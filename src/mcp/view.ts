// view.ts — bounded, field-WHITELISTED views returned through the MCP tools.
//
// Every value a caller can see is constructed here, never by spreading a raw job
// record. What is deliberately EXCLUDED: the task text, the raw CLI transcript /
// log path, the provider session id, owner/heartbeat internals, the working
// directory and any credential. Unreported usage stays `null` (never `0`).
//
// Text fields are length-capped and lists are bounded, so no tool result can grow
// without limit. The full record stays in the product's own local storage.
import { emptySlotSwitch, type DeliveryPhase, type JobRecord, type JobUsage, type NotificationRecord, type SlotSwitchAudit } from "../jobs/types";

/** Hard cap for any single text field returned through a tool. */
export const MCP_TEXT_CAP = 8000;
/** Hard cap on the number of attempts listed. */
export const MCP_MAX_ATTEMPTS = 20;
/** Hard cap on the number of jobs returned by a list call. */
export const MCP_MAX_LIST = 50;

function capText(value: unknown, cap = MCP_TEXT_CAP): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length <= cap ? t : t.slice(t.length - cap);
}

export interface CompactResultView {
  ok: boolean;
  subtype: string | null;
  kind: string | null;
  exit_code: number | null;
  stop_reason: string | null;
  /**
   * Why an interactive approval gate on this turn did not proceed
   * (canonical `approval_outcome`), or null when the result carries no such
   * evidence. Bounded tokens only; it never changes the status/classification.
   */
  approval_outcome: string | null;
  final_text: string | null;
  fallback_eligible: boolean;
}

export interface CompactAttemptView {
  generation: number;
  segment: boolean;
  exit_code: number | null;
  kind: string | null;
  failure_kind: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** The candidate model this attempt actually ran with (null for an old record). */
  model: string | null;
  model_source: string | null;
  /** The reasoning effort this attempt ACTUALLY ran with (null = provider/model default). */
  effort: string | null;
  /** True ONLY when this attempt ended on a clear model rate limit (exit 5). */
  rate_limited: boolean;
  /** True ONLY when this attempt was ended on purpose by a time-slot boundary switch. */
  switched: boolean;
  /** The model the switch moved to (null when this attempt did not switch). */
  switch_to_model: string | null;
}

/**
 * The bounded in-flight boundary-switch AUDIT exposed to a caller.
 *
 * Model ids, generations, instants and stable reason codes only — never the
 * task, the provider session id, the log path or a credential. The lists are
 * capped by the persisted audit itself (SLOT_SWITCH_LOG_MAX).
 */
export interface CompactSwitchView {
  /** "auto-switch is active for this job": the switch is ON and a boundary is armed. */
  enabled: boolean;
  armed: boolean;
  switch_enabled: boolean | null;
  current_model: string | null;
  next_boundary_at: string | null;
  next_model: string | null;
  switches: number;
  skips: number;
  last_switch: {
    generation: number;
    from: string | null;
    to: string | null;
    at: string | null;
    ok: boolean;
    reason: string | null;
  } | null;
  last_skip: { generation: number | null; at: string | null; reason: string | null; would_switch_to: string | null } | null;
  /** The applied/refused switch events, newest last (bounded). */
  events: Array<{ generation: number; from: string | null; to: string | null; ok: boolean; reason: string | null }>;
}

export interface CompactNotifyView {
  kind: "callback" | "codex_thread" | "claude_session" | "none";
  source: string | null;
  attempted: boolean;
  delivered: boolean;
  reason: string | null;
  /**
   * Bounded transport-phase evidence of the ORIGINAL attempt when the transport
   * can prove it (`not_written` / `writing_started` / `handoff`), else null.
   * `not_written` is the only phase a bounded recovery may ever re-send; null is
   * UNKNOWN and never eligible. Never inferred from `delivered` or the reason.
   */
  phase: DeliveryPhase | null;
}

export interface CompactJobView {
  job_id: string;
  provider: string;
  status: string;
  generation: number;
  model: string | null;
  model_source: string | null;
  explicit_model: string | null;
  /** The ordered, deduped candidate models resolved at startup (primary first). */
  model_chain: string[];
  /** True when the current/final model is a DOWNGRADE from the chain's primary. */
  downgraded: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  child_pid: number | null;
  usage: JobUsage;
  result: CompactResultView | null;
  stop_reason: string | null;
  error: string | null;
  failure_kind: string | null;
  cancel_requested: boolean;
  attempts: CompactAttemptView[];
  notify: CompactNotifyView;
  /** The bounded time-slot boundary switch audit (no task/session/credential). */
  switch: CompactSwitchView;
}

/**
 * A job was DOWNGRADED when its current model is a LATER candidate of the
 * rate-limit chain.
 *
 * Deliberately NOT "any model that differs from the primary": a scheduled
 * time-slot boundary switch also changes the model and is not a downgrade.
 */
export function isDowngraded(job: JobRecord): boolean {
  if (job.model == null || job.modelChain.length === 0) return false;
  return job.modelChain.indexOf(job.model) > 0;
}

export function compactSwitch(audit: SlotSwitchAudit | null): CompactSwitchView {
  const a = audit ?? emptySlotSwitch();
  return {
    enabled: a.enabled === true,
    armed: a.armed === true,
    switch_enabled: a.switchEnabled,
    current_model: capText(a.currentModel, 200),
    next_boundary_at: capText(a.nextBoundaryAt, 64),
    next_model: capText(a.nextModel, 200),
    switches: a.switches.filter((s) => s.ok).length,
    skips: a.skips.length,
    last_switch: a.lastSwitch
      ? {
          generation: a.lastSwitch.generation,
          from: capText(a.lastSwitch.from, 200),
          to: capText(a.lastSwitch.to, 200),
          at: capText(a.lastSwitch.at, 64),
          ok: a.lastSwitch.ok === true,
          reason: capText(a.lastSwitch.reason, 200)
        }
      : null,
    last_skip: a.lastSkip
      ? {
          generation: a.lastSkip.generation,
          at: capText(a.lastSkip.at, 64),
          reason: capText(a.lastSkip.reason, 64),
          would_switch_to: capText(a.lastSkip.wouldSwitchTo, 200)
        }
      : null,
    events: a.switches.slice(-MCP_MAX_ATTEMPTS).map((s) => ({
      generation: s.generation,
      from: capText(s.from, 200),
      to: capText(s.to, 200),
      ok: s.ok === true,
      reason: capText(s.reason, 200)
    }))
  };
}

export function compactResult(job: JobRecord): CompactResultView | null {
  const r = job.result;
  if (!r) return null;
  return {
    ok: r.ok === true,
    subtype: capText(r.subtype, 64),
    kind: capText(r.kind, 64),
    exit_code: typeof r.exitCode === "number" ? r.exitCode : null,
    stop_reason: capText(r.stopReason, 200),
    // The bounded approval outcome token: a caller facing a completed turn
    // whose gated operation never ran (or a denial that was not a human
    // refusal) gets the actual cause here instead of guessing from prose.
    approval_outcome: capText(r.approvalOutcome, 64),
    final_text: capText(r.finalText),
    fallback_eligible: r.fallbackEligible === true
  };
}

function compactNotify(job: JobRecord): CompactNotifyView {
  const gen = job.generation;
  const rec: NotificationRecord | undefined = job.notifications.find((n) => n.generation === gen);
  return {
    kind: job.notifyTarget.kind,
    source: job.notifyTarget.source,
    attempted: rec != null,
    delivered: rec?.delivered === true,
    reason: rec ? capText(rec.reason, 200) : null,
    phase: rec?.phase ?? null
  };
}

export function compactJob(job: JobRecord): CompactJobView {
  const attempts = job.attempts.slice(-MCP_MAX_ATTEMPTS).map((a) => ({
    generation: a.generation,
    segment: a.segment === true,
    exit_code: typeof a.exitCode === "number" ? a.exitCode : null,
    kind: capText(a.kind, 64),
    failure_kind: capText(a.failureKind, 64),
    started_at: capText(a.startedAt, 64),
    ended_at: capText(a.endedAt, 64),
    model: capText(a.model, 200),
    model_source: capText(a.modelSource, 32),
    effort: capText(a.effort, 32),
    rate_limited: a.rateLimited === true,
    switched: a.switched === true,
    switch_to_model: capText(a.switchToModel, 200)
  }));
  return {
    job_id: job.id,
    provider: job.provider,
    status: job.status,
    generation: job.generation,
    model: capText(job.model, 200),
    model_source: capText(job.modelSource, 32),
    explicit_model: capText(job.explicitModel, 200),
    model_chain: job.modelChain.map((m) => capText(m, 200)).filter((m): m is string => m != null),
    downgraded: isDowngraded(job),
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    child_pid: typeof job.childPid === "number" ? job.childPid : null,
    usage: job.usage,
    result: compactResult(job),
    stop_reason: capText(job.stopReason, 200),
    error: capText(job.error, 2000),
    failure_kind: capText(job.failureKind, 64),
    cancel_requested: job.cancelIntent.requested === true,
    attempts,
    notify: compactNotify(job),
    switch: compactSwitch(job.slotSwitch)
  };
}

/** A compact one-line summary for a list response (no result text). */
export interface CompactJobSummary {
  job_id: string;
  provider: string;
  status: string;
  generation: number;
  created_at: string;
  finished_at: string | null;
}

export function compactSummary(job: JobRecord): CompactJobSummary {
  return {
    job_id: job.id,
    provider: job.provider,
    status: job.status,
    generation: job.generation,
    created_at: job.createdAt,
    finished_at: job.finishedAt
  };
}
