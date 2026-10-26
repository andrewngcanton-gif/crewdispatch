// store.ts — durable, atomic, defensive persistence under CrewDispatch's OWN data
// root.
//
// Rules:
//   - the data root is CrewDispatch's own directory. Explicit/env overrides win;
//     fresh macOS profiles default to ~/Library/Application Support/JobQuay while
//     a legacy-only ~/JobQuay profile continues in place. Ambiguity fails closed;//   - every write goes through a temp file + fsync + rename, so a crash can
//     never leave a half-written job record that a reader would parse;
//   - every path is asserted to be INSIDE the root (a defensive check against a
//     traversal in an id or a caller-supplied path);
//   - the job record has ONE writer at a time (the owner/worker). Cancel intent
//     travels through a SEPARATE small file so a cancel client never races the
//     owner's record write.
//
// The single-writer design is deliberate: the worker owns `<root>/jobs/<id>.json`
// while it runs; a cancel client only writes `<root>/cancel/<id>.intent` and, if
// the owner is dead, may finalise the record itself. What was PROVEN about a
// tree's exit is recorded separately in `<root>/tree/<id>.json` (bound to
// generation + PID, with an explicit `scope`), so a client and the worker can
// share the evidence without racing the record and without ever treating the
// intent file itself as confirmation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { KillTreeScope } from "../runtime/process";
import { isValidClaudeBindingId, isValidClaudeSessionId } from "../claude/ids";
import { approvalDir, approvalFileToken, normalizePendingApproval, safeApprovalOutcome } from "./approval";
import {
  JOB_SCHEMA_VERSION,
  SLOT_SWITCH_LOG_MAX,
  emptyNotifyTarget,
  emptyUsage,
  type ApprovalNotificationRecord,
  type CancelCleanupEvidence,
  type CancelIntent,
  type DeliveryPhase,
  type JobRecord,
  type JobStatus,
  type AcceptedModelIntent,
  type ModelChainPlanEntry,
  type ModelSource,
  type NotificationRecord,
  type NotifyTarget,
  type PromptKind,
  type RecoveryNotificationRecord,
  type RunnerKind,
  type SlotSwitchAudit,
  type SlotSwitchEvent,
  type SlotSwitchSkip,
  type TerminalReadReceipt
} from "./types";

export class JobStoreError extends Error {
  readonly code: string;
  readonly systemCode: string | null;
  constructor(code: string, message: string, systemCode: string | null = null) {
    super(message);
    this.name = "JobStoreError";
    this.code = code;
    this.systemCode = systemCode;
  }
}

export function isTransientJobStoreWriteError(error: unknown): error is JobStoreError {
  if (!(error instanceof JobStoreError) || error.code !== "write_failed") return false;
  return error.systemCode === "EBUSY" ||
    (process.platform === "win32" && (error.systemCode === "EPERM" || error.systemCode === "EACCES"));
}

export type DataRootResolutionSource =
  | "explicit"
  | "crewdispatch_env"
  | "jobquay_env"
  | "macos_application_support"
  | "macos_legacy"
  | "platform_default"
  | "ambiguous";

export interface DataRootResolutionOptions {
  platform?: NodeJS.Platform;
  /** Test/embedded-host seam; defaults to HOME on Darwin, then os.homedir(). */
  homedir?: string | null;
  /** Read-only existence probe; defaults to fs.existsSync. */
  existsFn?: (candidate: string) => boolean;
}

export interface DataRootResolution {
  ok: boolean;
  path: string | null;
  source: DataRootResolutionSource;
  platform: NodeJS.Platform;
  preferredPath: string;
  legacyPath: string | null;
  preferredExists: boolean | null;
  legacyExists: boolean | null;
  error: string | null;
}

function dataRootHome(env: NodeJS.ProcessEnv, options: DataRootResolutionOptions): string {
  const configured = typeof options.homedir === "string" ? options.homedir.trim() : "";
  const envHome = typeof env.HOME === "string" ? env.HOME.trim() : "";
  return path.resolve(configured || envHome || os.homedir());
}

/** CrewDispatch's fresh platform default. Compatibility selection happens in inspectDataRootResolution(). */
export function defaultDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  options: DataRootResolutionOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return path.join(dataRootHome(env, options), "Library", "Application Support", "JobQuay");
  }
  const base = env.LOCALAPPDATA || env.APPDATA || os.homedir();
  // Stable across the rename on Windows/other legacy platforms.
  return path.join(base, "JobQuay");
}

/**
 * Read-only data-root decision.
 *
 * Precedence remains explicit path > CREWDISPATCH_DATA_ROOT >
 * JOBQUAY_DATA_ROOT > platform compatibility/default. On Darwin, only the
 * no-override branch inspects the fresh and legacy roots; it never creates,
 * moves or merges either directory.
 */
export function inspectDataRootResolution(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  options: DataRootResolutionOptions = {}
): DataRootResolution {
  const platform = options.platform ?? process.platform;
  const explicitValue = typeof explicit === "string" ? explicit.trim() : "";
  const crewdispatchValue = typeof env.CREWDISPATCH_DATA_ROOT === "string" ? env.CREWDISPATCH_DATA_ROOT.trim() : "";
  const jobquayValue = typeof env.JOBQUAY_DATA_ROOT === "string" ? env.JOBQUAY_DATA_ROOT.trim() : "";

  const override = explicitValue || crewdispatchValue || jobquayValue;
  const overrideSource: DataRootResolutionSource = explicitValue
    ? "explicit"
    : crewdispatchValue
      ? "crewdispatch_env"
      : jobquayValue
        ? "jobquay_env"
        : "platform_default";

  const preferredPath = path.resolve(defaultDataRoot(env, options));
  const legacyPath =
    platform === "darwin"
      ? path.resolve(path.join(dataRootHome(env, options), "JobQuay"))
      : null;

  if (override) {
    return {
      ok: true,
      path: path.resolve(override),
      source: overrideSource,
      platform,
      preferredPath,
      legacyPath,
      preferredExists: null,
      legacyExists: null,
      error: null
    };
  }

  if (platform !== "darwin") {
    return {
      ok: true,
      path: preferredPath,
      source: "platform_default",
      platform,
      preferredPath,
      legacyPath: null,
      preferredExists: null,
      legacyExists: null,
      error: null
    };
  }

  const exists = options.existsFn ?? fs.existsSync;
  const preferredExists = exists(preferredPath);
  const legacyExists = legacyPath != null && exists(legacyPath);
  if (preferredExists && legacyExists) {
    return {
      ok: false,
      path: null,
      source: "ambiguous",
      platform,
      preferredPath,
      legacyPath,
      preferredExists,
      legacyExists,
      error:
        `Both macOS data roots exist: "${preferredPath}" and "${legacyPath}". ` +
        "Refusing to guess, merge, or move data; set CREWDISPATCH_DATA_ROOT or JOBQUAY_DATA_ROOT explicitly."
    };
  }

  if (legacyExists && legacyPath) {
    return {
      ok: true,
      path: legacyPath,
      source: "macos_legacy",
      platform,
      preferredPath,
      legacyPath,
      preferredExists,
      legacyExists,
      error: null
    };
  }

  return {
    ok: true,
    path: preferredPath,
    source: "macos_application_support",
    platform,
    preferredPath,
    legacyPath,
    preferredExists,
    legacyExists,
    error: null
  };
}

/** Resolve a usable root or fail closed on an ambiguous macOS profile. */
export function resolveDataRoot(
  explicit?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  options: DataRootResolutionOptions = {}
): string {
  const resolution = inspectDataRootResolution(explicit, env, options);
  if (!resolution.ok || !resolution.path) {
    throw new JobStoreError("data_root_ambiguous", resolution.error ?? "Could not resolve CrewDispatch data root.");
  }
  return resolution.path;
}
export function jobsDir(root: string): string {
  return path.join(root, "jobs");
}
export function logsDir(root: string): string {
  return path.join(root, "logs");
}
export function cancelDir(root: string): string {
  return path.join(root, "cancel");
}
/** Directory of confirmed tree-exit records (kept apart from the intent files). */
export function treeDir(root: string): string {
  return path.join(root, "tree");
}
/** Directory of at-most-once terminal-wake claim files. */
export function notifyDir(root: string): string {
  return path.join(root, "notify");
}
/**
 * Directory of immutable, generation-scoped TERMINAL SNAPSHOTS.
 *
 * A snapshot records exactly what became terminal — `{id, generation, status,
 * notifyTarget}` — at the moment the terminal state was written. It is kept OUT
 * of the job record so that a later continuation (a new generation) can never
 * make the terminal generation undiscoverable, and so an asynchronous wake
 * delivery never has to re-read (and risk clobbering) the live record.
 */
export function terminalDir(root: string): string {
  return path.join(root, "terminal");
}

export function jobPath(root: string, id: string): string {
  return path.join(jobsDir(root), `${safeId(id)}.json`);
}
export function logPath(root: string, id: string): string {
  return path.join(logsDir(root), `${safeId(id)}.ndjson`);
}
export function workerLogPath(root: string, id: string): string {
  return path.join(logsDir(root), `${safeId(id)}.worker.log`);
}
export function cancelPath(root: string, id: string): string {
  return path.join(cancelDir(root), `${safeId(id)}.intent`);
}
export function treeConfirmPath(root: string, id: string): string {
  return path.join(treeDir(root), `${safeId(id)}.json`);
}
/** A generation-scoped claim file that makes a terminal wake at-most-once. */
export function notificationClaimPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(notifyDir(root), `${safeId(id)}.gen-${gen}.claim`);
}

/** A generation-scoped terminal-wake RESULT file (kept out of the job record). */
export function notificationResultPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(notifyDir(root), `${safeId(id)}.gen-${gen}.result.json`);
}

/**
 * Directory of bounded RECOVERY claim/result sidecars. It lives UNDER
 * `notify/` but in its own subdirectory, so a recovery claim can never be
 * confused with (or consume) an original attempt's claim/result file, and the
 * existing terminal/approval result scanners never pick up a recovery record.
 */
export function recoveryNotifyDir(root: string): string {
  return path.join(notifyDir(root), "recovery");
}

/**
 * Directory of per-generation terminal RESULT-READ receipts (sidecar files,
 * never a job-record field, so no job schema bump is needed).
 */
export function terminalReceiptDir(root: string): string {
  return path.join(notifyDir(root), "receipts");
}

/** A generation-scoped recovery claim file for ONE terminal event. */
export function terminalRecoveryClaimPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(recoveryNotifyDir(root), `${safeId(id)}.gen-${gen}.terminal.recovery.claim`);
}

/** A generation-scoped recovery RESULT file for ONE terminal event. */
export function terminalRecoveryResultPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(recoveryNotifyDir(root), `${safeId(id)}.gen-${gen}.terminal.recovery.json`);
}

/** A per-generation terminal result-read receipt path. */
export function terminalReadReceiptPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(terminalReceiptDir(root), `${safeId(id)}.gen-${gen}.read.json`);
}

/** A generation-scoped immutable terminal snapshot. */
export function terminalSnapshotPath(root: string, id: string, generation: number): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return path.join(terminalDir(root), `${safeId(id)}.gen-${gen}.json`);
}

/** Reject anything that is not a plain file id (no separators, no traversal). */
export function safeId(id: unknown): string {
  const s = typeof id === "string" ? id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s) || s.includes("..")) {
    throw new JobStoreError("bad_id", `invalid job id: ${JSON.stringify(String(id))}`);
  }
  return s;
}

/** Defensive: a computed path must stay inside the root. */
export function assertInside(root: string, p: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new JobStoreError("outside_root", `path escapes the CrewDispatch data root: ${p}`);
  }
}

/** Create the product's own directory skeleton. */
export function ensureRoot(root: string): void {
  for (const dir of [
    root,
    jobsDir(root),
    logsDir(root),
    cancelDir(root),
    notifyDir(root),
    approvalNotifyDir(root),
    recoveryNotifyDir(root),
    terminalReceiptDir(root),
    terminalDir(root),
    approvalDir(root)
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Atomic write: temp file in the same directory, fsync, rename over target. */
export function atomicWriteFile(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best-effort on some filesystems */
    }
  } finally {
    fs.closeSync(fd);
  }
  // Windows security scanners and short-lived readers can temporarily deny
  // replacement of the existing job record. The former 8 x 15ms window was too
  // short for real file contention and could crash a live worker on transient EPERM.
  const retryDelaysMs = [15, 30, 45, 60, 80, 100, 150, 200, 300, 400, 500] as const;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      const transient = code === "EBUSY" ||
        (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));
      if (!transient || attempt >= retryDelaysMs.length) break;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelaysMs[attempt]!);
      } catch {
        /* Atomics.wait may be unavailable; the next attempt is immediate */
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* best effort */
  }
  throw new JobStoreError(
    "write_failed",
    "atomic write failed for " + file + ": " + String((lastError as Error)?.message || lastError),
    (lastError as NodeJS.ErrnoException | null)?.code ?? null
  );
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

/** Persist a job record under the root (atomic). Stamps `updatedAt`. */
export function saveJob(root: string, job: JobRecord, now?: () => Date): JobRecord {
  const file = jobPath(root, job.id);
  assertInside(root, file);
  const next: JobRecord = { ...job, updatedAt: nowIso(now) };
  atomicWriteFile(file, JSON.stringify(next, null, 2));
  return next;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function normalizeWorkspaceIdentity(v: unknown): string | null {
  const value = asStringOrNull(v);
  if (!value || value.length > 128) return null;
  return /^darwin-fs:\d+:\d+$/.test(value) ? value : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown): boolean {
  return v === true;
}

function normalizeModelSource(v: unknown): ModelSource | null {
  return v === "explicit" ||
    v === "slot" ||
    v === "config-default" ||
    v === "cli-default" ||
    v === "rate-limit-fallback" ||
    v === "none"
    ? (v as ModelSource)
    : null;
}

/** Only the three known prompt kinds are accepted; an old/unknown value reads as "task". */
function normalizePromptKind(v: unknown): PromptKind {
  return v === "recovery" ? "recovery" : v === "switch" ? "switch" : "task";
}

function capString(v: unknown, cap: number): string | null {
  const s = asStringOrNull(v);
  return s ? s.slice(0, cap) : null;
}

function normalizeSwitchEvent(v: unknown): SlotSwitchEvent | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  return {
    generation: asNumberOrNull(x.generation) ?? 0,
    from: capString(x.from, 200),
    to: capString(x.to, 200),
    at: asStringOrNull(x.at) ?? "",
    ok: asBool(x.ok),
    reason: capString(x.reason, 64),
    pid: asNumberOrNull(x.pid),
    scope: capString(x.scope, 64)
  };
}

function normalizeSwitchSkip(v: unknown): SlotSwitchSkip | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  return {
    generation: asNumberOrNull(x.generation),
    at: asStringOrNull(x.at) ?? "",
    reason: capString(x.reason, 64) ?? "disabled",
    model: capString(x.model, 200),
    wouldSwitchTo: capString(x.wouldSwitchTo, 200)
  };
}

function normalizeSwitchList<T>(v: unknown, one: (e: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const e of v) {
    const n = one(e);
    if (n) out.push(n);
  }
  return out.slice(-SLOT_SWITCH_LOG_MAX);
}

/**
 * A v2/v3/v4 record has NO switch audit: it reads as null (this build never
 * invents a switch for a job that ran before the feature existed).
 */
function normalizeSlotSwitch(v: unknown): SlotSwitchAudit | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  return {
    enabled: asBool(x.enabled),
    armed: asBool(x.armed),
    switchEnabled: typeof x.switchEnabled === "boolean" ? x.switchEnabled : null,
    currentGeneration: asNumberOrNull(x.currentGeneration),
    currentModel: capString(x.currentModel, 200),
    nextBoundaryAt: capString(x.nextBoundaryAt, 64),
    nextModel: capString(x.nextModel, 200),
    switches: normalizeSwitchList(x.switches, normalizeSwitchEvent),
    skips: normalizeSwitchList(x.skips, normalizeSwitchSkip),
    lastSwitch: normalizeSwitchEvent(x.lastSwitch),
    lastSkip: normalizeSwitchSkip(x.lastSkip)
  };
}

/** A bounded list of model ids (never a task/credential); anything else is dropped. */
function normalizeModelChain(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    const s = asStringOrNull(e);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * The accepted `{model, source, effort}` plan (v10). A record written before
 * the plan existed reads as [] — the worker then re-resolves once from the
 * current config, never guessing a pair. Each entry is bounded: a valid model
 * id, a KNOWN source and a short effort token; malformed entries are dropped.
 */
function normalizeModelChainPlan(v: unknown): ModelChainPlanEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ModelChainPlanEntry[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const x = e as Record<string, unknown>;
    const model = capString(x.model, 200);
    const source = normalizeModelSource(x.source);
    if (!model || !source || seen.has(model)) continue;
    seen.add(model);
    out.push({ model, source, effort: capString(x.effort, 32) });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * The minimal accepted model/effort INTENT (v11). A record written before the
 * intent existed reads as null — the worker then resolves the chain from the
 * current config exactly as before, never guessing a pair. The primary model
 * may legitimately be null (the settings contributed none, so the CLI's own
 * catalog default applies); a missing/unknown primary source makes the whole
 * intent unreadable (null) rather than silently fabricating a route.
 */
function normalizeAcceptedIntent(v: unknown): AcceptedModelIntent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  const primarySource = normalizeModelSource(x.primarySource);
  if (!primarySource) return null;
  return {
    primaryModel: capString(x.primaryModel, 200),
    primarySource,
    primaryEffort: capString(x.primaryEffort, 32),
    fallbacks: normalizeModelChainPlan(x.fallbacks)
  };
}

function normalizeStatus(v: unknown): JobStatus {
  const s = typeof v === "string" ? v : "";
  return (["queued", "running", "done", "error", "cancelled", "interrupted", "orphaned"] as const).includes(s as JobStatus)
    ? (s as JobStatus)
    : "queued";
}

/**
 * Read one persisted usage object in the canonical vocabulary.
 *
 * `legacyDecode` marks a record written before schema v7: its `decodeSeconds`
 * was the run's TOTAL active model-output time, which never covered "exactly
 * the responses counted by decodeTokens". The value is therefore loaded as
 * null — presenting it under the paired meaning would be a misinterpretation,
 * not a measurement (the raw record file still carries it). The paired
 * `decodeTokens` field is absent in every older record and reads as null.
 *
 * `legacyWorkbuddyDecode` marks a WorkBuddy AI record written before schema
 * v8: its decode pair came from CrewDispatch's custom synthetic-boundary
 * approximation (the bridge's first ACP chunk → a CrewDispatch-closed message_end),
 * which is NOT the official deepseek-harness `sessionStats` fold the fields
 * now mean and produced inflated rates. The durable record holds only the
 * aggregate pair — never the per-response first-token/completion instants — so
 * the value cannot be recomputed deterministically and is dropped to null: a
 * missing metric is honest, a silently reinterpreted one is not. Command Code's
 * native request-scope pairing is unchanged, so its pre-v8 values stay valid.
 */
function normalizeUsage(v: unknown, legacyDecode: boolean = false, legacyWorkbuddyDecode: boolean = false) {
  const u = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const base = emptyUsage();
  for (const key of Object.keys(base) as (keyof typeof base)[]) {
    base[key] = asNumberOrNull(u[key]);
  }
  if (legacyDecode) base.decodeSeconds = null;
  if (legacyWorkbuddyDecode) {
    base.decodeTokens = null;
    base.decodeSeconds = null;
  }
  return base;
}

function normalizeCancelIntent(v: unknown): CancelIntent {
  const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { requested: asBool(c.requested), requestedAt: asStringOrNull(c.requestedAt), by: asStringOrNull(c.by) };
}

function normalizeNotifyKind(v: unknown): NotifyTarget["kind"] {
  return v === "callback" || v === "codex_thread" || v === "claude_session" ? v : "none";
}

/**
 * Normalize a persisted wake target. A v2..v11 record has no Claude fields:
 * both read as null and every existing target is unchanged. A `claude_session`
 * target keeps ONLY the opaque session/binding references; the native address
 * and token live in the private binding store (src/claude/binding.ts) and are
 * never part of a record. A Claude target whose references are missing or
 * malformed stays `claude_session` with null fields — the transport then fails
 * closed with `no_binding` instead of silently rerouting to another session.
 */
function normalizeNotifyTarget(v: unknown): NotifyTarget {
  const t = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const kind = normalizeNotifyKind(t.kind);
  const source =
    t.source === "callback_url" ||
    t.source === "codex_thread_id" ||
    t.source === "env" ||
    t.source === "claude_session_id" ||
    t.source === "claude_binding_id"
      ? t.source
      : null;
  const claudeSessionId = kind === "claude_session" && isValidClaudeSessionId(t.claudeSessionId) ? (t.claudeSessionId as string) : null;
  const claudeBindingId = kind === "claude_session" && isValidClaudeBindingId(t.claudeBindingId) ? (t.claudeBindingId as string) : null;
  return {
    kind,
    callbackUrl: kind === "callback" ? asStringOrNull(t.callbackUrl) : null,
    codexThreadId: kind === "codex_thread" ? asStringOrNull(t.codexThreadId) : null,
    claudeSessionId,
    claudeBindingId,
    source
  };
}

/**
 * The recorded origin of a wake attempt. A missing, blank or non-string value
 * is UNKNOWN (null): an origin is never invented, and a pre-origin record stays
 * readable.
 */
function normalizeNotifyOrigin(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeNotifications(v: unknown): NotificationRecord[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((n) => n && typeof n === "object")
    .map((n) => {
      const x = n as Record<string, unknown>;
      return {
        generation: asNumberOrNull(x.generation) ?? 0,
        kind: normalizeNotifyKind(x.kind),
        attemptedAt: asStringOrNull(x.attemptedAt) ?? "",
        delivered: asBool(x.delivered),
        reason: asStringOrNull(x.reason),
        by: normalizeNotifyOrigin(x.by)
      };
    });
}

/**
 * Parse and normalise a persisted record. A record written by a NEWER schema is
 * refused honestly instead of being silently misread.
 */
export function normalizeJob(raw: unknown): JobRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new JobStoreError("bad_record", "job record is not an object");
  }
  const r = raw as Record<string, unknown>;
  const version = asNumberOrNull(r.schemaVersion) ?? 0;
  if (version > JOB_SCHEMA_VERSION) {
    throw new JobStoreError(
      "schema_too_new",
      `job record schemaVersion ${version} is newer than this build supports (${JOB_SCHEMA_VERSION})`
    );
  }
  const id = safeId(r.id);
  // A record written before v7 carries the LEGACY (unpaired) decode seconds
  // and no paired decode tokens; see `normalizeUsage`.
  const legacyDecode = version < 7;
  // Preserve the raw persisted provider for diagnostics. The first-release
  // runtime maps only its two supported provider ids; any other persisted value
  // is kept on the record and refused generically before execution.
  const provider = asStringOrNull(r.provider) ?? "command-code";
  // A pre-v8 WorkBuddy record's decode pair came from the custom
  // synthetic-boundary approximation, not the dsh-exact fold the fields now
  // mean, and its durable evidence cannot recompute the corrected value; the
  // pair is loaded as unavailable (see `normalizeUsage`). The gate is the
  // schema version that INTRODUCED the fold (v8), not the current version:
  // every later bump kept the same decode semantics, and gating on the current
  // version would silently drop valid v8..vN-1 measurements. Command Code's
  // provider-native pairing is unchanged, so only WorkBuddy is gated.
  const legacyWorkbuddyDecode = provider === "workbuddy-ai" && version < 8;
  const runner: RunnerKind =
    r.runner === "fixture"
      ? "fixture"
      : r.runner === "workbuddy-ai" || provider === "workbuddy-ai"
        ? "workbuddy-ai"
        : "command-code";
  const attempts = Array.isArray(r.attempts)
    ? r.attempts
        .filter((a) => a && typeof a === "object")
        .map((a) => {
          const x = a as Record<string, unknown>;
          return {
            generation: asNumberOrNull(x.generation) ?? 0,
            startedAt: asStringOrNull(x.startedAt),
            endedAt: asStringOrNull(x.endedAt),
            exitCode: asNumberOrNull(x.exitCode),
            kind: asStringOrNull(x.kind),
            failureKind: asStringOrNull(x.failureKind),
            segment: asBool(x.segment),
            resumedFrom: asStringOrNull(x.resumedFrom),
            // A v2/v3 attempt has none of these: the model stays null (never
            // guessed), the source null, rateLimited false and usage empty.
            model: asStringOrNull(x.model),
            modelSource: normalizeModelSource(x.modelSource),
            // A pre-v10 attempt recorded no effort: it reads as null (never
            // back-filled from the job's current effort).
            effort: capString(x.effort, 32),
            rateLimited: asBool(x.rateLimited),
            // A pre-batch-6 attempt never switched: false, never guessed.
            switched: asBool(x.switched),
            switchToModel: asStringOrNull(x.switchToModel),
            usage: normalizeUsage(x.usage, legacyDecode, legacyWorkbuddyDecode)
          };
        })
    : [];
  return {
    schemaVersion: version || JOB_SCHEMA_VERSION,
    id,
    provider,
    runner,
    status: normalizeStatus(r.status),
    createdAt: asStringOrNull(r.createdAt) ?? new Date(0).toISOString(),
    updatedAt: asStringOrNull(r.updatedAt) ?? new Date(0).toISOString(),
    startedAt: asStringOrNull(r.startedAt),
    finishedAt: asStringOrNull(r.finishedAt),
    generation: asNumberOrNull(r.generation) ?? 0,
    cwd: asStringOrNull(r.cwd) ?? process.cwd(),
    workspaceIdentity: normalizeWorkspaceIdentity(r.workspaceIdentity),
    task: typeof r.task === "string" ? r.task : "",
    model: asStringOrNull(r.model),
    // A v2 record has neither field: it reads as null (the batch-3 build kept no
    // model source, so an old job's origin is honestly unknown rather than guessed).
    modelSource: normalizeModelSource(r.modelSource),
    explicitModel: asStringOrNull(r.explicitModel),
    // A v2/v3 record has no chain and no prompt kind: an empty chain and the
    // "task" prompt are the honest defaults (never a guessed candidate).
    modelChain: normalizeModelChain(r.modelChain),
    // A pre-v10 record has no accepted plan: [] (never a guessed pair).
    modelChainPlan: normalizeModelChainPlan(r.modelChainPlan),
    // A pre-v11 record has no frozen intent: null (the worker resolves from the
    // current config exactly as before — never a guessed pair).
    acceptedIntent: normalizeAcceptedIntent(r.acceptedIntent),
    promptKind: normalizePromptKind(r.promptKind),
    slotSwitch: normalizeSlotSwitch(r.slotSwitch),
    permissionMode: asStringOrNull(r.permissionMode) ?? "plan",
    effort: asStringOrNull(r.effort),
    sessionId: asStringOrNull(r.sessionId),
    logPath: asStringOrNull(r.logPath) ?? path.join("logs", `${id}.ndjson`),
    owner: asStringOrNull(r.owner) ?? "",
    ownerPid: asNumberOrNull(r.ownerPid),
    ownerStartedAtUs: asNumberOrNull(r.ownerStartedAtUs),
    heartbeatAt: asStringOrNull(r.heartbeatAt),
    childPid: asNumberOrNull(r.childPid),
    childStartedAtUs: asNumberOrNull(r.childStartedAtUs),
    childGeneration: asNumberOrNull(r.childGeneration),
    usage: normalizeUsage(r.usage, legacyDecode, legacyWorkbuddyDecode),
    result: (r.result && typeof r.result === "object" ? (r.result as JobRecord["result"]) : null) as JobRecord["result"],
    stopReason: asStringOrNull(r.stopReason),
    // A record written before JQ-20261001-23 has no finish reason: it reads as
    // null (never back-filled from the stop reason or any other evidence).
    finishReason: asStringOrNull(r.finishReason),
    // A record written before JQ-20261001-24 has no error detail: it reads as
    // null (never back-filled from the error message or any other evidence).
    errorDetail: asStringOrNull(r.errorDetail),
    // A record written before the approval outcome existed has none: it reads
    // as null (never back-filled from finishReason or any other evidence). An
    // unknown token is dropped the same way — a fabricated cause is never
    // presented.
    approvalOutcome: safeApprovalOutcome(r.approvalOutcome),
    error: asStringOrNull(r.error),
    failureKind: asStringOrNull(r.failureKind),
    cancelIntent: normalizeCancelIntent(r.cancelIntent),
    // A pre-v9 record has no pending approval: it reads as null (never a
    // fabricated pending state). A malformed object is dropped the same way.
    pendingApproval: normalizePendingApproval(r.pendingApproval),
    attempts,
    notifyTarget: normalizeNotifyTarget(r.notifyTarget),
    notifications: normalizeNotifications(r.notifications),
    // A record written before JQ-20261006-58 has no provider-owned cleanup
    // evidence: it reads as null (never inferred from the status or the stop
    // reason). A malformed object is dropped the same way.
    cancelCleanup: normalizeCancelCleanup(r.cancelCleanup)
  };
}

const CANCEL_CLEANUP_STATES: ReadonlySet<string> = new Set([
  "owned_tool_stopped",
  "no_owned_work",
  "no_route",
  "not_owned",
  "unresolved"
]);

/**
 * Normalize the bounded provider-owned cleanup evidence.
 *
 * Only a known state survives and the PID list is bounded: this evidence is
 * diagnostic, so a hostile or broken value must never widen the durable record.
 */
export function normalizeCancelCleanup(raw: unknown): CancelCleanupEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const state = typeof r.state === "string" ? r.state : "";
  if (!CANCEL_CLEANUP_STATES.has(state)) return null;
  const pids = Array.isArray(r.survivingPids)
    ? r.survivingPids.filter((pid): pid is number => Number.isInteger(pid) && (pid as number) > 0).slice(0, 32)
    : [];
  // A pre-field record, or a malformed value, normalizes to -1: it can never
  // match a real generation, so it is treated as UNRESOLVED (never accepted as
  // the current generation's cleanup proof).
  const generation = typeof r.generation === "number" && Number.isInteger(r.generation) && r.generation >= 0 ? r.generation : -1;
  return {
    state: state as CancelCleanupEvidence["state"],
    provider: asStringOrNull(r.provider) ?? "",
    generation,
    route: asStringOrNull(r.route),
    sessionId: asStringOrNull(r.sessionId),
    survivingPids: pids,
    detail: asStringOrNull(r.detail),
    at: asStringOrNull(r.at) ?? new Date(0).toISOString(),
    by: asStringOrNull(r.by)
  };
}

export function loadJob(root: string, id: string): JobRecord | null {
  const file = jobPath(root, id);
  assertInside(root, file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  return normalizeJob(JSON.parse(text));
}

export interface ListJobsResult {
  jobs: JobRecord[];
  /** Records that could not be read (name only), so a caller can report them. */
  unreadable: string[];
}

export function listJobs(root: string): ListJobsResult {
  const dir = jobsDir(root);
  const jobs: JobRecord[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { jobs, unreadable };
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const id = name.slice(0, -".json".length);
    try {
      const job = loadJob(root, id);
      if (job) jobs.push(job);
    } catch {
      unreadable.push(name);
    }
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { jobs, unreadable };
}

/** Append one raw line to the job's transcript/log file. */
export function appendLog(root: string, id: string, line: string): void {
  const file = logPath(root, id);
  assertInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

export function readLog(root: string, id: string, maxBytes = 512 * 1024): string {
  const file = logPath(root, id);
  assertInside(root, file);
  try {
    const buf = fs.readFileSync(file);
    return buf.length <= maxBytes ? buf.toString("utf8") : buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

/** Write the out-of-band cancel-intent file (never the job record). */
export function writeCancelIntent(root: string, id: string, by: string, now?: () => Date): void {
  const file = cancelPath(root, id);
  assertInside(root, file);
  atomicWriteFile(file, JSON.stringify({ id: safeId(id), by, at: nowIso(now) }));
}

export function readCancelIntent(root: string, id: string): { by: string; at: string } | null {
  const file = cancelPath(root, id);
  assertInside(root, file);
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return { by: asStringOrNull(obj.by) ?? "", at: asStringOrNull(obj.at) ?? "" };
  } catch {
    return null;
  }
}

export function clearCancelIntent(root: string, id: string): void {
  const file = cancelPath(root, id);
  assertInside(root, file);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Claim the ONE terminal-wake attempt for a generation. Uses an exclusive create
 * (`wx`) so two processes racing to wake the same terminal generation can never
 * both deliver: exactly one sees `true`. The claim file is a marker only; the
 * delivery OUTCOME is recorded on the job record.
 */
export function claimNotificationAttempt(root: string, id: string, generation: number): boolean {
  const file = notificationClaimPath(root, id, generation);
  assertInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Immutable terminal snapshots (generation-scoped, outside the job record)
// ---------------------------------------------------------------------------

/**
 * What became terminal, captured at the moment the terminal state was written.
 *
 * A snapshot is written ONCE per terminal generation (exclusive create: an
 * existing snapshot is never overwritten) and lives OUTSIDE the job record, so
 * a later continuation that bumps the generation cannot hide it and an
 * asynchronous wake delivery never needs to re-read the live record.
 */
export interface TerminalSnapshot {
  id: string;
  generation: number;
  status: JobStatus;
  notifyTarget: NotifyTarget;
  at: string;
  by: string;
}

/**
 * Persist the immutable terminal snapshot for `generation`. Uses an exclusive
 * create: if a snapshot for this generation already exists it is left untouched
 * (a terminal state is written once; the first snapshot is authoritative).
 * Returns true when this call created the file.
 */
export function writeTerminalSnapshot(
  root: string,
  id: string,
  generation: number,
  status: JobStatus,
  notifyTarget: NotifyTarget,
  by: string,
  now?: () => Date
): boolean {
  const file = terminalSnapshotPath(root, id, generation);
  assertInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec: TerminalSnapshot = {
    id: safeId(id),
    generation,
    status,
    notifyTarget: normalizeNotifyTarget(notifyTarget),
    by: typeof by === "string" && by.trim() ? by.trim() : "unknown",
    at: nowIso(now)
  };
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(rec), "utf8");
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best effort */
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

function normalizeTerminalSnapshot(v: unknown): TerminalSnapshot | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const generation = asNumberOrNull(o.generation);
  if (generation == null) return null;
  const status = normalizeStatus(o.status);
  return {
    id: asStringOrNull(o.id) ?? "",
    generation,
    status,
    notifyTarget: normalizeNotifyTarget(o.notifyTarget),
    at: asStringOrNull(o.at) ?? "",
    by: asStringOrNull(o.by) ?? ""
  };
}

export function readTerminalSnapshot(root: string, id: string, generation: number): TerminalSnapshot | null {
  const file = terminalSnapshotPath(root, id, generation);
  assertInside(root, file);
  try {
    return normalizeTerminalSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** All terminal snapshots for a job, ordered by generation ascending. */
export function readTerminalSnapshots(root: string, id: string): TerminalSnapshot[] {
  const dir = terminalDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const prefix = `${safeId(id)}.gen-`;
  const out: TerminalSnapshot[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const gen = Number(name.slice(prefix.length, -".json".length));
    if (!Number.isInteger(gen) || gen < 0) continue;
    const rec = readTerminalSnapshot(root, id, gen);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.generation - b.generation);
  return out;
}

// ---------------------------------------------------------------------------
// Generation-scoped notification RESULT files (never the job record)
// ---------------------------------------------------------------------------

/**
 * Only the three known transport phases are accepted; anything else (an old
 * record without the field, a corrupt value or a newer token) reads as null —
 * UNKNOWN, never inferred and never eligible for recovery.
 */
export function normalizeDeliveryPhase(v: unknown): DeliveryPhase | null {
  return v === "not_written" || v === "writing_started" || v === "handoff" ? v : null;
}

/**
 * Persist the delivery RESULT for one terminal generation in its OWN file.
 *
 * The wake result is deliberately NOT written back into the job record: a
 * detached worker that awaits a slow HTTP POST / queue child must never rewrite
 * a record that a continuation may have already advanced to a newer generation.
 * Readers merge these files into the view (see `withMergedNotifications`).
 */
export function writeNotificationResult(
  root: string,
  id: string,
  generation: number,
  record: NotificationRecord,
  now?: () => Date
): void {
  const file = notificationResultPath(root, id, generation);
  assertInside(root, file);
  const payload: NotificationRecord = {
    generation,
    kind: record.kind,
    attemptedAt: record.attemptedAt || nowIso(now),
    delivered: record.delivered === true,
    reason: record.reason,
    by: normalizeNotifyOrigin(record.by),
    phase: normalizeDeliveryPhase(record.phase)
  };
  atomicWriteFile(file, JSON.stringify(payload));
}

function normalizeNotificationRecord(v: unknown): NotificationRecord | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const generation = asNumberOrNull(x.generation);
  if (generation == null) return null;
  return {
    generation,
    kind: normalizeNotifyKind(x.kind),
    attemptedAt: asStringOrNull(x.attemptedAt) ?? "",
    delivered: asBool(x.delivered),
    reason: asStringOrNull(x.reason),
    by: normalizeNotifyOrigin(x.by),
    phase: normalizeDeliveryPhase(x.phase)
  };
}

export function readNotificationResult(root: string, id: string, generation: number): NotificationRecord | null {
  const file = notificationResultPath(root, id, generation);
  assertInside(root, file);
  try {
    return normalizeNotificationRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** All persisted wake results for a job, ordered by generation ascending. */
export function readNotificationResults(root: string, id: string): NotificationRecord[] {
  const dir = notifyDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const prefix = `${safeId(id)}.gen-`;
  const out: NotificationRecord[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".result.json")) continue;
    const gen = Number(name.slice(prefix.length, -".result.json".length));
    if (!Number.isInteger(gen) || gen < 0) continue;
    const rec = readNotificationResult(root, id, gen);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.generation - b.generation);
  return out;
}

/**
 * Directory of at-most-once APPROVAL-wake claim/result files. It lives UNDER
 * `notify/` but in its own subdirectory, so a terminal generation claim and an
 * approval `(generation, request)` identity can never consume each other's
 * records, and the terminal result scanner never picks up an approval record
 * (or vice versa).
 */
export function approvalNotifyDir(root: string): string {
  return path.join(notifyDir(root), "approval");
}

/**
 * The request token is the SAME safe encoding the approval file protocol uses
 * (`approvalFileToken`): a safe provider request id is used as-is, anything
 * else becomes a stable hash prefix, so it can never contain a separator or
 * escape the directory.
 */
function approvalNotificationFile(root: string, id: string, generation: number, requestId: string, suffix: string): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  const file = path.join(approvalNotifyDir(root), `${safeId(id)}.gen-${gen}.${approvalFileToken(requestId)}.${suffix}`);
  assertInside(root, file);
  return file;
}

/** A generation+request-scoped claim file that makes ONE approval wake at-most-once. */
export function approvalNotificationClaimPath(root: string, id: string, generation: number, requestId: string): string {
  return approvalNotificationFile(root, id, generation, requestId, "approval.claim");
}

/** A generation+request-scoped approval-wake RESULT file (never the job record). */
export function approvalNotificationResultPath(root: string, id: string, generation: number, requestId: string): string {
  return approvalNotificationFile(root, id, generation, requestId, "approval.result.json");
}

/**
 * Claim the ONE approval-wake attempt for this `(job, generation, request)`
 * identity, using an exclusive create (`wx`) so repeat stream events, two
 * processes or a restart can never wake it twice. The claim file is a marker
 * only; the OUTCOME is recorded in its own result file.
 */
export function claimApprovalNotificationAttempt(root: string, id: string, generation: number, requestId: string): boolean {
  const file = approvalNotificationClaimPath(root, id, generation, requestId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Persist the delivery RESULT for one approval wake in its OWN file. Like the
 * terminal result it is deliberately NOT written into the job record: the
 * running worker may be concurrently rewriting that record (usage/heartbeat),
 * and a delivery outcome must never be able to clobber it.
 */
export function writeApprovalNotificationResult(
  root: string,
  id: string,
  generation: number,
  record: ApprovalNotificationRecord,
  now?: () => Date
): void {
  const file = approvalNotificationResultPath(root, id, generation, record.requestId);
  const payload: ApprovalNotificationRecord = {
    generation,
    requestId: record.requestId,
    kind: record.kind,
    attemptedAt: record.attemptedAt || nowIso(now),
    delivered: record.delivered === true,
    reason: record.reason,
    by: normalizeNotifyOrigin(record.by),
    phase: normalizeDeliveryPhase(record.phase)
  };
  atomicWriteFile(file, JSON.stringify(payload));
}

function normalizeApprovalNotificationRecord(v: unknown): ApprovalNotificationRecord | null {
  if (!v || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  const generation = asNumberOrNull(x.generation);
  const requestId = asStringOrNull(x.requestId);
  if (generation == null || generation < 0 || !requestId) return null;
  return {
    generation,
    requestId: requestId.length <= 128 ? requestId : requestId.slice(0, 128),
    kind: normalizeNotifyKind(x.kind),
    attemptedAt: asStringOrNull(x.attemptedAt) ?? "",
    delivered: asBool(x.delivered),
    reason: asStringOrNull(x.reason),
    by: normalizeNotifyOrigin(x.by),
    phase: normalizeDeliveryPhase(x.phase)
  };
}

/** Read the delivery RESULT for the exact approval identity, or null. */
export function readApprovalNotificationResult(root: string, id: string, generation: number, requestId: string): ApprovalNotificationRecord | null {
  const file = approvalNotificationResultPath(root, id, generation, requestId);
  let rec: ApprovalNotificationRecord | null;
  try {
    rec = normalizeApprovalNotificationRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
  if (!rec) return null;
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return rec.generation === gen && rec.requestId === requestId ? rec : null;
}

/** All persisted approval-wake results for a job, ordered by generation then request id. */
export function readApprovalNotificationResults(root: string, id: string): ApprovalNotificationRecord[] {
  const dir = approvalNotifyDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }
  const prefix = `${safeId(id)}.gen-`;
  const out: ApprovalNotificationRecord[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".approval.result.json")) continue;
    const file = path.join(dir, name);
    assertInside(root, file);
    let rec: ApprovalNotificationRecord | null = null;
    try {
      rec = normalizeApprovalNotificationRecord(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      rec = null;
    }
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.generation - b.generation || a.requestId.localeCompare(b.requestId));
  return out;
}

/**
 * Claim the ONE bounded RECOVERY attempt for this terminal event identity
 * `(job, generation, terminal)` with an exclusive create (`wx`). New binding
 * ids and repeated SessionStart hooks cannot reset it: the claim file is the
 * durable per-event budget. An incomplete/crashed claim stays consumed — a
 * claimed attempt with no completed record is UNKNOWN, never free to resend.
 */
export function claimTerminalRecoveryAttempt(root: string, id: string, generation: number): boolean {
  const file = terminalRecoveryClaimPath(root, id, generation);
  assertInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

/**
 * The approval recovery identity additionally includes the request id:
 * `(job, generation, approval, requestId)`. Kept in its own file namespace so a
 * terminal event and an approval event of the same generation can never consume
 * each other's allowance.
 */
function approvalRecoveryFile(root: string, id: string, generation: number, requestId: string, suffix: string): string {
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  const file = path.join(recoveryNotifyDir(root), `${safeId(id)}.gen-${gen}.${approvalFileToken(requestId)}.${suffix}`);
  assertInside(root, file);
  return file;
}

/** Claim the ONE bounded recovery attempt for an exact approval identity. */
export function claimApprovalRecoveryAttempt(root: string, id: string, generation: number, requestId: string): boolean {
  const file = approvalRecoveryFile(root, id, generation, requestId, "approval.recovery.claim");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw e;
  }
}

function normalizeRecoveryRecord(v: unknown): RecoveryNotificationRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  const event = x.event === "terminal" || x.event === "approval_required" ? x.event : null;
  const generation = asNumberOrNull(x.generation);
  if (!event || generation == null || !Number.isInteger(generation) || generation < 0) return null;
  const requestId = asStringOrNull(x.requestId);
  if (event === "approval_required" && !requestId) return null;
  return {
    event,
    generation,
    requestId: event === "approval_required" ? (requestId!.length <= 128 ? requestId! : requestId!.slice(0, 128)) : null,
    attemptedAt: asStringOrNull(x.attemptedAt) ?? "",
    delivered: asBool(x.delivered),
    reason: asStringOrNull(x.reason),
    by: normalizeNotifyOrigin(x.by)
  };
}

/** Persist the RECOVERY outcome of one terminal event (never the job record). */
export function writeTerminalRecoveryResult(
  root: string,
  id: string,
  generation: number,
  record: RecoveryNotificationRecord,
  now?: () => Date
): void {
  const file = terminalRecoveryResultPath(root, id, generation);
  assertInside(root, file);
  const payload: RecoveryNotificationRecord = {
    event: "terminal",
    generation,
    requestId: null,
    attemptedAt: record.attemptedAt || nowIso(now),
    delivered: record.delivered === true,
    reason: record.reason,
    by: normalizeNotifyOrigin(record.by)
  };
  atomicWriteFile(file, JSON.stringify(payload));
}

/** Read the recovery outcome for the exact terminal event identity, or null. */
export function readTerminalRecoveryResult(root: string, id: string, generation: number): RecoveryNotificationRecord | null {
  const file = terminalRecoveryResultPath(root, id, generation);
  assertInside(root, file);
  try {
    const rec = normalizeRecoveryRecord(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!rec || rec.event !== "terminal") return null;
    const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
    return rec.generation === gen ? rec : null;
  } catch {
    return null;
  }
}

/** Persist the RECOVERY outcome of one exact approval event (never the job record). */
export function writeApprovalRecoveryResult(
  root: string,
  id: string,
  generation: number,
  record: RecoveryNotificationRecord,
  now?: () => Date
): void {
  if (!record.requestId) throw new JobStoreError("bad_request_id", "an approval recovery record requires its request id");
  const file = approvalRecoveryFile(root, id, generation, record.requestId, "approval.recovery.json");
  const payload: RecoveryNotificationRecord = {
    event: "approval_required",
    generation,
    requestId: record.requestId,
    attemptedAt: record.attemptedAt || nowIso(now),
    delivered: record.delivered === true,
    reason: record.reason,
    by: normalizeNotifyOrigin(record.by)
  };
  atomicWriteFile(file, JSON.stringify(payload));
}

/** Read the recovery outcome for the exact approval event identity, or null. */
export function readApprovalRecoveryResult(root: string, id: string, generation: number, requestId: string): RecoveryNotificationRecord | null {
  const file = approvalRecoveryFile(root, id, generation, requestId, "approval.recovery.json");
  let rec: RecoveryNotificationRecord | null;
  try {
    rec = normalizeRecoveryRecord(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
  if (!rec || rec.event !== "approval_required") return null;
  const gen = Number.isInteger(generation) && generation >= 0 ? generation : 0;
  return rec.generation === gen && rec.requestId === requestId ? rec : null;
}

// ---------------------------------------------------------------------------
// Per-generation terminal result-read receipts (sidecar, never the job record)
// ---------------------------------------------------------------------------

/**
 * Durably record that the REAL terminal result entry served this exact
 * `(job, generation)`. The write is atomic; a FAILURE THROWS so the caller can
 * report it explicitly instead of silently claiming a dedup guarantee it does
 * not have. The receipt means "result collected / request served" — never
 * "accepted", and never proof that the caller rendered the payload.
 */
export function writeTerminalReadReceipt(root: string, id: string, generation: number, by: string | null, now?: () => Date): void {
  const file = terminalReadReceiptPath(root, id, generation);
  assertInside(root, file);
  const rec: TerminalReadReceipt = {
    generation: Number.isInteger(generation) && generation >= 0 ? generation : 0,
    by: normalizeNotifyOrigin(by),
    at: nowIso(now)
  };
  atomicWriteFile(file, JSON.stringify(rec));
}

/** Read the terminal result-read receipt for the exact generation, or null. */
export function readTerminalReadReceipt(root: string, id: string, generation: number): TerminalReadReceipt | null {
  const file = terminalReadReceiptPath(root, id, generation);
  assertInside(root, file);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const gen = asNumberOrNull(parsed.generation);
    if (gen == null) return null;
    const expected = Number.isInteger(generation) && generation >= 0 ? generation : 0;
    if (gen !== expected) return null;
    return { generation: gen, by: normalizeNotifyOrigin(parsed.by), at: asStringOrNull(parsed.at) ?? "" };
  } catch {
    return null;
  }
}

/**
 * Merge the per-generation RESULT files with any inline `notifications` a legacy
 * (batch-3.0) record persisted. The file is authoritative for a generation it
 * covers; inline entries are kept only when no file exists for that generation.
 */
export function mergeNotifications(root: string, job: Pick<JobRecord, "id" | "notifications">): NotificationRecord[] {
  const byGeneration = new Map<number, NotificationRecord>();
  for (const rec of job.notifications) {
    if (!byGeneration.has(rec.generation)) byGeneration.set(rec.generation, rec);
  }
  for (const rec of readNotificationResults(root, job.id)) byGeneration.set(rec.generation, rec);
  return [...byGeneration.values()].sort((a, b) => a.generation - b.generation);
}

/** A read-only copy of the record with its wake results merged in (never saved). */
export function withMergedNotifications(root: string, job: JobRecord): JobRecord {
  return { ...job, notifications: mergeNotifications(root, job) };
}

/**
 * A generation-scoped record of WHAT was PROVEN about one attempt's CLI process
 * tree. It is written OUT OF BAND, exactly like the cancel intent, so a cancel
 * client and the owner worker can hand each other the evidence without racing the
 * single-writer job record.
 *
 * `scope` states the strength honestly (see `KillTreeScope` in
 * runtime/process.ts): a successful OS tree kill is `os_tree_exited`, a scoped
 * cleanup of identifiable descendants is `identified_descendants_stopped`, and a
 * dead root whose visible tree is empty is `root_exited`. NONE of them claims
 * that an arbitrary detached descendant behind an exited intermediate is gone.
 *
 * The record is bound to `{ id, generation, childPid }`: a confirmation for an
 * OLD generation or a different PID can never approve a newer run.
 */
export interface TreeConfirmation {
  id: string;
  generation: number;
  childPid: number;
  at: string;
  by: string;
  /** What was actually proven; never an absolute whole-tree guarantee. */
  scope: KillTreeScope;
}

/** Conservative default for a record from an older/unknown build. */
const DEFAULT_TREE_SCOPE: KillTreeScope = "root_exited";

function normalizeTreeScope(v: unknown): KillTreeScope {
  return v === "none" || v === "root_exited" || v === "os_tree_exited" || v === "identified_descendants_stopped" || v === "unconfirmed"
    ? v
    : DEFAULT_TREE_SCOPE;
}

export function writeTreeConfirmation(
  root: string,
  id: string,
  generation: number,
  childPid: number,
  scope: KillTreeScope,
  by: string,
  now?: () => Date
): void {
  const file = treeConfirmPath(root, id);
  assertInside(root, file);
  const rec: TreeConfirmation = {
    id: safeId(id),
    generation,
    childPid,
    by: typeof by === "string" && by.trim() ? by.trim() : "unknown",
    scope: normalizeTreeScope(scope),
    at: nowIso(now)
  };
  atomicWriteFile(file, JSON.stringify(rec));
}

export function readTreeConfirmation(root: string, id: string): TreeConfirmation | null {
  const file = treeConfirmPath(root, id);
  assertInside(root, file);
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const generation = asNumberOrNull(obj.generation);
    const childPid = asNumberOrNull(obj.childPid);
    if (generation == null || childPid == null) return null;
    return {
      id: asStringOrNull(obj.id) ?? safeId(id),
      generation,
      childPid,
      at: asStringOrNull(obj.at) ?? "",
      by: asStringOrNull(obj.by) ?? "",
      scope: normalizeTreeScope(obj.scope)
    };
  } catch {
    return null;
  }
}

export function clearTreeConfirmation(root: string, id: string): void {
  const file = treeConfirmPath(root, id);
  assertInside(root, file);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Does a persisted confirmation prove the job's recorded child tree stopped?
 *
 * It matches ONLY when the record's `childPid` equals the job's `childPid` AND
 * its `generation` equals the job's `childGeneration` (falling back to the job's
 * current generation). A missing record, a stale generation or a different PID
 * all return `false`, so a dead root is never silently upgraded to a tree exit.
 *
 * "Stopped" here means the CrewDispatch-managed and identified processes are gone
 * (the record's `scope` says exactly which); it is NEVER a claim that an
 * arbitrary detached descendant behind an exited intermediate is gone.
 */
export function isTreeConfirmed(
  root: string,
  job: Pick<JobRecord, "id" | "generation" | "childPid" | "childGeneration">
): boolean {
  if (job.childPid == null) return false;
  const rec = readTreeConfirmation(root, job.id);
  if (!rec) return false;
  const generation = job.childGeneration ?? job.generation;
  return rec.childPid === job.childPid && rec.generation === generation;
}

// ---------------------------------------------------------------------------
// Passive recovery evidence for a TERMINAL holder (kept OUT of the record)
// ---------------------------------------------------------------------------

/**
 * How a terminal holder's retained managed tree was independently proven
 * stopped WITHOUT killing anything (see `recoverTerminalHolders`):
 *
 *   - `boot_session_cleared` — the current OS boot provably postdates the
 *     LATEST recorded attempt start of the recorded generation (the spawn the
 *     retained child belongs to), and no process survives a reboot. The
 *     strongest available evidence: it does not depend on the process table and
 *     it is not fooled by a REUSED pid (any current process with the old number
 *     belongs to the current boot session, not to the recorded generation).
 *   - `descendant_snapshot` — the recorded root PID is provably gone and a
 *     bounded OS process-table snapshot scoped to `root PID + generation start`
 *     found no live descendant. The same bounded negative observation the
 *     existing old-tree check uses; never proof about an arbitrary detached
 *     descendant behind an exited intermediate.
 */
export type TreeRecoveryMethod = "boot_session_cleared" | "descendant_snapshot";

/**
 * Generation-scoped, out-of-band evidence that a TERMINAL record's retained
 * managed tree is stopped. It is written by the passive recovery path ONLY,
 * never by a kill, and lives beside the kill confirmation in `<root>/tree/` so
 * the job record itself stays byte-identical.
 *
 * Like `TreeConfirmation` it is bound to `{ id, generation, childPid }`: a late
 * write for an old generation can never approve a newer one.
 */
export interface TreeRecoveryEvidence {
  id: string;
  /** The CHILD generation that was proven stopped (not the live record's). */
  generation: number;
  childPid: number;
  at: string;
  by: string;
  method: TreeRecoveryMethod;
  /** For `boot_session_cleared`: the OS boot instant that postdates `generationStartedAtMs`. */
  bootAtMs: number | null;
  /**
   * The generation's LATEST recorded attempt start the proof was bound to,
   * epoch ms. Always present: every proof is scoped to the spawn the retained
   * child belongs to.
   */
  generationStartedAtMs: number | null;
  /** Scoped live descendant PIDs observed at validation time (empty on success). */
  survivingPids: number[];
}

/** Path of a job's passive recovery evidence (never the job record). */
export function treeRecoveryPath(root: string, id: string): string {
  return path.join(treeDir(root), `${safeId(id)}.recovery.json`);
}

function normalizeRecoveryMethod(v: unknown): TreeRecoveryMethod | null {
  return v === "boot_session_cleared" || v === "descendant_snapshot" ? v : null;
}

export function writeTreeRecovery(
  root: string,
  id: string,
  generation: number,
  childPid: number,
  evidence: {
    method: TreeRecoveryMethod;
    by: string;
    bootAtMs?: number | null;
    generationStartedAtMs?: number | null;
    survivingPids?: readonly number[];
  },
  now?: () => Date
): void {
  const file = treeRecoveryPath(root, id);
  assertInside(root, file);
  const rec: TreeRecoveryEvidence = {
    id: safeId(id),
    generation,
    childPid,
    by: typeof evidence.by === "string" && evidence.by.trim() ? evidence.by.trim() : "unknown",
    method: evidence.method,
    bootAtMs: typeof evidence.bootAtMs === "number" && Number.isFinite(evidence.bootAtMs) ? Math.trunc(evidence.bootAtMs) : null,
    generationStartedAtMs:
      typeof evidence.generationStartedAtMs === "number" && Number.isFinite(evidence.generationStartedAtMs)
        ? Math.trunc(evidence.generationStartedAtMs)
        : null,
    survivingPids: (evidence.survivingPids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 64),
    at: nowIso(now)
  };
  atomicWriteFile(file, JSON.stringify(rec));
}

/**
 * Read a job's recovery evidence, or null.
 *
 * FAIL CLOSED: a malformed or internally inconsistent record reads as null —
 * never as a weaker proof. The evidence file is keyed by job id, so the record
 * must name THIS job; the method must be known and its fields consistent; the
 * generation start must be a real instant; a boot proof needs a boot instant
 * STRICTLY AFTER that start (contradictory timestamps authorize nothing); a
 * descendant snapshot carries no boot instant; and a release never records
 * surviving PIDs.
 */
export function readTreeRecovery(root: string, id: string): TreeRecoveryEvidence | null {
  const file = treeRecoveryPath(root, id);
  assertInside(root, file);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  // The file is per-job: a record naming a different job (a copied, late or
  // misplaced write) is never evidence for this one.
  const recId = asStringOrNull(obj.id);
  if (recId == null || recId !== safeId(id)) return null;
  const generation = asNumberOrNull(obj.generation);
  const childPid = asNumberOrNull(obj.childPid);
  const method = normalizeRecoveryMethod(obj.method);
  if (generation == null || !Number.isInteger(generation) || generation < 0) return null;
  if (childPid == null || !Number.isInteger(childPid) || childPid <= 0) return null;
  if (!method) return null;
  const startedAtMs = asNumberOrNull(obj.generationStartedAtMs);
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  const bootAtMs = asNumberOrNull(obj.bootAtMs);
  if (method === "boot_session_cleared") {
    // A boot proof must actually postdate the generation start it is bound to;
    // a boot at/before that start proves nothing about the recorded tree.
    if (bootAtMs == null || bootAtMs <= 0 || !(bootAtMs > startedAtMs)) return null;
  } else if (bootAtMs != null) {
    // A descendant snapshot is a same-session observation and carries no boot.
    return null;
  }
  const surviving = Array.isArray(obj.survivingPids)
    ? obj.survivingPids.filter((pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0).slice(0, 64)
    : [];
  // A release never has survivors: a record naming live scoped PIDs is not
  // proof that the tree stopped.
  if (surviving.length > 0) return null;
  return {
    id: recId,
    generation,
    childPid,
    at: asStringOrNull(obj.at) ?? "",
    by: asStringOrNull(obj.by) ?? "",
    method,
    bootAtMs,
    generationStartedAtMs: startedAtMs,
    survivingPids: surviving
  };
}

export function clearTreeRecovery(root: string, id: string): void {
  const file = treeRecoveryPath(root, id);
  assertInside(root, file);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Does validated passive recovery evidence prove THIS exact retained tree
 * stopped? Matches only the same `{ id, generation, childPid }` binding as
 * `isTreeConfirmed` — a wrong job, a wrong generation, a different PID, or a
 * missing/malformed/contradictory record (see `readTreeRecovery`) is never a
 * release.
 */
export function isTreeRecoveryConfirmed(
  root: string,
  job: Pick<JobRecord, "id" | "generation" | "childPid" | "childGeneration">
): boolean {
  if (job.childPid == null) return false;
  const rec = readTreeRecovery(root, job.id);
  if (!rec) return false;
  const generation = job.childGeneration ?? job.generation;
  return rec.childPid === job.childPid && rec.generation === generation;
}

// ---------------------------------------------------------------------------
// Job transition lock (short, cross-process, exact lock file)
// ---------------------------------------------------------------------------

/**
 * Coordinate a terminal-to-running continuation (and the passive recovery
 * revalidation) with diagnostics retention. The lock is an exact, exclusive
 * file under CrewDispatch's `jobs/` directory, and callers must release it in
 * `finally`. A stale lock from a crashed process is reclaimed only when its
 * owner PID is provably gone (or an unreadable marker is older than one
 * minute).
 */
export function acquireJobTransitionLock(root: string, id: string): (() => void) | null {
  const file = path.join(root, "jobs", `${safeId(id)}.transition.lock`);
  assertInside(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const stale = (): boolean => {
    try {
      const stat = fs.statSync(file);
      let ownerPid: number | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0) ownerPid = parsed.pid as number;
      } catch {
        // An empty/corrupt marker may be from a process that crashed while
        // creating it. Wait before reclaiming so a just-created marker wins.
      }
      if (ownerPid != null) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ESRCH") return false;
        }
      } else if (Date.now() - stat.mtimeMs < 60_000) {
        return false;
      }
      fs.unlinkSync(file);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException)?.code === "ENOENT";
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = fs.openSync(file, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST" && stale()) continue;
      return null;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
      try {
        fs.fsyncSync(fd);
      } catch {
        /* a durable lock marker is best-effort; exclusive creation is the guard */
      }
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      throw e;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.unlinkSync(file); } catch { /* best effort */ }
    };
  }
  return null;
}
