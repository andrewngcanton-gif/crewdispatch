// messages.ts — the bounded, display-safe text of a Claude session wake.
//
// All messages are ONE line, never carry the task/result/transcript or a
// credential, and reuse the shared one-line sanitizer and approval-operation
// cap from src/jobs/notifications.ts. The terminal text asks for exactly ONE
// result collection; the approval text says the job is NOT finished, forbids a
// result call and forbids automatic approval, and carries the proven Dashboard
// link; the RECOVERED terminal text is identifiable as a recovery and asks for
// the result ONLY conditionally (never repeating the unconditional "exactly
// once" wording). The native inbox frame shape itself lives in transport.ts.
import {
  APPROVAL_OPERATION_CAP,
  sanitizeOneLineText,
  type ApprovalRequiredNotificationEvent
} from "../jobs/notifications";

/** Hard cap on the terminal wake message (mirrors the Codex wake bound). */
export const CLAUDE_WAKE_MESSAGE_CAP = 200;

/**
 * Hard cap on the approval wake message: the complete Dashboard link plus the
 * bounded identity/guidance must always fit (same budget rationale as the
 * Codex approval wake; the link is never truncated).
 */
export const CLAUDE_APPROVAL_WAKE_MESSAGE_CAP = 2048;

/**
 * Hard cap on the RECOVERED terminal message. It is longer than the original
 * terminal text on purpose: it must identify itself as a recovery, carry the
 * job AND the run number, and keep the CONDITIONAL collection request — for a
 * worst-case 128-char job id plus status. It stays a single compact line.
 */
export const CLAUDE_RECOVERY_WAKE_MESSAGE_CAP = 480;

/**
 * The terminal wake text: job id + status + a one-shot collection hint. It is
 * ALWAYS <= CLAUDE_WAKE_MESSAGE_CAP chars and never contains the task, result,
 * transcript or a credential.
 */
export function buildClaudeWakeMessage(jobId: string, status: string): string {
  const head = "CrewDispatch job ";
  const mid = " finished with status ";
  const tail = ". ";
  const hintHead = 'Call crewdispatch_result(id="';
  const hintTail = '") exactly once to collect the result (legacy: jobquay_result).';
  const overhead = head.length + mid.length + tail.length + hintHead.length + hintTail.length;
  const id = sanitizeOneLineText(jobId, "unknown");
  const st = sanitizeOneLineText(status, "unknown");
  const render = (i: string, s: string): string => `${head}${i}${mid}${s}${tail}${hintHead}${i}${hintTail}`;
  const full = render(id, st);
  if (full.length <= CLAUDE_WAKE_MESSAGE_CAP) return full;
  const budget = CLAUDE_WAKE_MESSAGE_CAP - overhead;
  let statusLen = Math.min(st.length, budget);
  let idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  if (statusLen < st.length) {
    statusLen = Math.min(8, st.length);
    idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  }
  return render(id.slice(0, idLen), st.slice(0, statusLen));
}

/**
 * The RECOVERED terminal wake text — sent only by the bounded local recovery
 * path, only after the ORIGINAL attempt provably never began writing to this
 * session's inbox. It is one line and ALWAYS <=
 * CLAUDE_RECOVERY_WAKE_MESSAGE_CAP chars.
 *
 * Deliberate properties:
 *   - IDENTIFIABLE: it states that the job finished while this conversation was
 *     closed and that the original notice was not delivered;
 *   - job + run identity (the human run number is `generation + 1`, matching the
 *     Dashboard and the approval wake);
 *   - CONDITIONAL: with `collected === false` it asks for ONE result collection
 *     ONLY IF the result has not already been collected; with `collected ===
 *     true` it asks for nothing. It never repeats the original unconditional
 *     "exactly once" instruction;
 *   - never the task, result text, transcript or a credential.
 */
export function buildClaudeRecoveryWakeMessage(jobId: string, generation: number, status: string, collected: boolean): string {
  const id = sanitizeOneLineText(jobId, "unknown");
  const st = sanitizeOneLineText(status, "unknown");
  const run = Number.isInteger(generation) && generation >= 0 ? generation + 1 : 1;
  const head = "CrewDispatch recovery: job ";
  const mid = ` run ${run} finished with status `;
  const why = " while this conversation was closed; its original notice was not delivered. ";
  const askHead = 'If this result has not already been collected, call crewdispatch_result(id="';
  const askTail = '") once to collect it (legacy: jobquay_result).';
  const doneText = "Its result was already collected in this conversation; no action is required.";
  const overhead = head.length + mid.length + why.length + (collected ? doneText.length : askHead.length + askTail.length);
  const render = (i: string, s: string): string =>
    collected
      ? `${head}${i}${mid}${s}${why}${doneText}`
      : `${head}${i}${mid}${s}${why}${askHead}${i}${askTail}`;
  const full = render(id, st);
  if (full.length <= CLAUDE_RECOVERY_WAKE_MESSAGE_CAP) return full;
  const budget = Math.max(0, CLAUDE_RECOVERY_WAKE_MESSAGE_CAP - overhead);
  let statusLen = Math.min(st.length, budget);
  let idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  if (statusLen < st.length) {
    statusLen = Math.min(8, st.length);
    idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  }
  return render(id.slice(0, idLen), st.slice(0, statusLen));
}

/**
 * The approval wake text: job/run identity, the essential "NOT finished / do
 * not collect a result / do not approve automatically" guidance, the complete
 * proven Dashboard link and an honest bounded operation summary. It never
 * contains a result-collection instruction, the task, transcript, credentials
 * or raw provider payload; only the operation text may be clipped, and then
 * with an explicit `[truncated]` mark.
 */
export function buildClaudeApprovalWakeMessage(event: ApprovalRequiredNotificationEvent): string {
  const id = sanitizeOneLineText(event.jobId, "unknown");
  const generation = Number.isInteger(event.generation) && event.generation >= 0 ? event.generation : 0;
  const link = sanitizeOneLineText(event.hubUrl, "");
  const rawOperation = sanitizeOneLineText(event.operation, "");
  const head = `CrewDispatch job ${id} run ${generation + 1} is waiting for human approval (not finished). `;
  const guidance = `Do not call crewdispatch_result and do not approve automatically; show the human this decision and let them resolve it in the Dashboard: ${link} `;
  const prefix = "Operation: ";
  const truncatedMark = " [truncated]";
  if (!rawOperation) {
    return `${head}${guidance}${prefix}not provided by the provider.`;
  }
  const available = CLAUDE_APPROVAL_WAKE_MESSAGE_CAP - head.length - guidance.length - prefix.length - truncatedMark.length;
  const maxOperation = Math.min(APPROVAL_OPERATION_CAP, Math.max(1, available));
  return rawOperation.length <= maxOperation
    ? `${head}${guidance}${prefix}${rawOperation}`
    : `${head}${guidance}${prefix}${rawOperation.slice(0, maxOperation)}${truncatedMark}`;
}
