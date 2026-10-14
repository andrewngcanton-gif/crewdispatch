// daemon-dashboard-ensure.test.ts — daemon-admission-level coverage for
// the on-demand Dashboard integration (src/daemon/server.ts +
// src/daemon/dashboard-ensure.ts).
//
// The broker is the REAL in-process daemon; the ensure is either a
// recording seam (trigger timing, rejection isolation, response
// promptness) or the REAL orchestration with seam-injected Hub
// probe/spawn (concurrent-dispatch dedup). The REAL Hub child and
// HTTP identity are exercised by dashboard-on-dispatch-mcp.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { startDaemon, type DaemonDashboardEnsure, type DaemonHandle } from "../../daemon/server";
import { continueJobViaDaemon, shutdownJobDaemon, startJobViaDaemon } from "../../daemon/client";
import { loadJob } from "../../jobs/store";
import { isTerminalStatus } from "../../jobs/types";
import {
  ensureDashboardOnDispatch,
  type DispatchDashboardRecord
} from "../../daemon/dashboard-ensure";
import { DASHBOARD_SERVICE_NAME, type HubBuildExpectation, type SpawnImpl } from "../../dashboard/launcher";
import { dataRootId } from "../../hub/endpoint";

const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const EXPECTED: HubBuildExpectation = { version: "0.0.0-m1", buildId: "build-daemon-level" };
const CURRENT_BUILD = { version: EXPECTED.version, buildId: EXPECTED.buildId };
const HUB_PORT = 31220;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * A one-shot gate. The release function escapes the promise
 * executor's closure with its real type, so tests can arm the
 * gate and release it later without narrowing hazards.
 */
function deferredGate(): { promise: Promise<void>; release: () => void } {
  let doRelease: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    doRelease = resolve;
  });
  return { promise, release: () => doRelease() };
}

/** A controlled provider stand-in: emits run_start, then succeeds. */
function writeEchoFixture(dir: string): string {
  const fixture = path.join(dir, "echo-fixture.cjs");
  fs.writeFileSync(
    fixture,
    [
      "const out = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  out({ type: "event", event: { type: "run_start", sessionId: "fx-dispatch-daemon" } });',
      '  out({ type: "result", subtype: "success", result: "FX_DONE", session_id: "fx-dispatch-daemon", stop_reason: "end_turn" });',
      "  process.exit(0);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

interface Workspace {
  dir: string;
  root: string;
  project: string;
  fixture: string;
  env: NodeJS.ProcessEnv;
}

function newWorkspace(name: string, projects = 1): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-daemon-dispatch-${name}-`));
  const root = path.join(dir, "root");
  const fixture = writeEchoFixture(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  if (process.platform === "win32") env.JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN = "1";
  for (let i = 0; i < projects; i += 1) {
    fs.mkdirSync(path.join(dir, `project-${i}`), { recursive: true });
  }
  return { dir, root, project: path.join(dir, "project-0"), fixture, env };
}

/** Remove a test tree, tolerating Windows EPERM/EBUSY with retries. */
async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw e;
      await sleep(100);
    }
  }
}

async function withDaemon<T>(
  root: string,
  ensure: DaemonDashboardEnsure | undefined,
  run: (daemon: DaemonHandle) => Promise<T>
): Promise<T> {
  const daemon = await startDaemon(root, ensure ? { dashboardEnsure: ensure } : {});
  try {
    return await run(daemon);
  } finally {
    await shutdownJobDaemon(root, process.env).catch(() => undefined);
    await daemon.close().catch(() => undefined);
  }
}

function dispatch(ws: Workspace, cwd: string, task = "dispatch task"): Promise<{ job: { id: string }; workerPid: number | null }> {
  return startJobViaDaemon(ws.root, {
    task,
    cwd,
    runner: "fixture",
    fixturePath: ws.fixture,
    env: ws.env
  });
}

test("an accepted start triggers the shared ensure once, with the daemon's authoritative root", { timeout: 60000 }, async () => {
  const ws = newWorkspace("start-trigger");
  const calls: Array<{ trigger: string; root: string; requestEnv: NodeJS.ProcessEnv | null; fixture: boolean }> = [];
  try {
    await withDaemon(ws.root, async (trigger, context) => {
      calls.push({ trigger, root: context.root, requestEnv: context.requestEnv ?? null, fixture: context.fixture });
      return { ok: true, action: "skipped", at: "", trigger, port: 0, url: null, ping_url: null, hub_pid: null, service: null, version: null, build_id: null, error: null } as DispatchDashboardRecord;
    }, async () => {
      const launched = await dispatch(ws, ws.project);
      assert.match(launched.job.id, /^job-/);
      await waitFor(() => {
        const job = loadJob(ws.root, launched.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the accepted job to finish");
    });
    assert.equal(calls.length, 1, "exactly one ensure for one accepted dispatch");
    assert.equal(calls[0]!.trigger, "start");
    assert.equal(calls[0]!.root, ws.root, "the ensure carries the daemon's authoritative root");
    assert.equal(calls[0]!.fixture, true, "a fixture dispatch is flagged (isolation default)");
    assert.ok(calls[0]!.requestEnv, "the caller's request env is forwarded for endpoint ownership");
  } finally {
    await removeTree(ws.dir);
  }
});

test("an accepted continuation triggers the same shared path", { timeout: 60000 }, async () => {
  const ws = newWorkspace("continue-trigger");
  const triggers: string[] = [];
  try {
    await withDaemon(ws.root, async (trigger) => {
      triggers.push(trigger);
      return { ok: true, action: "skipped", at: "", trigger, port: 0, url: null, ping_url: null, hub_pid: null, service: null, version: null, build_id: null, error: null } as DispatchDashboardRecord;
    }, async () => {
      const launched = await dispatch(ws, ws.project);
      await waitFor(() => {
        const job = loadJob(ws.root, launched.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the first generation to finish");
      const followed = await continueJobViaDaemon(ws.root, {
        jobId: launched.job.id,
        task: "repair packet",
        fixturePath: ws.fixture,
        env: ws.env
      });
      assert.equal(followed.job.id, launched.job.id, "the follow-up keeps the same logical job");
      assert.equal(followed.job.generation, 1);
      await waitFor(() => {
        const job = loadJob(ws.root, launched.job.id);
        return job && isTerminalStatus(job.status) && job.generation === 1 ? job : null;
      }, 20000, "the continued generation to finish");
    });
    assert.deepEqual(triggers, ["start", "continue"], "start AND continue share the one integration point");
  } finally {
    await removeTree(ws.dir);
  }
});

test("a refused dispatch never triggers the ensure (workspace_busy admission)", { timeout: 60000 }, async () => {
  const ws = newWorkspace("rejected");
  const triggers: string[] = [];
  try {
    await withDaemon(ws.root, async (trigger) => {
      triggers.push(trigger);
      return { ok: true, action: "skipped", at: "", trigger, port: 0, url: null, ping_url: null, hub_pid: null, service: null, version: null, build_id: null, error: null } as DispatchDashboardRecord;
    }, async () => {
      // Two concurrent dispatches on the SAME cwd: exactly one is
      // admitted; the other is refused with workspace_busy at the
      // daemon seam — and must not bring up a Dashboard.
      const [first, second] = await Promise.allSettled([
        dispatch(ws, ws.project, "FIRST"),
        dispatch(ws, ws.project, "SECOND")
      ]);
      const accepted = [first, second].filter((r) => r.status === "fulfilled");
      const refused = [first, second].filter((r) => r.status === "rejected");
      assert.equal(accepted.length, 1, "exactly one dispatch is accepted");
      assert.equal(refused.length, 1, "the other is refused");
      const error = (refused[0] as PromiseRejectedResult).reason as { code?: string };
      assert.equal(error.code, "workspace_busy");
    });
    assert.deepEqual(triggers, ["start"], "only the AUTHORITATIVELY accepted dispatch triggers the ensure");
  } finally {
    await removeTree(ws.dir);
  }
});

test("the dispatch response is already sent while the ensure is still pending", { timeout: 60000 }, async () => {
  const ws = newWorkspace("prompt");
  const gate = deferredGate();
  const pending: Array<Promise<unknown>> = [];
  try {
    await withDaemon(ws.root, async (_trigger, _context) => {
      const p = gate.promise.then(() => ({ ok: true, action: "skipped", at: "", trigger: "start" as const, port: 0, url: null, ping_url: null, hub_pid: null, service: null, version: null, build_id: null, error: null }) as DispatchDashboardRecord);
      pending.push(p);
      return p;
    }, async () => {
      const t0 = Date.now();
      const launched = await dispatch(ws, ws.project);
      const elapsed = Date.now() - t0;
      assert.ok(typeof launched.job.id === "string", "the dispatch returned an accepted job id");
      assert.ok(elapsed < 5000, `the response must not wait for the Dashboard (${elapsed}ms)`);
      // The ensure is STILL pending at this point: release it so the
      // fire-and-forget attempt settles before the daemon closes.
      gate.release();
      await Promise.all(pending);
    });
  } finally {
    gate.release();
    await removeTree(ws.dir);
  }
});

test("a synchronous ensure throw keeps the accepted job, its terminal result and the next request healthy", { timeout: 60000 }, async () => {
  const ws = newWorkspace("sync-throw", 2);
  const other = path.join(ws.dir, "project-1");
  try {
    await withDaemon(ws.root, ((): DaemonDashboardEnsure => {
      // The exact proven defect shape: the ensure helper throwing
      // SYNCHRONOUSLY (an invalid configured port) before any
      // promise exists. The daemon defers the whole invocation,
      // so this can never break admission, duplicate a response
      // or take the broker down.
      const syncThrow: DaemonDashboardEnsure = () => {
        throw new Error("invalid_port: Hub port invalid invalid");
      };
      return syncThrow;
    })(), async () => {
      const launched = await dispatch(ws, ws.project, "SYNC_THROW_GUARD");
      assert.match(launched.job.id, /^job-/, "the dispatch is still accepted");
      const done = await waitFor(() => {
        const job = loadJob(ws.root, launched.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the accepted job to reach its terminal result");
      assert.equal(done.status, "done");
      // The daemon is still healthy: the NEXT request is accepted
      // and reaches its own terminal result.
      const next = await dispatch(ws, other, "NEXT_REQUEST_GUARD");
      assert.match(next.job.id, /^job-/);
      assert.notEqual(next.job.id, launched.job.id, "a distinct next job");
      const nextDone = await waitFor(() => {
        const job = loadJob(ws.root, next.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the next request to reach its terminal result");
      assert.equal(nextDone.status, "done");
    });
  } finally {
    await removeTree(ws.dir);
  }
});

test("a rejected ensure promise keeps the accepted job, its terminal result and the next request healthy", { timeout: 60000 }, async () => {
  const ws = newWorkspace("rejected-promise", 2);
  const other = path.join(ws.dir, "project-1");
  try {
    await withDaemon(ws.root, async () => {
      // A rejected ensure promise must be absorbed the same way:
      // never as a dispatch failure, never as daemon damage.
      return Promise.reject(new Error("hub_start_failed: The Hub exited before it was ready"));
    }, async () => {
      const launched = await dispatch(ws, ws.project, "REJECTED_PROMISE_GUARD");
      assert.match(launched.job.id, /^job-/, "the dispatch is still accepted");
      const done = await waitFor(() => {
        const job = loadJob(ws.root, launched.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the accepted job to reach its terminal result");
      assert.equal(done.status, "done");
      const next = await dispatch(ws, other, "NEXT_REQUEST_GUARD");
      assert.match(next.job.id, /^job-/);
      const nextDone = await waitFor(() => {
        const job = loadJob(ws.root, next.job.id);
        return job && isTerminalStatus(job.status) ? job : null;
      }, 20000, "the next request to reach its terminal result");
      assert.equal(nextDone.status, "done");
    });
  } finally {
    await removeTree(ws.dir);
  }
});

class FakeChild extends EventEmitter {
  pid: number | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number | null) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.exitCode = 1;
    return true;
  }

  unref(): void {
    /* detached test child */
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface DedupWorld {
  fetchImpl: typeof fetch;
  spawnImpl: SpawnImpl;
  spawnCount: () => number;
  fetchCount: () => number;
}

function createDedupWorld(gate: () => Promise<void>, root: string): DedupWorld {
  let mode: "down" | "ready" = "down";
  let fetches = 0;
  let spawns = 0;
  const fetchImpl = (async (input: unknown) => {
    fetches += 1;
    const url = String(input);
    if (!url.includes("/api/ping")) throw new Error(`unexpected fetch: ${url}`);
    await gate();
    if (mode === "ready") {
      return jsonResponse({
        ok: true,
        service: DASHBOARD_SERVICE_NAME,
        version: CURRENT_BUILD.version,
        build_id: CURRENT_BUILD.buildId,
        root_id: dataRootId(root)
      });
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const spawnImpl = ((_file: string, _args: string[]) => {
    spawns += 1;
    mode = "ready";
    return new FakeChild(4200 + spawns) as unknown as ChildProcess;
  }) as unknown as SpawnImpl;
  return { fetchImpl, spawnImpl, spawnCount: () => spawns, fetchCount: () => fetches };
}

test("two concurrent accepted dispatches launch ONE Hub through the real orchestration", { timeout: 60000 }, async () => {
  const ws = newWorkspace("dedup", 2);
  const other = path.join(ws.dir, "project-1");
  const gate = deferredGate();
  const world = createDedupWorld(() => gate.promise, ws.root);
  const triggers: string[] = [];
  const attempts: Array<Promise<DispatchDashboardRecord>> = [];
  try {
    await withDaemon(ws.root, (trigger, context) => {
      triggers.push(trigger);
      // The real orchestration with seam-injected Hub probe/spawn:
      // the fixture flag is dropped so a production dispatch is simulated.
      const attempt = ensureDashboardOnDispatch(trigger, {
        ...context,
        fixture: false,
        port: HUB_PORT,
        fetchImpl: world.fetchImpl,
        spawnImpl: world.spawnImpl,
        expectedBuild: EXPECTED
      });
      attempts.push(attempt);
      return attempt;
    }, async () => {
      const [a, b] = await Promise.all([
        dispatch(ws, ws.project, "DEDUP_A"),
        dispatch(ws, other, "DEDUP_B")
      ]);
      assert.match(a.job.id, /^job-/);
      assert.match(b.job.id, /^job-/);
      assert.notEqual(a.job.id, b.job.id, "two distinct accepted jobs");
      // Both dispatches have been admitted and both ensures are in
      // flight (their probes are held on the gate).
      await waitFor(() => (triggers.length >= 2 ? true : null), 10000, "both ensures to be in flight");
      assert.equal(world.fetchCount() >= 1, true, "the first probe is held, not failed");
      gate.release();
      const records = await Promise.all(attempts);
      assert.equal(world.spawnCount(), 1, "concurrent accepted dispatches share ONE Hub");
      assert.equal(records[0], records[1], "both dispatches observe the same ensure result");
      assert.equal(records[0]!.action, "started");
      assert.equal(records[0]!.port, HUB_PORT);
    });
  } finally {
    gate.release();
    await removeTree(ws.dir);
  }
});
