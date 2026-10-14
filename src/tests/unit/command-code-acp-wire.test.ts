// command-code-acp-wire.test.ts — the PURE Command Code ACP wire contract.
//
// Every shape asserted here was read from the INSTALLED official CLI bundle
// (`command-code@1.74.0`, dist/cli.mjs createAcpServer module). These are unit
// tests of the translation knowledge; the transport itself is exercised by
// command-code-acp-bridge.test.ts against a scripted in-process ACP server.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CC_ACP_MODE_BY_PERMISSION_MODE,
  CC_ACP_PROTOCOL_VERSION,
  ccAcpModeForPermissionMode,
  ccAcpPromptUsage,
  ccAcpStopReason,
  ccAcpTerminalForStopReason,
  ccAcpUsdCost,
  ccPermissionModeForAcpModeId,
  classifyCcAcpRunError,
  parseCcAcpConfigOptions,
  parseCcAcpModes,
  parseCcAcpModels
} from "../../providers/command-code/acp-wire";
import { EXIT_CODES, FAILURE_PERMISSION, FAILURE_QUOTA_EXHAUSTED, FAILURE_RATE_LIMIT, FAILURE_AUTH } from "../../providers/command-code/capability";

test("the protocol version and the persisted-mode -> native ACP mode map are the CLI's own ids", () => {
  assert.equal(CC_ACP_PROTOCOL_VERSION, 1);
  assert.deepEqual(CC_ACP_MODE_BY_PERMISSION_MODE, {
    standard: "default",
    default: "default",
    plan: "plan",
    "accept-edits": "auto-accept",
    yolo: "bypass",
    "dont-ask": "dont-ask"
  });
  // The ACP mode id IS the CLI's internal permission-mode id.
  assert.equal(ccAcpModeForPermissionMode("  STANDARD "), "default");
  assert.equal(ccAcpModeForPermissionMode("default"), "default", "an already-persisted synonym value still maps to the CLI's own default ACP id");
  assert.equal(ccAcpModeForPermissionMode("accept-edits"), "auto-accept");
  assert.equal(ccAcpModeForPermissionMode("yolo"), "bypass");
  assert.equal(ccAcpModeForPermissionMode("auto"), null, "a mode the CLI never published is never invented");
  assert.equal(ccAcpModeForPermissionMode(null), null);
  assert.equal(ccPermissionModeForAcpModeId("bypass"), "yolo");
  assert.equal(ccPermissionModeForAcpModeId("auto-accept"), "accept-edits");
  assert.equal(ccPermissionModeForAcpModeId("nope"), null);
});

test("session modes are parsed defensively: deduped, bounded, never invented", () => {
  const parsed = parseCcAcpModes({
    modes: {
      currentModeId: "bypass",
      availableModes: [
        { id: "default", name: "Standard" },
        { id: "auto-accept", name: "Accept Edits" },
        { id: "default", name: "duplicate" },
        { id: "", name: "empty" },
        { id: "x".repeat(100), name: "too long" },
        { id: "plan", name: 42 }
      ]
    }
  });
  assert.deepEqual(parsed, {
    currentModeId: "bypass",
    availableModes: [
      { id: "default", name: "Standard" },
      { id: "auto-accept", name: "Accept Edits" },
      { id: "plan", name: null }
    ]
  });
  assert.equal(parseCcAcpModes({}), null);
  assert.equal(parseCcAcpModes(null), null);
  // A malformed list is an empty state, never a fabricated mode.
  assert.deepEqual(parseCcAcpModes({ modes: { availableModes: "nope" } }), { currentModeId: null, availableModes: [] });
});

test("session models are parsed from the CLI's own models block", () => {
  const parsed = parseCcAcpModels({
    models: {
      currentModelId: "deepseek/deepseek-v4-flash",
      availableModels: [
        { modelId: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { modelId: "deepseek/deepseek-v4-flash", name: "dup" },
        { modelId: "inclusionai/ling-3.0-flash-sante:free" }
      ]
    }
  });
  assert.deepEqual(parsed, {
    currentModelId: "deepseek/deepseek-v4-flash",
    availableModels: [
      { modelId: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { modelId: "inclusionai/ling-3.0-flash-sante:free", name: null }
    ]
  });
  assert.equal(parseCcAcpModels({ models: null }), null);
});

test("config options (effort/model select) keep only published values", () => {
  const parsed = parseCcAcpConfigOptions({
    configOptions: [
      {
        id: "effort",
        currentValue: "high",
        options: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "high" }]
      },
      { id: "model", currentValue: "deepseek/deepseek-v4-flash", options: [{ value: "deepseek/deepseek-v4-flash" }] }
    ]
  });
  assert.deepEqual(parsed, [
    { id: "effort", currentValue: "high", values: ["low", "medium", "high"] },
    { id: "model", currentValue: "deepseek/deepseek-v4-flash", values: ["deepseek/deepseek-v4-flash"] }
  ]);
  // The single-option shape of a config_option_update is accepted too.
  assert.deepEqual(parseCcAcpConfigOptions({ id: "effort", currentValue: "default", options: [{ value: "low" }, { value: "high" }] }), [
    { id: "effort", currentValue: "default", values: ["low", "high"] }
  ]);
  assert.deepEqual(parseCcAcpConfigOptions({}), []);
});

test("prompt usage prefers the turn's own counters and only reads the session block on a FRESH session", () => {
  // The CLI publishes BOTH: `usage` is session-accumulated and `_meta.usage` is
  // the turn's own counters. The turn's counters describe exactly this attempt.
  const turn = ccAcpPromptUsage(
    {
      usage: { totalTokens: 9999, inputTokens: 9000, outputTokens: 999, cachedReadTokens: 100, cachedWriteTokens: 0 },
      _meta: { usage: { inputTokens: 1200, outputTokens: 320, cacheReadTokens: 512, cacheWriteTokens: 64 } }
    },
    { freshSession: true }
  );
  assert.deepEqual(turn, { inputTokens: 1200, outputTokens: 320, cacheReadTokens: 512, cacheWriteTokens: 64, source: "turn" });
  // A session this attempt created EMPTY: the cumulative block is this
  // attempt's own counters.
  const freshSession = ccAcpPromptUsage(
    { usage: { totalTokens: 9999, inputTokens: 9000, outputTokens: 999, cachedReadTokens: 100, cachedWriteTokens: 0 } },
    { freshSession: true }
  );
  assert.deepEqual(freshSession, {
    inputTokens: 9000,
    outputTokens: 999,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    source: "session-fresh"
  });
  // A RESUMED session's cumulative block carries earlier generations: without
  // `_meta.usage` the attempt's counters stay unavailable rather than
  // recounting the loaded history.
  assert.equal(
    ccAcpPromptUsage(
      { usage: { totalTokens: 58668, inputTokens: 58668, outputTokens: 200, cachedReadTokens: 40000 } },
      { freshSession: false }
    ),
    null
  );
  // `_meta.usage` is still attempt-local on a resumed session.
  assert.deepEqual(
    ccAcpPromptUsage({ usage: { inputTokens: 58668 }, _meta: { usage: { inputTokens: 19677 } } }, { freshSession: false }),
    { inputTokens: 19677, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, source: "turn" }
  );
  // Missing counters stay null — never a fabricated 0.
  assert.deepEqual(ccAcpPromptUsage({ _meta: { usage: { outputTokens: 7 } } }, { freshSession: true }), {
    inputTokens: null,
    outputTokens: 7,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    source: "turn"
  });
  // No usage at all is null, and a negative/NaN counter is never a measurement.
  assert.equal(ccAcpPromptUsage({ stopReason: "end_turn" }, { freshSession: true }), null);
  assert.equal(ccAcpPromptUsage({ _meta: { usage: { inputTokens: -1 } } }, { freshSession: true }), null);
});

test("cost amounts are only read as USD; any other currency stays unavailable", () => {
  assert.equal(ccAcpUsdCost({ amount: 1.25, currency: "USD" }), 1.25);
  assert.equal(ccAcpUsdCost({ amount: 1.25, currency: "usd" }), 1.25);
  assert.equal(ccAcpUsdCost({ amount: 1.25, currency: "EUR" }), null, "a non-USD amount is never relabelled");
  assert.equal(ccAcpUsdCost({ amount: 1.25 }), null, "an unreported currency is not proof of USD");
  assert.equal(ccAcpUsdCost({ amount: -1, currency: "USD" }), null);
  assert.equal(ccAcpUsdCost(null), null);
});

test("stop reasons map onto the CLI's OWN exit classification; unknown is never success", () => {
  assert.equal(ccAcpStopReason({ stopReason: "end_turn" }), "end_turn");
  assert.equal(ccAcpStopReason({}), null);
  assert.deepEqual(ccAcpTerminalForStopReason("end_turn"), { kind: "success", exitCode: EXIT_CODES.SUCCESS, stopReason: "end_turn" });
  assert.deepEqual(ccAcpTerminalForStopReason("max_turn_requests"), { kind: "max_turns", exitCode: EXIT_CODES.MAX_TURNS, stopReason: "max_turn_requests" });
  assert.deepEqual(ccAcpTerminalForStopReason("cancelled"), { kind: "cancelled", exitCode: EXIT_CODES.INTERRUPTED, stopReason: "cancelled" });
  // A completed RPC with no/unknown stop reason is an honest error, never a
  // guessed success (the plan's row 21/22 class).
  assert.deepEqual(ccAcpTerminalForStopReason(null), { kind: "error", exitCode: 1, stopReason: "missing_stop_reason" });
  assert.deepEqual(ccAcpTerminalForStopReason(""), { kind: "error", exitCode: 1, stopReason: "missing_stop_reason" });
  assert.deepEqual(ccAcpTerminalForStopReason("something_new"), { kind: "error", exitCode: 1, stopReason: "something_new" });
});

test("run errors are classified ONLY from the CLI's proven structured shapes", () => {
  // The ONE fallback-eligible class: the CLI's own structured rate limit.
  assert.deepEqual(classifyCcAcpRunError({ data: { code: "RATE_LIMITED" } }), {
    exitCode: EXIT_CODES.RATE_LIMIT,
    failureKind: FAILURE_RATE_LIMIT,
    reason: "model rate limit reached"
  });
  assert.deepEqual(classifyCcAcpRunError({ data: { status: 429, code: "SOMETHING" } }), {
    exitCode: EXIT_CODES.RATE_LIMIT,
    failureKind: FAILURE_RATE_LIMIT,
    reason: "model rate limit reached"
  });
  // Credits / spend cap are NOT rate limits.
  assert.equal(classifyCcAcpRunError({ message: "insufficient credits to run this model" }).exitCode, EXIT_CODES.INSUFFICIENT_CREDITS);
  assert.equal(classifyCcAcpRunError({ data: { code: "PREMIUM_CREDITS_EXHAUSTED" } }).failureKind, FAILURE_QUOTA_EXHAUSTED);
  assert.deepEqual(classifyCcAcpRunError({ data: { code: "USAGE_EXCEEDED" } }), {
    exitCode: EXIT_CODES.PERMISSION,
    failureKind: FAILURE_PERMISSION,
    reason: "spend limit reached"
  });
  // Auth.
  assert.equal(classifyCcAcpRunError({ data: { status: 401 } }).failureKind, FAILURE_AUTH);
  assert.equal(classifyCcAcpRunError({ data: { status: 403 } }).failureKind, FAILURE_AUTH);
  assert.equal(classifyCcAcpRunError({ data: { code: "AUTH_REQUIRED" } }).exitCode, EXIT_CODES.AUTH);
  // Generic permission text the CLI's own classifier matches.
  assert.equal(classifyCcAcpRunError({ message: "Permission denied by the provider" }).exitCode, EXIT_CODES.PERMISSION);
  // Server / network / unknown.
  assert.equal(classifyCcAcpRunError({ data: { status: 503 } }).exitCode, EXIT_CODES.SERVER);
  assert.equal(classifyCcAcpRunError({ data: { code: "SERVER_ERROR" } }).exitCode, EXIT_CODES.SERVER);
  assert.equal(classifyCcAcpRunError({ data: { code: "ECONNRESET" } }).exitCode, EXIT_CODES.NETWORK);
  assert.equal(classifyCcAcpRunError({ message: "unable to connect to the model service" }).exitCode, EXIT_CODES.NETWORK);
  assert.deepEqual(classifyCcAcpRunError({ message: "the model produced garbage" }), {
    exitCode: 1,
    failureKind: null,
    reason: "run failed"
  });
});

test("a prose error that merely MENTIONS 429/quota is never a rate limit", () => {
  // Plan pitfall rows 29/30: WB's observed quota regex is not automatically a CC
  // rule. The rate-limit class requires the CLI's own structured evidence
  // (`code:"RATE_LIMITED"` or `status:429`) — never a number that appears in
  // free text. (Assistant text never reaches this classifier at all: it is only
  // ever called on a session/prompt JSON-RPC error, and the bridge test proves
  // an answer containing "429" still completes as a normal turn.)
  assert.deepEqual(classifyCcAcpRunError({ message: "The upstream returned HTTP 429 Too Many Requests" }), {
    exitCode: 1,
    failureKind: null,
    reason: "run failed"
  });
  assert.equal(classifyCcAcpRunError({ data: { code: "MODEL_TEXT", status: 200 }, message: "429 quota exceeded" }).exitCode, 1);
  assert.equal(classifyCcAcpRunError({ data: { status: 200, code: "UNKNOWN" }, message: "rate limit" }).exitCode, 1);
});
