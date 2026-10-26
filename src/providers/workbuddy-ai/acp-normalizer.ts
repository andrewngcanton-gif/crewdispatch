// acp-normalizer.ts — the ONE ACP -> CrewDispatch canonical event normalizer.
//
// WorkBuddy AI reaches CrewDispatch over the Agent Client Protocol (ACP): the
// Desktop-authenticated runtime reports progress as `session/update`
// notifications. CrewDispatch's job service, stream parser and Hub all read ONE
// shared event vocabulary — the records a Command Code run publishes
// (`{"type":"event","event":{...}}` lifecycle records plus the terminal
// `{"type":"result"}` record). This module is the ONLY place where an ACP
// update becomes that shared vocabulary, so:
//   - the Hub never grows a second, WorkBuddy-specific event language;
//   - the mapping reads PROTOCOL fields only (kind/title/status/content), so
//     every WorkBuddy model on the ACP transport is normalized identically —
//     there is deliberately no per-model or per-family branch;
//   - a streamed answer is a MESSAGE LIFECYCLE (message_start -> text_delta* ->
//     message_end), so the compact Hub activity view shows one readable
//     assistant message instead of one row per streamed chunk.
//
// HANDLED ACP SESSION-UPDATE KINDS (the installed WorkBuddy client's own
// vocabulary, read locally from its ACP schema): agent_message_chunk,
// agent_thought_chunk, tool_call, tool_call_update, usage_update — plus the
// runtime's `end_turn` boundary frame when it publishes one. Chunks carry
// `content` (a content block) and an optional `messageId`; a tool call carries
// `toolCallId`, `title`, `kind`, `status` (pending | in_progress | completed |
// failed), `content`, `locations`, `rawInput`, `rawOutput`. Every other kind
// (plan, available_commands_update, current_mode_update, session_info_update,
// ...) is ignored generically.
//
// USAGE EVIDENCE (read locally from the installed Desktop runtime's
// AcpUsagePublisher / UsageUpdateBuilder, NOT guessed from field names):
//   - `used` is the LATEST model request's input tokens — the tokens currently
//     occupying the context window — and `size` is that model's context window
//     in tokens (`model.maxInputTokens` / `contextWindow`). They are GAUGES, not
//     run totals.
//   - The runtime FORCES `used = 0` and `size = 0` when it cannot resolve the
//     model's context size, and its credit-only notifications (generation-tool
//     and team-member credits) are sent as `{used: 0, size: 0, cost: {...}}`.
//     A `size === 0` frame therefore carries NO context evidence: reading it as
//     "context used 0" would fabricate a measurement, so this normalizer emits
//     context metrics ONLY when `size > 0`.
//   - `cost.amount` is a credit amount the runtime logs as "credit consumed":
//     it is the raw usage record's `credit` for ONE model response (plus
//     per-stage generation-tool / team-member consumptions). It is an ADDITIVE
//     per-response amount, published once per (amount, messageId) or per stage.
//     The publisher attaches `cost` ONLY for a genuinely positive consumption
//     (`amount > 0 ? {amount, currency: ""} : undefined`, serialized only when
//     truthy; the credit-only helpers return early for a non-positive credit),
//     so zero consumption reaches the wire as the ABSENCE of `cost` and maps to
//     `credits: null` — a `cost.amount: 0` frame is a placeholder this publisher
//     cannot produce, never a genuine "0 credits consumed" measurement.
//   - The runtime also attaches `_meta.usage` (the LATEST event's raw usage
//     snapshot) and the identity of the response that event belongs to
//     (`codebuddy.ai/messageId` / `codebuddy.ai/requestId`) to a usage_update.
//     The snapshot is republished on every throttled stream publish and carries
//     no "final" marker, so it is never SUMMED blindly: the normalizer keeps the
//     latest snapshot PER RESPONSE IDENTITY and emits the additive DELTA since
//     that response's previous snapshot. A republication of the same snapshot
//     therefore adds nothing, and a later snapshot for the same response
//     replaces the earlier observation (a correction downward emits a negative
//     delta). Distinct responses each contribute their final snapshot exactly
//     once. A snapshot whose response identity cannot be proven is never summed
//     — a duplicate would double count and there is no way to tell.
//   - The raw snapshot is read in the shared raw-usage vocabulary this
//     repository already uses for one model response (`inputTokens` /
//     `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`, plus the
//     snake_case aliases the shared parser accepts), AND in the real
//     WorkBuddy/OpenAI-compatible prompt-cache vocabulary its provider
//     responses actually carry. Cache-read evidence follows an EXPLICIT
//     precedence (strongest first — see rawCacheReadOf):
//       1. `prompt_cache_hit_tokens` (the provider's direct prompt-cache hit
//          counter);
//       2. `prompt_tokens_details.cached_tokens` (nested prompt-token detail);
//       3. `inputTokensDetails[0].cached_tokens` (nested input-token detail,
//          flattened exactly like the installed runtime flattens it);
//       4. the shared named aliases `cacheReadTokens` /
//          `cache_read_input_tokens` / `cacheReadInputTokens`;
//       5. the generic top-level `cached_tokens`.
//     A real response carries a non-zero prompt-cache hit counter TOGETHER
//     WITH `cache_read_input_tokens: 0` and top-level `cached_tokens: 0`
//     placeholders in the same object; the precedence guarantees a
//     placeholder zero can never override the stronger non-zero evidence.
//     A `cached_tokens` nested inside completion/output details is NOT
//     prompt-cache evidence and is never read.
//   - `cacheMiss` prefers the provider's own exact miss evidence: when
//     `prompt_cache_miss_tokens` is reported and the direct hit/miss pair is
//     semantically consistent with the inclusive input total (real responses
//     partition it exactly — `inputTokens = hit + miss` on every observed
//     response), it maps directly to canonical `cacheMiss`. Otherwise the
//     canonical derivation still applies — the installed WorkBuddy runtime
//     computes net input from `inputTokens - cacheRead - cacheCreation`,
//     proving cache-read is a subset of input — but ONLY when the inclusive
//     relation is proven and sane (`cacheRead <= inputTokens`); contradictory
//     or impossible evidence omits the metric instead of clamping it to a
//     fabricated 0. (Cache creation remains a separately reported metric.)
//   - `cost.currency` is always "" and the amount is a credit, not USD, so
//     `totalCostUsd` is never derived from it. Credits are read ONLY from
//     `cost.amount` (the publisher's own deduped per-response consumption),
//     never re-read from the raw snapshot's own `credit` field, so no frame can
//     contribute the same consumption twice.
//
// TOOL ACTIVITY: `tool_call` creates the tool (its protocol `title` names it,
// falling back to `kind` and then to a generic "tool" for an unknown tool),
// `tool_call_update` reports its status (pending | in_progress | completed |
// failed) and its streamed content. Status transitions become the shared
// tool_queued / tool_running / tool_completed rows; a `failed` status stays
// visible as such. Streamed content is AGGREGATED rather than one row per
// frame: a real WorkBuddy run streamed the forming input/output of ONE Read as
// 36 separate content updates, so a row per update would recreate exactly the
// per-token noise this module exists to remove. The aggregate is reported once
// (a tool_update row when a tool never finished, otherwise inside its
// completion, which also falls back to it when the completion carries no
// content of its own). An update whose tool_call frame was never seen is still
// rendered generically BY NAME.
//
// WHAT THE PROTOCOL DOES NOT PUBLISH: ACP's base session-update union has no
// explicit "assistant message ended" update (a runtime MAY send an `end_turn`
// extension frame, which is honoured) and no "thinking ended" update. A message
// is therefore CLOSED at the boundaries that ARE observable — an `end_turn`
// frame, a changed message id, a tool call, and the end of the prompt turn —
// and a reasoning block is closed by the answer starting, a tool call, an
// `end_turn` frame or the end of the prompt turn. That is never a guess about
// model behaviour: each boundary is a protocol field or frame.
//
// RESPONSE IDENTITY: every chunk frame carries the response's `messageId`, so
// the canonical message_start / text_delta / message_end and thinking_start /
// thinking_delta / thinking_end records keep it, and a `usage_update` whose raw
// snapshot carries a token/cache delta carries the `messageId` the publisher
// attached to that same snapshot (`codebuddy.ai/messageId`). The identity lets
// the run totals reconcile per response (`rawUsageByResponse`).
//
// DECODE EVIDENCE (the official deepseek-harness `sessionStats` contract): a
// response contributes decode throughput ONLY when its first meaningful
// non-empty output instant, its assembled/final assistant-response instant,
// and its OWN provider-reported output token count are ALL provable:
// firstTokenAt -> assembled message is the decode span, the message's output
// tokens are the numerator, and the session rate is the ratio of the sums.
// This transport cannot prove the assembled/final instant: ACP has no
// "assistant message assembled" frame, and this bridge's message_end /
// thinking_end closures are CrewDispatch-SYNTHESIZED boundaries (a tool frame, a
// changed identity, the end of the prompt turn, a flush) — exactly what must
// never be converted into a rate. The runtime's `usage_update` for the
// completed response (derived from its own response_done event) carries the
// token count and the identity but no completion instant, and its arrival here
// is debounced transport time, not the provider's instant. This normalizer
// therefore emits NO completed-response timing event (`response_stats`): the
// shared parser's decode totals stay null for this transport instead of
// fabricating a throughput number. Facts that ARE provable stay exact: each
// forwarded update's runtime `_meta.timestamp` is carried on the canonical
// records as `timestamp` (never local read time), so the first-token boundary
// is exact and diagnostic views can tell provider time from transport time.
// Real WorkBuddy Desktop 5.6.2 exposes TWO different ids on streamed chunks:
// the top-level `messageId` is the ACP message/item id, while
// `_meta["codebuddy.ai/modelRequestId"]` / `llmMessageId` is the model-response
// id. The later usage_update publishes that model-response id as
// `_meta["codebuddy.ai/messageId"]`. Canonical lifecycle records therefore use
// the model-response id when it is present (falling back to the top-level
// message id for older/simple ACP shapes), so usage and lifecycle describe the
// SAME response. UUID-shaped ids are normalized only for textual formatting.
// A frame that proves only `codebuddy.ai/requestId` never carries a messageId:
// no message lifecycle could be linked, so its delta never claims a response
// identity (the run totals still receive the reconciled delta).
//
// REASONING PRIVACY: thought chunks become the SHARED thinking_start /
// thinking_delta / thinking_end records whose private text lives under the
// generic `delta`/`text` keys. Nothing is synthesized, and the Hub's existing
// privacy policy decides visibility: hidden by default (deep-stripped at any
// depth) and surfaced only for an explicit reasoning opt-in.
import type { ApprovalOutcome } from "../../jobs/approval";

type Json = Record<string, unknown>;

/** ACP kinds that stream the agent's answer text. */
const MESSAGE_CHUNK_KINDS: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "assistant_message_chunk",
  "agent_message",
  "message_chunk"
]);

/** ACP kinds that stream the agent's reasoning text. */
const THOUGHT_CHUNK_KINDS: ReadonlySet<string> = new Set(["agent_thought_chunk", "agent_thought"]);

/** Statuses a tool call/update may report (the protocol's own enumeration). */
const TOOL_STATUS_RUNNING = new Set(["in_progress", "running"]);
const TOOL_STATUS_COMPLETED = new Set(["completed", "success", "succeeded"]);
const TOOL_STATUS_FAILED = new Set(["failed", "error", "errored"]);

/** Cap on ONE canonical tool text block; keeps a record inside the Hub's line bound. */
export const ACP_TOOL_TEXT_CAP = 8000;

export interface AcpNormalizerOptions {
  /** Cap on ONE tool result/partial text block. */
  toolTextCap?: number;
}

/**
 * One ACP conversation's normalizer. It is intentionally STATELESS about the
 * model: the same updates always produce the same canonical records.
 */
export interface AcpNormalizer {
  /** Map one ACP `session/update` payload (params.update) to canonical records. */
  handleUpdate(update: unknown): Json[];
  /** Close any open message/thinking block (prompt end, transport teardown). */
  flush(): Json[];
  /** The assistant text the ACP stream actually delivered, in order. */
  assistantText(): string;
}

interface ToolState {
  name: string | null;
  queued: boolean;
  running: boolean;
  terminal: boolean;
  /** The tool's latest protocol-reported output text (snapshot semantics). */
  progress: string;
  /** True once this tool's progress was reported in a canonical row. */
  progressReported: boolean;
}

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalize only UUID textual formatting; preserve opaque ids verbatim. */
function responseMessageIdOf(value: unknown): string | null {
  const raw = stringOf(value);
  if (!raw) return null;
  const compact = raw.replace(/-/g, "");
  return /^[0-9a-fA-F]{32}$/.test(compact) ? compact.toLowerCase() : raw;
}

/**
 * Model-response identity carried on a streamed message/thought chunk.
 *
 * WorkBuddy Desktop 5.6.2 injects modelRequestId/llmMessageId into chunk
 * metadata; usage_update later republishes that same id under
 * codebuddy.ai/messageId. Prefer it for the canonical lifecycle identity, while
 * the top-level ACP messageId still controls message-lifecycle boundaries
 * internally. (It is NOT decode evidence: see the header's decode note.)
 */
function streamPairMessageIdOf(update: Json): string | null {
  const meta = asObject(update._meta);
  return (
    responseMessageIdOf(meta?.["codebuddy.ai/modelRequestId"]) ??
    responseMessageIdOf(meta?.["codebuddy.ai/llmMessageId"]) ??
    responseMessageIdOf(update.messageId) ??
    responseMessageIdOf(update.message_id)
  );
}

/** The kind of an ACP session update (the runtime has used all three spellings). */
function updateKind(update: Json): string {
  for (const key of ["sessionUpdate", "type", "kind"]) {
    const value = update[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The text of a content block / nested content value. Only text the stream
 * actually carried is returned; nothing is invented for non-text blocks.
 */
function textOfBlock(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textOfBlock(item))
      .filter(Boolean)
      .join("\n");
  }
  const obj = asObject(value);
  if (!obj) return "";
  if (typeof obj.text === "string") return obj.text;
  if (obj.content !== undefined) return textOfBlock(obj.content);
  if (obj.delta !== undefined) return textOfBlock(obj.delta);
  return "";
}

/** The text of ONE ACP tool-call content entry (`content` | `diff` | `terminal`). */
function toolContentText(entry: unknown): string {
  const obj = asObject(entry);
  if (!obj) return textOfBlock(entry);
  const type = typeof obj.type === "string" ? obj.type : "";
  if (type === "diff") {
    const file = typeof obj.path === "string" ? obj.path.trim() : "";
    return file ? `diff ${file}` : "diff";
  }
  if (type === "terminal") {
    const terminal = typeof obj.terminalId === "string" ? obj.terminalId.trim() : "";
    return terminal ? `terminal ${terminal}` : "terminal";
  }
  // `{type:"content", content:<block>}` and a bare content block both reduce to
  // their own text; a non-text block contributes nothing.
  return textOfBlock(obj.content ?? obj);
}

/** The text of an ACP `rawOutput` value (string, structured result, or blocks). */
function rawOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asObject(value);
  if (!obj) return Array.isArray(value) ? textOfBlock(value) : "";
  for (const key of ["result", "output", "message", "stdout", "stderr"]) {
    const nested = obj[key];
    if (typeof nested === "string" && nested) return nested;
  }
  return textOfBlock(obj);
}

/** The tool input a frame actually carries; an empty/partial value is not reported. */
function inputOf(update: Json): unknown {
  const value = update.rawInput !== undefined ? update.rawInput : update.input;
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) return value.length ? value : undefined;
  const obj = asObject(value);
  if (obj) return Object.keys(obj).length ? obj : undefined;
  return value;
}

/** A finite, non-negative protocol number; anything else is not a measurement. */
function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** An epoch-ms number or ISO string the runtime itself published for a frame. */
type FrameTime = number | string;

/**
 * The runtime's OWN instant for a forwarded update, when it published one.
 *
 * The ACP agent injects `_meta.timestamp` (ISO, via `withAcpTimestampMeta`) on
 * every forwarded prompt update, resolved from the source event's own
 * timestamp. It is read verbatim and carried on the canonical record so the
 * shared parser's observed time IS provider time; never substitute the local
 * read time here, and never invent an instant a frame did not carry.
 */
function frameTimestampOf(update: Json): FrameTime | null {
  const meta = asObject(update._meta);
  for (const candidate of [meta?.timestamp, update.timestamp, update.ts]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    const text = stringOf(candidate);
    if (text) return text;
  }
  return null;
}

/** Attach the runtime's frame instant when one exists; never a fabricated time. */
function withFrameTime(payload: Json, at: FrameTime | null): Json {
  return at == null ? payload : { ...payload, timestamp: at };
}

/**
 * The ADDITIVE raw token/cache fields of ONE model response's usage snapshot,
 * named exactly like the canonical JobUsage fields they become.
 */
const RAW_USAGE_FIELDS = ["tokensIn", "tokensOut", "cacheRead", "cacheMiss", "cacheCreation"] as const;
type RawUsageField = (typeof RAW_USAGE_FIELDS)[number];

/** One raw usage snapshot: only the fields the frame actually carried. */
type RawUsageSnapshot = Partial<Record<RawUsageField, number>>;

/**
 * The stable identity of the model response a `usage_update`'s raw snapshot
 * belongs to.
 *
 * `codebuddy.ai/messageId` is preferred because it is the response identity the
 * publisher itself dedupes credit consumption by ("an unchanged (amount,
 * messageId) pair is suppressed"); a frame that proves only
 * `codebuddy.ai/requestId` is keyed by the request id. The two namespaces are
 * prefixed so they can never collide, and the ACP update's own `messageId` /
 * `requestId` fields are accepted as the same vocabulary. Null when the frame
 * proves no identity at all — such a snapshot is NOT summed (see the header).
 */
function usageResponseId(update: Json, meta: Json | null): string | null {
  const messageId = responseMessageIdOf(meta?.["codebuddy.ai/messageId"]) ?? responseMessageIdOf(update.messageId);
  if (messageId) return `message:${messageId}`;
  const requestId = stringOf(meta?.["codebuddy.ai/requestId"]) ?? stringOf(update.requestId);
  if (requestId) return `request:${requestId}`;
  return null;
}

/**
 * The raw MESSAGE identity a `usage_update` frame proves, or null.
 *
 * Only a real message id may be used: the canonical `messageId` is the SAME
 * field the assistant/thought chunk lifecycle carries, so it can link a
 * response's usage to the output interval that response streamed. A frame that
 * proves only a request id has no message lifecycle to link to and therefore
 * never manufactures that link.
 */
function usageMessageId(update: Json, meta: Json | null): string | null {
  return responseMessageIdOf(meta?.["codebuddy.ai/messageId"]) ?? responseMessageIdOf(update.messageId);
}

/**
 * The cache-read (prompt-cache hit) tokens of ONE raw usage snapshot, read
 * with an EXPLICIT evidence precedence — strongest first:
 *
 *   1. `prompt_cache_hit_tokens` — the provider's own prompt-cache hit counter
 *      (present on the real WorkBuddy/OpenAI-compatible raw usage record);
 *   2. `prompt_tokens_details.cached_tokens` — the response's nested
 *      prompt-token detail (real raw usage carries it next to the hit
 *      counter, with the same value);
 *   3. `inputTokensDetails[0].cached_tokens` — the nested input-token detail;
 *      the installed runtime itself flattens this array by taking its first
 *      element, and real responses carry exactly one entry;
 *   4. the shared named aliases `cacheReadTokens` / `cache_read_input_tokens`
 *      / `cacheReadInputTokens`;
 *   5. the generic top-level `cached_tokens` — weakest.
 *
 * A real response carries a non-zero prompt-cache hit counter TOGETHER WITH
 * `cache_read_input_tokens: 0` and top-level `cached_tokens: 0` placeholders
 * in the same object; consulting the stronger evidence first means a
 * placeholder zero can never override it. A `cached_tokens` nested inside
 * completion/output details describes OUTPUT tokens, is not prompt-cache
 * evidence, and is never read here.
 */
function rawCacheReadOf(usage: Json): number | null {
  const directHit = numberOf(usage.prompt_cache_hit_tokens);
  if (directHit != null) return directHit;
  const promptDetails = asObject(usage.prompt_tokens_details);
  const promptDetailCached = promptDetails ? numberOf(promptDetails.cached_tokens) : null;
  if (promptDetailCached != null) return promptDetailCached;
  const inputDetails = Array.isArray(usage.inputTokensDetails) ? asObject(usage.inputTokensDetails[0]) : null;
  const inputDetailCached = inputDetails ? numberOf(inputDetails.cached_tokens) : null;
  if (inputDetailCached != null) return inputDetailCached;
  return (
    numberOf(usage.cacheReadTokens) ??
    numberOf(usage.cache_read_input_tokens) ??
    numberOf(usage.cacheReadInputTokens) ??
    numberOf(usage.cached_tokens)
  );
}

/**
 * The cache-miss (non-hit input) tokens of ONE raw usage snapshot.
 *
 * The provider's own miss evidence wins: when `prompt_cache_miss_tokens` is
 * reported and the direct hit/miss pair is semantically consistent with the
 * inclusive input total (real WorkBuddy responses partition it exactly —
 * `inputTokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens` on every
 * observed response), it maps directly to canonical `cacheMiss`: an exact
 * provider-reported counter is preferred over any derivation.
 *
 * Otherwise the shared canonical derivation `inputTokens - cacheRead` applies,
 * but ONLY when both are present and cache-read is a sane subset of input
 * (`cacheRead <= inputTokens`). A pair that does not partition its own input
 * is never copied — the trustworthy counters (input, cache-read) still follow
 * the canonical inclusive derivation. A cache-read larger than its own input
 * proves no inclusive relation at all, so the metric is omitted rather than
 * clamped to a fabricated 0.
 */
function rawCacheMissOf(usage: Json, inputTokens: number | undefined, cacheRead: number | null): number | null {
  const directMiss = numberOf(usage.prompt_cache_miss_tokens);
  if (directMiss != null) {
    const directHit = numberOf(usage.prompt_cache_hit_tokens);
    const consistent = inputTokens === undefined
      ? true
      : directHit != null
        ? directHit + directMiss === inputTokens
        : directMiss <= inputTokens;
    if (consistent) return directMiss;
  }
  if (inputTokens !== undefined && cacheRead != null && cacheRead <= inputTokens) {
    return inputTokens - cacheRead;
  }
  return null;
}

/**
 * The token/cache fields of ONE `_meta.usage` snapshot, read in the shared
 * raw-usage vocabulary (`inputTokens` / `outputTokens` / `cacheReadTokens` /
 * `cacheWriteTokens` plus the snake_case aliases the shared parser accepts)
 * and in the real WorkBuddy prompt-cache vocabulary (see rawCacheReadOf /
 * rawCacheMissOf). Only fields the snapshot actually carried are returned, so
 * an absent metric stays unavailable and a genuinely reported 0 stays 0.
 */
function rawUsageSnapshotOf(meta: Json | null): RawUsageSnapshot | null {
  const usage = meta ? asObject(meta.usage) : null;
  if (!usage) return null;
  const snapshot: RawUsageSnapshot = {};
  const read = (field: RawUsageField, ...candidates: unknown[]): void => {
    for (const candidate of candidates) {
      const value = numberOf(candidate);
      if (value != null) {
        snapshot[field] = value;
        return;
      }
    }
  };
  read("tokensIn", usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  read("tokensOut", usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const cacheRead = rawCacheReadOf(usage);
  if (cacheRead != null) snapshot.cacheRead = cacheRead;
  read("cacheCreation", usage.cacheWriteTokens, usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const cacheMiss = rawCacheMissOf(usage, snapshot.tokensIn, cacheRead);
  if (cacheMiss != null) snapshot.cacheMiss = cacheMiss;
  return Object.keys(snapshot).length ? snapshot : null;
}

/**
 * Map ONE ACP `usage_update` onto the canonical provider-neutral `usage` event.
 * Every field follows the protocol evidence documented in the module header:
 * `used`/`size` are context GAUGES that are only meaningful when the runtime
 * resolved a context window (`size > 0`), `cost.amount` is an ADDITIVE
 * per-response credit consumption, and `_meta.usage` is the raw token/cache
 * snapshot of ONE model response.
 *
 * `cost.amount` is only mapped when it is strictly positive: the runtime
 * expresses "zero credits consumed" by OMITTING `cost` (which maps to the
 * canonical null), so an `amount: 0` frame is a placeholder, never a genuine
 * zero measurement — it must not become `credits: 0`.
 *
 * The raw snapshot is reconciled by RESPONSE IDENTITY through
 * `rawUsageByResponse`: the event carries the DELTA since that response's
 * previous snapshot, so a republication contributes nothing, a later snapshot
 * replaces the earlier observation, and two distinct responses each contribute
 * their own final snapshot. A snapshot with no provable identity is dropped.
 *
 * When a delta IS emitted and the frame proves a real message id, the event
 * carries that `messageId` (the response the deltas were reconciled against).
 * It does NOT authorize Decode: the event proves the output token count and the
 * identity, never the assembled/final response instant (see the header's decode
 * note in the canonical telemetry contract). A frame that proves only a
 * request id never carries a messageId — no response identity could be linked.
 *
 * Returns null for an information-free frame (an unresolvable context size, no
 * credit consumption and no raw snapshot), so no record is invented for it.
 */
function canonicalUsageFromAcp(update: Json, rawUsageByResponse: Map<string, RawUsageSnapshot>): Json | null {
  const used = numberOf(update.used);
  const size = numberOf(update.size);
  const cost = asObject(update.cost);
  const credit = cost ? numberOf(cost.amount) : null;
  const canonical: Json = { type: "usage" };
  if (size != null && size > 0 && used != null) {
    canonical.contextUsed = used;
    canonical.contextWindow = size;
  }
  if (credit != null && credit > 0) canonical.credits = credit;

  const meta = asObject(update._meta);
  const snapshot = rawUsageSnapshotOf(meta);
  const responseId = snapshot ? usageResponseId(update, meta) : null;
  if (snapshot && responseId) {
    const previous = rawUsageByResponse.get(responseId) ?? {};
    const next = { ...previous };
    let emittedDelta = false;
    for (const field of RAW_USAGE_FIELDS) {
      const value = snapshot[field];
      if (value === undefined) continue;
      const prior = previous[field];
      next[field] = value;
      // The first snapshot of a response contributes in full (a reported 0
      // included); a later one contributes the exact change, which is 0 for a
      // plain republication and negative for a corrected-downward value.
      if (prior === undefined) {
        canonical[field] = value;
        emittedDelta = true;
      } else if (value !== prior) {
        canonical[field] = value - prior;
        emittedDelta = true;
      }
    }
    rawUsageByResponse.set(responseId, next);
    // The response identity is attached ONLY to an event that really carries a
    // token/cache delta: a republication stays an information-free no-op.
    const messageId = usageMessageId(update, meta);
    if (emittedDelta && messageId) canonical.messageId = messageId;
  }
  return Object.keys(canonical).length > 1 ? canonical : null;
}

function capText(text: string, cap: number): string {
  const value = text.trim();
  if (value.length <= cap) return value;
  return value.slice(0, cap) + "…";
}

/**
 * Create the normalizer of ONE ACP conversation.
 *
 * All state is per conversation; the caller owns the record sink (the bridge
 * writes each returned record as one stdout line, exactly like a Command Code
 * stream record).
 */
export function createAcpNormalizer(options: AcpNormalizerOptions = {}): AcpNormalizer {
  const toolTextCap = Number.isInteger(options.toolTextCap) && (options.toolTextCap as number) > 0
    ? (options.toolTextCap as number)
    : ACP_TOOL_TEXT_CAP;

  const tools = new Map<string, ToolState>();
  /**
   * The LATEST raw usage snapshot seen per response identity. Reconciliation is
   * scoped to ONE ACP conversation (one bridge run): a later generation is a
   * separate process whose own attempt usage is summed exactly once by the job
   * service, never merged with this conversation's observations.
   */
  const rawUsageByResponse = new Map<string, RawUsageSnapshot>();
  let textBuffer = "";
  let textMessageId: string | null = null;
  let textPairMessageId: string | null = null;
  let messageOpen = false;
  let toolSequence = 0;
  let assistant = "";
  let thoughtBuffer = "";
  let thoughtMessageId: string | null = null;
  let thoughtPairMessageId: string | null = null;
  let thinkingOpen = false;

  const event = (payload: Json): Json => ({ type: "event", event: payload });

  const closeMessage = (out: Json[], at: FrameTime | null = null): void => {
    if (!messageOpen) return;
    messageOpen = false;
    const messageId = textPairMessageId ?? textMessageId;
    textMessageId = null;
    textPairMessageId = null;
    const body = textBuffer;
    textBuffer = "";
    // The closing record keeps the response identity the streamed chunks
    // carried (the run totals reconcile by it) and, when the frame that caused
    // the closure published one, that frame's own instant. A closure is a
    // SYNTHESIZED boundary: it drives activity rendering only and is never
    // decode evidence (see the header).
    out.push(event(withFrameTime({
      type: "message_end",
      ...(messageId ? { messageId } : {}),
      ...(body ? { content: [{ type: "text", text: body }] } : {})
    }, at)));
  };

  const closeThinking = (out: Json[], at: FrameTime | null = null): void => {
    if (!thinkingOpen) return;
    thinkingOpen = false;
    const messageId = thoughtPairMessageId ?? thoughtMessageId;
    thoughtMessageId = null;
    thoughtPairMessageId = null;
    const body = thoughtBuffer;
    thoughtBuffer = "";
    out.push(event(withFrameTime({
      type: "thinking_end",
      ...(messageId ? { messageId } : {}),
      ...(body ? { text: body } : {})
    }, at)));
  };

  const toolState = (toolCallId: string): ToolState => {
    const existing = tools.get(toolCallId);
    if (existing) return existing;
    const created: ToolState = { name: null, queued: false, running: false, terminal: false, progress: "", progressReported: false };
    tools.set(toolCallId, created);
    return created;
  };

  const toolNameOf = (update: Json, state: ToolState | null): string => {
    for (const key of ["title", "toolName", "name"]) {
      const value = stringOf(update[key]);
      if (value) return value;
    }
    const kind = stringOf(update.kind);
    if (kind) return kind;
    return state?.name ?? "tool";
  };

  /** The tool's output as text: its ACP content entries, else its rawOutput (bounded). */
  const toolText = (update: Json): string => {
    const parts: string[] = [];
    if (update.content !== undefined) {
      const entries = Array.isArray(update.content) ? update.content : [update.content];
      for (const entry of entries) parts.push(toolContentText(entry));
    }
    const fromContent = capText(
      parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n"),
      toolTextCap
    );
    // A frame may carry the SAME output as tool-call content AND as rawOutput (a
    // real WorkBuddy completion did); the content form wins so a row never repeats it.
    if (fromContent) return fromContent;
    return update.rawOutput !== undefined ? capText(rawOutputText(update.rawOutput), toolTextCap) : "";
  };

  const blocksOf = (text: string): Json[] => (text ? [{ type: "text", text }] : []);

  const applyToolStatus = (
    out: Json[],
    update: Json,
    toolCallId: string,
    state: ToolState,
    name: string,
    status: string,
    at: FrameTime | null
  ): void => {
    if (state.terminal) return;
    const text = toolText(update);
    if (TOOL_STATUS_COMPLETED.has(status)) {
      state.terminal = true;
      state.running = false;
      state.progressReported = true;
      // A completion that carries no content of its own still reports the output
      // the SAME tool already streamed (never invented, never another tool's).
      const result = text || state.progress;
      state.progress = result;
      out.push(event(withFrameTime({ type: "tool_completed", toolCallId, toolName: name, result: blocksOf(result) }, at)));
      return;
    }
    if (TOOL_STATUS_FAILED.has(status)) {
      state.terminal = true;
      state.running = false;
      state.progressReported = true;
      const result = text || state.progress;
      state.progress = result;
      out.push(event(withFrameTime({ type: "tool_completed", toolCallId, toolName: name, status: "failed", result: blocksOf(result) }, at)));
      return;
    }
    if (TOOL_STATUS_RUNNING.has(status) && !state.running) {
      state.running = true;
      out.push(event(withFrameTime({ type: "tool_running", toolCallId, toolName: name, description: null }, at)));
    }
    // Content a still-unfinished tool streamed is AGGREGATED, not one row per
    // frame: a real WorkBuddy runtime streams the tool's forming input/output at
    // near-token granularity (one Read produced 36 content updates), so a row per
    // update would recreate exactly the per-token noise the canonical view
    // removes. The latest text is reported once, when the tool ends or the
    // conversation is flushed (see flush()), and it is what the completion falls
    // back to when the completion itself carries no content.
    if (text && text !== state.progress) state.progress = text;
  };

  /** Report the latest aggregated progress of every tool that never finished. */
  const reportOpenToolProgress = (out: Json[]): void => {
    for (const [toolCallId, state] of tools) {
      if (state.terminal || state.progressReported || !state.progress) continue;
      state.progressReported = true;
      out.push(event({
        type: "tool_update",
        toolCallId,
        toolName: state.name ?? "tool",
        partial: blocksOf(state.progress)
      }));
    }
  };

  const handleToolCall = (out: Json[], update: Json, at: FrameTime | null): void => {
    closeMessage(out, at);
    closeThinking(out, at);
    const toolCallId = stringOf(update.toolCallId) ?? stringOf(update.tool_call_id) ?? `acp-tool-${++toolSequence}`;
    const state = toolState(toolCallId);
    const name = toolNameOf(update, state);
    state.name = name;
    if (!state.queued) {
      state.queued = true;
      const input = inputOf(update);
      out.push(event(withFrameTime({
        type: "tool_queued",
        toolCallId,
        toolName: name,
        ...(input !== undefined ? { input } : {})
      }, at)));
    }
    const status = stringOf(update.status) ?? "";
    if (status) applyToolStatus(out, update, toolCallId, state, name, status, at);
  };

  const handleToolCallUpdate = (out: Json[], update: Json, at: FrameTime | null): void => {
    const toolCallId = stringOf(update.toolCallId) ?? stringOf(update.tool_call_id);
    if (!toolCallId) return;
    const state = toolState(toolCallId);
    const name = toolNameOf(update, state);
    if (!state.queued) {
      // An update for a tool whose `tool_call` frame we never saw must still be
      // rendered generically BY NAME, so the name is established here.
      state.queued = true;
      state.name = name;
      out.push(event(withFrameTime({ type: "tool_queued", toolCallId, toolName: name }, at)));
    } else if (name !== state.name) {
      state.name = name;
    }
    applyToolStatus(out, update, toolCallId, state, name, stringOf(update.status) ?? "", at);
  };

  return {
    handleUpdate(update: unknown): Json[] {
      const obj = asObject(update);
      if (!obj) return [];
      const kind = updateKind(obj);
      const out: Json[] = [];
      // The runtime's own instant for this frame, when it published one (see
      // `frameTimestampOf`). Local read time is never substituted.
      const at = frameTimestampOf(obj);

      if (MESSAGE_CHUNK_KINDS.has(kind)) {
        // The answer starting is the observable end of a reasoning block.
        closeThinking(out, at);
        const rawMessageId = responseMessageIdOf(obj.messageId) ?? responseMessageIdOf(obj.message_id);
        const pairMessageId = streamPairMessageIdOf(obj) ?? rawMessageId;
        if (
          messageOpen &&
          ((rawMessageId && textMessageId && rawMessageId !== textMessageId) ||
            (pairMessageId && textPairMessageId && pairMessageId !== textPairMessageId))
        ) closeMessage(out, at);
        if (!messageOpen) {
          messageOpen = true;
          textMessageId = rawMessageId;
          textPairMessageId = pairMessageId;
          out.push(event(withFrameTime({ type: "message_start", ...(pairMessageId ? { messageId: pairMessageId } : {}) }, at)));
        } else {
          if (rawMessageId && !textMessageId) textMessageId = rawMessageId;
          if (pairMessageId && !textPairMessageId) textPairMessageId = pairMessageId;
        }
        const chunk = textOfBlock(obj.content ?? obj.message ?? obj);
        if (!chunk) return out;
        textBuffer += chunk;
        assistant += chunk;
        const canonicalId = textPairMessageId ?? pairMessageId;
        out.push(event(withFrameTime({ type: "text_delta", delta: chunk, ...(canonicalId ? { messageId: canonicalId } : {}) }, at)));
        return out;
      }

      if (THOUGHT_CHUNK_KINDS.has(kind)) {
        const rawMessageId = responseMessageIdOf(obj.messageId) ?? responseMessageIdOf(obj.message_id);
        const pairMessageId = streamPairMessageIdOf(obj) ?? rawMessageId;
        if (
          thinkingOpen &&
          ((rawMessageId && thoughtMessageId && rawMessageId !== thoughtMessageId) ||
            (pairMessageId && thoughtPairMessageId && pairMessageId !== thoughtPairMessageId))
        ) closeThinking(out, at);
        if (!thinkingOpen) {
          thinkingOpen = true;
          thoughtMessageId = rawMessageId;
          thoughtPairMessageId = pairMessageId;
          out.push(event(withFrameTime({ type: "thinking_start", ...(pairMessageId ? { messageId: pairMessageId } : {}) }, at)));
        } else {
          if (rawMessageId && !thoughtMessageId) thoughtMessageId = rawMessageId;
          if (pairMessageId && !thoughtPairMessageId) thoughtPairMessageId = pairMessageId;
        }
        const chunk = textOfBlock(obj.content ?? obj.message ?? obj);
        if (!chunk) return out;
        thoughtBuffer += chunk;
        const canonicalId = thoughtPairMessageId ?? pairMessageId;
        out.push(event(withFrameTime({ type: "thinking_delta", delta: chunk, ...(canonicalId ? { messageId: canonicalId } : {}) }, at)));
        return out;
      }

      if (kind === "tool_call") {
        handleToolCall(out, obj, at);
        return out;
      }

      if (kind === "tool_call_update") {
        handleToolCallUpdate(out, obj, at);
        return out;
      }

      if (kind === "usage_update") {
        // The runtime's usage/credit notification. It never closes an open
        // message or reasoning block: it may arrive at any point of the turn.
        const usage = canonicalUsageFromAcp(obj, rawUsageByResponse);
        if (usage) out.push(event(withFrameTime(usage, at)));
        return out;
      }

      if (kind === "end_turn") {
        closeThinking(out, at);
        closeMessage(out, at);
        return out;
      }

      return out;
    },

    flush(): Json[] {
      const out: Json[] = [];
      // A tool that never reported a terminal status still has its last known
      // output recorded once, before the pending message blocks are closed.
      // Flush closes carry NO timestamp: the bridge, not the runtime, decided
      // the boundary (never presented as provider time).
      reportOpenToolProgress(out);
      closeThinking(out);
      closeMessage(out);
      return out;
    },

    assistantText(): string {
      return assistant;
    }
  };
}

/**
 * The bridge's run-start record. `sessionId` is the ACP session id the run
 * continues (`--resume` reuses it) and `model` is the resolved model id this
 * run requested — model METADATA only: it never selects a parsing path.
 */
export function acpInitRecord(sessionId: string, model: string): Json {
  return { type: "init", session_id: sessionId, model };
}

// ---------------------------------------------------------------------------
// ACP terminal outcomes: a prompt-turn COMPLETION is not a successful result
// ---------------------------------------------------------------------------
//
// `session/prompt` returning only proves the transport delivered a terminal
// record; it is NOT proof that the provider finished the requested task. The
// INSTALLED WorkBuddy ACP schema (`zStopReason` in resources/app.asar
// main/acp.js, WorkBuddy Desktop 5.6.2) publishes exactly five stop reasons:
//
//     end_turn | max_tokens | max_turn_requests | refusal | cancelled
//
// Only `end_turn` means the turn completed normally. The other four are
// non-completions and must never become a durable CrewDispatch `done` result: the
// pre-fix bridge stamped EVERY transport completion as
// `subtype:"success" / is_error:false`, so the observed live record
// `{subtype:"success", result:null, stop_reason:"refusal", is_error:false}`
// (job-mupa72lp-k2iinx) was persisted as `done` with no assistant result.
//
// The classifications below are the SINGLE provider-boundary mapping of those
// stop reasons onto CrewDispatch's shared terminal vocabulary. They carry:
//   - a stable provider-specific failure kind (durable `failure_kind`),
//   - an understandable message that names the provider's own decision and
//     never claims a transport/connection failure,
//   - the bridge exit code that carries the outcome to the shared exit
//     classifier (the bridge's own terminal namespace on Windows; 0 stays a
//     successful bridge run).
// The provider's ORIGINAL stop reason is preserved verbatim in the result
// record's `stop_reason`, so it stays visible in durable state.
//
// FINISH REASON (JQ-20261001-23): the installed runtime maps BOTH
// `finish_reason=content_filter` and `finish_reason=refusal` to ACP
// `stopReason=refusal` (its own `mapFinishReasonToStopReason`), but it also
// publishes the model's original token on the prompt result as
// `_meta["codebuddy.ai/finishReason"]` (read locally from the installed
// Desktop runtime's AcpView response construction). The bridge preserves that
// bounded token as the record's `finish_reason`; the refusal diagnostic then
// names the provider's real cause and a `content_filter` is never presented as
// a plain refusal. A runtime that publishes no finish reason keeps the honest
// generic refusal message and record shape.
//
// ERROR DETAIL (JQ-20261001-24): the SAME installed prompt-result construction
// (`cli/dist/codebuddy-headless.js`, its AcpView response builder and
// exception/refusal paths) publishes a provider-generated diagnostic as
// `_meta["codebuddy.ai/errorMessage"]` whenever the classified outcome carries
// one — the JSON-encoded classified error response (`{code,message,data}`) on
// an exception/refusal, or the runtime's own `safeMessage` on a blocked
// sensitive prompt. The bridge preserves ONLY the bounded, single-line safe
// form `safeAcpErrorDetail` accepts as the record's `error_detail`. The detail
// is diagnostic in general; only the recorded quota shape beside
// stop_reason=refusal (with `finish_reason=tool_calls` or none — the observed
// live quota shape, JQ-20261002-43) is classified as a rate limit.

/** The one ACP stop reason that means the provider completed the requested task. */
export const ACP_COMPLETED_STOP_REASON = "end_turn";

/**
 * The provider `finish_reason` that marks a cut-off tool loop. It is the
 * second half of the proven declined-approval shape (JQ-20261001-25): the
 * installed runtime ends a turn whose own approval gate could not proceed as
 * `stop_reason=cancelled, finish_reason=tool_calls`.
 */
export const ACP_FINISH_TOOL_CALLS = "tool_calls";

/**
 * The provider's own `finish_reason` values that refine an ACP `refusal`
 * (JQ-20261001-23). The installed runtime maps BOTH to `stopReason=refusal`
 * (see `mapFinishReasonToStopReason`), so they are distinguished only by the
 * finish reason itself:
 *   - `content_filter` — the provider's content filter blocked the response;
 *   - `refusal`       — the model explicitly refused the request.
 */
export const ACP_FINISH_CONTENT_FILTER = "content_filter";
export const ACP_FINISH_REFUSAL = "refusal";

/** Cap on a safe provider evidence token (finish reason / error category / reason). */
export const ACP_FINISH_REASON_CAP = 64;

/**
 * A bounded, display-safe provider evidence token.
 *
 * The installed runtime publishes short machine tokens (the model's own
 * `finish_reason`, a JSON-RPC error `category`, the runtime's own `reason`) on
 * its terminal surfaces. Only such a token is accepted: an arbitrary provider
 * payload must never reach canonical records, durable state or the Dashboard.
 * Anything else is omitted (null), never rewritten or truncated into a
 * fabricated value.
 */
export function safeAcpEvidenceToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ACP_FINISH_REASON_CAP) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(trimmed) ? trimmed : null;
}

/**
 * A bounded, display-safe provider finish reason (`safeAcpEvidenceToken`).
 *
 * The installed runtime publishes the model's own `finish_reason` token inside
 * the ACP `session/prompt` result's `_meta` (`_meta["codebuddy.ai/finishReason"]`,
 * read locally from the installed Desktop runtime's AcpView response).
 */
export function safeAcpFinishReason(value: unknown): string | null {
  return safeAcpEvidenceToken(value);
}

/** Cap on one safe bounded provider terminal error detail (single line). */
export const ACP_ERROR_DETAIL_CAP = 300;

/**
 * A bounded, display-safe provider terminal error detail, or null.
 *
 * The installed WorkBuddy runtime (Desktop 5.6.2,
 * `cli/dist/codebuddy-headless.js`) publishes a provider-generated diagnostic
 * on the ACP prompt result under `_meta["codebuddy.ai/errorMessage"]`:
 *   - a plain provider message — the runtime's own `safeMessage` when it blocks
 *     a sensitive prompt before dispatch, and the classified refusal text;
 *   - the JSON-encoded classified error response of an exception path
 *     (`JSON.stringify(classifyErrorAsRequestError(e).toErrorResponse())`),
 *     whose shape is `{code, message, data}` — `data` can carry internal
 *     status/business fields, so ONLY `message` may ever leave the boundary.
 *
 * Every value is reduced before it can reach a record:
 *   - the JSON form contributes ONLY its `message` field; a JSON-looking value
 *     without a usable message is dropped entirely (never re-serialized);
 *   - the text is reduced to its FIRST line — the point where a stack trace or
 *     payload dump would start — and a value that itself looks like a code
 *     frame is dropped;
 *   - control characters are collapsed, credentials are redacted through the
 *     same policy the bridge uses, and the result is capped; an empty or
 *     unusable value is omitted (null).
 *
 * This detail is diagnostic by default. A single known provider quota message
 * may classify as a rate limit, but only when the same prompt also reports
 * stop_reason=refusal with `finish_reason=tool_calls` or no finish reason at
 * all (see classifyAcpStopReason).
 */
export function safeAcpErrorDetail(value: unknown): string | null {
  const raw = stringOf(value);
  if (!raw) return null;
  let text = raw;
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A payload-shaped value that is not even valid JSON is never carried.
      return null;
    }
    const message = asObject(parsed) ? stringOf((parsed as Json).message) : null;
    if (!message) return null;
    text = message;
  }
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstLine) return null;
  // A `file:line:column` frame is a stack/diagnostic dump, never a provider
  // message: omit the whole detail rather than carrying internals.
  if (/(?:[A-Za-z]:[\\/]|\/)[^\s"']+:\d+:\d+/.test(firstLine)) return null;
  const redacted = firstLine.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>");
  return redacted.length <= ACP_ERROR_DETAIL_CAP ? redacted : redacted.slice(0, ACP_ERROR_DETAIL_CAP) + "…";
}

/** Stable failure kinds for ACP non-completions (durable `failure_kind`). */
export const ACP_FAILURE_REFUSAL = "provider_refusal";
/** The shared fallback-eligible rate-limit failure kind. */
export const ACP_FAILURE_RATE_LIMIT = "rate_limit";
export const ACP_FAILURE_MAX_TOKENS = "provider_max_tokens";
export const ACP_FAILURE_MAX_TURN_REQUESTS = "provider_max_turn_requests";
export const ACP_FAILURE_CANCELLED = "provider_cancelled";
export const ACP_FAILURE_STOP = "provider_stop";
/**
 * The runtime rejected `session/prompt` because the model stream itself ended
 * with `finish_reason=error` (JQ-20261001-24; see ACP_MODEL_ERROR_OUTCOME).
 */
export const ACP_FAILURE_MODEL_ERROR = "provider_model_error";
/**
 * The provider demanded an interactive approval for a tool action and CrewDispatch,
 * running non-interactively, declined it; the prompt turn then ended
 * `stop_reason=cancelled` with `finish_reason=tool_calls` (JQ-20261001-25).
 * This is a provider permission interruption, never a user/CrewDispatch
 * cancellation.
 */
export const ACP_FAILURE_PERMISSION_REQUIRED = "provider_permission_required";
/**
 * THIS prompt turn's interactive approval gate reached its deadline before any
 * decision was made, and the bridge's ApprovalChannel PROVED it by returning
 * `reason=expired` (JQ-20261001-26). This is a distinct diagnostic from the
 * declined-gate `provider_permission_required` and from a plain
 * `provider_cancelled`: it must be raised ONLY on that proven expiry, never for
 * an ordinary rejection, a teardown/dispose, or a generic cancelled turn.
 */
export const ACP_FAILURE_APPROVAL_EXPIRED = "provider_approval_expired";
/**
 * THIS prompt turn's interactive approval gate was REJECTED by a real human
 * decision: the ApprovalChannel returned `selected` with a provider option that
 * is provably NOT an allow choice (the provider's own reject_once/reject kind).
 * The historical `provider_permission_required` wording ("CrewDispatch is
 * non-interactive") is false for this case — the user was asked and decided —
 * so the rejection gets its own durable kind and message. It is raised ONLY
 * from that proven selection, never for a decline, an expiry or a teardown.
 */
export const ACP_FAILURE_APPROVAL_REJECTED = "provider_approval_rejected";

/**
 * The proven shape of ONE declined WorkBuddy interactive tool-approval gate.
 *
 * The installed runtime only asks its client for `session/request_permission`
 * when its own permission system demands an interactive approval — and it
 * announces the ASK (with its internal `decisionReason`, e.g.
 * `{type:"toolValidation",message:"High-risk command safety check"}`) ONLY in
 * its own log. Live captured params of the high-risk case (job
 * `job-mupil5r4-pd51wy`, replayed against the installed runtime) are exactly:
 *
 *   { sessionId,
 *     options: [ {kind:"allow_always",...}, {kind:"allow_once",...}, {kind:"reject_once",...} ],
 *     toolCall: { toolCallId, rawInput: { command, ... }, _meta: { "codebuddy.ai/toolName": "Bash" } },
 *     _meta: { "codebuddy.ai/requestId": ... } }
 *
 * — and an ordinary (non-safety) Bash permission ask in the same runtime has
 * the SAME wire shape. The decision reason is NOT on this transport, so the
 * ONE thing a request proves is that WorkBuddy demanded an interactive
 * approval for a tool action; the remembered evidence stays exactly that.
 */
/**
 * The provider's OWN operation fields, extracted one by one from the approval
 * request. Only these named keys are read — the request is never copied
 * wholesale — and every value stays a raw string here: bounding, control-
 * sequence stripping and credential redaction happen at the shared
 * provider-neutral boundary (jobs/approval.ts), so the durable record, the Hub
 * API and the UI all enforce the SAME rules.
 */
export interface AcpApprovalOperation {
  /** The actual operation (`toolCall.rawInput.command`), when published. */
  command: string | null;
  /** The provider's own description, when published. */
  description: string | null;
  /** A file path (`file_path` / `path`), when published. */
  path: string | null;
  /** A working directory (`cwd`), when published. */
  cwd: string | null;
  /** The provider's own title/text for the operation, when published. */
  title: string | null;
  /**
   * The provider's own approval GATE token, read from the ACP wire when present
   * (`toolCall._meta["codebuddy.ai/approvalKind"]`). Null when the provider
   * published none — never guessed.
   */
  gate: string | null;
  /**
   * The provider's own approval REASON/category token, read from the ACP wire
   * when present (`toolCall._meta["codebuddy.ai/approvalCategory"]`). Null when
   * the provider published none — never a guessed risk classification.
   */
  reason: string | null;
}

export interface AcpApprovalEvidence {
  /** The one proven interactive gate: a tool-approval permission request. */
  kind: "tool_approval";
  /**
   * The provider's own bounded tool-name token when it published a safe one
   * (`safeAcpEvidenceToken`); null when absent or unsafe. It is never
   * arbitrary request text and never the tool's arguments.
   */
  toolName: string | null;
  /**
   * The provider's own operation detail, or null when it published none. Only
   * the named operation fields are read; the object is later bounded, stripped
   * and redacted by the shared approval boundary before it can be displayed.
   */
  detail: AcpApprovalOperation | null;
}

/** The provider's interactive-question tools are not approval gates. */
const ACP_QUESTION_TOOL_TOKENS: ReadonlySet<string> = new Set(["askuserquestion", "exitplanmode"]);

/**
 * Prove ONE `session/request_permission` request is a WorkBuddy tool-approval
 * gate, or return null.
 *
 * Accepted only when the request structurally IS an approval gate:
 *   - `toolCall` is an object carrying a non-empty string `toolCallId`;
 *   - at least one `options` entry offers a reject/deny outcome (the gate can
 *     be declined);
 *   - it is not an interactive QUESTION (`AskUserQuestion` / `ExitPlanMode`
 *     tools, or a `rawInput.questions` payload): questions are
 *     user-interaction requests, not tool-approval gates, and keep the
 *     historical cancellation semantics.
 *
 * The remembered detail is the provider's bounded tool-name token PLUS the
 * provider's OWN operation fields, extracted one by one (`command`,
 * `description`, `file_path`/`path`, `cwd`, title/text) so a human can see what
 * the gate is about. The request is never copied wholesale: no other raw input
 * key, no environment, no prompt text. The extracted values are bounded,
 * control-stripped and credential-redacted by the shared approval boundary
 * before they can reach a file, a record, the Hub or the UI. Malicious,
 * oversized or unsafe values cannot kill the gate (the request still proves
 * one) and can never leak an unredacted secret.
 */
export function acpToolApprovalEvidence(params: unknown): AcpApprovalEvidence | null {
  const request = asObject(params);
  if (!request) return null;
  const toolCall = asObject(request.toolCall);
  const toolCallId = stringOf(toolCall?.toolCallId);
  if (!toolCall || !toolCallId) return null;
  const options = Array.isArray(request.options) ? request.options : [];
  const hasReject = options.some((option) => {
    const entry = asObject(option);
    if (!entry) return false;
    const kind = stringOf(entry.kind)?.toLowerCase() ?? "";
    const optionId = stringOf(entry.optionId)?.toLowerCase() ?? "";
    return (
      kind === "reject" ||
      kind === "reject_once" ||
      kind === "reject_always" ||
      optionId === "reject" ||
      optionId === "deny"
    );
  });
  if (!hasReject) return null;
  const rawInput = asObject(toolCall.rawInput);
  if (Array.isArray(rawInput?.questions) && rawInput.questions.length > 0) return null;
  const meta = asObject(toolCall._meta);
  const toolName = safeAcpEvidenceToken(meta?.["codebuddy.ai/toolName"]) ?? safeAcpEvidenceToken(toolCall.title);
  const normalizedName = toolName ? toolName.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  if (ACP_QUESTION_TOOL_TOKENS.has(normalizedName)) return null;
  // Field-by-field extraction of the KNOWN operation keys only. The gate and
  // reason are the provider's OWN bounded tokens from the ACP wire meta; they
  // are read only when the installed runtime actually published them (the
  // approval-policy path), and are never derived or guessed.
  const operation: AcpApprovalOperation = {
    command: stringOf(rawInput?.command),
    description: stringOf(rawInput?.description) ?? stringOf(toolCall.description),
    path: stringOf(rawInput?.file_path) ?? stringOf(rawInput?.path),
    cwd: stringOf(rawInput?.cwd),
    title: stringOf(toolCall.title),
    gate: safeAcpEvidenceToken(meta?.["codebuddy.ai/approvalKind"]),
    reason: safeAcpEvidenceToken(meta?.["codebuddy.ai/approvalCategory"])
  };
  const hasDetail = !!(
    operation.command || operation.description || operation.path || operation.cwd || operation.title || operation.gate || operation.reason
  );
  return { kind: "tool_approval", toolName: toolName ?? null, detail: hasDetail ? operation : null };
}

export interface AcpTerminalOutcome {
  /** Stable provider-specific failure kind; null when the turn completed normally. */
  failureKind: string | null;
  /** Understandable message of the provider's own decision; null on success. */
  message: string | null;
  /** Bridge exit code carrying this outcome (0 for a normal completion). */
  exitCode: number;
}

const ACP_COMPLETION_OUTCOME: AcpTerminalOutcome = { failureKind: null, message: null, exitCode: 0 };

/** Non-completion stop reasons of the installed ACP schema (see the block note). */
const ACP_NON_SUCCESS_STOP_REASONS: ReadonlyMap<string, AcpTerminalOutcome> = new Map([
  [
    "refusal",
    {
      failureKind: ACP_FAILURE_REFUSAL,
      message: "WorkBuddy AI refused this request (stop_reason=refusal); no task result was produced.",
      exitCode: 11
    }
  ],
  [
    "max_tokens",
    {
      failureKind: ACP_FAILURE_MAX_TOKENS,
      message: "WorkBuddy AI stopped at the output-token limit (stop_reason=max_tokens); the response is incomplete.",
      exitCode: 12
    }
  ],
  [
    "max_turn_requests",
    {
      failureKind: ACP_FAILURE_MAX_TURN_REQUESTS,
      message: "WorkBuddy AI reached its maximum number of model requests for this turn (stop_reason=max_turn_requests); the task did not complete.",
      exitCode: 13
    }
  ],
  [
    "cancelled",
    {
      failureKind: ACP_FAILURE_CANCELLED,
      message: "WorkBuddy AI reported the turn as cancelled (stop_reason=cancelled); the task did not complete.",
      exitCode: 14
    }
  ]
]);

/**
 * A stop reason outside the installed schema is still a non-completion: a
 * future protocol value must never fall back to "success". The raw reason is
 * preserved in durable state; the message names it.
 */
const ACP_UNKNOWN_STOP_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_STOP,
  message: "WorkBuddy AI ended the turn without a normal end_turn completion; the task did not complete.",
  exitCode: 15
};

/**
 * The runtime's JSON-RPC model-service error, carried by the bridge's own
 * exit-code namespace.
 *
 * The installed runtime (Desktop 5.6.2,
 * `cli/dist/codebuddy-headless.js`) REJECTS `session/prompt` as a JSON-RPC
 * error — it does not resolve a stop reason — when its own terminal event
 * proves `finish_reason=error`: `isProviderFinishReasonError` matches a
 * RequestError whose `data.reason` is `provider_finish_reason_error` (built
 * with `data:{category:"model_service", details:"The model stream ended with
 * finish_reason=error.", finishReason:"error", reason:"provider_finish_reason_error"}`,
 * code -32004). The bridge preserves that bounded evidence so a model-service
 * error is never reduced to a generic bridge failure (JQ-20261001-24); the
 * existing auth/permission/rate-limit/network/server classifications still
 * take precedence (see classifyBridgeError).
 */
const ACP_MODEL_ERROR_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_MODEL_ERROR,
  message: "WorkBuddy AI's model service ended the response with an error (finish_reason=error); the task did not complete.",
  exitCode: 16
};

/**
 * The refused interactive approval gate (JQ-20261001-25).
 *
 * CrewDispatch is non-interactive: when the runtime's own permission system demands
 * an explicit approval for a tool action, the bridge can only decline it, and
 * the runtime then ends the turn `stop_reason=cancelled, finish_reason=tool_calls`.
 * That shape is NOT a cancellation — nobody cancelled the run; the provider
 * required an approval that this client cannot give. The durable wording names
 * exactly that and never presents it as a user/CrewDispatch cancellation.
 */
const ACP_PERMISSION_REQUIRED_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_PERMISSION_REQUIRED,
  message:
    "WorkBuddy AI required an interactive approval for a tool action, and CrewDispatch is non-interactive, so the run stopped " +
    "(stop_reason=cancelled, finish_reason=tool_calls); the task did not complete.",
  exitCode: 17
};

/**
 * The EXPIRED interactive approval gate (JQ-20261001-26).
 *
 * The bridge's own ApprovalChannel reported `reason=expired` for THIS prompt
 * turn: the user was asked, the deadline passed, and no decision was ever made.
 * That is neither a decline nor a cancellation, so it gets its own durable
 * wording and failure kind. It is raised ONLY from that proven reason AND the
 * gate shape that proves the gate caused the stop (`stop_reason=cancelled` +
 * `finish_reason=tool_calls` + the remembered tool-approval gate); a normal
 * rejection, a bridge teardown, a bare `cancelled` turn, and every unrelated
 * terminal cause (quota, refusal, unknown stop, completion) keep their
 * existing classification. The provider's raw stop reason is still preserved
 * verbatim on the record's `stop_reason`.
 */
const ACP_APPROVAL_EXPIRED_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_APPROVAL_EXPIRED,
  message:
    "WorkBuddy AI required an interactive approval for a tool action, and the CrewDispatch approval deadline passed " +
    "before a decision was made, so the run stopped; the task did not complete.",
  exitCode: 18
};

/**
 * The REJECTED interactive approval gate.
 *
 * The bridge's own ApprovalChannel returned `selected` with one of the
 * provider's OWN CANONICAL reject options: a human decided, and the gated
 * operation did not run. That is neither "CrewDispatch is non-interactive"
 * (the historical JQ-20261001-25 wording, which stays for a gate that could
 * not be offered) nor a cancellation, so it gets its own durable kind, wording
 * and exit code. It is raised ONLY from that proven rejection AND the gate
 * shape that proves the gate caused the stop (`stop_reason=cancelled` +
 * `finish_reason=tool_calls` + the remembered tool-approval gate); a decline,
 * an expiry, a teardown, a bare `cancelled` turn, a proven quota/refusal or an
 * unknown stop keep their existing classifications, and a normal completion is
 * never overridden. An unknown provider option kind is never treated as a
 * rejection (JQ-20261005-57).
 */
const ACP_APPROVAL_REJECTED_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_APPROVAL_REJECTED,
  message:
    "WorkBuddy AI required an interactive approval for a tool action, and the CrewDispatch approval request was rejected, " +
    "so the run stopped; the task did not complete.",
  exitCode: 19
};

/**
 * One bounded provider message shape observed for a transient WorkBuddy quota
 * limit. Exit 5 is deliberately not added to ACP_TERMINAL_EXIT_OUTCOMES below:
 * the adapter delegates it to the shared classifier, which marks it eligible
 * for the existing model fallback chain.
 */
const ACP_RATE_LIMIT_OUTCOME: AcpTerminalOutcome = {
  failureKind: ACP_FAILURE_RATE_LIMIT,
  message: "WorkBuddy AI reported a quota/frequency rate limit (429); the configured fallback may be tried.",
  exitCode: 5
};

/**
 * Extract one bounded HTTP status from WorkBuddy's trusted ACP terminal error
 * metadata without depending on any provider prose.
 *
 * WorkBuddy's internal runtime keeps `httpStatusCode`, but the current ACP
 * prompt-result builder exposes only `codebuddy.ai/errorMessage`. That field is
 * sometimes JSON and sometimes plain text. Prefer known structured status keys;
 * otherwise accept only a standalone 3-digit HTTP-status token, never digits
 * embedded in ids, timestamps or longer numbers. The surrounding words are not
 * decision-bearing and may change language/version freely.
 */
export function safeAcpHttpStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed >= 100 && parsed <= 599 ? parsed : null;
  }
  return null;
}

function acpStructuredHttpStatus(value: unknown, depth = 0): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["httpStatusCode", "httpStatus", "statusCode", "status"] as const) {
    const status = safeAcpHttpStatus(record[key]);
    if (status !== null) return status;
  }
  for (const key of ["response", "error", "data"] as const) {
    const nested = acpStructuredHttpStatus(record[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

export function acpHttpStatusFromErrorDetail(errorDetail: string | null | undefined): number | null {
  // Inspect structured status BEFORE safeAcpErrorDetail intentionally strips the
  // JSON payload down to its display-safe message. Only the numeric status is
  // retained; no other provider data crosses this boundary.
  const raw = stringOf(errorDetail);
  if (raw?.trim().startsWith("{")) {
    try {
      const structured = acpStructuredHttpStatus(JSON.parse(raw));
      if (structured !== null) return structured;
    } catch {
      // Malformed JSON remains unusable evidence; the sanitizer below will also
      // refuse to carry it as a diagnostic.
    }
  }
  const detail = safeAcpErrorDetail(errorDetail);
  if (detail === null) return null;
  const match = /(?:^|[^A-Za-z0-9])([1-5]\d{2})(?![A-Za-z0-9])/.exec(detail);
  return match ? Number(match[1]) : null;
}

function hasAcpQuotaErrorEvidence(errorDetail: string | null | undefined): boolean {
  return acpHttpStatusFromErrorDetail(errorDetail) === 429;
}

/**
 * Bridge exit code -> terminal outcome, for the exit classifier. These private
 * codes are the WorkBuddy Desktop bridge's own namespace (Windows and macOS). The
 * shared rate-limit exit code 5 is intentionally absent so the adapter's base
 * classifier can enable the existing fallback path.
 */
export const ACP_TERMINAL_EXIT_OUTCOMES: ReadonlyMap<number, AcpTerminalOutcome> = new Map(
  [
    ...ACP_NON_SUCCESS_STOP_REASONS.values(),
    ACP_UNKNOWN_STOP_OUTCOME,
    ACP_MODEL_ERROR_OUTCOME,
    ACP_PERMISSION_REQUIRED_OUTCOME,
    ACP_APPROVAL_EXPIRED_OUTCOME,
    ACP_APPROVAL_REJECTED_OUTCOME
  ].map((outcome) => [outcome.exitCode, outcome])
);

// ---------------------------------------------------------------------------
// ACP session_end notifications: NOT a second terminal source
// ---------------------------------------------------------------------------
//
// The installed runtime also broadcasts an ACP `session_end` session update.
// Its only builder (`buildAcpSessionEndUpdate` in
// `cli/dist/codebuddy-headless.js`, WorkBuddy Desktop 5.6.2) produces exactly
//
//     { sessionUpdate: "session_end", stopReason, _meta: {requestId, timestamp?} }
//
// — no finishReason and no errorMessage (the runtime's own published API docs
// also describe optional fields, but the ACP notification builder that is
// actually wired to `sendTerminalSessionEnd`/`broadcastSessionEnd` writes only
// the stop reason). It is sent BESIDE the `session/prompt` RESPONSE, whose
// `_meta` carries the finish reason and the error detail, and the runtime
// itself suppresses it whenever the session is not idle
// (`shouldBroadcastSessionEnd`). The prompt result is therefore the
// authoritative terminal record; a session_end frame could never refine or
// override it. The normalizer ignores the frame generically and deliberately
// does NOT create a second terminal source (JQ-20261001-24).

/**
 * Classify one ACP prompt-turn stop reason. A missing reason keeps the
 * bridge's historical default (`end_turn`) ONLY for the success record it
 * writes (see acpSuccessResultRecord); it is treated as a normal completion
 * here so no existing behavior changes for a runtime that omits the field.
 *
 * `finishReason` (JQ-20261001-23) is the provider's own more specific cause
 * when the runtime published one. It refines the diagnostic message of a
 * refusal; ordinary refusals remain `provider_refusal`. The one evidence-backed
 * exception is the exact quota error-detail shape beside `stop_reason=refusal`
 * (with `finish_reason=tool_calls` or an absent finish reason — the observed
 * live shape, JQ-20261002-43), which becomes the shared `rate_limit` outcome.
 * Other detail text is diagnostic only, and a refusal with no finish reason
 * keeps the historical generic message.
 *
 * `approval` (JQ-20261001-25) is the per-prompt-turn evidence the bridge
 * remembered when a WorkBuddy `session/request_permission` tool-approval gate
 * was declined. When the turn then ends `cancelled` with
 * `finish_reason=tool_calls`, the outcome is the provider permission
 * interruption `provider_permission_required` — never the generic
 * `provider_cancelled`. Both proofs are required: a `cancelled` turn WITHOUT
 * the remembered approval (or without the tool_calls finish reason) keeps the
 * existing `provider_cancelled` semantics untouched. An ABANDONED wait
 * (`gateOutcome === "cancelled"`, see below) also keeps the generic
 * `provider_cancelled` semantics: the gate was never declined, the turn simply
 * ended before a decision.
 *
 * `gateOutcome` (JQ-20261001-26 and the approval-interruption follow-up,
 * JQ-20261005-57) is the outcome the bridge's own interactive ApprovalChannel
 * PROVED for the CURRENT remembered approval gate, when it answered that
 * request:
 *   - `rejected`        — a real human selected one of the provider's own
 *                         CANONICAL reject options (only `reject_once` /
 *                         `reject_always` kinds; an unknown provider kind
 *                         proves no decision);
 *   - `expired`         — the deadline passed before any decision was made;
 *   - `no_route` / `no_allow_option` / `publish_failed` — the gate could not be
 *                         offered interactively, so the historical declined-gate
 *                         classification (`provider_permission_required`)
 *                         applies exactly as before;
 *   - `cancelled`       — the wait was abandoned before a decision (the turn
 *                         ended, or the bridge was torn down), so a
 *                         `cancelled` turn keeps its existing
 *                         `provider_cancelled` semantics instead of being
 *                         re-labelled as a declined gate.
 *
 * The outcome is DIAGNOSTIC evidence, not a terminal cause: it refines
 * the classification ONLY inside the gate shape the JQ-20261001-25 refinement
 * already requires (`stop_reason=cancelled` + `finish_reason=tool_calls` +
 * the remembered tool-approval gate), where it selects the most precise
 * diagnosis (rejection / expiry / unavailable-route decline). Anywhere else —
 * a proven quota, an explicit refusal or content filter, an unrelated
 * cancellation, an unknown stop reason, or a normal completion — the terminal
 * cause stands unchanged and the token is merely carried alongside it. A turn
 * with no outcome evidence (a legacy/recorded stream, or an unavailable gate
 * the bridge could not prove) classifies exactly as before.
 *
 * The value passed here MUST describe the CURRENT remembered gate: a
 * turn-level summary that still carries an EARLIER gate's cause (rejected >
 * expired > unavailable) would otherwise label this gate with another
 * request's outcome. Callers that track the current gate's own outcome pass
 * it here (the WorkBuddy bridge does, JQ-20261005-57); a caller that has only
 * the turn token and a single remembered gate passes that.
 *
 * `errorDetail` is only the bounded provider terminal error metadata from this
 * ACP prompt response. It is never inferred from task text, assistant output,
 * tool output, or transcript. It affects classification only when the raw stop
 * reason is `refusal` and trusted terminal metadata proves bounded HTTP status
 * `429`; other status codes, numbers embedded in ids/timestamps, and all
 * assistant/tool/transcript text remain ordinary refusal evidence only. The provider may omit the finish reason on that
 * quota path (the observed live shape, JQ-20261002-43): a MISSING/null finish
 * reason therefore still qualifies, while an explicit different finish reason
 * (`content_filter`, `refusal`, ...) keeps its own refusal semantics.
 */
export function classifyAcpStopReason(
  stopReason: string | null | undefined,
  finishReason?: string | null,
  approval?: AcpApprovalEvidence | null,
  gateOutcome?: ApprovalOutcome | null,
  errorDetail?: string | null
): AcpTerminalOutcome {
  const reason = typeof stopReason === "string" ? stopReason.trim() : "";
  if (!reason || reason === ACP_COMPLETED_STOP_REASON) return { ...ACP_COMPLETION_OUTCOME };
  const finish = safeAcpFinishReason(finishReason);
  // The ONE evidence-backed quota exception: trusted terminal metadata proves
  // HTTP status 429 beside stop_reason=refusal. Provider wording is not evidence.
  // NO finish reason on this path (the observed live shape, JQ-20261002-43), so
  // an absent/null finish reason still qualifies; an explicit finish reason
  // other than `tool_calls` (content_filter, refusal, ...) keeps its own
  // refusal semantics untouched. A turn-level approval outcome is DIAGNOSTIC
  // evidence and never outranks this terminal cause: a rejected/expired gate
  // earlier in the same turn does not make a later proven quota a rejection,
  // and the configured fallback must still advance.
  if (
    reason === "refusal" &&
    hasAcpQuotaErrorEvidence(errorDetail) &&
    (finish === null || finish === ACP_FINISH_TOOL_CALLS)
  ) {
    return { ...ACP_RATE_LIMIT_OUTCOME };
  }
  const known = ACP_NON_SUCCESS_STOP_REASONS.get(reason);
  if (known) {
    const outcome = { ...known };
    if (reason === "refusal") {
      if (finish === ACP_FINISH_CONTENT_FILTER) {
        outcome.message =
          "WorkBuddy AI's content filter blocked this response (stop_reason=refusal, finish_reason=content_filter); " +
          "no task result was produced.";
      } else if (finish === ACP_FINISH_REFUSAL) {
        outcome.message =
          "WorkBuddy AI explicitly refused this request (stop_reason=refusal, finish_reason=refusal); " +
          "no task result was produced.";
      }
    }
    // The interactive approval gate is refined ONLY where the existing terminal
    // evidence proves the gate CAUSED the stop: the provider's own
    // `stop_reason=cancelled` + `finish_reason=tool_calls` beside the prompt
    // turn's remembered tool-approval gate (the JQ-20261001-25 shape). Within
    // that proven shape the CURRENT gate's own outcome picks the most precise
    // diagnosis: a real canonical rejection, a proven expiry, or the
    // unavailable-route decline. Everywhere else — an unrelated cancellation,
    // an explicit refusal/content filter, a quota, an unknown stop — the
    // terminal cause stands and the outcome stays diagnostic. The caller must
    // pass the CURRENT gate's outcome, never another request's (JQ-20261005-57).
    if (reason === "cancelled" && approval?.kind === "tool_approval" && finish === ACP_FINISH_TOOL_CALLS) {
      if (gateOutcome === "rejected") return { ...ACP_APPROVAL_REJECTED_OUTCOME };
      if (gateOutcome === "expired") return { ...ACP_APPROVAL_EXPIRED_OUTCOME };
      // An ABANDONED wait is not a declined gate: the turn ended before a
      // decision was ever made, so it keeps the generic cancelled semantics.
      if (gateOutcome !== "cancelled") return { ...ACP_PERMISSION_REQUIRED_OUTCOME };
    }
    return outcome;
  }
  return {
    ...ACP_UNKNOWN_STOP_OUTCOME,
    message:
      `WorkBuddy AI ended the turn with stop_reason=${reason.slice(0, 64)} instead of a normal end_turn completion; ` +
      "the task did not complete."
  };
}

export interface AcpTerminalRecord {
  record: Json;
  /** Bridge process exit code: 0 for a normal completion, else the failure code. */
  exitCode: number;
}

/**
 * The bridge's successful terminal record (unchanged CrewDispatch result shape).
 *
 * `approvalOutcome` (optional) is the prompt turn's most specific PROVEN
 * approval outcome. A completed `end_turn` turn is never re-classified by it,
 * but it IS carried as the record's bounded `approval_outcome`, so a turn that
 * completed after a rejected / expired / unofferable approval still explains
 * that its gated operation did not run. A runtime that proves no outcome
 * produces exactly the historical record.
 */
export function acpSuccessResultRecord(input: {
  sessionId: string;
  model: string;
  stopReason: string | null;
  finalText: string;
  approvalOutcome?: ApprovalOutcome | null;
}): Json {
  return {
    type: "result",
    subtype: "success",
    result: input.finalText || null,
    stop_reason: input.stopReason ?? "end_turn",
    ...(input.approvalOutcome ? { approval_outcome: input.approvalOutcome } : {}),
    session_id: input.sessionId,
    model: input.model,
    is_error: false
  };
}

/**
 * The bridge's classified failure record (unchanged CrewDispatch result shape).
 *
 * `stopReason` (optional) is the provider's OWN terminal reason (`refusal`,
 * ...) and is preserved verbatim in `stop_reason`; when absent the failure
 * code is used. `finalText` (optional) is assistant text the turn actually
 * delivered and is preserved as the record's `result` (null when there was
 * none — never fabricated).
 *
 * `finishReason` (optional) is the provider's more specific cause when the ACP
 * response published one (`_meta["codebuddy.ai/finishReason"]`). Only a
 * bounded, safe token is carried, under the canonical `finish_reason` key;
 * a runtime that omits it produces exactly the historical record.
 *
 * `errorDetail` (optional) is the provider's bounded terminal diagnostic when
 * the ACP response published one (`_meta["codebuddy.ai/errorMessage"]`); only
 * the safe single-line form `safeAcpErrorDetail` accepts is carried, under the
 * canonical `error_detail` key. This record writer does not classify: its
 * caller has already selected the outcome from the provider terminal fields.
 *
 * `approvalOutcome` (optional) is the prompt turn's most specific PROVEN
 * approval outcome, carried under the canonical `approval_outcome` key so the
 * durable result distinguishes a real rejection, an expiry, a missing approval
 * route and an abandoned wait without reading any provider prose.
 */
export function acpErrorResultRecord(input: {
  sessionId: string | null;
  model: string;
  code: string;
  message: string;
  stopReason?: string | null;
  finalText?: string | null;
  finishReason?: string | null;
  errorDetail?: string | null;
  approvalOutcome?: ApprovalOutcome | null;
}): Json {
  const finishReason = safeAcpFinishReason(input.finishReason);
  const errorDetail = safeAcpErrorDetail(input.errorDetail);
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    stop_reason: input.stopReason ?? input.code,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    ...(errorDetail ? { error_detail: errorDetail } : {}),
    ...(input.approvalOutcome ? { approval_outcome: input.approvalOutcome } : {}),
    result: input.finalText || null,
    error: { code: input.code, message: input.message },
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    model: input.model
  };
}

/**
 * The ONE terminal record of a finished ACP prompt turn.
 *
 * A normal `end_turn` completion (optionally with streamed assistant text)
 * keeps the existing success record. Any other stop reason becomes a
 * classified provider failure whose `stop_reason` preserves the provider's
 * own reason and whose `result` preserves whatever assistant text the turn
 * actually delivered (null when there was none — never invented).
 *
 * `finishReason` (optional) is the provider's more specific cause when the ACP
 * response carried one; it refines a refusal's diagnostic and is preserved as
 * the record's bounded `finish_reason`. The success record is untouched — a
 * normal completion never changes shape.
 *
 * `errorDetail` (optional) is the provider's bounded terminal diagnostic when
 * the ACP response carried one (`_meta["codebuddy.ai/errorMessage"]`); it is
 * preserved as the record's bounded `error_detail` on a classified failure
 * only. A normal completion never carries it. The terminal classifier uses a
 * narrowly recognized quota message only alongside a refusal (with
 * `finish_reason=tool_calls` or no finish reason).
 *
 * `approval` (optional, JQ-20261001-25) is the prompt turn's remembered
 * declined tool-approval gate. It ONLY refines a `cancelled` +
 * `finish_reason=tool_calls` turn into `provider_permission_required`; every
 * other turn is classified exactly as before.
 *
 * `approvalOutcome` (optional, JQ-20261001-26 and the approval-interruption
 * follow-up, JQ-20261005-57) is the prompt turn's most specific PROVEN
 * approval outcome: a real selected canonical rejection, a proven expiry, a
 * proven missing/unofferable route, or an abandoned wait. It is the turn-level
 * DIAGNOSTIC summary and is carried on the record's `approval_outcome`
 * (success records included), so a turn that completed after a rejected /
 * expired / unofferable approval still explains that its gated operation did
 * not run. It is used for the terminal classification only when no separate
 * `gateOutcome` is supplied. A runtime that proves no outcome produces exactly
 * the historical record.
 *
 * `gateOutcome` (optional, JQ-20261005-57) is the outcome proven for the
 * CURRENT remembered approval gate, which the classifier uses as the gate's
 * causal value when it is supplied (the WorkBuddy bridge always supplies it,
 * null when the current gate has no proven outcome). This keeps an earlier
 * gate's cause in the turn-level summary from mislabelling a later gate: a
 * rejected-then-expired turn classifies as an expiry, an expired-then-
 * unofferable turn as the declined-gate interruption. Callers without a
 * separate current-gate value omit it and keep the historical behavior.
 */
export function acpTerminalResultRecord(input: {
  sessionId: string;
  model: string;
  stopReason: string | null;
  finalText: string;
  finishReason?: string | null;
  errorDetail?: string | null;
  approval?: AcpApprovalEvidence | null;
  approvalOutcome?: ApprovalOutcome | null;
  gateOutcome?: ApprovalOutcome | null;
}): AcpTerminalRecord {
  // The CURRENT gate's own outcome is the causal value when the caller tracks
  // it (`gateOutcome`, explicit null = the current gate proved nothing); a
  // caller that only has the turn-level token keeps the documented behavior.
  const causalOutcome = input.gateOutcome === undefined ? input.approvalOutcome : input.gateOutcome;
  const outcome = classifyAcpStopReason(
    input.stopReason,
    input.finishReason,
    input.approval,
    causalOutcome,
    input.errorDetail
  );
  if (!outcome.failureKind) return { record: acpSuccessResultRecord(input), exitCode: 0 };
  return {
    record: acpErrorResultRecord({
      sessionId: input.sessionId,
      model: input.model,
      code: outcome.failureKind,
      message: outcome.message ?? outcome.failureKind,
      stopReason: input.stopReason,
      finalText: input.finalText,
      finishReason: input.finishReason,
      errorDetail: input.errorDetail,
      approvalOutcome: input.approvalOutcome
    }),
    exitCode: outcome.exitCode
  };
}
