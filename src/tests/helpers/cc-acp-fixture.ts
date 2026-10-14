// cc-acp-fixture.ts — ONE controlled fake `cmdc` used by the Command Code
// integration tests that exercise the REAL production ACP entry.
//
// The production `command-code` provider no longer launches `cmdc -p ...`: its
// run plan launches the CrewDispatch ACP bridge, which spawns the resolved CLI
// as `cmdc acp` and speaks the installed CLI's own ACP protocol over stdio
// (see src/providers/command-code/acp-bridge.ts). A print-mode fixture can no
// longer stand in for that transport, so these tests drive a fixture that
// answers the PUBLIC probes AND behaves as the installed CLI's ACP server.
//
// The fixture is a real separate child process (Node behind a `.cmd` shim on
// Windows), so the whole production chain is exercised for real: the built MCP
// entry -> daemon -> detached worker -> REAL ACP bridge -> this fixture. Only
// the CLI process itself is scripted.
//
// Determinism: every behavior is selected by an ENVIRONMENT variable, so the
// same fixture serves every case without per-test code:
//   * `FAKE_CLI_LOG`        JSONL path every protocol event is appended to.
//   * `FAKE_SUCCESS_MODEL`  when SET, the named model completes a turn; every
//                           other model answers a structured RATE_LIMITED error
//                           (the ONE fallback-eligible class). An empty string
//                           therefore makes EVERY model rate-limit. When the
//                           variable is UNSET, every model succeeds.
//   * `FAKE_MODE=hang`      accept the prompt and never answer (cancel test).
//   * `FAKE_MODE=fatal`     answer a JSON-RPC error whose shape is derived from
//                           `fatal <n>` in the prompt: 3 auth, 4 permission,
//                           10 insufficient credits, anything else unknown.
//   * `FAKE_EXIT`           the fatal code when the prompt carries none.
import fs from "node:fs";
import path from "node:path";

export interface CcAcpFixtureOptions {
  /** The ordered model catalog the CLI publishes (first is the default). */
  models: readonly string[];
  /** The `--list-models` default marker model; defaults to the first model. */
  defaultModel?: string;
  /** The effort levels this fixture publishes for every model. */
  effortValues?: readonly string[];
  /**
   * The model's initial effort when a session is fresh/attached. `"default"`
   * (the default) publishes `default` as a selectable value; any CONCRETE level
   * (e.g. `"medium"`) models the installed CLI resolving the model default to a
   * real value and NOT offering `default` as a selectable option.
   */
  defaultEffort?: string;
  /** The session id `session/new` returns (and `resume` is expected to reuse). */
  sessionId?: string;
}

export interface CcAcpFixture {
  /** The resolved CLI path (a `.cmd` shim on Windows, a sh shim elsewhere). */
  shim: string;
  /** The generated Node script path. */
  script: string;
}

export const CC_ACP_DEFAULT_SESSION = "fake-session-acp";
export const CC_ACP_DEFAULT_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** One recorded protocol event (every entry also carries the CLI's `cwd`). */
export interface CcAcpLogEntry {
  cwd: string;
  kind: "new" | "resume" | "load" | "model" | "effort" | "mode" | "prompt" | "close";
  value?: string;
  text?: string;
  model?: string;
  mode?: string;
  sessionId?: string;
  /** The model's effective reasoning effort when the prompt was issued. */
  effortValue?: string;
}

/** Write the fixture into `dir` and return the resolved CLI path. */
export function writeCcAcpCmdcFixture(dir: string, options: CcAcpFixtureOptions): CcAcpFixture {
  const models = [...options.models];
  const defaultModel = options.defaultModel ?? models[0] ?? "fake/model-a";
  const effortValues = [...(options.effortValues ?? CC_ACP_DEFAULT_EFFORT_VALUES)];
  const defaultEffort = options.defaultEffort ?? "default";
  const sessionId = options.sessionId ?? CC_ACP_DEFAULT_SESSION;

  const script = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const mode = argv[0];
const MODELS = ${JSON.stringify(models)};
const DEFAULT_MODEL = ${JSON.stringify(defaultModel)};
const EFFORT_VALUES = ${JSON.stringify(effortValues)};
const DEFAULT_EFFORT = ${JSON.stringify(defaultEffort)};
const FIXTURE_SESSION = ${JSON.stringify(sessionId)};
const MODES = [
  { id: "default", name: "Standard" },
  { id: "auto-accept", name: "Accept Edits" },
  { id: "plan", name: "Plan" },
  { id: "dont-ask", name: "Don't Ask" },
  { id: "bypass", name: "Bypass Permissions" }
];
const LOG = process.env.FAKE_CLI_LOG || path.join(process.cwd(), ".fake-cmdc-acp-log.jsonl");
function logEvent(event) {
  try { fs.appendFileSync(LOG, JSON.stringify(Object.assign({ cwd: process.cwd() }, event)) + "\\n"); } catch (e) {}
}
function write(text) { process.stdout.write(text); }

if (mode === "--version") { write("9.9.9-fake\\n"); process.exit(0); }
if (mode === "--help") {
  write([
    "Usage: cmdc [options] [prompt]",
    "  --model <id>              Model id",
    "  --permission-mode <mode>  Set permission mode (standard, plan, accept-edits, yolo)",
    "  --effort <level>          Reasoning effort (minimal, low, medium, high)",
    ""
  ].join("\\n"));
  process.exit(0);
}
if (mode === "--list-models") {
  const lines = ["Available models \u00b7 " + MODELS.length + " models", ""];
  MODELS.forEach(function (model) {
    lines.push(model + "   Fake model" + (model === DEFAULT_MODEL ? " (default)" : ""));
  });
  write(lines.join("\\n") + "\\n");
  process.exit(0);
}
if (mode !== "acp") { process.stderr.write("unsupported argv: " + argv.join(" ") + "\\n"); process.exit(2); }

// ---- ACP server ----
let currentModel = DEFAULT_MODEL;
let currentMode = "default";
const effortByModel = {};
function effortState() {
  if (!effortByModel[currentModel]) {
    // A model-default request can be RESOLVED to a concrete level (the installed
    // 1.74.1 reports "medium" for stealth/space-bunny-alpha); when the fixture is
    // configured with a concrete initial effort, "default" is not selectable,
    // mirroring the real CLI. Otherwise "default" is the initial selectable value.
    effortByModel[currentModel] = DEFAULT_EFFORT === "default"
      ? { current: "default", values: ["default"].concat(EFFORT_VALUES) }
      : { current: DEFAULT_EFFORT, values: EFFORT_VALUES.slice() };
  }
  return effortByModel[currentModel];
}
function configOptions() {
  const eff = effortState();
  return [
    { id: "model", category: "model", type: "select", currentValue: currentModel,
      options: MODELS.map(function (m) { return { value: m }; }) },
    { id: "effort", category: "thought_level", type: "select", currentValue: eff.current,
      options: eff.values.map(function (v) { return { value: v }; }) }
  ];
}
function attachState() {
  return {
    sessionId: FIXTURE_SESSION,
    modes: { currentModeId: currentMode, availableModes: MODES },
    models: { currentModelId: currentModel, availableModels: MODELS.map(function (m) { return { modelId: m, name: m }; }) },
    configOptions: configOptions()
  };
}
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function respond(id, result) { send({ jsonrpc: "2.0", id: id, result: result }); }
function respondError(id, code, message, data) {
  const error = { code: code, message: message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id: id, error: error });
}
function notify(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: FIXTURE_SESSION, update: update } }); }

function fatalError(text) {
  const m = /fatal\\s+(\\d+)/.exec(text || "");
  const code = m ? Number(m[1]) : Number(process.env.FAKE_EXIT || "3");
  if (code === 3) return { status: 401 };
  if (code === 4) return { code: "USAGE_EXCEEDED" };
  if (code === 10) return { code: "PREMIUM_CREDITS_EXHAUSTED" };
  return { code: "MYSTERY" };
}

function handlePrompt(id, params) {
  const block = Array.isArray(params.prompt) ? params.prompt[0] : null;
  const text = block && typeof block.text === "string" ? block.text : "";
  logEvent({ kind: "prompt", text: text, model: currentModel, mode: currentMode, sessionId: FIXTURE_SESSION, effortValue: effortState().current });
  const fakeMode = process.env.FAKE_MODE || "";
  if (fakeMode === "hang") { setInterval(function () {}, 1000); return; }
  if (fakeMode === "fatal") {
    respondError(id, -32603, "The Command Code run failed", fatalError(text));
    return;
  }
  const successModel = process.env.FAKE_SUCCESS_MODEL;
  if (successModel !== undefined && currentModel !== successModel) {
    respondError(id, -32603, "The model request failed", { code: "RATE_LIMITED", status: 429 });
    return;
  }
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK:" + currentModel } });
  respond(id, { stopReason: "end_turn", _meta: { usage: { inputTokens: 5, outputTokens: 2 } } });
}

function handleRequest(method, params, id) {
  if (method === "initialize") {
    respond(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {}, close: {} } } });
    return;
  }
  if (method === "session/new") { logEvent({ kind: "new" }); respond(id, attachState()); return; }
  if (method === "session/resume") { logEvent({ kind: "resume", sessionId: params.sessionId }); respond(id, attachState()); return; }
  if (method === "session/load") { logEvent({ kind: "load", sessionId: params.sessionId }); respond(id, attachState()); return; }
  if (method === "session/set_model") {
    if (MODELS.indexOf(params.modelId) < 0) { respondError(id, -32602, "Unknown model: " + String(params.modelId)); return; }
    currentModel = params.modelId;
    logEvent({ kind: "model", value: currentModel });
    respond(id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/set_config_option") {
    if (params.configId !== "effort") { respondError(id, -32602, "Unknown config option: " + String(params.configId)); return; }
    const value = typeof params.value === "string" ? params.value : "";
    const state = effortState();
    if (state.values.indexOf(value) < 0) { respondError(id, -32602, "Unknown effort: " + value); return; }
    state.current = value;
    if (value !== "default") state.values = state.values.filter(function (v) { return v !== "default"; });
    logEvent({ kind: "effort", value: value });
    respond(id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/set_mode") {
    currentMode = params.modeId;
    logEvent({ kind: "mode", value: params.modeId });
    respond(id, {});
    return;
  }
  if (method === "session/close") { logEvent({ kind: "close" }); respond(id, {}); return; }
  if (method === "session/prompt") { handlePrompt(id, params); return; }
  respondError(id, -32601, "Method not found: " + method);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (e) { continue; }
    if (message && message.method !== undefined) {
      if (message.id !== undefined) handleRequest(message.method, message.params || {}, message.id);
      continue;
    }
    if (message && message.result !== undefined) { continue; }
  }
});
process.stdin.on("end", function () { process.exit(0); });
`;

  const scriptPath = path.join(dir, "fake-cmdc.cjs");
  fs.writeFileSync(scriptPath, script, "utf8");
  if (process.platform === "win32") {
    const shim = path.join(dir, "fake-cmdc.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nendLocal & node "%dp0%\\fake-cmdc.cjs" %*\r\n`, "utf8");
    return { shim, script: scriptPath };
  }
  const shim = path.join(dir, "fake-cmdc");
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-cmdc.cjs" "$@"\n`, "utf8");
  fs.chmodSync(shim, 0o755);
  return { shim, script: scriptPath };
}

/** Read every recorded protocol event (empty when the fixture never ran). */
export function readCcAcpLog(logPath: string): CcAcpLogEntry[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CcAcpLogEntry);
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Compare fixture cwd values by filesystem identity where the path exists. */
export function sameFixtureCwd(left: string, right: string): boolean {
  return canonicalExistingPath(left || "") === canonicalExistingPath(right || "");
}

/** The prompt events recorded for ONE project cwd, in order. */
export function promptEventsFor(logPath: string, project: string): CcAcpLogEntry[] {
  return readCcAcpLog(logPath).filter((entry) => entry.kind === "prompt" && sameFixtureCwd(entry.cwd || "", project));
}
