// dashboard-ensure.ts — the shared on-demand Dashboard lifecycle for
// ORDINARY dispatch.
//
// The FIRST accepted dispatch (start OR continue, from any MCP/Hub
// caller) quietly ensures the ONE CrewDispatch Hub for this data root
// through the SAME `ensureHub` primitive as `crewdispatch web` and the
// Windows login autostart — there is exactly one Hub lifecycle
// implementation, and this module only orchestrates WHEN it runs.
//
// Ownership and bounds (the contract every caller relies on):
//   * the daemon owns the attempt: it is triggered only AFTER a job
//     has been authoritatively admitted, runs off the response path,
//     and survives a caller disconnect;
//   * ONE in-flight ensure per daemon process: concurrent accepted
//     requests join the same attempt instead of launching competing
//     Hub copies (the probe-based reuse in `ensureHub` is the second
//     line of defense across processes);
//   * it NEVER throws and NEVER changes a dispatch outcome: every Hub
//     failure (port conflict, timeout, build mismatch) is recorded as
//     a small local diagnostic and reported as `ok: false`;
//   * it is finite: `ensureHub` bounds its own probe/start/restart
//     waits; nothing here adds a retry loop or a new deadline;
//   * it opens no browser and adds no process type beyond the Hub the
//     existing launcher already creates.
//
// Test isolation: a dispatch that drives the TEST-ONLY fixture runner
// is skipped by default, so ordinary fixture tests never start the
// user's Hub. The new real-boundary coverage opts in explicitly with
// `CREWDISPATCH_DISPATCH_DASHBOARD=1`; an operator (or a test) can
// force the behavior off with `=0`.
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../jobs/store";
import {
  DashboardLauncherError,
  ensureHub,
  resolveDashboardPort,
  type HubBuildExpectation,
  type HubEnsureResult,
  type SpawnImpl
} from "../dashboard/launcher";

export type DispatchDashboardTrigger = "start" | "continue";

export type DispatchDashboardAction =
  | "started"
  | "reused"
  | "restarted"
  | "refused"
  | "failed"
  | "skipped";

/** Explicit override for the on-demand dispatch Dashboard. */
export const DISPATCH_DASHBOARD_ENV = "CREWDISPATCH_DISPATCH_DASHBOARD";

/** Bounded shape of the on-demand Dashboard diagnostic (no secrets). */
export interface DispatchDashboardRecord {
  product: "jobquay";
  kind: "jobquay-dashboard-dispatch-ensure";
  at: string;
  trigger: DispatchDashboardTrigger;
  ok: boolean;
  action: DispatchDashboardAction;
  port: number;
  url: string | null;
  ping_url: string | null;
  hub_pid: number | null;
  service: string | null;
  version: string | null;
  build_id: string | null;
  error: { code: string; message: string } | null;
}

export interface DispatchDashboardContext {
  /** The daemon's authoritative data root; the Hub is forced to serve it. */
  root: string;
  /**
   * The daemon's own environment (base for port resolution and the Hub
   * child). On Windows the WMI-created daemon does not inherit the
   * caller's environment block, so…
   */
  env?: NodeJS.ProcessEnv;
  /**
   * …the caller-supplied request environment is layered on top of it
   * (it wins where present): the operator's `HUB_PORT`/`PORT` and
   * credential-free session variables travel with the dispatch payload
   * and must reach the Hub decision.
   */
  requestEnv?: NodeJS.ProcessEnv | null;
  /** True when the dispatch drives the TEST-ONLY fixture runner. */
  fixture: boolean;
  /** Explicit port (test/embedding seam); default: resolve from env. */
  port?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the child_process.spawn used for the Hub. */
  spawnImpl?: SpawnImpl;
  /** Test/embedding seam: the version+build this process expects. */
  expectedBuild?: HubBuildExpectation;
  now?: () => Date;
  /** Test seam: replaces the durable diagnostic write. */
  writeRecord?: (dataRoot: string, record: DispatchDashboardRecord) => void;
}

export function dispatchDashboardDiagnosticDir(dataRoot: string): string {
  return path.join(dataRoot, "dashboard");
}

export function dispatchDashboardDiagnosticPath(dataRoot: string): string {
  return path.join(dispatchDashboardDiagnosticDir(dataRoot), "dispatch-ensure.json");
}

/** Best-effort atomic write of the last ensure outcome; never throws. */
export function writeDispatchDashboardRecord(dataRoot: string, record: DispatchDashboardRecord): { ok: boolean; path: string } {
  const file = dispatchDashboardDiagnosticPath(dataRoot);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
    return { ok: true, path: file };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the temp file may not exist */
    }
    return { ok: false, path: file };
  }
}

/** Read the last on-demand ensure outcome (null when none was written). */
export function readDispatchDashboardRecord(dataRoot: string): DispatchDashboardRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(dispatchDashboardDiagnosticPath(dataRoot), "utf8")) as DispatchDashboardRecord;
    if (!parsed || parsed.product !== "jobquay" || parsed.kind !== "jobquay-dashboard-dispatch-ensure") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether a dispatch may bring up the Dashboard on demand.
 *
 * Production dispatches (no fixture) are ON by default — the first
 * ordinary accepted dispatch quietly ensures the Hub. Fixture dispatches
 * are OFF by default so ordinary fixture tests never start the user's
 * Hub; the explicit override exists for the real-boundary coverage that
 * opts into the actual lifecycle (and for forcing the feature off).
 */
export function dispatchDashboardEnabled(context: { fixture: boolean; env: NodeJS.ProcessEnv }): boolean {
  const override = context.env[DISPATCH_DASHBOARD_ENV]?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "on" || override === "real") return true;
  if (override === "0" || override === "false" || override === "off") return false;
  return !context.fixture;
}

/**
 * The environment the Hub decision and the Hub child see: the caller's
 * request env layered over the daemon's own, with the daemon's
 * authoritative data root forced (the Hub must serve exactly the data
 * root the daemon serves, never merely a listener on a port).
 */
function hubEnvForRoot(base: NodeJS.ProcessEnv, requestEnv: NodeJS.ProcessEnv | null | undefined, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(requestEnv ?? {}) };
  delete env.JOBQUAY_DATA_ROOT;
  delete env.CREWDISPATCH_DATA_ROOT;
  env.CREWDISPATCH_DATA_ROOT = root;
  return env;
}

function recordFromEnsure(result: HubEnsureResult, trigger: DispatchDashboardTrigger, at: string): DispatchDashboardRecord {
  return {
    product: "jobquay",
    kind: "jobquay-dashboard-dispatch-ensure",
    at,
    trigger,
    ok: true,
    action: result.action,
    port: result.port,
    url: result.url,
    ping_url: result.ping_url,
    hub_pid: result.hub_pid,
    service: result.service,
    version: result.version,
    build_id: result.build_id,
    error: null
  };
}

const ERROR_MESSAGE_CAP = 300;

// ONE in-flight ensure per process: a second accepted request joins the
// SAME attempt (and its record) instead of racing it to the port.
let inFlight: Promise<DispatchDashboardRecord> | null = null;

/**
 * Ensure the ONE Hub for this data root, on demand, from an accepted
 * dispatch. This helper NEVER throws and NEVER returns a rejected
 * promise: the synchronous port/root preparation is inside the same
 * protected attempt as the Hub work, so a caller that fires it
 * and forgets it can never observe a throw — every outcome,
 * including an invalid configured port, is a returned (and durably
 * recorded) result. A failed port resolution is recorded truthfully;
 * it is NEVER silently replaced by the default port.
 */
export function ensureDashboardOnDispatch(
  trigger: DispatchDashboardTrigger,
  context: DispatchDashboardContext
): Promise<DispatchDashboardRecord> {
  // The diagnostic write is best-effort: a failed write must never
  // change the recorded outcome, and never escape this helper.
  const writeBounded = (
    write: (dataRoot: string, record: DispatchDashboardRecord) => void,
    dataRoot: string,
    record: DispatchDashboardRecord
  ): void => {
    try {
      write(dataRoot, record);
    } catch {
      /* best-effort by contract */
    }
  };
  try {
    const base = context.env ?? process.env;
    const now = context.now ?? (() => new Date());
    const mergedEnv: NodeJS.ProcessEnv = { ...base, ...(context.requestEnv ?? {}) };
    if (!dispatchDashboardEnabled({ fixture: context.fixture, env: mergedEnv })) {
      return Promise.resolve({
        product: "jobquay",
        kind: "jobquay-dashboard-dispatch-ensure",
        at: now().toISOString(),
        trigger,
        ok: true,
        action: "skipped",
        port: resolveDashboardPort({ port: context.port, env: mergedEnv }),
        url: null,
        ping_url: null,
        hub_pid: null,
        service: null,
        version: null,
        build_id: null,
        error: null
      });
    }
    if (inFlight) return inFlight;
    // The diagnostic follows the daemon's resolved data root when that
    // resolution succeeds, and falls back to the caller's root only for
    // a best-effort record when even that preparation fails.
    let diagnosticRoot = context.root;
    const root = resolveDataRoot(context.root, base);
    diagnosticRoot = root;
    const at = now().toISOString();
    const env = hubEnvForRoot(base, context.requestEnv, root);
    const port = resolveDashboardPort({ port: context.port, env });
    const write = context.writeRecord ?? writeDispatchDashboardRecord;
    const attempt = (async (): Promise<DispatchDashboardRecord> => {
      try {
        const result = await ensureHub({
          port,
          env,
          fetchImpl: context.fetchImpl,
          spawnImpl: context.spawnImpl,
          expectedBuild: context.expectedBuild
        });
        const record = recordFromEnsure(result, trigger, at);
        writeBounded(write, root, record);
        return record;
      } catch (e) {
        const error = e instanceof DashboardLauncherError
          ? e
          : new DashboardLauncherError("dispatch_dashboard_failed", String((e as Error)?.message ?? e).slice(0, ERROR_MESSAGE_CAP));
        const record: DispatchDashboardRecord = {
          product: "jobquay",
          kind: "jobquay-dashboard-dispatch-ensure",
          at,
          trigger,
          ok: false,
          // A foreign listener and a Hub that does not prove ownership
          // of the requested data root are refusals (the other process
          // is never killed or replaced); every other failure is
          // recorded as a plain local failure.
          action:
            error.code === "port_in_use" ||
            error.code === "hub_root_mismatch" ||
            error.code === "hub_root_unproven"
              ? "refused"
              : "failed",
          port,
          url: null,
          ping_url: null,
          hub_pid: null,
          service: null,
          version: null,
          build_id: null,
          error: { code: error.code, message: error.message }
        };
        writeBounded(write, root, record);
        return record;
      }
    })();
    inFlight = attempt.finally(() => {
      inFlight = null;
    });
    return inFlight;
  } catch (e) {
    // Synchronous preparation failure — for example an invalid
    // configured HUB_PORT: a bounded, truthful, durably recorded
    // failure. No throw, no rejected promise, no silent fallback.
    const error = e instanceof DashboardLauncherError
      ? e
      : new DashboardLauncherError("dispatch_dashboard_failed", String((e as Error)?.message ?? e).slice(0, ERROR_MESSAGE_CAP));
    let at: string;
    try {
      at = (context.now ?? (() => new Date()))().toISOString();
    } catch {
      at = new Date().toISOString();
    }
    const record: DispatchDashboardRecord = {
      product: "jobquay",
      kind: "jobquay-dashboard-dispatch-ensure",
      at,
      trigger,
      ok: false,
      action: "failed",
      // No port was resolved; the raw configured value is named in the
      // bounded error message instead of being replaced by a default.
      port: 0,
      url: null,
      ping_url: null,
      hub_pid: null,
      service: null,
      version: null,
      build_id: null,
      error: { code: error.code, message: error.message }
    };
    let diagnosticRoot = context.root;
    try {
      diagnosticRoot = resolveDataRoot(context.root, context.env ?? process.env);
    } catch {
      /* best-effort diagnostic location */
    }
    writeBounded(context.writeRecord ?? writeDispatchDashboardRecord, diagnosticRoot, record);
    return Promise.resolve(record);
  }
}
