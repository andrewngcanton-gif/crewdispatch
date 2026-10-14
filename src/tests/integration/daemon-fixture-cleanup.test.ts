// daemon-fixture-cleanup.test.ts — regression for the TEST-ONLY daemon fixture
// cleanup helper.
//
// It does NOT assert that a production defect is fixed. It asserts the cleanup
// CONTRACT the deadline teardown relies on:
//   * a root held by a REAL live child cannot be deleted, and the helper only
//     deletes it AFTER that child's exit is confirmed;
//   * an unresolved ORIGINAL is reported honestly and its root is left in place;
//   * a birth-proven ORIGINAL is the ONLY thing ever signalled, exactly once;
//   * a reused pid (different birth) and an unverifiable identity are NEVER
//     signalled and never reported as stopped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  awaitProcessInstanceExit,
  captureProcessIdentity,
  cleanupDaemonFixture,
  discoverFixtureJobProcessRoots,
  removeFixtureRootBounded
} from "../helpers/daemon-fixture-cleanup";
import { isPidAlive } from "../../runtime/process";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-daemon-cleanup-"));
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One recursive delete attempt: the error code, or null when it succeeded. */
function attemptRemove(root: string): string | null {
  try {
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
  }
}

function killQuietly(pid: number | undefined): void {
  if (pid == null) return;
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

/** A REAL node child that signals readiness, then holds its cwd (the root) open. */
function startHolder(root: string, holdMs: number): ChildProcess {
  const ready = path.join(root, "ready.txt");
  const script =
    "const fs=require('node:fs');" +
    `fs.writeFileSync(${JSON.stringify(ready)},'ready');` +
    `setTimeout(()=>{},${holdMs});`;
  return spawn(process.execPath, ["-e", script], { cwd: root, stdio: "ignore", windowsHide: true });
}

/**
 * A REAL unrelated control child in its OWN disposable dir (never the fixture
 * root), used to model a pid the OS could have reused behind stale metadata.
 */
async function startControlChild(holdMs: number): Promise<{ child: ChildProcess; pid: number; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-control-"));
  const ready = path.join(dir, "ready.txt");
  const script =
    "const fs=require('node:fs');" +
    `fs.writeFileSync(${JSON.stringify(ready)},'ready');` +
    `setTimeout(()=>{},${holdMs});`;
  const child = spawn(process.execPath, ["-e", script], { cwd: dir, stdio: "ignore", windowsHide: true });
  await waitForFile(ready, 5000);
  return { child, pid: child.pid as number, dir };
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isPidAlive(pid) === false) return;
    if (Date.now() >= deadline) throw new Error(`pid ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the helper waits for a REAL delayed-release child to exit before deleting its root", { timeout: 30000, skip: process.platform !== "win32" && "Windows open-cwd delete semantics" }, async () => {
  const root = tmpRoot();
  const child = startHolder(root, 1500);
  try {
    const pid = child.pid;
    assert.ok(Number.isInteger(pid) && (pid as number) > 0, "the real child started");
    await waitForFile(path.join(root, "ready.txt"), 5000);

    // HAZARD: while the child is alive its cwd IS the root, so a recursive delete
    // of the root must fail. This is the class of failure the deadline teardown
    // raced when it deleted before the broker process exited.
    const hazard = attemptRemove(root);
    assert.ok(hazard !== null, "deleting a root held by a live child must fail");
    assert.equal(fs.existsSync(root), true, "the root was not removed while the child held it");

    const identity = await captureProcessIdentity(pid as number);
    const outcome = await awaitProcessInstanceExit(identity, { timeoutMs: 15000 });
    assert.equal(outcome, "exited", "the real child's exit was confirmed");
    assert.equal(isPidAlive(pid as number), false, "the real child is gone");

    await removeFixtureRootBounded(root);
    assert.equal(fs.existsSync(root), false, "the root was removed only after the child exited");
  } finally {
    killQuietly(child.pid);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("the helper reports an unresolved ORIGINAL honestly and never deletes its root", { timeout: 30000 }, async () => {
  const root = tmpRoot();
  const child = startHolder(root, 6000);
  try {
    const pid = child.pid as number;
    await waitForFile(path.join(root, "ready.txt"), 5000);
    const identity = await captureProcessIdentity(pid);

    const outcome = await awaitProcessInstanceExit(identity, { timeoutMs: 500, terminateAfterMs: 0 });
    assert.equal(outcome, "timeout", "a still-alive original is a timeout, never 'exited'");

    let message = "";
    try {
      await cleanupDaemonFixture({
        root,
        identities: [identity],
        shutdownFn: async () => undefined,
        exitTimeoutMs: 400,
        terminateAfterMs: 0
      });
    } catch (e) {
      message = String((e as Error).message);
    }
    assert.match(message, new RegExp(String(pid)), "the refusal names the unresolved pid");
    assert.equal(fs.existsSync(root), true, "the root is left in place while the original is alive");
  } finally {
    killQuietly(child.pid);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("the helper terminates a birth-proven ORIGINAL that ignores shutdown, then removes the root", { timeout: 30000, skip: process.platform !== "win32" && "Requires Windows CIM process birth times" }, async () => {
  const root = tmpRoot();
  const child = startHolder(root, 8000);
  try {
    const pid = child.pid as number;
    await waitForFile(path.join(root, "ready.txt"), 5000);
    const identity = await captureProcessIdentity(pid);
    assert.ok(identity.birthMs != null, "the real child's birth was observed from the OS");

    const startedAt = Date.now();
    const report = await cleanupDaemonFixture({
      root,
      identities: [identity],
      shutdownFn: async () => undefined,
      exitTimeoutMs: 15000,
      terminateAfterMs: 300
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(report.outcomes[0]?.outcome, "exited", "the terminated original was confirmed exited");
    assert.ok(elapsed < 7000, `termination must not wait the child's full hold, took ${elapsed}ms`);
    assert.equal(isPidAlive(pid), false, "the child is gone");
    assert.equal(fs.existsSync(root), false, "the root was removed");
  } finally {
    killQuietly(child.pid);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("a reused pid born just AFTER the original (+1ms and +1999ms) is never signalled", async () => {
  for (const deltaMs of [1, 1999]) {
    const killed: number[] = [];
    const birthMs = 1_000_000;
    const outcome = await awaitProcessInstanceExit(
      { pid: 4242, birthMs },
      {
        timeoutMs: 2000,
        terminateAfterMs: 1,
        pollMs: 1,
        isAliveFn: () => true,
        // Same pid, birth just past the original: an exact-equality check must
        // reject it, while a tolerance would have accepted and killed it.
        enumerateFn: async () => ({ ok: true, processes: [{ pid: 4242, ppid: 1, createdAtMs: birthMs + deltaMs }] }),
        delayFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        killFn: (p) => killed.push(p)
      }
    );
    assert.equal(outcome, "reused", `a +${deltaMs}ms birth is a reuse`);
    assert.deepEqual(killed, [], `a +${deltaMs}ms reuse is never signalled`);
  }
});

test("Darwin exact microsecond birth distinguishes a same-millisecond PID reuse", async () => {
  const birthUs = 1_000_000_123;
  const birthMs = Math.floor(birthUs / 1000);
  const killed: number[] = [];
  const outcome = await awaitProcessInstanceExit(
    { pid: 4245, birthMs, birthUs },
    {
      timeoutMs: 200,
      terminateAfterMs: 1,
      pollMs: 1,
      isAliveFn: () => true,
      enumerateFn: async () => ({
        ok: true,
        processes: [{ pid: 4245, ppid: 1, createdAtMs: birthMs, createdAtUs: birthUs + 1 }]
      }),
      killFn: (p) => killed.push(p)
    }
  );
  assert.equal(outcome, "reused");
  assert.deepEqual(killed, [], "a same-ms but different-us incarnation is never signalled");
});

test("fixture cleanup consumes persisted Darwin owner birth evidence instead of treating the PID as unproven", async () => {
  const root = tmpRoot();
  const birthUs = 2_000_000_123;
  const birthMs = Math.floor(birthUs / 1000);
  const pid = 4246;
  let alive = true;
  const killed: number[] = [];
  const createdAt = "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "jobs", "owned.json"),
    JSON.stringify({
      createdAt,
      generation: 0,
      ownerPid: pid,
      ownerStartedAtUs: birthUs,
      childPid: null,
      childStartedAtUs: null,
      attempts: []
    }),
    "utf8"
  );
  assert.deepEqual(discoverFixtureJobProcessRoots(root), [
    { pid, sinceMs: Date.parse(createdAt) - 2000, birthUs }
  ]);  try {
    const report = await cleanupDaemonFixture({
      root,
      shutdownFn: async () => undefined,
      exitTimeoutMs: 1000,
      terminateAfterMs: 1,
      isAliveFn: () => alive,
      enumerateFn: async () => ({
        ok: true,
        processes: [{ pid, ppid: 1, createdAtMs: birthMs, createdAtUs: birthUs }]
      }),
      delayFn: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
      killFn: (p) => {
        killed.push(p);
        alive = false;
      }
    });
    assert.deepEqual(report.outcomes, [{ pid, outcome: "exited" }]);
    assert.deepEqual(killed, [pid]);
    assert.equal(report.removed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unverifiable identity is never signalled and reports unknown honestly", async () => {
  const killed: number[] = [];
  const outcome = await awaitProcessInstanceExit(
    { pid: 4243, birthMs: null },
    {
      timeoutMs: 200,
      terminateAfterMs: 1,
      pollMs: 1,
      isAliveFn: () => true,
      enumerateFn: async () => ({ ok: false, processes: [], reason: "unsupported_platform" }),
      delayFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      killFn: (p) => killed.push(p)
    }
  );
  assert.equal(outcome, "unknown");
  assert.deepEqual(killed, [], "an unverifiable process is never signalled");
});

test("a birth-proven original is signalled exactly once and then confirmed exited", async () => {
  let alive = true;
  const killed: number[] = [];
  const outcome = await awaitProcessInstanceExit(
    { pid: 4244, birthMs: 2_000_000 },
    {
      timeoutMs: 5000,
      terminateAfterMs: 1,
      pollMs: 1,
      isAliveFn: () => alive,
      enumerateFn: async () => ({ ok: true, processes: [{ pid: 4244, ppid: 1, createdAtMs: 2_000_000 }] }),
      delayFn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      killFn: (p) => {
        killed.push(p);
        alive = false;
      }
    }
  );
  assert.equal(outcome, "exited");
  assert.deepEqual(killed, [4244], "exactly one signal to the confirmed original");
});

test("a stale metadata pid that is already DEAD lets the root be removed safely", async () => {
  const root = tmpRoot();
  const control = await startControlChild(80);
  await waitForPidExit(control.pid, 5000);
  assert.equal(isPidAlive(control.pid), false, "the control child really exited");
  try {
    fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
    fs.writeFileSync(path.join(root, "daemon", "daemon.json"), JSON.stringify({ version: 1, pid: control.pid }), "utf8");
    const report = await cleanupDaemonFixture({ root, shutdownFn: async () => undefined, exitTimeoutMs: 500 });
    assert.equal(report.discoveredPid, control.pid, "the published pid was discovered");
    assert.deepEqual(report.outcomes, [{ pid: control.pid, outcome: "exited" }]);
    assert.equal(report.removed, true);
    assert.equal(fs.existsSync(root), false);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(control.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("a stale metadata pid is NEVER promoted to ownership: a live unrelated control child survives and the root is retained", { timeout: 30000 }, async () => {
  const root = tmpRoot();
  const control = await startControlChild(6000);
  try {
    fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
    fs.writeFileSync(path.join(root, "daemon", "daemon.json"), JSON.stringify({ version: 1, pid: control.pid, port: 1 }), "utf8");

    let message = "";
    try {
      await cleanupDaemonFixture({ root, shutdownFn: async () => undefined, exitTimeoutMs: 500 });
    } catch (e) {
      message = String((e as Error).message);
    }
    assert.match(message, new RegExp(String(control.pid)), "the unresolved discovered pid is named");
    assert.equal(isPidAlive(control.pid), true, "the unrelated control child was never signalled");
    assert.equal(fs.existsSync(root), true, "the root was retained while the discovered pid was unproven");
  } finally {
    killQuietly(control.child.pid);
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(control.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("cleanup waits for retained job worker/provider pids before removing the root", async () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "jobs", "job-fixture.json"),
      JSON.stringify({ ownerPid: 4245, childPid: 4246 }),
      "utf8"
    );
    const report = await cleanupDaemonFixture({
      root,
      discoverPidFn: () => null,
      shutdownFn: async () => undefined,
      isAliveFn: (pid) => (pid === 4245 || pid === 4246 ? false : null),
      enumerateFn: async () => ({ ok: false, processes: [], reason: "test" })
    });
    assert.deepEqual(report.outcomes, [
      { pid: 4245, outcome: "exited" },
      { pid: 4246, outcome: "exited" }
    ]);
    assert.equal(report.removed, true);
    assert.equal(fs.existsSync(root), false);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("a fixture root with no owned broker is removed safely", async () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, "daemon"), { recursive: true });
    const report = await cleanupDaemonFixture({
      root,
      shutdownFn: async () => undefined,
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: false, processes: [], reason: "test" })
    });
    assert.equal(report.discoveredPid, null, "no broker was discovered");
    assert.deepEqual(report.outcomes, [], "no owned process was awaited");
    assert.equal(report.removed, true);
    assert.equal(fs.existsSync(root), false);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
