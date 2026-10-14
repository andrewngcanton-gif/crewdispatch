// failure-evidence.ts — TEST-ONLY bounded failure-evidence retention.
//
// The two 982/984 full-regression failures lost their exact decision-time
// evidence: a `waitTerminal` budget expired and only "did not reach a terminal
// state" survived; the workspace-admission failure kept neither the actual
// recovery decision nor the caller outcomes. This helper exists so a FUTURE
// failure of those two named tests retains a bounded, whitelisted snapshot of
// their own disposable data root BEFORE teardown deletes it, plus the primary
// and cleanup errors, in a NEW test-owned temp directory that is OUTSIDE the
// workspace being removed.
//
// Hard rules encoded here:
//   - read ONLY the known disposable root the test created; never a real user
//     data root, never a workspace file's CONTENT (the workspace path is
//     recorded as a string only);
//   - whitelist explicit records/fields. Never include environments, credentials,
//     arbitrary process command lines, user transcripts (task text, result
//     final text, message/log contents) or unrelated files;
//   - bound every array and string; mark missing/unreadable/truncated data
//     honestly; NEVER translate UNKNOWN into "stopped";
//   - create the artifact directory ONLY on failure (a passing test leaves no
//     persistent artifact);
//   - preserve BOTH the body and the cleanup error (AggregateError) and never let
//     a diagnostic-write failure hide the original failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enumerateProcesses, isPidAlive, type ProcessEntry } from "../../runtime/process";

const MAX_JOBS = 32;
const MAX_TREE = 64;
const MAX_NOTIFY = 128;
const MAX_TERMINAL = 32;
const MAX_CANCEL = 32;
const MAX_PHASES = 8;
const MAX_ATTEMPTS = 64;
const MAX_NOTIFICATIONS = 64;
const MAX_RELEVANT_PROCS = 16;
const MAX_STRING = 400;
const MAX_STACK = 4000;
const CHILD_OBSERVE_TIMEOUT_MS = 5000;

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function capText(v: unknown, cap: number): { value: string | null; truncated: boolean } {
  if (typeof v !== "string") return { value: null, truncated: false };
  if (v.length <= cap) return { value: v, truncated: false };
  return { value: v.slice(0, cap), truncated: true };
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sanitizeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 64) || "evidence";
}

interface DirRead {
  ok: boolean;
  names: string[];
  missing: boolean;
  error: string | null;
}

function readDirNames(dir: string): DirRead {
  try {
    return { ok: true, names: fs.readdirSync(dir), missing: false, error: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code ?? "";
    return { ok: false, names: [], missing: code === "ENOENT", error: `${code || "read_error"}: ${errText(e)}` };
  }
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/** Builder that records honest truncation markers alongside the bounded data. */
class Bounded {
  readonly truncated: string[] = [];
  str(v: unknown, cap = MAX_STRING): string | null {
    const r = capText(v, cap);
    if (r.truncated) this.truncated.push("string");
    return r.value;
  }
}

function pickCancelIntent(raw: unknown): Record<string, unknown> {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { requested: x.requested === true, requestedAt: asStr(x.requestedAt), by: asStr(x.by) };
}

function pickNotifyTarget(raw: unknown): Record<string, unknown> {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    kind: asStr(x.kind),
    source: asStr(x.source),
    hasCallbackUrl: typeof x.callbackUrl === "string" && x.callbackUrl.length > 0,
    hasCodexThreadId: typeof x.codexThreadId === "string" && x.codexThreadId.length > 0,
    hasClaudeBinding: typeof x.claudeBindingId === "string" && x.claudeBindingId.length > 0
  };
}

function pickResult(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  return {
    ok: x.ok === true,
    kind: asStr(x.kind),
    subtype: asStr(x.subtype),
    stopReason: asStr(x.stopReason),
    exitCode: asNum(x.exitCode),
    fallbackEligible: x.fallbackEligible === true
    // finalText is deliberately EXCLUDED (provider/user output).
  };
}

function pickAttempt(raw: unknown): Record<string, unknown> {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    generation: asNum(x.generation),
    startedAt: asStr(x.startedAt),
    endedAt: asStr(x.endedAt),
    exitCode: asNum(x.exitCode),
    kind: asStr(x.kind),
    failureKind: asStr(x.failureKind),
    segment: x.segment === true,
    resumedFrom: asStr(x.resumedFrom),
    rateLimited: x.rateLimited === true,
    switched: x.switched === true
  };
}

function pickNotification(raw: unknown, b: Bounded): Record<string, unknown> {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    generation: asNum(x.generation),
    kind: asStr(x.kind),
    attemptedAt: asStr(x.attemptedAt),
    delivered: x.delivered === true,
    reason: b.str(x.reason),
    by: asStr(x.by),
    phase: asStr(x.phase)
  };
}

function pickJob(raw: unknown, b: Bounded): Record<string, unknown> {
  const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    id: asStr(x.id),
    status: asStr(x.status),
    generation: asNum(x.generation),
    childPid: asNum(x.childPid),
    childGeneration: asNum(x.childGeneration),
    owner: b.str(x.owner),
    ownerPid: asNum(x.ownerPid),
    heartbeatAt: asStr(x.heartbeatAt),
    startedAt: asStr(x.startedAt),
    finishedAt: asStr(x.finishedAt),
    stopReason: asStr(x.stopReason),
    finishReason: asStr(x.finishReason),
    failureKind: asStr(x.failureKind),
    approvalOutcome: asStr(x.approvalOutcome),
    error: b.str(x.error),
    errorDetail: b.str(x.errorDetail),
    model: b.str(x.model, 200),
    sessionId: b.str(x.sessionId, 200),
    cancelIntent: pickCancelIntent(x.cancelIntent),
    notifyTarget: pickNotifyTarget(x.notifyTarget),
    result: pickResult(x.result),
    attempts: Array.isArray(x.attempts) ? x.attempts.slice(-MAX_ATTEMPTS).map(pickAttempt) : [],
    notifications: Array.isArray(x.notifications) ? x.notifications.slice(-MAX_NOTIFICATIONS).map((n) => pickNotification(n, b)) : []
    // task is deliberately EXCLUDED (the job's input text).
  };
}

export interface RetainedChildObservation {
  pid: number | null;
  alive: boolean | null;
  identity: { pid: number; ppid: number; createdAtMs: number | null } | null;
  relevantProcesses: Array<{ pid: number; ppid: number; createdAtMs: number | null }>;
  scan: { ok: boolean; reason: string | null; count: number | null };
  observedAt: string;
  /** This observation happens AFTER the failure; it is never a decision-time scan. */
  laterEvidence: true;
  note: string;
}

/**
 * Bounded, labelled OS observation of the retained child of the failing test.
 * It is explicitly marked `laterEvidence: true` — it is a post-failure
 * observation, never presented as the decision-time scan the production code
 * performed. Only the child's own entry and its direct neighbours are kept; the
 * full process table is never retained.
 */
export async function observeRetainedChild(pid: number | null): Promise<RetainedChildObservation> {
  const observedAt = new Date().toISOString();
  const alive = pid != null && Number.isInteger(pid) && pid > 0 ? isPidAlive(pid) : null;
  let scan: { ok: boolean; reason: string | null; count: number | null } = { ok: false, reason: "not_scanned", count: null };
  let identity: RetainedChildObservation["identity"] = null;
  let relevantProcesses: RetainedChildObservation["relevantProcesses"] = [];
  if (pid != null && Number.isInteger(pid) && pid > 0) {
    try {
      const result = await withTimeout(enumerateProcesses(), CHILD_OBSERVE_TIMEOUT_MS, () => ({ ok: false, processes: [] as ProcessEntry[], reason: "observation_timeout" }));
      scan = { ok: result.ok, reason: result.reason ?? null, count: result.processes.length };
      const matches = result.processes.filter((p) => p.pid === pid || p.ppid === pid).slice(0, MAX_RELEVANT_PROCS);
      identity = matches.find((p) => p.pid === pid) ?? null;
      relevantProcesses = matches.map((p) => ({ pid: p.pid, ppid: p.ppid, createdAtMs: p.createdAtMs }));
    } catch (e) {
      scan = { ok: false, reason: `observation_failed: ${errText(e).slice(0, 200)}`, count: null };
    }
  }
  return {
    pid,
    alive,
    identity,
    relevantProcesses,
    scan,
    observedAt,
    laterEvidence: true,
    note:
      "Post-failure OS observation of the test-owned retained child. Not the production decision-time scan; " +
      "alive:null means the liveness probe itself was unknown (never read as stopped)."
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(onTimeout()), ms);
    timer.unref?.();
    p.then(finish, () => finish(onTimeout()));
  });
}

export interface DurableSnapshot {
  dataRoot: string;
  phase: string;
  at: string;
  present: Record<string, boolean>;
  missing: string[];
  unreadable: string[];
  truncated: string[];
  jobs: Array<Record<string, unknown>>;
  treeConfirmations: Array<Record<string, unknown>>;
  treeRecoveries: Array<Record<string, unknown>>;
  notifyClaims: Array<Record<string, unknown>>;
  notifyResults: Array<Record<string, unknown>>;
  terminalSnapshots: Array<Record<string, unknown>>;
  cancelIntents: Array<Record<string, unknown>>;
  daemonMeta: Record<string, unknown> | null;
  messagesFileCount: number | null;
  logsFileCount: number | null;
  retainedChild: RetainedChildObservation | null;
  notes: string[];
}

/**
 * Read ONLY `root` and return a bounded, whitelisted snapshot. Every record is
 * marked present/missing/unreadable honestly; a value that could not be read is
 * NEVER reported as a resolved state.
 */
export function collectDurableSnapshot(root: string, phase: string, retainedChild: RetainedChildObservation | null): DurableSnapshot {
  const b = new Bounded();
  const missing: string[] = [];
  const unreadable: string[] = [];
  const notes: string[] = [];
  if (!path.isAbsolute(root)) {
    notes.push("dataRoot is not absolute; refusing to read it as evidence.");
  }

  const present: Record<string, boolean> = {};
  const dir = (name: string): DirRead => {
    const r = readDirNames(path.join(root, name));
    present[name] = r.ok;
    if (r.missing) missing.push(name);
    else if (!r.ok) unreadable.push(`${name}: ${r.error}`);
    return r;
  };

  const jobsDir = dir("jobs");
  const jobs: Array<Record<string, unknown>> = [];
  for (const name of jobsDir.names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).slice(0, MAX_JOBS)) {
    const r = readJson(path.join(root, "jobs", name));
    if (!r.ok) unreadable.push(`jobs/${name}: ${r.error}`);
    else jobs.push(pickJob(r.value, b));
  }
  if (jobsDir.names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).length > MAX_JOBS) b.truncated.push("jobs>cap");

  const treeDir = dir("tree");
  const treeConfirmations: Array<Record<string, unknown>> = [];
  const treeRecoveries: Array<Record<string, unknown>> = [];
  for (const name of treeDir.names.filter((n) => n.endsWith(".json")).slice(0, MAX_TREE)) {
    const r = readJson(path.join(root, "tree", name));
    if (!r.ok) {
      unreadable.push(`tree/${name}: ${r.error}`);
      continue;
    }
    const x = (r.value && typeof r.value === "object" ? r.value : {}) as Record<string, unknown>;
    if (name.endsWith(".recovery.json")) {
      treeRecoveries.push({
        file: name,
        id: asStr(x.id),
        generation: asNum(x.generation),
        childPid: asNum(x.childPid),
        method: asStr(x.method),
        bootAtMs: asNum(x.bootAtMs),
        generationStartedAtMs: asNum(x.generationStartedAtMs),
        survivingPids: Array.isArray(x.survivingPids) ? x.survivingPids.filter((p): p is number => typeof p === "number").slice(0, 64) : [],
        at: asStr(x.at),
        by: asStr(x.by)
      });
    } else {
      treeConfirmations.push({
        file: name,
        id: asStr(x.id),
        generation: asNum(x.generation),
        childPid: asNum(x.childPid),
        scope: asStr(x.scope),
        at: asStr(x.at),
        by: asStr(x.by)
      });
    }
  }

  const notifyDir = dir("notify");
  const notifyClaims: Array<Record<string, unknown>> = [];
  const notifyResults: Array<Record<string, unknown>> = [];
  for (const name of notifyDir.names.slice(0, MAX_NOTIFY)) {
    if (name.endsWith(".claim")) {
      notifyClaims.push({ file: name });
    } else if (name.endsWith(".result.json")) {
      const r = readJson(path.join(root, "notify", name));
      if (!r.ok) unreadable.push(`notify/${name}: ${r.error}`);
      else {
        const x = (r.value && typeof r.value === "object" ? r.value : {}) as Record<string, unknown>;
        notifyResults.push({ file: name, ...pickNotification(x, b) });
      }
    }
  }
  // Sub-directories under notify/ (recovery/approval/receipts) are reported as
  // presence only; their records are not required for these two tests.
  for (const sub of ["recovery", "approval", "receipts"]) {
    present[`notify/${sub}`] = fs.existsSync(path.join(root, "notify", sub));
  }

  const terminalDir = dir("terminal");
  const terminalSnapshots: Array<Record<string, unknown>> = [];
  for (const name of terminalDir.names.filter((n) => n.endsWith(".json")).slice(0, MAX_TERMINAL)) {
    const r = readJson(path.join(root, "terminal", name));
    if (!r.ok) {
      unreadable.push(`terminal/${name}: ${r.error}`);
      continue;
    }
    const x = (r.value && typeof r.value === "object" ? r.value : {}) as Record<string, unknown>;
    terminalSnapshots.push({
      file: name,
      id: asStr(x.id),
      generation: asNum(x.generation),
      status: asStr(x.status),
      notifyKind: pickNotifyTarget(x.notifyTarget).kind,
      at: asStr(x.at),
      by: asStr(x.by)
    });
  }

  const cancelDir = dir("cancel");
  const cancelIntents = cancelDir.names.filter((n) => n.endsWith(".intent")).slice(0, MAX_CANCEL).map((name) => ({ file: name }));

  // The daemon metadata carries a TOKEN: only non-secret fields are retained.
  const daemonDir = dir("daemon");
  let daemonMeta: Record<string, unknown> | null = null;
  if (daemonDir.ok && daemonDir.names.includes("daemon.json")) {
    const r = readJson(path.join(root, "daemon", "daemon.json"));
    if (r.ok) {
      const x = (r.value && typeof r.value === "object" ? r.value : {}) as Record<string, unknown>;
      daemonMeta = { present: true, pid: asNum(x.pid), startedAt: asStr(x.startedAt), heartbeatAt: asStr(x.heartbeatAt), version: asNum(x.version) };
    } else {
      unreadable.push(`daemon/daemon.json: ${r.error}`);
    }
  }

  // messages/ and logs/ contain user/transcript content: record COUNTS only.
  const messagesDir = readDirNames(path.join(root, "messages"));
  present["messages"] = messagesDir.ok;
  if (messagesDir.missing) missing.push("messages");
  else if (!messagesDir.ok) unreadable.push(`messages: ${messagesDir.error}`);
  const logsDir = readDirNames(path.join(root, "logs"));
  present["logs"] = logsDir.ok;
  if (logsDir.missing) missing.push("logs");
  else if (!logsDir.ok) unreadable.push(`logs: ${logsDir.error}`);

  return {
    dataRoot: root,
    phase,
    at: new Date().toISOString(),
    present,
    missing,
    unreadable,
    truncated: b.truncated,
    jobs,
    treeConfirmations,
    treeRecoveries,
    notifyClaims,
    notifyResults,
    terminalSnapshots,
    cancelIntents,
    daemonMeta,
    messagesFileCount: messagesDir.ok ? messagesDir.names.length : null,
    logsFileCount: logsDir.ok ? logsDir.names.length : null,
    retainedChild,
    notes
  };
}

export interface FailureEvidencePhase {
  phase: string;
  at: string;
  durable: DurableSnapshot;
  extra: unknown;
}

export interface ArtifactWriteInput {
  baseDir: string;
  name: string;
  payload: string;
  readme: string;
}

/** Writes the artifact and returns its directory. May throw (a secondary failure). */
export type ArtifactWriter = (input: ArtifactWriteInput) => string;

export interface FailureEvidenceOptions {
  /** A human-readable test name (used in the artifact directory prefix). */
  name: string;
  /** The disposable data root THIS test created; the only root read. */
  dataRoot: string;
  /** The workspace directory teardown deletes; recorded as a path string only. */
  workspaceDir: string;
  /** Base directory for the artifact. Defaults to a test-owned temp base. */
  artifactBaseDir?: string;
  /** The test-owned retained child (B). Enables the labelled post-failure observation. */
  childPid?: () => number | null;
  /** Extra bounded, test-supplied evidence (last observed MCP state, caller outcomes). */
  extra?: () => unknown | Promise<unknown>;
  /** Bounded wrapper observations (B). */
  observations?: () => unknown;
  /** Injectable writer (the diagnostic-write-failure check). */
  writeArtifactFn?: ArtifactWriter;
}

export interface FailureEvidence {
  readonly name: string;
  readonly artifactBaseDir: string;
  capture(phase: string): Promise<void>;
  /** Synchronous: evaluated at flush time from already-captured data. */
  flush(errors: { primary?: unknown; cleanup?: unknown; hasPrimary: boolean }): { artifactDir: string | null; writeError: unknown };
}

function defaultArtifactWriter(input: ArtifactWriteInput): string {
  fs.mkdirSync(input.baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(input.baseDir, `jobquay-failure-evidence-${sanitizeName(input.name)}-`));
  fs.writeFileSync(path.join(dir, "evidence.json"), input.payload, "utf8");
  fs.writeFileSync(path.join(dir, "README.txt"), input.readme, "utf8");
  return dir;
}

function defaultArtifactBaseDir(): string {
  return path.join(os.tmpdir(), "jobquay-failure-evidence");
}

function serializeError(e: unknown): Record<string, unknown> | null {
  if (e === undefined || e === null) return null;
  if (e instanceof Error) {
    return { name: e.name, message: capText(e.message, MAX_STRING).value, stack: capText(e.stack, MAX_STACK).value };
  }
  return { name: typeof e, message: capText(String(e), MAX_STRING).value, stack: null };
}

function printArtifactLine(name: string, dir: string): void {
  try {
    process.stderr.write(
      `\n[failure-evidence] ${name}: retained bounded failure evidence (outside the deleted workspace) at:\n` +
        `FAILURE_EVIDENCE_ARTIFACT=${dir}\n`
    );
  } catch {
    /* printing must never mask the failure */
  }
}

function printWriteFailure(name: string, e: unknown): void {
  try {
    process.stderr.write(`[failure-evidence] ${name}: SECONDARY diagnostic-write failure (original failure preserved): ${errText(e)}\n`);
  } catch {
    /* ignore */
  }
}

export function createFailureEvidence(opts: FailureEvidenceOptions): FailureEvidence {
  const artifactBaseDir = opts.artifactBaseDir && opts.artifactBaseDir.trim() ? opts.artifactBaseDir.trim() : defaultArtifactBaseDir();
  const phases: FailureEvidencePhase[] = [];
  const childIdentityMemo: { value: RetainedChildObservation | null } = { value: null };

  const capture = async (phase: string): Promise<void> => {
    let child: RetainedChildObservation | null = null;
    if (opts.childPid) {
      const pid = opts.childPid();
      // Identity/PPID/birth is memoized (one OS observation); liveness is re-read
      // each capture because it is the part that changes.
      if (childIdentityMemo.value == null || childIdentityMemo.value.pid !== pid) {
        childIdentityMemo.value = await observeRetainedChild(pid);
      } else {
        childIdentityMemo.value = { ...childIdentityMemo.value, alive: pid != null && pid > 0 ? isPidAlive(pid) : null, observedAt: new Date().toISOString() };
      }
      child = childIdentityMemo.value;
    }
    let extra: unknown = null;
    try {
      extra = opts.extra ? await opts.extra() : null;
    } catch (e) {
      extra = { error: errText(e) };
    }
    const durable = collectDurableSnapshot(opts.dataRoot, phase, child);
    phases.push({ phase, at: durable.at, durable, extra });
    if (phases.length > MAX_PHASES) {
      phases.shift();
      durable.notes.push(`earlier phases dropped; only the newest ${MAX_PHASES} are retained`);
    }
  };

  const flush = (errors: { primary?: unknown; cleanup?: unknown; hasPrimary: boolean }): { artifactDir: string | null; writeError: unknown } => {
    let observations: unknown = null;
    try {
      observations = opts.observations ? opts.observations() : null;
    } catch (e) {
      observations = { error: errText(e) };
    }
    const payload = {
      kind: "jobquay-test-failure-evidence",
      version: 1,
      name: opts.name,
      createdAt: new Date().toISOString(),
      sourceDataRoot: opts.dataRoot,
      sourceWorkspaceDir: opts.workspaceDir,
      notes: [
        "Test-only bounded evidence. Only the disposable data root named above was read.",
        "Whitelisted fields only: no environments, credentials, arbitrary command lines, task text, result text or message/log content.",
        "missing/unreadable/truncated entries are marked honestly; an unknown liveness is never presented as stopped.",
        "The source workspace may already be deleted by teardown; this artifact lives outside it and is retained."
      ],
      phases: phases.map((p) => ({ phase: p.phase, at: p.at, durable: p.durable, extra: p.extra })),
      observations,
      primaryError: serializeError(errors.primary),
      cleanupError: serializeError(errors.cleanup),
      diagnosticWriteError: null as Record<string, unknown> | null
    };
    const readme =
      `jobquay test failure evidence\n` +
      `name: ${opts.name}\n` +
      `sourceDataRoot: ${opts.dataRoot}\n` +
      `sourceWorkspaceDir: ${opts.workspaceDir}\n` +
      `This directory is TEST-ONLY, retained after the disposable workspace was removed.\n` +
      `It contains a bounded, whitelisted snapshot of durable job/attempt/tree/notify/terminal state\n` +
      `and the primary/cleanup errors. See evidence.json.\n`;
    try {
      const writer = opts.writeArtifactFn ?? defaultArtifactWriter;
      const dir = writer({ baseDir: artifactBaseDir, name: opts.name, payload: JSON.stringify(payload, null, 2), readme });
      return { artifactDir: dir, writeError: null };
    } catch (e) {
      return { artifactDir: null, writeError: e };
    }
  };

  return { name: opts.name, artifactBaseDir, capture, flush };
}

export interface CleanupStep {
  /** Short label used in the aggregate error message (never a secret). */
  name: string;
  run: () => void | Promise<void>;
}

/**
 * Attempt EVERY cleanup step even if an earlier one throws, then throw a single
 * AggregateError only after all steps have been attempted.
 *
 * The two named full-regression tests previously ran their teardown as a
 * sequential chain of `await`s: an early `client.close()`/`listener.close()`
 * exception skipped the daemon shutdown and the workspace removal, and only the
 * first error reached `runWithFailureEvidence`. Routing the owned cleanup through
 * this runner guarantees the remaining steps are still attempted and that EVERY
 * cleanup error survives alongside the original body error.
 */
export async function runCleanupSteps(steps: readonly CleanupStep[]): Promise<void> {
  const errors: Array<{ name: string; error: unknown }> = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (e) {
      errors.push({ name: step.name, error: e });
    }
  }
  if (errors.length === 0) return;
  const detail = errors.map((e) => `${e.name}=${errText(e.error)}`).join(" | ");
  throw new AggregateError(
    errors.map((e) => e.error),
    `cleanup steps failed (${errors.length}/${steps.length}): ${detail}`
  );
}

/**
 * Run the test body and its teardown so that a failure of EITHER retains a
 * pre-teardown snapshot and a bounded artifact. Both errors are preserved; a
 * diagnostic-write failure is attached but never hides the original failure.
 */
export async function runWithFailureEvidence<T>(
  evidence: FailureEvidence,
  body: (ctx: FailureEvidence) => Promise<T>,
  teardown: (ctx: FailureEvidence) => Promise<void>
): Promise<T> {
  let hasPrimary = false;
  let primary: unknown;
  let result: T | undefined;
  await evidence.capture("start").catch(() => undefined);
  try {
    result = await body(evidence);
    await evidence.capture("before-teardown").catch(() => undefined);
  } catch (e) {
    hasPrimary = true;
    primary = e;
    // Capture the pre-teardown failure state; a capture failure is secondary.
    await evidence.capture("body-error-before-teardown").catch(() => undefined);
  }

  let hasCleanup = false;
  let cleanup: unknown;
  try {
    await teardown(evidence);
  } catch (e) {
    hasCleanup = true;
    cleanup = e;
  }

  if (!hasPrimary && !hasCleanup) return result as T;

  const { artifactDir, writeError } = evidence.flush({ primary, cleanup, hasPrimary });
  if (artifactDir) printArtifactLine(evidence.name, artifactDir);
  if (writeError) printWriteFailure(evidence.name, writeError);

  const real: unknown[] = [];
  if (hasPrimary) real.push(primary);
  if (hasCleanup) real.push(cleanup);
  const suffix = ` artifact=${artifactDir ?? "(none)"}`;
  if (real.length === 1 && !writeError) {
    // Preserve the original error object and its stack unchanged.
    throw real[0];
  }
  const extras = writeError ? [writeError] : [];
  const markers = real.map((e) => errText(e)).join(" | ");
  throw new AggregateError([...real, ...extras], `failure-evidence(${evidence.name}): ${markers}${suffix}`);
}
