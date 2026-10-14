// decode-dsh.test.ts — the dsh-exact decode contract.
//
// The official deepseek-harness `sessionStats` fold is the normative algorithm
// (see src/tests/helpers/dsh-session-stats.ts, a one-for-one port of the
// installed @deepseek-ai/dsh-session-stats projection):
//   - decode time per response = first meaningful NON-EMPTY output token →
//     assembled/final assistant message (internal reasoning→answer gaps and
//     the full stream span included; prefill/TTFT and tool execution excluded);
//   - numerator = the provider-reported output tokens of that SAME response;
//   - only responses with BOTH facts contribute; a cancelled/incomplete
//     response that never assembles a message contributes neither;
//   - totals are SUMS over exactly those responses, so the session rate is a
//     ratio of sums, never an average of per-response rates and never the full
//     token total over a subset denominator.
//
// Production folds the same contract through the canonical `response_stats`
// event (the explicit completed-response timing evidence a proving provider
// boundary emits). Tests pin the two aggregate acceptance vectors and prove
// that the bespoke ACP synthetic-boundary path alone yields NO Decode.
import test from "node:test";
import assert from "node:assert/strict";
import { createCommandCodeState, parseCommandCodeRecord, normalizeUsage } from "../../providers/command-code/stream";
import { createWorkBuddyAiAdapter } from "../../providers/workbuddy-ai/index";
import { acpFixtureRunLines } from "../helpers/acp-workbuddy-fixture";
import { foldDshSessionStats } from "../helpers/dsh-session-stats";
import {
  DSH_PINNED_DECODE_VECTORS,
  PINNED_VECTOR_A_RECORDS,
  PINNED_VECTOR_B_RECORDS,
  REAL_SHAPE_GENERATION_RECORDS,
  dshSessionEventsOf,
  responseStatsDurationLinesOf,
  responseStatsLinesOf,
  type WorkBuddyGenerationRecord
} from "../fixtures/workbuddy-decode-records";

function foldLines(lines: string[]) {
  const state = createCommandCodeState();
  for (const line of lines) parseCommandCodeRecord(line, state);
  return normalizeUsage(state);
}

function assertApprox(actual: number | null, expected: number, epsilon: number, message: string): void {
  assert.ok(actual != null, `${message} (expected a number, got ${String(actual)})`);
  assert.ok(Math.abs((actual as number) - expected) <= epsilon, `${message}: ${String(actual)} vs ${expected}`);
}

const [PINNED_VECTOR_A, PINNED_VECTOR_B] = DSH_PINNED_DECODE_VECTORS;

test("the reference fold reproduces both pinned aggregate acceptance vectors", () => {
  for (const [pinned, records] of [
    [PINNED_VECTOR_A, PINNED_VECTOR_A_RECORDS],
    [PINNED_VECTOR_B, PINNED_VECTOR_B_RECORDS]
  ] as const) {
    const stats = foldDshSessionStats(dshSessionEventsOf(records));
    assert.equal(stats.decodeTokens, pinned.tokens, `${pinned.name}: output tokens`);
    assert.equal(stats.decodeMs, Math.round(pinned.seconds * 1000), `${pinned.name}: first-token → final spans`);
    assertApprox(stats.decodeTokens / (stats.decodeMs / 1000), pinned.rate, 0.05, `${pinned.name}: ratio of sums`);
  }
});

test("production folds the pinned vectors to exactly the reference totals", () => {
  for (const [pinned, records] of [
    [PINNED_VECTOR_A, PINNED_VECTOR_A_RECORDS],
    [PINNED_VECTOR_B, PINNED_VECTOR_B_RECORDS]
  ] as const) {
    const reference = foldDshSessionStats(dshSessionEventsOf(records));
    const production = foldLines(responseStatsLinesOf(records));
    assert.equal(production.decodeTokens, reference.decodeTokens, `${pinned.name}: numerator parity`);
    assert.equal(
      Math.round((production.decodeSeconds ?? 0) * 1000),
      reference.decodeMs,
      `${pinned.name}: denominator parity`
    );
    assertApprox(
      (production.decodeTokens as number) / (production.decodeSeconds as number),
      pinned.rate,
      0.05,
      `${pinned.name}: production ratio of sums`
    );
  }
});

test("production matches the reference fold on the sanitized real-shape generation records", () => {
  const reference = foldDshSessionStats(dshSessionEventsOf(REAL_SHAPE_GENERATION_RECORDS));
  const production = foldLines(responseStatsLinesOf(REAL_SHAPE_GENERATION_RECORDS));
  // The cancelled response (no assembled message) and the response whose
  // provider never reported output tokens contribute NEITHER side.
  assert.equal(production.decodeTokens, reference.decodeTokens);
  assert.equal(Math.round((production.decodeSeconds ?? 0) * 1000), reference.decodeMs);
  assert.equal(production.decodeTokens, 1_365, "only the eight completed, usage-reporting responses are paired");
  assert.equal(production.decodeSeconds, 4.136);
  // Tool windows in the fixture never enter decode: the reference tool total
  // is measured independently (or 0 when the group carries no tools).
  assert.equal(reference.toolMs, 0);
});

test("the duration/ttft form is the same exact evidence as explicit instants", () => {
  const reference = foldDshSessionStats(dshSessionEventsOf(PINNED_VECTOR_A_RECORDS));
  const production = foldLines(responseStatsDurationLinesOf(PINNED_VECTOR_A_RECORDS));
  assert.equal(production.decodeTokens, reference.decodeTokens);
  assert.equal(Math.round((production.decodeSeconds ?? 0) * 1000), reference.decodeMs);
});

test("a long TTFT is excluded: decode starts at the first meaningful token", () => {
  const slowStart: WorkBuddyGenerationRecord[] = [
    {
      responseId: "resp-slow-prefill",
      startedAt: 1_000_000,
      // 60 seconds of prefill before the first output token…
      firstTokenAt: 1_060_000,
      // …then 2 seconds of decode to the assembled message.
      completedAt: 1_062_000,
      outputTokens: 500
    }
  ];
  const reference = foldDshSessionStats(dshSessionEventsOf(slowStart));
  assert.equal(reference.ttftMs, 60_000, "TTFT is measured, never decoded");
  assert.equal(reference.decodeMs, 2_000, "decode spans first token → final message only");
  const production = foldLines(responseStatsLinesOf(slowStart));
  assert.equal(production.decodeTokens, 500);
  assert.equal(production.decodeSeconds, 2, "the 60s prefill never reaches the denominator");
});

test("the reasoning → answer gap INSIDE one response stays decode time", () => {
  const gapped: WorkBuddyGenerationRecord[] = [
    {
      responseId: "resp-reasoning-gap",
      startedAt: 2_000_000,
      firstTokenAt: 2_001_000,
      // 12 seconds from the first reasoning token to the assembled answer: the
      // internal gap is decoding, exactly as dsh measures it.
      completedAt: 2_013_000,
      outputTokens: 900,
      firstDeltaKind: "reasoning"
    }
  ];
  const reference = foldDshSessionStats(dshSessionEventsOf(gapped));
  assert.equal(reference.decodeMs, 12_000);
  assert.equal(reference.llmMs, 13_000, "model wall time additionally covers the prefill, unlike decode");
  const production = foldLines(responseStatsLinesOf(gapped));
  assert.equal(production.decodeTokens, 900);
  assert.equal(production.decodeSeconds, 12);
});

test("tool execution time is excluded: a tool window never changes the decode totals", () => {
  const withTools: WorkBuddyGenerationRecord[] = [
    {
      responseId: "resp-tools",
      startedAt: 3_000_000,
      firstTokenAt: 3_001_000,
      completedAt: 3_005_000,
      outputTokens: 300,
      tools: [
        { callId: "t1", startedAt: 3_005_100, endedAt: 3_075_100 },
        { callId: "t2", startedAt: 3_075_200, endedAt: 3_095_200 }
      ]
    }
  ];
  const reference = foldDshSessionStats(dshSessionEventsOf(withTools));
  assert.equal(reference.toolMs, 90_000, "tool time is paired by callId");
  assert.equal(reference.decodeMs, 4_000, "decode is first token → final message, never tool time");
  const production = foldLines(responseStatsLinesOf(withTools));
  assert.equal(production.decodeSeconds, 4, "the 90s of tool execution is never decode time");
  assert.equal(production.decodeTokens, 300);
});

test("an incomplete response contributes neither numerator nor denominator", () => {
  const cancelled: WorkBuddyGenerationRecord[] = [
    {
      responseId: "resp-cancelled",
      startedAt: 4_000_000,
      firstTokenAt: 4_001_000,
      completedAt: null,
      outputTokens: null
    }
  ];
  const reference = foldDshSessionStats(dshSessionEventsOf(cancelled));
  assert.deepEqual([reference.decodeTokens, reference.decodeMs], [0, 0], "no assembled message → no decode sample");
  const production = foldLines(responseStatsLinesOf(cancelled));
  assert.equal(production.decodeTokens, null, "no exact sample → Decode stays unavailable, never 0");
  assert.equal(production.decodeSeconds, null);
});

test("multiple steps use the ratio of sums, never an average of per-response rates", () => {
  const mixed: WorkBuddyGenerationRecord[] = [
    { responseId: "fast", startedAt: 5_000_000, firstTokenAt: 5_000_000, completedAt: 5_001_000, outputTokens: 100 },
    { responseId: "slow", startedAt: 6_000_000, firstTokenAt: 6_000_000, completedAt: 6_010_000, outputTokens: 10 }
  ];
  const reference = foldDshSessionStats(dshSessionEventsOf(mixed));
  // (100 + 10) / (1 + 10) = 10.0. An average of the per-response rates would
  // be (100.0 + 1.0) / 2 = 50.5.
  assert.equal(reference.decodeTokens / (reference.decodeMs / 1000), 10);
  const production = foldLines(responseStatsLinesOf(mixed));
  assert.equal(production.decodeTokens, 110);
  assert.equal(production.decodeSeconds, 11);
  assert.equal((production.decodeTokens as number) / (production.decodeSeconds as number), 10);
});

test("a response-id mismatch cannot fabricate a pair", () => {
  const state = createCommandCodeState();
  // A canonical usage event claims tokens for `mB`, but `mB` has NO exact
  // completed-response event: those tokens never enter Decode.
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":30,"messageId":"mB"}}', state);
  // `mA` has an exact event with a MISSING output-token count while its usage
  // event carries tokens: still no pair — the exact event's own facts are the
  // only authority, never another record's numbers.
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":10,"messageId":"mA"}}', state);
  parseCommandCodeRecord('{"type":"event","event":{"type":"response_stats","messageId":"mA","firstTokenAt":1000,"completedAt":2000}}', state);
  const usage = normalizeUsage(state);
  assert.equal(usage.tokensOut, 40, "the run total still receives every delta");
  assert.equal(usage.decodeTokens, null, "no exact response_stats pair → no numerator");
  assert.equal(usage.decodeSeconds, null, "no exact response_stats pair → no denominator");
  // A later exact event for `mA` pairs ONLY its own facts (10 tokens over 1s),
  // and `mB`'s tokens stay out even though the run total holds them.
  parseCommandCodeRecord('{"type":"event","event":{"type":"response_stats","messageId":"mA","firstTokenAt":5000,"completedAt":6000,"outputTokens":10}}', state);
  const paired = normalizeUsage(state);
  assert.equal(paired.decodeTokens, 10);
  assert.equal(paired.decodeSeconds, 1);
});

test("a repeated or corrected response_stats moves the totals by the exact change", () => {
  const state = createCommandCodeState();
  const line = (tokens: number) =>
    JSON.stringify({ type: "event", event: { type: "response_stats", messageId: "m1", firstTokenAt: 1000, completedAt: 2000, outputTokens: tokens } });
  parseCommandCodeRecord(line(320), state);
  parseCommandCodeRecord(line(320), state);
  assert.deepEqual([normalizeUsage(state).decodeTokens, normalizeUsage(state).decodeSeconds], [320, 1], "a republication never double counts");
  parseCommandCodeRecord(line(300), state);
  const usage = normalizeUsage(state);
  assert.equal(usage.decodeTokens, 300, "320 then 300 pairs exactly 300, never 620 or a stale 320");
  assert.equal(usage.decodeSeconds, 1, "the interval is unchanged by the correction");
});

test("the bespoke ACP synthetic-boundary path alone produces NO Decode", () => {
  // The recorded-shape ACP conversation streams reasoning + answer chunks,
  // closes its message at a CrewDispatch-synthesized boundary and publishes the
  // response's usage — exactly what the old approximation paired into a rate.
  // Under the dsh contract none of it proves the assembled/final instant, so
  // Decode must stay null rather than report an inflated figure.
  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000_000;
  for (const line of acpFixtureRunLines("deepseek-v4.1-flash")) {
    adapter.parseStreamLine(line, state, at);
    at += 400;
  }
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensOut, 320, "the usage_update's raw snapshot still reaches the run total");
  assert.equal(usage.decodeTokens, null, "synthetic boundaries never authorize a numerator");
  assert.equal(usage.decodeSeconds, null, "synthetic boundaries never authorize a denominator");
});

test("An identity-carrying stream's chunk/usage events never pair without an exact completion event", () => {
  // The minimal old-pairing shape: first delta, synthesized message_end and the
  // response's own usage delta. Nothing here proves an assembled/final instant.
  const state = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"a","messageId":"m1","timestamp":1000}}', state, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"message_end","messageId":"m1","timestamp":5000}}', state, 5000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"usage","tokensOut":40,"messageId":"m1"}}', state);
  const usage = normalizeUsage(state);
  assert.equal(usage.tokensOut, 40);
  assert.equal(usage.decodeTokens, null);
  assert.equal(usage.decodeSeconds, null);
});

test("Command Code's native request/turn boundaries keep pairing (no regression)", () => {
  const state = createCommandCodeState();
  parseCommandCodeRecord('{"type":"event","event":{"type":"turn_start","turnNumber":1}}', state, 1000);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"a"}}', state, 1100);
  parseCommandCodeRecord('{"type":"event","event":{"type":"text_delta","delta":"b"}}', state, 2600);
  parseCommandCodeRecord('{"type":"event","event":{"type":"model_request_end","usage":{"outputTokens":12}}}', state, 3900);
  const usage = normalizeUsage(state);
  assert.equal(usage.decodeTokens, 12, "the request's own output tokens pair with its native boundary");
  assert.equal(usage.decodeSeconds, 2.8, "first delta → the provider's own request boundary");
});
