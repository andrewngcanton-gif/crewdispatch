// acp-wire.ts — the Command Code ACP wire contract, read from the INSTALLED
// official CLI bundle (`command-code@1.74.0`, `dist/cli.mjs`, the
// `createAcpServer` module) and kept here as pure, testable knowledge.
//
// Everything in this module is a documented fact about the installed CLI's own
// ACP server, not an inference from field names:
//
//   * methods: initialize, authenticate, session/new, session/load,
//     session/resume, session/list, session/close, session/set_mode,
//     session/set_config_option, session/set_model, session/prompt,
//     session/cancel (a NOTIFICATION), session/update (a notification),
//     session/request_permission (a server -> client request);
//   * framing: one JSON-RPC 2.0 object per `\n`-terminated NDJSON line;
//   * session modes: `default` (Standard), `auto-accept` (Accept Edits),
//     `plan`, `dont-ask`, `bypass` (Bypass Permissions). The ACP mode id IS the
//     CLI's internal permission-mode id (`permissionModeForAcpModeId` returns
//     the id itself), so the mapping from CrewDispatch's persisted
//     `--permission-mode` vocabulary is explicit below;
//   * config options: `{id:"model"|"effort", type:"select", currentValue,
//     options:[{value,name}]}`. Effort is PER MODEL; a model without reasoning
//     levels publishes NO effort option at all, and `session/set_config_option`
//     then fails with METHOD_NOT_FOUND. `currentEffort` is the model's own
//     default when it declares one, else the literal token `"default"`, and
//     `"default"` can never be re-selected once an effort is set;
//   * prompt result: `{stopReason, usage?, _meta?}` where `usage` is the
//     session's accumulated `{totalTokens,inputTokens,outputTokens,
//     cachedReadTokens,cachedWriteTokens}` and `_meta.usage` is the TURN's own
//     `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}` (published
//     only when the turn's total is > 0). The session block is CUMULATIVE: on
//     a resumed session it contains earlier generations and may only be read
//     on a session this attempt created empty (see `ccAcpPromptUsage`);
//   * `usage_update` notification: `{used,size,cost?}` where `cost.amount` is
//     the SESSION's cumulative USD cost (`getSessionStats().costUsd`) and
//     `used`/`size` are the context gauges;
//   * a failed run arrives as a JSON-RPC error `-32603` whose `data` carries
//     the underlying error's `{status, code}`; the proven classifier shapes are
//     mirrored from the CLI's own print-mode classifier;
//   * stop reasons map to the CLI's own exit codes: `end_turn` -> 0,
//     `max_turn_requests` -> 8 (the resumable segment boundary), `cancelled`
//     -> 130.
import { EXIT_CODES, FAILURE_AUTH, FAILURE_PERMISSION, FAILURE_QUOTA_EXHAUSTED, FAILURE_RATE_LIMIT } from "./capability";

/** The ACP protocol version this CLI advertises (`cn = 1` in the bundle). */
export const CC_ACP_PROTOCOL_VERSION = 1;

export const CC_ACP_METHODS = Object.freeze({
  INITIALIZE: "initialize",
  AUTHENTICATE: "authenticate",
  SESSION_NEW: "session/new",
  SESSION_LOAD: "session/load",
  SESSION_RESUME: "session/resume",
  SESSION_LIST: "session/list",
  SESSION_CLOSE: "session/close",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_SET_MODE: "session/set_mode",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_SET_CONFIG_OPTION: "session/set_config_option",
  SESSION_UPDATE: "session/update",
  SESSION_REQUEST_PERMISSION: "session/request_permission"
});

export const CC_ACP_JSONRPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000
});

/**
 * CrewDispatch's persisted `--permission-mode` vocabulary -> the ACP mode ids
 * the installed CLI's own ACP server publishes. The ACP ids are the CLI's
 * internal permission-mode ids (proven by `permissionModeForAcpModeId`), and
 * their published display names match the product semantics one-to-one:
 * Standard/`default`, Accept Edits/`auto-accept`, Plan/`plan`,
 * Don't Ask/`dont-ask`, Bypass Permissions/`bypass`.
 *
 * The PUBLIC canonical mode is `standard`; `normalizePermissionMode` resolves
 * the documented input synonym `default` to `standard` at the provider
 * boundary BEFORE this map is consulted, so a run never launches with a
 * different mode than the canonical one. The `default` KEY is retained only so
 * an already-persisted job/config value (or a direct caller) still maps to the
 * CLI's own native `default` ACP mode id — it is the same Standard mode, never
 * a separate or broader permission.
 */
export const CC_ACP_MODE_BY_PERMISSION_MODE: Readonly<Record<string, string>> = Object.freeze({
  standard: "default",
  default: "default",
  plan: "plan",
  "accept-edits": "auto-accept",
  yolo: "bypass",
  "dont-ask": "dont-ask"
});

/** The ACP mode id for one persisted permission mode, or null when unmapped. */
export function ccAcpModeForPermissionMode(mode: unknown): string | null {
  if (typeof mode !== "string") return null;
  return CC_ACP_MODE_BY_PERMISSION_MODE[mode.trim().toLowerCase()] ?? null;
}

/** The persisted permission mode an ACP mode id corresponds to, or null. */
export function ccPermissionModeForAcpModeId(modeId: unknown): string | null {
  if (typeof modeId !== "string") return null;
  const id = modeId.trim().toLowerCase();
  for (const [mode, acpId] of Object.entries(CC_ACP_MODE_BY_PERMISSION_MODE)) {
    if (acpId === id) return mode;
  }
  return null;
}

export interface CcAcpModeEntry {
  id: string;
  name: string | null;
}

export interface CcAcpModesState {
  currentModeId: string | null;
  availableModes: CcAcpModeEntry[];
}

export interface CcAcpModelEntry {
  modelId: string;
  name: string | null;
}

export interface CcAcpModelsState {
  currentModelId: string | null;
  availableModels: CcAcpModelEntry[];
}

export interface CcAcpConfigOptionState {
  id: string;
  currentValue: string | null;
  values: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeToken(value: unknown, cap = 200): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v && v.length <= cap ? v : null;
}

/** Read the `modes` block of a session state result (session/new|load|resume). */
export function parseCcAcpModes(result: unknown): CcAcpModesState | null {
  const modes = asRecord(asRecord(result)?.modes);
  if (!modes) return null;
  const listed = Array.isArray(modes.availableModes) ? modes.availableModes : [];
  const availableModes: CcAcpModeEntry[] = [];
  for (const raw of listed) {
    const entry = asRecord(raw);
    const id = safeToken(entry?.id, 64);
    if (!id || availableModes.some((m) => m.id === id)) continue;
    availableModes.push({ id, name: safeToken(entry?.name, 120) });
  }
  return { currentModeId: safeToken(modes.currentModeId, 64), availableModes };
}

/** Read the `models` block of a session state result. */
export function parseCcAcpModels(result: unknown): CcAcpModelsState | null {
  const models = asRecord(asRecord(result)?.models);
  if (!models) return null;
  const listed = Array.isArray(models.availableModels) ? models.availableModels : [];
  const availableModels: CcAcpModelEntry[] = [];
  for (const raw of listed) {
    const entry = asRecord(raw);
    const modelId = safeToken(entry?.modelId, 200);
    if (!modelId || availableModels.some((m) => m.modelId === modelId)) continue;
    availableModels.push({ modelId, name: safeToken(entry?.name, 120) });
  }
  return { currentModelId: safeToken(models.currentModelId, 200), availableModels };
}

/** Read the `configOptions` array of a session state result (or update). */
export function parseCcAcpConfigOptions(result: unknown): CcAcpConfigOptionState[] {
  const record = asRecord(result);
  const listed = Array.isArray(record?.configOptions)
    ? record.configOptions
    : Array.isArray(record?.options) && typeof record?.id === "string"
      ? [record]
      : [];
  const out: CcAcpConfigOptionState[] = [];
  for (const raw of listed) {
    const entry = asRecord(raw);
    const id = safeToken(entry?.id, 64);
    if (!id || out.some((o) => o.id === id)) continue;
    const values: string[] = [];
    for (const option of Array.isArray(entry?.options) ? entry.options : []) {
      const value = safeToken(asRecord(option)?.value, 120);
      if (value && !values.includes(value)) values.push(value);
    }
    out.push({ id, currentValue: safeToken(entry?.currentValue, 120), values });
  }
  return out;
}

export interface CcAcpPromptUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /**
   * `turn` = `_meta.usage` (the turn's own counters, always attempt-local);
   * `session-fresh` = the top-level `usage` block on a session this attempt
   * CREATED with `session/new` (the session started empty, so its cumulative
   * counters are this attempt's own).
   */
  source: "turn" | "session-fresh";
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageFrom(record: Record<string, unknown> | null): Omit<CcAcpPromptUsage, "source"> | null {
  if (!record) return null;
  const inputTokens = nonNegativeNumber(record.inputTokens);
  const outputTokens = nonNegativeNumber(record.outputTokens);
  // The CLI publishes the SESSION block's cache counters as `cachedReadTokens`/
  // `cachedWriteTokens` and the TURN block's as `cacheReadTokens`/
  // `cacheWriteTokens` (both verified in the installed bundle). Either spelling
  // is a real reported counter; neither is invented.
  const cacheReadTokens = nonNegativeNumber(record.cacheReadTokens) ?? nonNegativeNumber(record.cachedReadTokens);
  const cacheWriteTokens = nonNegativeNumber(record.cacheWriteTokens) ?? nonNegativeNumber(record.cachedWriteTokens);
  if (inputTokens == null && outputTokens == null && cacheReadTokens == null && cacheWriteTokens == null) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/**
 * The attempt's own token counters from a prompt result.
 *
 * `_meta.usage` (the turn's counters) is preferred: it describes exactly the
 * turn this attempt ran, so a resumed session can never leak an earlier
 * generation's counters into this attempt.
 *
 * The top-level `usage` block is the SESSION's CUMULATIVE counters, and a
 * bridge process serving one prompt does NOT make it attempt-local: a resumed
 * session carries the history it was loaded with. It may therefore only be
 * used when the session was CREATED empty by this attempt (`freshSession`),
 * where its cumulative value is provably this attempt's own. On a resumed
 * session without `_meta.usage` the counters stay UNAVAILABLE (null) — a
 * partial subtraction from an unknown historical baseline would be invented
 * telemetry.
 */
export function ccAcpPromptUsage(result: unknown, options: { freshSession: boolean }): CcAcpPromptUsage | null {
  const record = asRecord(result);
  if (!record) return null;
  const meta = asRecord(record._meta);
  const turn = usageFrom(asRecord(meta?.usage));
  if (turn) return { ...turn, source: "turn" };
  if (!options.freshSession) return null;
  const session = usageFrom(asRecord(record.usage));
  if (session) return { ...session, source: "session-fresh" };
  return null;
}

/**
 * The session-cumulative USD amount of one `usage_update`, or null when the
 * report is not a proven USD amount. The canonical additive field is
 * `totalCostUsd`: an amount reported in any other currency (or with no proven
 * currency at all) can never be presented as USD, and no conversion is
 * invented, so it stays unavailable.
 */
export function ccAcpUsdCost(cost: unknown): number | null {
  const record = asRecord(cost);
  const amount = nonNegativeNumber(record?.amount);
  if (amount == null) return null;
  if (typeof record?.currency !== "string" || record.currency.trim().toUpperCase() !== "USD") return null;
  return amount;
}

/** The prompt result's `stopReason`, when the CLI published one. */
export function ccAcpStopReason(result: unknown): string | null {
  return safeToken(asRecord(result)?.stopReason, 64);
}

export type CcAcpTerminalKind = "success" | "max_turns" | "cancelled" | "error";

export interface CcAcpTerminalOutcome {
  kind: CcAcpTerminalKind;
  /** The official CLI exit code this outcome is classified with. */
  exitCode: number;
  stopReason: string;
}

/**
 * Map a prompt result's stop reason onto the CLI's OWN documented exit-code
 * classification. The mapping is the bundle's own `acpStopReasonFor` inverse:
 * `end_turn` (which includes `permission_denied`, `terminate` and `stop_hook`)
 * is a completed turn; `max_turns` is the CLI's resumable segment boundary
 * (exit 8); `interrupted` is a user cancellation (exit 130).
 */
export function ccAcpTerminalForStopReason(stopReason: string | null): CcAcpTerminalOutcome {
  const reason = typeof stopReason === "string" && stopReason.trim() ? stopReason : null;
  if (reason === "max_turn_requests") {
    return { kind: "max_turns", exitCode: EXIT_CODES.MAX_TURNS, stopReason: reason };
  }
  if (reason === "cancelled") {
    return { kind: "cancelled", exitCode: EXIT_CODES.INTERRUPTED, stopReason: reason };
  }
  if (reason === "end_turn") {
    return { kind: "success", exitCode: EXIT_CODES.SUCCESS, stopReason: reason };
  }
  // A missing or unknown stop reason is NOT silently treated as success: the
  // turn ended without a completion the CLI documents, so it is an honest
  // generic error, never a guessed success.
  return { kind: "error", exitCode: 1, stopReason: reason ?? "missing_stop_reason" };
}

export interface CcAcpRunErrorClassification {
  exitCode: number;
  failureKind: string | null;
  /** Bounded, display-safe reason text (never raw provider output). */
  reason: string;
}

/**
 * Classify a failed run (`session/prompt` JSON-RPC error -32603 with
 * `data:{status,code}`), mirroring ONLY the shapes the CLI's own print-mode
 * classifier proves:
 *
 *   - `code === "RATE_LIMITED"` or `status === 429` -> the official rate-limit
 *     exit code (5). This is the ONE class eligible for the frozen fallback
 *     chain, and it is never inferred from free text;
 *   - "insufficient credits" / `PREMIUM_CREDITS_EXHAUSTED` -> quota exhausted
 *     (10, fatal) — never a rate limit;
 *   - the spend-cap code `USAGE_EXCEEDED` -> permission denied (4), exactly as
 *     the CLI's print classifier maps a spend cap;
 *   - `status` 401/403 or the auth-required JSON-RPC code -> auth (3);
 *   - the generic permission patterns the CLI's print classifier matches ->
 *     permission (4);
 *   - `status` >= 500 or a server code -> server (7);
 *   - a connection/network code -> network (6);
 *   - anything else -> the generic error code 1, never a fabricated class.
 */
export function classifyCcAcpRunError(input: { data?: unknown; message?: unknown }): CcAcpRunErrorClassification {
  const data = asRecord(input.data);
  const code = safeToken(data?.code, 120);
  const status = typeof data?.status === "number" && Number.isFinite(data.status) ? data.status : null;
  const message = typeof input.message === "string" ? input.message : "";
  const lower = message.toLowerCase();

  if (code === "RATE_LIMITED" || status === 429) {
    return { exitCode: EXIT_CODES.RATE_LIMIT, failureKind: FAILURE_RATE_LIMIT, reason: "model rate limit reached" };
  }
  if (lower.includes("insufficient credits") || code === "PREMIUM_CREDITS_EXHAUSTED") {
    return { exitCode: EXIT_CODES.INSUFFICIENT_CREDITS, failureKind: FAILURE_QUOTA_EXHAUSTED, reason: "insufficient credits" };
  }
  if (code === "USAGE_EXCEEDED") {
    return { exitCode: EXIT_CODES.PERMISSION, failureKind: FAILURE_PERMISSION, reason: "spend limit reached" };
  }
  if (status === 401 || status === 403 || code === "AUTH_REQUIRED" || code === "AUTHENTICATION") {
    return { exitCode: EXIT_CODES.AUTH, failureKind: FAILURE_AUTH, reason: "authentication failed" };
  }
  if (/permission denied|access denied|not permitted|unauthorized/i.test(message)) {
    return { exitCode: EXIT_CODES.PERMISSION, failureKind: FAILURE_PERMISSION, reason: "permission denied" };
  }
  if ((status != null && status >= 500) || code === "SERVER_ERROR") {
    return { exitCode: EXIT_CODES.SERVER, failureKind: null, reason: "server error" };
  }
  if (/connection|network|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(code ?? "") || /unable to connect|network connection/i.test(message)) {
    return { exitCode: EXIT_CODES.NETWORK, failureKind: null, reason: "connection error" };
  }
  return { exitCode: 1, failureKind: null, reason: "run failed" };
}

/** The CLI's own no-response warning text (bundle `YT`), reused verbatim. */
export const CC_ACP_NO_RESPONSE_TEXT =
  "Warning: The model produced no response (continuation budget exhausted). Retry, or try a different model.";

/** The CLI's own user-interrupt text (bundle `IS`). */
export const CC_ACP_INTERRUPTED_TEXT = "Interrupted by user";
