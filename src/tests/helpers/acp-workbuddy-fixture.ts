// acp-workbuddy-fixture.ts — ONE recorded-shape ACP conversation used by the
// WorkBuddy adapter tests and the Hub activity test.
//
// The updates below use only fields of the installed WorkBuddy ACP vocabulary
// (`sessionUpdate` kinds, `content.text`, `messageId`, `toolCallId`, `title`,
// `kind`, `status`, `content`, `rawInput`, `rawOutput`, and the usage frame's
// `used` / `size` / `cost` / `_meta` identity + raw usage snapshot). Nothing
// here is model-specific: the whole point of the adapter contract is that the
// SAME sequence must normalize identically under ANY model id, which is why the
// fixture is driven under two ids by the model-independence regression.
import { acpInitRecord, acpSuccessResultRecord, createAcpNormalizer, type AcpNormalizer } from "../../providers/workbuddy-ai/acp-normalizer";

/** The prompt the fixture conversation answers. */
export const ACP_FIXTURE_PROMPT = "Read the workspace file and report.";

/** Marks the reasoning text; it must never reach the default Hub view. */
export const ACP_FIXTURE_THOUGHT = "Let me look at the workspace first.";
/** Marks the assistant answer, split across several streamed chunks. */
export const ACP_FIXTURE_ANSWER = "I'll read the workspace file now.";
/** Marks the second assistant answer of the same turn. */
export const ACP_FIXTURE_ANSWER_TAIL = "The file lists three entries.";

/** The full assistant text the ACP stream delivered, in order. */
export const ACP_FIXTURE_ASSISTANT_TEXT = ACP_FIXTURE_ANSWER + ACP_FIXTURE_ANSWER_TAIL;

/** The tool results the fixture's tools produced. */
export const ACP_FIXTURE_TOOL_RESULT = "Read 1/1 file, 42 lines";
/** Content streamed by a tool that never reported a completion. */
export const ACP_FIXTURE_TOOL_PROGRESS = "scanning files…";
export const ACP_FIXTURE_TOOL_FAILURE = "command exited 1: boom";

/**
 * The usage evidence a real WorkBuddy Desktop turn publishes through
 * `usage_update` (shape read locally from the installed AcpUsagePublisher):
 * `used` = the latest request's context occupancy, `size` = the model's context
 * window, `cost.amount` = the credits that response consumed, and
 * `_meta.usage` = that response's raw token/cache snapshot.
 *
 * The raw snapshot's `inputTokens` is the SAME latest request input the gauge
 * reports, which is why the two constants below are equal. `cacheWriteTokens`
 * is deliberately absent: an absent metric must stay unavailable, never 0.
 */
export const ACP_FIXTURE_CONTEXT_USED = 1200;
export const ACP_FIXTURE_CONTEXT_WINDOW = 200000;
export const ACP_FIXTURE_CREDITS = 0.5;
export const ACP_FIXTURE_INPUT_TOKENS = 1200;
export const ACP_FIXTURE_OUTPUT_TOKENS = 320;
export const ACP_FIXTURE_CACHE_READ_TOKENS = 512;

export const ACP_FIXTURE_SESSION_ID = "01a0ecaf-aa3e-799c-90ea-7680e8184d7e";

/**
 * The ACP `session/update` payloads of ONE prompt turn, in stream order:
 * reasoning, an answer segment, three tools (one that succeeds, one that
 * falls back to its `kind` for a name and fails, and one whose `tool_call`
 * frame never arrived and never finished), a second reasoning block, a second
 * answer segment, the turn's usage/credit notification, and update kinds the
 * shared vocabulary does not render at all.
 *
 * `call-1` deliberately streams the same content twice: a tool's streamed
 * content is aggregated into its completion, never one row per frame.
 */
export const ACP_FIXTURE_UPDATES: readonly unknown[] = [
  { sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "Let me look at the " } },
  { sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "workspace first." } },

  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "I'll read the " } },
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "workspace file " } },
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "now." } },

  {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "read_file",
    kind: "read",
    status: "pending",
    rawInput: { file_path: "workspace/notes.md" }
  },
  { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "workspace/" } }]
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "workspace/notes.md" } }]
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Read 1/1 file, 42 lines" } }]
  },

  { sessionUpdate: "tool_call", toolCallId: "call-2", kind: "execute", status: "pending", rawInput: { command: "ls -la" } },
  { sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "failed", rawOutput: { result: "command exited 1: boom" } },

  {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-3",
    title: "search_code",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "scanning files…" } }]
  },

  { sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "Now the summary." } },
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "The file lists " } },
  { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "three entries." } },

  // Update kinds the shared vocabulary does not render: ignored generically.
  { sessionUpdate: "plan", entries: [{ content: "read the file", status: "completed" }] },
  // The runtime's usage/credit notification, in its real published shape
  // (used = context occupancy, size = context window, cost.amount = credits,
  // _meta = the response identity plus that response's raw usage snapshot).
  {
    sessionUpdate: "usage_update",
    used: ACP_FIXTURE_CONTEXT_USED,
    size: ACP_FIXTURE_CONTEXT_WINDOW,
    cost: { amount: ACP_FIXTURE_CREDITS, currency: "" },
    _meta: {
      "codebuddy.ai/requestId": "req-1",
      "codebuddy.ai/messageId": "m1",
      usage: {
        inputTokens: ACP_FIXTURE_INPUT_TOKENS,
        outputTokens: ACP_FIXTURE_OUTPUT_TOKENS,
        cacheReadTokens: ACP_FIXTURE_CACHE_READ_TOKENS
      }
    }
  },
  { sessionUpdate: "session_info_update", title: "Workspace notes" }
];

export interface AcpFixtureRun {
  sessionId: string;
  model: string;
  stopReason: string;
  updates: readonly unknown[];
}

/** The record stream of ONE WorkBuddy prompt turn, exactly as the bridge writes it. */
export function acpFixtureRunRecords(model: string): Record<string, unknown>[] {
  const normalizer: AcpNormalizer = createAcpNormalizer();
  const records: Record<string, unknown>[] = [acpInitRecord(ACP_FIXTURE_SESSION_ID, model)];
  for (const update of ACP_FIXTURE_UPDATES) records.push(...normalizer.handleUpdate(update));
  records.push(...normalizer.flush());
  records.push(acpSuccessResultRecord({
    sessionId: ACP_FIXTURE_SESSION_ID,
    model,
    stopReason: "end_turn",
    finalText: normalizer.assistantText()
  }));
  return records;
}

/** The same record stream as newline-delimited JSON lines (the bridge's stdout shape). */
export function acpFixtureRunLines(model: string): string[] {
  return acpFixtureRunRecords(model).map((record) => JSON.stringify(record));
}
