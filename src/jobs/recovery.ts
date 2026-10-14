// recovery.ts — the bounded, host-neutral RECOVERY pass for local caller
// notifications whose ORIGINAL attempt provably never began writing.
//
// WHY this exists: a Claude-owned job can reach a terminal state while the
// conversation is CLOSED. The original wake is then truthfully recorded as
// failed (`inbox_unreachable`, phase `not_written`), and reopening the SAME
// session registers a NEW private binding — which by itself never replays the
// lost notice. This module replays it ONCE, under a strict, provable bound.
//
// What this module is NOT:
//   * it is not a retry loop, timer, poller or resident sidecar. It runs ONE
//     finite pass, only when a VERIFIED local caller registration asks for it
//     through the authenticated daemon (or a test drives it directly);
//   * it never resumes/retries a job, never creates a worker, never advances a
//     generation and never changes permissions;
//   * it never claims exactly-once HOST delivery. The wire has no
//     acknowledgement, so a recovered send can still be lost, and a claim is
//     never rolled back after a send may have happened.
//
// Eligibility (shared, host-neutral; only Claude targets can be recovered in
// this increment):
//   * the job is CURRENTLY terminal on its CURRENT generation, and its
//     persisted target is a `claude_session` target that can be tied to the
//     EXACT session of the verified registration. A target that cannot be tied
//     to that session (a foreign session, or a binding-only reference whose
//     record is gone) fails closed;
//   * the ORIGINAL attempt for that exact event exists and PROVES no write:
//     `delivered === false` AND `phase === "not_written"`. A successful
//     original, a `writing_started`/uncertain outcome, a missing phase (an old
//     record, a crash, or a transport that cannot prove a phase) and a missing
//     original attempt are all INELIGIBLE — recovery never infers eligibility
//     from `delivered:false` or from message text;
//   * no per-generation terminal result-read receipt exists (the result was not
//     already collected through the real MCP result entry);
//   * the exact recovery identity `(job, generation, event)` — approvals
//     additionally the request id — has not consumed its ONE additional
//     attempt. An incomplete/crashed claim consumes the allowance
//     conservatively (the exclusive claim file is the durable budget).
//
// Delivery: every send goes through the SHARED notification layer and the
// production transport adapter, to the CURRENT private binding of the exact
// session (never the stale one the job was originally bound to). The recovered
// terminal text names the job AND the run and asks for the result ONLY
// conditionally; the approval text reuses the original approval wake text
// (the human still decides in the Dashboard — there is no auto-approval).
import { isValidClaudeBindingId, isValidClaudeSessionId } from "../claude/ids";
import { readClaudeBindingFile, resolveClaudeBinding } from "../claude/binding";
import {
  buildApprovalRequiredEvent,
  deliverNotificationEvent,
  revalidatePendingApproval,
  resolveProvenApprovalHub,
  type DeliveryDeps,
  type TerminalRecoveredNotificationEvent
} from "./notifications";
import {
  claimApprovalRecoveryAttempt,
  claimTerminalRecoveryAttempt,
  listJobs,
  loadJob,
  readApprovalNotificationResults,
  readApprovalRecoveryResult,
  readNotificationResult,
  readTerminalReadReceipt,
  readTerminalRecoveryResult,
  writeApprovalRecoveryResult,
  writeTerminalRecoveryResult
} from "./store";
import { isTerminalStatus, type ApprovalNotificationRecord, type JobRecord, type NotifyTarget } from "./types";

/**
 * Hard bound on the CANDIDATES one recovery pass may consider: the NEWEST jobs
 * of the data root (by creation time), never an unbounded sweep. Every
 * candidate is then filtered by the exact-session target rule.
 *
 * This is a candidate/delivery cap, NOT a read bound: the store enumerates the
 * job directory and reads every job file to order them by creation time, and
 * only then is the newest slice taken. It is therefore also "newest 100 of ALL
 * jobs", not "newest 100 matching" — a data root whose newest hundred jobs all
 * belong to other sessions simply yields no candidates.
 */
export const RECOVERY_MAX_JOBS_PER_PASS = 100;

/** The persisted origin of a daemon-driven recovery attempt. */
export const CLAUDE_SESSION_START_ORIGIN = "claude-session-start";

export interface RecoveryPassOptions {
  /** The EXACT session of the verified registration (never cwd/title/most recent chat). */
  sessionId: string;
  /** The registration's opaque binding reference; it must still be current. */
  bindingId: string;
  /** Recorded origin of the recovery attempts; defaults to the SessionStart origin. */
  by?: string;
  /** Delivery seams (timeout, socket connect, hub proof, clock) for tests. */
  deps?: DeliveryDeps;
  /** Test-only override of the job scan bound (never above the hard cap). */
  maxJobs?: number;
}

/** One claimed recovery event and its durable outcome. */
export interface RecoveryAttemptRecord {
  jobId: string;
  event: "terminal" | "approval_required";
  generation: number;
  /** The approval request id, or null for a terminal event. */
  requestId: string | null;
  /** True only when the recovery transport reported its own successful handoff. */
  delivered: boolean;
  /** Stable outcome/suppression code; null only on a successful handoff. */
  reason: string | null;
}

export interface RecoveryPassSummary {
  /** How many recent jobs the pass examined. */
  scanned: number;
  /** How many of them carry a target tied to the exact session. */
  matching: number;
  /** Every CLAIMED event (sent or suppressed after the claim), in order. */
  attempts: RecoveryAttemptRecord[];
}

/**
 * The exact session a persisted target is tied to, or null when it cannot be
 * proven. A `claude_session` target is tied by its opaque session reference, or
 * — when only a binding reference is persisted — by the session recorded in
 * that binding's own file. A binding-only reference whose file is gone (for
 * example because a later registration replaced it) CANNOT be tied and returns
 * null: recovery then fails closed instead of guessing.
 */
export function targetSessionId(root: string, target: NotifyTarget): string | null {
  if (target.kind !== "claude_session") return null;
  if (isValidClaudeSessionId(target.claudeSessionId)) return target.claudeSessionId;
  if (isValidClaudeBindingId(target.claudeBindingId)) {
    const binding = readClaudeBindingFile(root, target.claudeBindingId);
    return binding ? binding.sessionId : null;
  }
  return null;
}

export type TerminalRecoveryVerdict =
  | { eligible: true; generation: number; status: string }
  | { eligible: false; reason: string };

/**
 * Evaluate ONE job against the terminal-recovery rules. Pure and side-effect
 * free; it is called TWICE for every claimed event — once before the claim and
 * once on a FRESH record read immediately before the transport call — because
 * the job can advance (a continuation), be collected (a result read), or lose
 * its exact target between those moments.
 */
export function terminalRecoveryVerdict(root: string, job: JobRecord, sessionId: string): TerminalRecoveryVerdict {
  if (!isTerminalStatus(job.status)) return { eligible: false, reason: "not_terminal" };
  if (job.notifyTarget.kind !== "claude_session") return { eligible: false, reason: "not_claude_target" };
  const tied = targetSessionId(root, job.notifyTarget);
  if (tied === null) return { eligible: false, reason: "target_session_unresolved" };
  if (tied !== sessionId) return { eligible: false, reason: "target_session_mismatch" };
  const generation = job.generation;
  const original = readNotificationResult(root, job.id, generation);
  if (!original) return { eligible: false, reason: "no_original_attempt" };
  if (original.delivered) return { eligible: false, reason: "original_delivered" };
  // Only a PROVEN no-write original is recoverable. A null phase is an older
  // record / a crash / a transport without phase evidence — UNKNOWN, and
  // unknown is never eligible.
  if (original.phase !== "not_written") {
    return { eligible: false, reason: original.phase == null ? "original_phase_unknown" : "original_write_started" };
  }
  if (readTerminalRecoveryResult(root, job.id, generation)) return { eligible: false, reason: "already_recovered" };
  if (readTerminalReadReceipt(root, job.id, generation)) return { eligible: false, reason: "already_collected" };
  return { eligible: true, generation, status: job.status };
}

/**
 * The AUTHORITATIVE current registration of the verified session, or null when
 * the supplied registration is not it.
 *
 * This deliberately resolves the session's CURRENT binding (the newest valid
 * record of that session id) and then compares it with the expected id, instead
 * of resolving the requested id directly. `resolveClaudeBinding` returns the
 * direct record whenever that file still exists, which does NOT prove it is the
 * latest incarnation: overlapping registration/cleanup can leave an older
 * binding file behind for a moment, and admitting that leftover would let a
 * stale request send to (and spend the budget of) a superseded incarnation.
 *
 * Ordinary delivery keeps using `resolveClaudeBinding` unchanged — this stricter
 * rule exists only for recovery admission/eligibility.
 */
function currentRegistration(root: string, opts: RecoveryPassOptions): { bindingId: string } | null {
  const current = resolveClaudeBinding(root, { sessionId: opts.sessionId });
  if (!current || current.bindingId !== opts.bindingId || current.sessionId !== opts.sessionId) return null;
  return { bindingId: current.bindingId };
}

/**
 * The in-memory delivery target of a recovery send: the CURRENT binding of the
 * exact session that asked for recovery. The native address/token are resolved
 * from the private store by the transport, never from here.
 */
function recoveryTarget(sessionId: string, bindingId: string): NotifyTarget {
  return {
    kind: "claude_session",
    callbackUrl: null,
    codexThreadId: null,
    claudeSessionId: sessionId,
    claudeBindingId: bindingId,
    source: "claude_session_id"
  };
}

/**
 * Run ONE finite recovery pass for one verified Claude registration.
 *
 * The pass never throws and never waits on anything long-lived: it considers at
 * most `RECOVERY_MAX_JOBS_PER_PASS` newest CANDIDATES (the store still
 * enumerates and reads every job file to order them — see the constant), and
 * every claimed send is bounded by the transport's own timeout. Durable
 * exclusive claims remain the cross-process authority — two concurrent passes
 * (even in two processes) can never both send the same event.
 */
export async function runRecoveryPass(root: string, opts: RecoveryPassOptions): Promise<RecoveryPassSummary> {
  const summary: RecoveryPassSummary = { scanned: 0, matching: 0, attempts: [] };
  if (!isValidClaudeSessionId(opts.sessionId) || !isValidClaudeBindingId(opts.bindingId)) return summary;
  // The registration that asked must STILL be the current one: a stale request
  // may never claim or send on behalf of a newer binding's budget.
  if (!currentRegistration(root, opts)) return summary;

  const deps: DeliveryDeps = opts.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const origin = typeof opts.by === "string" && opts.by.trim() ? opts.by.trim() : CLAUDE_SESSION_START_ORIGIN;
  const cap = Math.min(
    RECOVERY_MAX_JOBS_PER_PASS,
    Number.isInteger(opts.maxJobs) && (opts.maxJobs as number) > 0 ? (opts.maxJobs as number) : RECOVERY_MAX_JOBS_PER_PASS
  );

  let jobs: JobRecord[];
  try {
    jobs = listJobs(root).jobs.slice(-cap);
  } catch {
    return summary;
  }
  summary.scanned = jobs.length;

  for (const job of jobs) {
    // ONE unreadable/malformed candidate can never stop the bounded pass.
    try {
      if (targetSessionId(root, job.notifyTarget) !== opts.sessionId) continue;
      summary.matching += 1;
      // A registration that stopped being current mid-pass (this session was
      // rebound, e.g. by a concurrent hook) must STOP here: it may not spend a
      // LATER event's single allowance.
      if (!currentRegistration(root, opts)) break;
      // Fresh read of the exact candidate before any claim: the scanned record
      // may already be stale.
      let candidate: JobRecord | null = null;
      try {
        candidate = loadJob(root, job.id);
      } catch {
        candidate = null;
      }
      if (!candidate) continue;
      const terminal = await recoverTerminalEvent(root, candidate, opts, deps, now, origin);
      if (terminal) summary.attempts.push(terminal);
      summary.attempts.push(...(await recoverApprovalEvents(root, candidate, opts, deps, now, origin)));
      // Same rule after each candidate's events: a send can yield, and the
      // session may have rebound in that window.
      if (!currentRegistration(root, opts)) break;
    } catch {
      /* fail closed for this candidate only */
    }
  }
  return summary;
}

/** Persist one terminal recovery outcome; the diagnostic write is best-effort. */
function persistTerminalRecovery(
  root: string,
  jobId: string,
  generation: number,
  origin: string,
  now: () => Date,
  delivered: boolean,
  reason: string | null
): RecoveryAttemptRecord {
  const record: RecoveryAttemptRecord = { jobId, event: "terminal", generation, requestId: null, delivered, reason };
  try {
    writeTerminalRecoveryResult(
      root,
      jobId,
      generation,
      { event: "terminal", generation, requestId: null, attemptedAt: now().toISOString(), delivered, reason, by: origin },
      now
    );
  } catch {
    /* the outcome is a diagnostic; the claim stays consumed either way */
  }
  return record;
}

/** Persist one approval recovery outcome; the diagnostic write is best-effort. */
function persistApprovalRecovery(
  root: string,
  jobId: string,
  generation: number,
  requestId: string,
  origin: string,
  now: () => Date,
  delivered: boolean,
  reason: string | null
): RecoveryAttemptRecord {
  const record: RecoveryAttemptRecord = { jobId, event: "approval_required", generation, requestId, delivered, reason };
  try {
    writeApprovalRecoveryResult(
      root,
      jobId,
      generation,
      { event: "approval_required", generation, requestId, attemptedAt: now().toISOString(), delivered, reason, by: origin },
      now
    );
  } catch {
    /* the outcome is a diagnostic; the claim stays consumed either way */
  }
  return record;
}

/**
 * Recover ONE terminal event: pre-claim eligibility → exclusive claim →
 * fresh-state re-check immediately before the transport call → ONE bounded
 * send. Every path after the claim records its outcome durably; no path rolls
 * the claim back, because the send may already have happened.
 */
async function recoverTerminalEvent(
  root: string,
  job: JobRecord,
  opts: RecoveryPassOptions,
  deps: DeliveryDeps,
  now: () => Date,
  origin: string
): Promise<RecoveryAttemptRecord | null> {
  const pre = terminalRecoveryVerdict(root, job, opts.sessionId);
  if (!pre.eligible) return null;
  const jobId = job.id;
  const generation = pre.generation;

  // The CURRENT authoritative registration must hold immediately BEFORE the
  // claim. Checking only at pass start lets a pass that has already gone stale
  // (a rebound session) consume a LATER event's only allowance.
  if (!currentRegistration(root, opts)) return null;

  let claimed = false;
  try {
    claimed = claimTerminalRecoveryAttempt(root, jobId, generation);
  } catch {
    return null;
  }
  // Already claimed (including by a crashed/incomplete pass): the allowance is
  // consumed conservatively — never reopened, never retried.
  if (!claimed) return null;

  // Re-read the durable state IMMEDIATELY before the transport call: the job
  // must still be terminal on this exact generation with the exact target, no
  // original success/unknown outcome, no result-read receipt and no completed
  // recovery.
  let fresh: JobRecord | null = null;
  try {
    fresh = loadJob(root, jobId);
  } catch {
    fresh = null;
  }
  if (!fresh) return persistTerminalRecovery(root, jobId, generation, origin, now, false, "stale");
  const final = terminalRecoveryVerdict(root, fresh, opts.sessionId);
  if (!final.eligible) return persistTerminalRecovery(root, jobId, generation, origin, now, false, final.reason);
  // A continuation may have advanced the record while the pass ran: the claimed
  // event's generation must still be the CURRENT one, or the allowance would be
  // spent on a different event than the one it belongs to.
  if (final.generation !== generation) return persistTerminalRecovery(root, jobId, generation, origin, now, false, "stale");
  // The registration must STILL be the current one immediately before the
  // transport call: the fresh re-read above was itself followed by awaits.
  if (!currentRegistration(root, opts)) return persistTerminalRecovery(root, jobId, generation, origin, now, false, "binding_not_current");
  // The conditional text is the LAST line of defence: if a result read landed
  // after the verdict above, the notice must still never ask for a result that
  // was already collected.
  const collected = readTerminalReadReceipt(root, jobId, generation) != null;
  if (collected) return persistTerminalRecovery(root, jobId, generation, origin, now, false, "already_collected");

  const event: TerminalRecoveredNotificationEvent = {
    event: "terminal_recovered",
    jobId,
    generation,
    status: final.status,
    collected: false
  };
  const outcome = await deliverNotificationEvent(event, recoveryTarget(opts.sessionId, opts.bindingId), { ...deps, root });
  return persistTerminalRecovery(root, jobId, generation, origin, now, outcome.delivered, outcome.reason);
}

/**
 * Recover the approvals of ONE job. Only an original attempt that provably
 * never began writing is eligible, and the CURRENT validator of
 * src/jobs/notifications.ts decides whether the exact `(generation, request)`
 * is still a live pending approval (running generation, unexpired, unresolved,
 * not cancelled). It runs once before the claim and again immediately before
 * the transport call — after the awaited Hub proof, exactly like the original
 * approval-wake path.
 */
async function recoverApprovalEvents(
  root: string,
  job: JobRecord,
  opts: RecoveryPassOptions,
  deps: DeliveryDeps,
  now: () => Date,
  origin: string
): Promise<RecoveryAttemptRecord[]> {
  const out: RecoveryAttemptRecord[] = [];
  let results: ApprovalNotificationRecord[];
  try {
    results = readApprovalNotificationResults(root, job.id);
  } catch {
    return out;
  }
  for (const rec of results) {
    if (rec.delivered) continue;
    // Only a PROVEN no-write original is recoverable (same rule as terminal).
    if (rec.phase !== "not_written") continue;
    if (rec.generation !== job.generation) continue;
    if (readApprovalRecoveryResult(root, job.id, rec.generation, rec.requestId)) continue;

    const pre = revalidatePendingApproval(root, job.id, rec.generation, rec.requestId, now().getTime());
    if (!pre.ok) continue;

    // The CURRENT authoritative registration must hold immediately BEFORE the
    // claim, so a stale pass never spends this approval event's allowance.
    if (!currentRegistration(root, opts)) break;

    let claimed = false;
    try {
      claimed = claimApprovalRecoveryAttempt(root, job.id, rec.generation, rec.requestId);
    } catch {
      continue;
    }
    if (!claimed) continue;

    // The Hub link must be PROVEN live (same proof as the original wake); a
    // hardcoded port or a dead marker never produces a link nobody can use.
    const hubUrl = await resolveProvenApprovalHub(root, deps);
    if (!hubUrl) {
      out.push(persistApprovalRecovery(root, job.id, rec.generation, rec.requestId, origin, now, false, "no_hub"));
      continue;
    }
    // The registration must STILL be current AFTER that awaited proof and
    // immediately before the send: the session can rebind while we wait.
    if (!currentRegistration(root, opts)) {
      out.push(persistApprovalRecovery(root, job.id, rec.generation, rec.requestId, origin, now, false, "binding_not_current"));
      continue;
    }
    // The proof was AWAITED: revalidate the exact identity (and the exact
    // target/session of THIS record read) immediately before the send.
    const current = revalidatePendingApproval(root, job.id, rec.generation, rec.requestId, now().getTime());
    if (!current.ok) {
      out.push(persistApprovalRecovery(root, job.id, rec.generation, rec.requestId, origin, now, false, current.reason));
      continue;
    }
    if (targetSessionId(root, current.state.target) !== opts.sessionId) {
      out.push(persistApprovalRecovery(root, job.id, rec.generation, rec.requestId, origin, now, false, "target_session_mismatch"));
      continue;
    }
    const event = buildApprovalRequiredEvent(hubUrl, current.state.pending);
    const outcome = await deliverNotificationEvent(event, recoveryTarget(opts.sessionId, opts.bindingId), { ...deps, root });
    out.push(persistApprovalRecovery(root, job.id, rec.generation, rec.requestId, origin, now, outcome.delivered, outcome.reason));
  }
  return out;
}
