// dsh-session-stats.ts — the PURE REFERENCE FOLD of the official
// deepseek-harness `sessionStats` projection, ported one-for-one from
// `@deepseek-ai/dsh-session-stats/lib/types/projection.js` (the installed
// 2026-10-01 build) and `isTokenDelta` from
// `@deepseek-ai/dsh-llm/lib/types/message.js`.
//
// Tests fold a sanitized real-shape fixture with THIS implementation and
// compare the production parser's paired totals against it. It is
// deliberately independent of CrewDispatch production code: if production drifts
// from the official semantics, these tests fail instead of agreeing with
// themselves.

/** One durable dsh session event (the subset the fold consumes). */
export interface DshSessionEvent {
  type: string;
  time: number;
  data: {
    turn: number;
    step: number;
    chunk?: unknown;
    usage?: { outputTokens?: number } | null;
    callId?: string;
    message?: { source?: { callId?: string } };
  };
}

/** Official `isTokenDelta`: non-empty text/reasoning delta, or any tool-call delta. */
export function isDshTokenDelta(chunk: unknown): boolean {
  if (!chunk || typeof chunk !== "object") return false;
  const c = chunk as { type?: string; text?: unknown; argumentsDelta?: unknown; name?: unknown };
  switch (c.type) {
    case "text-delta":
    case "reasoning-delta":
      return c.text !== "";
    case "tool-call-delta":
      return c.argumentsDelta !== "" || c.name !== undefined;
    default:
      return false;
  }
}

export interface DshSessionStats {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
}

/** Official `usageOutputTokens` guard. */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const value = (usage as { outputTokens?: unknown }).outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The official `sessionStats` fold: step boundaries, stream chunks, tool pairs
 * and assembled assistant messages into whole-log counts and wall times. A
 * step contributes decode time (`messageTime − firstTokenTime`) and tokens
 * ONLY when it recorded a first token AND its assembled message reported
 * output tokens; a cancelled step that never assembles contributes nothing.
 * The session rate is `decodeTokens / decodeMs` — a ratio of sums.
 */
export function foldDshSessionStats(events: readonly DshSessionEvent[]): DshSessionStats {
  const state: DshSessionStats & {
    lastTurn: number | null;
    openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null;
    pendingCalls: Record<string, number>;
  } = {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    lastTurn: null,
    openStep: null,
    pendingCalls: {}
  };
  for (const event of events) {
    switch (event.type) {
      case "step/start":
        state.openStep = { turn: event.data.turn, step: event.data.step, startTime: event.time, firstTokenTime: null };
        break;
      case "assistant/chunk": {
        const open = state.openStep;
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) break;
        if (open.firstTokenTime !== null || !isDshTokenDelta(event.data.chunk)) break;
        open.firstTokenTime = event.time;
        break;
      }
      case "assistant/message": {
        const open = state.openStep;
        if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) break;
        state.llmMs += Math.max(0, event.time - open.startTime);
        state.openStep = null;
        if (open.firstTokenTime !== null) {
          state.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
          state.ttftSteps += 1;
          const outputTokens = usageOutputTokens(event.data.usage);
          if (outputTokens !== null) {
            state.decodeMs += Math.max(0, event.time - open.firstTokenTime);
            state.decodeTokens += outputTokens;
          }
        }
        break;
      }
      case "tool/call":
        state.pendingCalls[String(event.data.callId)] = event.time;
        break;
      case "tool/result": {
        const callId = event.data.message?.source?.callId;
        if (callId == null) break;
        const dispatched = state.pendingCalls[callId];
        if (dispatched === undefined) break;
        state.toolMs += Math.max(0, event.time - dispatched);
        delete state.pendingCalls[callId];
        break;
      }
      case "step/end":
        state.turns = state.lastTurn === event.data.turn ? state.turns : state.turns + 1;
        state.steps += 1;
        state.lastTurn = event.data.turn;
        state.openStep = null;
        break;
      case "turn/end":
        if (Object.keys(state.pendingCalls).length !== 0) state.pendingCalls = {};
        break;
      default:
        break;
    }
  }
  return {
    turns: state.turns,
    steps: state.steps,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    ttftMs: state.ttftMs,
    ttftSteps: state.ttftSteps,
    decodeMs: state.decodeMs,
    decodeTokens: state.decodeTokens
  };
}
