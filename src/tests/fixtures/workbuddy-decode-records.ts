// workbuddy-decode-records.ts — sanitized real-shape WorkBuddy generation
// records for the dsh-exact decode tests.
//
// SHAPE (read locally from the installed WorkBuddy Desktop 5.6.2 runtime and
// its ACP bridge; no prompts, answers, tool text, file paths or user content):
//   - `responseId`    — the model-response identity the runtime publishes
//                       (`codebuddy.ai/messageId`); SANITIZED here.
//   - `startedAt`     — generation start.
//   - `firstTokenAt`  — the runtime's "first meaningful token" instant (it logs
//                       `requestId` + `ttft` per generation); null when no
//                       meaningful output token was ever produced.
//   - `completedAt`   — the assembled/final assistant-response instant; null
//                       for a cancelled/incomplete response that never
//                       assembled one.
//   - `outputTokens`  — the provider-reported output tokens attached to that
//                       final response; null when unreported.
//   - `tools`         — tool executions the runtime ran after the response;
//                       never part of decode.
//
// The REAL_SHAPE records take their per-response output tokens and
// first-token→final spans from a real JobQuay-dispatched WorkBuddy run
// (2026-10-01, deepseek-v4.1-flash); ids are replaced and start offsets/ttft
// are rounded to the observed ranges, so the file is sanitized but
// dimensionally real. The two PINNED groups carry the aggregate acceptance
// vectors the task pins (92,651 tokens / 342.433 s and 71,186 tokens /
// 244.465 s); their per-response decomposition is sanitized real-shape data.
import type { DshSessionEvent } from "../helpers/dsh-session-stats";

export interface WorkBuddyToolWindow {
  callId: string;
  startedAt: number;
  endedAt: number;
}

export interface WorkBuddyGenerationRecord {
  responseId: string;
  startedAt: number;
  firstTokenAt: number | null;
  completedAt: number | null;
  outputTokens: number | null;
  tools?: WorkBuddyToolWindow[];
  /** The kind of the FIRST non-empty output delta (reasoning deltas count too). */
  firstDeltaKind?: "text" | "reasoning";
}

/** Aggregate acceptance vectors pinned for the dsh fold (task-provided). */
export const DSH_PINNED_DECODE_VECTORS = [
  { name: "pinned-92651", tokens: 92_651, seconds: 342.433, rate: 270.6 },
  { name: "pinned-71186", tokens: 71_186, seconds: 244.465, rate: 291.2 }
] as const;

/** A real-shape group: real per-response spans/tokens, sanitized identities. */
const SHAPE_BASE = 1_800_000_000_000;
function shapeRecord(
  index: number,
  outputTokens: number,
  decodeMs: number,
  ttftMs: number,
  extra: Partial<WorkBuddyGenerationRecord> = {}
): WorkBuddyGenerationRecord {
  const startedAt = SHAPE_BASE + index * 60_000;
  const firstTokenAt = startedAt + ttftMs;
  return {
    responseId: `resp-shape-${String(index + 1).padStart(2, "0")}`,
    startedAt,
    firstTokenAt,
    completedAt: firstTokenAt + decodeMs,
    outputTokens,
    ...extra
  };
}

export const REAL_SHAPE_GENERATION_RECORDS: readonly WorkBuddyGenerationRecord[] = [
  shapeRecord(0, 168, 451, 2_870),
  shapeRecord(1, 260, 776, 3_309),
  shapeRecord(2, 283, 988, 2_950),
  shapeRecord(3, 193, 577, 1_800, { firstDeltaKind: "reasoning" }),
  shapeRecord(4, 73, 173, 2_400),
  shapeRecord(5, 52, 237, 2_100),
  shapeRecord(6, 128, 336, 1_900, { firstDeltaKind: "reasoning" }),
  shapeRecord(7, 208, 598, 2_600),
  // A cancelled response that never assembled a final assistant message: it
  // produced a first token but contributes NEITHER numerator nor denominator.
  {
    responseId: "resp-shape-09-cancelled",
    startedAt: SHAPE_BASE + 8 * 60_000,
    firstTokenAt: SHAPE_BASE + 8 * 60_000 + 1_500,
    completedAt: null,
    outputTokens: null
  },
  // A completed response whose provider never reported output tokens: its
  // timing must not enter the denominator either.
  {
    responseId: "resp-shape-10-unreported",
    startedAt: SHAPE_BASE + 9 * 60_000,
    firstTokenAt: SHAPE_BASE + 9 * 60_000 + 1_200,
    completedAt: SHAPE_BASE + 9 * 60_000 + 1_200 + 900,
    outputTokens: null
  }
];

function vectorRecord(
  prefix: string,
  index: number,
  outputTokens: number,
  decodeMs: number,
  ttftMs: number,
  toolMs?: number
): WorkBuddyGenerationRecord {
  const startedAt = 1_900_000_000_000 + index * 120_000;
  const firstTokenAt = startedAt + ttftMs;
  const completedAt = firstTokenAt + decodeMs;
  return {
    responseId: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    startedAt,
    firstTokenAt,
    completedAt,
    outputTokens,
    ...(toolMs != null
      ? { tools: [{ callId: `${prefix}-tool-${index + 1}`, startedAt: completedAt + 50, endedAt: completedAt + 50 + toolMs }] }
      : {})
  };
}

/** 92,651 output tokens over 342,433 ms of first-token → final spans (270.6 tok/s). */
export const PINNED_VECTOR_A_RECORDS: readonly WorkBuddyGenerationRecord[] = [
  vectorRecord("pinned-a", 0, 12_480, 45_250, 2_600, 12_000),
  vectorRecord("pinned-a", 1, 9_340, 30_000, 3_100),
  vectorRecord("pinned-a", 2, 7_215, 24_500, 2_450, 4_500),
  vectorRecord("pinned-a", 3, 16_880, 60_300, 2_900),
  vectorRecord("pinned-a", 4, 11_020, 41_100, 3_400, 9_000),
  vectorRecord("pinned-a", 5, 8_760, 33_200, 2_200),
  vectorRecord("pinned-a", 6, 14_210, 55_450, 3_800, 6_000),
  vectorRecord("pinned-a", 7, 12_746, 52_633, 2_700)
];

/** 71,186 output tokens over 244,465 ms of first-token → final spans (291.2 tok/s). */
export const PINNED_VECTOR_B_RECORDS: readonly WorkBuddyGenerationRecord[] = [
  vectorRecord("pinned-b", 0, 11_240, 38_400, 2_500, 7_500),
  vectorRecord("pinned-b", 1, 8_910, 30_250, 3_000),
  vectorRecord("pinned-b", 2, 14_320, 49_600, 2_800, 15_000),
  vectorRecord("pinned-b", 3, 9_860, 33_900, 2_150),
  vectorRecord("pinned-b", 4, 12_750, 43_800, 3_300, 5_500),
  vectorRecord("pinned-b", 5, 7_406, 25_315, 2_400),
  vectorRecord("pinned-b", 6, 6_700, 23_200, 2_900, 8_000)
];

/**
 * The same records as the official durable dsh session events the reference
 * fold consumes: every response is one step (`step/start` → first non-empty
 * delta → tool pairs → assembled `assistant/message` → `step/end`). A
 * response with no assembled message publishes no `assistant/message`.
 */
export function dshSessionEventsOf(records: readonly WorkBuddyGenerationRecord[]): DshSessionEvent[] {
  const events: DshSessionEvent[] = [];
  const turn = 1;
  records.forEach((record, index) => {
    const step = index + 1;
    events.push({ type: "step/start", time: record.startedAt, data: { turn, step } });
    if (record.firstTokenAt != null) {
      events.push({
        type: "assistant/chunk",
        time: record.firstTokenAt,
        data: {
          turn,
          step,
          chunk:
            record.firstDeltaKind === "reasoning"
              ? { type: "reasoning-delta", text: "reasoning" }
              : { type: "text-delta", text: "answer" }
        }
      });
    }
    if (record.completedAt != null) {
      events.push({
        type: "assistant/message",
        time: record.completedAt,
        data: { turn, step, usage: record.outputTokens != null ? { outputTokens: record.outputTokens } : null }
      });
    }
    for (const tool of record.tools ?? []) {
      events.push({ type: "tool/call", time: tool.startedAt, data: { turn, step, callId: tool.callId } });
      events.push({ type: "tool/result", time: tool.endedAt, data: { turn, step, message: { source: { callId: tool.callId } } } });
    }
    const lastToolEnd = (record.tools ?? []).reduce((max, tool) => Math.max(max, tool.endedAt), 0);
    events.push({
      type: "step/end",
      time: Math.max(record.completedAt ?? record.firstTokenAt ?? record.startedAt, lastToolEnd),
      data: { turn, step }
    });
  });
  return events;
}

/**
 * The same records as JobQuay's canonical `response_stats` NDJSON lines: the
 * explicit completed-response timing event a proving provider boundary emits
 * (response id, firstTokenAt/ttft, completedAt/duration, outputTokens). A
 * response missing any fact emits NOTHING — it can never be paired.
 */
export function responseStatsLinesOf(records: readonly WorkBuddyGenerationRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (record.firstTokenAt == null || record.completedAt == null || record.outputTokens == null) continue;
    lines.push(JSON.stringify({
      type: "event",
      event: {
        type: "response_stats",
        messageId: record.responseId,
        firstTokenAt: record.firstTokenAt,
        completedAt: record.completedAt,
        outputTokens: record.outputTokens
      }
    }));
  }
  return lines;
}

/**
 * The duration/ttft form of the same events (`durationMs` + `ttftMs`, the
 * runtime's own generation-duration and first-token-latency facts) — the
 * alternate exact evidence the canonical event accepts.
 */
export function responseStatsDurationLinesOf(records: readonly WorkBuddyGenerationRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (record.firstTokenAt == null || record.completedAt == null || record.outputTokens == null) continue;
    lines.push(JSON.stringify({
      type: "event",
      event: {
        type: "response_stats",
        messageId: record.responseId,
        durationMs: record.completedAt - record.startedAt,
        ttftMs: record.firstTokenAt - record.startedAt,
        outputTokens: record.outputTokens
      }
    }));
  }
  return lines;
}
