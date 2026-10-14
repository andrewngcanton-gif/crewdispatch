// workbuddy-acp-normalizer.test.ts — the ACP/protocol ADAPTER boundary.
//
// One recorded-shape ACP conversation (src/tests/helpers/acp-workbuddy-fixture.ts)
// is normalized into the SHARED CrewDispatch event vocabulary. These tests prove:
//   - a streamed answer is a message LIFECYCLE (one readable completed message,
//     not one record per streamed chunk);
//   - tool activity keeps its protocol NAME and lifecycle, including a tool
//     whose `tool_call` frame never arrived and a tool with no title;
//   - reasoning stays in the shared thinking vocabulary and is never synthesized;
//   - the mapping is MODEL-INDEPENDENT: the same fixture under two different
//     model ids produces identical canonical records, differing only in the
//     model metadata the bridge records;
//   - the shared stream parser (the accepted Command Code parser the WorkBuddy
//     adapter delegates to) still reads session, final text and tool usage.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcpNormalizer } from "../../providers/workbuddy-ai/acp-normalizer";
import { createWorkBuddyAiAdapter } from "../../providers/workbuddy-ai/index";
import {
  ACP_FIXTURE_ANSWER,
  ACP_FIXTURE_ANSWER_TAIL,
  ACP_FIXTURE_ASSISTANT_TEXT,
  ACP_FIXTURE_CACHE_READ_TOKENS,
  ACP_FIXTURE_CONTEXT_USED,
  ACP_FIXTURE_CONTEXT_WINDOW,
  ACP_FIXTURE_CREDITS,
  ACP_FIXTURE_INPUT_TOKENS,
  ACP_FIXTURE_OUTPUT_TOKENS,
  ACP_FIXTURE_SESSION_ID,
  ACP_FIXTURE_THOUGHT,
  ACP_FIXTURE_TOOL_FAILURE,
  ACP_FIXTURE_TOOL_PROGRESS,
  ACP_FIXTURE_TOOL_RESULT,
  ACP_FIXTURE_UPDATES,
  acpFixtureRunLines,
  acpFixtureRunRecords
} from "../helpers/acp-workbuddy-fixture";

type Json = Record<string, unknown>;

/** The canonical `event` payloads of a record stream, in order. */
function eventsOf(records: Json[]): Json[] {
  return records
    .filter((record) => record.type === "event" && record.event && typeof record.event === "object")
    .map((record) => record.event as Json);
}

function eventsByType(records: Json[], type: string): Json[] {
  return eventsOf(records).filter((event) => event.type === type);
}

function messageText(event: Json): string {
  const content = Array.isArray(event.content) ? event.content : [];
  return content
    .map((block) => (block && typeof block === "object" && typeof (block as Json).text === "string" ? String((block as Json).text) : ""))
    .join("");
}

/** Drop the model METADATA from every record (everything else must be identical). */
function withoutModel(records: Json[]): Json[] {
  return records.map((record) => {
    const copy: Json = { ...record };
    delete copy.model;
    return copy;
  });
}

test("WorkBuddy ACP normalizer turns a streamed answer into one canonical message lifecycle", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  for (const update of ACP_FIXTURE_UPDATES) records.push(...normalizer.handleUpdate(update));
  records.push(...normalizer.flush());

  const deltas = eventsByType(records, "text_delta");
  const ends = eventsByType(records, "message_end");
  assert.equal(eventsByType(records, "message_start").length, 2, "one message_start per spoken segment");
  assert.equal(ends.length, 2, "one message_end per spoken segment, never one per streamed chunk");
  assert.equal(deltas.length, 5, "every streamed chunk is still preserved as a delta for diagnostics");
  assert.equal(deltas.map((event) => String(event.delta)).join(""), ACP_FIXTURE_ASSISTANT_TEXT);

  const first = messageText(ends[0] as Json);
  const second = messageText(ends[1] as Json);
  assert.equal(first, ACP_FIXTURE_ANSWER);
  assert.equal(second, ACP_FIXTURE_ANSWER_TAIL);
  assert.equal(first + second, ACP_FIXTURE_ASSISTANT_TEXT);
  assert.equal(normalizer.assistantText(), ACP_FIXTURE_ASSISTANT_TEXT, "the final result text is the concatenated stream text");

  // No canonical record may fabricate an assistant row that is not a lifecycle event.
  const types = eventsOf(records).map((event) => String(event.type));
  assert.equal(types.includes("assistant"), false);
  assert.equal(records.some((record) => record.type === "assistant"), false, "no per-chunk assistant records are emitted");
});

test("WorkBuddy ACP tool activity maps onto the shared tool lifecycle with the protocol name", () => {
  const records = acpFixtureRunRecords("deepseek-v4.1-flash");
  const queued = eventsByType(records, "tool_queued");
  assert.deepEqual(
    queued.map((event) => [event.toolCallId, event.toolName]),
    [
      ["call-1", "read_file"],
      ["call-2", "execute"],
      ["call-3", "search_code"]
    ],
    "a title names the tool, the protocol kind is the generic fallback, and every tool keeps its own name"
  );
  assert.deepEqual(queued[0]?.input, { file_path: "workspace/notes.md" }, "the tool input is preserved for the readable hint");

  assert.deepEqual(eventsByType(records, "tool_running").map((event) => event.toolName), ["read_file", "search_code"]);
  assert.equal(eventsByType(records, "tool_running").length, 2, "a repeated in_progress update is not repeated as a row");

  // Streamed tool content is AGGREGATED: three content updates produced no row
  // each, and only the tool that never finished reports one progress row.
  const updates = eventsByType(records, "tool_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.toolName, "search_code");
  assert.deepEqual(updates[0]?.partial, [{ type: "text", text: ACP_FIXTURE_TOOL_PROGRESS }]);

  const completed = eventsByType(records, "tool_completed");
  assert.equal(completed.length, 2);
  assert.equal(completed[0]?.toolName, "read_file");
  assert.equal(completed[0]?.status, undefined, "a successful completion carries no failure status");
  assert.deepEqual(completed[0]?.result, [{ type: "text", text: ACP_FIXTURE_TOOL_RESULT }]);
  assert.equal(completed[1]?.toolName, "execute");
  assert.equal(completed[1]?.status, "failed", "an ACP failed tool is reported as failed, not completed");
  assert.deepEqual(completed[1]?.result, [{ type: "text", text: ACP_FIXTURE_TOOL_FAILURE }]);
});

test("a tool that streams content but never reports a status keeps ONE aggregated progress row", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", kind: "execute" }));
  for (const chunk of ['{"command":"ls', ' -la', '"}']) {
    records.push(...normalizer.handleUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: chunk } }]
    }));
  }
  assert.deepEqual(eventsOf(records).map((event) => event.type), ["tool_queued", "tool_running"]);
  const flushed = normalizer.flush();
  assert.deepEqual(eventsOf(flushed).map((event) => event.type), ["tool_update"], "the aggregate is reported exactly once, at the end");
  assert.deepEqual(normalizer.flush(), [], "flushing twice never repeats the progress row");
});

test("a completion with no content of its own reports the output the SAME tool already streamed", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", kind: "execute" }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "in_progress",
    content: [{ type: "content", content: { type: "text", text: "streamed output" } }]
  }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }));
  const completed = eventsByType(records, "tool_completed");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0]?.result, [{ type: "text", text: "streamed output" }]);
  assert.deepEqual(normalizer.flush(), [], "a completed tool reports no extra progress row");
});

test("a real completion that reports the same output as content AND rawOutput is never repeated", () => {
  // Shape observed in a real WorkBuddy run: the completion frame carried both
  // `content` blocks and an equivalent `rawOutput`.
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Read", kind: "read" }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "file body" } }],
    rawOutput: { result: "file body" }
  }));
  const completed = eventsByType(records, "tool_completed");
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0]?.result, [{ type: "text", text: "file body" }], "the output is reported exactly once");
});

test("WorkBuddy ACP reasoning stays in the shared thinking vocabulary and is never synthesized", () => {
  const records = acpFixtureRunRecords("deepseek-v4.1-flash");
  const deltas = eventsByType(records, "thinking_delta");
  const ends = eventsByType(records, "thinking_end");
  assert.equal(eventsByType(records, "thinking_start").length, 2);
  assert.equal(ends.length, 2);
  assert.equal(deltas.map((event) => String(event.delta)).join(""), `${ACP_FIXTURE_THOUGHT}Now the summary.`);
  assert.equal(ends[0]?.text, ACP_FIXTURE_THOUGHT, "the completed reasoning block carries only protocol-emitted text");
  // The private text lives under the generic keys the Hub's privacy policy strips.
  // `messageId` is the protocol's response identity (the paired-decode link),
  // never provider-specific content.
  for (const delta of deltas) assert.deepEqual(Object.keys(delta).sort(), ["delta", "messageId", "type"]);
});

test("WorkBuddy ACP updates the shared vocabulary does not render are ignored generically", () => {
  const normalizer = createAcpNormalizer();
  const emitted: Json[] = [];
  for (const update of [
    { sessionUpdate: "plan", entries: [{ content: "x", status: "pending" }] },
    { sessionUpdate: "available_commands_update", availableCommands: [] },
    { sessionUpdate: "current_mode_update", currentModeId: "plan" },
    { somethingElse: true }
  ]) {
    emitted.push(...normalizer.handleUpdate(update));
  }
  assert.deepEqual(emitted, []);
});

test("a real-shape usage_update becomes the canonical provider-neutral usage event", () => {
  const records = acpFixtureRunRecords("deepseek-v4.1-flash");
  const usageEvents = eventsByType(records, "usage");
  assert.equal(usageEvents.length, 1, "the turn's usage notification is mapped exactly once");
  assert.deepEqual(usageEvents[0], {
    type: "usage",
    messageId: "m1",
    contextUsed: ACP_FIXTURE_CONTEXT_USED,
    contextWindow: ACP_FIXTURE_CONTEXT_WINDOW,
    credits: ACP_FIXTURE_CREDITS,
    tokensIn: ACP_FIXTURE_INPUT_TOKENS,
    tokensOut: ACP_FIXTURE_OUTPUT_TOKENS,
    cacheRead: ACP_FIXTURE_CACHE_READ_TOKENS,
    cacheMiss: ACP_FIXTURE_INPUT_TOKENS - ACP_FIXTURE_CACHE_READ_TOKENS
  });
  // The canonical event carries protocol NUMBERS plus the response identity
  // (`messageId`) the shared parser needs to pair this response's output token
  // delta with the output interval that SAME response streamed. It never
  // carries the raw usage snapshot or any provider-specific key.
  assert.deepEqual(
    Object.keys(usageEvents[0] as Json).sort(),
    ["cacheMiss", "cacheRead", "contextUsed", "contextWindow", "credits", "messageId", "tokensIn", "tokensOut", "type"]
  );
});

test("a usage_update never closes an open assistant message or reasoning block", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Half " } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 10, size: 1000 }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "an answer." } }));
  records.push(...normalizer.flush());
  assert.deepEqual(eventsOf(records).map((event) => event.type), ["message_start", "text_delta", "usage", "text_delta", "message_end"]);
});

test("a usage_update with no resolvable context window and no credit consumption emits nothing", () => {
  const normalizer = createAcpNormalizer();
  // The runtime forces used=0/size=0 when the model's context size is unknown:
  // that is an "unresolved" sentinel, never a measured "context used 0".
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 0, size: 0 }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 1200, size: 0 }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 1200 }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", size: 200000 }), []);
  // A zero-cost frame consumes no credit and carries no context: nothing to record.
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 0, size: 0, cost: { amount: 0, currency: "" } }), []);
});

test("a credit-only usage_update (generation-tool / team-member credit) reports credits without context", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    used: 0,
    size: 0,
    cost: { amount: 1.25, currency: "" },
    _meta: { "codebuddy.ai/requestId": "req-9" }
  });
  assert.deepEqual(eventsOf(records), [{ type: "usage", credits: 1.25 }]);
});

test("a cost.amount of 0 is a placeholder, not a genuine zero-credit report", () => {
  const normalizer = createAcpNormalizer();
  // Local runtime evidence (AcpUsagePublisher.doPublish + sendSessionUpdate):
  // the publisher builds `cost` only when the amount is strictly positive and
  // serializes it only when truthy, so "zero credits consumed" reaches the wire
  // as the ABSENCE of `cost`. An amount-0 frame is therefore a placeholder this
  // publisher cannot produce, never a measurement: it must not become
  // `credits: 0` (the canonical "a genuinely reported 0 stays 0" rule applies
  // to values the provider actually reports as numbers, like a measured
  // context 0 — see the test below).
  const records = normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    used: 500,
    size: 100000,
    cost: { amount: 0, currency: "" }
  });
  assert.deepEqual(eventsOf(records), [{ type: "usage", contextUsed: 500, contextWindow: 100000 }]);
});

test("a genuinely measured context 0 is still reported when the window is known", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 0, size: 200000 });
  assert.deepEqual(eventsOf(records), [{ type: "usage", contextUsed: 0, contextWindow: 200000 }]);
});

test("negative and non-finite usage_update values are never accepted", () => {
  const normalizer = createAcpNormalizer();
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: -5, size: 200000 }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 10, size: -1 }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", cost: { amount: -2 } }), []);
  assert.deepEqual(normalizer.handleUpdate({ sessionUpdate: "usage_update", cost: "nope" }), []);
});

test("an end_turn frame closes the assistant message at the protocol boundary", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer." } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "end_turn" }));
  assert.deepEqual(eventsOf(records).map((event) => event.type), ["message_start", "text_delta", "message_end"]);
  assert.deepEqual(normalizer.flush(), [], "the boundary already closed the message");
});

test("the same ACP fixture under two different model ids normalizes identically apart from model metadata", () => {
  const first = acpFixtureRunRecords("deepseek-v4.1-flash");
  const second = acpFixtureRunRecords("hy4-preview-f");

  assert.equal(first.length, second.length);
  assert.deepEqual(eventsOf(first), eventsOf(second), "every canonical event record is identical");
  assert.equal(JSON.stringify(eventsOf(first)), JSON.stringify(eventsOf(second)));
  assert.deepEqual(withoutModel(first), withoutModel(second), "the streams differ only in model metadata");
  assert.notDeepEqual(first, second, "the two runs really did carry different model ids");

  const models = first
    .map((record) => record.model)
    .filter((value): value is string => typeof value === "string");
  assert.deepEqual(models, ["deepseek-v4.1-flash", "deepseek-v4.1-flash"], "the model id appears as metadata only");
  // No canonical event carries a model id at all: parsing never branches on it.
  for (const event of eventsOf(first)) assert.equal("model" in event, false);
});

test("the shared stream parser still reads session, final text and tool usage from the canonical records", () => {
  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  for (const line of acpFixtureRunLines("deepseek-v4.1-flash")) adapter.parseStreamLine(line, state, Date.now());

  assert.equal(state.sessionId, ACP_FIXTURE_SESSION_ID, "resume still gets the ACP session id");
  assert.equal(state.finalResult, ACP_FIXTURE_ASSISTANT_TEXT, "jobquay_result still returns the full final text");
  assert.equal(state.terminal, true);
  assert.equal(state.resultSubtype, "success");
  assert.equal(state.stopReason, "end_turn");
  assert.equal(state.isError, false);
  assert.equal(state.malformedLines, 0);
  assert.equal(state.unknownLines, 0);

  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.toolCalls, 3, "each ACP tool is counted exactly once");
});

test("real WorkBuddy modelRequestId links streamed output to usage even when ACP messageId differs", () => {
  // Observed from WorkBuddy Desktop 5.6.2:
  // - top-level chunk messageId is an ACP message/item id;
  // - chunk _meta.modelRequestId / llmMessageId identifies the model response;
  // - usage_update republishes THAT model-response id as codebuddy.ai/messageId.
  const acpMessageId = "01a0f219-3090-7349-8150-6104653bbfcd";
  const modelRequestId = "01a0f219309073498150610305327fca";
  const requestId = "01a0f219302c7ca7904e2e579f5aedbf";
  const chunkMeta = {
    "codebuddy.ai/messageId": acpMessageId,
    "codebuddy.ai/modelRequestId": modelRequestId,
    "codebuddy.ai/llmMessageId": modelRequestId,
    "codebuddy.ai/requestId": requestId
  };
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: acpMessageId,
    _meta: chunkMeta,
    content: { type: "text", text: "JQ_" }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: acpMessageId,
    _meta: chunkMeta,
    content: { type: "text", text: "OK" }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    _meta: {
      "codebuddy.ai/messageId": modelRequestId,
      "codebuddy.ai/requestId": requestId,
      usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 80 }
    }
  }));
  records.push(...normalizer.flush());

  const ids = eventsOf(records)
    .filter((event) => ["message_start", "text_delta", "message_end", "usage"].includes(String(event.type)))
    .map((event) => event.messageId)
    .filter(Boolean);
  assert.ok(ids.length >= 4);
  assert.deepEqual([...new Set(ids)], [modelRequestId], "lifecycle timing and usage use one proven model-response identity");

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 500;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 8);
  assert.equal(usage.cacheRead, 80);
  assert.equal(usage.cacheMiss, 20);
  // The dsh contract: this transport cannot prove the response's assembled/
  // final instant (ACP has no message-assembled frame; the bridge's
  // message_end is a synthesized closure), so Decode stays null rather than
  // pairing the run-total tokens with a synthetic-boundary interval.
  assert.equal(usage.decodeTokens, null, "synthetic lifecycle boundaries never authorize a numerator");
  assert.equal(usage.decodeSeconds, null, "synthetic lifecycle boundaries never authorize a denominator");
});

test("a WorkBuddy response that streams reasoning then its answer still proves no assembled/final instant — no Decode pair", () => {
  // Real WorkBuddy Desktop 5.6.2 shape: one model response streams thought
  // chunks and then answer chunks under the SAME model-response identity (the
  // normalizer closes the reasoning block when the answer starts). Even though
  // the reasoning→answer gap WOULD be decode time under dsh semantics, this
  // transport never proves the response's assembled/final instant (the
  // message_end below is a bridge-synthesized closure), so no pair exists and
  // Decode stays null. A missing metric is honest; a synthetic-boundary rate is
  // not.
  const modelRequestId = "01a0f2a7604575b9a7f0792a75f1014e";
  const requestId = "01a0f2a7604575b9a7f0792a75f1014f";
  const meta = { "codebuddy.ai/modelRequestId": modelRequestId, "codebuddy.ai/requestId": requestId };
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_thought_chunk",
    messageId: "acp-item-1",
    _meta: meta,
    content: { type: "text", text: "Let me think." }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "acp-item-1",
    _meta: meta,
    content: { type: "text", text: "Here is the answer." }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    _meta: { "codebuddy.ai/messageId": modelRequestId, "codebuddy.ai/requestId": requestId, usage: { outputTokens: 9 } }
  }));
  records.push(...normalizer.flush());

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 500;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 9, "the response's token count still reaches the run total");
  assert.equal(usage.decodeTokens, null, "no assembled/final instant → no numerator");
  assert.equal(usage.decodeSeconds, null, "no assembled/final instant → no denominator");
});

test("a reasoning-only ACP turn with no token evidence reports NO decode pair", () => {
  // Observed in a real WorkBuddy run: the model streamed reasoning, used a tool,
  // and produced no assistant message at all, so no message_end ever arrived —
  // and this stream carried no usage frame for the response either. The
  // interval is still closed (never left dangling), but without the response's
  // own provider-reported output token count no pair exists: Decode stays
  // absent instead of showing raw seconds or borrowing another response's
  // tokens.
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "Let me " } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "check the file." } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", kind: "execute", status: "pending" }));
  records.push(...normalizer.flush());

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 5_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 700;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.toolCalls, 1, "the tool is still counted from its lifecycle evidence");
  assert.equal(usage.decodeTokens, null, "no provider-reported output token count → no numerator");
  assert.equal(usage.decodeSeconds, null, "an unpaired interval is omitted, never shown raw");
});

test("a reasoning-only ACP turn with its own usage_update still reports NO Decode pair", () => {
  // The response's usage frame carries its identity and output tokens, and the
  // reasoning block closed at a synthesized boundary — but the assembled/final
  // instant is still unprovable, so the dsh contract pairs NOTHING.
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "Let me " } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "check the file." } }));
  // The response's own usage frame: identity + output tokens, no context window
  // (the runtime's unresolved sentinel).
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    used: 0,
    size: 0,
    _meta: { "codebuddy.ai/messageId": "m1", usage: { outputTokens: 8 } }
  }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", kind: "execute", status: "pending" }));
  records.push(...normalizer.flush());

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 5_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 700;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 8, "the response's output tokens still reach the run total");
  assert.equal(usage.decodeTokens, null, "a synthesized block boundary is not decode evidence");
  assert.equal(usage.decodeSeconds, null);
});

test("the runtime's own frame timestamp is carried on canonical records, never local read time", () => {
  // The ACP agent injects `_meta.timestamp` (ISO) on every forwarded prompt
  // update, resolved from the source event's own time. Carrying it is what
  // makes the first-token boundary EXACT; a frame without one carries no
  // timestamp at all (local read time is never substituted).
  const at = "2026-10-01T00:29:21.231Z";
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_thought_chunk",
    messageId: "m1",
    _meta: { "codebuddy.ai/modelRequestId": "m1", timestamp: at },
    content: { type: "text", text: "Thinking." }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    _meta: { "codebuddy.ai/modelRequestId": "m1", timestamp: at },
    content: { type: "text", text: "Answer." }
  }));
  records.push(...normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    _meta: { "codebuddy.ai/messageId": "m1", timestamp: at, usage: { outputTokens: 8 } }
  }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Bash", status: "pending", _meta: { timestamp: at } }));
  records.push(...normalizer.flush());

  const lifecycle = [
    ...eventsByType(records, "thinking_start"),
    ...eventsByType(records, "thinking_delta"),
    ...eventsByType(records, "thinking_end"),
    ...eventsByType(records, "message_start"),
    ...eventsByType(records, "text_delta"),
    ...eventsByType(records, "message_end"),
    ...eventsByType(records, "usage"),
    ...eventsByType(records, "tool_queued")
  ];
  assert.ok(lifecycle.length >= 7, "the frame produced the canonical lifecycle");
  for (const event of lifecycle) {
    assert.equal(event.timestamp, at, `${String(event.type)} keeps the runtime's own instant`);
  }
  // The flush-synthesized message_end (no frame caused it) carries no
  // timestamp: a bridge decision is never presented as provider time.
  const flushed = eventsByType(normalizer.flush(), "message_end");
  assert.equal(flushed.length, 0, "the message was already closed by the tool frame");
  const dangling = createAcpNormalizer();
  dangling.handleUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "open" } });
  const flushRecords = dangling.flush();
  assert.equal(eventsByType(flushRecords, "message_end")[0]?.timestamp, undefined, "a flush closure carries no provider instant");
});

test("the WorkBuddy adapter reports exactly the metrics the ACP evidence proves", () => {
  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  // Stream the fixture with a realistic arrival clock so the observable
  // model-output interval (first delta -> message_end) is measurable.
  let at = 1_000_000;
  for (const line of acpFixtureRunLines("deepseek-v4.1-flash")) {
    adapter.parseStreamLine(line, state, at);
    at += 400;
  }
  const usage = adapter.normalizeUsage(state);

  // Proven by canonical tool lifecycle evidence.
  assert.equal(usage.toolCalls, 3);
  // Decode: the fixture streams chunks, a synthesized message closure and the
  // response's usage snapshot — none of which proves the assembled/final
  // instant the dsh contract requires, so Decode stays null (the run totals
  // still receive every token).
  assert.equal(usage.decodeTokens, null, "an ACP transcript alone never proves a decode pair");
  assert.equal(usage.decodeSeconds, null, "no exact completed-response timing → no denominator");
  // Proven by the runtime's usage_update (context gauges + credit consumption).
  assert.equal(usage.contextUsed, ACP_FIXTURE_CONTEXT_USED);
  assert.equal(usage.contextWindow, ACP_FIXTURE_CONTEXT_WINDOW);
  assert.equal(usage.credits, ACP_FIXTURE_CREDITS);
  // Proven by the raw usage snapshot the response republishes under its identity.
  assert.equal(usage.tokensIn, ACP_FIXTURE_INPUT_TOKENS);
  assert.equal(usage.tokensOut, ACP_FIXTURE_OUTPUT_TOKENS);
  assert.equal(usage.cacheRead, ACP_FIXTURE_CACHE_READ_TOKENS);
  assert.equal(
    usage.cacheMiss,
    ACP_FIXTURE_INPUT_TOKENS - ACP_FIXTURE_CACHE_READ_TOKENS,
    "the installed WorkBuddy runtime proves cache-read is a subset of input, so the non-hit portion is derivable"
  );

  // The fixture carries no cache-write value, and a credit is not USD. Those
  // metrics stay unavailable rather than estimated or 0.
  assert.equal(usage.cacheCreation, null);
  assert.equal(usage.totalCostUsd, null);
});

// ---------------------------------------------------------------------------
// Raw usage snapshots: identity-scoped reconciliation (see the module header)
// ---------------------------------------------------------------------------

/** Fold canonical records through the real WorkBuddy adapter into a snapshot. */
function foldedUsage(records: Json[]) {
  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  records.forEach((record, index) => adapter.parseStreamLine(JSON.stringify(record), state, 1_000 + index * 10));
  return adapter.normalizeUsage(state);
}

/** One `usage_update` carrying the raw snapshot of ONE message-keyed response. */
function rawUsageFrame(input: {
  messageId: string;
  snapshot: Json;
  used?: number;
  size?: number;
  cost?: number;
}): Json {
  return {
    sessionUpdate: "usage_update",
    ...(input.used !== undefined ? { used: input.used } : {}),
    ...(input.size !== undefined ? { size: input.size } : {}),
    ...(input.cost !== undefined ? { cost: { amount: input.cost, currency: "" } } : {}),
    _meta: { "codebuddy.ai/messageId": input.messageId, usage: input.snapshot }
  };
}

test("a republished raw usage snapshot for the same response never double counts", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 1000, outputTokens: 50 } })),
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 1000, outputTokens: 50 } }))
  ];
  assert.deepEqual(
    eventsByType(records, "usage"),
    [{ type: "usage", messageId: "m1", tokensIn: 1000, tokensOut: 50 }],
    "the identical republication emits no raw delta at all"
  );
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 1000);
  assert.equal(usage.tokensOut, 50, "the snapshot is counted exactly once");
});

test("a later snapshot for the same response replaces the earlier observation", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 100 } })),
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 1000, outputTokens: 120, cacheReadTokens: 100 } }))
  ];
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 1000);
  assert.equal(usage.tokensOut, 120, "the grown snapshot replaces the earlier 50, it does not add to it");
  assert.equal(usage.cacheRead, 100);
});

test("WorkBuddy cacheMiss is derived from the same inclusive input/cache-read relation its installed runtime uses", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate(rawUsageFrame({
      messageId: "m1",
      snapshot: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 800 }
    })),
    // A later corrected snapshot must reconcile every dependent field, not
    // leave the old hit-rate denominator behind.
    ...normalizer.handleUpdate(rawUsageFrame({
      messageId: "m1",
      snapshot: { inputTokens: 900, outputTokens: 10, cacheReadTokens: 720 }
    }))
  ];
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 900);
  assert.equal(usage.cacheRead, 720);
  assert.equal(usage.cacheMiss, 180, "cacheRead + cacheMiss equals the corrected inclusive input total");
});

// ---------------------------------------------------------------------------
// Real WorkBuddy prompt-cache evidence: explicit precedence
//
// The shapes below are read from a real installed-runtime trace (2026-10-01).
// A WorkBuddy response's raw usage carries its OWN prompt-cache counters
// (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`) next to a nested
// `prompt_tokens_details.cached_tokens` detail AND zero-valued
// `cache_read_input_tokens` / top-level `cached_tokens` placeholders in the
// SAME object, while `completion_tokens_details.cached_tokens` describes
// OUTPUT tokens only. On every observed response the pair partitions the
// prompt total exactly: `inputTokens = hit + miss`.
// ---------------------------------------------------------------------------

const REAL_PROMPT_CACHE_HIT_TOKENS = 3584;
const REAL_PROMPT_CACHE_MISS_TOKENS = 25211;
const REAL_PROMPT_TOKENS = REAL_PROMPT_CACHE_HIT_TOKENS + REAL_PROMPT_CACHE_MISS_TOKENS;

/** The exact contradictory shape: strong prompt-cache evidence + zero placeholders. */
function contradictoryCacheUsage(overrides: Json = {}): Json {
  return {
    inputTokens: REAL_PROMPT_TOKENS,
    outputTokens: 2,
    prompt_cache_hit_tokens: REAL_PROMPT_CACHE_HIT_TOKENS,
    prompt_cache_miss_tokens: REAL_PROMPT_CACHE_MISS_TOKENS,
    prompt_tokens_details: { cached_tokens: REAL_PROMPT_CACHE_HIT_TOKENS, reasoning_tokens: 0 },
    completion_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cached_tokens: 0,
    ...overrides
  };
}

/** The verbatim provider raw usage object the runtime republishes under `_meta.usage`. */
function verbatimProviderUsage(): Json {
  return {
    prompt_tokens: REAL_PROMPT_TOKENS,
    completion_tokens: 2,
    total_tokens: REAL_PROMPT_TOKENS + 2,
    completion_tokens_details: { accepted_prediction_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 },
    prompt_tokens_details: { accepted_prediction_tokens: 0, cached_tokens: REAL_PROMPT_CACHE_HIT_TOKENS, reasoning_tokens: 0 },
    prompt_cache_hit_tokens: REAL_PROMPT_CACHE_HIT_TOKENS,
    prompt_cache_miss_tokens: REAL_PROMPT_CACHE_MISS_TOKENS,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    prompt_cache_write_tokens: 0,
    completion_thinking_tokens: 0,
    credit: 0,
    cached_tokens: 0
  };
}

test("the real contradictory WorkBuddy cache shape maps the prompt-cache evidence, never the zero placeholders", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: contradictoryCacheUsage() }));
  const usage = eventsByType(records, "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.tokensIn, REAL_PROMPT_TOKENS);
  assert.equal(usage[0]?.tokensOut, 2);
  assert.equal(
    usage[0]?.cacheRead,
    REAL_PROMPT_CACHE_HIT_TOKENS,
    "the provider's own prompt-cache hit counter beats cache_read_input_tokens:0 and top-level cached_tokens:0"
  );
  assert.notEqual(usage[0]?.cacheRead, 0, "the canonical cache-read must not collapse to the placeholder zero");
  assert.equal(
    usage[0]?.cacheMiss,
    REAL_PROMPT_CACHE_MISS_TOKENS,
    "the exact provider-reported miss is preferred over deriving the full placeholder input"
  );

  const folded = foldedUsage(records);
  assert.equal(folded.tokensIn, REAL_PROMPT_TOKENS);
  assert.equal(folded.cacheRead, REAL_PROMPT_CACHE_HIT_TOKENS);
  assert.equal(folded.cacheMiss, REAL_PROMPT_CACHE_MISS_TOKENS);
  assert.equal(
    (folded.cacheRead ?? 0) + (folded.cacheMiss ?? 0),
    folded.tokensIn,
    "hit + miss still partitions the inclusive input total"
  );
  // The shared weighted ratio is non-zero for this real shape (12.4%), never 0%.
  const ratio = (folded.cacheRead ?? 0) / ((folded.cacheRead ?? 0) + (folded.cacheMiss ?? 0));
  assert.equal(Number((ratio * 100).toFixed(1)), 12.4);
});

test("the verbatim provider raw usage record maps the same canonical cache counters", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: verbatimProviderUsage() }));
  const usage = eventsByType(records, "usage");
  assert.equal(usage[0]?.tokensIn, REAL_PROMPT_TOKENS, "prompt_tokens is the inclusive input total");
  assert.equal(usage[0]?.cacheRead, REAL_PROMPT_CACHE_HIT_TOKENS);
  assert.equal(usage[0]?.cacheMiss, REAL_PROMPT_CACHE_MISS_TOKENS);
  // The creation chain keeps its documented shared aliases: the zero-valued
  // `cache_creation_input_tokens` is a genuinely reported 0 and stays 0.
  assert.equal(usage[0]?.cacheCreation, 0);
});

test("nested inputTokensDetails[].cached_tokens is the fallback when the direct hit counter is absent", () => {
  const normalizer = createAcpNormalizer();
  // The real aggregated usage record shape: `inputTokensDetails` is an array
  // whose single element carries the cached-token detail, next to zero
  // placeholder aliases.
  const aggregated = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m1",
    snapshot: {
      requests: 1,
      inputTokens: REAL_PROMPT_TOKENS,
      outputTokens: 2,
      totalTokens: REAL_PROMPT_TOKENS + 2,
      inputTokensDetails: [{ cached_tokens: REAL_PROMPT_CACHE_HIT_TOKENS }],
      outputTokensDetails: [{ reasoning_tokens: 0 }],
      cache_read_input_tokens: 0,
      cached_tokens: 0
    }
  })), "usage");
  assert.equal(
    aggregated[0]?.cacheRead,
    REAL_PROMPT_CACHE_HIT_TOKENS,
    "the nested input-token detail beats the zero placeholder aliases"
  );
  assert.equal(
    aggregated[0]?.cacheMiss,
    REAL_PROMPT_CACHE_MISS_TOKENS,
    "without direct miss evidence the inclusive input derivation still applies"
  );
  assert.equal((aggregated[0]?.cacheRead as number) + (aggregated[0]?.cacheMiss as number), REAL_PROMPT_TOKENS);

  // The nested prompt-token detail (object form) is the same evidence class.
  const nestedPromptDetails = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m2",
    snapshot: {
      inputTokens: 1000,
      prompt_tokens_details: { cached_tokens: 700 },
      cache_read_input_tokens: 0,
      cached_tokens: 0
    }
  })), "usage");
  assert.equal(nestedPromptDetails[0]?.cacheRead, 700);
  assert.equal(nestedPromptDetails[0]?.cacheMiss, 300);

  // Precedence is explicit: the provider's direct counter outranks every
  // nested detail and alias, even when those disagree.
  const direct = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m3",
    snapshot: {
      inputTokens: 1000,
      prompt_cache_hit_tokens: 100,
      prompt_tokens_details: { cached_tokens: 900 },
      inputTokensDetails: [{ cached_tokens: 900 }],
      cache_read_input_tokens: 900
    }
  })), "usage");
  assert.equal(direct[0]?.cacheRead, 100, "the direct prompt-cache hit counter is the strongest evidence");
});

test("a genuine no-cache response keeps the strongest evidence's zero", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate(rawUsageFrame({
    messageId: "m1",
    snapshot: contradictoryCacheUsage({
      inputTokens: 30198,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 30198,
      cache_read_input_tokens: 0,
      cached_tokens: 0
    })
  }));
  const usage = eventsByType(records, "usage");
  assert.equal(usage[0]?.cacheRead, 0, "the direct counter really says zero cache hits");
  assert.equal(usage[0]?.cacheMiss, 30198, "the provider's exact miss counter is used");

  const folded = foldedUsage(records);
  assert.equal(folded.cacheRead, 0);
  assert.equal(folded.cacheMiss, 30198);
  assert.equal(
    (folded.cacheRead ?? 0) / ((folded.cacheRead ?? 0) + (folded.cacheMiss ?? 0)),
    0,
    "a genuine no-cache response is honestly 0%, never hidden or fabricated away"
  );
});

test("repeated, grown and corrected prompt-cache snapshots reconcile without double counting", () => {
  const normalizer = createAcpNormalizer();
  const frame = (input: number, output: number, hit: number, miss: number): Json => rawUsageFrame({
    messageId: "m1",
    snapshot: contradictoryCacheUsage({
      inputTokens: input,
      outputTokens: output,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
      prompt_tokens_details: { cached_tokens: hit }
    })
  });
  const records: Json[] = [
    ...normalizer.handleUpdate(frame(10000, 10, 8000, 2000)),
    ...normalizer.handleUpdate(frame(10000, 10, 8000, 2000)),
    ...normalizer.handleUpdate(frame(12000, 20, 9600, 2400)),
    ...normalizer.handleUpdate(frame(12000, 20, 9000, 3000))
  ];
  assert.deepEqual(
    eventsByType(records, "usage"),
    [
      { type: "usage", messageId: "m1", tokensIn: 10000, tokensOut: 10, cacheRead: 8000, cacheMiss: 2000, cacheCreation: 0 },
      { type: "usage", messageId: "m1", tokensIn: 2000, tokensOut: 10, cacheRead: 1600, cacheMiss: 400 },
      { type: "usage", messageId: "m1", cacheRead: -600, cacheMiss: 600 }
    ],
    "an identical republication emits nothing; a grown snapshot emits its growth; a corrected split emits the exact change"
  );

  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 12000);
  assert.equal(usage.tokensOut, 20, "the grown snapshot replaces the earlier one, it never adds to it");
  assert.equal(usage.cacheRead, 9000, "the corrected hit counter wins exactly");
  assert.equal(usage.cacheMiss, 3000, "the corrected miss counter wins exactly");
  assert.equal((usage.cacheRead ?? 0) + (usage.cacheMiss ?? 0), usage.tokensIn);
});

test("contradictory or impossible cache evidence is never copied or clamped into a fabricated counter", () => {
  const normalizer = createAcpNormalizer();
  // (a) The provider's hit/miss pair does not partition its own input: the
  // inconsistent miss is not copied, and the canonical inclusive derivation
  // still applies to the trustworthy counters (cacheRead 100 <= input 1000).
  const inconsistent = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m1",
    snapshot: { inputTokens: 1000, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 800 }
  })), "usage");
  assert.equal(inconsistent[0]?.cacheRead, 100);
  assert.equal(inconsistent[0]?.cacheMiss, 900, "the canonical inclusive derivation, never the contradictory 800");

  // (b) A cache-read larger than its own input proves no inclusive relation:
  // no miss may be fabricated (a clamp would have emitted 0).
  const impossible = normalizer.handleUpdate(rawUsageFrame({
    messageId: "m2",
    snapshot: { inputTokens: 100, cacheReadTokens: 800 }
  }));
  assert.equal(eventsByType(impossible, "usage")[0]?.cacheRead, 800);
  assert.equal(
    eventsByType(impossible, "usage")[0]?.cacheMiss,
    undefined,
    "an impossible subset relation is omitted, never clamped to 0"
  );
  assert.equal(foldedUsage(impossible).cacheMiss, null);

  // (c) Invalid evidence (non-numeric / negative) is not a measurement: the
  // precedence chain falls through to the next source instead of fabricating.
  const invalid = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m3",
    snapshot: { inputTokens: 1000, prompt_cache_hit_tokens: "nope", prompt_cache_miss_tokens: -5, cache_read_input_tokens: 0 }
  })), "usage");
  assert.deepEqual(invalid[0], { type: "usage", messageId: "m3", tokensIn: 1000, cacheRead: 0, cacheMiss: 1000 });
});

test("a lone provider-reported miss counter is used when it fits the inclusive input", () => {
  const normalizer = createAcpNormalizer();
  const usage = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m1",
    snapshot: { inputTokens: 1000, prompt_cache_miss_tokens: 300, cache_read_input_tokens: 0, cached_tokens: 0 }
  })), "usage");
  assert.equal(usage[0]?.cacheRead, 0);
  assert.equal(
    usage[0]?.cacheMiss,
    300,
    "the provider's own miss counter is preferred over deriving input minus the placeholder"
  );

  // A miss larger than its own input cannot be a portion of it: the
  // contradictory counter is not copied, and the canonical inclusive
  // derivation still applies to the remaining counters.
  const impossible = eventsByType(normalizer.handleUpdate(rawUsageFrame({
    messageId: "m2",
    snapshot: { inputTokens: 1000, prompt_cache_miss_tokens: 2000, cache_read_input_tokens: 0, cached_tokens: 0 }
  })), "usage");
  assert.equal(impossible[0]?.cacheMiss, 1000);
});

test("a cached_tokens nested in completion/output details is never prompt-cache evidence", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate(rawUsageFrame({
    messageId: "m1",
    snapshot: {
      inputTokens: 1000,
      completion_tokens_details: { cached_tokens: 500 },
      outputTokensDetails: [{ cached_tokens: 500 }],
      cache_read_input_tokens: 0,
      cached_tokens: 0
    }
  }));
  const usage = eventsByType(records, "usage");
  assert.equal(usage[0]?.cacheRead, 0, "output-side details describe output tokens, never prompt-cache hits");
  assert.equal(usage[0]?.cacheMiss, 1000);
});

test("a corrected-downward snapshot reconciles with a negative delta instead of keeping a stale total", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { outputTokens: 500 } })),
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { outputTokens: 200 } }))
  ];
  assert.equal(foldedUsage(records).tokensOut, 200, "the corrected value wins exactly");
});

test("a republished usage_update never inflates the run total nor fabricates a decode pair", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Answer " } }));
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "text." } }));
  const frame = rawUsageFrame({ messageId: "m1", snapshot: { outputTokens: 320 } });
  records.push(...normalizer.handleUpdate(frame));
  records.push(...normalizer.handleUpdate(frame));
  records.push(...normalizer.handleUpdate(frame));
  records.push(...normalizer.flush());

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 500;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 320, "three identical publications contribute the response exactly once");
  assert.equal(usage.decodeTokens, null, "a republished usage snapshot proves no assembled/final instant");
  assert.equal(usage.decodeSeconds, null);
});

test("a corrected-downward usage_update moves the run total, never a decode pair", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [];
  records.push(...normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Answer." } }));
  records.push(...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { outputTokens: 320 } })));
  records.push(...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { outputTokens: 300 } })));
  records.push(...normalizer.flush());

  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000;
  for (const record of records) {
    adapter.parseStreamLine(JSON.stringify(record), state, at);
    at += 500;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 300, "the corrected snapshot wins exactly");
  assert.equal(usage.decodeTokens, null, "run-total reconciliation never pairs by itself");
  assert.equal(usage.decodeSeconds, null);
});

test("distinct responses aggregate, and context stays the latest valid gauge", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 1000, outputTokens: 40 }, used: 1000, size: 200000 })),
    ...normalizer.handleUpdate(rawUsageFrame({ messageId: "m2", snapshot: { inputTokens: 1500, outputTokens: 60 }, used: 1500, size: 200000 })),
    // The runtime's credit-only frame carries the unresolved-window sentinel
    // (used 0 / size 0) and must neither add context nor erase the real gauge.
    ...normalizer.handleUpdate({
      sessionUpdate: "usage_update",
      used: 0,
      size: 0,
      cost: { amount: 0.25, currency: "" },
      _meta: { "codebuddy.ai/messageId": "m2" }
    })
  ];
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 2500, "two distinct responses each contribute exactly once");
  assert.equal(usage.tokensOut, 100);
  assert.equal(usage.credits, 0.25);
  assert.equal(usage.contextUsed, 1500, "the latest observation wins, never a sum across requests");
  assert.equal(usage.contextWindow, 200000);
});

test("a request-keyed snapshot reconciles among request frames and never merges with a message key", () => {
  const normalizer = createAcpNormalizer();
  const requestFrame = (inputTokens: number, outputTokens: number): Json => ({
    sessionUpdate: "usage_update",
    _meta: { "codebuddy.ai/requestId": "req-9", usage: { inputTokens, outputTokens } }
  });
  const records: Json[] = [
    ...normalizer.handleUpdate(requestFrame(100, 10)),
    ...normalizer.handleUpdate(requestFrame(100, 25))
  ];
  assert.equal(foldedUsage(records).tokensOut, 25, "the later request-keyed snapshot replaces the earlier one");
});

test("a raw snapshot with no provable response identity is never summed", () => {
  const normalizer = createAcpNormalizer();
  const records: Json[] = [
    ...normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 800, size: 200000, _meta: { usage: { inputTokens: 800, outputTokens: 10 } } }),
    ...normalizer.handleUpdate({ sessionUpdate: "usage_update", used: 900, size: 200000, _meta: { usage: { inputTokens: 900, outputTokens: 20 } } })
  ];
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, null, "an identity-less snapshot cannot be told from a duplicate, so it is not summed");
  assert.equal(usage.tokensOut, null);
  assert.equal(usage.contextUsed, 900, "the context gauge is still mapped");
});

test("reported zeros are kept, cache-write maps to cacheCreation, and absent cache metrics stay null", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate(
    rawUsageFrame({ messageId: "m1", snapshot: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 128 } })
  );
  const usage = foldedUsage(records);
  assert.equal(usage.tokensIn, 0, "a genuinely reported 0 stays 0");
  assert.equal(usage.tokensOut, 0);
  assert.equal(usage.cacheCreation, 128, "the cache-write/creation field keeps its own name");
  assert.equal(usage.cacheRead, null, "an absent cache metric stays unavailable");
  assert.equal(usage.cacheMiss, null, "without a cache-read measurement there is no cache hit/miss split to derive");
});

test("the raw snapshot never re-reports the credits the deduped cost frame already carries", () => {
  const normalizer = createAcpNormalizer();
  const records = normalizer.handleUpdate({
    sessionUpdate: "usage_update",
    cost: { amount: 0.5, currency: "" },
    _meta: { "codebuddy.ai/messageId": "m1", usage: { inputTokens: 100, outputTokens: 5, credit: 0.5 } }
  });
  assert.equal(foldedUsage(records).credits, 0.5, "the consumption is counted once, from the cost frame");
});

// JQ-20261001-24: session_end is a NOTIFICATION, never a second terminal
// source. The installed runtime's own builder
// (`buildAcpSessionEndUpdate` in cli/dist/codebuddy-headless.js, WorkBuddy
// Desktop 5.6.2) produces exactly `{sessionUpdate:"session_end", stopReason,
// _meta:{requestId, timestamp?}}` — no finishReason and no errorMessage — and
// sends it beside the authoritative `session/prompt` response (whose `_meta`
// carries both); it can even be suppressed entirely when the session is not
// idle. The normalizer must ignore every session_end shape so the prompt result
// stays the only terminal record.
test("session_end frames are ignored and never become a terminal record (JQ-20261001-24)", () => {
  const normalizer = createAcpNormalizer();
  const opened = normalizer.handleUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "m1",
    content: { type: "text", text: "working" }
  });
  assert.equal(opened.length, 2, "message_start + text_delta for the open message");

  // The exact installed builder shape.
  assert.deepEqual(
    normalizer.handleUpdate({ sessionUpdate: "session_end", stopReason: "end_turn" }),
    [],
    "the installed notification shape creates no canonical record"
  );
  assert.deepEqual(
    normalizer.handleUpdate({
      sessionUpdate: "session_end",
      stopReason: "refusal",
      _meta: { "codebuddy.ai/requestId": "r1", timestamp: "2026-10-01T00:00:00.000Z" }
    }),
    [],
    "a timestamped session_end with a conflicting stop reason still creates no record"
  );
  // Even a richer frame (the runtime's published API docs describe optional
  // errorMessage/finishReason fields the ACP builder does not write) must not
  // be translated into terminal evidence.
  assert.deepEqual(
    normalizer.handleUpdate({
      sessionUpdate: "session_end",
      stopReason: "refusal",
      errorMessage: "conflicting detail",
      finishReason: "content_filter"
    }),
    [],
    "no field of a session_end frame ever becomes terminal evidence"
  );

  // The open message lifecycle is untouched: it still closes only at its own
  // flush boundary, with no extra terminal record.
  const flushed = normalizer.flush();
  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0], {
    type: "event",
    event: { type: "message_end", messageId: "m1", content: [{ type: "text", text: "working" }] }
  });
});
