// acp-normalizer.ts — Command Code ACP -> the EXISTING canonical NDJSON stream.
//
// The bridge does not invent a second stream grammar: it translates the
// installed CLI's own ACP `session/update` notifications and prompt result into
// the canonical records the accepted Command Code parser already folds
// (`src/providers/command-code/stream.ts`), so the shared runner, usage
// projection, telemetry contract and UI need no Command-Code-specific branch.
//
// Translation table (all shapes read from the installed 1.74.0 bundle):
//
//   agent_message_chunk        -> {"type":"event","event":{"type":"text_delta","delta":...}}
//   agent_thought_chunk        -> {"type":"event","event":{"type":"thinking_delta","delta":...}}
//   tool_call                  -> {"type":"event","event":{"type":"tool_queued","toolCallId","toolName"}}
//   usage_update {used,size,cost} -> {"type":"event","event":{"type":"usage","contextUsed",
//                                     "contextWindow","totalCostUsd"}} (gauges latest-wins; the
//                                     SESSION-cumulative USD cost is reconciled to deltas)
//   prompt result usage        -> {"type":"event","event":{"type":"usage","tokensIn","tokensOut",
//                                     "cacheRead","cacheCreation","cacheMiss"}} (ADDITIVE deltas)
//
// TELEMETRY HONESTY (canonical telemetry contract):
//
//   * `_meta.usage` is the TURN's own counters. The top-level `usage` block is
//     the SESSION's cumulative counters and is used ONLY when this attempt
//     created the session empty (`session/new`); on a resumed session the
//     attempt's token counters stay unavailable rather than recounting the
//     loaded history.
//   * `cost.amount` is the session's CUMULATIVE USD estimate. It is reconciled
//     to additive deltas ONLY against a PROVEN pre-prompt baseline: 0 for a
//     session this attempt created empty, or the last cumulative observation
//     seen BEFORE the prompt was sent on a resumed session. Without that
//     proven baseline the ENTIRE attempt's cost stays unavailable — a first
//     post-prompt observation is never adopted as a baseline (that would
//     silently undercount the turn).
//   * A cost reported in any currency other than USD is never emitted as
//     `totalCostUsd`; no conversion is invented.
//   * The ACP surface publishes NO model-request boundary, so the paired decode
//     evidence (`decodeTokens`/`decodeSeconds`) is NOT synthesized here: those
//     metrics stay null under ACP rather than being fabricated from a turn
//     window (Command Code ACP bridge contract).
//   * A warning `notice` event is forwarded by the CLI as a plain message chunk
//     (the ACP server's own translation), so it is rendered as text; the bridge
//     never guesses a refusal from chunk contents.
import { ccAcpPromptUsage, ccAcpUsdCost, type CcAcpPromptUsage } from "./acp-wire";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeText(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v && v.length <= cap ? v : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The text of one ACP content block/array (the CLI sends `{type,text}`). */
function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  const single = asRecord(content);
  if (single) {
    if (single.type === "text" && typeof single.text === "string") return single.text;
    return null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const text = contentText(block);
      if (text != null) parts.push(text);
    }
    return parts.length ? parts.join("") : null;
  }
  return null;
}

export interface CcAcpNormalizerOptions {
  emit: (record: Record<string, unknown>) => void;
  /**
   * True for `session/new` (the session started empty, so the attempt's cost
   * baseline is PROVEN 0). False for a resumed session, whose pre-prompt
   * cumulative cost is unknown until a pre-prompt observation proves it.
   */
  freshSession: boolean;
}

export interface CcAcpNormalizerSummary {
  finalText: string;
  toolCalls: number;
  /** True when the CLI itself reported a user permission denial on a tool. */
  deniedTool: boolean;
}

/** The CLI's own denial text (bundle `tool_denied` translation). */
const CC_ACP_DENIED_TEXT = "Permission denied by the user.";

export class CcAcpNormalizer {
  private readonly emit: (record: Record<string, unknown>) => void;
  private readonly freshSession: boolean;
  private text = "";
  private readonly toolIds = new Set<string>();
  private deniedTool = false;
  /**
   * The attempt's proven cost baseline. 0 for a session this attempt created
   * empty; null on a resumed session until a PRE-prompt observation proves the
   * loaded cumulative cost. While it is null the entire attempt's cost is
   * unavailable: a post-prompt observation is never adopted as a baseline.
   */
  private costBaseline: number | null;
  private lastCostUsd: number | null = null;
  private promptStarted = false;
  private usageEmitted = false;

  constructor(options: CcAcpNormalizerOptions) {
    this.emit = options.emit;
    this.freshSession = options.freshSession;
    // A fresh session's baseline is PROVEN 0 (the session started empty); a
    // resumed session's baseline is UNKNOWN until a pre-prompt observation.
    this.costBaseline = options.freshSession ? 0 : null;
  }

  /**
   * The prompt is about to be sent. Any cost observation after this call is
   * this turn's work and is only reconciled against a baseline proven BEFORE
   * it (the fresh-session 0, or a pre-prompt cumulative observation).
   */
  markPromptStarted(): void {
    this.promptStarted = true;
  }

  /** Translate ONE `session/update` payload (`params.update`). */
  handleUpdate(update: unknown): void {
    const record = asRecord(update);
    if (!record) return;
    const kind = typeof record.sessionUpdate === "string" ? record.sessionUpdate : null;
    if (!kind) return;

    if (kind === "agent_message_chunk") {
      const text = contentText(record.content);
      if (text != null && text.length > 0) {
        this.text += text;
        this.emit({ type: "event", event: { type: "text_delta", delta: text } });
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = contentText(record.content);
      if (text != null && text.length > 0) {
        this.emit({ type: "event", event: { type: "thinking_delta", delta: text } });
      }
      return;
    }
    if (kind === "tool_call") {
      const id = safeText(record.toolCallId, 200);
      const title = safeText(record.title, 200) ?? safeText(record.kind, 64) ?? "tool";
      if (id && !this.toolIds.has(id)) this.toolIds.add(id);
      this.emit({ type: "event", event: { type: "tool_queued", toolCallId: id ?? title, toolName: title } });
      return;
    }
    if (kind === "tool_call_update") {
      // A terminal denial is the CLI's own proven evidence that a permission
      // gate rejected this tool; it refines the terminal classification and is
      // never inferred from arbitrary output.
      if (record.status === "failed") {
        const text = contentText(record.content);
        if (text && text.includes(CC_ACP_DENIED_TEXT)) this.deniedTool = true;
      }
      return;
    }
    if (kind === "usage_update") {
      this.handleUsageUpdate(record);
      return;
    }
    // plan / available_commands_update / current_mode_update /
    // config_option_update / session_info_update carry no canonical metric or
    // content; they are consumed silently rather than counted as unknown.
  }

  private handleUsageUpdate(update: Record<string, unknown>): void {
    const event: Record<string, unknown> = { type: "usage" };
    const used = finiteNumber(update.used);
    if (used != null && used >= 0) event.contextUsed = used;
    const size = finiteNumber(update.size);
    // A 0 window is the runtime's "unresolved" sentinel; the shared parser
    // ignores it too, but it is never emitted as a size claim.
    if (size != null && size > 0) event.contextWindow = size;
    // Only a proven USD amount participates in cost reconciliation; another
    // currency is never relabelled as USD.
    const amount = ccAcpUsdCost(update.cost);
    if (amount != null) {
      if (!this.promptStarted) {
        // A PRE-prompt cumulative observation on a resumed session is the
        // proven baseline this attempt's deltas are measured from. On a fresh
        // session the baseline is already proven 0 and must not be replaced.
        if (!this.freshSession) {
          this.costBaseline = amount;
          this.lastCostUsd = amount;
        }
      } else if (this.costBaseline == null) {
        // The first post-prompt observation is NOT a valid resumed baseline:
        // it already contains this turn's work, so adopting it would undercount
        // the turn. The whole attempt's cost stays unavailable.
      } else if (amount < (this.lastCostUsd ?? this.costBaseline)) {
        // A decreasing cumulative value is a NEW baseline (e.g. a branch
        // switch), never a negative correction to this attempt.
        this.costBaseline = amount;
        this.lastCostUsd = amount;
      } else {
        const delta = amount - (this.lastCostUsd ?? this.costBaseline);
        this.lastCostUsd = amount;
        if (delta > 0) event.totalCostUsd = delta;
      }
    }
    if (Object.keys(event).length > 1) {
      this.emit({ type: "event", event });
    }
  }

  /**
   * Fold the prompt result's own usage into the canonical additive counters.
   * Returns the parsed usage so the bridge can report it; the canonical event
   * carries only fields the CLI actually reported (a missing counter stays
   * absent, never a fabricated 0). The session-cumulative block is only read
   * for a session this attempt created empty; a resumed session without
   * `_meta.usage` leaves the counters unavailable.
   */
  handlePromptResult(result: unknown): CcAcpPromptUsage | null {
    const usage = ccAcpPromptUsage(result, { freshSession: this.freshSession });
    if (!usage) return null;
    const event: Record<string, unknown> = { type: "usage" };
    if (usage.inputTokens != null) event.tokensIn = usage.inputTokens;
    if (usage.outputTokens != null) event.tokensOut = usage.outputTokens;
    if (usage.cacheReadTokens != null) event.cacheRead = usage.cacheReadTokens;
    if (usage.cacheWriteTokens != null) event.cacheCreation = usage.cacheWriteTokens;
    // The shared parser derives cacheMiss the same way for every transport:
    // a verifiable computation from two REPORTED counters.
    if (usage.inputTokens != null && usage.cacheReadTokens != null) {
      event.cacheMiss = Math.max(usage.inputTokens - usage.cacheReadTokens, 0);
    }
    if (Object.keys(event).length > 1) {
      this.usageEmitted = true;
      this.emit({ type: "event", event });
    }
    return usage;
  }

  /** True when at least one canonical usage event was emitted for this attempt. */
  get hasUsage(): boolean {
    return this.usageEmitted;
  }

  summary(): CcAcpNormalizerSummary {
    return { finalText: this.text, toolCalls: this.toolIds.size, deniedTool: this.deniedTool };
  }
}
