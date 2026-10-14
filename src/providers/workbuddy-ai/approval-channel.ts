// approval-channel.ts — the WorkBuddy AI binding of the SHARED provider-neutral
// interactive approval channel (src/jobs/approval-channel.ts).
//
// The channel implementation, the ACP permission-shape extraction and the
// canonical approval stream records are provider-neutral and now live in the
// shared jobs layer, because the Command Code ACP bridge needs exactly the same
// protocol (one product, one implementation). This module keeps the historical
// WorkBuddy import surface — including the WorkBuddy canonical provider id —
// so the Desktop bridge, the provider adapter and the tests are unchanged.
//
// See src/jobs/approval-channel.ts for the full behavioural contract and
// src/jobs/approval.ts for the shared file protocol the Hub/worker use.
export {
  ApprovalChannel,
  applyApprovalStreamLine,
  approvalOptionsFromParams,
  approvalOptionsOfferAllow,
  approvalOutcomeOfAnswer,
  approvalPendingRecord,
  approvalResolvedRecord,
  mergeApprovalOutcome,
  type ApprovalAnswer,
  type ApprovalChannelIdentity,
  type ApprovalChannelOptions,
  type ApprovalEvidence,
  type ApprovalUnavailableCause
} from "../../jobs/approval-channel";
export type { ApprovalOutcome } from "../../jobs/approval";

/** The canonical provider id persisted on WorkBuddy pending approvals. */
export const WORKBUDDY_APPROVAL_PROVIDER_ID = "workbuddy-ai";
