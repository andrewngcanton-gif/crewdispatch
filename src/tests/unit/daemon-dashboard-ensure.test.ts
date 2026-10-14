// daemon-dashboard-ensure.test.ts — pure/lifecycle coverage for the
// shared on-demand Dashboard orchestration (src/daemon/dashboard-ensure.ts).
//
// Everything external (Hub probe fetch, Hub child spawn, diagnostic
// write) is a deterministic seam here, exactly like the underlying
// ensureHub unit tests. The REAL Hub lifecycle is exercised by
// dashboard-on-dispatch-mcp.test.ts (real MCP/daemon entry, real Hub
// child, real HTTP identity) and daemon-dashboard-ensure.test.ts
// (real broker admission timing).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { dataRootId } from "../../hub/endpoint";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DISPATCH_DASHBOARD_ENV,
  dispatchDashboardEnabled,
  dispatchDashboardDiagnosticPath,
  ensureDashboardOnDispatch,
  readDispatchDashboardRecord,
  writeDispatchDashboardRecord,
  type DispatchDashboardRecord
} from "../../daemon/dashboard-ensure";
import {
  DASHBOARD_SERVICE_NAME,
  type HubBuildExpectation,
  type SpawnImpl
} from "../../dashboard/launcher";

/** The version+build the process under test expects to find. */
const EXPECTED: HubBuildExpectation = { version: "0.0.0-m1", buildId: "build-dispatch" };
const CURRENT_BUILD = { version: EXPECTED.version, buildId: EXPECTED.buildId };

const HUB_ENTRY = path.join(__dirname, "..", "..", "hub", "server.js");

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

type WorldMode = "down" | "ready" | "foreign";

interface WorldOptions {
  mode?: WorldMode;
  /** The spawned child exits immediately (simulates a failed start). */
  exitChild?: boolean;
  /** One-shot gate awaited before EVERY ping answer (dedup timing). */
  gate?: () => Promise<void>;
  /** How the Hub answers a restart request. */
  shutdown?: "accepted" | "unavailable";
}

interface World {
  fetchImpl: typeof fetch;
  spawnImpl: SpawnImpl;
  spawnCalls: Array<{ file: string; args: string[]; options: SpawnOptions }>;
  shutdownCalls: Array<{ url: string; method: string | undefined }>;
  fetchCount: () => number;
}

function createWorld(root: string, options: WorldOptions = {}): World {
  let mode: WorldMode = options.mode ?? "down";
  let fetches = 0;
  const children: FakeChild[] = [];
  const spawnCalls: World["spawnCalls"] = [];
  const shutdownCalls: World["shutdownCalls"] = [];

  const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
    fetches += 1;
    const url = String(input);
    if (url.endsWith("/api/hub/shutdown")) {
      shutdownCalls.push({ url, method: init?.method });
      if (options.shutdown === "unavailable") return jsonResponse({ error: "shutdown_unavailable" }, 503);
      mode = "down";
      return jsonResponse({ ok: true, service: DASHBOARD_SERVICE_NAME, exiting: true });
    }
    if (!url.includes("/api/ping")) throw new Error(`unexpected fetch: ${url}`);
    if (options.gate) await options.gate();
    if (mode === "foreign") return jsonResponse({ ok: true, service: "not-jobquay" });
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

  const spawnImpl = ((file: string, args: string[], spawnOptions: SpawnOptions) => {
    spawnCalls.push({ file, args, options: spawnOptions });
    const child = new FakeChild(4100 + children.length);
    children.push(child);
    if (options.exitChild) child.exitCode = 1;
    else mode = "ready";
    return child as unknown as ChildProcess;
  }) as unknown as SpawnImpl;

  return {
    fetchImpl,
    spawnImpl,
    spawnCalls,
    shutdownCalls,
    fetchCount: () => fetches
  };
}

function tmpRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-dispatch-ensure-${name}-`));
}

/** A one-shot gate whose release escapes the promise executor's closure. */
function deferredGate(): { promise: Promise<void>; release: () => void } {
  let doRelease: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    doRelease = resolve;
  });
  return { promise, release: () => doRelease() };
}

/** The shared context shape for one ensure attempt. */
function context(root: string, world: World, extra: Record<string, unknown> = {}) {
  return {
    root,
    env: {},
    requestEnv: null,
    fixture: false,
    port: 31210,
    fetchImpl: world.fetchImpl,
    spawnImpl: world.spawnImpl,
    expectedBuild: EXPECTED,
    ...extra
  } as Parameters<typeof ensureDashboardOnDispatch>[1];
}

test("a down port starts exactly one Hub and records the owned start", async () => {
  const root = tmpRoot("started");
  const world = createWorld(root, { mode: "down" });
  try {
    const record = await ensureDashboardOnDispatch("start", context(root, world));
    assert.equal(record.ok, true);
    assert.equal(record.action, "started");
    assert.equal(record.port, 31210);
    assert.equal(record.service, DASHBOARD_SERVICE_NAME);
    assert.equal(record.version, EXPECTED.version);
    assert.equal(record.build_id, EXPECTED.buildId);
    assert.ok(Number.isInteger(record.hub_pid) && (record.hub_pid as number) > 0);
    assert.equal(world.spawnCalls.length, 1, "exactly one Hub child");
    // The durable diagnostic is written and reads back.
    const persisted = readDispatchDashboardRecord(root);
    assert.deepEqual(persisted, record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy same-build Hub is reused without a second process", async () => {
  const root = tmpRoot("reused");
  const world = createWorld(root, { mode: "ready" });
  try {
    const record = await ensureDashboardOnDispatch("continue", context(root, world));
    assert.equal(record.ok, true);
    assert.equal(record.action, "reused");
    assert.equal(record.trigger, "continue");
    assert.equal(world.spawnCalls.length, 0, "no Hub child for a healthy Hub");
    assert.equal(world.shutdownCalls.length, 0, "a current build is never restarted");
    assert.equal(readDispatchDashboardRecord(root)?.action, "reused");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent accepted dispatches join ONE in-flight ensure", async () => {
  const root = tmpRoot("dedup");
  const gate = deferredGate();
  const world = createWorld(root, { mode: "down", gate: () => gate.promise });
  try {
    const first = ensureDashboardOnDispatch("start", context(root, world));
    const second = ensureDashboardOnDispatch("continue", context(root, world));
    // Both requests are in flight; neither has spawned yet.
    assert.equal(world.spawnCalls.length, 0);
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(world.spawnCalls.length, 1, "ONE Hub child for BOTH dispatches");
    assert.equal(a, b, "both dispatches share the same ensure result");
    assert.equal(a.action, "started");
  } finally {
    gate.release();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign listener is refused, never touched and recorded truthfully", async () => {
  const root = tmpRoot("foreign");
  const world = createWorld(root, { mode: "foreign" });
  try {
    const record = await ensureDashboardOnDispatch("start", context(root, world));
    assert.equal(record.ok, false);
    assert.equal(record.action, "refused");
    assert.equal(record.error?.code, "port_in_use");
    assert.equal(record.url, null);
    assert.equal(record.hub_pid, null);
    assert.equal(world.spawnCalls.length, 0, "no Hub is started for a foreign listener");
    assert.equal(world.shutdownCalls.length, 0, "a foreign listener is NEVER asked to stop");
    assert.equal(readDispatchDashboardRecord(root)?.action, "refused");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Hub that exits before readiness is a bounded recorded failure, never a throw", async () => {
  const root = tmpRoot("failed");
  const world = createWorld(root, { mode: "down", exitChild: true });
  try {
    const record = await ensureDashboardOnDispatch("start", context(root, world));
    assert.equal(record.ok, false);
    assert.equal(record.action, "failed");
    assert.equal(record.error?.code, "hub_start_failed");
    assert.ok((record.error?.message ?? "").length > 0);
    assert.ok((record.error?.message ?? "").length <= 300, "the diagnostic message is bounded");
    assert.equal(readDispatchDashboardRecord(root)?.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid configured port is a bounded truthful failure, never a synchronous throw and never a silent 30080 fallback", async () => {
  const root = tmpRoot("invalid-port");
  const world = createWorld(root, { mode: "down" });
  const writes: Array<{ root: string; record: DispatchDashboardRecord }> = [];
  let synchronousThrow: unknown = null;
  let record: DispatchDashboardRecord | null = null;
  try {
    // The exact proven defect shape: an invalid configured
    // HUB_PORT on an enabled (production) dispatch. Port
    // preparation happens before any Hub work, but the helper
    // must still return a promise — never throw synchronously.
    try {
      record = await ensureDashboardOnDispatch("start", {
        root,
        fixture: false,
        env: { HUB_PORT: "invalid" },
        writeRecord: (dataRoot, written) => { writes.push({ root: dataRoot, record: written }); }
      });
    } catch (e) {
      synchronousThrow = e;
    }
    assert.equal(synchronousThrow, null, "the helper must never throw, not even synchronously");
    assert.ok(record, "the helper must return a truthful failure record");
    assert.equal(record.ok, false);
    assert.equal(record.action, "failed");
    assert.equal(record.error?.code, "invalid_port");
    assert.equal(record.port, 0, "no port was resolved");
    assert.notEqual(record.port, 30080, "an invalid configured port must never silently fall back to 30080");
    assert.match(record.error?.message ?? "", /invalid/);
    assert.ok((record.error?.message ?? "").length <= 300, "the diagnostic message is bounded");
    assert.equal(world.spawnCalls.length, 0, "no Hub is started for an invalid port");
    assert.equal(writes.length, 1, "the failure is durably recorded");
    assert.equal(writes[0]!.record, record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Hub child env carries the authoritative data root and port", async () => {
  const root = tmpRoot("env");
  const world = createWorld(root, { mode: "down" });
  try {
    await ensureDashboardOnDispatch("start", context(root, world));
    assert.equal(world.spawnCalls.length, 1);
    const env = world.spawnCalls[0]!.options.env as NodeJS.ProcessEnv;
    assert.equal(env.CREWDISPATCH_DATA_ROOT, root, "the Hub serves the daemon's root");
    assert.equal(env.JOBQUAY_DATA_ROOT, undefined, "the legacy root var is removed");
    assert.equal(env.HUB_PORT, "31210", "the port travels to the Hub child");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the request env wins for Hub port resolution", async () => {
  const root = tmpRoot("port");
  const world = createWorld(root, { mode: "ready" });
  try {
    // No explicit port seam: resolution must come from the env.
    const noPort = { port: undefined };
    const caller = await ensureDashboardOnDispatch("start", context(root, world, {
      ...noPort,
      env: { HUB_PORT: "30010" },
      requestEnv: { HUB_PORT: "30011" }
    }));
    assert.equal(caller.port, 30011, "the caller's HUB_PORT owns the endpoint");
    const daemon = await ensureDashboardOnDispatch("start", context(root, world, {
      ...noPort,
      env: { HUB_PORT: "30010" },
      requestEnv: null
    }));
    assert.equal(daemon.port, 30010, "the daemon env applies when the caller names none");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fixture dispatches are skipped by default; the explicit override wins both ways", async () => {
  assert.equal(dispatchDashboardEnabled({ fixture: false, env: {} }), true, "production dispatch: on");
  assert.equal(dispatchDashboardEnabled({ fixture: true, env: {} }), false, "fixture dispatch: off (test isolation)");
  assert.equal(dispatchDashboardEnabled({ fixture: true, env: { [DISPATCH_DASHBOARD_ENV]: "1" } }), true, "opt-in covers fixtures");
  assert.equal(dispatchDashboardEnabled({ fixture: false, env: { [DISPATCH_DASHBOARD_ENV]: "0" } }), false, "explicit opt-out");

  const root = tmpRoot("skip");
  const world = createWorld(root, { mode: "down" });
  try {
    const skipped = await ensureDashboardOnDispatch("start", context(root, world, { fixture: true }));
    assert.equal(skipped.action, "skipped");
    assert.equal(skipped.ok, true);
    assert.equal(world.fetchCount(), 0, "a skipped ensure never probes the port");
    assert.equal(world.spawnCalls.length, 0);
    assert.equal(readDispatchDashboardRecord(root), null, "a skip writes nothing");

    const optedIn = await ensureDashboardOnDispatch("start", context(root, world, {
      fixture: true,
      env: { [DISPATCH_DASHBOARD_ENV]: "1" }
    }));
    assert.equal(optedIn.action, "started", "the real-boundary coverage opts into the actual lifecycle");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the dispatch diagnostic round-trips and absent records read as null", () => {
  const root = tmpRoot("diagnostic");
  const empty = tmpRoot("empty");
  try {
    const record: DispatchDashboardRecord = {
      product: "jobquay",
      kind: "jobquay-dashboard-dispatch-ensure",
      at: "2026-10-07T00:00:00.000Z",
      trigger: "start",
      ok: false,
      action: "refused",
      port: 31210,
      url: null,
      ping_url: null,
      hub_pid: null,
      service: null,
      version: null,
      build_id: null,
      error: { code: "port_in_use", message: "Port 31210 is already serving something that is not a CrewDispatch Hub." }
    };
    const written = writeDispatchDashboardRecord(root, record);
    assert.equal(written.ok, true);
    assert.equal(written.path, dispatchDashboardDiagnosticPath(root));
    assert.deepEqual(readDispatchDashboardRecord(root), record);
    assert.equal(readDispatchDashboardRecord(empty), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
