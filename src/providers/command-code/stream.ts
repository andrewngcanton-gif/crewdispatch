// stream.ts — the tolerant NDJSON parser of `cmdc -p --output-format json`.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` createCommandCodeState / parseCommandCodeRecord /
// usage handling. Pure: no process, no I/O, never throws.
//
// TOLERANCE RULES (the exact field names of a future CLI release must not break a
// run):
//   - an unknown record type is counted and ignored, never an error;
//   - a malformed line is counted (bounded) and kept in the bounded diagnostic
//     tail, never thrown on;
//   - chunk splits are handled by the line splitter, so this function only ever
//     sees complete lines;
//   - the terminal record's subtype decides the outcome class;
//   - usage is taken ONLY from explicit numeric fields. A metric the transport
//     does not report stays null and is displayed as unavailable — never
//     estimated from tokens and never a fabricated 0;
//   - the internal tool-event counter is kept separately from what is shown: a
//     count is exposed only when the stream carried tool evidence (an explicit
//     count or at least one tool event). A run that never mentioned tools
//     reports toolCalls = null, not 0.
//
// CANONICAL USAGE EVENT: this is the ONE shared parser of the CrewDispatch event
// vocabulary, so it also folds the provider-neutral `usage` event a transport
// publishes through its own normalizer (see
// src/providers/workbuddy-ai/acp-normalizer.ts and the Command Code ACP bridge,
// src/providers/command-code/acp-normalizer.ts):
//
//   {"type":"event","event":{"type":"usage",
//     "contextUsed":1200,"contextWindow":200000,"credits":0.5,
//     "totalCostUsd":0.0125,"tokensIn":1200,"tokensOut":320,"cacheRead":512}}
//
// `contextUsed`/`contextWindow` are GAUGES (latest observation wins); `credits`,
// `totalCostUsd` and the raw `tokensIn`/`tokensOut`/`cacheRead`/`cacheCreation`
// amounts are ADDITIVE. The raw amounts are emitted by the provider boundary as
// already-reconciled DELTAS: repeated snapshots of ONE model response replace
// each other there, so a delta may be negative when a later snapshot corrected
// an earlier observation downward (a plain republication emits no delta at
// all). Absent fields are ignored, so a provider that publishes only context
// keeps credits and tokens null. A `contextWindow` of 0 is never a
// measurement — no model has a 0-token window, and providers use 0 as an
// "unresolved" sentinel — so it is ignored rather than stored. Command Code
// itself never emits this event; its own `usage` records are folded by
// `applyUsage` exactly as before.
//
// PAIRED DECODE (the `decodeTokens` / `decodeSeconds` contract): the UI rate
// may only divide output tokens by decode time when BOTH describe the very same
// completed model responses. The normative algorithm is the official
// deepseek-harness `sessionStats` projection
// (@deepseek-ai/dsh-session-stats, `lib/types/projection.js`):
//
//   * `step/start` opens a step; the first non-empty stream delta
//     (`isTokenDelta`: non-empty text/reasoning/tool-call delta) records the
//     step's first-token instant;
//   * `assistant/message` is the ASSEMBLED response: decode time is
//     `messageTime − firstTokenTime` and the numerator is that same message's
//     provider-reported `usage.outputTokens`, counted ONLY when the step has
//     both a first-token instant AND a reported output-token count;
//   * a cancelled/incomplete response that never assembles a message
//     contributes NEITHER numerator nor denominator;
//   * totals are sums over exactly those steps — the rate is
//     `SUM(decodeTokens) / SUM(decodeMs)`, a ratio of sums, never an average
//     of per-response rates and never a subset denominator for the full token
//     total.
//
// Prefill/TTFT is excluded (decode starts at the first token), tool execution
// after a completed response is excluded (the next response's clock starts at
// its own first token), and the reasoning → answer gap INSIDE one response is
// included (first token → assembled message is one wall-clock span).
//
// CrewDispatch folds this contract through two kinds of evidence:
//   - `response_stats` — the explicit canonical completed-response timing
//     event (response id, firstTokenAt/ttft, completedAt/duration,
//     outputTokens). A response contributes its OWN facts, exactly once; a
//     repeated/corrected event for the same id moves the totals by the exact
//     change. This is the only decode evidence for a provider whose transport
//     carries a response identity (WorkBuddy ACP): its message/thinking
//     boundaries are CrewDispatch-synthesized closures, so they may drive activity
//     rendering but must NEVER authorize throughput.
//   - the implicit request/turn scope of Command Code's own records. Its
//     `model_request_start`/`model_request_end`/`turn_end` records ARE the
//     provider's native request boundaries (not a CrewDispatch invention), so the
//     request's own usage pairs with the interval from its FIRST non-empty
//     delta to that boundary. `thinking_end` is a block boundary only and
//     never shortens the span; a response's completion ends the interval even
//     when the boundary carries no instant (the last streamed delta is the
//     conservative fallback), and output resuming after a COMPLETED interval
//     starts a new epoch so idle/tool time is never decode.
//
// Token counts are never derived from text length, characters, bytes, chunk
// counts, model ids, credits or historical averages, and session wall time is
// never used as decode time.
import type { StreamState, UsageSnapshot } from "../provider";
import { safeApprovalOutcome } from "../../jobs/approval";

export const MALFORMED_LINE_CAP = 50;
export const DIAG_TAIL_CAP = 1000;

/** Product-owned UI text for a metric the CLI did not report (dev: Chinese). */
export const USAGE_UNAVAILABLE_TEXT = "not provided";

/**
 * One IDENTITY-LESS response scope's decode evidence (see the module header).
 *
 * This is Command Code's own native pairing: its records carry no response id,
 * so the implicit request/turn scope delimited by
 * `model_request_start`/`model_request_end`/`turn_end` is the response. A
 * scope counts toward the paired totals ONLY when a completion boundary was
 * observed AND the request/turn's own usage reported output tokens AND a
 * positive interval was measured. Identity-carrying transports (WorkBuddy ACP)
 * never use this shape: their only decode evidence is `response_stats`.
 */
interface DecodeSample {
  /** First output instant of the CURRENT epoch; the interval always starts here. */
  epochFirstMs: number | null;
  /** Last streamed output instant of the current epoch. */
  epochLastMs: number | null;
  /**
   * Credited span of the sample's latest epoch, in ms: the CONTINUOUS interval
   * from that epoch's first output to its completion boundary, internal block
   * gaps included (see `closeDecodeWindow`).
   */
  measuredMs: number;
  /** A completion boundary has been observed for this response. */
  complete: boolean;
  /**
   * The last close was a RESPONSE completion: output resuming for the same
   * identity begins a NEW epoch (idle time between epochs is never decode).
   */
  epochEnded: boolean;
  /** Provider-reported output tokens for this response (reconciled deltas). */
  tokens: number | null;
  /** What this response has already contributed to the paired totals. */
  pairedTokens: number;
  pairedMs: number;
}

export interface CommandCodeStreamState extends StreamState {
  /** Tokens-in exactly as a usage record reported it; null until then. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** INTERNAL accumulator of tool evidence (starts at 0, never shown directly). */
  toolCalls: number;
  /** True once a tool count was reported or at least one tool event was seen. */
  toolCallsObserved: boolean;
  cacheRead: number | null;
  cacheMiss: number | null;
  cacheCreation: number | null;
  credits: number | null;
  totalCostUsd: number | null;
  /**
   * PAIRED decode numerator: output tokens of completed responses that also
   * reported their OWN output-token count (the dsh `decodeTokens` fold). Never
   * the run's total `tokensOut` — a response without decode evidence
   * contributes nothing.
   */
  decodeTokens: number | null;
  /**
   * PAIRED decode denominator: seconds from first meaningful token to the
   * assembled/final response over EXACTLY the responses counted by
   * `decodeTokens` (the dsh `decodeMs` fold). Unpaired timing is measured
   * internally but never exposed.
   */
  decodeSeconds: number | null;
  /** Per-scope decode evidence of IDENTITY-LESS records (see `DecodeSample`). */
  decodeSamples: Map<string, DecodeSample>;
  /**
   * Dsh-exact completed-response samples from explicit `response_stats` events,
   * keyed by response id. The stored sample is the response's AUTHORITATIVE
   * contribution: a repeated or corrected event for the same id moves the
   * totals by the exact change, so nothing is ever counted twice.
   */
  decodeStats: Map<string, { tokens: number; ms: number }>;
  /** The sample that owns the currently open output window. */
  decodeWindowSampleId: string | null;
  /** The implicit request/turn scope sample of an identity-less provider stream. */
  decodeImplicitScopeId: string | null;
  /** Monotonic counter for implicit scope sample ids. */
  decodeScopeSeq: number;
  /** True once a model_request_end boundary was seen in the current turn. */
  decodeModelRequestSeenThisTurn: boolean;
  /** GAUGE: latest provider-reported context occupancy (see the usage event). */
  contextUsed: number | null;
  /** GAUGE: latest provider-reported context window size. */
  contextWindow: number | null;
  /** Prevent double-counting turn_end after model_request_end already supplied usage. */
  requestUsageObservedThisTurn: boolean;
  /** Unique tool ids seen in nested official CLI events. */
  seenToolCallIds: Set<string>;
  numTurns: number;
  errorMessage: string | null;
}

export function createCommandCodeState(): CommandCodeStreamState {
  return {
    step: "spawning",
    currentTool: null,
    finalResult: null,
    lastAssistantText: null,
    terminal: false,
    resultSubtype: null,
    isError: false,
    stopReason: null,
    finishReason: null,
    errorDetail: null,
    approvalOutcome: null,
    tokensIn: null,
    tokensOut: null,
    toolCalls: 0,
    toolCallsObserved: false,
    cacheRead: null,
    cacheMiss: null,
    cacheCreation: null,
    credits: null,
    totalCostUsd: null,
    decodeTokens: null,
    decodeSeconds: null,
    decodeSamples: new Map<string, DecodeSample>(),
    decodeStats: new Map<string, { tokens: number; ms: number }>(),
    decodeWindowSampleId: null,
    decodeImplicitScopeId: null,
    decodeScopeSeq: 0,
    decodeModelRequestSeenThisTurn: false,
    contextUsed: null,
    contextWindow: null,
    requestUsageObservedThisTurn: false,
    seenToolCallIds: new Set<string>(),
    numTurns: 0,
    model: null,
    actualModel: null,
    sessionId: null,
    errorMsg: null,
    errorCode: null,
    errorStatus: null,
    errorMessage: null,
    malformedLines: 0,
    unknownLines: 0,
    diagTail: "",
    approval: null
  };
}

function ccNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
function ccStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function ccTail(tail: string, text: string, cap: number): string {
  const combined = tail ? tail + "\n" + text : text;
  return combined.length <= cap ? combined : combined.slice(combined.length - cap);
}

function sessionIdOf(rec: Record<string, unknown>): string | null {
  const direct =
    ccStr(rec.session_id) ??
    ccStr(rec.sessionId) ??
    ccStr(rec.thread_id) ??
    ccStr(rec.threadId) ??
    null;
  if (direct) return direct;
  const session = rec.session;
  if (session && typeof session === "object" && !Array.isArray(session)) {
    const s = session as Record<string, unknown>;
    return ccStr(s.id) ?? ccStr(s.session_id) ?? null;
  }
  const conversation = rec.conversation;
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    return ccStr((conversation as Record<string, unknown>).id) ?? null;
  }
  return null;
}

function blocksOf(rec: Record<string, unknown>): unknown[] {
  const msg = rec.message && typeof rec.message === "object" && !Array.isArray(rec.message)
    ? (rec.message as Record<string, unknown>)
    : rec;
  if (Array.isArray(msg.content)) return msg.content;
  if (Array.isArray(msg.blocks)) return msg.blocks;
  return [];
}

function textOf(rec: Record<string, unknown>): string | null {
  for (const k of ["finalText", "final_text", "result", "text", "output_text", "content"]) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  const msg = rec.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const m = msg as Record<string, unknown>;
    const texts: string[] = [];
    for (const b of blocksOf(rec)) {
      if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
        const t = (b as Record<string, unknown>).text as string;
        if (t) texts.push(t);
      }
    }
    if (texts.length) return texts.join("\n\n");
    if (typeof m.text === "string" && m.text.trim()) return m.text;
  }
  if (Array.isArray(rec.content)) {
    const texts: string[] = [];
    for (const b of rec.content) {
      if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
        const t = (b as Record<string, unknown>).text as string;
        if (t) texts.push(t);
      }
    }
    if (texts.length) return texts.join("\n\n");
  }
  return null;
}

function toolCountOf(rec: Record<string, unknown>): number | null {
  return (
    ccNum(rec.tool_calls) ??
    ccNum(rec.toolCalls) ??
    ccNum(rec.num_tool_calls) ??
    ccNum(rec.numToolCalls) ??
    ccNum(rec.tool_count) ??
    ccNum(rec.toolCount)
  );
}

function countToolUseBlocks(rec: Record<string, unknown>): number {
  let n = 0;
  for (const b of blocksOf(rec)) {
    if (!b || typeof b !== "object") continue;
    const type = (b as Record<string, unknown>).type;
    if (type === "tool_use" || type === "tool_call" || type === "function_call") n++;
  }
  return n;
}

type ParsedUsage = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheMiss: number | null;
  cacheCreation: number | null;
  credits: number | null;
  totalCostUsd: number | null;
};

function parsedUsage(usage: unknown): ParsedUsage | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const input = ccNum(u.input_tokens) ?? ccNum(u.prompt_tokens) ?? ccNum(u.inputTokens);
  const output = ccNum(u.output_tokens) ?? ccNum(u.completion_tokens) ?? ccNum(u.outputTokens);
  const cacheRead =
    ccNum(u.cache_read_input_tokens) ??
    ccNum(u.cached_tokens) ??
    ccNum(u.cacheReadInputTokens) ??
    ccNum(u.cacheReadTokens);
  const cacheCreation =
    ccNum(u.cache_creation_input_tokens) ??
    ccNum(u.cacheCreationInputTokens) ??
    ccNum(u.cacheWriteTokens);
  const cacheMiss = input != null && cacheRead != null ? Math.max(input - cacheRead, 0) : null;
  return {
    input,
    output,
    cacheRead,
    cacheMiss,
    cacheCreation,
    credits: ccNum(u.credits) ?? ccNum(u.credits_used) ?? ccNum(u.total_credits),
    totalCostUsd: ccNum(u.total_cost_usd)
  };
}

function setOrAdd(current: number | null, value: number | null, accumulate: boolean): number | null {
  if (value == null) return current;
  return accumulate ? (current ?? 0) + value : value;
}

/**
 * Legacy/top-level usage records are cumulative snapshots and replace prior
 * values. Nested model_request_end / turn_end usage in the current CLI is
 * per-request, so those records are accumulated exactly once.
 */
function applyUsage(state: CommandCodeStreamState, usage: unknown, accumulate = false): void {
  const u = parsedUsage(usage);
  if (!u) return;
  state.tokensIn = setOrAdd(state.tokensIn, u.input, accumulate);
  state.tokensOut = setOrAdd(state.tokensOut, u.output, accumulate);
  state.cacheRead = setOrAdd(state.cacheRead, u.cacheRead, accumulate);
  state.cacheMiss = setOrAdd(state.cacheMiss, u.cacheMiss, accumulate);
  state.cacheCreation = setOrAdd(state.cacheCreation, u.cacheCreation, accumulate);
  state.credits = setOrAdd(state.credits, u.credits, accumulate);
  state.totalCostUsd = setOrAdd(state.totalCostUsd, u.totalCostUsd, accumulate);
}

/** A finite reconciliation delta; a provider boundary may report a negative
 *  one when a later snapshot corrected an earlier response observation down. */
function ccDelta(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function addDelta(current: number | null, delta: number | null): number | null {
  return delta == null ? current : (current ?? 0) + delta;
}

/**
 * The additive fields a canonical usage event may carry as deltas. The raw
 * token/cache fields are the reconciled provider deltas; `totalCostUsd` is the
 * same kind of additive USD amount (the Command Code ACP bridge reconciles the
 * session-cumulative `cost.amount` of `usage_update` into deltas before it is
 * published here).
 */
const CANONICAL_DELTA_FIELDS = ["tokensIn", "tokensOut", "cacheRead", "cacheMiss", "cacheCreation", "totalCostUsd"] as const;

/**
 * Fold ONE canonical `usage` event (see the module header) into the state.
 *
 * `contextUsed`/`contextWindow` are GAUGES: the latest reported observation
 * replaces the previous one and a run total never sums them. `credits` and the
 * raw token/cache fields (including provider-proven cacheMiss) are ADDITIVE:
 * each event contributes exactly once, and the raw fields carry
 * already-reconciled deltas (possibly negative — see the
 * module header). An absent field leaves the current value untouched, so a
 * provider that publishes only context never fabricates credits or tokens.
 *
 * A `messageId` on the event is the protocol response identity, but a token
 * delta alone is NEVER decode evidence: the response's assembled/final instant
 * is not something this event carries, and a transport with response ids
 * (WorkBuddy ACP) closes its message blocks at synthesized boundaries. The
 * delta is therefore folded into the run total only; its decode contribution
 * can arrive only through an explicit `response_stats` event carrying the
 * response's own first-token/completion facts.
 */
function applyCanonicalUsage(state: CommandCodeStreamState, event: Record<string, unknown>): void {
  const used = ccNum(event.contextUsed);
  const window = ccNum(event.contextWindow);
  if (used != null) state.contextUsed = used;
  // A 0 window is an "unresolved" sentinel, not a size (see the module header):
  // it is ignored so it can never overwrite a real window.
  if (window != null && window > 0) state.contextWindow = window;
  const credits = ccNum(event.credits);
  if (credits != null) state.credits = (state.credits ?? 0) + credits;
  for (const key of CANONICAL_DELTA_FIELDS) {
    state[key] = addDelta(state[key], ccDelta(event[key]));
  }
}

/**
 * Fold ONE canonical completed-response timing event (`response_stats`) into
 * the paired decode totals — the dsh-exact evidence of the module header.
 *
 * The event states, for ONE completed response, the facts the official
 * sessionStats fold needs:
 *   - `messageId` — the response identity (required; without it nothing can
 *     be paired and the event is ignored);
 *   - `firstTokenAt` + `completedAt` (epoch ms), or `durationMs` + `ttftMs`
 *     (the runtime's generation duration and first-token latency) — the
 *     response's first meaningful non-empty token instant and its
 *     assembled/final assistant-response instant;
 *   - `outputTokens` — the provider-reported output token count of that SAME
 *     response.
 *
 * The response contributes `max(0, completedAt − firstTokenAt)` and its own
 * `outputTokens` (0 included, exactly as dsh's `usageOutputTokens` accepts a
 * reported 0). The sample is stored by response id and moves the totals by the
 * exact change on a repeat or correction, so no event is counted twice. An
 * event missing any fact contributes NEITHER numerator nor denominator — a
 * missing metric is honest, an inferred one is not.
 */
function applyResponseStats(state: CommandCodeStreamState, event: Record<string, unknown>): void {
  const messageId = ccStr(event.messageId) ?? ccStr(event.message_id);
  if (!messageId) return;
  const outputTokens = ccNum(event.outputTokens) ?? ccNum(event.output_tokens);
  if (outputTokens == null) return;
  const firstTokenAt = ccNum(event.firstTokenAt) ?? ccNum(event.first_token_at);
  const completedAt = ccNum(event.completedAt) ?? ccNum(event.completed_at);
  const durationMs = ccNum(event.durationMs) ?? ccNum(event.duration_ms);
  const ttftMs = ccNum(event.ttftMs) ?? ccNum(event.ttft);
  let measuredMs: number | null = null;
  if (firstTokenAt != null && completedAt != null) measuredMs = completedAt - firstTokenAt;
  else if (durationMs != null && ttftMs != null) measuredMs = durationMs - ttftMs;
  if (measuredMs == null) return;
  const next = { tokens: outputTokens, ms: Math.max(0, measuredMs) };
  const previous = state.decodeStats.get(messageId) ?? { tokens: 0, ms: 0 };
  state.decodeTokens = (state.decodeTokens ?? 0) + (next.tokens - previous.tokens);
  state.decodeSeconds = (state.decodeSeconds ?? 0) + (next.ms - previous.ms) / 1000;
  state.decodeStats.set(messageId, next);
}

function observedMs(rec: Record<string, unknown>, fallback?: number): number | null {
  for (const key of ["timestamp", "ts", "created_at", "createdAt", "time"]) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : null;
}

function ensureDecodeSample(state: CommandCodeStreamState, id: string): DecodeSample {
  let sample = state.decodeSamples.get(id);
  if (!sample) {
    sample = {
      epochFirstMs: null,
      epochLastMs: null,
      measuredMs: 0,
      complete: false,
      epochEnded: false,
      tokens: null,
      pairedTokens: 0,
      pairedMs: 0
    };
    state.decodeSamples.set(id, sample);
  }
  return sample;
}

/**
 * The implicit request/turn scope sample id of a provider whose records carry
 * no response identity (Command Code). Created lazily on the first timed delta.
 */
function implicitDecodeScope(state: CommandCodeStreamState): string {
  if (!state.decodeImplicitScopeId) {
    state.decodeScopeSeq += 1;
    state.decodeImplicitScopeId = `@scope:${state.decodeScopeSeq}`;
  }
  return state.decodeImplicitScopeId;
}

/**
 * Recompute one response's contribution to the PAIRED decode totals.
 *
 * A response counts ONLY when its completion boundary was observed, its own
 * provider-reported output token count is known, and a positive interval was
 * measured — otherwise it contributes nothing (missing/ambiguous evidence
 * means Decode is absent, never guessed). A later correction (a grown or
 * corrected-downward output token snapshot, or the response's completion
 * boundary extending its measured interval) moves the totals by the EXACT
 * change, so no snapshot is ever summed twice.
 */
function syncDecodeSample(state: CommandCodeStreamState, sample: DecodeSample): void {
  if (!sample.complete || sample.tokens == null || sample.measuredMs <= 0) return;
  const deltaTokens = sample.tokens - sample.pairedTokens;
  const deltaMs = sample.measuredMs - sample.pairedMs;
  if (deltaTokens === 0 && deltaMs === 0) return;
  state.decodeTokens = (state.decodeTokens ?? 0) + deltaTokens;
  state.decodeSeconds = (state.decodeSeconds ?? 0) + deltaMs / 1000;
  sample.pairedTokens = sample.tokens;
  sample.pairedMs = sample.measuredMs;
}

/** Accumulate provider-reported output tokens for ONE response and re-pair it. */
function addDecodeTokens(state: CommandCodeStreamState, sampleId: string, tokens: number): void {
  const sample = ensureDecodeSample(state, sampleId);
  sample.tokens = (sample.tokens ?? 0) + tokens;
  syncDecodeSample(state, sample);
}

/**
 * Pair the implicit request/turn scope's own output token count with the
 * interval that scope measured (see `closeDecodeWindow`). Used ONLY by the
 * identity-less Command Code records: a model_request_end / turn_end carries
 * the request's or turn's own usage, and the scope's window is the output that
 * request/turn produced. A scope that never streamed output has no sample and
 * pairs nothing — a boundary is never paired with another scope's interval.
 */
function pairImplicitSample(state: CommandCodeStreamState, tokens: number): void {
  const sampleId = state.decodeImplicitScopeId;
  if (sampleId == null) return;
  addDecodeTokens(state, sampleId, tokens);
}

/** The sample id a record's PROVEN response identity maps to, or null. */
function explicitSampleIdOf(record: Record<string, unknown>): string | null {
  const messageId = ccStr(record.messageId) ?? ccStr(record.message_id);
  return messageId ? `message:${messageId}` : null;
}

/**
 * Open (or extend) the timed output window of one sample at `atMs`.
 *
 * Only the identity-less implicit scope reaches this (see the `text_delta`
 * handler): an identity-carrying stream's decode evidence is `response_stats`,
 * never a streamed timing window. The window of ONE response stays open across
 * its internal block boundaries (`thinking_end`, the answer starting): the
 * response measures ONE continuous interval from its FIRST output to its
 * completion boundary, so the gap between a reasoning block and its answer is
 * decode time, never discarded. A window still open when ANOTHER response's
 * output starts is closed at its last streamed delta — its own completion was
 * never observed, and idle time is never attributed to it.
 *
 * Output resuming for a sample whose previous epoch ENDED at a response
 * completion (a request boundary, a tool call) starts a NEW epoch: the gap
 * since that completion — for example the execution of a tool the model
 * called — is never decode time.
 */
function openDecodeWindow(state: CommandCodeStreamState, sampleId: string, atMs: number): void {
  if (state.decodeWindowSampleId != null && state.decodeWindowSampleId !== sampleId) {
    closeDecodeWindow(state, null, true);
  }
  const sample = ensureDecodeSample(state, sampleId);
  if (state.decodeWindowSampleId !== sampleId) {
    if (sample.epochFirstMs == null || sample.epochEnded) {
      sample.epochFirstMs = atMs;
      sample.epochEnded = false;
    }
    state.decodeWindowSampleId = sampleId;
  }
  sample.epochLastMs = atMs;
}

/**
 * Close the open output window into its sample and credit the CONTINUOUS span
 * from that sample's first output to `endMs` — internal block gaps included.
 *
 * `endMs` is the protocol completion instant (a `model_request_end`, a
 * `message_end`, a turn boundary); when absent the window ends at its LAST
 * streamed delta, so a block boundary such as `thinking_end` never counts
 * transport latency as decode. `responseEnded` marks a RESPONSE completion:
 * output resuming for the same identity then starts a new epoch (see
 * `openDecodeWindow`), so a gap that is not decode time can never be counted.
 */
function closeDecodeWindow(state: CommandCodeStreamState, endMs: number | null, responseEnded: boolean): void {
  const sampleId = state.decodeWindowSampleId;
  state.decodeWindowSampleId = null;
  if (sampleId == null) return;
  const sample = ensureDecodeSample(state, sampleId);
  const first = sample.epochFirstMs;
  const last = sample.epochLastMs;
  const end = endMs != null && last != null ? Math.max(endMs, last) : last;
  if (first != null && end != null && end > first) sample.measuredMs = end - first;
  sample.complete = true;
  if (responseEnded) sample.epochEnded = true;
  syncDecodeSample(state, sample);
}

/**
 * Start a fresh implicit scope: the next identity-less delta opens a NEW
 * response epoch. Timing measured by a scope that never completed with its own
 * usage is dropped here — an unpaired interval is omitted, never attributed to
 * the next response.
 */
function resetDecodeScope(state: CommandCodeStreamState): void {
  state.decodeImplicitScopeId = null;
}

const TERMINAL_SUBTYPES = new Set(["success", "error", "max_turns", "max-turns", "maxturns"]);

function normalizeSubtype(v: unknown): string | null {
  const s = ccStr(v);
  if (!s) return null;
  const k = s.toLowerCase().replace(/-/g, "_");
  return TERMINAL_SUBTYPES.has(k) ? k.replace("maxturns", "max_turns") : k;
}

/**
 * Fold ONE complete NDJSON line into the parser state. Pure; never throws.
 * Returns the (mutated) state so callers can chain.
 */
export function parseCommandCodeRecord(line: string, state: CommandCodeStreamState, observedAtMs?: number): CommandCodeStreamState {
  if (!state || typeof state !== "object") return state;
  if (typeof line !== "string") return state;
  const trimmed = line.trim();
  if (!trimmed) return state;

  let rec: unknown;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    if (state.malformedLines < MALFORMED_LINE_CAP) state.malformedLines += 1;
    state.diagTail = ccTail(state.diagTail, trimmed, DIAG_TAIL_CAP);
    return state;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
    if (state.unknownLines < MALFORMED_LINE_CAP) state.unknownLines += 1;
    return state;
  }
  const r = rec as Record<string, unknown>;

  // The installed CLI (v1.65.0, verified in a real run) also nests its payload
  // under `event`: {"type":"event","event":{"type":"run_start","sessionId":"..."}}
  // and {"type":"event","event":{"type":"model_request_start","model":"..."}}.
  // Those are read too, so a value the CLI really published is never reported as
  // unavailable.
  const nested =
    r.event && typeof r.event === "object" && !Array.isArray(r.event) ? (r.event as Record<string, unknown>) : null;

  const sid = sessionIdOf(r) ?? (nested ? sessionIdOf(nested) : null);
  if (sid) state.sessionId = sid;

  const model =
    ccStr(r.model) ??
    (r.message && typeof r.message === "object" && !Array.isArray(r.message)
      ? ccStr((r.message as Record<string, unknown>).model)
      : null) ??
    (nested ? ccStr(nested.model) : null);
  if (model) {
    // The id echoed for the argv id is the INIT model; a later record's model is
    // the ACTUAL one.
    const type = ccStr(r.type);
    if (type === "result" || type === "init" || type === "system") state.model = model;
    else state.actualModel = model;
  }

  if (r.usage) applyUsage(state, r.usage);
  const toolCount = toolCountOf(r);
  if (toolCount != null) {
    state.toolCalls = toolCount;
    state.toolCallsObserved = true;
  }

  const type = ccStr(r.type) ?? (ccStr(r.event) ? "event" : null);

  // Current Command Code / WorkBuddy AI builds wrap lifecycle records under
  // {type:"event", event:{...}}. Handle the published nested events directly:
  // usage is per model request, tool_queued is one logical tool call, and the
  // dsh-exact decode evidence is the explicit `response_stats` event (see the
  // paired-decode note above). Command Code's own request/turn boundaries also
  // pair their native request scope below.
  if (type === "event" && nested) {
    const eventType = ccStr(nested.type);
    const at = observedMs(nested, observedMs(r, observedAtMs) ?? undefined);
    const nestedModel = ccStr(nested.model);
    if (nestedModel) state.actualModel = nestedModel;

    if (eventType === "turn_start") {
      state.requestUsageObservedThisTurn = false;
      state.decodeModelRequestSeenThisTurn = false;
      // A new turn is a new output epoch: any timing the previous epoch left
      // unpaired is dropped rather than attributed to this turn.
      closeDecodeWindow(state, null, true);
      resetDecodeScope(state);
      state.step = "turn_start";
      return state;
    }
    if (eventType === "model_request_start") {
      // The smallest response boundary the stream proves: a new model request
      // begins. Its output deltas open a fresh scope.
      closeDecodeWindow(state, null, true);
      resetDecodeScope(state);
      state.step = "model_request_start";
      return state;
    }
    if (eventType === "message_start") {
      // A message boundary is NOT by itself a response completion: one
      // WorkBuddy response streams reasoning and then its answer under ONE
      // identity, and that thinking -> answer gap is decode time. An
      // identity-carrying message never owns a streamed decode window at all
      // (its only evidence is `response_stats`); this closes only a still-open
      // identity-LESS Command Code scope.
      const startId = explicitSampleIdOf(nested);
      if (state.decodeWindowSampleId != null && (startId == null || state.decodeWindowSampleId !== startId)) {
        closeDecodeWindow(state, null, true);
      }
      state.step = "message_start";
      return state;
    }
    if (eventType === "text_delta" || eventType === "thinking_delta") {
      const delta = nested.delta;
      // Only an identity-LESS stream measures decode timing here: Command Code's
      // request boundary is the provider's own record. An identity-carrying
      // stream's message/thinking boundaries are CrewDispatch-synthesized closures,
      // which may drive activity rendering but must never authorize Decode —
      // its contribution can only come from an explicit `response_stats` event.
      if (typeof delta === "string" && delta.length > 0 && at != null && explicitSampleIdOf(nested) == null) {
        openDecodeWindow(state, implicitDecodeScope(state), at);
      }
      state.step = eventType;
      return state;
    }
    if (eventType === "message_end") {
      // The message lifecycle's completion boundary: close at the boundary
      // instant when it carries one, else at the last streamed delta. Only an
      // identity-LESS Command Code scope owns a window here; an id-carrying
      // ACP record closes no window (it never opened one) and never pairs.
      const endId = explicitSampleIdOf(nested);
      if (state.decodeWindowSampleId != null && (endId == null || state.decodeWindowSampleId === endId)) {
        closeDecodeWindow(state, at, true);
      }
      state.step = "message_end";
      return state;
    }
    if (eventType === "thinking_end") {
      // A reasoning block closed by its OWN protocol boundary (a real
      // WorkBuddy turn can be reasoning-only and never open an assistant
      // message). It is a BLOCK boundary, not necessarily a response
      // completion: the SAME response's answer may follow, and that gap is
      // decode time. The window is closed provisionally at its last streamed
      // delta — the very instant a following `message_start` would have used —
      // so a reasoning-only Command Code scope still pairs, while a later delta
      // of the same scope continues the same epoch. An identity-carrying ACP
      // block boundary never authorizes Decode (see the `text_delta` handler).
      const endId = explicitSampleIdOf(nested);
      if (state.decodeWindowSampleId != null && (endId == null || state.decodeWindowSampleId === endId)) {
        closeDecodeWindow(state, null, false);
      }
      state.step = "thinking_end";
      return state;
    }
    if (eventType === "model_request_end") {
      const requestUsage = parsedUsage(nested.usage);
      applyUsage(state, nested.usage, true);
      state.requestUsageObservedThisTurn = !!requestUsage;
      state.decodeModelRequestSeenThisTurn = true;
      // The request boundary is this response's completion evidence: close its
      // output window at the boundary instant (falling back to the last
      // streamed delta when the boundary carries no instant), then pair the
      // request's OWN output token count with exactly that interval. A request
      // that reported no output tokens, or whose output was never timed,
      // contributes nothing.
      closeDecodeWindow(state, at, true);
      if (requestUsage && requestUsage.output != null) pairImplicitSample(state, requestUsage.output);
      resetDecodeScope(state);
      const stop = ccStr(nested.stopReason) ?? ccStr(nested.stop_reason);
      if (stop) state.stopReason = stop;
      state.step = "model_request_end";
      return state;
    }
    if (eventType === "usage") {
      // The canonical provider-neutral usage event (see the module header).
      applyCanonicalUsage(state, nested);
      state.step = "usage";
      return state;
    }
    if (eventType === "response_stats") {
      // The canonical completed-response timing event: the ONLY decode evidence
      // of an identity-carrying transport. It carries the response's own
      // first-token and assembled/final instants plus its own provider-reported
      // output tokens (see `applyResponseStats`).
      applyResponseStats(state, nested);
      state.step = "response_stats";
      return state;
    }
    if (eventType === "turn_end") {
      // Some CLI versions only attach usage at turn_end. Current builds also
      // emit the same request usage at model_request_end; never count both.
      closeDecodeWindow(state, at, true);
      if (!state.requestUsageObservedThisTurn) {
        const turnUsage = parsedUsage(nested.usage);
        applyUsage(state, nested.usage, true);
        // Only a turn whose records proved NO request boundary may pair its
        // usage: with a model_request_end present, the turn's usage describes
        // the whole turn while the last scope's timing covers only the final
        // request — pairing them would fabricate a rate.
        if (!state.decodeModelRequestSeenThisTurn && turnUsage && turnUsage.output != null) {
          pairImplicitSample(state, turnUsage.output);
        }
      }
      resetDecodeScope(state);
      const turn = ccNum(nested.turnNumber) ?? ccNum(nested.turn_number);
      if (turn != null) state.numTurns = Math.max(state.numTurns, turn);
      state.step = "turn_end";
      return state;
    }
    if (eventType === "tool_queued") {
      // A tool call ends the model's current output epoch: the response
      // completed before the tool ran. Close any still-open window at its last
      // streamed delta — tool execution time is never decode time.
      closeDecodeWindow(state, null, true);
      const id = ccStr(nested.toolCallId) ?? ccStr(nested.tool_call_id);
      if (!id || !state.seenToolCallIds.has(id)) {
        if (id) state.seenToolCallIds.add(id);
        state.toolCalls += 1;
        state.toolCallsObserved = true;
      }
      state.currentTool = ccStr(nested.toolName) ?? ccStr(nested.tool_name) ?? "tool";
      state.step = "tool_use";
      return state;
    }
    if (eventType) state.step = eventType;
    return state;
  }

  // ---- terminal result record ----
  if (type === "result" || type === "final" || type === "terminal" || r.terminal === true) {
    state.terminal = true;
    state.step = "result";
    const subtype =
      normalizeSubtype(r.subtype) ??
      normalizeSubtype(r.status) ??
      normalizeSubtype(r.stop_reason) ??
      normalizeSubtype(r.outcome);
    if (subtype) state.resultSubtype = subtype;
    const text = textOf(r);
    if (text) state.finalResult = text;
    const turns = ccNum(r.num_turns) ?? ccNum(r.numTurns) ?? ccNum(r.turns);
    if (turns != null) state.numTurns = turns;
    if (typeof r.is_error === "boolean") state.isError = r.is_error;
    if (state.resultSubtype === "error" || state.resultSubtype === "max_turns") state.isError = true;
    const stop = ccStr(r.stop_reason) ?? ccStr(r.stopReason);
    if (stop) state.stopReason = stop;
    // The provider's more specific terminal cause (JQ-20261001-23), carried
    // under the canonical `finish_reason` key. Bounded: an over-long value is
    // omitted rather than sliced into a fabricated one.
    const finish = ccStr(r.finish_reason) ?? ccStr(r.finishReason);
    if (finish && finish.length <= 200) state.finishReason = finish;
    // The provider's bounded terminal error detail (JQ-20261001-24), carried
    // under the canonical `error_detail` key. The provider boundary sanitizes
    // it; this is a DEFENSIVE bound only — an over-long value is omitted, never
    // sliced.
    const detail = ccStr(r.error_detail) ?? ccStr(r.errorDetail);
    if (detail && detail.length <= 400) state.errorDetail = detail;
    // The bounded approval outcome token, carried under the canonical
    // `approval_outcome` key (see jobs/approval.ts). Only the exact canonical
    // tokens are accepted: an unknown value is dropped, never displayed as a
    // fabricated cause, and a record without the key leaves the state untouched.
    const approvalOutcome = safeApprovalOutcome(r.approval_outcome) ?? safeApprovalOutcome(r.approvalOutcome);
    if (approvalOutcome) state.approvalOutcome = approvalOutcome;
    if (r.error) {
      const nested = typeof r.error === "object" && !Array.isArray(r.error) ? (r.error as Record<string, unknown>) : null;
      state.errorMsg = nested
        ? ccStr(nested.message) ?? ccStr(nested.code) ?? "error"
        : String(r.error).slice(0, 200);
      state.errorCode = (nested ? ccStr(nested.code) : null) ?? state.errorCode;
      state.errorStatus = (nested ? ccNum(nested.status) : null) ?? state.errorStatus;
    }
    if (r.credits != null) {
      const c = ccNum(r.credits) ?? ccNum(r.credits_used) ?? ccNum(r.total_credits);
      if (c != null) state.credits = c;
    }
    return state;
  }

  // ---- assistant / message text ----
  if (
    type === "assistant" ||
    type === "message" ||
    type === "text" ||
    type === "assistant_message" ||
    type === "agent_message" ||
    type === "output"
  ) {
    const text = textOf(r);
    if (text) {
      state.lastAssistantText = text;
      state.step = "assistant_text";
    }
    const blocks = countToolUseBlocks(r);
    if (blocks) {
      state.toolCalls += blocks;
      state.toolCallsObserved = true;
      state.step = "tool_use";
    }
    return state;
  }

  // ---- tool records ----
  if (type === "tool_use" || type === "tool_call" || type === "function_call") {
    state.toolCalls += 1;
    state.toolCallsObserved = true;
    state.currentTool = ccStr(r.name) ?? ccStr(r.tool) ?? "tool";
    state.step = "tool_use";
    return state;
  }

  // ---- progress / status / init / unknown events ----
  if (type === "init" || type === "system" || type === "session" || type === "start") {
    state.step = "init";
    return state;
  }
  if (type === "progress" || type === "status" || type === "step" || type === "event") {
    const label = ccStr(r.step) ?? ccStr(r.status) ?? ccStr(r.name);
    if (label) state.step = label;
    return state;
  }
  if (type === "error") {
    state.step = "error";
    state.errorMsg = ccStr(r.error) ?? ccStr(r.message) ?? ccStr(r.code) ?? "unknown error";
    state.errorCode = ccStr(r.code) ?? ccStr(r.error_code);
    state.errorStatus = ccNum(r.status) ?? ccNum(r.status_code);
    state.diagTail = ccTail(state.diagTail, trimmed, DIAG_TAIL_CAP);
    return state;
  }

  if (state.unknownLines < MALFORMED_LINE_CAP) state.unknownLines += 1;
  return state;
}

/** The usage of one run. Unreported metrics stay null (UI: "not provided" / unavailable). */
export function normalizeUsage(state: CommandCodeStreamState): UsageSnapshot {
  return {
    tokensIn: state.tokensIn ?? null,
    tokensOut: state.tokensOut ?? null,
    toolCalls: state.toolCallsObserved ? state.toolCalls : null,
    cacheRead: state.cacheRead ?? null,
    cacheMiss: state.cacheMiss ?? null,
    cacheCreation: state.cacheCreation ?? null,
    credits: state.credits ?? null,
    totalCostUsd: state.totalCostUsd ?? null,
    decodeTokens: state.decodeTokens ?? null,
    decodeSeconds: state.decodeSeconds ?? null,
    contextUsed: state.contextUsed ?? null,
    contextWindow: state.contextWindow ?? null
  };
}

/** Display text for one usage metric; unavailable when the CLI did not report it. */
export function usageText(value: number | null): string {
  return value == null ? USAGE_UNAVAILABLE_TEXT : String(value);
}
