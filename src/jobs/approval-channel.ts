// approval-channel.ts — the SHARED provider-neutral interactive approval channel
// (see src/jobs/approval.ts for the file protocol the Hub and the worker use).
//
// A provider whose transport can pause a running turn for an explicit user
// decision (ACP `session/request_permission`, used by both the WorkBuddy
// Desktop bridge and the Command Code ACP bridge) owns the only connection that
// can answer that request. This module is that provider-side half:
//
//   1. extracts the provider's OWN bounded options (id/kind/label) AND its own
//      named operation fields from the request — never the request wholesale,
//      never environment or prompt text. The operation detail is bounded,
//      stripped of control sequences and credential-redacted by the shared
//      `sanitizeApprovalDetail` before it is written anywhere;
//   2. asks whether a live interactive Hub route exists; when it does not, the
//      provider keeps its historical fully non-interactive decline — and the
//      answer says WHY (no route / no allow option / publish failure), so the
//      durable result can distinguish it from a human rejection or an expiry;
//   3. writes ONE generation+request-scoped pending file and publishes the
//      bounded `approval` stream record the worker persists on the job;
//   4. waits (bounded) for the Hub's exclusive decision file and validates
//      it against THIS identity + the provider's published options;
//   5. resolves the wait on one answer, on expiry, or on teardown — always
//      clearing the pending file and publishing the resolved stream record.
//
// Every answer carries a bounded, evidence-backed OUTCOME (`ApprovalAnswer`):
// a real selected CANONICAL reject option, a proven expiry, a proven
// unavailable sub-cause, or an abandoned (cancelled/disposed) wait.
// `approvalOutcomeOfAnswer` maps it onto the canonical `ApprovalOutcome` token a
// bridge carries into its terminal result, and `mergeApprovalOutcome` keeps the
// most specific proven cause when one turn contained several gates. A selected
// option the canonical vocabulary does not recognize proves NO decision: its
// exact provider id is still echoed back, but it yields no token — the token is
// diagnostic evidence, never an inferred human rejection.
//
// The module is deliberately transport-agnostic: it knows the ACP permission
// SHAPE (optionId/kind/name), not any provider's product semantics. Each
// provider binds its own canonical id and evidence extractor.
import {
  APPROVAL_DEFAULT_TIMEOUT_MS,
  APPROVAL_KIND_CAP,
  APPROVAL_LABEL_CAP,
  APPROVAL_OPTION_MAX,
  APPROVAL_POLL_MS,
  canonicalApprovalKind,
  clearPendingApproval,
  normalizePendingApproval,
  readApprovalDecision,
  resolveApprovalHubUrl,
  safeApprovalText,
  safeApprovalToken,
  sanitizeApprovalDetail,
  writePendingApproval,
  type ApprovalOption,
  type ApprovalOutcome,
  type PendingApproval
} from "./approval";
import type { StreamState } from "../providers/provider";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The provider's own proven interactive gate evidence: a bounded tool name and
 * its own named operation detail, already reduced to the fields the shared
 * sanitizer understands. `detail` is `unknown` on purpose — it is never trusted
 * here; `sanitizeApprovalDetail` bounds, strips and redacts it.
 */
export interface ApprovalEvidence {
  kind: "tool_approval";
  toolName: string | null;
  detail: unknown;
}

/**
 * The provider's OWN published choices, bounded and sanitized. Only an
 * `optionId` the provider actually published can ever be echoed back in the
 * ACP reply; a missing/unsafe id is dropped rather than invented.
 */
export function approvalOptionsFromParams(params: unknown): ApprovalOption[] {
  const request = asRecord(params);
  const listed = Array.isArray(request?.options) ? request.options : [];
  const options: ApprovalOption[] = [];
  for (const raw of listed) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const id = safeApprovalToken(entry.optionId);
    if (!id || options.some((option) => option.id === id)) continue;
    options.push({
      id,
      kind: safeApprovalText(entry.kind, APPROVAL_KIND_CAP) ?? "unknown",
      label: safeApprovalText(entry.name, APPROVAL_LABEL_CAP) ?? id
    });
    if (options.length >= APPROVAL_OPTION_MAX) break;
  }
  return options;
}

/** An interactive wait is only offered when the provider published an allow choice. */
export function approvalOptionsOfferAllow(options: readonly ApprovalOption[]): boolean {
  return options.some((option) => {
    const kind = canonicalApprovalKind(option.kind);
    return kind === "allow_once" || kind === "allow_always";
  });
}

export function approvalPendingRecord(approval: PendingApproval): Record<string, unknown> {
  return { type: "approval", phase: "pending", approval };
}

export function approvalResolvedRecord(input: {
  requestId: string;
  optionId: string | null;
  decision: "selected" | "expired" | "disposed" | "cancelled";
}): Record<string, unknown> {
  return {
    type: "approval",
    phase: "resolved",
    request_id: input.requestId,
    option_id: input.optionId,
    decision: input.decision
  };
}

/**
 * Apply ONE bridge `{"type":"approval",...}` stream line to the canonical
 * parse state. Returns true when the line was an approval record (so the
 * shared provider parser never sees it as malformed/unknown). The pending
 * object is re-normalized here: a malformed record can never become an
 * actionable UI state.
 */
export function applyApprovalStreamLine(line: string, state: StreamState): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  const record = asRecord(parsed);
  if (!record || record.type !== "approval") return false;
  if (record.phase === "pending") {
    // A well-formed pending record REPLACES the current state; a malformed one
    // clears it. Keeping a previous approval visible for a request this record
    // just superseded would present a stale decision surface.
    state.approval = normalizePendingApproval(record.approval);
    return true;
  }
  if (record.phase === "resolved") {
    const requestId = safeApprovalText(record.request_id, 128);
    if (!requestId) return true;
    // A resolved record for a DIFFERENT request can never clear the current
    // one: only the exact pending request may be retired.
    if (state.approval && state.approval.requestId !== requestId) return true;
    state.approval = null;
    return true;
  }
  return true;
}

export interface ApprovalChannelIdentity {
  jobId: string;
  generation: number;
  dataRoot: string;
  /** Canonical provider id persisted on the pending approval. */
  provider: string;
}

export interface ApprovalChannelOptions {
  /** Publish the bounded bridge stream records (the bridge's NDJSON `emit`). */
  emit?: (record: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Bounded override for tests/boundaries; defaults to the shared one hour. */
  timeoutMs?: number;
  pollMs?: number;
}

export type ApprovalAnswer =
  | {
      kind: "selected";
      /** The provider's own option id, echoed verbatim into the ACP reply. */
      optionId: string;
      /**
       * True only when that option is provably an ALLOW choice (allow_once /
       * allow_always). A provider-declined choice keeps the remembered gate
       * evidence so the resulting turn still classifies as the permission
       * interruption rather than an ordinary cancellation.
       */
      allows: boolean;
      /**
       * True only when that option is provably a CANONICAL reject choice
       * (reject_once / reject_always / the documented synonyms). It is the
       * explicit classification evidence for a human rejection: a
       * provider-owned UNKNOWN kind is neither an allow nor a reject, so it
       * keeps the conservative gate behavior and never becomes `rejected`.
       */
      rejects: boolean;
    }
  | {
      kind: "declined";
      reason: "unavailable";
      /**
       * The PROVEN sub-cause of an unavailable approval route, so the durable
       * result can say WHICH route was missing instead of collapsing every
       * non-decision into one generic decline:
       *   - `no_route`        — no live interactive Hub route answered the probe;
       *   - `no_allow_option` — the provider published no allow choice to offer;
       *   - `publish_failed`  — the pending request could not be written (a
       *                         local protocol/filesystem failure).
       */
      cause: ApprovalUnavailableCause;
    }
  | { kind: "declined"; reason: "expired" }
  | { kind: "declined"; reason: "disposed" };

/** The evidence-backed sub-causes of an `unavailable` approval answer. */
export type ApprovalUnavailableCause = "no_route" | "no_allow_option" | "publish_failed";

/**
 * The canonical outcome token of ONE answer, or null when the answer proves no
 * interruption to explain (an ALLOW satisfied the gate; a selected UNKNOWN
 * option kind proves no canonical decision at all).
 *
 * Only a real `selected` CANONICAL reject option becomes `rejected` (the
 * answer's own explicit `rejects` classification, computed from the
 * provider-published option KIND — never from its id, label or prose): a
 * decline is never promoted to a human decision, and an unknown kind is never
 * assumed to be a rejection. `expired` and `cancelled` come from the channel's
 * own proven resolution, and the `unavailable` causes are carried verbatim.
 */
export function approvalOutcomeOfAnswer(answer: ApprovalAnswer): ApprovalOutcome | null {
  if (answer.kind === "selected") return answer.rejects ? "rejected" : null;
  if (answer.reason === "expired") return "expired";
  if (answer.reason === "disposed") return "cancelled";
  return answer.cause;
}

/**
 * Specificity order of the outcome tokens, strongest first. ONE provider turn
 * may contain several unresolved gates; the durable result carries the most
 * specific PROVEN cause (a human decision beats a deadline, a deadline beats a
 * missing route, and an abandoned wait is the weakest):
 *
 *   rejected (5) > expired (4) > unavailable causes (3) > cancelled (2)
 *
 * Ties keep the FIRST observed cause, so the summary is stable and never
 * invents an ordering between equally specific unavailable sub-causes.
 */
const APPROVAL_OUTCOME_RANK: Readonly<Record<ApprovalOutcome, number>> = {
  rejected: 5,
  expired: 4,
  no_route: 3,
  no_allow_option: 3,
  publish_failed: 3,
  cancelled: 2
};

/** Merge ONE newly proven outcome into the turn's current one (see the rank note). */
export function mergeApprovalOutcome(current: ApprovalOutcome | null, next: ApprovalOutcome | null): ApprovalOutcome | null {
  if (!next) return current;
  if (!current) return next;
  return APPROVAL_OUTCOME_RANK[next] > APPROVAL_OUTCOME_RANK[current] ? next : current;
}

function boundedTimeout(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 250) return APPROVAL_DEFAULT_TIMEOUT_MS;
  return Math.min(n, 60 * 60_000);
}

/**
 * ONE bridge-owned interactive approval wait. The channel is inert when no Hub
 * route answers the probe, so a fully unattended run keeps the exact historical
 * decline behavior.
 */
export class ApprovalChannel {
  /** Terminal for the channel: set on bridge teardown. */
  private disposed = false;
  /** The ONE wait this channel may currently own (null between requests). */
  private active: { requestId: string; cancelled: boolean } | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly identity: ApprovalChannelIdentity,
    private readonly options: ApprovalChannelOptions = {}
  ) {}

  /**
   * Ask for one decision. Resolves with the provider's own option id when the
   * user selected one, else a safe decline. Never throws: any protocol/IO
   * failure degrades to the historical decline.
   */
  async request(requestId: string, evidence: ApprovalEvidence, params: unknown): Promise<ApprovalAnswer> {
    if (this.disposed) return { kind: "declined", reason: "disposed" };
    const options = approvalOptionsFromParams(params);
    if (!approvalOptionsOfferAllow(options)) {
      return { kind: "declined", reason: "unavailable", cause: "no_allow_option" };
    }
    // The provider's own operation fields, bounded/redacted by the shared
    // boundary before they can be written. Null when nothing usable was
    // published, so the UI can say so honestly.
    const detail = sanitizeApprovalDetail(evidence.detail);
    const root = this.identity.dataRoot;
    const env = this.options.env ?? process.env;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let approval: PendingApproval;
    try {
      const hubUrl = await resolveApprovalHubUrl(root, env, fetchImpl);
      if (!hubUrl || this.disposed) {
        return this.disposed
          ? { kind: "declined", reason: "disposed" }
          : { kind: "declined", reason: "unavailable", cause: "no_route" };
      }
      const now = this.options.now ?? (() => new Date());
      const createdAt = now();
      const expiresAt = new Date(createdAt.getTime() + boundedTimeout(this.options.timeoutMs));
      approval = writePendingApproval(root, {
        version: 1,
        kind: "tool_approval",
        provider: this.identity.provider,
        jobId: this.identity.jobId,
        generation: this.identity.generation,
        requestId,
        toolName: evidence.toolName ?? null,
        summary: null,
        detail,
        options,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString()
      });
    } catch {
      // A protocol or filesystem failure is an honest "no interactive route":
      // the provider keeps the historical safe decline. The proven sub-cause is
      // that the request could not be published, not that the user declined.
      return { kind: "declined", reason: "unavailable", cause: "publish_failed" };
    }

    this.active = { requestId: approval.requestId, cancelled: false };
    const deadline = Date.parse(approval.expiresAt);
    try {
      this.options.emit?.(approvalPendingRecord(approval));
      for (;;) {
        // dispose() has already cleared the file and published the resolution;
        // settling again would emit a duplicate record for the same request.
        if (this.disposed) return { kind: "declined", reason: "disposed" };
        if (this.active?.cancelled) return this.settle(approval, null, "cancelled");
        const decision = readApprovalDecision(root, approval.jobId, approval.generation, approval.requestId);
        if (decision) {
          // The reply may only ever use an option THIS request published; an
          // unknown option is treated as a stale/foreign decision and ignored.
          if (approval.options.some((option) => option.id === decision.optionId)) {
            return this.settle(approval, decision.optionId, "selected");
          }
        }
        if (Date.now() >= deadline) return this.settle(approval, null, "expired");
        await this.sleep(this.options.pollMs ?? APPROVAL_POLL_MS);
      }
    } finally {
      clearPendingApproval(root, approval.jobId, approval.generation, approval.requestId);
      if (this.active?.requestId === approval.requestId) this.active = null;
    }
  }

  /**
   * Abandon the CURRENT wait without retiring the channel: the prompt turn that
   * owned the gate is over, so the pending file is cleared and the resolved
   * record published. The connection may still serve a later prompt turn.
   */
  cancel(): void {
    if (!this.active) return;
    this.active.cancelled = true;
    this.wake?.();
  }

  /**
   * Bridge teardown: cancel the wait for good, clear the pending file and
   * publish the resolved record. Called on ACP close/SIGTERM, so a pending
   * approval can never outlive the provider connection it belongs to.
   * Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.active;
    if (active) {
      clearPendingApproval(this.identity.dataRoot, this.identity.jobId, this.identity.generation, active.requestId);
      this.options.emit?.(approvalResolvedRecord({ requestId: active.requestId, optionId: null, decision: "disposed" }));
      this.active = null;
    }
    this.wake?.();
  }

  private settle(
    approval: PendingApproval,
    optionId: string | null,
    decision: "selected" | "expired" | "disposed" | "cancelled"
  ): ApprovalAnswer {
    clearPendingApproval(this.identity.dataRoot, approval.jobId, approval.generation, approval.requestId);
    if (this.active?.requestId === approval.requestId) this.active = null;
    this.options.emit?.(approvalResolvedRecord({ requestId: approval.requestId, optionId, decision }));
    if (decision === "selected" && optionId) {
      // The decision class comes ONLY from the provider-published option KIND
      // mapped onto the canonical vocabulary. An unknown kind is neither an
      // allow nor a reject: its exact id is still echoed back, but no human
      // intent is inferred from it.
      const canonical = canonicalApprovalKind(approval.options.find((option) => option.id === optionId)?.kind);
      return {
        kind: "selected",
        optionId,
        allows: canonical === "allow_once" || canonical === "allow_always",
        rejects: canonical === "reject_once"
      };
    }
    return { kind: "declined", reason: decision === "expired" ? "expired" : "disposed" };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
