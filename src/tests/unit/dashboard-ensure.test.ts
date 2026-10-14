// dashboard-ensure.test.ts — pure/idempotent lifecycle tests for the ONE Hub
// ensure implementation shared by `jobquay web` and the Windows login
// autostart. Everything external (fetch, child spawn, browser open) is a
// deterministic seam here; the real processes are exercised by
// dashboard-cli.test.ts, dashboard-build-aware.test.ts and
// install-autostart.test.ts.
//
// The reuse contract under test is deliberately small:
//   * same version + same build id  -> reuse;
//   * same version, older build id  -> restart (a development rebuild);
//   * different version             -> restart (a release upgrade);
//   * a Hub that publishes no build id at all (older CrewDispatch) -> restart;
//   * anything that is not CrewDispatch  -> port_in_use, never killed.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  DASHBOARD_SERVICE_NAME,
  DashboardLauncherError,
  ensureDashboard,
  ensureHub,
  probeHubEndpoint,
  resolveDashboardPort,
  type HubBuildExpectation,
  type SpawnImpl
} from "../../dashboard/launcher";
import { readAutostartRunRecord, runDashboardAutostart, autostartDiagnosticPath } from "../../dashboard/autostart";
import { dataRootId } from "../../hub/endpoint";
import { resolveDataRoot } from "../../jobs/store";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The version+build the process under test expects to find on the port. */
const EXPECTED: HubBuildExpectation = { version: "0.0.0-m1", buildId: "build-current" };

interface WorldBuild {
  version: string | null;
  buildId: string | null;
}

const CURRENT_BUILD: WorldBuild = { version: EXPECTED.version, buildId: EXPECTED.buildId };

class FakeChild extends EventEmitter {
  pid: number | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unrefCalled = false;

  constructor(pid: number | null) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 1;
    return true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

type WorldMode =
  | { mode: "down" }
  | { mode: "ready"; build: WorldBuild }
  | { mode: "foreign" }
  | { mode: "downThenReady"; remaining: number; build: WorldBuild };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

interface WorldOptions {
  mode?: WorldMode;
  /** The spawned child exits immediately (simulates losing the bind race). */
  exitChild?: boolean;
  /** After a successful spawn the port answers as CrewDispatch with this build. */
  readyAfterSpawn?: WorldBuild | null;
  /** How the Hub answers a restart request. */
  shutdown?: "accepted" | "unavailable" | "no-route";
  /** The Hub keeps answering after the restart request (never releases). */
  shutdownKeepsPort?: boolean;
  /**
   * The root identity the answering Hub reports. The default is the
   * GENUINE identity of the data root this process resolves (so default
   * worlds are same-root Hubs); `null` simulates a Hub that cannot
   * prove its root; any other value is a controlled other-root identity.
   */
  rootId?: string | null;
}

function createWorld(options: WorldOptions = {}) {
  let mode: WorldMode = options.mode ?? { mode: "down" };
  const children: FakeChild[] = [];
  const spawnCalls: string[][] = [];
  const shutdownCalls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  // The genuine identity of the data root an ensure without an explicit
  // env resolves — the identity a same-root Hub reports.
  const rootId = options.rootId === undefined
    ? dataRootId(resolveDataRoot(undefined, process.env))
    : options.rootId;

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    if (url.endsWith("/api/hub/shutdown")) {
      shutdownCalls.push({ url, method: init?.method, body: init?.body ?? null });
      const verdict = options.shutdown ?? "accepted";
      if (verdict === "unavailable") return jsonResponse({ error: "shutdown_unavailable" }, 503);
      if (verdict === "no-route") return jsonResponse({ error: "not_found" }, 404);
      if (!options.shutdownKeepsPort) mode = { mode: "down" };
      return jsonResponse({ ok: true, service: DASHBOARD_SERVICE_NAME, exiting: true });
    }
    if (!url.includes("/api/ping")) throw new Error(`unexpected fetch: ${url}`);
    if (mode.mode === "foreign") return jsonResponse({ ok: true, service: "not-jobquay" });
    if (mode.mode === "ready") {
      return jsonResponse({
        ok: true,
        service: DASHBOARD_SERVICE_NAME,
        version: mode.build.version,
        build_id: mode.build.buildId,
        ...(rootId === null ? {} : { root_id: rootId })
      });
    }
    if (mode.mode === "downThenReady") {
      if (mode.remaining > 0) {
        mode.remaining -= 1;
        throw new Error("ECONNREFUSED");
      }
      return jsonResponse({
        ok: true,
        service: DASHBOARD_SERVICE_NAME,
        version: mode.build.version,
        build_id: mode.build.buildId,
        ...(rootId === null ? {} : { root_id: rootId })
      });
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const spawnImpl = ((file: string, args: string[]) => {
    spawnCalls.push([file, ...args]);
    const child = new FakeChild(4000 + children.length);
    children.push(child);
    if (options.exitChild) child.exitCode = 1;
    // A child that exits immediately never becomes ready, so it must not flip
    // the world to "ready" (that is the bind-race simulation).
    const readyBuild = options.readyAfterSpawn === undefined
      ? (options.exitChild ? null : CURRENT_BUILD)
      : options.readyAfterSpawn;
    if (readyBuild) mode = { mode: "ready", build: readyBuild };
    return child as unknown as ChildProcess;
  }) as unknown as SpawnImpl;

  return {
    fetchImpl,
    spawnImpl,
    children,
    spawnCalls,
    shutdownCalls,
    rootId,
    getMode: () => mode,
    setMode: (next: WorldMode) => { mode = next; }
  };
}

const HUB_ENTRY = path.join(__dirname, "..", "..", "hub", "server.js");

test("no listener -> exactly one Hub is started, then reused without a duplicate", async () => {
  const world = createWorld({ mode: { mode: "down" }, readyAfterSpawn: CURRENT_BUILD });
  const first = await ensureHub({ port: 31080, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(first.ok, true);
  assert.equal(first.started, true);
  assert.equal(first.restarted, false);
  assert.equal(first.action, "started");
  assert.equal(first.hub_pid, 4000);
  assert.equal(first.port, 31080);
  assert.equal(first.url, "http://127.0.0.1:31080/ui");
  assert.equal(first.ping_url, "http://127.0.0.1:31080/api/ping");
  assert.equal(first.service, "jobquay");
  assert.equal(first.version, EXPECTED.version);
  assert.equal(first.build_id, EXPECTED.buildId);
  assert.equal(world.spawnCalls.length, 1);
  assert.equal(world.children[0]!.unrefCalled, true, "the Hub child must be detached/unref'd");

  const second = await ensureHub({ port: 31080, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(second.started, false);
  assert.equal(second.restarted, false);
  assert.equal(second.action, "reused");
  assert.equal(second.hub_pid, null);
  assert.equal(world.spawnCalls.length, 1, "repeated ensure must not create a duplicate Hub");
  assert.equal(world.shutdownCalls.length, 0, "a same-build Hub is never asked to exit");

  const third = await ensureHub({ port: 31080, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(third.started, false);
  assert.equal(world.spawnCalls.length, 1);
});

test("a Hub running the same version and build is reused and never killed", async () => {
  const world = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD } });
  const result = await ensureHub({ port: 31081, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(result.action, "reused");
  assert.equal(result.started, false);
  assert.equal(result.hub_pid, null);
  assert.equal(result.version, EXPECTED.version);
  assert.equal(result.build_id, EXPECTED.buildId);
  assert.equal(world.spawnCalls.length, 0);
  assert.equal(world.children.length, 0);
  assert.equal(world.shutdownCalls.length, 0);
});

test("an unrelated listener is refused cleanly: no kill, no spawn, no alternate port", async () => {
  const world = createWorld({ mode: { mode: "foreign" } });
  await assert.rejects(
    () => ensureHub({ port: 31082, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "port_in_use");
      assert.match(error.message, /not a CrewDispatch Hub/);
      return true;
    }
  );
  assert.equal(world.spawnCalls.length, 0, "a foreign port must not be replaced by a spawned Hub");
  assert.equal(world.children.length, 0, "nothing may be spawned or killed");
  assert.equal(world.shutdownCalls.length, 0, "a foreign listener is never asked to exit");
  assert.deepEqual(world.getMode(), { mode: "foreign" }, "the unrelated service is left exactly as it was");
});

test("a development rebuild (same version, older build) restarts the Hub", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
    readyAfterSpawn: CURRENT_BUILD
  });
  const result = await ensureHub({ port: 31090, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });

  assert.equal(result.action, "restarted");
  assert.equal(result.restarted, true);
  assert.equal(result.started, true);
  assert.equal(result.hub_pid, 4000, "the replacement Hub is the process this ensure spawned");
  assert.equal(result.version, EXPECTED.version);
  assert.equal(result.build_id, EXPECTED.buildId);

  assert.equal(world.shutdownCalls.length, 1, "exactly one restart request");
  assert.equal(world.shutdownCalls[0]!.method, "POST");
  assert.match(world.shutdownCalls[0]!.url, /\/api\/hub\/shutdown$/);
  assert.equal(world.shutdownCalls[0]!.body, null, "the restart request carries no payload");
  assert.equal(world.spawnCalls.length, 1, "one replacement Hub, never a duplicate");
});

test("a release upgrade (different version) restarts the Hub", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: "0.0.0-m0", buildId: EXPECTED.buildId } },
    readyAfterSpawn: CURRENT_BUILD
  });
  const result = await ensureHub({ port: 31097, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(result.action, "restarted");
  assert.equal(result.version, EXPECTED.version);
  assert.equal(world.shutdownCalls.length, 1);
});

test("an older CrewDispatch Hub that publishes no build id is restarted, never reused", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: null } },
    readyAfterSpawn: CURRENT_BUILD
  });
  const result = await ensureHub({ port: 31091, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(result.action, "restarted");
  assert.equal(result.build_id, EXPECTED.buildId);
  assert.equal(world.shutdownCalls.length, 1);
});

test("a restart whose replacement does not report the expected build fails honestly", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
    readyAfterSpawn: { version: EXPECTED.version, buildId: "build-something-else" }
  });
  await assert.rejects(
    () => ensureHub({ port: 31092, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_build_mismatch");
      assert.match(error.message, /build-something-else/);
      assert.match(error.message, new RegExp(EXPECTED.buildId!));
      return true;
    }
  );
});

test("an older Hub that does not accept a restart request is reported, never replaced by a second Hub", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
    shutdown: "unavailable"
  });
  await assert.rejects(
    () => ensureHub({ port: 31093, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_restart_failed");
      assert.match(error.message, /older build/);
      return true;
    }
  );
  assert.equal(world.spawnCalls.length, 0, "a refused restart must never start a competing Hub");
});

test("an older Hub that never releases the port fails honestly", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
    shutdownKeepsPort: true
  });
  await assert.rejects(
    () => ensureHub({ port: 31094, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_restart_failed");
      assert.match(error.message, /did not release the port/);
      return true;
    }
  );
  assert.equal(world.spawnCalls.length, 0, "no replacement may be spawned while the old Hub still holds the port");
});

test("an older Hub without the restart route reports the unsupported restart honestly", async () => {
  const world = createWorld({
    mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
    shutdown: "no-route"
  });
  await assert.rejects(
    () => ensureHub({ port: 31095, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_restart_failed");
      return true;
    }
  );
  assert.equal(world.spawnCalls.length, 0);
});

test("a same-root same-build Hub is reused only after its root identity is verified", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-same-"));
  try {
    const world = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD }, rootId: dataRootId(dataRoot) });
    const result = await ensureHub({
      port: 31100,
      env: { CREWDISPATCH_DATA_ROOT: dataRoot },
      expectedBuild: EXPECTED,
      fetchImpl: world.fetchImpl,
      spawnImpl: world.spawnImpl,
      hubEntry: HUB_ENTRY
    });
    assert.equal(result.action, "reused");
    assert.equal(result.started, false);
    assert.equal(result.hub_pid, null);
    assert.equal(world.spawnCalls.length, 0);
    assert.equal(world.shutdownCalls.length, 0);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a same-root older-build Hub is still restarted (ownership never blocks the restart path)", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-restart-"));
  try {
    const world = createWorld({
      mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
      readyAfterSpawn: CURRENT_BUILD,
      rootId: dataRootId(dataRoot)
    });
    const result = await ensureHub({
      port: 31101,
      env: { CREWDISPATCH_DATA_ROOT: dataRoot },
      expectedBuild: EXPECTED,
      fetchImpl: world.fetchImpl,
      spawnImpl: world.spawnImpl,
      hubEntry: HUB_ENTRY
    });
    assert.equal(result.action, "restarted");
    assert.equal(result.restarted, true);
    assert.equal(result.started, true);
    assert.equal(world.shutdownCalls.length, 1);
    assert.equal(world.spawnCalls.length, 1);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a same-build Hub of ANOTHER data root is refused: never reused, killed or replaced", async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-b-"));
  try {
    const world = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD }, rootId: dataRootId(rootA) });
    await assert.rejects(
      () => ensureHub({
        port: 31102,
        env: { CREWDISPATCH_DATA_ROOT: rootB },
        expectedBuild: EXPECTED,
        fetchImpl: world.fetchImpl,
        spawnImpl: world.spawnImpl,
        hubEntry: HUB_ENTRY
      }),
      (error: unknown) => {
        assert.ok(error instanceof DashboardLauncherError);
        assert.equal(error.code, "hub_root_mismatch");
        assert.match(error.message, new RegExp(dataRootId(rootA)));
        assert.match(error.message, new RegExp(dataRootId(rootB)));
        return true;
      }
    );
    assert.equal(world.spawnCalls.length, 0, "a competing Hub must never be spawned");
    assert.equal(world.children.length, 0, "nothing may be spawned or killed");
    assert.equal(world.shutdownCalls.length, 0, "another root's Hub is never asked to exit");
    assert.deepEqual(world.getMode(), { mode: "ready", build: CURRENT_BUILD }, "the other root's Hub is left exactly as it was");
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("an older-build Hub of ANOTHER data root is refused WITHOUT any shutdown request", async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-old-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-old-b-"));
  try {
    const world = createWorld({
      mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
      rootId: dataRootId(rootA)
    });
    await assert.rejects(
      () => ensureHub({
        port: 31103,
        env: { CREWDISPATCH_DATA_ROOT: rootB },
        expectedBuild: EXPECTED,
        fetchImpl: world.fetchImpl,
        spawnImpl: world.spawnImpl,
        hubEntry: HUB_ENTRY
      }),
      (error: unknown) => {
        assert.ok(error instanceof DashboardLauncherError);
        assert.equal(error.code, "hub_root_mismatch");
        return true;
      }
    );
    assert.equal(world.shutdownCalls.length, 0, "an older Hub of another root must NOT be shutdown or restarted");
    assert.equal(world.spawnCalls.length, 0, "no replacement may be spawned for another root's Hub");
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("a Hub that cannot prove its data root is conservatively refused", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-root-unproven-"));
  try {
    const world = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD }, rootId: null });
    await assert.rejects(
      () => ensureHub({
        port: 31104,
        env: { CREWDISPATCH_DATA_ROOT: dataRoot },
        expectedBuild: EXPECTED,
        fetchImpl: world.fetchImpl,
        spawnImpl: world.spawnImpl,
        hubEntry: HUB_ENTRY
      }),
      (error: unknown) => {
        assert.ok(error instanceof DashboardLauncherError);
        assert.equal(error.code, "hub_root_unproven");
        assert.match(error.message, /did not report a data-root identity/);
        return true;
      }
    );
    assert.equal(world.spawnCalls.length, 0);
    assert.equal(world.shutdownCalls.length, 0);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a bind race (child exits, another Hub became ready) reuses the winner instead of failing", async () => {
  const world = createWorld({
    mode: { mode: "downThenReady", remaining: 2, build: CURRENT_BUILD },
    exitChild: true
  });
  const result = await ensureHub({ port: 31083, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY });
  assert.equal(result.started, false, "the loser of the bind race must report a reuse, not a new start");
  assert.equal(result.action, "reused");
  assert.equal(result.hub_pid, null);
  assert.equal(result.build_id, EXPECTED.buildId);
  assert.equal(world.spawnCalls.length, 1);
});

test("a bind race whose winner is not the expected build is refused, not reused", async () => {
  const world = createWorld({
    mode: { mode: "downThenReady", remaining: 1, build: { version: EXPECTED.version, buildId: "build-not-mine" } },
    exitChild: true
  });
  await assert.rejects(
    () => ensureHub({ port: 31096, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_build_mismatch");
      return true;
    }
  );
});

test("a Hub that exits with nothing listening fails honestly", async () => {
  const world = createWorld({ mode: { mode: "down" }, exitChild: true });
  await assert.rejects(
    () => ensureHub({ port: 31084, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, hubEntry: HUB_ENTRY }),
    (error: unknown) => {
      assert.ok(error instanceof DashboardLauncherError);
      assert.equal(error.code, "hub_start_failed");
      return true;
    }
  );
});

test("probeHubEndpoint distinguishes CrewDispatch, foreign and unreachable listeners and reports their build and root", async () => {
  const world = createWorld({ mode: { mode: "ready", build: { version: "7.0.0", buildId: "b-1" } } });
  const ready = await probeHubEndpoint(31085, world.fetchImpl);
  assert.deepEqual(ready, { state: "ready", version: "7.0.0", buildId: "b-1", root_id: world.rootId });
  const noBuildWorld = createWorld({ mode: { mode: "ready", build: { version: "0.0.1", buildId: null } } });
  const noBuild = await probeHubEndpoint(31085, noBuildWorld.fetchImpl);
  assert.deepEqual(noBuild, { state: "ready", version: "0.0.1", buildId: null, root_id: noBuildWorld.rootId });
  const unprovenWorld = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD }, rootId: null });
  const noRoot = await probeHubEndpoint(31085, unprovenWorld.fetchImpl);
  assert.deepEqual(noRoot, { state: "ready", version: EXPECTED.version, buildId: EXPECTED.buildId, root_id: null });
  const foreign = await probeHubEndpoint(31085, createWorld({ mode: { mode: "foreign" } }).fetchImpl);
  assert.deepEqual(foreign, { state: "foreign", version: null, buildId: null, root_id: null });
  const down = await probeHubEndpoint(31085, createWorld({ mode: { mode: "down" } }).fetchImpl);
  assert.deepEqual(down, { state: "unreachable", version: null, buildId: null, root_id: null });
});

test("the Hub port resolution keeps the existing precedence and rejects invalid values", () => {
  assert.equal(resolveDashboardPort({ env: {} }), 30080);
  assert.equal(resolveDashboardPort({ env: { PORT: "30100" } }), 30100);
  assert.equal(resolveDashboardPort({ env: { PORT: "30100", HUB_PORT: "30200" } }), 30200);
  assert.equal(resolveDashboardPort({ port: 30300, env: { HUB_PORT: "30200" } }), 30300);
  assert.throws(() => resolveDashboardPort({ env: { HUB_PORT: "70000" } }), (error: unknown) => {
    assert.ok(error instanceof DashboardLauncherError);
    assert.equal(error.code, "invalid_port");
    return true;
  });
});

test("jobquay web opens the browser unless --no-open is given", async () => {
  const calls: { url: string; platform: NodeJS.Platform }[] = [];
  const opener = async (platform: NodeJS.Platform, url: string) => {
    calls.push({ url, platform });
    return 777;
  };

  const world = createWorld({ mode: { mode: "ready", build: CURRENT_BUILD } });
  const opened = await ensureDashboard({
    port: 31086,
    expectedBuild: EXPECTED,
    fetchImpl: world.fetchImpl,
    spawnImpl: world.spawnImpl,
    hubEntry: HUB_ENTRY,
    browserOpener: opener
  });
  assert.equal(opened.opened, true);
  assert.equal(opened.browser_pid, 777);
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:31086/ui", platform: process.platform }]);

  calls.length = 0;
  const headless = await ensureDashboard({
    port: 31086,
    noOpen: true,
    expectedBuild: EXPECTED,
    fetchImpl: world.fetchImpl,
    spawnImpl: world.spawnImpl,
    hubEntry: HUB_ENTRY,
    browserOpener: opener
  });
  assert.equal(headless.opened, false);
  assert.equal(headless.browser_pid, null);
  assert.deepEqual(calls, [], "--no-open must never touch the browser");
});

test("headless autostart run records a durable diagnostic and never opens a browser", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-run-"));
  try {
    const world = createWorld({ mode: { mode: "down" }, readyAfterSpawn: CURRENT_BUILD });
    const first = await runDashboardAutostart({
      port: 31087,
      dataRoot,
      expectedBuild: EXPECTED,
      fetchImpl: world.fetchImpl,
      spawnImpl: world.spawnImpl,
      now: new Date("2026-09-30T10:00:00.000Z")
    });
    assert.equal(first.ok, true);
    assert.equal(first.record.action, "started");
    assert.equal(first.record.at, "2026-09-30T10:00:00.000Z");
    assert.equal(first.record.build_id, EXPECTED.buildId);
    assert.equal(first.diagnostic.ok, true);
    assert.equal(first.diagnostic.path, autostartDiagnosticPath(dataRoot));

    const recorded = readAutostartRunRecord(dataRoot);
    assert.equal(recorded.ok, true);
    assert.equal(recorded.ok === true ? recorded.record?.action : null, "started");
    assert.equal(fs.existsSync(autostartDiagnosticPath(dataRoot)), true);

    const second = await runDashboardAutostart({ port: 31087, dataRoot, expectedBuild: EXPECTED, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl });
    assert.equal(second.record.action, "reused");
    assert.equal(world.spawnCalls.length, 1, "the second headless trigger reuses the Hub");

    // A rebuilt installation at login restarts the Hub instead of reporting a
    // false reuse.
    const rebuilt = createWorld({
      mode: { mode: "ready", build: { version: EXPECTED.version, buildId: "build-previous" } },
      readyAfterSpawn: CURRENT_BUILD
    });
    const third = await runDashboardAutostart({ port: 31087, dataRoot, expectedBuild: EXPECTED, fetchImpl: rebuilt.fetchImpl, spawnImpl: rebuilt.spawnImpl });
    assert.equal(third.ok, true);
    assert.equal(third.record.action, "restarted");
    assert.equal(third.record.build_id, EXPECTED.buildId);
    assert.equal(third.record.hub_pid, 4000);
    const rerecorded = readAutostartRunRecord(dataRoot);
    assert.equal(rerecorded.ok === true ? rerecorded.record?.action : null, "restarted");

    const foreign = createWorld({ mode: { mode: "foreign" } });
    const refused = await runDashboardAutostart({ port: 31087, dataRoot, expectedBuild: EXPECTED, fetchImpl: foreign.fetchImpl, spawnImpl: foreign.spawnImpl });
    assert.equal(refused.ok, false);
    assert.equal(refused.record.action, "refused");
    assert.equal(refused.record.error?.code, "port_in_use");
    assert.equal(foreign.spawnCalls.length, 0);
    const afterRefusal = readAutostartRunRecord(dataRoot);
    assert.equal(afterRefusal.ok === true ? afterRefusal.record?.error?.code : null, "port_in_use");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
