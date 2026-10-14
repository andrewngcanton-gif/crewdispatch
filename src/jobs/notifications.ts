// notifications.ts — the provider-neutral / client-neutral notification event
// and orchestration layer.
//
// A durable job can produce exactly two kinds of caller notification:
//
//   * `terminal` — the job reached a terminal state. The externally visible
//     callback body stays exactly `{job_id, status}` and the Codex wake message
//     keeps its one-shot result-collection hint (see src/mcp/notify.ts); this
//     change does NOT alter terminal delivery in any way.
//   * `approval_required` — a RUNNING provider turn paused on an explicit human
//     decision (the shared `PendingApproval` of src/jobs/approval.ts). The
//     original dispatcher conversation is told ONCE that the job is waiting,
//     with job/run identity, a bounded operation summary and a working Hub
//     deep link. The Hub remains the ONLY place a decision is made: there is
//     no chat-based approval, no auto-approval and no polling.
//
// This module owns the shared orchestration: event construction, durable
// at-most-once dedup in a namespace separate from terminal wakes, delivery
// diagnostics and the small TRANSPORT ADAPTER boundary. The transport
// implementations themselves (HTTP callback, Codex `codex queue`) live in
// src/mcp/notify.ts and register here; a future caller (for example a Claude
// transport) adds an adapter + a `NotifyTarget` kind, without touching the job
// service or any provider code.
//
// Guarantees and honest limits:
//   * an approval wake is attempted AT MOST ONCE per
//     (job, generation, request) across repeat stream events, processes and
//     restarts (an exclusive claim file);
//   * the exact current job/generation/request is REVALIDATED TWICE against
//     durable state: once before the claim, and again immediately BEFORE the
//     transport call after the awaited Hub endpoint proof. The job must still be
//     running with the EXACT pending approval, unexpired, not cancelled, with
//     the provider request still materialized and no decision claimed. A stale,
//     resolved, replaced, expired, cancelled or terminal approval is suppressed
//     — before the claim with no record, after the claim as a durable
//     diagnostic in the already-claimed result, and never with a retry;
//   * the target and the pending snapshot are captured from the SAME record read
//     that validated the request, so a later generation's target can never
//     receive an older request's alert;
//   * `deliverApprovalNotification` never writes the job record, the pending
//     approval or the decision; a delivery failure/absence is recorded in its
//     OWN result file and can never change the job's outcome or block the run;
//   * there is no retry and no exactly-once network guarantee. The only residual
//     race is AFTER the final revalidation and the start of the transport send:
//     a delivery already in flight can still land after the human resolves the
//     request. That window is unavoidable without an ack protocol; the link
//     always opens the task's ACTUAL current state, so it cannot authorize
//     anything, and the request identity is never woken twice.
import type { spawn } from "node:child_process";
import {
  readApprovalDecision,
  readPendingApproval,
  resolveApprovalHubUrl,
  type PendingApproval
} from "./approval";
import {
  claimApprovalNotificationAttempt,
  loadJob,
  writeApprovalNotificationResult
} from "./store";
import type { ApprovalNotificationRecord, DeliveryPhase, JobRecord, NotifyKind, NotifyTarget } from "./types";

/** Bound of the one-line operation summary carried by an approval alert. */
export const APPROVAL_OPERATION_CAP = 200;

// ---------------------------------------------------------------------------
// Neutral event model
// ---------------------------------------------------------------------------

/** The terminal wake of one job generation (external body/semantics unchanged). */
export interface TerminalNotificationEvent {
  event: "terminal";
  jobId: string;
  generation: number;
  status: string;
}

/**
 * A running provider turn is waiting for a human approval decision. Every
 * field is bounded and display-safe; `operation`/`cwd` come from the shared
 * sanitized approval detail, and `hubUrl` is built ONLY from a currently proven
 * Hub endpoint (never a hardcoded port).
 */
export interface ApprovalRequiredNotificationEvent {
  event: "approval_required";
  jobId: string;
  generation: number;
  requestId: string;
  provider: string;
  /** The provider's bounded tool-name token, or null. */
  toolName: string | null;
  /** The bounded actual operation (command/title/description/tool fallback), or null. */
  operation: string | null;
  /** The ACTUAL working directory when the provider published one, else null. */
  cwd: string | null;
  /** Proven Hub deep link that opens this exact job; never fabricated. */
  hubUrl: string;
  expiresAt: string;
}

export type NotificationEvent = TerminalNotificationEvent | TerminalRecoveredNotificationEvent | ApprovalRequiredNotificationEvent;

/**
 * A RECOVERED terminal notice: the bounded local recovery path re-notifies the
 * same caller session about a terminal generation whose ORIGINAL attempt
 * provably never began writing to the destination (see `DeliveryPhase`). It is
 * deliberately a distinct event kind:
 *
 *   - it is IDENTIFIABLE as a recovery (the transport's text says the original
 *     notice was not delivered while the conversation was closed);
 *   - it is CONDITIONAL: it asks for the result only when the durable
 *     per-generation result-read receipt shows the result was NOT already
 *     collected, and never repeats the unconditional "exactly once" wording;
 *   - it never implies the caller accepted the work — a read is a read.
 *
 * Only a verified local caller registration triggers it, and only the caller
 * transport that recorded the phase evidence can receive it. Callback and Codex
 * targets keep their existing behavior and never receive this event.
 */
export interface TerminalRecoveredNotificationEvent {
  event: "terminal_recovered";
  jobId: string;
  generation: number;
  status: string;
  /**
   * True when a durable result-read receipt for this exact generation was
   * already observed at construction time (the notice then asks for nothing).
   * Eligibility normally suppresses such a case before the event is built; the
   * flag keeps the text honest even in a race.
   */
  collected: boolean;
}

export interface DeliveryOutcome {
  delivered: boolean;
  reason: string | null;
  /**
   * OPTIONAL bounded transport-phase evidence (see `DeliveryPhase` in
   * jobs/types.ts). Absent/null means the transport cannot prove a phase
   * (HTTP callback, Codex queue) or an older record — recovery treats it as
   * UNKNOWN and never eligible. It is never inferred from `delivered` or text.
   */
  phase?: DeliveryPhase | null;
}

/**
 * Shared delivery dependencies. The same object is used by terminal and
 * approval wakes so a caller (worker / MCP / Hub / daemon reconcile) configures
 * transport seams once; every field is optional and defaults to production.
 */
export interface DeliveryDeps {
  env?: NodeJS.ProcessEnv;
  /**
   * The CrewDispatch data root of the delivery. Required by transports whose
   * destination is a private LOCAL binding (the Claude session inbox store);
   * the HTTP/Codex transports ignore it. The terminal/approval delivery
   * functions fill it from their own `root` argument.
   */
  root?: string;
  /** Target platform for resolution/spawn-plan decisions (test seam; defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Explicit Codex executable path (test seam / user override). */
  codexCliPath?: string | null;
  /** Injected spawn (tests). Defaults to child_process.spawn. */
  spawnFn?: typeof spawn;
  /** Injected HTTP POST (tests). Defaults to a short-timeout http/https request. */
  httpPostFn?: (url: string, body: string, timeoutMs: number) => Promise<DeliveryOutcome>;
  /** Injected fetch used to PROVE the Hub route (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected native-socket connect for the Claude inbox transport (tests). */
  claudeConnectFn?: (socketPath: string) => import("node:net").Socket;
  now?: () => Date;
  /** Timeout for the callback POST / codex queue child / Claude inbox send. */
  timeoutMs?: number;
}

/**
 * ONE caller transport, keyed by the persisted `NotifyTarget.kind`. The adapter
 * receives the already-constructed neutral event and is the ONLY place that
 * knows the caller's wire format. `none` never has an adapter (no target).
 */
export interface NotificationTransportAdapter {
  kind: NotifyKind;
  deliver(event: NotificationEvent, target: NotifyTarget, deps: DeliveryDeps): Promise<DeliveryOutcome>;
}

const transports = new Map<NotifyKind, NotificationTransportAdapter>();

/**
 * Register (or replace) the adapter for one target kind. Registering the same
 * kind twice is intentionally last-wins: a test seam or a future transport can
 * override the built-in without a second dispatch path.
 */
export function registerNotificationTransport(adapter: NotificationTransportAdapter): void {
  transports.set(adapter.kind, adapter);
}

/**
 * Deliver one neutral event to the persisted target through its adapter. Never
 * throws: an absent target/adapter or an adapter failure becomes a stable
 * diagnostic. There is no retry.
 */
export async function deliverNotificationEvent(
  event: NotificationEvent,
  target: NotifyTarget,
  deps: DeliveryDeps = {}
): Promise<DeliveryOutcome> {
  if (target.kind === "none") return { delivered: false, reason: "no_target" };
  const adapter = transports.get(target.kind);
  if (!adapter) return { delivered: false, reason: "no_transport" };
  try {
    return await adapter.deliver(event, target, deps);
  } catch (e) {
    return { delivered: false, reason: `request_failed:${String((e as Error)?.message || e)}` };
  }
}

// ---------------------------------------------------------------------------
// Shared notification MAINTENANCE seam
// ---------------------------------------------------------------------------
//
// Some transports own a private, local resource that must be reaped when its
// owner is gone (for example a Claude session binding whose host process
// exited without exporting end identity). Rather than hard-code any caller's
// cleanup inside the daemon or provider code, an adapter registers HERE beside
// its transport and the daemon's existing reconcile cycle calls the ONE shared
// entry. The orchestration is provider/caller-neutral; every cleanup DECISION
// stays inside the owning module.

/** Result of one maintenance adapter pass. `scanned` says whether an OS scan ran. */
export interface NotificationMaintenanceResult {
  kind: string;
  /** True only when the adapter actually performed its (bounded) work this pass. */
  scanned: boolean;
  /** How many owned records the pass inspected. */
  checked: number;
  /** How many records the pass removed. */
  removed: number;
  /** Stable diagnostic, or null on a clean pass. Never carries a secret. */
  reason: string | null;
}

/**
 * ONE maintenance adapter, keyed by a stable `kind`. `maintain` must be bounded,
 * local, best-effort and must NEVER throw for an expected condition (return a
 * result with a reason instead); a thrown error is caught by the shared entry
 * and recorded, never propagated.
 */
export interface NotificationMaintenanceAdapter {
  kind: string;
  maintain(root: string, deps: DeliveryDeps): Promise<NotificationMaintenanceResult>;
}

const maintenanceAdapters = new Map<string, NotificationMaintenanceAdapter>();

/**
 * Register (or replace) the maintenance adapter for one kind. Registering the
 * same kind twice is intentionally last-wins, mirroring the transport registry.
 */
export function registerNotificationMaintenance(adapter: NotificationMaintenanceAdapter): void {
  maintenanceAdapters.set(adapter.kind, adapter);
}

/**
 * Run every registered maintenance adapter once for the given data root. Never
 * throws: a failing adapter becomes a result with a stable reason and never
 * blocks the others or the daemon's reconcile cycle. Adapters run sequentially
 * so at most one OS scan is taken per adapter per pass.
 */
export async function runNotificationMaintenance(
  root: string,
  deps: DeliveryDeps = {}
): Promise<NotificationMaintenanceResult[]> {
  const results: NotificationMaintenanceResult[] = [];
  for (const adapter of maintenanceAdapters.values()) {
    try {
      results.push(await adapter.maintain(root, deps));
    } catch (e) {
      results.push({
        kind: adapter.kind,
        scanned: false,
        checked: 0,
        removed: 0,
        reason: `maintenance_failed:${String((e as Error)?.message || e).slice(0, 120)}`
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Event construction (bounded, display-safe, provider text is data)
// ---------------------------------------------------------------------------

/**
 * The externally visible callback body of one event. The terminal body is
 * byte-compatible with the historical wake (`{"job_id":...,"status":...}`).
 * The approval body carries an explicit `event` discriminator and identity —
 * never a fabricated terminal `status`. The recovered-terminal body is defined
 * for completeness but is never delivered to a callback/Codex target in this
 * increment (those adapters refuse it explicitly).
 */
export function notificationCallbackBody(event: NotificationEvent): string {
  if (event.event === "terminal") {
    return JSON.stringify({ job_id: event.jobId, status: event.status });
  }
  if (event.event === "terminal_recovered") {
    return JSON.stringify({ event: "terminal_recovered", job_id: event.jobId, generation: event.generation, status: event.status });
  }
  return JSON.stringify({
    event: "approval_required",
    job_id: event.jobId,
    generation: event.generation,
    request_id: event.requestId,
    provider: event.provider,
    tool: event.toolName,
    operation: event.operation,
    cwd: event.cwd,
    hub_url: event.hubUrl,
    expires_at: event.expiresAt
  });
}

/**
 * The bounded one-line operation summary of a pending approval, in the order
 * command (with its separately supplied arguments) → title → description →
 * provider summary → tool name. The fields were already sanitized by the
 * approval boundary; this re-runs the shared one-line cleanup so a multi-line
 * command can never break a wake message or a callback body. `null` means the
 * provider published nothing usable.
 *
 * An EMPTY argument is kept (it is real argv data), so it is never silently
 * dropped from the summary or its count.
 */
export function approvalOperationSummary(approval: Pick<PendingApproval, "detail" | "summary" | "toolName">): string | null {
  const detail = approval.detail;
  const command = detail?.command ?? null;
  const args = Array.isArray(detail?.args) ? detail.args.filter((arg): arg is string => typeof arg === "string") : [];
  const candidate = command
    ? args.length
      ? `${command} ${summarizeApprovalArgs(args)}`
      : command
    : detail?.title ?? detail?.description ?? approval.summary ?? approval.toolName ?? null;
  const oneLine = sanitizeOneLineText(candidate, "");
  if (!oneLine) return null;
  return oneLine.length <= APPROVAL_OPERATION_CAP ? oneLine : oneLine.slice(0, APPROVAL_OPERATION_CAP);
}

/**
 * DISPLAY NOTATION for separately supplied argv inside the one-line summary —
 * not a runnable shell command line. Ordinary simple tokens (non-empty, no
 * whitespace, quotes, globs or shell metacharacters) join compactly, which is
 * the shape a human reads most easily; every other argument — an empty or
 * whitespace-only entry, a quoted or spaced value, a glob (`*`/`?`), or any
 * shell metacharacter — switches the whole list to an explicitly LABELLED JSON
 * array (`args:[…]`), so the summary cannot be mistaken for a command line
 * that would pass different arguments.
 *
 * The summary is a SINGLE LINE by contract: the shared one-line cleanup
 * collapses whitespace runs and drops line breaks, so it is notation only —
 * the exact argument bytes are shown on the approval card, not here.
 */
function summarizeApprovalArgs(args: readonly string[]): string {
  const simple = args.every((arg) => arg.length > 0 && !/[\s"'\\$`&|<>^%!;(){}[\]*?]/.test(arg));
  return simple ? args.join(" ") : `args:${JSON.stringify(args)}`;
}

/** The Dashboard deep link that opens this exact job (generation/request inform its presentation). */
export function approvalHubLink(hubUrl: string, approval: Pick<PendingApproval, "jobId" | "generation" | "requestId">): string {
  const base = hubUrl.replace(/\/+$/, "");
  return `${base}/ui?job=${encodeURIComponent(approval.jobId)}&generation=${approval.generation}&request=${encodeURIComponent(approval.requestId)}`;
}

// ---------------------------------------------------------------------------
// Bounded one-line sanitizer (shared with the terminal wake and stderr diagnostics)
// ---------------------------------------------------------------------------

/**
 * ANSI CSI / SGR escape sequences: ESC `[`, parameter bytes, intermediate
 * bytes, final byte (so `\u001b[31m` … `\u001b[0m` and friends). Matched on the
 * ESC introducer only — a literal bracketed token such as `[31m` with no ESC is
 * ordinary text and must survive.
 */
const ANSI_CSI_RE = /\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g;

/**
 * Strip ANSI CSI/SGR escape sequences, then NUL/control characters, and
 * collapse whitespace to a single line: the shared safe-output cleanup of
 * user-visible diagnostics (wake text, CLI stderr evidence). Stripping the
 * whole escape sequence (not just its control byte) is what keeps SGR residue
 * such as `[31m` out of durable diagnostics. Never used on the task.
 */
export function sanitizeOneLineText(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  const s = String(value)
    .replace(ANSI_CSI_RE, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || fallback;
}

// ---------------------------------------------------------------------------
// Approval wake orchestration (shared by every provider and every caller)
// ---------------------------------------------------------------------------

export interface DeliverApprovalOptions {
  /**
   * Origin tag of the recorded attempt, persisted in the result file:
   * `worker` is the production value today. An omitted/blank value is
   * persisted as null — an unknown origin is never invented.
   */
  by?: string;
  now?: () => Date;
}

/** Stable suppression codes for an approval identity that is no longer current. */
export type ApprovalSuppressionReason = "resolved" | "expired" | "cancelled" | "stale";

export interface PendingApprovalState {
  pending: PendingApproval;
  /** The target captured from the SAME record read (never re-read later). */
  target: NotifyTarget;
}

/**
 * Revalidate one approval identity against the CURRENT durable state:
 *   * the job exists, is honestly `running` and is on this exact generation;
 *   * its `pendingApproval` is the exact (job, generation, request) triple;
 *   * it was not cancelled and no decision has been claimed for it;
 *   * the request has not expired and is still materialized on disk.
 * Returns the validated pending approval plus the target captured from the SAME
 * record read, or the stable reason it must be suppressed. Never mutates
 * anything. It runs once BEFORE the claim and again immediately BEFORE the
 * transport call, because the awaited Hub endpoint proof takes time during
 * which the request can be resolved, replaced, cancelled or superseded.
 *
 * Exported so the bounded recovery path reuses the EXACT SAME validator
 * (current running generation, exact pending request, not expired / resolved /
 * cancelled) instead of a second approval-validity rule.
 */
export function revalidatePendingApproval(
  root: string,
  jobId: string,
  generation: number,
  requestId: string,
  nowMs: number
): { ok: true; state: PendingApprovalState } | { ok: false; reason: ApprovalSuppressionReason } {
  let job: JobRecord | null;
  try {
    job = loadJob(root, jobId);
  } catch {
    return { ok: false, reason: "stale" };
  }
  if (!job || job.status !== "running" || job.generation !== generation) return { ok: false, reason: "stale" };
  if (job.cancelIntent.requested) return { ok: false, reason: "cancelled" };
  const pending = job.pendingApproval;
  if (!pending || pending.jobId !== jobId || pending.generation !== generation || pending.requestId !== requestId) {
    return { ok: false, reason: "stale" };
  }
  if (readApprovalDecision(root, jobId, generation, requestId)) return { ok: false, reason: "resolved" };
  const expiresMs = Date.parse(pending.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return { ok: false, reason: "expired" };
  if (!readPendingApproval(root, jobId, generation, requestId)) return { ok: false, reason: "stale" };
  return { ok: true, state: { pending, target: job.notifyTarget } };
}

/**
 * Prove the live CrewDispatch Hub route that may produce an approval deep link:
 * a hardcoded port, a dead marker or a foreign listener never does. Without one
 * the approval stays visible in durable state and the attempt is recorded
 * honestly instead of sending a link nobody can use. Exported for the bounded
 * recovery path so it resolves the link through the SAME proof.
 */
export async function resolveProvenApprovalHub(root: string, deps: DeliveryDeps = {}): Promise<string | null> {
  try {
    return await resolveApprovalHubUrl(root, deps.env ?? process.env, deps.fetchFn ?? fetch);
  } catch {
    return null;
  }
}

/** Build the neutral approval event from an ALREADY VALIDATED pending snapshot. */
export function buildApprovalRequiredEvent(
  hubUrl: string,
  pending: PendingApproval
): ApprovalRequiredNotificationEvent {
  return {
    event: "approval_required",
    jobId: pending.jobId,
    generation: pending.generation,
    requestId: pending.requestId,
    provider: pending.provider,
    toolName: pending.toolName,
    operation: approvalOperationSummary(pending),
    cwd: sanitizeOneLineText(pending.detail?.cwd, "") || null,
    hubUrl: approvalHubLink(hubUrl, pending),
    expiresAt: pending.expiresAt
  };
}

/**
 * Attempt the ONE approval wake for `(jobId, generation, requestId)`.
 *
 * Returns the recorded result, or null when the identity was stale (suppressed
 * before claiming) or already claimed. Never throws. The target lives on the
 * job record (resolved at dispatch and persisted), exactly like the terminal
 * wake, so a detached worker never depends on the caller's inherited env — and
 * it is captured from the original request's own record read, never from a
 * later generation's record.
 */
export async function deliverApprovalNotification(
  root: string,
  jobId: string,
  generation: number,
  requestId: string,
  deps: DeliveryDeps = {},
  opts: DeliverApprovalOptions = {}
): Promise<ApprovalNotificationRecord | null> {
  const now = opts.now ?? deps.now ?? (() => new Date());
  const origin = typeof opts.by === "string" && opts.by.trim() ? opts.by.trim() : null;

  const initial = revalidatePendingApproval(root, jobId, generation, requestId, now().getTime());
  if (!initial.ok) return null;

  // The claim makes the wake at-most-once across repeat events / processes /
  // restarts; it is taken only AFTER the revalidation above.
  let claimed = false;
  try {
    claimed = claimApprovalNotificationAttempt(root, jobId, generation, requestId);
  } catch {
    return null;
  }
  if (!claimed) return null;

  // The ORIGINAL generation's target, captured from the same record read that
  // validated the request. A continuation may advance the record while the Hub
  // proof below is awaited; that newer generation's target must never receive
  // this older request's alert.
  const target = initial.state.target;

  // From here on the outcome is ALWAYS recorded diagnostically; no path may
  // throw out of this function or touch the job/approval/decision state.
  const record = (delivered: boolean, reason: string | null, phase: DeliveryPhase | null = null): ApprovalNotificationRecord => ({
    generation,
    requestId: requestId.length <= 128 ? requestId : requestId.slice(0, 128),
    kind: target.kind,
    attemptedAt: now().toISOString(),
    delivered,
    reason,
    by: origin,
    phase
  });
  const persist = (rec: ApprovalNotificationRecord): ApprovalNotificationRecord => {
    try {
      writeApprovalNotificationResult(root, jobId, generation, rec, now);
    } catch {
      /* the diagnostic is best-effort; the job/approval state stays untouched */
    }
    return rec;
  };

  if (target.kind === "none") return persist(record(false, "no_target"));

  // Only a currently PROVEN live CrewDispatch Hub may produce the link: a
  // hardcoded port, a dead marker or a foreign listener never does. Without
  // one the approval stays visible in durable state and the attempt is
  // recorded honestly instead of sending a link nobody can use.
  const hubUrl = await resolveProvenApprovalHub(root, deps);
  if (!hubUrl) return persist(record(false, "no_hub"));

  // The endpoint proof was AWAITED, so the request may have been resolved,
  // replaced, expired or cancelled, or the job may have advanced generations
  // while it ran. Revalidate the exact current identity immediately BEFORE the
  // transport call: the attempt is already claimed (request-level at-most-once,
  // never reopened and never retried), and a no-longer-current request is
  // recorded as a durable diagnostic instead of being delivered.
  const current = revalidatePendingApproval(root, jobId, generation, requestId, now().getTime());
  if (!current.ok) return persist(record(false, current.reason));

  const event = buildApprovalRequiredEvent(hubUrl, current.state.pending);

  const outcome = await deliverNotificationEvent(event, target, { ...deps, root });
  return persist(record(outcome.delivered, outcome.reason, outcome.phase ?? null));
}
