import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { computeBuildId, readPackageVersion, resolveHubRoot } from "../hub/identity";
import { dataRootId } from "../hub/endpoint";
import { resolveDataRoot } from "../jobs/store";
import { isPidAlive, killProcessTree } from "../runtime/process";
import { launchWindowsOutsideCallerJob, spawnDetachedProcess, supportsDurableLaunch, useDirectTestDurableLaunch } from "../runtime/durable-launch";

export const DEFAULT_DASHBOARD_PORT = 30080;
export const DASHBOARD_SERVICE_NAME = "jobquay";

/** The child_process.spawn signature, exposed so callers/tests can inject a seam. */
export type SpawnImpl = typeof spawn;

/** Opens a URL in the platform browser; exposed so tests never launch one. */
export type BrowserOpener = (platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv) => Promise<number | null>;

export interface DashboardLaunchOptions extends HubEnsureOptions {
  noOpen?: boolean;
  platform?: NodeJS.Platform;
  /** Test seam: replaces the real "open the system default browser" action. */
  browserOpener?: BrowserOpener;
}

export interface DashboardLaunchResult {
  ok: true;
  url: string;
  ping_url: string;
  port: number;
  started: boolean;
  restarted: boolean;
  action: HubEnsureAction;
  hub_pid: number | null;
  opened: boolean;
  browser_pid: number | null;
  service: string;
  version: string | null;
  build_id: string | null;
}

/** What one ensure attempt did to the port. */
export type HubEnsureAction = "started" | "reused" | "restarted";

/** The build a CrewDispatch Hub must report to be reusable by this process. */
export interface HubBuildExpectation {
  /** Package version; release upgrades are identified by this. */
  version: string | null;
  /** Served-build digest; development rebuilds are identified by this. */
  buildId: string | null;
}

/**
 * The shared "ensure one Hub" contract. `crewdispatch web` (browser) and the Windows
 * login autostart (headless) both go through `ensureHub`, so there is exactly
 * one server-lifecycle implementation: probe the identity endpoint, reuse a
 * healthy Hub running this version+build, restart a CrewDispatch Hub that is running
 * an older build, refuse a foreign listener, otherwise start one Hub process and
 * wait for readiness. On Windows the Hub is created OUTSIDE the caller's
 * (possibly kill-on-close) Job Object through the OS management service; on
 * POSIX it is a detached session leader. The Hub must outlive the caller either
 * way (JQ-20261005-55).
 */
export interface HubEnsureOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  hubEntry?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the child_process.spawn used for the Hub. */
  spawnImpl?: SpawnImpl;
  /** Test/embedding seam: the version+build this process expects to find. */
  expectedBuild?: HubBuildExpectation;
}

export interface HubEnsureResult {
  ok: true;
  url: string;
  ping_url: string;
  port: number;
  /** This ensure spawned the Hub process that now serves the port. */
  started: boolean;
  /** A Hub running an older build was replaced by this ensure attempt. */
  restarted: boolean;
  action: HubEnsureAction;
  hub_pid: number | null;
  service: string;
  version: string | null;
  /** The build the Hub now serving the port reports. */
  build_id: string | null;
}

export class DashboardLauncherError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DashboardLauncherError";
    this.code = code;
  }
}

export interface HubProbeResult {
  state: "ready" | "unreachable" | "foreign";
  version: string | null;
  /** The build the answering Hub snapshotted at ITS startup (null when absent). */
  buildId: string | null;
  /** The data-root identity the answering Hub reported (null when absent). */
  root_id: string | null;
}

function resolvedHubEntry(explicit?: string): string {
  return path.resolve(explicit || path.join(__dirname, "..", "hub", "server.js"));
}

function normalizePort(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new DashboardLauncherError("invalid_port", `Dashboard port must be an integer from 1 to 65535; got ${JSON.stringify(value)}.`);
  }
  return n;
}

/**
 * Resolve the configured Hub port with the existing supported precedence:
 * explicit value > `HUB_PORT` > `PORT` > 30080. The same resolver is used by
 * the browser launcher and the headless autostart path so both are
 * deterministic and can never silently pick a different port.
 */
export function resolveDashboardPort(options: { port?: number; env?: NodeJS.ProcessEnv } = {}): number {
  const env = options.env ?? process.env;
  return normalizePort(options.port ?? env.HUB_PORT ?? env.PORT ?? DEFAULT_DASHBOARD_PORT);
}

/**
 * Probe the loopback identity endpoint. Only a response whose body declares
 * `service: "jobquay"` is treated as CrewDispatch; anything else that answers is a
 * foreign listener and must never be killed or reused. The version/build id is
 * read from the SAME response the Hub snapshotted at its own startup, so it
 * describes the process actually holding the port.
 */
export async function probeHubEndpoint(port: number, fetchImpl: typeof fetch = fetch): Promise<HubProbeResult> {
  const url = `http://127.0.0.1:${port}/api/ping`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { state: "foreign", version: null, buildId: null, root_id: null };
    const body = (await response.json()) as Record<string, unknown>;
    if (body.ok === true && body.service === DASHBOARD_SERVICE_NAME) {
      return {
        state: "ready",
        version: typeof body.version === "string" ? body.version : null,
        buildId: typeof body.build_id === "string" ? body.build_id : null,
        root_id: typeof body.root_id === "string" ? body.root_id : null
      };
    }
    return { state: "foreign", version: null, buildId: null, root_id: null };
  } catch {
    return { state: "unreachable", version: null, buildId: null, root_id: null };
  }
}

/**
 * The version+build this process must find on the port. Defaults to the build it
 * is itself running from, computed once per ensure attempt (never per request).
 */
function expectedHubBuild(override?: HubBuildExpectation): HubBuildExpectation {
  if (override) return override;
  const root = resolveHubRoot(__dirname);
  return { version: readPackageVersion(root), buildId: computeBuildId(path.join(root, "dist")) };
}

/** True when the answering Hub runs exactly this version AND this build. */
function sameBuild(probe: HubProbeResult, expected: HubBuildExpectation): boolean {
  return probe.version === expected.version && probe.buildId === expected.buildId;
}

/**
 * Verify that the Hub now serving the port is the build this process expects.
 * Called after every start/restart so a success is never reported for a process
 * that does not actually match the build on disk.
 */
function assertServingBuild(probe: HubProbeResult, expected: HubBuildExpectation, port: number): void {
  if (sameBuild(probe, expected)) return;
  throw new DashboardLauncherError(
    "hub_build_mismatch",
    `The Hub on port ${port} reports version ${probe.version ?? "unknown"} / build ${probe.buildId ?? "unknown"} ` +
      `but this build is version ${expected.version ?? "unknown"} / build ${expected.buildId ?? "unknown"} ` +
      `Stop the Hub process and run the command again.`
  );
}

/** True when the answering Hub positively proves it serves THIS data root. */
function sameRoot(probe: HubProbeResult, root: string): boolean {
  return probe.root_id === dataRootId(root);
}

/**
 * The truthful refusal for an answering CrewDispatch Hub that does not
 * prove ownership of the requested data root. It is a refusal, never a
 * kill: the caller must leave the other-root Hub exactly as it is.
 */
function rootRefusalError(probe: HubProbeResult, root: string, port: number): DashboardLauncherError {
  const expectedRootId = dataRootId(root);
  return new DashboardLauncherError(
    probe.root_id === null ? "hub_root_unproven" : "hub_root_mismatch",
    probe.root_id === null
      ? `The CrewDispatch Hub on port ${port} did not report a data-root identity, so it cannot prove ownership of the requested data root. Stop that Hub process and run the command again.`
      : `The CrewDispatch Hub on port ${port} serves a different data root (its root identity ${probe.root_id} is not the requested root identity ${expectedRootId}). Choose another port with --port or stop that Hub process.`
  );
}

/**
 * Verify that the CrewDispatch Hub now serving the port positively proves
 * (via its live /api/ping root_id) that it serves the requested data root.
 * Only a SAME-root Hub may be reused, restarted or claimed; a Hub of
 * another data root — or one that cannot prove its root — is refused
 * truthfully and NEVER killed, reused or replaced, whatever build it
 * runs, and no alternate port is ever bound.
 */
function assertServingRoot(probe: HubProbeResult, root: string, port: number): void {
  if (!sameRoot(probe, root)) throw rootRefusalError(probe, root, port);
}

type ShutdownOutcome = "accepted" | "unavailable" | "unreachable";

/**
 * Ask a CrewDispatch Hub that runs an older build to exit so a rebuilt Hub can bind.
 * The request carries nothing: the launcher only sends it to a listener that
 * just identified itself as CrewDispatch on the same loopback port.
 */
async function requestHubShutdown(port: number, fetchImpl: typeof fetch): Promise<ShutdownOutcome> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/hub/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000)
    });
    if (response.ok) return "accepted";
    if (response.status === 404 || response.status === 405 || response.status === 503) return "unavailable";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Wait until the CrewDispatch Hub that answered before no longer holds the port. */
async function waitForHubRelease(port: number, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeHubEndpoint(port, fetchImpl);
    if (probe.state !== "ready") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const HUB_START_TIMEOUT_MS = 8000;
const HUB_RELEASE_TIMEOUT_MS = 5000;

interface HubStartOutcome {
  started: boolean;
  hub_pid: number | null;
  serving: HubProbeResult;
}

/**
 * Start one Hub and wait for a verified readiness.
 *
 * Ownership: on Windows the production path creates the Hub through the OS
 * management service (`src/runtime/durable-launch.ts`), so the Hub never
 * belongs to the caller's (possibly kill-on-close) Job Object — a Hub started
 * from Codex Desktop must outlive it, exactly like the daemon
 * (JQ-20261005-55). A caller that injects `spawnImpl` (tests) fully controls
 * child creation and keeps the plain detached spawn.
 *
 * Bind races keep the existing contract: if the launched process exits because
 * a concurrent ensure won the port, the winner is probed, verified and reused
 * instead of failing.
 */
async function startHubProcess(options: {
  port: number;
  env: NodeJS.ProcessEnv;
  hubEntry: string;
  spawnImpl: SpawnImpl;
  fetchImpl: typeof fetch;
  expected: HubBuildExpectation;
  /** The data root this launcher resolved; passed to a durable Hub as argv. */
  root: string;
  /** Create the Hub outside the caller's Windows Job Object. */
  durableLaunch: boolean;
}): Promise<HubStartOutcome> {
  const { port, env, hubEntry, spawnImpl, fetchImpl, expected, root, durableLaunch } = options;
  let hub: ChildProcess | null = null;
  let launchedPid: number | null = null;
  if (durableLaunch) {
    // The WMI-created process does not inherit this process's environment, so
    // the Hub receives its port and data root as argv (see hub/server.ts::main).
    try {
      launchedPid = launchWindowsOutsideCallerJob({
        file: process.execPath,
        args: [hubEntry, "--port", String(port), "--root", root]
      });
    } catch (e) {
      throw new DashboardLauncherError(
        "hub_start_failed",
        `CrewDispatch Hub could not be created outside the caller's Windows Job Object: ${String((e as Error)?.message || e)}`
      );
    }
  } else {
    hub = spawnDetachedProcess({
      file: process.execPath,
      args: [hubEntry],
      stdio: "ignore",
      env: { ...env, HUB_PORT: String(port) },
      spawnFn: spawnImpl
    });
    await waitForSpawn(hub, "hub_start_failed", "CrewDispatch Hub");
    launchedPid = hub.pid ?? null;
  }
  /** Kill only the process THIS call created moments ago (failure paths only). */
  const killLaunched = async (): Promise<void> => {
    if (hub) {
      try { hub.kill(); } catch {}
      return;
    }
    if (launchedPid != null && isPidAlive(launchedPid) === true) {
      await killProcessTree(launchedPid, { graceMs: 2000 }).catch(() => undefined);
    }
  };
  let started = true;
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  let serving: HubProbeResult;
  for (;;) {
    const current = await probeHubEndpoint(port, fetchImpl);
    if (current.state === "ready") {
      assertServingBuild(current, expected, port);
      if (!sameRoot(current, root)) {
        // The port is held by a CrewDispatch Hub of another data root (or
        // one that cannot prove its root). Kill only the child THIS call
        // just launched, then refuse truthfully: the other-root Hub is
        // never touched and no competing Hub is started.
        await killLaunched();
        throw rootRefusalError(current, root, port);
      }
      serving = current;
      break;
    }
    if (current.state === "foreign") {
      await killLaunched();
      throw new DashboardLauncherError("port_in_use", `Port ${port} became occupied by a non-CrewDispatch service while starting the Hub.`);
    }
    const launchedExited = hub
      ? hub.exitCode !== null || hub.signalCode !== null
      : launchedPid != null && isPidAlive(launchedPid) === false;
    if (launchedExited) {
      // The launched process exited before becoming ready. If another ensure won
      // the bind race in the meantime the port is healthy now, so reuse it
      // instead of reporting a failure or starting a second Hub.
      const afterExit = await probeHubEndpoint(port, fetchImpl);
      if (afterExit.state === "ready") {
        assertServingBuild(afterExit, expected, port);
        assertServingRoot(afterExit, root, port);
        started = false;
        serving = afterExit;
        break;
      }
      throw new DashboardLauncherError(
        "hub_start_failed",
        `CrewDispatch Hub exited before becoming ready (exit=${hub ? hub.exitCode ?? hub.signalCode : "process gone"}). ` +
          `The port may already be held by another local service that does not answer /api/ping.`
      );
    }
    if (Date.now() >= deadline) {
      await killLaunched();
      throw new DashboardLauncherError("hub_start_timeout", `CrewDispatch Hub did not become ready on port ${port} within ${HUB_START_TIMEOUT_MS / 1000} seconds.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { started, hub_pid: started ? launchedPid : null, serving };
}

async function waitForSpawn(child: ChildProcess, code: string, label: string): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new DashboardLauncherError(code, `${label} failed to start: ${error.message}`));
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

export function browserCommand(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (platform === "win32") {
    return {
      file: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", url]
    };
  }
  if (platform === "darwin") return { file: "/usr/bin/open", args: ["-g", url] };
  if (platform === "linux") return { file: "xdg-open", args: [url] };
  throw new DashboardLauncherError("platform_unsupported", `Opening the Dashboard is not supported on platform ${platform}; use --no-open and open the URL manually.`);
}

async function openBrowser(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  const command = browserCommand(platform, url, env);
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  });
  await waitForSpawn(child, "browser_open_failed", "Default browser");
  const pid = child.pid ?? null;
  child.unref();
  return pid;
}

function packageVersion(): string | null {
  return readPackageVersion(resolveHubRoot(__dirname));
}

/**
 * Ensure exactly one healthy CrewDispatch Hub of THIS version and THIS build owns the
 * configured loopback port.
 *
 * Rules:
 *   * a healthy CrewDispatch Hub reporting the same version AND the same build id
 *     is reused and no second process is created — but only when it also
 *     positively proves (via its live /api/ping root_id) that it serves the
 *     requested data root;
 *   * a CrewDispatch Hub of the SAME data root reporting an older version or an
 *     older build is restarted in a controlled way (it is asked to exit, the
 *     port must be released, the replacement must come up reporting this
 *     version+build AND this data root), so `crewdispatch web` can never claim
 *     success while an older Dashboard is still being served;
 *   * a Hub of ANOTHER data root, or one that cannot prove its data root, is
 *     refused (`hub_root_mismatch` / `hub_root_unproven`) and NEVER killed,
 *     reused or replaced — whatever build it runs — and no alternate port is
 *     bound;
 *   * a listener that is not CrewDispatch is refused (`port_in_use`) and NEVER
 *     killed or replaced, and no alternate port is bound;
 *   * two concurrent ensures that both start a child still end with ONE healthy
 *     Hub: the child that loses the bind race exits and the caller re-probes,
 *     verifies and reuses the winner instead of failing or respawning.
 *
 * This is deliberately probe-based: no PID/metadata file is trusted, so a stale
 * record from before a reboot can never block or duplicate the Hub.
 */
export async function ensureHub(options: HubEnsureOptions = {}): Promise<HubEnsureResult> {
  const env = options.env ?? process.env;
  const port = resolveDashboardPort({ port: options.port, env });
  const fetchImpl = options.fetchImpl ?? fetch;
  const spawnHub = options.spawnImpl ?? spawn;
  const expected = expectedHubBuild(options.expectedBuild);
  const url = `http://127.0.0.1:${port}/ui`;
  const pingUrl = `http://127.0.0.1:${port}/api/ping`;
  // The data root this ensure must own, resolved with the SAME shared
  // resolver the Hub itself uses. Ownership is proven against the live
  // /api/ping root_id at every reuse/restart/readiness decision below —
  // never from child args or metadata files alone.
  const root = resolveDataRoot(undefined, env);

  const initial = await probeHubEndpoint(port, fetchImpl);
  if (initial.state === "foreign") {
    throw new DashboardLauncherError(
      "port_in_use",
      `Port ${port} is already serving something that is not a CrewDispatch Hub. Choose another port with --port.`
    );
  }

  let started = false;
  let restarted = false;
  let hubPid: number | null = null;
  let serving: HubProbeResult | null = initial.state === "ready" ? initial : null;

  // Data-root ownership: only a Hub that positively proves it serves
  // THIS data root may be reused or restarted. This runs BEFORE any
  // restart request, so a Hub of another data root is never asked to
  // exit — whatever build it runs.
  if (serving !== null) {
    assertServingRoot(serving, root, port);
  }

  if (serving !== null && !sameBuild(serving, expected)) {
    const outcome = await requestHubShutdown(port, fetchImpl);
    if (outcome === "unavailable") {
      throw new DashboardLauncherError(
        "hub_restart_failed",
        `The Hub on port ${port} runs an older build but does not accept a restart request. ` +
          `Stop that Hub process and run the command again.`
      );
    }
    // "accepted" (or the request raced with an already-exiting Hub): the old
    // process must really release the port before a replacement may bind.
    if (!(await waitForHubRelease(port, fetchImpl, HUB_RELEASE_TIMEOUT_MS))) {
      throw new DashboardLauncherError(
        "hub_restart_failed",
        `The older Hub on port ${port} did not release the port within ${HUB_RELEASE_TIMEOUT_MS / 1000} seconds. ` +
          `Stop it manually and run the command again.`
      );
    }
    restarted = true;
    serving = null;
  }

  if (serving === null) {
    const hubEntry = resolvedHubEntry(options.hubEntry);
    if (!fs.existsSync(hubEntry)) {
      throw new DashboardLauncherError("hub_missing", `CrewDispatch Hub entry not found: ${hubEntry}`);
    }
    // Production Windows creates the Hub through the OS management service so
    // it never belongs to the caller's Job Object; an injected spawnImpl (test
    // seam) keeps full control of child creation. The data root resolved
    // above is passed explicitly on the durable Windows path (a WMI-created
    // process does not inherit this process's environment).
    const durableLaunch = options.spawnImpl === undefined && supportsDurableLaunch() && !useDirectTestDurableLaunch(env);
    const outcome = await startHubProcess({ port, env, hubEntry, spawnImpl: spawnHub, fetchImpl, expected, root, durableLaunch });
    started = outcome.started;
    hubPid = outcome.hub_pid;
    serving = outcome.serving;
  }

  return {
    ok: true,
    url,
    ping_url: pingUrl,
    port,
    started,
    restarted,
    action: restarted ? "restarted" : started ? "started" : "reused",
    hub_pid: hubPid,
    service: DASHBOARD_SERVICE_NAME,
    version: serving.version ?? packageVersion(),
    build_id: serving.buildId
  };
}

/**
 * The `crewdispatch web` entry: ensure the Hub, then open the Dashboard in the
 * system default browser unless the caller passed `--no-open`.
 */
export async function ensureDashboard(options: DashboardLaunchOptions = {}): Promise<DashboardLaunchResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const open = options.browserOpener ?? openBrowser;
  const hub = await ensureHub(options);

  let browserPid: number | null = null;
  let opened = false;
  if (!options.noOpen) {
    browserPid = await open(platform, hub.url, env);
    opened = true;
  }

  return {
    ...hub,
    opened,
    browser_pid: browserPid
  };
}
