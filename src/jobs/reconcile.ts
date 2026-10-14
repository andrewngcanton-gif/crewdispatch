// reconcile.ts — owner/heartbeat reconciliation across process restarts.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/jobs.mjs` isOrphanedJob / ownerPid / isPidAlive / loadJobs
// (kept as an explicit compatibility boundary).
//
// The rule that matters:
//
//   * a job is only "dead-owner" when its heartbeat is STALE **and** its owner
//     PID is NOT alive. A silent but live owner (long CLI call, blocked event
//     loop) must never be orphaned just because the heartbeat is late;
//   * a terminal job is NEVER rerun or rewritten by reconciliation;
//   * a dead owner whose CLI process TREE is resolved as stopped becomes terminal
//     (`interrupted`, or `cancelled` when a cancel intent was recorded). "Stopped"
//     means the CrewDispatch-managed and identified processes are gone — it never
//     claims an arbitrary detached descendant behind an exited intermediate was
//     proven gone (a pure TypeScript observation limit);
//   * a dead owner whose child tree is STILL ALIVE, of UNKNOWN liveness, or whose
//     ROOT is dead but has NO matching tree confirmation is NOT declared terminal.
//     It becomes the non-terminal `orphaned` state with `childPid` kept as
//     inspectable evidence: this never claims `cancelled`, never auto-resumes,
//     and lets a later explicit cancel retry the tree kill (which alone may
//     produce a terminal `cancelled`).
//   * a dead ROOT PID is never a tree guarantee: only a persisted, generation-
//     scoped confirmation (`isTreeConfirmedFn`) lets a dead root settle terminal.
//
// The same module also hosts the PASSIVE recovery for a TERMINAL record that
// still retains child evidence (`recoverTerminalHolders`, JQ-20261004-50): it
// never rewrites the record and never signals a process — see its section
// comment below.
import {
  DESCENDANT_CLOCK_TOLERANCE_MS,
  captureProcessIdentity,
  enumerateDescendantProcesses,
  enumerateProcesses,
  findDescendants,
  isPidAlive,
  readBootTime,
  type BootTimeReading,
  type EnumerateProcesses,
  type ProcessScan
} from "../runtime/process";
import { ownerPidOf } from "./generation";
import {
  acquireJobTransitionLock,
  isTreeConfirmed,
  isTreeRecoveryConfirmed,
  listJobs,
  loadJob,
  saveJob,
  writeTerminalSnapshot,
  writeTreeRecovery,
  type TreeRecoveryMethod
} from "./store";
import { isTerminalStatus, type JobRecord } from "./types";
import { providerTurnUnresolved } from "./provider-turn";

export const HEARTBEAT_MS = 5000;
export const ORPHAN_THRESHOLD_MS = 15000;

export interface ReconcileOptions {
  thresholdMs?: number;
  /** Owner liveness probe (true / false / null=unknown). */
  isAliveFn?: (pid: number) => boolean | null;
  /** Exact owner incarnation probe (tests); production uses Darwin runtime facts. */
  captureOwnerIdentityFn?: typeof captureProcessIdentity;
  /** Platform seam so cross-platform unit tests can pin owner semantics. */
  platform?: NodeJS.Platform;
  /** Child (CLI process tree root) liveness probe (true / false / null=unknown). */
  isChildAliveFn?: (pid: number) => boolean | null;
  /**
   * Returns true ONLY when a persisted, generation-scoped confirmation proves the
   * CrewDispatch-managed and identified processes of the job's recorded child tree
   * stopped (the record's `scope` says exactly which; a dead root alone and the
   * intent file are never confirmation). Absent/undefined means "not confirmed",
   * so a dead root conservatively stays `orphaned`.
   */
  isTreeConfirmedFn?: (job: JobRecord) => boolean;
  now?: () => Date;
}

function parseIsoMs(v: string | null): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function isHeartbeatStale(job: JobRecord, nowMs: number, thresholdMs: number = ORPHAN_THRESHOLD_MS): boolean {
  const beat = parseIsoMs(job.heartbeatAt);
  if (beat == null) return true;
  return nowMs - beat > thresholdMs;
}

/** Is the owning process still alive? true / false / null (unknown). */
export function isOwnerAlive(
  job: JobRecord,
  isAliveFn: (pid: number) => boolean | null = isPidAlive,
  options: { platform?: NodeJS.Platform; captureIdentityFn?: typeof captureProcessIdentity } = {}
): boolean | null {
  const pid = job.ownerPid ?? ownerPidOf(job.owner);
  if (pid == null) return null;
  const alive = isAliveFn(pid);
  if (alive !== true) return alive;

  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return true;
  // A legacy/unpinned Darwin owner with a live same-number PID is UNKNOWN: PID
  // reuse must never be upgraded to proof that the original owner still lives.
  if (job.ownerStartedAtUs == null) return null;
  const identity = (options.captureIdentityFn ?? captureProcessIdentity)(pid);
  if (!identity || identity.createdAtUs == null) return null;
  return identity.createdAtUs === job.ownerStartedAtUs;
}

/**
 * Should this job be reconciled (its owner is provably gone)? Never true for a
 * terminal job, and never true while the owner PID is still alive.
 */
export function shouldReconcile(
  job: JobRecord,
  nowMs: number,
  opts: ReconcileOptions = {}
): boolean {
  if (isTerminalStatus(job.status)) return false;
  // `orphaned` is intentionally NOT re-reconciled: it is already the honest
  // "owner gone, child tree unconfirmed" state and only an explicit cancel may
  // move it forward. This keeps reconciliation idempotent (no repeated writes).
  if (job.status !== "running" && job.status !== "queued") return false;
  if (!isHeartbeatStale(job, nowMs, opts.thresholdMs ?? ORPHAN_THRESHOLD_MS)) return false;
  return isOwnerAlive(job, opts.isAliveFn ?? isPidAlive, {
    platform: opts.platform,
    captureIdentityFn: opts.captureOwnerIdentityFn
  }) === false;
}

/**
 * Pure reconciliation of one job. Returns a NEW record when it changed, or null
 * when the job is left untouched. Terminal jobs and live-owner jobs are never
 * changed.
 *
 * A dead owner with a RESOLVED-STOPPED child tree (no child, or a dead root with
 * a matching generation-scoped confirmation) ends terminal (`interrupted`, or
 * `cancelled` when a cancel intent was recorded). A dead owner whose child tree
 * is still alive, of unknown liveness, or whose root is dead without a matching
 * confirmation becomes the non-terminal `orphaned` state with the child PID
 * preserved — never `cancelled`, never a new generation.
 */
function settleStoppedTreeAfterOwnerLoss(job: JobRecord, at: string): JobRecord {
  const cancelled = job.cancelIntent.requested;
  return {
    ...job,
    status: cancelled ? "cancelled" : "interrupted",
    stopReason: cancelled ? "cancelled" : "owner_lost",
    error: cancelled
      ? job.error
      : job.error ?? "The process that owned this job exited and the CrewDispatch-managed/recognized process tree is confirmed stopped; treated as interrupted and not rerun automatically.",
    failureKind: cancelled ? job.failureKind : job.failureKind ?? "owner_lost",
    finishedAt: at,
    childPid: null,
    childStartedAtUs: null,
    childGeneration: null,
    pendingApproval: null,
    updatedAt: at
  };
}
export function reconcileJob(job: JobRecord, nowMs: number, opts: ReconcileOptions = {}): JobRecord | null {
  if (!shouldReconcile(job, nowMs, opts)) return null;
  const at = (opts.now ? opts.now() : new Date()).toISOString();
  const cancelled = job.cancelIntent.requested;

  if (job.childPid == null) {
    // A provider-owned turn that runs OUTSIDE the (never-recorded) tree must not
    // be settled from tree proof alone: keep it non-terminal so only an explicit
    // cancellation that reaches the provider route may resolve it.
    if (providerTurnUnresolved(job)) return holdForProviderTurn(job, at);
    // No CLI child was ever recorded: a dead owner ends honestly with nothing to
    // prove and no PID to keep. (A queued, never-spawned job takes this path.)
    return {
      ...job,
      status: cancelled ? "cancelled" : "interrupted",
      stopReason: cancelled ? "cancelled" : "owner_lost",
      error: cancelled ? job.error : job.error ?? "The process that owned this job exited and no CLI child process had been started; treated as interrupted and not rerun automatically.",
      failureKind: cancelled ? job.failureKind : job.failureKind ?? "owner_lost",
      finishedAt: at,
      childPid: null,
      childStartedAtUs: null,
      childGeneration: null,
      // The owning provider connection is gone with the owner: no approval can
      // still be pending.
      pendingApproval: null,
      updatedAt: at
    };
  }

  const childAlive = (opts.isChildAliveFn ?? isPidAlive)(job.childPid);
  if (childAlive !== false) {
    // The CLI process tree may still be running (or cannot be probed). Do NOT
    // write a terminal outcome and do NOT drop the PID: keep the evidence so a
    // later explicit cancel can retry the kill.
    return {
      ...job,
      status: "orphaned",
      stopReason: "owner_lost_child_unconfirmed",
      error: "The process that owned this job exited, but the CLI process tree cannot be confirmed exited; the child PID is retained for an explicit cancel retry and the job is not resumed automatically.",
      failureKind: "owner_lost_child_unconfirmed",
      finishedAt: null,
      pendingApproval: null,
      updatedAt: at
    };
  }

  // The ROOT PID is gone. That alone never proves the TREE exited (descendants
  // may have been reparented and survive), so a terminal state needs a matching,
  // generation-scoped confirmation. Without it the honest state is `orphaned`.
  if (!(opts.isTreeConfirmedFn?.(job) ?? false)) {
    return {
      ...job,
      status: "orphaned",
      stopReason: "child_root_dead_tree_unconfirmed",
      error:
        "The process that owned this job exited and the CLI child root PID is gone, but there is no confirmation record proving the CrewDispatch-managed/recognized process tree has stopped; " +
        "the child PID is retained as evidence and the job stays pending (it is not resumed automatically, nor falsely reported as cancelled).",
      failureKind: "child_root_dead_tree_unconfirmed",
      finishedAt: null,
      pendingApproval: null,
      updatedAt: at
    };
  }

  // The managed tree is proven stopped, but a provider-owned turn that runs
  // OUTSIDE that tree with unresolved cleanup must NOT be settled (and must not
  // emit a terminal snapshot/wake): keep it non-terminal with its ownership
  // evidence until an explicit cancellation resolves the provider route.
  if (providerTurnUnresolved(job)) return holdForProviderTurn(job, at);

  return settleStoppedTreeAfterOwnerLoss(job, at);
}

/**
 * The non-terminal hold for a job whose provider-owned out-of-tree turn has not
 * been resolved. The child PID (and generation) are retained as ownership
 * evidence, `finishedAt` stays null, and only an explicit cancellation that
 * reaches the provider route may settle it.
 */
function holdForProviderTurn(job: JobRecord, at: string): JobRecord {
  return {
    ...job,
    status: "orphaned",
    stopReason: "provider_turn_unresolved",
    error:
      "The process that owned this job exited and its CrewDispatch-managed process tree is resolved as stopped, but the provider owns a turn that runs OUTSIDE that tree whose cleanup is not resolved for this generation; " +
      "the job is kept non-terminal and is not resumed automatically — only an explicit cancellation that reaches the provider route may resolve it.",
    failureKind: "provider_turn_unresolved",
    finishedAt: null,
    pendingApproval: null,
    updatedAt: at
  };
}

export interface ReconcileResult {
  changed: JobRecord[];
  scanned: number;
  unreadable: string[];
}

/**
 * Reconcile ONE job against an explicit instant and persist the change, if any.
 *
 * This is the single shared body used by the periodic sweep (`reconcileAll`) and
 * by the exact-workspace guard (`jobs/workspace.ts`), so a workspace held by a
 * provably dead owner is settled by the SAME liveness rules everywhere and can
 * never be freed by a second, weaker decision path.
 *
 * Returns the persisted NEW record when it changed, or null when the job is left
 * untouched (live owner, not reconcilable, or already terminal).
 */
export function reconcileJobAndSave(
  root: string,
  job: JobRecord,
  nowMs: number,
  opts: ReconcileOptions = {}
): JobRecord | null {
  const nowFn = opts.now ?? (() => new Date());
  const isTreeConfirmedFn = opts.isTreeConfirmedFn ?? ((j: JobRecord) => isTreeConfirmed(root, j));
  const next = reconcileJob(job, nowMs, { ...opts, isTreeConfirmedFn });
  if (!next) return null;
  saveJob(root, next, nowFn);
  // Persist the immutable terminal snapshot for a reconciled terminal state, so
  // the entry that observed the sweep can perform the one generation-scoped wake
  // (see deliverTerminalNotification).
  if (isTerminalStatus(next.status)) {
    writeTerminalSnapshot(root, next.id, next.generation, next.status, next.notifyTarget, "reconcile", nowFn);
  }
  return next;
}

/** Reconcile every job under the root; persist only the ones that changed. */
export function reconcileAll(
  root: string,
  opts: ReconcileOptions = {}
): ReconcileResult {
  const nowFn = opts.now ?? (() => new Date());
  const nowMs = nowFn().getTime();
  const { jobs, unreadable } = listJobs(root);
  const changed: JobRecord[] = [];
  for (const job of jobs) {
    const next = reconcileJobAndSave(root, job, nowMs, opts);
    if (next) changed.push(next);
  }
  return { changed, scanned: jobs.length, unreadable };
}

// ---------------------------------------------------------------------------
// Reboot recovery for NON-TERMINAL orphaned jobs
// ---------------------------------------------------------------------------

export interface OrphanedBootRecoveryOptions {
  now?: () => Date;
  by?: string;
  readBootTimeFn?: () => Promise<BootTimeReading>;
  includeJob?: (job: JobRecord) => boolean;
}

export interface OrphanedBootRecoveryItem {
  jobId: string;
  generation: number;
  childPid: number;
  outcome: "changed" | "blocked" | "skipped";
  reason: string | null;
}

export interface OrphanedBootRecoveryReport {
  candidates: number;
  changed: JobRecord[];
  blocked: OrphanedBootRecoveryItem[];
  skipped: OrphanedBootRecoveryItem[];
}

/**
 * Settle an orphaned job ONLY when the current OS boot strictly postdates the
 * latest attempt start of its retained child generation.
 *
 * This is stronger than any process snapshot: no local process survives a
 * reboot, so a current process reusing the old PID is unrelated and is never
 * signalled. The transition is serialized by the normal job transition lock and
 * revalidates the exact job/generation/child binding before writing.
 *
 * Provider-owned out-of-tree work remains fail-closed: reboot proof settles the
 * managed tree, but does not fabricate provider cancellation evidence.
 */
export async function recoverOrphanedAfterBoot(
  root: string,
  opts: OrphanedBootRecoveryOptions = {}
): Promise<OrphanedBootRecoveryReport> {
  const nowFn = opts.now ?? (() => new Date());
  const by = typeof opts.by === "string" && opts.by.trim() ? opts.by.trim() : "reboot-recovery";
  const candidates = listJobs(root).jobs.filter(
    (job) =>
      job.status === "orphaned" &&
      job.childPid != null &&
      (opts.includeJob ? opts.includeJob(job) : true)
  );
  const report: OrphanedBootRecoveryReport = {
    candidates: candidates.length,
    changed: [],
    blocked: [],
    skipped: []
  };
  if (candidates.length === 0) return report;

  let boot: BootTimeReading;
  try {
    boot = await (opts.readBootTimeFn ?? readBootTime)();
  } catch (e) {
    boot = {
      ok: false,
      bootTimeMs: null,
      reason: `boot_time_probe_failed: ${String((e as Error)?.message || e).slice(0, 200)}`
    };
  }

  for (const job of candidates) {
    const generation = job.childGeneration ?? job.generation;
    const childPid = job.childPid as number;
    const base = { jobId: job.id, generation, childPid };
    const proof = bootProofFor(job, generation, boot);
    if (!proof.ok) {
      report.blocked.push({ ...base, outcome: "blocked", reason: proof.reason });
      continue;
    }
    if (providerTurnUnresolved(job)) {
      report.blocked.push({ ...base, outcome: "blocked", reason: "provider_turn_unresolved" });
      continue;
    }

    const release = acquireJobTransitionLock(root, job.id);
    if (!release) {
      report.blocked.push({ ...base, outcome: "blocked", reason: "job_transition_busy" });
      continue;
    }
    try {
      let current: JobRecord | null;
      try {
        current = loadJob(root, job.id);
      } catch {
        current = null;
      }
      if (
        !current ||
        current.status !== "orphaned" ||
        current.generation !== job.generation ||
        current.childPid !== childPid ||
        (current.childGeneration ?? current.generation) !== generation
      ) {
        report.skipped.push({ ...base, outcome: "skipped", reason: "identity_changed" });
        continue;
      }
      if (providerTurnUnresolved(current)) {
        report.blocked.push({ ...base, outcome: "blocked", reason: "provider_turn_unresolved" });
        continue;
      }
      const currentProof = bootProofFor(current, generation, boot);
      if (!currentProof.ok) {
        report.blocked.push({ ...base, outcome: "blocked", reason: currentProof.reason });
        continue;
      }
      const startedAtMs = latestAttemptStartedAtMs(current, generation);
      if (startedAtMs == null || boot.bootTimeMs == null) {
        report.blocked.push({ ...base, outcome: "blocked", reason: "boot_time_unknown" });
        continue;
      }

      writeTreeRecovery(
        root,
        current.id,
        generation,
        childPid,
        {
          method: "boot_session_cleared",
          by,
          bootAtMs: boot.bootTimeMs,
          generationStartedAtMs: startedAtMs,
          survivingPids: []
        },
        nowFn
      );

      const at = nowFn().toISOString();
      const next = settleStoppedTreeAfterOwnerLoss(current, at);
      saveJob(root, next, nowFn);
      writeTerminalSnapshot(root, next.id, next.generation, next.status, next.notifyTarget, "reconcile", nowFn);
      report.changed.push(next);
    } finally {
      release();
    }
  }

  return report;
}
// ---------------------------------------------------------------------------
// Passive recovery for TERMINAL workspace holders (JQ-20261004-50)
//
// A terminal record may retain `childPid`/`childGeneration` as evidence when
// its managed tree could not be PROVEN stopped at finalize time. That record
// keeps holding its exact workspace (see jobs/workspace.ts) until a later
// generation-scoped confirmation exists — and the only remaining path used to
// be a continuation of that SAME job, so a genuinely finished task whose tree
// has since exited could block an INDEPENDENT new dispatch forever.
//
// This is the bounded, NON-DESTRUCTIVE revalidation that closes that gap. It is
// shared (the daemon sweep and daemon admission both call it) and it NEVER
// signals a process, kills a tree, resumes work, rewrites the job record, sends
// a terminal notification or changes a generation/result/message/usage. When it
// can PROVE the retained managed tree stopped it persists separate, validated,
// generation-bound evidence under `<root>/tree/<id>.recovery.json`; the job
// record itself stays byte-identical.
//
// Two proofs, in strength order:
//
//   1. `boot_session_cleared` — the current OS boot provably postdates the
//      LATEST recorded attempt start of that generation (the spawn the retained
//      child belongs to). No process survives a reboot, so the tree is gone even
//      if its old PID is now reused by an unrelated process. This is the
//      reliable proof for a historical holder recorded before the current boot.
//   2. `descendant_snapshot` — the recorded root PID is provably gone and one
//      bounded OS process-table enumeration, scoped to `root PID + generation
//      start time`, finds no live descendant (the same bounded negative
//      observation the existing old-tree check uses; the provider-managed
//      shared sidecar is excluded by the caller's `ignoredPidsFor`).
//
// Anything else stays a blocker, honestly: a live or unknown root, a live or
// unidentifiable descendant, a failed/unsupported enumeration, an unknown
// generation start or an unreadable boot instant. A dead root alone, elapsed
// age or a fabricated/absent proof never releases.
// ---------------------------------------------------------------------------

/** The generation start time recorded for one attempt, as epoch ms (null when unknown). */
export function attemptStartedAtMs(job: JobRecord, generation: number | null): number | null {
  if (generation == null) return null;
  const attempt = job.attempts.find((a) => a.generation === generation);
  if (!attempt || !attempt.startedAt) return null;
  const t = Date.parse(attempt.startedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * The LATEST recorded attempt start of a generation, epoch ms.
 *
 * A worker restart keeps the same generation and appends a NEW attempt whose
 * spawn overwrites `childPid`; the retained child therefore belongs to the
 * LAST attempt of that generation, and only a boot that postdates it can prove
 * the tree is gone. Using an earlier attempt would falsely release a tree
 * spawned after the boot by a restarted worker.
 */
function latestAttemptStartedAtMs(job: JobRecord, generation: number | null): number | null {
  if (generation == null) return null;
  let latest: number | null = null;
  for (const attempt of job.attempts) {
    if (attempt.generation !== generation || !attempt.startedAt) continue;
    const t = Date.parse(attempt.startedAt);
    if (Number.isFinite(t) && (latest == null || t > latest)) latest = t;
  }
  return latest;
}

export interface TerminalHolderRecoveryOptions {
  now?: () => Date;
  /** Platform seam; production defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Recorded origin of an evidence write (diagnostic only, never a secret). */
  by?: string;
  /** Child (CLI process tree root) liveness probe. */
  isChildAliveFn?: (pid: number) => boolean | null;
  /** Process-table enumeration used for the descendant snapshot. */
  enumerateFn?: EnumerateProcesses;
  /** OS boot-time probe (defaults to the real public-OS read). */
  readBootTimeFn?: () => Promise<BootTimeReading>;
  /**
   * Provider-managed daemon PIDs that are intentionally outside the job's
   * disposable CLI tree (for example the persistent WorkBuddy sidecar); they
   * are excluded from the descendant snapshot exactly like the old-tree check.
   */
  ignoredPidsFor?: (job: JobRecord) => ReadonlySet<number>;
  /**
   * Restrict recovery to the records a caller cares about (the daemon
   * admission path passes the requested workspace; the sweep passes none).
   */
  includeJob?: (job: JobRecord) => boolean;
}

export interface TerminalHolderRecoveryOutcome {
  jobId: string;
  generation: number;
  childPid: number;
  outcome: "released" | "blocked" | "skipped";
  method: TreeRecoveryMethod | null;
  reason: string | null;
}

export interface TerminalHolderRecoveryReport {
  /** Terminal records that retained unresolved child evidence at call time. */
  candidates: number;
  released: TerminalHolderRecoveryOutcome[];
  blocked: TerminalHolderRecoveryOutcome[];
  skipped: TerminalHolderRecoveryOutcome[];
}

interface BootProofDecision {
  ok: boolean;
  reason: string | null;
}

/**
 * Does the current boot prove the recorded child tree is gone?
 *
 * The retained child was spawned at/after the LATEST attempt start of its
 * generation (a worker restart keeps the generation and replaces `childPid`).
 * A boot instant strictly after that start means the child — and every
 * descendant it could ever create — was created in a previous boot session,
 * and no process survives a reboot. A process currently holding the old PID
 * therefore belongs to the current session (a different incarnation, never
 * ours). An unknown/unsupported boot reading, an unknown latest attempt start
 * or a boot instant that does not postdate it is NOT proof.
 */
function bootProofFor(
  job: JobRecord,
  generation: number,
  boot: BootTimeReading
): BootProofDecision {
  if (!boot.ok || boot.bootTimeMs == null) return { ok: false, reason: boot.reason ?? "boot_time_unknown" };
  const latestStartMs = latestAttemptStartedAtMs(job, generation);
  if (latestStartMs == null) return { ok: false, reason: "no_generation_start" };
  if (!(boot.bootTimeMs > latestStartMs)) return { ok: false, reason: "boot_not_after_generation" };
  return { ok: true, reason: null };
}

/**
 * Persist validated recovery evidence, but ONLY when the durable record still
 * matches the exact identity this proof was computed for. The same job
 * transition lock a continuation takes serializes the re-read + write, so a
 * generation bump or a new/cleared child can never be approved by late
 * evidence; a contended or unreadable record fails closed (no write).
 */
function persistRecoveryEvidence(
  root: string,
  job: JobRecord,
  generation: number,
  childPid: number,
  evidence: {
    method: TreeRecoveryMethod;
    bootAtMs: number | null;
    generationStartedAtMs: number | null;
    survivingPids: readonly number[];
  },
  by: string,
  nowFn: () => Date
): TerminalHolderRecoveryOutcome {
  const base = { jobId: job.id, generation, childPid };
  const release = acquireJobTransitionLock(root, job.id);
  if (!release) return { ...base, outcome: "blocked", method: null, reason: "job_transition_busy" };
  try {
    let current: JobRecord | null;
    try {
      current = loadJob(root, job.id);
    } catch {
      return { ...base, outcome: "blocked", method: null, reason: "record_unreadable" };
    }
    if (
      !current ||
      !isTerminalStatus(current.status) ||
      current.generation !== job.generation ||
      current.childPid !== childPid ||
      (current.childGeneration ?? current.generation) !== generation
    ) {
      return { ...base, outcome: "skipped", method: null, reason: "identity_changed" };
    }
    writeTreeRecovery(root, job.id, generation, childPid, { ...evidence, by }, nowFn);
    return { ...base, outcome: "released", method: evidence.method, reason: null };
  } finally {
    release();
  }
}

async function revalidateTerminalHolder(
  root: string,
  job: JobRecord,
  generation: number,
  childPid: number,
  startedAtMs: number | null,
  boot: BootTimeReading,
  alive: (pid: number) => boolean | null,
  scanOnce: () => Promise<ProcessScan>,
  by: string,
  nowFn: () => Date,
  opts: TerminalHolderRecoveryOptions
): Promise<TerminalHolderRecoveryOutcome> {
  const base = { jobId: job.id, generation, childPid };
  const blocked = (reason: string): TerminalHolderRecoveryOutcome => ({ ...base, outcome: "blocked", method: null, reason });

  // 1) The strongest proof: the current OS boot postdates the retained child's
  // spawn (the latest attempt start of this generation).
  const bootProof = bootProofFor(job, generation, boot);
  if (bootProof.ok) {
    return persistRecoveryEvidence(
      root,
      job,
      generation,
      childPid,
      {
        method: "boot_session_cleared",
        bootAtMs: boot.bootTimeMs,
        generationStartedAtMs: latestAttemptStartedAtMs(job, generation),
        survivingPids: []
      },
      by,
      nowFn
    );
  }

  // Darwin reparents descendants when the recorded root exits. Once the root is
  // gone, a negative PPID snapshot cannot prove an escaped/reparented descendant
  // does not still exist. Only the stronger reboot proof above may passively
  // release a dead-root Darwin holder.
  if ((opts.platform ?? process.platform) === "darwin") {
    return blocked("darwin_dead_root_unconfirmed");
  }

  // 2) A live or unknowable root keeps the workspace, exactly as before.
  let childAlive: boolean | null;
  try {
    childAlive = alive(childPid);
  } catch {
    childAlive = null;
  }
  if (childAlive !== false) return blocked(childAlive === true ? "child_alive" : "child_liveness_unknown");

  // 3) The root is gone: one bounded descendant snapshot, scoped to the
  // generation start so a reused pid's unrelated children are never ours.
  if (startedAtMs == null) return blocked("no_generation_start");
  let scanResult: ProcessScan;
  try {
    scanResult = await scanOnce();
  } catch (e) {
    return blocked(`enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}`);
  }
  if (!scanResult.ok) return blocked(scanResult.reason ?? "enumeration_failed");
  const found = findDescendants(
    scanResult.processes,
    childPid,
    startedAtMs - DESCENDANT_CLOCK_TOLERANCE_MS,
    opts.ignoredPidsFor?.(job)
  );
  if (found.unknown) return blocked("descendant_identity_unknown");
  const live: number[] = [];
  for (const pid of found.pids) {
    if (alive(pid) !== false) live.push(pid);
  }
  if (live.length > 0) return blocked("descendants_alive");

  return persistRecoveryEvidence(
    root,
    job,
    generation,
    childPid,
    { method: "descendant_snapshot", bootAtMs: null, generationStartedAtMs: startedAtMs, survivingPids: [] },
    by,
    nowFn
  );
}

/**
 * Bounded, non-destructive recovery for terminal records that retain an
 * unresolved managed child tree. It reads at most ONE OS boot instant and
 * performs at most ONE process-table enumeration per call (shared by every
 * candidate), and it never signals a process.
 *
 * A terminal record that already has valid recovery evidence is not a
 * candidate, so repeated calls are idempotent and cost nothing once the release
 * is proven. A record with a legacy `TreeConfirmation` IS still revalidated: the
 * confirmation only proves the tree stopped at the time it was written, so if
 * its old PID is now held by an unrelated live process (PID reuse) it would
 * otherwise block the workspace forever. Revalidation can only ADD evidence
 * when an independent proof holds; otherwise the holder stays blocked exactly as
 * before.
 */
export async function recoverTerminalHolders(
  root: string,
  opts: TerminalHolderRecoveryOptions = {}
): Promise<TerminalHolderRecoveryReport> {
  const nowFn = opts.now ?? (() => new Date());
  const by = typeof opts.by === "string" && opts.by.trim() ? opts.by.trim() : "recovery";
  const candidates = listJobs(root).jobs.filter(
    (job) =>
      isTerminalStatus(job.status) &&
      job.childPid != null &&
      !isTreeRecoveryConfirmed(root, job) &&
      (opts.includeJob ? opts.includeJob(job) : true)
  );
  const report: TerminalHolderRecoveryReport = { candidates: candidates.length, released: [], blocked: [], skipped: [] };
  if (candidates.length === 0) return report;

  const alive = opts.isChildAliveFn ?? isPidAlive;
  const readBoot = opts.readBootTimeFn ?? readBootTime;
  let boot: BootTimeReading;
  try {
    boot = await readBoot();
  } catch (e) {
    boot = { ok: false, bootTimeMs: null, reason: `boot_time_probe_failed: ${String((e as Error)?.message || e).slice(0, 200)}` };
  }
  // Lazily started: a boot-proven or live-child holder never pays for it. A
  // single Windows candidate uses the targeted PPID walk; multiple candidates
  // still share one coherent full snapshot, preserving the one-scan bound.
  let scan: Promise<ProcessScan> | null = null;
  const sharedScan = (): Promise<ProcessScan> => (scan ??= (opts.enumerateFn ?? enumerateProcesses)());
  const scanFor = (childPid: number): Promise<ProcessScan> => {
    if (opts.enumerateFn) return sharedScan();
    if ((opts.platform ?? process.platform) === "win32" && process.platform === "win32" && candidates.length === 1) {
      return enumerateDescendantProcesses(childPid);
    }
    return sharedScan();
  };

  for (const job of candidates) {
    const generation = job.childGeneration ?? job.generation;
    const childPid = job.childPid as number;
    const outcome = await revalidateTerminalHolder(
      root,
      job,
      generation,
      childPid,
      attemptStartedAtMs(job, generation),
      boot,
      alive,
      () => scanFor(childPid),
      by,
      nowFn,
      opts
    );
    if (outcome.outcome === "released") report.released.push(outcome);
    else if (outcome.outcome === "skipped") report.skipped.push(outcome);
    else report.blocked.push(outcome);
  }
  return report;
}
