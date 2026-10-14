// types.ts — the durable job record of CrewDispatch's local job service.
//
// One LOGICAL job has a stable id and may span several GENERATION-scoped
// attempts (an internal CLI segment boundary resumed via `--resume`, or a later
// continuation message). Every attempt belongs to exactly one generation, and
// only the CURRENT generation of a non-terminal job may write a terminal state.
//
// The record is deliberately flat and JSON-serialisable. Unreported values are
// `null`, never a fabricated `0` (see the batch-1 usage rule). `schemaVersion`
// is persisted so a future reader can migrate or honestly refuse.
import type { PendingApproval } from "./approval";

// Version 2 (M1 batch 3): the record gained a persisted terminal-notification
// TARGET and a per-generation notification DELIVERY log (see NotifyTarget /
// NotificationRecord below). A batch-2 build reading a batch-3 record honestly
// refuses it (schema too new) instead of silently dropping the wake evidence.
//
// Version 3 (M1 batch 4): the record gained `modelSource` + `explicitModel`, so
// a later reader (fallback / in-flight switching) can tell a per-job EXPLICIT
// override apart from an automatic slot/default selection. A batch-2/3 build
// reading a v3 record refuses it (schema too new); this build reads a v2 record
// with null defaults for the two new fields.
//
// Version 5 (M1 batch 6): the record gained the IN-FLIGHT time-slot BOUNDARY
// SWITCH audit. `slotSwitch` records, bounded and generation-scoped, whether the
// switch is enabled/armed, the next boundary instant and its model, every applied
// switch (from/to/generation/what was proven about the old tree) and every SKIP
// with its reason, so a caller can audit a running switch without the task, the
// session id or any credential. `JobAttempt` gained `switched` /
// `switchToModel`, and `PromptKind` gained `switch` (the fixed internal resume
// prompt of a boundary-switched generation). A batch-2/3/4 build reading a v5
// record refuses it (schema too new); this build reads a v2/v3/v4 record with
// safe defaults (no audit, switched false, switchToModel null, and "switch"
// falls back to "task") and NEVER guesses a switch that did not happen.
//
// Version 4 (M1 batch 5): the record gained the RATE-LIMIT DOWNGRADE audit. The
// chain is persisted on the record (`modelChain`), each attempt records the
// candidate model it actually ran with its source and whether it hit a rate
// limit (`JobAttempt.model` / `modelSource` / `rateLimited`) plus that attempt's
// own usage (`JobAttempt.usage`, so the job total is a sum that can never double
// count), and `promptKind` records whether the current generation's prompt is
// the job's own task or the fixed internal resume prompt. A batch-2/3 build
// reading a v4 record refuses it (schema too new); this build reads a v2/v3
// record with safe defaults (null model, null source, rateLimited false, empty
// per-attempt usage, empty chain, promptKind "task") and NEVER guesses a source.
//
// Version 6 (telemetry): `JobUsage` gained the two provider-neutral GAUGE
// metrics `contextUsed` / `contextWindow` (see `totalUsage`). A build that
// predates them would silently DROP a provider's context evidence, so a v5
// build refuses a v6 record (schema too new); this build reads a v2..v5 record
// with both gauges null (never a guessed context).
//
// Version 7 (paired decode): `JobUsage` gained the ADDITIVE paired-decode
// numerator `decodeTokens`, and `decodeSeconds` changed MEANING — it is now the
// measured decode time covering EXACTLY the responses counted by
// `decodeTokens`, never the run's total active model-output time. A v6 build
// reading a v7 record would keep the new `decodeTokens` out of its schema and
// would divide the OLD total `tokensOut` by `decodeSeconds`, fabricating a
// misleading tok/s rate — so it refuses a v7 record honestly. This build reads
// a v2..v6 record with `decodeTokens: null` and its legacy (unpaired)
// `decodeSeconds` value DROPPED to null: a pre-v7 value never covered "exactly
// the responses counted by decodeTokens", so presenting it under the new field
// meaning would be a misinterpretation, not a measurement.
//
// Version 8 (dsh-exact decode): `decodeTokens` / `decodeSeconds` now mean
// EXACTLY the official deepseek-harness `sessionStats` fold — summed over
// completed responses whose first meaningful non-empty token instant, assembled
// final response instant and provider-reported output token count are ALL
// proven, with `decodeTokens / decodeSeconds` a ratio of sums. A pre-v8
// WorkBuddy record was written by CrewDispatch's custom synthetic-boundary
// approximation (first ACP chunk → CrewDispatch-synthesized message_end), which is
// not dsh-equivalent and produced inflated rates; its durable record carries
// no per-response first-token/completion evidence, so the value cannot be
// recomputed deterministically and is loaded as null (`normalizeUsage`'s
// `legacyWorkbuddyDecode` gate). Command Code's own request-scope pairing is
// its provider-native behavior and is unchanged, so its pre-v8 values stay
// valid. A v7 build reading a v8 record would read the same field meanings it
// already implements for Command Code and would ignore the gate for a
// WorkBuddy record — so the version bump also lets this build refuse a newer
// record honestly.
//
// Version 9 (interactive provider approval, JQ-20261001-26): `JobRecord` gained
// `pendingApproval` — a bounded, display-safe, provider-neutral description of
// an approval a running provider turn is waiting on (job/generation/request
// identity, provider, safe tool name, the provider's own option ids/kinds/
// labels and an expiry). It is set while the job is `running` and cleared on
// resolution, expiry, generation change, cancel/interruption and any terminal
// write. A pre-v9 build reading a v9 record would ignore the field while the
// provider waits, so the bump also lets it refuse the newer record honestly;
// this build reads a v2..v8 record with `pendingApproval: null` (never a
// fabricated pending state).
// Version 10 (independent reasoning effort): the record gained the ACCEPTED
// MODEL/EFFORT PLAN `modelChainPlan` — the ordered `{model, source, effort}`
// candidates resolved at dispatch — plus `JobAttempt.effort` (the effort the
// attempt ACTUALLY ran with). The two are what make a restart / segment resume
// / follow-up reuse the accepted pairs instead of re-reading later Settings
// edits. A pre-v10 build reading a v10 record would ignore both and re-resolve
// the chain (and the effort) from whatever the config says at that moment — the
// exact defect — so the bump also lets it refuse the newer record honestly;
// this build reads a v2..v9 record with an empty plan and a null attempt effort
// (never a guessed pair).
//
// Version 11 (frozen accepted intent): the record gained `acceptedIntent` — the
// MINIMAL model/effort INTENT captured at dispatch, BEFORE the queued record is
// exposed, so a Settings edit made while the job is queued can never pair a
// later model with an earlier effort. v10 froze the validated plan at WORKER
// startup, which still let a queued job mix a later model with the
// dispatch-time effort; v11 captures the pure config-derived pair up front and
// the worker only VALIDATES it against the CLI's own catalog. A pre-v11 build
// reading a v11 record would ignore the intent and re-resolve from live config
// (the mixing defect), so the bump also lets it refuse the newer record
// honestly; this build reads a v2..v10 record with `acceptedIntent: null` and
// resolves the chain from the current config exactly as before (never a
// guessed pair).
//
// Version 12 (Claude session wake target): `NotifyKind` gained `claude_session`
// and `NotifyTarget` gained the opaque `claudeSessionId` / `claudeBindingId`
// references (never the session's socket address or auth token — those live in
// a private local binding store, see src/claude/binding.ts). A pre-v12 build
// reading a v12 record would normalize the unknown target kind to `none` and
// could then record a fabricated `no_target` diagnostic for a wake that really
// targeted a Claude session, so the bump also lets it refuse the newer record
// honestly; this build reads a v2..v11 record with both Claude fields null and
// every existing Codex/callback target unchanged.
// Version 13 (Darwin provider-child incarnation) added `childStartedAtUs`.
// Version 14 adds `ownerStartedAtUs`, the exact worker-owner birth instant used
// by Darwin reconciliation so a reused PID is never mistaken for the original
// live owner. Pre-v14 records read the owner birth as null and therefore keep a
// live same-number Darwin PID UNKNOWN rather than guessing ownership.
// Version 15 adds `workspaceIdentity`, the Darwin filesystem identity captured
// from realpath + device/inode for an existing accepted workspace. A pre-v15
// record has no such fact and keeps the historical canonical-path behavior.
export const JOB_SCHEMA_VERSION = 15;

/**
 * Where a job's persisted `model` came from. `explicit` is a per-job override
 * (never affected by a time slot); `slot` matched an enabled time window;
 * `config-default` is the configured default model; `cli-default` is the
 * official CLI catalog's own default; `rate-limit-fallback` is the configured
 * final fallback model, reached only after a clear model rate limit;
 * `none` means no model was resolved.
 */
export type ModelSource = "explicit" | "slot" | "config-default" | "cli-default" | "rate-limit-fallback" | "none";

/**
 * One ACCEPTED candidate of a job's model/effort plan (v10): the ordered
 * `{model, source, effort}` pairs resolved once at dispatch. `modelChain`
 * carries the same ids for display; the plan additionally freezes each
 * candidate's SOURCE and EFFORT so a later generation reuses exactly the
 * accepted pair instead of re-reading a Settings edit made in the meantime.
 */
export interface ModelChainPlanEntry {
  model: string;
  source: ModelSource;
  effort: string | null;
}

/**
 * The MINIMAL accepted model/effort INTENT, frozen at dispatch (v11) BEFORE the
 * queued record is exposed (see `JobRecord.acceptedIntent`).
 *
 * It is the pure config-derived decision — no catalog, no environment and no
 * profile — captured so that a Settings edit made while the job is queued
 * cannot pair a later model with an earlier effort. The worker VALIDATES it
 * against the installed CLI's own catalog (`selectModelChainFromIntent`) and
 * freezes the validated `modelChainPlan`; it never re-reads the live config for
 * a fresh job that carries an intent.
 *
 * `primaryModel` is null when the dispatch-time settings contributed no model
 * (no explicit override, no configured default); the worker then resolves the
 * CLI's own catalog default. `primarySource`/`primaryEffort` are the primary's
 * accepted route and its accepted reasoning effort (null = provider/model
 * default). `fallbacks` are the configured default model and the configured
 * rate-limit fallback model with their OWN efforts, in chain order.
 */
export interface AcceptedModelIntent {
  primaryModel: string | null;
  primarySource: ModelSource;
  primaryEffort: string | null;
  fallbacks: ModelChainPlanEntry[];
}

/**
 * How the CURRENT generation's prompt is formed.
 *
 * `task` — the job's own task (a fresh run, or a continuation's new user
 * message). `recovery` — the fixed, short, transport-only internal resume prompt
 * used when a generation resumes an ALREADY-ESTABLISHED session after a rate
 * limit or the CLI's internal segment boundary. `switch` — the fixed, short,
 * transport-only internal resume prompt of a generation that continues the SAME
 * session on a DIFFERENT model after a configured time-slot boundary. Both
 * internal kinds are NEVER a user follow-up: the session already holds the task,
 * so re-sending it would invite duplicated work.
 */
export type PromptKind = "task" | "recovery" | "switch";

/**
 * Job lifecycle status.
 *
 * `orphaned` is deliberately NON-terminal. It records that the owning worker is
 * gone (or refused to continue) while the CLI process TREE could not be RESOLVED
 * as stopped. "Resolved as stopped" means the CrewDispatch-managed and identified
 * processes are gone; it never claims an arbitrary detached descendant behind an
 * exited intermediate was proven gone (a pure TypeScript PID/PPID observation
 * limit — this is a deliberate persisted-state boundary). The record keeps `childPid` as
 * inspectable evidence, never claims `cancelled`, can never auto-resume/continue
 * into a new generation, and can only reach a terminal state through an explicit
 * cancel that first resolves the managed tree as stopped.
 */
export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted" | "orphaned";

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "error", "cancelled", "interrupted"]);

/** True only for a settled outcome; `orphaned` is NOT terminal (see above). */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Which runner drove a job. `fixture` is a test-only seam; production
 * currently supports Command Code and WorkBuddy AI.
 */
export type RunnerKind = "command-code" | "workbuddy-ai" | "fixture";

/** Usage exactly as the CLI reported it; `null` = unreported (never 0). */
export interface JobUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  toolCalls: number | null;
  cacheRead: number | null;
  cacheMiss: number | null;
  cacheCreation: number | null;
  credits: number | null;
  totalCostUsd: number | null;
  /**
   * PAIRED decode numerator (the official deepseek-harness `sessionStats`
   * fold): output tokens of completed responses that also proved their own
   * output-token count, first-token instant AND assembled/final response
   * instant. A response missing any fact contributes nothing, and
   * `decodeTokens / decodeSeconds` is therefore the only valid rate — a ratio
   * of sums, never the run's total `tokensOut` over a subset denominator.
   */
  decodeTokens: number | null;
  /**
   * PAIRED decode denominator: summed decode wall time in seconds, covering
   * EXACTLY the responses counted by `decodeTokens` — first meaningful
   * non-empty token → assembled/final response, tool time and prefill
   * excluded. Never the run's total active model-output time (a pre-v7
   * record's legacy value and a pre-v8 WorkBuddy value are loaded as null; see
   * `JOB_SCHEMA_VERSION`).
   */
  decodeSeconds: number | null;
  /** GAUGE: latest reported context occupancy (see `totalUsage`). */
  contextUsed: number | null;
  /** GAUGE: latest reported context window size (see `totalUsage`). */
  contextWindow: number | null;
}

export function emptyUsage(): JobUsage {
  return {
    tokensIn: null,
    tokensOut: null,
    toolCalls: null,
    cacheRead: null,
    cacheMiss: null,
    cacheCreation: null,
    credits: null,
    totalCostUsd: null,
    decodeTokens: null,
    decodeSeconds: null,
    contextUsed: null,
    contextWindow: null
  };
}

/**
 * The ADDITIVE metrics of the canonical telemetry contract: each attempt's
 * reported value is a delta (or a per-request value) and the job total is their
 * sum.
 */
export const ADDITIVE_USAGE_KEYS = [
  "tokensIn",
  "tokensOut",
  "toolCalls",
  "cacheRead",
  "cacheMiss",
  "cacheCreation",
  "credits",
  "totalCostUsd",
  "decodeTokens",
  "decodeSeconds"
] as const satisfies readonly (keyof JobUsage)[];

/**
 * The GAUGE metrics of the canonical telemetry contract: each value describes
 * ONE instant (the latest request's context occupancy / the model's context
 * window), so a job total takes the LAST reported value — never a sum, which
 * would fabricate a context of several windows.
 */
export const GAUGE_USAGE_KEYS = ["contextUsed", "contextWindow"] as const satisfies readonly (keyof JobUsage)[];

/** True when at least one usage metric was actually reported. */
export function usageReported(usage: JobUsage): boolean {
  return Object.values(usage).some((v) => v != null);
}

/**
 * Cumulative usage of several attempts.
 *
 * ADDITIVE metrics are the SUM of the values actually reported and stay `null`
 * when NO attempt reported one — an absent metric is never turned into a
 * fabricated 0. Every attempt contributes exactly once, so a multi-attempt /
 * downgraded / resumed run never double counts; a continuation generation adds
 * its OWN usage once because each attempt owns its own `usage` record.
 *
 * GAUGE metrics (contextUsed / contextWindow) are the LAST value reported by
 * any attempt in attempt order (the most recent generation's observation).
 * Summing them would fabricate a context larger than the model's window.
 */
export function totalUsage(attempts: readonly JobAttempt[]): JobUsage {
  const acc = emptyUsage();
  for (const key of ADDITIVE_USAGE_KEYS) {
    let sum = 0;
    let seen = false;
    for (const attempt of attempts) {
      const v = attempt.usage ? attempt.usage[key] : null;
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        seen = true;
      }
    }
    acc[key] = seen ? sum : null;
  }
  for (const key of GAUGE_USAGE_KEYS) {
    let last: number | null = null;
    for (const attempt of attempts) {
      const v = attempt.usage ? attempt.usage[key] : null;
      if (typeof v === "number" && Number.isFinite(v)) last = v;
    }
    acc[key] = last;
  }
  return acc;
}

/** Bounded, field-whitelisted terminal outcome kept in the job record. */
export interface CompactResult {
  ok: boolean;
  /** Terminal subtype the CLI reported (success / error / max_turns), or null. */
  subtype: string | null;
  /** Exit classification kind (success / auth / permission / rate_limit / ...). */
  kind: string;
  exitCode: number | null;
  stopReason: string | null;
  /**
   * The provider's more specific terminal cause when its terminal record
   * carried one (canonical `finish_reason`), else null. Diagnostic refinement
   * only — never a second failure classification, and absent on records
   * persisted before it existed (JQ-20261001-23).
   */
  finishReason?: string | null;
  /**
   * The provider's bounded, display-safe terminal error detail when its
   * terminal record carried one (canonical `error_detail`), else null. The
   * provider boundary sanitizes it (single line, no payloads/stack traces);
   * refinement only — never a second failure classification, and absent on
   * records persisted before it existed (JQ-20261001-24).
   */
  errorDetail?: string | null;
  /**
   * The bounded approval outcome token when the turn's terminal record carried
   * one (canonical `approval_outcome`), else null: why an interactive approval
   * gate did not proceed (`rejected` / `expired` / `no_route` /
   * `no_allow_option` / `publish_failed` / `cancelled`). It lets a completed
   * turn whose gated operation never ran explain that fact, and keeps a missing
   * approval route from being reported as a human refusal. Evidence only —
   * never a second failure classification, and absent on records persisted
   * before it existed (never back-filled from `finishReason` or any other
   * evidence).
   */
  approvalOutcome?: string | null;
  /** Bounded final text; full raw stream stays in the log file. */
  finalText: string | null;
  /** True ONLY for a clear model rate limit — eligible for future fallback. */
  fallbackEligible: boolean;
}

/** One generation-scoped attempt of a logical job. */
export interface JobAttempt {
  generation: number;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  kind: string | null;
  failureKind: string | null;
  /** True when the attempt ended at the CLI's internal segment boundary. */
  segment: boolean;
  /** The session id this attempt resumed from (null for the first attempt). */
  resumedFrom: string | null;
  /**
   * The candidate model this attempt ACTUALLY ran with, or null for a record
   * written before the downgrade audit existed (never back-filled from `job.model`).
   */
  model: string | null;
  /** Where `model` came from (null when unknown / an old record). */
  modelSource: ModelSource | null;
  /**
   * The reasoning effort this attempt ACTUALLY ran with (null = the provider /
   * model default, or an attempt written before the field existed — never
   * back-filled from the job's current effort).
   */
  effort: string | null;
  /** True ONLY when this attempt ended on a clear model rate limit (exit 5). */
  rateLimited: boolean;
  /**
   * True ONLY when this attempt was terminated ON PURPOSE by the in-flight
   * time-slot boundary switch (never a failure of its own).
   */
  switched: boolean;
  /** The model the boundary switch moved this job to, or null when it did not switch. */
  switchToModel: string | null;
  /** THIS attempt's own usage; the job total is the sum over attempts. */
  usage: JobUsage;
}

// ---------------------------------------------------------------------------
// The in-flight time-slot boundary switch audit (M1 batch 6)
// ---------------------------------------------------------------------------

/** Hard cap on the persisted switch/skip logs of one job (bounded record). */
export const SLOT_SWITCH_LOG_MAX = 20;

/** One APPLIED (or REFUSED) boundary switch, scoped to the generation it ended. */
export interface SlotSwitchEvent {
  generation: number;
  from: string | null;
  to: string | null;
  at: string;
  /** True only when the old tree was proven stopped AND the next generation started. */
  ok: boolean;
  /** Stable reason code when `ok === false` (never a raw CLI output). */
  reason: string | null;
  /** The PID of the terminated CLI tree (bounded evidence). */
  pid: number | null;
  /** What was PROVEN about that tree's exit (see `KillTreeScope`). */
  scope: string | null;
}

/** One SKIPPED boundary: the boundary arrived and the switch did NOT happen. */
export interface SlotSwitchSkip {
  generation: number | null;
  at: string;
  /** Stable code: disabled / same_model / no_session / config_invalid / ... */
  reason: string;
  model: string | null;
  /** The model the switch WOULD have moved to (null when it could not be resolved). */
  wouldSwitchTo: string | null;
}

/**
 * The bounded, job-scoped audit of the in-flight boundary switch.
 *
 * It is written by the owning worker only and contains NO task text, NO session
 * id and NO credential — model ids, generations, instants, stable reason codes
 * and the process evidence of the old tree's exit.
 */
export interface SlotSwitchAudit {
  /** User-visible "auto-switch is active for this job": ON and a boundary armed. */
  enabled: boolean;
  /** A boundary timer is armed for a future local instant. */
  armed: boolean;
  /** The last `inFlightSwitch` value read from the persisted config (null = unknown). */
  switchEnabled: boolean | null;
  currentGeneration: number | null;
  currentModel: string | null;
  nextBoundaryAt: string | null;
  nextModel: string | null;
  switches: SlotSwitchEvent[];
  skips: SlotSwitchSkip[];
  lastSwitch: SlotSwitchEvent | null;
  lastSkip: SlotSwitchSkip | null;
}

export function emptySlotSwitch(): SlotSwitchAudit {
  return {
    enabled: false,
    armed: false,
    switchEnabled: null,
    currentGeneration: null,
    currentModel: null,
    nextBoundaryAt: null,
    nextModel: null,
    switches: [],
    skips: [],
    lastSwitch: null,
    lastSkip: null
  };
}

/**
 * Append a switch event, keeping the log BOUNDED (oldest dropped) and the
 * last-event pointer fresh. Pure: it returns a NEW audit, never mutates.
 */
export function pushSwitchEvent(audit: SlotSwitchAudit, event: SlotSwitchEvent): SlotSwitchAudit {
  const switches = [...audit.switches, event].slice(-SLOT_SWITCH_LOG_MAX);
  return { ...audit, switches, lastSwitch: event };
}

/** Append a skip, bounded the same way. Pure. */
export function pushSwitchSkip(audit: SlotSwitchAudit, skip: SlotSwitchSkip): SlotSwitchAudit {
  const skips = [...audit.skips, skip].slice(-SLOT_SWITCH_LOG_MAX);
  return { ...audit, skips, lastSkip: skip };
}

export interface CancelIntent {
  requested: boolean;
  requestedAt: string | null;
  by: string | null;
}

/**
 * Where a terminal wake for this job is delivered. Resolved ONCE at dispatch time
 * (priority callback URL > explicit Claude session/binding > explicit
 * codex_thread_id > `CODEX_THREAD_ID` env fallback) and persisted with the job,
 * so the detached worker that reaches the terminal state does not depend on
 * inheriting the caller's thread id.
 *
 * A `claude_session` target carries ONLY the opaque session/binding reference.
 * The native inbox address and its per-session authentication token stay in a
 * narrowly scoped private local binding store (src/claude/binding.ts) and never
 * enter a job record, an MCP argument/result, a prompt, the UI or a log.
 *
 * `kind: "none"` means no target was supplied: the terminal wake is a recorded
 * diagnostic (`no_target`), never an error, and never changes the job outcome.
 */
export type NotifyKind = "callback" | "codex_thread" | "claude_session" | "none";
export type NotifySource = "callback_url" | "codex_thread_id" | "env" | "claude_session_id" | "claude_binding_id" | null;

export interface NotifyTarget {
  kind: NotifyKind;
  /** Loopback/HTTP(S) URL the short terminal body is POSTed to (kind "callback"). */
  callbackUrl: string | null;
  /** Explicit Codex thread id to `codex queue` (kind "codex_thread"). */
  codexThreadId: string | null;
  /** Opaque Claude session id (kind "claude_session"), or null. */
  claudeSessionId?: string | null;
  /** Opaque registered Claude binding reference (kind "claude_session"), or null. */
  claudeBindingId?: string | null;
  /** Which input supplied the target (null when there is none). */
  source: NotifySource;
}

export function emptyNotifyTarget(): NotifyTarget {
  return { kind: "none", callbackUrl: null, codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: null };
}

/**
 * Minimal TRANSPORT-PHASE evidence of ONE delivery attempt, recorded by a
 * transport that can prove it. It exists so bounded recovery can distinguish a
 * proven pre-write failure from an uncertain one:
 *
 *   - `not_written` — the attempt provably never began writing to the
 *     destination (the connection was missing/refused/never established, or a
 *     connect-time failure occurred) BEFORE any write call. Only this phase is
 *     eligible for bounded recovery;
 *   - `writing_started` — a write call was issued (or the destination closed /
 *     timed out / errored after it), so the outcome is uncertain; never
 *     automatically resent;
 *   - `handoff` — the transport reports its own successful handoff (frames
 *     fully written + clean close for the Claude inbox). Never a recovery
 *     candidate.
 *
 * `null`/absent means UNKNOWN (an older record, a transport that does not
 * record a phase, or a crash before the record was written). Unknown is never
 * eligible: recovery never infers eligibility from `delivered:false` or text.
 */
export type DeliveryPhase = "not_written" | "writing_started" | "handoff";

/**
 * One terminal-wake DELIVERY record, scoped to a generation. A logical job can
 * reach a terminal state more than once (a continuation starts a new
 * generation), so the wake is tracked per generation — never as a permanent
 * boolean — and attempted AT MOST ONCE per terminal generation. `reason` is a
 * stable code (`no_target`, `http_status`, `timeout`, `spawn_failed`, ...); it is
 * a diagnostic only and never alters the job's own terminal result.
 *
 * `by` is the recorded ORIGIN of the attempt: which finalizer performed the
 * delivery (`worker` / `cancel` / `mcp` / `daemon-reconcile` /
 * `hub-reconcile`). It is null for a record written before the origin was
 * persisted or when the caller supplied none — an unknown origin is never
 * invented.
 *
 * `phase` is the optional bounded transport-phase evidence (see
 * `DeliveryPhase`); it is absent on records written before it existed and on
 * transports that cannot prove a phase, and recovery treats both as unknown.
 */
export interface NotificationRecord {
  generation: number;
  kind: NotifyKind;
  attemptedAt: string;
  delivered: boolean;
  reason: string | null;
  /** Which finalizer attempted delivery; null = not recorded (never invented). */
  by: string | null;
  /** Bounded transport-phase evidence; null/absent = unknown (never inferred). */
  phase?: DeliveryPhase | null;
}

/**
 * One APPROVAL-wake DELIVERY record, scoped to `(generation, requestId)` and
 * stored in its OWN namespace (`<root>/notify/approval/`), so it can never be
 * confused with the terminal `NotificationRecord` log and a terminal generation
 * can never consume an approval attempt (or vice versa).
 *
 * The wake is attempted AT MOST ONCE per approval identity: an exclusive claim
 * file guards it across repeat stream events, processes and restarts. `reason`
 * is a stable diagnostic code (`no_target`, `no_hub`, `http_status_...`,
 * `timeout`, `spawn_failed`, ...) and never alters the job, the pending
 * approval or the claimed decision.
 */
export interface ApprovalNotificationRecord {
  generation: number;
  /** The provider request id this attempt belongs to (bounded on load). */
  requestId: string;
  /** Which target kind was recorded for this job (never invented). */
  kind: NotifyKind;
  attemptedAt: string;
  delivered: boolean;
  reason: string | null;
  /** Which finalizer attempted delivery; null = not recorded (never invented). */
  by: string | null;
  /** Bounded transport-phase evidence; null/absent = unknown (never inferred). */
  phase?: DeliveryPhase | null;
}

/**
 * One bounded RECOVERY attempt record (this feature), scoped to the exact
 * event identity it belongs to and persisted in its OWN sidecar namespace
 * (`<root>/notify/recovery/`). It is deliberately separate from the original
 * `NotificationRecord` / `ApprovalNotificationRecord`: the original attempt and
 * its outcome are immutable, and the recovery budget (exactly ONE additional
 * attempt per exact event) is tracked independently.
 *
 * The record never carries the task, result text, a native address or a token —
 * identity and a stable outcome code only.
 */
export interface RecoveryNotificationRecord {
  /** Which event kind was recovered. */
  event: "terminal" | "approval_required";
  generation: number;
  /** The approval request id, or null for a terminal event. */
  requestId: string | null;
  attemptedAt: string;
  /** True only when the recovery transport reported its own successful handoff. */
  delivered: boolean;
  /** Stable diagnostic code (see the recovery module), or null on success. */
  reason: string | null;
  /** Recorded origin of the recovery attempt; null = not recorded. */
  by: string | null;
}

/**
 * A durable per-generation TERMINAL RESULT-READ receipt: the real MCP result
 * entry served the terminal result for this exact `(job, generation)`. It means
 * "result collected / request served" — NEVER "accepted", and not proof that a
 * caller rendered the payload. Bounded recovery uses it to suppress a recovered
 * notice for an already-collected generation.
 */
export interface TerminalReadReceipt {
  generation: number;
  /** Which entry served the read (stable token, e.g. "mcp-result"). */
  by: string | null;
  at: string;
}

/**
 * Durable evidence of a PROVIDER-OWNED turn cleanup during cancellation
 * (JQ-20261006-58).
 *
 * Some providers run a turn OUTSIDE the process tree CrewDispatch spawned, so
 * killing that tree is not the whole cancellation. This records exactly what the
 * provider-owned cancellation proved for one cancelled generation:
 *   - `owned_tool_stopped` — the exact session/turn was cancelled and a process
 *     scoped to this generation was SEEN alive and is now gone;
 *   - `no_owned_work`      — the exact session/turn was cancelled and no
 *     provider-owned process of this generation was visible (a bounded negative
 *     snapshot, never a whole-tree guarantee);
 *   - `no_route`           — the provider owns the turn but the exact
 *     cancellation route could not be reached;
 *   - `unresolved`         — the cancellation was requested but owned work could
 *     not be proven stopped (still alive, unknown scan, or a slot shared with
 *     another live job). The job must NOT claim complete cancellation.
 * Absent/null means the provider owned no out-of-tree work for this job.
 */
export interface CancelCleanupEvidence {
  state: "owned_tool_stopped" | "no_owned_work" | "no_route" | "not_owned" | "unresolved";
  provider: string;
  /**
   * The generation this cleanup was proven for. A previous generation's evidence
   * is NEVER accepted as proof for the current one (JQ-20261006-58); a record
   * written before the field existed normalizes to -1, which matches no real
   * generation and is therefore treated as unresolved.
   */
  generation: number;
  /** Stable provider route token, or null. */
  route: string | null;
  /** The exact provider session the cancellation targeted, or null. */
  sessionId: string | null;
  /** Provider-owned PIDs still alive when the cleanup could not be proven. */
  survivingPids: number[];
  /** Stable diagnostic code, or null. */
  detail: string | null;
  at: string;
  by: string | null;
}

export interface JobRecord {
  schemaVersion: number;
  id: string;
  provider: string;
  runner: RunnerKind;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Current generation. Bumped on every resume/continuation attempt. */
  generation: number;
  cwd: string;
  /** Persisted filesystem identity for the accepted workspace when proven; null for legacy/path-fallback records. */
  workspaceIdentity: string | null;
  /** The first task message (the job's input). */
  task: string;
  /** The model actually dispatched (resolved at startup), or null before resolution. */
  model: string | null;
  /** Where `model` came from (persisted source of truth for fallback/in-flight). */
  modelSource: ModelSource | null;
  /** The per-job explicit override this job was created with (null = none). */
  explicitModel: string | null;
  /**
   * The ordered, canonical-id-deduped candidate models resolved at startup
   * (primary first, at most 3). The model ids only — no task, credential or raw
   * CLI output. Empty for a record written before the chain existed.
   */
  modelChain: string[];
  /**
   * The accepted `{model, source, effort}` plan frozen at dispatch (v10). The
   * worker reuses it for every later generation of this job (segment resume,
   * rate-limit downgrade, follow-up, restart) so a Settings edit made after
   * dispatch can never silently change a running/continued job. Empty for a
   * record written before the plan existed.
   */
  modelChainPlan: ModelChainPlanEntry[];
  /**
   * The minimal model/effort INTENT frozen at dispatch (v11), before the queued
   * record is exposed. The worker validates it against the CLI's own catalog
   * (instead of re-reading a Settings edit made while the job was queued) and
   * freezes the result as `modelChainPlan`. Null for a record written before
   * the intent existed (the worker then resolves from the current config).
   */
  acceptedIntent: AcceptedModelIntent | null;
  /** How the current generation's prompt is formed (see `PromptKind`). */
  promptKind: PromptKind;
  /**
   * The bounded audit of the in-flight time-slot boundary switch (batch 6).
   * Null only for a record written before the switch existed; the worker fills it
   * in when it first evaluates a boundary.
   */
  slotSwitch: SlotSwitchAudit | null;
  permissionMode: string;
  effort: string | null;
  /** Provider session id, used to `--resume` the SAME logical job. */
  sessionId: string | null;
  /** Transcript/log path RELATIVE to the data root. */
  logPath: string;
  /** Owner id "jobquay-<pid>-<ts36>" of the process that owns this job. */
  owner: string;
  ownerPid: number | null;
  /** Exact epoch-microsecond birth of `ownerPid` when the OS proved it. */
  ownerStartedAtUs: number | null;
  heartbeatAt: string | null;
  /** PID of the CURRENT generation's child process tree. */
  childPid: number | null;
  /** Exact epoch-microsecond birth of `childPid` when the OS proved it. */
  childStartedAtUs: number | null;
  childGeneration: number | null;
  usage: JobUsage;
  result: CompactResult | null;
  stopReason: string | null;
  /**
   * The provider's more specific terminal cause when its terminal record
   * carried one (canonical `finish_reason`), else null. Absent on records
   * persisted before it existed (JQ-20261001-23) — never back-filled.
   */
  finishReason?: string | null;
  /**
   * The provider's bounded, display-safe terminal error detail when its
   * terminal record carried one (canonical `error_detail`), else null. Absent
   * on records persisted before it existed (JQ-20261001-24) — never back-filled.
   */
  errorDetail?: string | null;
  /**
   * The bounded approval outcome token of the terminal result (canonical
   * `approval_outcome`), else null: why an interactive approval gate did not
   * proceed (`rejected` / `expired` / `no_route` / `no_allow_option` /
   * `publish_failed` / `cancelled`). It is durable evidence for the SAME turn
   * as `result`, never a second failure classification and never carried
   * across a generation; absent on records persisted before it existed.
   */
  approvalOutcome?: string | null;
  error: string | null;
  failureKind: string | null;
  cancelIntent: CancelIntent;
  /**
   * The provider-neutral pending approval a RUNNING provider turn is waiting
   * on, or null. Bounded and display-safe (see jobs/approval.ts): identity,
   * provider, tool-name token, the provider's own option ids/kinds/labels and
   * an expiry. Never the tool input, a command, prompt text or a raw provider
   * payload. Cleared on resolution/expiry/generation change/cancel/terminal.
   */
  pendingApproval: PendingApproval | null;
  attempts: JobAttempt[];
  /** Terminal-wake destination, resolved at dispatch and persisted (see above). */
  notifyTarget: NotifyTarget;
  /** Per-generation terminal-wake delivery log (at most one attempt per entry). */
  notifications: NotificationRecord[];
  /**
   * Evidence of the provider-owned turn cleanup of the cancelled generation
   * (JQ-20261006-58). Absent/null for a provider with no out-of-tree work, and
   * for every record written before it existed (never back-filled).
   */
  cancelCleanup?: CancelCleanupEvidence | null;
}

export const RESULT_TEXT_CAP = 8000;

/** Bound the stored final text; the raw stream remains in the log file. */
export function boundResultText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= RESULT_TEXT_CAP ? t : t.slice(t.length - RESULT_TEXT_CAP);
}

/** The plain status view returned to a caller (no secrets, bounded fields). */
export interface JobStatusView {
  id: string;
  provider: string;
  runner: RunnerKind;
  status: JobStatus;
  generation: number;
  model: string | null;
  modelSource: ModelSource | null;
  explicitModel: string | null;
  modelChain: string[];
  promptKind: PromptKind;
  /** Bounded switch audit (never a task / session id / credential). */
  slotSwitch: SlotSwitchAudit | null;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  owner: string;
  ownerPid: number | null;
  childPid: number | null;
  logPath: string;
  usage: JobUsage;
  result: CompactResult | null;
  stopReason: string | null;
  /** The provider's more specific terminal cause, or null (JQ-20261001-23). */
  finishReason?: string | null;
  /** The provider's bounded, display-safe terminal error detail, or null (JQ-20261001-24). */
  errorDetail?: string | null;
  /** The terminal result's bounded approval outcome token, or null. */
  approvalOutcome?: string | null;
  error: string | null;
  failureKind: string | null;
  cancelIntent: CancelIntent;
  /** The bounded pending approval of a running provider turn, or null. */
  pendingApproval: PendingApproval | null;
  attempts: JobAttempt[];
  notifyTarget: NotifyTarget;
  notifications: NotificationRecord[];
}

export function toStatusView(job: JobRecord): JobStatusView {
  return {
    id: job.id,
    provider: job.provider,
    runner: job.runner,
    status: job.status,
    generation: job.generation,
    model: job.model,
    modelSource: job.modelSource,
    explicitModel: job.explicitModel,
    modelChain: [...job.modelChain],
    promptKind: job.promptKind,
    slotSwitch: job.slotSwitch,
    sessionId: job.sessionId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    heartbeatAt: job.heartbeatAt,
    owner: job.owner,
    ownerPid: job.ownerPid,
    childPid: job.childPid,
    logPath: job.logPath,
    usage: job.usage,
    result: job.result,
    stopReason: job.stopReason,
    finishReason: job.finishReason ?? null,
    errorDetail: job.errorDetail ?? null,
    approvalOutcome: job.approvalOutcome ?? null,
    error: job.error,
    failureKind: job.failureKind,
    cancelIntent: job.cancelIntent,
    pendingApproval: job.pendingApproval,
    attempts: job.attempts,
    notifyTarget: job.notifyTarget,
    notifications: job.notifications
  };
}
