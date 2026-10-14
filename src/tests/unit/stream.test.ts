// stream.test.ts — unit tests for the NDJSON parser and usage normalization.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCommandCodeState,
  parseCommandCodeRecord,
  normalizeUsage,
  usageText,
  MALFORMED_LINE_CAP,
  USAGE_UNAVAILABLE_TEXT
} from "../../providers/command-code/stream";
import { createLineSplitter } from "../../runtime/line-splitter";

function fold(lines: string[]) {
  let s = createCommandCodeState();
  for (const l of lines) s = parseCommandCodeRecord(l, s);
  return s;
}

test("reads the session id under every tolerated shape", () => {
  assert.equal(fold(['{"session_id":"abc-1"}']).sessionId, "abc-1");
  assert.equal(fold(['{"sessionId":"abc-2"}']).sessionId, "abc-2");
  assert.equal(fold(['{"thread_id":"abc-3"}']).sessionId, "abc-3");
  assert.equal(fold(['{"session":{"id":"abc-4"}}']).sessionId, "abc-4");
  assert.equal(fold(['{"conversation":{"id":"abc-5"}}']).sessionId, "abc-5");
});

test("reads ids the installed CLI nests under an `event` payload (real v1.65.0 shape)", () => {
  // Verbatim shapes observed in the real one-shot run
  // (npm.cmd run test:e2e:command-code) against cmdc 1.65.0.
  const s = fold([
    '{"type":"event","event":{"type":"run_start","sessionId":"c4cdeed6-2d38-43b2-a9e6-6003ac4e86ec"}}',
    '{"type":"event","event":{"type":"model_request_start","model":"deepseek/deepseek-v4-flash"}}'
  ]);
  assert.equal(s.sessionId, "c4cdeed6-2d38-43b2-a9e6-6003ac4e86ec");
  assert.equal(s.actualModel, "deepseek/deepseek-v4-flash");
  assert.equal(s.model, null); // the init/result record did not echo one
});

test("current nested CLI events accumulate usage, unique tools and the paired decode interval", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"run_start","sessionId":"nested-session"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 1050);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_start"}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"thinking"}}', s, 1200);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hello"}}', s, 1300);
  // The real CLI order: the request boundary (the response's completion
  // evidence) precedes the message artifact's own end.
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","model":"deepseek/deepseek-v4.1-flash","usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheWriteTokens":1},"stopReason":"tool_calls"}}', s, 2200);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 2250);
  parseCommandCodeRecord('{"type":"event","event":{"type":"tool_queued","toolCallId":"call-1","toolName":"read_file"}}', s, 2300);
  parseCommandCodeRecord('{"type":"event","event":{"type":"tool_queued","toolCallId":"call-1","toolName":"read_file"}}', s, 2310);
  // The current CLI repeats the same request usage at turn_end; it must not double count.
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_end","turnNumber":1,"usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheWriteTokens":1}}}', s, 2350);
  const usage = normalizeUsage(s);
  assert.equal(s.sessionId, "nested-session");
  assert.equal(s.actualModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(usage.tokensIn, 10);
  assert.equal(usage.tokensOut, 4);
  assert.equal(usage.cacheRead, 3);
  assert.equal(usage.cacheMiss, 7);
  assert.equal(usage.cacheCreation, 1);
  assert.equal(usage.toolCalls, 1);
  assert.equal(usage.decodeTokens, 4, "the request's own output tokens are the paired numerator");
  assert.equal(usage.decodeSeconds, 1, "first output → the request completion boundary is the paired denominator");
  assert.equal(s.numTurns, 1);
});

test("nested request usage accumulates across turns", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3}}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_end","turnNumber":1,"usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3}}}', s, 1200);
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":2}}', s, 1300);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"inputTokens":20,"outputTokens":6,"cacheReadTokens":10}}}', s, 1400);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensIn, 30);
  assert.equal(usage.tokensOut, 10);
  assert.equal(usage.cacheRead, 13);
  assert.equal(usage.cacheMiss, 17);
});

test("folds a successful terminal result record", () => {
  const s = fold([
    '{"type":"init","model":"deepseek/deepseek-v4-flash"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    '{"type":"tool_use","name":"Read"}',
    '{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":40,"credits":1.5,"total_cost_usd":0.002},"session_id":"s-1","num_turns":2}'
  ]);
  assert.equal(s.terminal, true);
  assert.equal(s.resultSubtype, "success");
  assert.equal(s.isError, false);
  assert.equal(s.finalResult, "done");
  assert.equal(s.lastAssistantText, "hello");
  assert.equal(s.model, "deepseek/deepseek-v4-flash");
  assert.equal(s.sessionId, "s-1");
  assert.equal(s.toolCalls, 1);
  assert.equal(s.numTurns, 2);
  assert.equal(s.tokensIn, 120);
  assert.equal(s.tokensOut, 30);
  assert.equal(s.cacheRead, 40);
  assert.equal(s.cacheMiss, 80);
  assert.equal(s.credits, 1.5);
  assert.equal(s.totalCostUsd, 0.002);
});

test("a terminal finish_reason is carried beside the stop reason and stays null when absent (JQ-20261001-23)", () => {
  const s = fold([
    '{"type":"result","subtype":"error","stop_reason":"refusal","finish_reason":"content_filter","error":{"code":"provider_refusal","message":"blocked"}}'
  ]);
  assert.equal(s.stopReason, "refusal", "the raw stop reason is untouched");
  assert.equal(s.finishReason, "content_filter");
  assert.equal(s.errorCode, "provider_refusal");

  const absent = fold(['{"type":"result","subtype":"success","result":"ok","stop_reason":"end_turn"}']);
  assert.equal(absent.finishReason, null, "an absent finish reason is never fabricated");

  const overLong = fold([`{"type":"result","subtype":"error","finish_reason":"${"x".repeat(201)}"}`]);
  assert.equal(overLong.finishReason, null, "an over-long finish reason is omitted, never truncated into a value");
});

test("an error terminal subtype marks the run as failed even at exit 0", () => {
  const s = fold(['{"type":"result","subtype":"error","error":{"message":"boom","code":"E_AUTH","status":401}}']);
  assert.equal(s.terminal, true);
  assert.equal(s.isError, true);
  assert.equal(s.resultSubtype, "error");
  assert.equal(s.errorMsg, "boom");
  assert.equal(s.errorCode, "E_AUTH");
  assert.equal(s.errorStatus, 401);
});

test("max_turns is normalized and marked as an error subtype (a segment boundary)", () => {
  const s = fold(['{"type":"result","subtype":"max-turns"}']);
  assert.equal(s.resultSubtype, "max_turns");
  assert.equal(s.isError, true);
});

test("counts tool_use blocks and explicit tool counts", () => {
  const blocks = fold(['{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"tool_use"}]}}']);
  assert.equal(blocks.toolCalls, 2);
  const explicit = fold(['{"type":"progress","tool_calls":7}']);
  assert.equal(explicit.toolCalls, 7);
});

test("malformed and unknown records are tolerated, counted and bounded", () => {
  const many = Array.from({ length: 200 }, () => "{not json");
  const s = fold([...many, ...Array.from({ length: 200 }, () => '{"type":"brand-new-thing"}')]);
  assert.equal(s.malformedLines, MALFORMED_LINE_CAP);
  assert.equal(s.unknownLines, MALFORMED_LINE_CAP);
  assert.ok(s.diagTail.includes("not json"));
  assert.ok(s.diagTail.length <= 1000);
});

test("empty/blank lines and non-object JSON are ignored without throwing", () => {
  const s = fold(["", "   ", "[1,2,3]", "null", '"a string"']);
  assert.equal(s.terminal, false);
  assert.equal(s.unknownLines, 3);
});

test("unreported usage stays unavailable (never a fabricated 0)", () => {
  const s = fold(['{"type":"result","subtype":"success","result":"ok"}']);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensIn, null);
  assert.equal(usage.tokensOut, null);
  assert.equal(usage.toolCalls, null); // no tool evidence at all
  assert.equal(usage.credits, null);
  assert.equal(usage.totalCostUsd, null);
  assert.equal(usage.cacheRead, null);
  assert.equal(usageText(null), USAGE_UNAVAILABLE_TEXT);
  assert.equal(usageText(12), "12");
});

test("an explicitly reported 0 stays 0 (only absence becomes unavailable)", () => {
  const s = fold([
    '{"type":"progress","tool_calls":0}',
    '{"type":"result","subtype":"success","usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0}}'
  ]);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensIn, 0);
  assert.equal(usage.tokensOut, 0);
  assert.equal(usage.toolCalls, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.cacheMiss, 0); // verifiable: input 0 - cacheRead 0
});

test("tool evidence is required before a tool count is shown", () => {
  // Text-only run: no tool record, no explicit count -> unavailable, not 0.
  const none = normalizeUsage(fold(['{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}']));
  assert.equal(none.toolCalls, null);
  // Tool events -> a countable value.
  const byEvent = normalizeUsage(fold(['{"type":"tool_use","name":"Read"}']));
  assert.equal(byEvent.toolCalls, 1);
});

test("cacheMiss is unavailable unless both input and cache-read were reported", () => {
  const inputOnly = normalizeUsage(fold(['{"type":"result","usage":{"input_tokens":100}}']));
  assert.equal(inputOnly.tokensIn, 100);
  assert.equal(inputOnly.cacheMiss, null);
  const both = normalizeUsage(fold(['{"type":"result","usage":{"input_tokens":100,"cache_read_input_tokens":30}}']));
  assert.equal(both.cacheMiss, 70);
});

test("Cache stays a weighted session ratio over ALL responses — a provider cache reset is included, never averaged away or floored", () => {
  // Real-shape Command Code usage records: the exact per-response input/cache
  // pairs the installed CLI reported around a provider-side prompt-cache reset
  // in the job-muo3sxxt-fa3lyc session (raw session file
  // 48924864-7b2d-447e-b439-87abcb6365bc.jsonl). Two responses read the prompt
  // from cache, then two read only 2,432 of ~171k/182k input tokens, then the
  // cache recovers. The provider's own counters are the only evidence; the
  // session Cache is SUM(cacheRead) / SUM(cacheRead + cacheMiss) over EVERY
  // response. The two low-cache responses are real measurements and are never
  // excluded, never averaged per response, and never clamped toward a nicer
  // percentage.
  const responses = [
    { input: 169859, cacheRead: 153856 },
    { input: 171735, cacheRead: 2432 },
    { input: 182075, cacheRead: 2432 },
    { input: 184387, cacheRead: 182272 }
  ];
  const s = createCommandCodeState();
  let at = 1000;
  responses.forEach((response, index) => {
    const turn = index + 1;
    const usage = `{"inputTokens":${response.input},"outputTokens":10,"cacheReadTokens":${response.cacheRead},"cacheWriteTokens":0}`;
    parseCommandCodeRecord(`{"type":"event","event":{"type":"turn_start","turnNumber":${turn}}}`, s, at);
    parseCommandCodeRecord(`{"type":"event","event":{"type":"model_request_end","usage":${usage}}}`, s, (at += 100));
    // The real CLI repeats the request usage at turn_end; it must not double count.
    parseCommandCodeRecord(`{"type":"event","event":{"type":"turn_end","turnNumber":${turn},"usage":${usage}}}`, s, (at += 100));
  });
  const usage = normalizeUsage(s);
  const inputTotal = responses.reduce((sum, r) => sum + r.input, 0);
  const readTotal = responses.reduce((sum, r) => sum + r.cacheRead, 0);
  assert.equal(usage.tokensIn, inputTotal, "input totals are the exact sum over every response");
  assert.equal(usage.cacheRead, readTotal, "the two low-cache responses are IN the aggregate, never filtered");
  assert.equal(usage.cacheMiss, inputTotal - readTotal, "each response's miss is its own input minus its own cache-read");
  const ratio = (usage.cacheRead ?? 0) / ((usage.cacheRead ?? 0) + (usage.cacheMiss ?? 0));
  assert.equal(ratio, readTotal / inputTotal, "the hit percentage is the ratio of the SUMS, exactly");
  // A per-response average is a different number, and a >=98% cosmetic floor
  // would hide the two real low-cache responses. Neither may ever be reported.
  const perResponseAverage = responses.reduce((sum, r) => sum + r.cacheRead / r.input, 0) / responses.length;
  assert.notEqual(ratio, perResponseAverage, "an average of percentages is never the session Cache");
  assert.ok(ratio < 0.98, "no cosmetic floor may lift the provider's own evidence toward 98%");
});

test("negative / non-finite numbers are never accepted as usage", () => {
  const s = fold(['{"type":"result","usage":{"input_tokens":-5,"output_tokens":null,"credits":"x"}}']);
  assert.equal(s.tokensIn, null);
  assert.equal(s.credits, null);
});

// ---------------------------------------------------------------------------
// The canonical provider-neutral `usage` event (the ONE shared telemetry fold)
// ---------------------------------------------------------------------------

test("the canonical usage event folds context gauges (latest wins) and credit deltas (summed)", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","contextUsed":1200,"contextWindow":200000,"credits":0.5}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","contextUsed":1800,"contextWindow":200000,"credits":0.25}}', s, 2000);
  const usage = normalizeUsage(s);
  // GAUGES describe ONE instant: the latest observation replaces the earlier
  // one and is never summed into a fabricated "context of two windows".
  assert.equal(usage.contextUsed, 1800);
  assert.equal(usage.contextWindow, 200000);
  // ADDITIVE: each credit consumption contributes exactly once.
  assert.equal(usage.credits, 0.75);
  // The event carries no token/cache/USD evidence at all.
  assert.equal(usage.tokensIn, null);
  assert.equal(usage.tokensOut, null);
  assert.equal(usage.cacheRead, null);
  assert.equal(usage.totalCostUsd, null);
});

test("a canonical usage event never fabricates a metric it did not carry", () => {
  const windowOnly = normalizeUsage(fold(['{"type":"event","event":{"type":"usage","contextWindow":200000}}']));
  assert.equal(windowOnly.contextWindow, 200000);
  assert.equal(windowOnly.contextUsed, null, "no used value was reported");
  assert.equal(windowOnly.credits, null, "no credit consumption was reported");

  const creditsOnly = normalizeUsage(fold(['{"type":"event","event":{"type":"usage","credits":2}}']));
  assert.equal(creditsOnly.credits, 2);
  assert.equal(creditsOnly.contextUsed, null);
  assert.equal(creditsOnly.contextWindow, null);

  // A usage event with no usable numeric field changes nothing.
  const empty = normalizeUsage(fold(['{"type":"event","event":{"type":"usage"}}']));
  assert.equal(empty.contextUsed, null);
  assert.equal(empty.contextWindow, null);
  assert.equal(empty.credits, null);
});

test("a genuinely reported context 0 stays 0, and Command Code records never populate the gauges", () => {
  const zero = normalizeUsage(fold(['{"type":"event","event":{"type":"usage","contextUsed":0,"contextWindow":200000}}']));
  assert.equal(zero.contextUsed, 0);
  assert.equal(zero.contextWindow, 200000);

  // Command Code's own usage records describe tokens/cache/cost only: the
  // context gauges stay unavailable rather than being derived from them.
  const commandCode = normalizeUsage(fold([
    '{"type":"result","subtype":"success","usage":{"input_tokens":100,"cache_read_input_tokens":30}}'
  ]));
  assert.equal(commandCode.tokensIn, 100);
  assert.equal(commandCode.contextUsed, null);
  assert.equal(commandCode.contextWindow, null);
});

test("negative and non-finite canonical usage values are never accepted", () => {
  const s = fold([
    '{"type":"event","event":{"type":"usage","contextUsed":-1,"contextWindow":0,"credits":-3}}',
    '{"type":"event","event":{"type":"usage","contextUsed":10,"contextWindow":null,"credits":"x"}}'
  ]);
  assert.equal(s.contextUsed, 10, "the negative observation is dropped, the valid one is kept");
  assert.equal(s.contextWindow, null, "a 0 window and a null window are not measurements");
  assert.equal(s.credits, null);
});

test("the canonical usage event folds already-reconciled raw token/cache deltas", () => {
  // The provider boundary reconciles repeated snapshots of ONE response before
  // emitting them, so the raw fields are DELTAS: an unchanged snapshot emits
  // nothing, a grown one emits only the change, and a corrected-downward one
  // emits a negative delta that must be applied exactly (never discarded).
  const s = fold([
    '{"type":"event","event":{"type":"usage","tokensIn":1200,"tokensOut":40,"cacheRead":512,"cacheCreation":64}}',
    '{"type":"event","event":{"type":"usage","tokensOut":135}}',
    '{"type":"event","event":{"type":"usage","tokensOut":-20}}'
  ]);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensIn, 1200);
  assert.equal(usage.tokensOut, 155);
  assert.equal(usage.cacheRead, 512);
  assert.equal(usage.cacheCreation, 64);
  assert.equal(usage.cacheMiss, null, "a canonical event never fabricates the input-minus-cache-read relation");
  assert.equal(usage.totalCostUsd, null);
});

test("a canonical raw delta of 0 records a first genuinely-reported zero and changes no total", () => {
  const s = fold([
    '{"type":"event","event":{"type":"usage","tokensOut":0}}',
    '{"type":"event","event":{"type":"usage","tokensOut":0}}'
  ]);
  assert.equal(normalizeUsage(s).tokensOut, 0, "a reported 0 stays 0, never null");
});

test("Command Code usage records are unaffected by the canonical delta fields", () => {
  const s = fold([
    '{"type":"event","event":{"type":"turn_start","turnNumber":1}}',
    '{"type":"event","event":{"type":"model_request_end","usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheWriteTokens":1}}}',
    '{"type":"result","subtype":"success","result":"ok"}'
  ]);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensIn, 10);
  assert.equal(usage.tokensOut, 4);
  assert.equal(usage.cacheRead, 3);
  assert.equal(usage.cacheMiss, 7, "Command Code keeps its own input-minus-cache-read derivation");
  assert.equal(usage.cacheCreation, 1);
  assert.equal(usage.contextUsed, null, "Command Code records never populate the context gauges");
  assert.equal(usage.contextWindow, null);
});

test("a reasoning-only turn without its own token count contributes NO decode sample", () => {
  // A real WorkBuddy ACP turn can stream reasoning and no assistant message at
  // all (the model answers nothing, or the turn ends on a tool boundary). The
  // interval is still closed at its last generated delta (never left dangling),
  // but with no provider-reported output token count for that response the
  // PAIRED metrics stay absent: an unpaired interval is omitted, never paired
  // with another response's tokens and never shown as raw seconds.
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_start"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"a"}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"b"}}', s, 2600);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_end"}}', s, 2700);
  assert.equal(s.decodeWindowSampleId, null, "the open window is closed, never left dangling");
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, null, "no provider-reported output tokens → no numerator");
  assert.equal(usage.decodeSeconds, null, "no pair → Decode stays absent");
});

test("a reasoning-only turn pairs its measured interval with the request's own output tokens", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"a"}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"b"}}', s, 2600);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_end"}}', s, 2700);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":8}}}', s, 2800);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 8, "the request's own output token count is the numerator");
  assert.equal(usage.decodeSeconds, 1.5, "first delta → last delta of the reasoning block");
});

test("a thinking block and its answer measure ONE continuous interval — the internal gap is decode time (the inflated-rate regression)", () => {
  // The previous build summed only the ACTIVE streaming blocks: it closed the
  // reasoning block at its last delta and reopened a fresh window at the first
  // answer delta, so the gap between them — the model still decoding — vanished
  // from the denominator and the tok/s rate was inflated. A response measures
  // ONE continuous interval: its first non-empty output → its completion
  // boundary, with every internal block gap included.
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 900);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_start"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"a"}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_delta","delta":"b"}}', s, 2600);
  parseCommandCodeRecord('{"type":"event","event":{"type":"thinking_end"}}', s, 2700);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_start"}}', s, 2800);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hi"}}', s, 2900);
  // The real CLI order: the request completion boundary carries the usage.
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":12}}}', s, 3900);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 4000);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 12);
  assert.equal(
    usage.decodeSeconds,
    2.8,
    "1100 → 3900: the 300ms thinking→answer gap is included, never dropped"
  );
  // The old sum-of-blocks shape measured 1.5s + 1.0s = 2.5s and would have
  // rendered 4.8 tok/s for a response that really took 2.8s (4.3 tok/s).
});

test("an unpaired interval or token count never fabricates Decode", () => {
  // (a) Output tokens reported, but the response's output was never timed:
  // there is no denominator, so the tokens contribute no sample.
  const a = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', a, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":4}}}', a, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_end","turnNumber":1,"usage":{"outputTokens":4}}}', a, 1200);
  assert.equal(normalizeUsage(a).tokensOut, 4, "the run total still receives the tokens");
  assert.equal(normalizeUsage(a).decodeTokens, null);
  assert.equal(normalizeUsage(a).decodeSeconds, null);

  // (b) Timed output whose own usage never arrives: no numerator, no sample.
  const b = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hi"}}', b, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', b, 2000);
  assert.equal(normalizeUsage(b).decodeTokens, null);
  assert.equal(normalizeUsage(b).decodeSeconds, null);

  // (c) A canonical usage event whose token delta proves no response identity
  // cannot be linked to the interval that streamed: it is folded into the run
  // total exactly as before but never paired.
  const c = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hi"}}', c, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', c, 2000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":4}}', c, 2100);
  assert.equal(normalizeUsage(c).tokensOut, 4, "the run total still receives the delta");
  assert.equal(normalizeUsage(c).decodeTokens, null, "no identity → no pair");
  assert.equal(normalizeUsage(c).decodeSeconds, null);
});

test("the job decode rate is SUM(paired tokens) / SUM(paired seconds), never an average of per-response rates", () => {
  const s = createCommandCodeState();
  // Response A: 10 tokens over 1.0s → 10.0 tok/s.
  parseCommandCodeRecord('{"type":"event","event":{"type":"response_stats","messageId":"mA","firstTokenAt":1000,"completedAt":2000,"outputTokens":10}}', s);
  // Response B: 30 tokens over 2.0s → 15.0 tok/s.
  parseCommandCodeRecord('{"type":"event","event":{"type":"response_stats","messageId":"mB","firstTokenAt":3000,"completedAt":5000,"outputTokens":30}}', s);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 40, "paired numerators sum across completed responses");
  assert.equal(usage.decodeSeconds, 3, "paired denominators sum across the same responses");
  // 40 / 3 = 13.3 tok/s. An average of the two per-response rates would be
  // (10 + 15) / 2 = 12.5 — the contract is the ratio of the sums.
});

test("the paired rate never borrows the output tokens of an UNPAIRED response", () => {
  // The exact bug this contract exists to prevent: total tokensOut covers two
  // responses, but only ONE of them proved its own decode facts. The old
  // formula (total tokensOut / decodeSeconds) would render 40 / 1 = 40.0
  // tok/s — a fabricated rate for the untimed response. The paired
  // numerator/denominator must describe the SAME set of responses.
  const s = createCommandCodeState();
  // Response A: paired — its own exact completed-response evidence; its tokens
  // arrive BOTH as the run-total delta a real boundary publishes and inside the
  // exact sample.
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":10,"messageId":"mA"}}', s);
  parseCommandCodeRecord('{"type":"event","event":{"type":"response_stats","messageId":"mA","firstTokenAt":1000,"completedAt":2000,"outputTokens":10}}', s);
  // Response B: its own 30 output tokens were reported, but no exact
  // completed-response evidence of that response exists — it contributes to
  // the run total only.
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":30,"messageId":"mB"}}', s);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensOut, 40, "the run total still includes BOTH responses");
  assert.equal(usage.decodeTokens, 10, "only the paired response's own tokens are the numerator");
  assert.equal(usage.decodeSeconds, 1, "only the paired response's interval is the denominator");
  // Paired rate = 10 / 1 = 10.0 tok/s; the unpaired 30 tokens are never divided.
});

test("a corrected-downward usage delta moves the run total, never a decode pair", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":320,"messageId":"m1"}}', s);
  assert.equal(normalizeUsage(s).tokensOut, 320);
  assert.equal(normalizeUsage(s).decodeTokens, null, "run-total deltas never pair by themselves");
  // The provider corrects the SAME response downward: only the change applies.
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":-20,"messageId":"m1"}}', s);
  const usage = normalizeUsage(s);
  assert.equal(usage.tokensOut, 300, "320 then −20 is exactly 300, never 620 or a stale 320");
  assert.equal(usage.decodeTokens, null, "the correction never fabricates a decode pair");
  assert.equal(usage.decodeSeconds, null);
});

test("the response's completion boundary instant ends the interval, not the last token", () => {
  // A one-delta response still has a measurable interval: the request boundary
  // is the response's completion evidence, so the denominator runs to it. The
  // old code closed at the last delta (end === start) and measured nothing.
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hi"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":5}}}', s, 1800);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 5);
  assert.equal(usage.decodeSeconds, 0.8, "1000 → the 1800ms request boundary");
});

test("a response that streams again after its completion starts a NEW epoch — idle time is never decode", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 900);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"a"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 2000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":10}}}', s, 2100);
  assert.deepEqual([normalizeUsage(s).decodeTokens, normalizeUsage(s).decodeSeconds], [10, 1]);
  // The same identity-less scope streams again 1.0s later: the previous
  // interval had already COMPLETED at 2000, so the gap is idle time, never
  // decode.
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"b"}}', s, 3000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 4000);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeSeconds, 1, "the new epoch measures 3000 → 4000, never 1000 → 4000");
  assert.equal(usage.decodeTokens, 10, "the numerator is the request's own token count, not re-added");
});

test("tool execution time is never decode: output after a completed response opens a new epoch", () => {
  // The synthetic worst case for identity reuse: a completed response, then a
  // tool runs for 7 seconds, then the same scope streams again. Tool
  // execution is not model output, so it must never reach the denominator.
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 900);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"a"}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 2000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":10}}}', s, 2100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"tool_queued","toolCallId":"c1","toolName":"Bash"}}', s, 2200);
  parseCommandCodeRecord('{"type":"event","event":{"type":"tool_completed","toolCallId":"c1"}}', s, 9200);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"b"}}', s, 9300);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 10300);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 10);
  assert.equal(usage.decodeSeconds, 1, "the 7s tool run is never counted as decode time");
});

test("a turn whose usage is published only at turn_end pairs exactly once", () => {
  const s = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', s, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"hi"}}', s, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end"}}', s, 2100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_end","turnNumber":1,"usage":{"outputTokens":6}}}', s, 2200);
  const usage = normalizeUsage(s);
  assert.equal(usage.decodeTokens, 6);
  assert.equal(usage.decodeSeconds, 1, "the closed request-scope interval is paired exactly once");
});

test("the line splitter handles chunk splits and CRLF, and flushes the tail", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.feed('{"a":1}\r\n{"b":'), ['{"a":1}']);
  assert.deepEqual(sp.feed('2}\n'), ['{"b":2}']);
  assert.deepEqual(sp.feed("tail-no-newline"), []);
  assert.deepEqual(sp.flush(), ["tail-no-newline"]);
  assert.deepEqual(sp.flush(), []);
});

test("an oversized unterminated line is force-emitted instead of buffering forever", () => {
  const sp = createLineSplitter(16);
  const emitted = sp.feed("x".repeat(20));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], "x".repeat(20));
});
