// autostart.ts — the headless, no-browser form of the Dashboard lifecycle.
//
// `jobquay autostart run` is what the Windows login entry invokes. It reuses
// the EXACT same ensure-Hub implementation as `jobquay web` (probe identity,
// reuse a healthy Hub running this version+build, restart a Hub running an
// older build, refuse a foreign listener, otherwise start one detached Hub and
// wait for readiness) and it never opens a browser. Every run leaves a small
// durable diagnostic under the CrewDispatch data root so a failed login
// startup can be inspected later without a terminal:
//
//   <dataRoot>/autostart/last-run.json
//
// The record is product state, contains no credentials, and never influences
// the Hub itself: it is written after the ensure attempt and is best-effort.
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
} from "./launcher";

export interface AutostartRunRecord {
  product: "jobquay";
  kind: "jobquay-dashboard-autostart-run";
  at: string;
  ok: boolean;
  /** `restarted` = a Hub running an older build was replaced by this run. */
  action: "started" | "reused" | "restarted" | "refused" | "failed";
  port: number;
  url: string | null;
  ping_url: string | null;
  hub_pid: number | null;
  service: string | null;
  version: string | null;
  /** The build identity the Hub serving the port reports (null when unknown). */
  build_id: string | null;
  error: { code: string; message: string } | null;
}

export function autostartDiagnosticDir(dataRoot: string): string {
  return path.join(dataRoot, "autostart");
}

export function autostartDiagnosticPath(dataRoot: string): string {
  return path.join(autostartDiagnosticDir(dataRoot), "last-run.json");
}

/** Best-effort atomic write of the last-run diagnostic; never throws. */
export function writeAutostartRunRecord(dataRoot: string, record: AutostartRunRecord): { ok: boolean; path: string; error: string | null } {
  const file = autostartDiagnosticPath(dataRoot);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
    return { ok: true, path: file, error: null };
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* the temp file may not exist */
    }
    return { ok: false, path: file, error: String((error as Error)?.message || error) };
  }
}

export function readAutostartRunRecord(dataRoot: string): { ok: true; record: AutostartRunRecord | null } | { ok: false; error: string } {
  const file = autostartDiagnosticPath(dataRoot);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, record: null };
    return { ok: false, error: String((error as Error)?.message || error) };
  }
  try {
    const parsed = JSON.parse(raw) as AutostartRunRecord;
    if (!parsed || parsed.product !== "jobquay" || parsed.kind !== "jobquay-dashboard-autostart-run" || typeof parsed.at !== "string") {
      return { ok: false, error: "the recorded autostart diagnostic has an unsupported shape" };
    }
    return { ok: true, record: parsed };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

export interface RunAutostartOptions {
  port?: number;
  env?: NodeJS.ProcessEnv;
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the child_process.spawn used for the Hub. */
  spawnImpl?: SpawnImpl;
  /** Test/embedding seam: the version+build this process expects to find. */
  expectedBuild?: HubBuildExpectation;
  now?: Date;
}

export interface RunAutostartResult {
  ok: boolean;
  record: AutostartRunRecord;
  /** Where the durable diagnostic was written (even when writing failed). */
  diagnostic: { ok: boolean; path: string; error: string | null };
}

function recordFromEnsure(result: HubEnsureResult, at: string): AutostartRunRecord {
  return {
    product: "jobquay",
    kind: "jobquay-dashboard-autostart-run",
    at,
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

/**
 * Headless ensure used by the Windows login autostart. Returns exit code
 * semantics through `ok`: a foreign listener or a failed start is a local
 * failure that is recorded and reported, never retried in a loop here (the
 * registration runs the entry exactly once per login).
 */
export async function runDashboardAutostart(options: RunAutostartOptions = {}): Promise<RunAutostartResult> {
  const env = options.env ?? process.env;
  const dataRoot = options.dataRoot ?? resolveDataRoot(undefined, env);
  const at = (options.now ?? new Date()).toISOString();
  const port = resolveDashboardPort({ port: options.port, env });
  let record: AutostartRunRecord;
  try {
    const result = await ensureHub({
      port,
      env,
      fetchImpl: options.fetchImpl,
      spawnImpl: options.spawnImpl,
      expectedBuild: options.expectedBuild
    });
    record = recordFromEnsure(result, at);
  } catch (error) {
    const e = error instanceof DashboardLauncherError
      ? error
      : new DashboardLauncherError("autostart_failed", String((error as Error)?.message || error));
    record = {
      product: "jobquay",
      kind: "jobquay-dashboard-autostart-run",
      at,
      ok: false,
      action: e.code === "port_in_use" ? "refused" : "failed",
      port,
      url: null,
      ping_url: null,
      hub_pid: null,
      service: null,
      version: null,
      build_id: null,
      error: { code: e.code, message: e.message }
    };
  }
  const diagnostic = writeAutostartRunRecord(dataRoot, record);
  return { ok: record.ok, record, diagnostic };
}
