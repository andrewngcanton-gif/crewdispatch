// workbuddy-terminal-records.ts — the EXACT terminal records of the WorkBuddy
// ACP result-semantics regression (JQ-20261001-14).
//
// The refusal record is the observed live bridge terminal record of JobQuay job
// `job-mupa72lp-k2iinx` (WorkBuddy model deepseek-v4.1-flash): the ACP turn
// returned `stop_reason=refusal` with no assistant text, yet the pre-fix bridge
// stamped every transport completion as `subtype:"success" / is_error:false`,
// so JobQuay persisted `status=done` with `finalText=null`. The four contract
// fields of that exact shape are: subtype=success, is_error=false,
// stop_reason=refusal, result=null — and it must never end as done again.
//
// The end_turn record is the SUCCESS CONTROL: a normal completion with a real
// assistant text, which must keep ending as `done` with its own text.
//
// JQ-20261001-23 adds the two EXACT refusal records of the finish-reason-aware
// bridge: the installed WorkBuddy runtime maps BOTH `finish_reason=content_filter`
// and `finish_reason=refusal` to ACP `stopReason=refusal`, and publishes the
// original token as `_meta["codebuddy.ai/finishReason"]` on the prompt result.
// The bridge preserves it as the record's bounded `finish_reason`; the literal
// records below are the exact shapes it writes (result=null, no assistant text).
//
// JQ-20261001-24 adds the EXACT refusal-with-detail and model-error records:
//   - the installed runtime (cli/dist/codebuddy-headless.js, WorkBuddy Desktop
//     5.6.2) publishes `_meta["codebuddy.ai/errorMessage"]` on the prompt
//     result — on the exception/refusal paths the JSON-encoded classified error
//     response (`JSON.stringify(classifyErrorAsRequestError(e).toErrorResponse())`,
//     shape `{code,message,data}`); the bridge preserves ONLY the safe bounded
//     message as the record's `error_detail`;
//   - when its own terminal event proves `finish_reason=error`, the runtime
//     REJECTS session/prompt as a JSON-RPC error (code -32004,
//     `data.reason=provider_finish_reason_error`) instead of resolving a stop
//     reason; the bridge classifies that as `provider_model_error` (exit 16)
//     and preserves the proven `finish_reason=error`.
//
// JQ-20261002-43 adds the EXACT observed MISSING-finish-reason quota record:
// the provider's own refusal carried the bounded `Quota exceeded: 429 usage
// exceeds frequency limit…` detail with NO finish reason, and the pre-fix
// classifier wrongly required `tool_calls`, persisting an actual quota as
// `provider_refusal`. The record below is the fixed bridge's exact output.
import {
  ACP_FAILURE_MODEL_ERROR,
  ACP_FAILURE_PERMISSION_REQUIRED,
  ACP_FAILURE_RATE_LIMIT,
  ACP_FAILURE_REFUSAL,
  acpInitRecord
} from "../../providers/workbuddy-ai/acp-normalizer";

export const WORKBUDDY_TERMINAL_FIXTURE_MODEL = "deepseek-v4.1-flash";
export const WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID = "01a0ecaf-aa3e-799c-90ea-7680e8184d7e";

/** The assistant text of the normal end_turn success control. */
export const WORKBUDDY_END_TURN_TEXT = "WB_END_TURN_OK";

/** Provider text a refusal may carry instead of an answer. */
export const WORKBUDDY_REFUSAL_TEXT = "I can't help with that request.";

/**
 * The EXACT observed refusal terminal record (JQ-20261001-14). This is the
 * record the pre-fix bridge wrote and JobQuay persisted as `done`; the
 * regression replays it through the production WorkBuddy adapter and service.
 */
export const WORKBUDDY_OBSERVED_REFUSAL_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "success",
  result: null,
  stop_reason: "refusal",
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  is_error: false
});

/** The same refusal shape, but the provider DID deliver text the turn produced. */
export const WORKBUDDY_REFUSAL_TEXT_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "success",
  result: WORKBUDDY_REFUSAL_TEXT,
  stop_reason: "refusal",
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  is_error: false
});

/**
 * The EXACT content-filter refusal record (JQ-20261001-23): the installed
 * runtime's `finish_reason=content_filter` arrives as ACP `stopReason=refusal`,
 * and the bridge preserves the token as `finish_reason`. It must be a
 * `provider_refusal` — but its diagnostic must say the provider content filter
 * blocked the response, never a bare generic refusal.
 */
export const WORKBUDDY_CONTENT_FILTER_MESSAGE =
  "WorkBuddy AI's content filter blocked this response (stop_reason=refusal, finish_reason=content_filter); " +
  "no task result was produced.";

export const WORKBUDDY_CONTENT_FILTER_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "refusal",
  finish_reason: "content_filter",
  result: null,
  error: { code: ACP_FAILURE_REFUSAL, message: WORKBUDDY_CONTENT_FILTER_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/**
 * The EXACT explicit-refusal record (JQ-20261001-23): the provider reported
 * `finish_reason=refusal` — the model itself refused, with no content filter.
 * Its diagnostic must say exactly that, while the classification stays the same
 * stable `provider_refusal`.
 */
export const WORKBUDDY_EXPLICIT_REFUSAL_MESSAGE =
  "WorkBuddy AI explicitly refused this request (stop_reason=refusal, finish_reason=refusal); " +
  "no task result was produced.";

export const WORKBUDDY_EXPLICIT_REFUSAL_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "refusal",
  finish_reason: "refusal",
  result: null,
  error: { code: ACP_FAILURE_REFUSAL, message: WORKBUDDY_EXPLICIT_REFUSAL_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/**
 * The EXACT observed prompt-result `_meta` shape of the installed runtime's
 * refusal path (WorkBuddy Desktop 5.6.2,
 * `cli/dist/codebuddy-headless.js`): the classified error response is
 * JSON-encoded into `codebuddy.ai/errorMessage` — `{code,message,data}` with
 * internal `data` fields that must never reach durable state or the UI. The
 * bridge extracts ONLY the message as the safe `error_detail`.
 */
export const WORKBUDDY_REFUSAL_SAFE_DETAIL = "Model service error: upstream content policy";

export const WORKBUDDY_REFUSAL_RAW_ERROR_MESSAGE = JSON.stringify({
  code: -32004,
  message: WORKBUDDY_REFUSAL_SAFE_DETAIL,
  data: { category: "model_service", statusCode: 500, bizCode: "internal-must-not-leak" }
});

/**
 * Sanitized recorded-shape ACP prompt result for JQ-20261002-32. The volatile
 * reset timestamp is replaced; the decision-bearing fields remain exactly the
 * provider's `stopReason` and `_meta` values. No job id or credential is kept.
 */
export const WORKBUDDY_QUOTA_ERROR_DETAIL =
  "Quota exceeded: 429 usage exceeds frequency limit, but usage resets at <reset-time>; " +
  "alternatively, switch models to continue using it.";

export const WORKBUDDY_QUOTA_ACP_PROMPT_RESULT = Object.freeze({
  stopReason: "refusal",
  _meta: Object.freeze({
    "codebuddy.ai/finishReason": "tool_calls",
    "codebuddy.ai/errorMessage": WORKBUDDY_QUOTA_ERROR_DETAIL
  })
});

export const WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE =
  "WorkBuddy AI reported a quota/frequency rate limit (429); the configured fallback may be tried.";

/** Expected terminal record after the production normalizer processes the recorded ACP response. */
export const WORKBUDDY_QUOTA_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "refusal",
  finish_reason: "tool_calls",
  error_detail: WORKBUDDY_QUOTA_ERROR_DETAIL,
  result: null,
  error: { code: ACP_FAILURE_RATE_LIMIT, message: WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/**
 * The EXACT observed missing-finish-reason quota shape (JQ-20261002-43).
 *
 * Job `job-muqxgzqn-8k2k0g` failed 2026-10-02 after ~8 s with the provider's
 * own refusal and NO `finish_reason`; its bounded `error_detail` began exactly
 * `Quota exceeded: 429 usage exceeds frequency limit` and continued with the
 * reset instant and the switch-models suggestion. The pre-fix classifier
 * required `finish_reason=tool_calls`, so the actual quota was persisted as
 * `provider_refusal` (exit 11) with `fallback_eligible:false` and the
 * configured fallback was never tried.
 *
 * The volatile reset instant is normalized to `<reset-time>` (the provider
 * wording and the decision-bearing prefix stay exact); no job/session id is
 * kept beyond the shared fixture session constant.
 */
export const WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL =
  "Quota exceeded: 429 usage exceeds frequency limit, but don't worry, your usage resets at <reset-time>, " +
  "alternatively, you can switch to the other models to continue using it.";

export const WORKBUDDY_QUOTA_MISSING_FINISH_ACP_PROMPT_RESULT = Object.freeze({
  stopReason: "refusal",
  _meta: Object.freeze({
    "codebuddy.ai/errorMessage": WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL
  })
});

/**
 * Expected terminal record of the observed missing-finish quota shape: the
 * canonical shared rate-limit classification (exit 5), the provider's raw stop
 * reason and bounded detail preserved, and NO invented `finish_reason`.
 */
export const WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "refusal",
  error_detail: WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
  result: null,
  error: { code: ACP_FAILURE_RATE_LIMIT, message: WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/**
 * The EXACT refusal record of the detail-aware bridge (JQ-20261001-24): the
 * stable provider_refusal classification and the content_filter finish reason
 * are unchanged; the safe bounded provider detail is added as `error_detail`.
 */
export const WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "refusal",
  finish_reason: "content_filter",
  error_detail: WORKBUDDY_REFUSAL_SAFE_DETAIL,
  result: null,
  error: { code: ACP_FAILURE_REFUSAL, message: WORKBUDDY_CONTENT_FILTER_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/** The bridge's message for the proven JSON-RPC model-service error. */
export const WORKBUDDY_MODEL_ERROR_MESSAGE =
  "WorkBuddy AI's model service ended the response with an error (finish_reason=error); the task did not complete.";

/**
 * The EXACT terminal record of the proven model-service error (JQ-20261001-24):
 * the installed runtime rejects session/prompt with
 * `data.finishReason=error` / `data.reason=provider_finish_reason_error`; the
 * bridge emits this classified record (subtype error, stable
 * provider_model_error code, the proven bounded finish reason) and exits 16.
 */
export const WORKBUDDY_MODEL_ERROR_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: ACP_FAILURE_MODEL_ERROR,
  finish_reason: "error",
  result: null,
  error: { code: ACP_FAILURE_MODEL_ERROR, message: WORKBUDDY_MODEL_ERROR_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/** The success control: a genuine end_turn completion with its own result text. */
export const WORKBUDDY_END_TURN_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "success",
  result: WORKBUDDY_END_TURN_TEXT,
  stop_reason: "end_turn",
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  is_error: false
});

// ---------------------------------------------------------------------------
// JQ-20261001-25: the declined high-risk tool-approval gate
// ---------------------------------------------------------------------------

/**
 * The EXACT `session/request_permission` params of the live high-risk case
 * (job `job-mupil5r4-pd51wy`: toolCallId and command text verbatim, session id
 * normalized to the fixture session; replayed against the installed WorkBuddy
 * Desktop 5.6.2 runtime):
 *
 *   [tool-permission] ASK tool=Bash mode=bypassPermissions
 *     reason={"type":"toolValidation","message":"High-risk command safety check"}
 *     message="High-risk command requires explicit approval"
 *
 * The job's WorkBuddy log announces that internal decision reason, but the ACP
 * transport does NOT carry it: the params below are the COMPLETE wire shape —
 * options, toolCall (toolCallId, rawInput, `codebuddy.ai/toolName`) and the
 * request `_meta`. An ordinary Bash permission ask has the same wire shape,
 * which is why the remembered evidence is exactly "WorkBuddy demanded an
 * interactive tool approval" and nothing about the tool's arguments.
 */
export const WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS: Readonly<Record<string, unknown>> = Object.freeze({
  sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  options: [
    { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
    { kind: "allow_once", name: "Allow", optionId: "allow" },
    { kind: "reject_once", name: "Reject", optionId: "reject" }
  ],
  toolCall: {
    toolCallId: "call_00_ET_iPVtBbC4rp0duL0w80pM3477",
    rawInput: {
      command:
        'cd "C:/Users/TestUser/AppData/Local/Temp" && rm -rf wb-main && node jq-asar-extract.cjs ' +
        '"C:/Program Files/WorkBuddy/resources/app.asar" "main/" wb-main ".js" && du -sh wb-main',
      description: "Extract main/*.js and find finishReason"
    },
    _meta: { "codebuddy.ai/toolName": "Bash" }
  },
  _meta: { "codebuddy.ai/requestId": "01a0f7b6-38ae-7482-a22b-ee9142086081" }
});

/** The bridge's message for a declined WorkBuddy interactive approval gate. */
export const WORKBUDDY_PERMISSION_REQUIRED_MESSAGE =
  "WorkBuddy AI required an interactive approval for a tool action, and JobQuay is non-interactive, so the run stopped " +
  "(stop_reason=cancelled, finish_reason=tool_calls); the task did not complete.";

/**
 * The EXACT terminal record of the declined approval gate (JQ-20261001-25):
 * JobQuay answered `cancelled` and the runtime completed the prompt with
 * `stopReason=cancelled, finishReason=tool_calls` — the bridge classifies it as
 * `provider_permission_required` (exit 17), never as `provider_cancelled`.
 */
export const WORKBUDDY_PERMISSION_REQUIRED_RESULT_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  type: "result",
  subtype: "error",
  is_error: true,
  stop_reason: "cancelled",
  finish_reason: "tool_calls",
  result: null,
  error: { code: ACP_FAILURE_PERMISSION_REQUIRED, message: WORKBUDDY_PERMISSION_REQUIRED_MESSAGE },
  session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
});

/**
 * The bridge's stdout lines for one terminal record (the run-start init record
 * followed by the terminal record), exactly as the bridge writes them.
 */
export function workbuddyTerminalLines(
  record: Readonly<Record<string, unknown>>,
  model: string = WORKBUDDY_TERMINAL_FIXTURE_MODEL
): string[] {
  return [
    JSON.stringify(acpInitRecord(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, model)),
    JSON.stringify(record)
  ];
}
