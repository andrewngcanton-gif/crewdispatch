import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { captureProcessIdentity, isPidAlive } from "../runtime/process";
import { launchWindowsOutsideCallerJob, spawnDetachedProcess, useDirectTestDurableLaunch } from "../runtime/durable-launch";
import { loadJob, resolveDataRoot } from "../jobs/store";
import type { JobRecord } from "../jobs/types";
import { isValidClaudeBindingId, isValidClaudeSessionId } from "../claude/ids";
import { loadConfigResult } from "../config/schema";
import { loadWorkBuddyAiConfigResult } from "../config/workbuddy-ai";
import { COMMAND_CODE_PROVIDER } from "../providers/command-code";
import { WORKBUDDY_AI_PROVIDER } from "../providers/workbuddy-ai";
import {
  DAEMON_META_VERSION,
  DAEMON_PROTOCOL_VERSION,
  type DaemonContinuePayload,
  type DaemonMeta,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStartPayload
} from "./protocol";

/** The shared bound on one daemon startup wait (published metadata + a live ping). */
export const START_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Bound on ONE liveness ping. Always capped by the caller's remaining budget. */
const PING_TIMEOUT_MS = 1500;
/** Startup-poll interval. Always capped by the caller's remaining budget. */
const POLL_INTERVAL_MS = 100;

export class JobDaemonError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JobDaemonError";
    this.code = code;
  }
}

export interface DaemonPaths {
  dir: string;
  meta: string;
  lock: string;
}

export function daemonPaths(rootInput: string, env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const root = resolveDataRoot(rootInput, env);
  const dir = path.join(root, "daemon");
  return {
    dir,
    meta: path.join(dir, "daemon.json"),
    lock: path.join(dir, "launch.lock")
  };
}

function ensureDaemonDir(paths: DaemonPaths): void {
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
}

function safeReadMeta(paths: DaemonPaths): DaemonMeta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.meta, "utf8")) as Partial<DaemonMeta>;
    if (
      parsed.version !== DAEMON_META_VERSION ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      !Number.isSafeInteger(parsed.port) ||
      Number(parsed.port) <= 0 ||
      Number(parsed.port) > 65535 ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 32 ||
      typeof parsed.heartbeatAt !== "string" ||
      typeof parsed.serverPath !== "string"
    ) return null;
    const startedAtUs = optionalPositiveInteger(parsed.startedAtUs);
    const pgid = optionalPositiveInteger(parsed.pgid);
    const sid = optionalPositiveInteger(parsed.sid);
    if (startedAtUs === undefined && parsed.startedAtUs !== undefined) return null;
    if (pgid === undefined && parsed.pgid !== undefined) return null;
    if (sid === undefined && parsed.sid !== undefined) return null;
    return {
      ...(parsed as DaemonMeta),
      ...(parsed.startedAtUs !== undefined ? { startedAtUs } : {}),
      ...(parsed.pgid !== undefined ? { pgid } : {}),
      ...(parsed.sid !== undefined ? { sid } : {})
    };
  } catch {
    return null;
  }
}

type DaemonIdentityState = "same" | "dead" | "reused" | "unknown";

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function daemonIdentityState(meta: DaemonMeta): DaemonIdentityState {
  const alive = isPidAlive(meta.pid);
  if (alive === false) return "dead";
  if (alive !== true) return "unknown";
  if (process.platform !== "darwin") return "same";
  // Legacy metadata has no exact birth. An authenticated ping may still prove
  // the broker, but a failed ping cannot treat this live same-number PID as stale.
  if (meta.startedAtUs == null) return "unknown";
  const current = captureProcessIdentity(meta.pid);
  if (!current || current.createdAtUs == null) return "unknown";
  return current.createdAtUs === meta.startedAtUs ? "same" : "reused";
}

function requestId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function send(meta: DaemonMeta, req: Omit<DaemonRequest, "token">, timeoutMs = REQUEST_TIMEOUT_MS): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: meta.port });
    let settled = false;
    let bytes = 0;
    let buf = "";
    const done = (err?: Error, value?: DaemonResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value as DaemonResponse);
    };
    socket.setTimeout(timeoutMs, () => done(new JobDaemonError("daemon_timeout", "CrewDispatch daemon request timed out.")));
    socket.on("error", (e) => done(new JobDaemonError("daemon_unreachable", String((e as Error)?.message || e))));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        done(new JobDaemonError("daemon_response_too_large", "CrewDispatch daemon response exceeded the local safety limit."));
        return;
      }
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as DaemonResponse;
        done(undefined, parsed);
      } catch (e) {
        done(new JobDaemonError("daemon_bad_response", `Invalid CrewDispatch daemon response: ${String((e as Error)?.message || e)}`));
      }
    });
    socket.on("connect", () => {
      const wire = { ...req, token: meta.token } as DaemonRequest;
      socket.end(JSON.stringify(wire) + "\n");
    });
  });
}

async function ping(meta: DaemonMeta, timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
  if (timeoutMs <= 0) return false;
  if (isPidAlive(meta.pid) !== true) return false;
  if (process.platform === "darwin" && meta.startedAtUs != null && daemonIdentityState(meta) !== "same") return false;
  try {
    const r = await send(meta, { version: 1, id: requestId(), op: "ping", payload: null }, Math.max(1, Math.min(PING_TIMEOUT_MS, timeoutMs)));
    return r.ok && r.op === "ping" && "pong" in r.result && r.result.pong === true && r.result.pid === meta.pid;
  } catch {
    return false;
  }
}

function unlinkIfStale(paths: DaemonPaths, meta: DaemonMeta | null): void {
  const state = meta ? daemonIdentityState(meta) : "dead";
  if (!meta || state === "dead" || state === "reused") {
    try { fs.unlinkSync(paths.meta); } catch {}
  }
}

function acquireLaunchLock(paths: DaemonPaths): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(paths.lock, "wx", 0o600);
      const self = process.platform === "darwin" ? captureProcessIdentity(process.pid) : null;
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAtUs: self?.createdAtUs ?? null, at: new Date().toISOString() }), "utf8");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(paths.lock); } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      let ownerPid: number | null = null;
      let ownerReused = false;
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        const stat = fs.statSync(paths.lock);
        ageMs = Date.now() - stat.mtimeMs;
        const marker = JSON.parse(fs.readFileSync(paths.lock, "utf8")) as { pid?: unknown; startedAtUs?: unknown };
        if (Number.isSafeInteger(marker.pid) && Number(marker.pid) > 0) ownerPid = Number(marker.pid);
        if (
          ownerPid != null &&
          process.platform === "darwin" &&
          typeof marker.startedAtUs === "number" &&
          Number.isSafeInteger(marker.startedAtUs) &&
          marker.startedAtUs > 0 &&
          isPidAlive(ownerPid) === true
        ) {
          const current = captureProcessIdentity(ownerPid);
          if (current?.createdAtUs != null && current.createdAtUs !== marker.startedAtUs) ownerReused = true;
        }
      } catch {}
      if (ownerReused || (ownerPid != null && isPidAlive(ownerPid) === false) || (ownerPid == null && ageMs > 60_000)) {
        try { fs.unlinkSync(paths.lock); } catch {}
        continue;
      }
      throw new JobDaemonError("daemon_launch_busy", "Another process is starting the CrewDispatch daemon.");
    }
  }
  throw new JobDaemonError("daemon_launch_busy", "Could not acquire the CrewDispatch daemon launch lock.");
}

/**
 * Launch the daemon through the shared outside-Job-Object mechanism.
 *
 * `remainingMs` bounds the CREATION call only (never the created broker's
 * lifetime): a caller's budget must not be spent waiting on WMI/PowerShell.
 */
function launchDaemonDurably(root: string, serverPath: string, env: NodeJS.ProcessEnv, remainingMs?: number | null): void {
  // Functional Windows suites create many disposable data roots. Repeated WMI
  // cold starts are both unnecessary for those tests and can saturate the hosted
  // runner's CIM provider. The explicit TEST-ONLY seam keeps their process graph
  // real while the dedicated durable-launch tests continue to exercise WMI.
  if (useDirectTestDurableLaunch(env)) {
    spawnDetachedProcess({
      file: process.execPath,
      args: [serverPath, "--root", root],
      stdio: "ignore",
      env
    });
    return;
  }
  // IMPORTANT: do not CreateProcess the daemon from this MCP/Hub process. Codex
  // Desktop can place its whole plugin tree inside a kill-on-close Windows Job
  // Object, and ordinary Node `detached:true` children remain members of it.
  //
  // `src/runtime/durable-launch.ts` asks the OS CIM/WMI provider to
  // CreateProcess instead. The daemon's creator is then the Windows management
  // service, outside the disposable client Job Object; workers spawned by that
  // daemon inherit the durable ownership. The helper also owns the verified
  // headless startup form (see its module comment) and the argv quoting.
  try {
    launchWindowsOutsideCallerJob({ file: process.execPath, args: [serverPath, "--root", root], timeoutMs: remainingMs ?? null });
  } catch (e) {
    throw new JobDaemonError(
      "daemon_launch_failed",
      `Could not launch the CrewDispatch daemon outside the caller's Windows Job Object: ${String((e as Error)?.message || e)}`
    );
  }
}

function launchPosix(root: string, serverPath: string): void {
  spawnDetachedProcess({
    file: process.execPath,
    args: [serverPath, "--root", root],
    stdio: "ignore",
    env: process.env
  });
}

async function waitForDaemon(paths: DaemonPaths, deadlineMs: number): Promise<DaemonMeta> {
  let last: DaemonMeta | null = null;
  for (;;) {
    // Every awaited step below is bounded by what is ACTUALLY left, not by a
    // fixed constant: a 1500ms ping or a 100ms sleep started inside a 250ms
    // budget is precisely what overruns the caller's deadline.
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    const meta = safeReadMeta(paths);
    if (meta) {
      last = meta;
      if (await ping(meta, Math.min(PING_TIMEOUT_MS, remaining))) return meta;
      const state = daemonIdentityState(meta);
      if (state === "dead" || state === "reused") unlinkIfStale(paths, meta);
    }
    const afterPing = deadlineMs - Date.now();
    if (afterPing <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, afterPing)));
  }
  throw new JobDaemonError(
    "daemon_start_timeout",
    last
      ? `CrewDispatch daemon pid ${last.pid} did not become responsive.`
      : "CrewDispatch daemon did not publish startup metadata."
  );
}

export interface EnsureDaemonOptions {
  /**
   * Absolute deadline (ms since epoch) bounding connect/start. When set, the
   * startup wait never runs past it: a caller with its own end-to-end budget
   * needs the startup machinery itself to stop at that deadline, rather than an
   * unsettled wait loop (or an abandoned launch promise) outliving the budget
   * it was supposed to be bounded by.
   */
  deadlineMs?: number | null;
}

export async function ensureJobDaemon(
  rootInput: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: EnsureDaemonOptions = {}
): Promise<DaemonMeta> {
  const root = resolveDataRoot(rootInput, env);
  const paths = daemonPaths(root, env);
  ensureDaemonDir(paths);

  const deadline = Number.isFinite(opts.deadlineMs as number) ? (opts.deadlineMs as number) : null;
  const remaining = (): number => (deadline === null ? Number.POSITIVE_INFINITY : deadline - Date.now());
  /** One awaited step's bound: never larger than what is left, never nonpositive. */
  const bounded = (max: number): number => Math.max(1, Math.min(max, remaining()));
  // Never longer than the caller's budget, never longer than the ordinary
  // startup bound.
  const startDeadline = (): number => Math.min(Date.now() + START_TIMEOUT_MS, deadline ?? Number.POSITIVE_INFINITY);
  if (remaining() <= 0) {
    throw new JobDaemonError("daemon_start_timeout", "CrewDispatch daemon budget expired before startup could be attempted.");
  }

  const existing = safeReadMeta(paths);
  if (existing) {
    if (await ping(existing, bounded(PING_TIMEOUT_MS))) return existing;
    const state = daemonIdentityState(existing);
    if (state !== "dead" && state !== "reused") {
      throw new JobDaemonError(
        "daemon_unhealthy",
        `CrewDispatch daemon pid ${existing.pid} is still present or its exact identity is unknown, but it is not responding; refusing to start a second broker for the same data root.`
      );
    }
    unlinkIfStale(paths, existing);
  }
  let release: (() => void) | null = null;
  try {
    try {
      release = acquireLaunchLock(paths);
    } catch (e) {
      if (e instanceof JobDaemonError && e.code === "daemon_launch_busy") {
        return await waitForDaemon(paths, startDeadline());
      }
      throw e;
    }

    const afterLock = safeReadMeta(paths);
    if (afterLock) {
      if (await ping(afterLock, bounded(PING_TIMEOUT_MS))) return afterLock;
      const state = daemonIdentityState(afterLock);
      if (state !== "dead" && state !== "reused") {
        throw new JobDaemonError(
          "daemon_unhealthy",
          `CrewDispatch daemon pid ${afterLock.pid} is still present or its exact identity is unknown, but it is not responding; refusing to start a second broker for the same data root.`
        );
      }
      unlinkIfStale(paths, afterLock);
    }
    const serverPath = path.join(__dirname, "server.js");
    if (!fs.existsSync(serverPath)) {
      throw new JobDaemonError("daemon_missing", `CrewDispatch daemon entry is missing: ${serverPath} (build dist first).`);
    }
    // Re-check the budget IMMEDIATELY before creating a process: everything
    // above (the launch lock, a ping, a stale-metadata unlink) can consume it,
    // and starting a broker we will not wait for would outlive the budget.
    // One millisecond is the durable-launch helper's minimum representable
    // creation timeout. Treat that floor as exhausted here: launching with it can
    // only turn an already-spent end-to-end budget into daemon_launch_failed and,
    // on a very fast host, may create a broker the caller no longer has time to
    // observe. Refuse before process creation instead.
    if (remaining() <= 1) {
      throw new JobDaemonError("daemon_start_timeout", "CrewDispatch daemon budget expired before the broker could be launched.");
    }
    if (process.platform === "win32") launchDaemonDurably(root, serverPath, env, remaining());
    else launchPosix(root, serverPath);
    return await waitForDaemon(paths, startDeadline());
  } finally {
    try { release?.(); } catch {}
  }
}

async function call(root: string, env: NodeJS.ProcessEnv, req: Omit<DaemonRequest, "token">): Promise<DaemonResponse> {
  const meta = await ensureJobDaemon(root, env);
  let r: DaemonResponse;
  try {
    r = await send(meta, req);
  } catch (e) {
    // Never replay a mutating daemon request after the socket has been opened.
    // The broker may already have persisted/accepted the start or continuation
    // and only the response may have been lost. An automatic retry could create
    // duplicate work. Surface the uncertainty and let callers inspect the
    // durable job store before deciding what to do.
    throw new JobDaemonError(
      "daemon_request_uncertain",
      `Connection to the CrewDispatch daemon was lost after dispatch; acceptance is unknown and the request was NOT retried: ${String((e as Error)?.message || e)}`
    );
  }
  if (!r.ok) throw new JobDaemonError(r.code, r.message);
  return r;
}

function preflightStart(root: string, payload: DaemonStartPayload): void {
  const provider = typeof payload.provider === "string" && payload.provider.trim()
    ? payload.provider.trim()
    : COMMAND_CODE_PROVIDER;
  if (provider !== COMMAND_CODE_PROVIDER && provider !== WORKBUDDY_AI_PROVIDER) {
    throw new JobDaemonError(
      "invalid_provider",
      `Unsupported provider: ${provider}; CrewDispatch supports ${COMMAND_CODE_PROVIDER} and ${WORKBUDDY_AI_PROVIDER}.`
    );
  }
  const config = provider === WORKBUDDY_AI_PROVIDER
    ? loadWorkBuddyAiConfigResult(root)
    : loadConfigResult(root);
  if (!config.ok) {
    throw new JobDaemonError(
      config.error?.code ?? "config_invalid",
      config.error?.message ?? "CrewDispatch configuration is invalid."
    );
  }
}

function preflightContinuation(root: string, payload: DaemonContinuePayload): void {
  // Force schema validation before starting a broker. Future/corrupt records
  // must remain byte-identical and must not create daemon metadata as a side
  // effect of a refusal.
  try {
    loadJob(root, payload.jobId);
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === "string"
      ? String((e as { code: string }).code)
      : "job_read_failed";
    throw new JobDaemonError(code, String((e as Error)?.message || e));
  }
}

export async function startJobViaDaemon(rootInput: string, payload: DaemonStartPayload): Promise<{ job: JobRecord; workerPid: number | null }> {
  const root = resolveDataRoot(rootInput, payload.env ?? process.env);
  preflightStart(root, payload);
  const r = await call(root, payload.env ?? process.env, {
    version: DAEMON_PROTOCOL_VERSION,
    id: requestId(),
    op: "start",
    payload
  });
  if (!r.ok || r.op !== "start" || !("job" in r.result)) throw new JobDaemonError("daemon_bad_response", "CrewDispatch daemon returned the wrong response to start.");
  return r.result;
}

export async function continueJobViaDaemon(rootInput: string, payload: DaemonContinuePayload): Promise<{ job: JobRecord; workerPid: number | null }> {
  const root = resolveDataRoot(rootInput, payload.env ?? process.env);
  preflightContinuation(root, payload);
  const r = await call(root, payload.env ?? process.env, {
    version: DAEMON_PROTOCOL_VERSION,
    id: requestId(),
    op: "continue",
    payload
  });
  if (!r.ok || r.op !== "continue" || !("job" in r.result)) throw new JobDaemonError("daemon_bad_response", "CrewDispatch daemon returned the wrong response to continuation.");
  return r.result;
}

/**
 * Upper bound on the REQUEST half of one recovery call: connect + write +
 * response. The broker acknowledges a validated admission PROMPTLY (before
 * running the finite pass), so this never covers the pass itself.
 */
export const RECOVERY_REQUEST_TIMEOUT_MS = 8000;

/**
 * The END-TO-END budget of ONE recovery request: broker connect/start PLUS the
 * request round-trip.
 *
 * `ensureJobDaemon` is given the same deadline, and every awaited step inside
 * the startup machinery is capped by what actually remains: each liveness ping
 * (otherwise 1500ms), each 100ms poll sleep, and the Windows WMI/PowerShell
 * creation call (otherwise 15s). The wait therefore STOPS at the deadline
 * instead of being abandoned mid-flight or overrun by a fixed constant.
 * Whatever is left, up to `RECOVERY_REQUEST_TIMEOUT_MS`, bounds the
 * round-trip; when nothing is left the request is not sent at all and
 * `recovery_budget_exhausted` is reported.
 *
 * This is a finite I/O budget under NORMAL scheduling, not a hard wall-clock
 * guarantee: a bounded step still returns at the OS/Node scheduler's
 * convenience, so the real elapsed time is the budget plus ordinary scheduling
 * overhead (a stalled broker is polled, a cold start may occupy most of it).
 * What it excludes is the alternative — an unbounded or fixed-constant wait
 * that overruns the budget by multiples of it.
 */
export const RECOVERY_REQUEST_BUDGET_MS = 15_000;

export interface RecoveryRequestResult {
  ok: boolean;
  /** Stable code: `accepted`, or the honest reason recovery did not run. */
  code: string;
  message: string | null;
}

/**
 * Ask the EXISTING authenticated broker for ONE bounded notification-recovery
 * pass on behalf of a verified local caller registration. Only the two OPAQUE
 * references travel — never a native inbox address, a token or job metadata.
 *
 * It never throws and NEVER restarts or kills a broker: an older broker that
 * does not know the additive `recover` operation answers `unknown_operation`,
 * which is reported honestly as `unsupported_operation`.
 *
 * The WHOLE call — broker connect/start plus request round-trip — is bounded by
 * `RECOVERY_REQUEST_BUDGET_MS`, so a host session can never be held longer than
 * that. It is not instantaneous: with a stopped broker the budget is mostly
 * spent starting it, which is why the budget exists rather than a promise of
 * "never waits".
 */
export async function requestClaudeSessionRecovery(
  rootInput: string,
  ref: { sessionId: string; bindingId: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<RecoveryRequestResult> {
  if (!isValidClaudeSessionId(ref.sessionId) || !isValidClaudeBindingId(ref.bindingId)) {
    return {
      ok: false,
      code: "invalid_reference",
      message: "A recovery request requires the opaque session id and binding id of a local caller registration."
    };
  }
  const deadline = Date.now() + RECOVERY_REQUEST_BUDGET_MS;
  try {
    // The SAME deadline bounds the startup machinery, so the wait stops at it
    // instead of continuing past the claimed budget.
    const meta = await ensureJobDaemon(rootInput, env, { deadlineMs: deadline });
    const sendMs = Math.min(RECOVERY_REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (sendMs <= 0) {
      return {
        ok: false,
        code: "recovery_budget_exhausted",
        message: `The bounded recovery budget (${RECOVERY_REQUEST_BUDGET_MS}ms) was spent starting the CrewDispatch daemon; no recovery request was sent.`
      };
    }
    const r = await send(
      meta,
      {
        version: DAEMON_PROTOCOL_VERSION,
        id: requestId(),
        op: "recover",
        payload: { sessionId: ref.sessionId, bindingId: ref.bindingId }
      },
      sendMs
    );
    if (!r.ok) {
      if (r.code === "unknown_operation") {
        return {
          ok: false,
          code: "unsupported_operation",
          message: "The running CrewDispatch daemon predates the recovery operation; no recovery pass was started and the daemon was left untouched."
        };
      }
      return { ok: false, code: r.code, message: r.message };
    }
    return { ok: true, code: "accepted", message: null };
  } catch (e) {
    const code = e instanceof JobDaemonError ? e.code : "recovery_request_failed";
    return { ok: false, code, message: String((e as Error)?.message || e) };
  }
}

export async function shutdownJobDaemon(rootInput: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const root = resolveDataRoot(rootInput, env);
  const paths = daemonPaths(root, env);
  const meta = safeReadMeta(paths);
  if (!meta || !(await ping(meta))) {
    unlinkIfStale(paths, meta);
    return;
  }
  try {
    await send(meta, { version: 1, id: requestId(), op: "shutdown", payload: null }, 3000);
  } catch {
    // Best effort; explicit tests can still kill the pid if needed.
  }
}
