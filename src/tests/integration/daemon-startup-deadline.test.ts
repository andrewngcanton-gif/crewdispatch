// daemon-startup-deadline.test.ts — BEHAVIOR coverage of the one finite
// request I/O budget that propagates through broker startup, its liveness
// pings, its poll sleeps and the Windows out-of-Job-Object process creation.
//
// The defect these tests exist for (parent evidence
// ../parent-deadline-evidence.json): `ensureJobDaemon` accepted a `deadlineMs`
// but the wait loop still pinged with a FIXED 1500ms and slept a FIXED 100ms,
// and the Windows launch still used a FIXED 15s spawnSync timeout with no
// re-check of the budget immediately before creating a process. A 250ms budget
// therefore took 1718ms — 1468ms past its own deadline.
//
// Every assertion below is a BEHAVIOR assertion against the real code path
// (a real loopback broker double, a real concurrent startup lock, a real
// PowerShell/WMI process creation, a real cold-started broker), never a bare
// comparison of constants. Reverting the deadline threading makes these fail.
//
// All roots are disposable OS temp directories under this snapshot; no
// production data root, installed asset, real Claude host or real approval is
// involved. Every broker, receiver and temp root is stopped/removed in
// `finally`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ensureJobDaemon,
  JobDaemonError,
  START_TIMEOUT_MS,
  RECOVERY_REQUEST_BUDGET_MS
} from "../../daemon/client";
import { isPidAlive } from "../../runtime/process";
import { cleanupDaemonFixture, captureProcessIdentity, type ProcessIdentity } from "../helpers/daemon-fixture-cleanup";
import {
  DURABLE_LAUNCH_TIMEOUT_MS,
  durableLaunchTimeoutMs,
  launchWindowsOutsideCallerJob,
  supportsDurableLaunch
} from "../../runtime/durable-launch";

const TOKEN = "t".repeat(64);

/**
 * Ordinary scheduling overhead is allowed, a fixed-constant step is not: the
 * recorded defect overran a 250ms budget by ~6x, so 2x already separates the
 * fixed behavior from the bounded one while tolerating a loaded CI host.
 */
function assertWithinBudget(elapsedMs: number, budgetMs: number, note: string): void {
  assert.ok(
    elapsedMs < budgetMs * 2,
    `${note}: expected roughly the ${budgetMs}ms budget, took ${elapsedMs}ms`
  );
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-deadline-"));
}

interface StalledBroker {
  port: number;
  close: () => Promise<void>;
  received: () => number;
}

/**
 * A real loopback broker double that ACCEPTS every connection and deliberately
 * never answers: exactly the shape that made the old fixed 1500ms ping overrun
 * a small caller budget.
 */
async function startStalledBroker(): Promise<StalledBroker> {
  const sockets = new Set<net.Socket>();
  let received = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("data", () => {
      received += 1;
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    received: () => received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** A live-pid startup lock, i.e. another process is already starting a broker. */
function holdStartupLock(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "launch.lock"),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    "utf8"
  );
}

function publishStalledMeta(dir: string, port: number): void {
  fs.writeFileSync(
    path.join(dir, "daemon.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      token: TOKEN,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      serverPath: __filename
    }),
    "utf8"
  );
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return "unexpected_success";
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

/**
 * Run a test BODY, then the owned-root cleanup, preserving BOTH failures. A
 * cleanup throw must never mask a primary body failure (and vice versa): every
 * launch-capable teardown in this file goes through this so the original
 * assertion failure is never lost to a cleanup error.
 *
 * The SAME `identities` array is passed by reference and the body may append to
 * it (a captured ORIGINAL instance); it must NOT be snapshotted as an argument
 * expression before the async body runs. Returns a copy of exactly what cleanup
 * was handed, so a caller can assert the identity captured INSIDE the body
 * actually reached cleanup.
 */
async function runBodyThenCleanup(
  root: string,
  body: () => Promise<void>,
  identities: ProcessIdentity[] = []
): Promise<ProcessIdentity[]> {
  let bodyError: unknown;
  try {
    await body();
  } catch (e) {
    bodyError = e;
  }
  const handedToCleanup = identities.slice();
  let cleanupError: unknown;
  try {
    await cleanupDaemonFixture({ root, identities: handedToCleanup, terminateAfterMs: 2000 });
  } catch (e) {
    cleanupError = e;
  }
  if (bodyError && cleanupError) {
    throw new AggregateError([bodyError, cleanupError], "deadline test: body and cleanup both failed");
  }
  if (bodyError) throw bodyError;
  if (cleanupError) throw cleanupError;
  return handedToCleanup;
}

test("a stalled broker behind a concurrent startup lock stops at the caller's deadline", { timeout: 60000 }, async () => {
  // THE PARENT'S BOUNDARY, verbatim in shape: a live pid already holds the
  // startup lock, so ensureJobDaemon cannot launch and must WAIT for a broker
  // that never becomes responsive. The old code pinged 1500ms per iteration
  // regardless of the budget and slept a fixed 100ms.
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  const broker = await startStalledBroker();
  holdStartupLock(dir);
  // Published shortly AFTER the call starts, exactly as the parent's repro does,
  // so the code takes the lock-busy -> waitForDaemon path.
  const publish = setTimeout(() => publishStalledMeta(dir, broker.port), 40);
  try {
    const budgetMs = 250;
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start + budgetMs }));
    const elapsedMs = Date.now() - start;
    assert.equal(code, "daemon_start_timeout", "the stalled broker must time out, not succeed");
    assertWithinBudget(elapsedMs, budgetMs, "stalled broker startup wait");
    assert.ok(broker.received() > 0, "the wait really did ping the stalled broker");
  } finally {
    clearTimeout(publish);
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the poll sleep is capped by the remaining budget, not by a fixed 100ms", { timeout: 60000 }, async () => {
  // Lock busy, and NO metadata ever appears: the loop can only sleep and
  // re-read. A fixed 100ms sleep alone overruns a 40ms budget several times.
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  holdStartupLock(dir);
  try {
    const budgetMs = 40;
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start + budgetMs }));
    const elapsedMs = Date.now() - start;
    assert.equal(code, "daemon_start_timeout");
    assertWithinBudget(elapsedMs, budgetMs, "sleep-only startup wait");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an already expired deadline refuses before any ping, launch or metadata read", { timeout: 60000 }, async () => {
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  const broker = await startStalledBroker();
  publishStalledMeta(dir, broker.port);
  try {
    const start = Date.now();
    // A deadline already 5s in the past. The old code only noticed much later,
    // after acquiring a launch lock and attempting the launch.
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start - 5000 }));
    const elapsedMs = Date.now() - start;
    assert.equal(code, "daemon_start_timeout", "an expired budget is refused, not attempted");
    assert.ok(elapsedMs < 1000, `an expired deadline must be refused immediately, took ${elapsedMs}ms`);
    assert.equal(broker.received(), 0, "nothing may be sent on an expired budget");
    assert.equal(
      fs.existsSync(path.join(dir, "launch.lock")),
      false,
      "no launch may be attempted on an expired budget"
    );
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live but unresponsive broker is never replaced and is bounded by the caller's budget", { timeout: 60000 }, async () => {
  // The re-check immediately BEFORE creation must not turn "no second broker"
  // into "start one anyway": a live pid that never answers keeps its refusal,
  // reached in bounded time.
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  const broker = await startStalledBroker();
  publishStalledMeta(dir, broker.port);
  try {
    const budgetMs = 300;
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start + budgetMs }));
    const elapsedMs = Date.now() - start;
    assert.equal(code, "daemon_unhealthy", "a live unresponsive broker must not be replaced");
    assertWithinBudget(elapsedMs, budgetMs, "live unresponsive broker");
    assert.equal(fs.existsSync(path.join(dir, "launch.lock")), false, "no second broker was launched");
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Windows launch is given the caller's remaining budget, not an unbounded default", { timeout: 60000, skip: !supportsDurableLaunch() && "Requires the Windows WMI process-creation boundary" }, async () => {
  // Proves the PROPAGATION, not just the clamp. Nothing stands between the
  // launch and a broker being created, so when the remaining budget is smaller
  // than a real PowerShell/WMI cold start (hundreds of ms on this host), a call
  // that honors its bound creates NOTHING.
  //
  // Under the defect this test exists for — `timeoutMs: null`, i.e. the fixed
  // 15s default — the same call creates a real broker, which publishes
  // `daemon.json` a little later. So the assertion is made against a POLLED
  // observation window, not a single immediate read: an async publish must not
  // be able to slip past the check.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
  await runBodyThenCleanup(root, async () => {
    const dir = path.join(root, "daemon");
    const metaFile = path.join(dir, "daemon.json");
    const budgetMs = 40;
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start + budgetMs }));
    const elapsedMs = Date.now() - start;
    // Either the budget ran out before creation, or the bounded creation call
    // itself failed fast. Both are honest bounded outcomes.
    assert.ok(
      code === "daemon_start_timeout" || code === "daemon_launch_failed",
      `a launch budget of ${budgetMs}ms must not produce a broker, got ${code}`
    );
    assert.ok(elapsedMs < 10_000, `the bounded launch must fail fast, took ${elapsedMs}ms`);

    // Poll well past a normal broker publish latency: nothing may appear.
    const observedUntil = Date.now() + 5000;
    while (Date.now() < observedUntil) {
      assert.equal(
        fs.existsSync(metaFile),
        false,
        "a launch bounded to 40ms must never result in a created broker"
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fs.existsSync(path.join(dir, "launch.lock")), false, "the launch lock was released");
  });
});

test("the budget is re-checked immediately before process creation, not only on entry", { timeout: 60000 }, async () => {
  // Distinct from the entry guard on purpose. With no metadata present the
  // call walks the full launch path, and a 1ms budget is already spent by the
  // time it reaches the creation step (lock acquisition, metadata reads and the
  // entry check each cost more than that).
  //
  // The two outcomes are distinguished by their CODE, which is what makes this
  // catch a removed pre-launch re-check:
  //   * re-check present -> `daemon_start_timeout`, refusing BEFORE any process
  //     is created;
  //   * re-check removed -> the code proceeds to creation with nothing left,
  //     the WMI call is clamped to 1ms and fails -> `daemon_launch_failed`.
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  await runBodyThenCleanup(root, async () => {
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}, { deadlineMs: start + 1 }));
    const elapsedMs = Date.now() - start;
    assert.equal(
      code,
      "daemon_start_timeout",
      "an exhausted budget must be refused before a process is created, not turned into a failed creation"
    );
    assert.ok(elapsedMs < 10_000, `the refusal must be prompt, took ${elapsedMs}ms`);
    assert.equal(
      fs.existsSync(path.join(dir, "daemon.json")),
      false,
      "no broker was created"
    );
  });
});

test("a caller with no deadline keeps the ordinary startup behavior", { timeout: 60000 }, async () => {
  // Default behavior for every non-recovery caller is unchanged. With no
  // deadline there is nothing small to cap, so the liveness ping still runs its
  // FULL published bound; a wrong clamp (e.g. treating "no deadline" as 1ms)
  // would return almost instantly and fail this.
  assert.ok(Number.isFinite(START_TIMEOUT_MS) && START_TIMEOUT_MS > 0);
  const root = tmpRoot();
  const dir = path.join(root, "daemon");
  fs.mkdirSync(dir, { recursive: true });
  const broker = await startStalledBroker();
  publishStalledMeta(dir, broker.port);
  try {
    const start = Date.now();
    const code = await codeOf(() => ensureJobDaemon(root, {}));
    const elapsedMs = Date.now() - start;
    assert.equal(code, "daemon_unhealthy", "the ordinary refusal is unchanged");
    assert.ok(
      elapsedMs >= 1000,
      `with no deadline the ping must still use its full published bound, returned in ${elapsedMs}ms`
    );
  } finally {
    await broker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the recovery budget still cold-starts a STOPPED broker inside itself", { timeout: 120000 }, async () => {
  // The budget must be able to cover a real cold start — that is the whole point
  // of `RECOVERY_REQUEST_BUDGET_MS > START_TIMEOUT_MS`. This drives the REAL
  // launch + startup wait against the REAL compiled daemon server, given the
  // SAME deadline the recovery request uses. It also proves the propagated
  // bound on Windows process creation is still usable: a leftover wrong clamp
  // would fail here.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
  // ONE mutable array created BEFORE the body and passed by reference; the body
  // appends the captured ORIGINAL. (An argument expression like
  // `ownedIdentity ? [ownedIdentity] : []` would be evaluated while it is still
  // empty and cleanup would silently fall back to the unproven metadata pid.)
  const ownedIdentities: ProcessIdentity[] = [];
  const handedToCleanup = await runBodyThenCleanup(
    root,
    async () => {
      const startedAt = Date.now();
      // One real end-to-end budget, exactly as `requestClaudeSessionRecovery`
      // computes it.
      const deadline = startedAt + RECOVERY_REQUEST_BUDGET_MS;
      const meta = await ensureJobDaemon(root, {}, { deadlineMs: deadline });
      const elapsedMs = Date.now() - startedAt;
      // Record the ORIGINAL broker instance (pid + birth) while it is alive, so
      // teardown can prove the SAME incarnation exited before deleting its root.
      ownedIdentities.push(await captureProcessIdentity(meta.pid));
      assert.ok(Number.isSafeInteger(meta.pid) && meta.pid > 0, "a real broker pid was published");
      assert.equal(isPidAlive(meta.pid), true, "the launched broker is alive");
      assert.ok(meta.port > 0 && meta.port <= 65535);
      assert.ok(
        elapsedMs < RECOVERY_REQUEST_BUDGET_MS * 2,
        `a cold start must fit inside the budget, took ${elapsedMs}ms`
      );
      // The launch lock is released on the success path, so a later caller never
      // sees a phantom "another process is starting the daemon".
      assert.equal(fs.existsSync(path.join(root, "daemon", "launch.lock")), false);
    },
    ownedIdentities
  );

  // Wiring regression: the ORIGINAL identity captured INSIDE the body must be
  // what cleanup received. A pre-body snapshot would hand cleanup an empty array
  // (birth-less metadata fallback), so this assertion fails without the fix.
  assert.equal(handedToCleanup.length, 1, "the captured ORIGINAL identity reached cleanup");
  assert.ok(handedToCleanup[0]!.birthMs != null, "cleanup received the birth-bearing captured identity, not the metadata fallback");
});

test("the Windows creation timeout is the default unless a caller passes remaining budget", () => {
  // Default preserved for the Dashboard Hub launcher and every other caller.
  assert.equal(durableLaunchTimeoutMs(undefined), DURABLE_LAUNCH_TIMEOUT_MS);
  assert.equal(durableLaunchTimeoutMs(null), DURABLE_LAUNCH_TIMEOUT_MS);
  assert.equal(durableLaunchTimeoutMs(Number.NaN), DURABLE_LAUNCH_TIMEOUT_MS);
  assert.equal(durableLaunchTimeoutMs(Number.POSITIVE_INFINITY), DURABLE_LAUNCH_TIMEOUT_MS);
  // A caller's remaining budget wins, and Node's `timeout: 0` ("no timeout")
  // can never be produced: that would silently unbind the very bound a budget
  // exists to enforce.
  assert.equal(durableLaunchTimeoutMs(250), 250);
  assert.equal(durableLaunchTimeoutMs(1.9), 1);
  for (const nonpositive of [0, -1, -5000]) {
    assert.ok(
      durableLaunchTimeoutMs(nonpositive) >= 1,
      `a nonpositive remaining budget must clamp to a real bound, got ${durableLaunchTimeoutMs(nonpositive)}`
    );
  }
});

test("the Windows launch really consumes the remaining bounded timeout, and the default is really usable", { timeout: 120000, skip: !supportsDurableLaunch() && "Requires the Windows WMI process-creation boundary" }, async () => {
  // REAL process creation through the real WMI/PowerShell path. Children are
  // short-lived and reaped by the OS; the daemon is NOT started and no data root
  // is claimed.
  const root = tmpRoot();
  const marker = path.join(root, "durable-launch-boundary.txt");
  const child = launchWindowsOutsideCallerJob({
    file: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'created')`],
    timeoutMs: 30_000
  });
  assert.ok(Number.isSafeInteger(child) && child > 0, "the WMI provider host created a real process");
  // The DEFAULT is proven by the same real call with no budget: it must succeed
  // against a cold PowerShell start, which an over-clamped bound could not do.
  const childDefault = launchWindowsOutsideCallerJob({
    file: process.execPath,
    args: ["-e", "void 0"],
    timeoutMs: null
  });
  assert.ok(Number.isSafeInteger(childDefault) && childDefault > 0);

  // Now prove the bound is REAL and not merely recorded: an impossible
  // remaining budget makes the same real call fail fast instead of silently
  // running unbounded (which is exactly what `timeout: 0` would do).
  const startedAt = Date.now();
  assert.throws(
    () =>
      launchWindowsOutsideCallerJob({
        file: process.execPath,
        args: ["-e", "void 0"],
        timeoutMs: 1
      }),
    /Win32_Process\.Create outside the caller's Job Object failed/
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 30_000, `a 1ms creation bound must not run the full default, took ${elapsedMs}ms`);
  fs.rmSync(root, { recursive: true, force: true });
});
