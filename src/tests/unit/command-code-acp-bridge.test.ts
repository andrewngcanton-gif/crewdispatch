// command-code-acp-bridge.test.ts — the REAL bridge code against a scripted
// in-process ACP server.
//
// The fake server speaks the INSTALLED official CLI's own wire shapes (the
// permission options `allow_once/allow_always/reject_once/reject_always`, the
// `{sessionId, toolCall, options}` request, the `{outcome:{outcome,optionId}}`
// reply, `session/update` notifications and the `{stopReason, usage, _meta}`
// prompt result). The bridge itself is the production code path; only the child
// process and the Hub are test doubles, so everything between the JSON-RPC
// frame and the canonical NDJSON record is exercised for real.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { spawn } from "node:child_process";
import {
  boundedOneLine,
  buildCcAcpBridgeArgv,
  parseCcAcpBridgeArgv,
  runCcAcpBridge,
  type CcAcpBridgeArgs,
  type CcAcpBridgeIo
} from "../../providers/command-code/acp-bridge";
import { createCommandCodeState, normalizeUsage, parseCommandCodeRecord } from "../../providers/command-code/stream";
import { createCommandCodeAdapter } from "../../providers/command-code/index";
import {
  APPROVAL_DETAIL_SCAN_CAP,
  approvalRequestPath,
  canonicalApprovalKind,
  claimApprovalDecision,
  readPendingApproval,
  type ApprovalDecision
} from "../../jobs/approval";

const JOB_ID = "job-cc-acp-unit";
const GENERATION = 3;
const SESSION_ID = "sess-cc-1";
const PERMISSION_REQUEST_ID = 7777;

// ---------------------------------------------------------------------------
// A scripted in-process ACP server behind a fake ChildProcess
// ---------------------------------------------------------------------------

class FakeAcpChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 4242;
  kill(): boolean {
    return true;
  }
  exitWith(code: number): void {
    this.emit("exit", code, null);
  }
}

interface PromptScript {
  updates?: unknown[];
  permission?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  /** The child dies instead of answering the prompt (EOF class). */
  exitCode?: number;
  /** The prompt request stays pending until the test releases it. */
  hold?: boolean;
}

interface ServerScript {
  initialize?: unknown;
  /** The CLI refuses initialize itself (auth-required class). */
  initializeError?: { code: number; message: string; data?: unknown };
  /** The CLI never answers initialize (a stalled control request). */
  holdInitialize?: boolean;
  attach?: unknown;
  /** A JSON-RPC error for ONE attach method (capability-vs-method mismatch). */
  attachError?: { method: string; code: number; message: string };
  /** Notifications sent BEFORE the attach response (session/load replay). */
  attachReplay?: unknown[];
  /** Live notifications sent AFTER the attach response and BEFORE the prompt. */
  prePromptUpdates?: unknown[];
  /**
   * The effort state each model's session remembers: `current` plus the
   * SELECTABLE values the CLI publishes. The installed CLI drops `"default"`
   * from the selectable values once an explicit level is set and then rejects
   * `"default"` with -32602 — the fake mirrors that exactly.
   */
  modelEfforts?: Record<string, { current: string; values: string[] }>;
  /** A provider that accepts an effort set but reports a different effective value. */
  effortMisreport?: string;
  prompt?: PromptScript;
}

const DEFAULT_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { resume: {}, list: {}, close: {} }
  }
};

const AVAILABLE_MODES = [
  { id: "default", name: "Standard" },
  { id: "auto-accept", name: "Accept Edits" },
  { id: "plan", name: "Plan" },
  { id: "dont-ask", name: "Don't Ask" },
  { id: "bypass", name: "Bypass Permissions" }
];

const AVAILABLE_MODELS = [
  { modelId: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { modelId: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash" }
];

/** The effort levels the installed CLI publishes for a reasoning model. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const EFFORT_OPTION = {
  id: "effort",
  category: "thought_level",
  type: "select",
  currentValue: "default",
  options: [{ value: "default" }, ...EFFORT_LEVELS.map((value) => ({ value }))]
};

const MODEL_OPTION = {
  id: "model",
  category: "model",
  type: "select",
  currentValue: "deepseek/deepseek-v4-flash",
  options: AVAILABLE_MODELS.map((model) => ({ value: model.modelId }))
};

function defaultAttach(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    modes: { currentModeId: "bypass", availableModes: AVAILABLE_MODES },
    models: { currentModelId: "deepseek/deepseek-v4-flash", availableModels: AVAILABLE_MODELS },
    configOptions: [MODEL_OPTION, EFFORT_OPTION],
    ...overrides
  };
}

/** The installed CLI's own permission request shape (bundle `askClient`). */
function permissionParams(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    toolCall: {
      toolCallId: "call-1",
      title: "Edit: C:/tmp/disposable/note.txt",
      kind: "edit",
      status: "pending",
      rawInput: { file_path: "C:/tmp/disposable/note.txt", old_string: "a", new_string: "b" }
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Always reject", kind: "reject_always" }
    ]
  };
}

class FakeCcAcpServer {
  readonly child = new FakeAcpChild();
  readonly methods: string[] = [];
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly clientNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly permissionAnswers: unknown[] = [];
  readonly spawnCalls: Array<{ file: string; args: string[] }> = [];
  private readonly responseWaiters = new Map<number, (value: unknown) => void>();
  private buffer = "";
  private exited = false;
  /** The session's current model, as the CLI's own session state tracks it. */
  private sessionModel: string | null = null;
  /** Per-model remembered effort state (mirrors the installed CLI). */
  private readonly sessionEfforts = new Map<string, { current: string; values: string[] }>();
  private hasEffortOption = true;
  /** Pre-prompt updates to flush on the first client message after attach. */
  private pendingPrePrompt: unknown[] | null = null;
  private heldPrompt: { id: number; result: unknown } | null = null;
  private resolvePromptSeen: (() => void) | null = null;
  private readonly promptSeen = new Promise<void>((resolve) => {
    this.resolvePromptSeen = resolve;
  });

  constructor(private readonly script: ServerScript = {}) {
    this.child.stdin.setEncoding("utf8");
    this.child.stdin.on("data", (chunk: string) => this.feed(chunk));
    this.child.stdin.on("end", () => this.exit(0));
    this.child.stdin.on("error", () => {});
  }

  /** Resolves once the prompt request has been received (no wall-clock wait). */
  waitForPrompt(): Promise<void> {
    return this.promptSeen;
  }

  /** Answer the held prompt (a late provider reply). */
  releasePrompt(result?: unknown): void {
    const held = this.heldPrompt;
    if (!held) throw new Error("no prompt is held");
    this.heldPrompt = null;
    this.respond(held.id, result ?? held.result);
  }

  /** Send one live `session/update` after the prompt was issued. */
  sendUpdate(update: unknown): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update } });
  }

  /** The spawn seam the bridge receives: record and hand back the fake child. */
  readonly spawnFn = ((file: string, args: readonly string[]) => {
    this.spawnCalls.push({ file, args: [...args] });
    return this.child;
  }) as unknown as typeof spawn;

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  /** The effort state of one model: the live session memory wins. */
  private effortStateFor(model: string | null): { current: string; values: string[] } {
    const existing = model ? this.sessionEfforts.get(model) : undefined;
    if (existing) return existing;
    // A scripted `modelEfforts` entry is the model's INITIAL remembered state;
    // it is adopted once so later changes (a set/reset) persist like the CLI's.
    const remembered = model ? this.script.modelEfforts?.[model] : undefined;
    const state = remembered
      ? { current: remembered.current, values: [...remembered.values] }
      : { current: "default", values: ["default", ...EFFORT_LEVELS] };
    if (model) this.sessionEfforts.set(model, state);
    return state;
  }

  /** The installed CLI's own config_options payload for the current state. */
  private configOptionsPayload(): unknown[] {
    const model = this.sessionModel ?? "deepseek/deepseek-v4-flash";
    const effort = this.effortStateFor(model);
    const payload: unknown[] = [
      { ...MODEL_OPTION, currentValue: model, options: AVAILABLE_MODELS.map((entry) => ({ value: entry.modelId })) }
    ];
    if (this.hasEffortOption) {
      payload.push({
        id: "effort",
        category: "thought_level",
        type: "select",
        currentValue: effort.current,
        options: effort.values.map((value) => ({ value }))
      });
    }
    return payload;
  }

  /** The installed CLI republishes its config state after every change. */
  private sendConfigUpdate(sessionId: unknown): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: typeof sessionId === "string" ? sessionId : SESSION_ID,
        update: { sessionUpdate: "config_option_update", configOptions: this.configOptionsPayload() }
      }
    });
  }

  /** Adopt the attach result as this fake session's own initial state. */
  private applyAttachState(attach: Record<string, unknown>): void {
    const model = this.asRecord(attach.models).currentModelId;
    this.sessionModel = typeof model === "string" ? model : null;
    const configs = Array.isArray(attach.configOptions) ? attach.configOptions : [];
    this.hasEffortOption = configs.some((raw) => this.asRecord(raw).id === "effort") || Boolean(this.script.modelEfforts);
    // A scripted memory for the attached model is its INITIAL state; it is
    // adopted first so the static attach block never overrides it.
    const scripted = this.sessionModel ? this.script.modelEfforts?.[this.sessionModel] : undefined;
    if (scripted && this.sessionModel) {
      this.sessionEfforts.set(this.sessionModel, { current: scripted.current, values: [...scripted.values] });
    }
    for (const raw of configs) {
      const entry = this.asRecord(raw);
      if (entry.id !== "effort" || !this.sessionModel) continue;
      if (this.sessionEfforts.has(this.sessionModel)) continue;
      const current = typeof entry.currentValue === "string" ? entry.currentValue : "default";
      const values = (Array.isArray(entry.options) ? entry.options : [])
        .map((option) => this.asRecord(option).value)
        .filter((value): value is string => typeof value === "string");
      this.sessionEfforts.set(this.sessionModel, { current, values: values.length ? values : ["default", ...EFFORT_LEVELS] });
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          this.handleMessage(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* a malformed client line is ignored, like the real server would */
        }
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      // Live post-attach updates the provider publishes while the session is
      // being configured: they are delivered deterministically BEFORE the next
      // request is answered (the bridge's notification handler is installed
      // once the attach response is consumed, so this is the first point the
      // client can observe them — and always before `session/prompt`).
      this.flushPrePrompt();
      if (!("id" in message)) {
        this.clientNotifications.push({ method: message.method, params: this.asRecord(message.params) });
        return;
      }
      const id = typeof message.id === "number" ? message.id : 0;
      void this.handleRequest(message.method, this.asRecord(message.params), id);
      return;
    }
    if ("result" in message || "error" in message) {
      const id = typeof message.id === "number" ? message.id : -1;
      const waiter = this.responseWaiters.get(id);
      if (waiter) {
        this.responseWaiters.delete(id);
        waiter("result" in message ? message.result : { error: message.error });
      }
    }
  }

  /** Send the scripted pre-prompt updates once, on the first message after attach. */
  private flushPrePrompt(): void {
    const pending = this.pendingPrePrompt;
    if (!pending?.length) return;
    this.pendingPrePrompt = null;
    for (const update of pending) {
      this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update } });
    }
  }

  private async handleRequest(method: string, params: Record<string, unknown>, id: number): Promise<void> {
    this.methods.push(method);
    this.requests.push({ method, params });
    if (method === "initialize") {
      if (this.script.holdInitialize) return;
      if (this.script.initializeError) {
        this.respondError(id, this.script.initializeError.code, this.script.initializeError.message, this.script.initializeError.data);
        return;
      }
      this.respond(id, this.script.initialize ?? DEFAULT_INITIALIZE);
      return;
    }
    if (method === "session/new" || method === "session/resume" || method === "session/load") {
      if (this.script.attachReplay) {
        for (const update of this.script.attachReplay) {
          this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId ?? SESSION_ID, update } });
        }
      }
      if (this.script.attachError && this.script.attachError.method === method) {
        this.respondError(id, this.script.attachError.code, this.script.attachError.message);
        return;
      }
      const attach = this.asRecord(this.script.attach ?? defaultAttach());
      this.applyAttachState(attach);
      // A scripted per-model effort memory is this session's OWN attach state
      // (the installed CLI publishes the current model's effort with the
      // session), so the response the bridge reads reflects it.
      const response = this.script.modelEfforts ? { ...attach, configOptions: this.configOptionsPayload() } : attach;
      this.respond(id, response);
      if (this.script.prePromptUpdates?.length) {
        this.pendingPrePrompt = [...this.script.prePromptUpdates];
      }
      return;
    }
    if (method === "session/set_model") {
      const modelId = typeof params.modelId === "string" ? params.modelId : null;
      if (!modelId || !AVAILABLE_MODELS.some((entry) => entry.modelId === modelId)) {
        this.respondError(id, -32602, `Unknown model: ${modelId ?? ""}`);
        return;
      }
      this.sessionModel = modelId;
      this.sendConfigUpdate(params.sessionId);
      this.respond(id, { configOptions: this.configOptionsPayload() });
      return;
    }
    if (method === "session/set_config_option") {
      if (params.configId !== "effort") {
        this.respondError(id, -32602, `Unknown config option: ${String(params.configId)}`);
        return;
      }
      const value = typeof params.value === "string" ? params.value : "";
      const state = this.effortStateFor(this.sessionModel);
      if (!state.values.includes(value)) {
        // The installed CLI's own rejection (explicit "default" after a level
        // is set is -32602 "Unknown effort: default").
        this.respondError(id, -32602, `Unknown effort: ${value}`);
        return;
      }
      state.current = value;
      if (value !== "default") state.values = state.values.filter((entry) => entry !== "default");
      if (this.script.effortMisreport) state.current = this.script.effortMisreport;
      this.sendConfigUpdate(params.sessionId);
      this.respond(id, { configOptions: this.configOptionsPayload() });
      return;
    }
    if (method === "session/set_mode" || method === "session/close") {
      this.respond(id, {});
      return;
    }
    if (method === "session/prompt") {
      void this.runPrompt(id, params);
      return;
    }
    this.respondError(id, -32601, `Method not found: ${method}`);
  }

  private async runPrompt(id: number, params: Record<string, unknown>): Promise<void> {
    const script = this.script.prompt ?? {};
    this.resolvePromptSeen?.();
    for (const update of script.updates ?? []) {
      this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
    }
    if (script.permission) {
      const answer = new Promise<unknown>((resolve) => this.responseWaiters.set(PERMISSION_REQUEST_ID, resolve));
      this.send({
        jsonrpc: "2.0",
        id: PERMISSION_REQUEST_ID,
        method: "session/request_permission",
        params: script.permission
      });
      this.permissionAnswers.push(await answer);
    }
    if (script.exitCode != null) {
      this.exit(script.exitCode);
      return;
    }
    if (script.error) {
      this.respondError(id, script.error.code, script.error.message, script.error.data);
      return;
    }
    if (script.hold) {
      this.heldPrompt = { id, result: script.result ?? { stopReason: "end_turn" } };
      return;
    }
    this.respond(id, script.result ?? { stopReason: "end_turn" });
  }

  private exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.child.exitWith(code);
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdout.write(JSON.stringify(message) + "\n");
  }

  private respond(id: number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function newTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-cc-acp-${prefix}-`));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One macrotask turn — usable while the wall clock is mocked. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Poll a condition with macrotasks only (no timers, safe under fake clocks). */
async function waitForImmediate(predicate: () => boolean, label = "condition", tries = 5000): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function bridgeArgs(overrides: Partial<CcAcpBridgeArgs> = {}): CcAcpBridgeArgs {
  return {
    cliPath: "/fake/bin/cmdc",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    effort: null,
    resumeSessionId: null,
    effortDefaultProven: false,
    attempt: null,
    ...overrides
  };
}

function bridgeIo(
  server: FakeCcAcpServer,
  options: {
    prompt?: string;
    env?: NodeJS.ProcessEnv;
    records?: Record<string, unknown>[];
    signalHandlers?: Array<() => void>;
  } = {}
): CcAcpBridgeIo {
  const records = options.records ?? [];
  return {
    stdin: Readable.from([options.prompt ?? "Do the task"]),
    stdout: {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) records.push(JSON.parse(trimmed) as Record<string, unknown>);
        }
      }
    },
    stderr: { write: () => {} },
    env: options.env ?? {},
    cwd: process.cwd(),
    platform: "linux",
    spawnFn: server.spawnFn,
    killTreeFn: async () => true,
    closeGraceMs: 200,
    registerSignalHandler: (handler) => {
      options.signalHandlers?.push(handler);
    },
    controlTimeoutMs: 2000
  };
}

/** Feed every bridge record through the REAL canonical parser. */
function canonicalUsage(records: readonly Record<string, unknown>[]) {
  const state = createCommandCodeState();
  for (const record of records) parseCommandCodeRecord(JSON.stringify(record), state);
  return { state, usage: normalizeUsage(state) };
}

function eventsOf(records: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const record of records) {
    if (record.type === "event" && record.event && typeof record.event === "object") {
      out.push(record.event as Record<string, unknown>);
    }
  }
  return out;
}

function terminalOf(records: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record?.type === "result") return record;
  }
  return null;
}

function decisionFor(optionId: string, requestId = String(PERMISSION_REQUEST_ID)): ApprovalDecision {
  return {
    version: 1,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId,
    optionId,
    kind: canonicalApprovalKind(optionId) ?? "unknown",
    decidedAt: new Date().toISOString(),
    by: "hub"
  };
}

async function startFakeHub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/ping") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "jobquay", version: "test", build_id: "test" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake hub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

// ---------------------------------------------------------------------------
// Launch and configuration (before the prompt)
// ---------------------------------------------------------------------------

test("the bridge launches the CLI's OWN `acp` entry (never print mode) and configures model/effort/mode BEFORE the prompt", async () => {
  const server = new FakeCcAcpServer({
    attach: defaultAttach({ models: { currentModelId: "inclusionai/ling-3.0-flash-sante:free", availableModels: AVAILABLE_MODELS } }),
    prompt: {
      updates: [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering " } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "carefully" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ model: "deepseek/deepseek-v4-flash", permissionMode: "standard", effort: "high" }),
    bridgeIo(server, { prompt: "Say hello", records })
  );
  assert.equal(code, 0);
  // The official CLI is spawned as `cmdc acp`; no `-p`, no print branch.
  assert.deepEqual(server.spawnCalls, [{ file: "/fake/bin/cmdc", args: ["acp"] }]);
  // Configuration strictly precedes the prompt.
  assert.deepEqual(server.methods, [
    "initialize",
    "session/new",
    "session/set_model",
    "session/set_config_option",
    "session/set_mode",
    "session/prompt",
    "session/close"
  ]);
  assert.deepEqual(server.requests[2]?.params, { sessionId: SESSION_ID, modelId: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(server.requests[3]?.params, { sessionId: SESSION_ID, configId: "effort", value: "high" });
  assert.deepEqual(server.requests[4]?.params, { sessionId: SESSION_ID, modeId: "default" });
  assert.deepEqual(server.requests[5]?.params, { sessionId: SESSION_ID, prompt: [{ type: "text", text: "Say hello" }] });

  const events = eventsOf(records);
  assert.deepEqual(events[0], { type: "init", session_id: SESSION_ID, model: "deepseek/deepseek-v4-flash" });
  assert.deepEqual(events[1], { type: "turn_start" });
  assert.deepEqual(
    events.filter((event) => event.type === "text_delta").map((event) => event.delta),
    ["Hello ", "world"]
  );
  assert.deepEqual(
    events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ["considering ", "carefully"]
  );
  assert.equal(events.filter((event) => event.type === "thinking_start").length, 1, "one reasoning block opens once");
  assert.deepEqual(
    events.filter((event) => event.type === "thinking_end").map((event) => event.text),
    ["considering carefully"],
    "the production normalizer closes one complete reasoning block before assistant text"
  );
  assert.ok(
    events.findIndex((event) => event.type === "thinking_end") < events.findIndex((event) => event.type === "text_delta"),
    "reasoning closes before the answer starts"
  );
  const terminal = terminalOf(records);
  assert.ok(terminal);
  assert.equal(terminal.subtype, "success");
  assert.equal(terminal.is_error, false);
  assert.equal(terminal.stop_reason, "end_turn");
  assert.equal(terminal.finalText, "Hello world");
  assert.equal(terminal.session_id, SESSION_ID);
});

test("a reasoning-only Command Code turn flushes one complete thinking block when session/prompt returns", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning only " } },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "before result" } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 9, "reasoning-only remains the provider's no-assistant-response class");
  const events = eventsOf(records);
  assert.deepEqual(events.filter((event) => event.type === "thinking_end").map((event) => event.text), ["reasoning only before result"]);
  assert.equal(events.filter((event) => event.type === "thinking_delta").length, 2);
  assert.equal(terminalOf(records)?.subtype, "error", "closing reasoning never fabricates an assistant success");
});

test("yolo maps to the CLI's own bypass mode; the mode is set before the prompt", async () => {
  const server = new FakeCcAcpServer({
    attach: defaultAttach({ modes: { currentModeId: "default", availableModes: AVAILABLE_MODES } }),
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ permissionMode: "yolo" }), bridgeIo(server, { records }));
  assert.equal(code, 0);
  assert.ok(server.methods.indexOf("session/set_mode") < server.methods.indexOf("session/prompt"));
  assert.deepEqual(server.requests.find((request) => request.method === "session/set_mode")?.params, {
    sessionId: SESSION_ID,
    modeId: "bypass"
  });
});

test("a fresh session's model default (no requested effort) sends NO effort call and accepts only the provider's own reported state", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ effort: null }), bridgeIo(server, { records }));
  assert.equal(code, 0);
  assert.equal(server.methods.includes("session/set_config_option"), false);
});

test("a resumed session's remembered explicit effort cannot satisfy a model-default request: the run fails BEFORE the prompt", async () => {
  // The installed CLI remembers per-model effort across a resume and rejects
  // "default" once a level is set. Without a proven reset the bridge must not
  // silently prompt at the remembered level.
  const server = new FakeCcAcpServer({
    modelEfforts: { "deepseek/deepseek-v4-flash": { current: "high", values: ["off", "low", "high", "max"] } },
    prompt: { result: { stopReason: "end_turn" } }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", effort: null }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/prompt"), false, "no prompt may run at a remembered effort");
  const terminal = terminalOf(records);
  assert.ok(terminal);
  assert.equal(terminal.is_error, true);
  assert.match(String(terminal.error ?? ""), /remembers reasoning effort "high"/);
  assert.match(String(terminal.error ?? ""), /refusing to prompt at a remembered level/);
});

test("a resumed session whose model default is still in effect (or resettable) proceeds after reconciling the reported state", async () => {
  // currentValue "default": nothing was ever set for this model in the session.
  const server = new FakeCcAcpServer({
    modelEfforts: { "deepseek/deepseek-v4-flash": { current: "default", values: ["default", "off", "high", "max"] } },
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", effort: null }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  assert.equal(server.methods.includes("session/set_config_option"), false, "already at the model default");
  assert.equal(terminalOf(records)?.finalText, "continued");
});

test("a resumed session whose provider resolves the model default to a concrete value is accepted when the worker PROVED no explicit effort for this model", async () => {
  // The real Command Code 1.74.1 shape: a fresh model-default turn (effort null)
  // makes the provider report the resolved level "medium" — NOT a user-explicit
  // setting. A continuation the worker proved never selected an explicit effort
  // for this model must proceed under that model-default intent.
  const server = new FakeCcAcpServer({
    modelEfforts: { "deepseek/deepseek-v4-flash": { current: "medium", values: ["low", "medium", "high"] } },
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", effort: null, effortDefaultProven: true }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  assert.equal(server.methods.includes("session/set_config_option"), false, "the provider's resolved default needs no setter");
  assert.equal(server.methods.includes("session/prompt"), true, "the proven model-default continuation prompts");
  assert.equal(terminalOf(records)?.finalText, "continued");
});

test("the same provider-resolved value is still refused when provenance is UNPROVEN", async () => {
  const server = new FakeCcAcpServer({
    modelEfforts: { "deepseek/deepseek-v4-flash": { current: "medium", values: ["low", "medium", "high"] } },
    prompt: { result: { stopReason: "end_turn" } }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", effort: null, effortDefaultProven: false }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/prompt"), false, "an unproven remembered value must not prompt");
  assert.match(String(terminalOf(records)?.error ?? ""), /remembers reasoning effort "medium"/);
});

test("when the provider publishes a selectable reset, a remembered explicit effort is reset and verified before the prompt", async () => {
  // A build that publishes "default" as a selectable value (the installed CLI
  // does this only while the model is still unset, but the branch must work
  // whenever the provider proves it).
  const server = new FakeCcAcpServer({
    modelEfforts: { "deepseek/deepseek-v4-flash": { current: "high", values: ["default", "off", "high", "max"] } },
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reset" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", effort: null }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  assert.deepEqual(
    server.requests.filter((request) => request.method === "session/set_config_option").map((request) => request.params),
    [{ sessionId: "session-existing", configId: "effort", value: "default" }]
  );
  assert.equal(terminalOf(records)?.finalText, "reset");
});

test("a model revisit reconciles the TARGET model's own remembered effort instead of reusing the previous model's state", async () => {
  // Model A was explicitly set to "high"; the requested model B never had an
  // effort set, so B's own default is in effect. A model-default request for B
  // must succeed on B's state even though A remembers "high".
  const server = new FakeCcAcpServer({
    modelEfforts: {
      "deepseek/deepseek-v4-flash": { current: "high", values: ["off", "high", "max"] },
      "inclusionai/ling-3.0-flash-sante:free": { current: "default", values: ["default", "off", "high", "max"] }
    },
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on B" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", model: "inclusionai/ling-3.0-flash-sante:free", effort: null }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  assert.equal(server.methods.includes("session/set_config_option"), false);
  assert.equal(terminalOf(records)?.finalText, "on B");

  // The same revisit on the model that DOES remember an explicit level fails
  // before the prompt instead of inheriting "high".
  const second = new FakeCcAcpServer({
    modelEfforts: {
      "deepseek/deepseek-v4-flash": { current: "high", values: ["off", "high", "max"] },
      "inclusionai/ling-3.0-flash-sante:free": { current: "default", values: ["default", "off", "high", "max"] }
    }
  });
  const secondRecords: Record<string, unknown>[] = [];
  const secondCode = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing", model: "deepseek/deepseek-v4-flash", effort: null }),
    bridgeIo(second, { records: secondRecords })
  );
  assert.equal(secondCode, 1);
  assert.equal(second.methods.includes("session/prompt"), false);
});

test("an explicit effort is set AND verified from the provider's own reported state; an unconfirmed value fails before the prompt", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ effort: "high" }), bridgeIo(server, { records }));
  assert.equal(code, 0);
  const setCall = server.requests.find((request) => request.method === "session/set_config_option");
  assert.deepEqual(setCall?.params, { sessionId: SESSION_ID, configId: "effort", value: "high" });

  // A build that accepts the call but reports a different effective value must
  // not be trusted: the bridge refuses to prompt.
  const stubborn = new FakeCcAcpServer({
    effortMisreport: "low",
    prompt: { result: { stopReason: "end_turn" } }
  });
  const stubbornRecords: Record<string, unknown>[] = [];
  const stubbornCode = await runCcAcpBridge(bridgeArgs({ effort: "high" }), bridgeIo(stubborn, { records: stubbornRecords }));
  assert.equal(stubbornCode, 1);
  assert.equal(stubborn.methods.includes("session/prompt"), false);
  assert.match(String(terminalOf(stubbornRecords)?.error ?? ""), /could not be verified/);
});

// ---------------------------------------------------------------------------
// Usage and telemetry honesty
// ---------------------------------------------------------------------------

test("usage folds the turn counters, reconciles the cumulative USD cost into deltas, and leaves Decode null", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [
        // The installed CLI's publisher always pairs the amount with
        // `currency:"USD"` when a cost is present (recorded wire shape).
        { sessionUpdate: "usage_update", used: 900, size: 200000, cost: { amount: 0.002, currency: "USD" } },
        { sessionUpdate: "usage_update", used: 1200, size: 200000, cost: { amount: 0.0025, currency: "USD" } },
        { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Edit: C:/tmp/disposable/note.txt", kind: "edit" },
        { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" },
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "post-tool reasoning" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }
      ],
      result: {
        stopReason: "end_turn",
        usage: { totalTokens: 5000, inputTokens: 4000, outputTokens: 1000, cachedReadTokens: 300, cachedWriteTokens: 0 },
        _meta: { usage: { inputTokens: 1200, outputTokens: 320, cacheReadTokens: 512, cacheWriteTokens: 64 } }
      }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 0);

  const usageEvents = eventsOf(records).filter((event) => event.type === "usage");
  assert.deepEqual(usageEvents, [
    { type: "usage", contextUsed: 900, contextWindow: 200000, totalCostUsd: 0.002 },
    { type: "usage", contextUsed: 1200, contextWindow: 200000, totalCostUsd: 0.0005 },
    { type: "usage", tokensIn: 1200, tokensOut: 320, cacheRead: 512, cacheCreation: 64, cacheMiss: 688 }
  ]);

  const { state, usage } = canonicalUsage(records);
  assert.equal(state.terminal, true);
  assert.equal(state.finalResult, "done");
  assert.equal(usage.tokensIn, 1200, "the TURN's own counters, not the session block");
  assert.equal(usage.tokensOut, 320);
  assert.equal(usage.cacheRead, 512);
  assert.equal(usage.cacheCreation, 64);
  assert.equal(usage.cacheMiss, 688);
  assert.equal(usage.totalCostUsd, 0.0025, "the session-cumulative USD cost reconciled to this attempt's delta");
  assert.equal(usage.contextUsed, 1200, "the context gauge is the latest observation");
  assert.equal(usage.contextWindow, 200000);
  assert.equal(usage.toolCalls, 1);
  // The ACP surface publishes no model-request boundary: Decode is honestly
  // absent rather than synthesized from a turn window.
  assert.equal(usage.decodeTokens, null);
  assert.equal(usage.decodeSeconds, null);
});

test("a resumed session's POST-prompt cumulative cost is never adopted as a baseline: the whole attempt's cost stays unavailable", async () => {
  const server = new FakeCcAcpServer({
    attach: defaultAttach(),
    prompt: {
      updates: [
        { sessionUpdate: "usage_update", used: 15000, size: 200000, cost: { amount: 1.25, currency: "USD" } },
        { sessionUpdate: "usage_update", used: 15200, size: 200000, cost: { amount: 1.5, currency: "USD" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing" }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  const usageEvents = eventsOf(records).filter((event) => event.type === "usage");
  // The gauges are still reported; the money is NOT (a first post-prompt
  // observation already includes this turn, so a "delta" from it undercounts).
  assert.deepEqual(usageEvents, [
    { type: "usage", contextUsed: 15000, contextWindow: 200000 },
    { type: "usage", contextUsed: 15200, contextWindow: 200000 }
  ]);
  const { usage } = canonicalUsage(records);
  assert.equal(usage.totalCostUsd, null, "an unknown partial turn cost is never reported");
});

test("a resumed session's PRE-prompt cumulative cost is the proven baseline; only the turn's own deltas are emitted", async () => {
  // The provider republishes the session's cumulative cost while the session is
  // being attached — BEFORE the prompt. That value is the historical baseline.
  // The load-replay history (which also carries a cost) is NOT a baseline: it
  // arrives before the attach response and is suppressed.
  const server = new FakeCcAcpServer({
    attachReplay: [{ sessionUpdate: "usage_update", used: 11000, size: 200000, cost: { amount: 9.99, currency: "USD" } }],
    prePromptUpdates: [{ sessionUpdate: "usage_update", used: 12000, size: 200000, cost: { amount: 1.0, currency: "USD" } }],
    prompt: {
      updates: [
        { sessionUpdate: "usage_update", used: 15000, size: 200000, cost: { amount: 1.25, currency: "USD" } },
        { sessionUpdate: "usage_update", used: 15200, size: 200000, cost: { amount: 1.5, currency: "USD" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "continued" } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing" }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  const usageEvents = eventsOf(records).filter((event) => event.type === "usage");
  // The pre-prompt observation itself is a live gauge (reported without cost:
  // it is the baseline, never this attempt's spend), the suppressed replay
  // never contributes, and the deltas sum to exactly the turn's own cost
  // (1.50 - 1.00 = 0.50).
  assert.deepEqual(usageEvents, [
    { type: "usage", contextUsed: 12000, contextWindow: 200000 },
    { type: "usage", contextUsed: 15000, contextWindow: 200000, totalCostUsd: 0.25 },
    { type: "usage", contextUsed: 15200, contextWindow: 200000, totalCostUsd: 0.25 }
  ]);
  const { usage } = canonicalUsage(records);
  assert.equal(usage.totalCostUsd, 0.5);
});

test("a cost reported in another currency is never relabelled as USD", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [
        { sessionUpdate: "usage_update", used: 900, size: 200000, cost: { amount: 0.002, currency: "EUR" } },
        { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: 0.003, currency: "USD" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 0);
  const usageEvents = eventsOf(records).filter((event) => event.type === "usage");
  assert.deepEqual(usageEvents, [
    { type: "usage", contextUsed: 900, contextWindow: 200000 },
    { type: "usage", contextUsed: 1000, contextWindow: 200000, totalCostUsd: 0.003 }
  ]);
  const { usage } = canonicalUsage(records);
  assert.equal(usage.totalCostUsd, 0.003, "the EUR amount contributes nothing");
});

// ---------------------------------------------------------------------------
// Long turns: NO total or idle prompt deadline (clock-controlled)
//
// These tests run the PRODUCTION request path (`runCcAcpBridge` ->
// `CcAcpConnection.request(session/prompt, ..., null)`) under a mocked clock.
// The historical 30-minute prompt timeout (incident
// 2026-09-30-windows-host-restart-kills-worker) must never return: elapsed
// silence is not EOF, not a failed task and not a cancellation.
// ---------------------------------------------------------------------------

test(
  "a quiet-but-open prompt survives simulated 30- and 60-minute boundaries: updates still arrive and a late success completes",
  { timeout: 30000 },
  async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const server = new FakeCcAcpServer({
        prompt: {
          hold: true,
          updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "early" } }],
          result: { stopReason: "end_turn" }
        }
      });
      const records: Record<string, unknown>[] = [];
      const pending = runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
      await server.waitForPrompt();
      await settle();
      assert.equal(terminalOf(records), null);

      // 31 quiet minutes — past the historical 30-minute deadline.
      mock.timers.tick(31 * 60_000);
      await settle();
      assert.equal(terminalOf(records), null, "31 quiet minutes must not end the turn");
      // 30 more quiet minutes (61 total) — past any "extended" deadline.
      mock.timers.tick(30 * 60_000);
      await settle();
      assert.equal(terminalOf(records), null, "61 quiet minutes must not end the turn");

      // The transport is ALIVE: an update arriving after the silence is accepted.
      server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
      await settle();
      assert.deepEqual(
        eventsOf(records)
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta),
        ["early", "late"],
        "a live stream keeps accepting updates after prolonged silence"
      );

      // A late successful provider reply completes normally.
      server.releasePrompt();
      const code = await pending;
      assert.equal(code, 0, "a late success is still a success");
      const terminal = terminalOf(records);
      assert.equal(terminal?.subtype, "success");
      assert.equal(terminal?.is_error, false);
      assert.equal(terminal?.finalText, "earlylate");
      // No timeout error, no fallback, no cancellation merely from elapsed time.
      assert.equal(server.clientNotifications.some((notification) => notification.method === "session/cancel"), false);
      assert.equal(
        records.some((record) => record.type === "result" && record.is_error === true),
        false
      );
      assert.equal(
        eventsOf(records).some((event) => event.type === "usage" && event.tokensIn != null),
        false,
        "no fabricated usage from the timeout"
      );
    } finally {
      mock.timers.reset();
    }
  }
);

test("stalled startup/control requests DO time out (bounded), unlike the prompt", { timeout: 30000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const server = new FakeCcAcpServer({ holdInitialize: true });
    const records: Record<string, unknown>[] = [];
    const pending = runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
    await waitForImmediate(() => server.methods.includes("initialize"), "initialize");
    await settle();
    assert.equal(terminalOf(records), null, "the control call is still within its budget");
    mock.timers.tick(2000); // bridgeIo's controlTimeoutMs
    await settle();
    const code = await pending;
    assert.equal(code, 1);
    assert.equal(server.methods.includes("session/new"), false, "a stalled control call never reaches the prompt");
    assert.match(String(terminalOf(records)?.error ?? ""), /timed out/);
  } finally {
    mock.timers.reset();
  }
});

test("elapsed time alone never resolves a deliberately pending approval either — its own TTL is a separate contract", { timeout: 30000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dir = newTmp("clockapproval");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  try {
    const server = new FakeCcAcpServer({
      prompt: {
        permission: permissionParams(),
        updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "edit applied" } }],
        result: { stopReason: "end_turn" }
      }
    });
    const records: Record<string, unknown>[] = [];
    const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records }));
    await server.waitForPrompt();
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitForImmediate(() => fs.existsSync(requestFile), "the pending approval file");

    // Five quiet minutes: well inside the shared one-hour approval TTL and far
    // beyond any short prompt timer. Neither the approval nor the turn may end.
    mock.timers.tick(5 * 60_000);
    await settle();
    assert.equal(server.permissionAnswers.length, 0, "the human decision is still pending");
    assert.equal(terminalOf(records), null, "no terminal write merely from elapsed time");

    // The decision is still answerable and completes the same turn. The
    // channel's poll is a (mocked) timer: the claim alone is not observed until
    // the next poll tick fires.
    const claim = claimApprovalDecision(root, decisionFor("allow_once"));
    assert.equal(claim.claimed, true);
    mock.timers.tick(1000);
    await settle();
    await waitForImmediate(() => server.permissionAnswers.length === 1, "the approval answer");
    const code = await pending;
    assert.equal(code, 0);
    assert.equal(terminalOf(records)?.finalText, "edit applied");
    assert.ok(
      records.some((record) => record.type === "approval" && record.phase === "resolved" && record.option_id === "allow_once")
    );
  } finally {
    mock.timers.reset();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("absent counters stay null (no fabricated zero) and a 0 context window is an unresolved sentinel", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [
        { sessionUpdate: "usage_update", used: 0, size: 0 },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }
      ],
      result: { stopReason: "end_turn", usage: { outputTokens: 7 } }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 0);
  const { usage } = canonicalUsage(records);
  assert.equal(usage.tokensIn, null);
  assert.equal(usage.tokensOut, 7);
  assert.equal(usage.cacheRead, null);
  assert.equal(usage.cacheMiss, null);
  assert.equal(usage.contextUsed, 0, "a real 0 observation is kept");
  assert.equal(usage.contextWindow, null, "a 0 window is never a size claim");
  assert.equal(usage.credits, null, "money is not credits");
});

test("assistant output that MENTIONS 429/quota is a normal answer, never a fallback-eligible rate limit", async () => {
  const server = new FakeCcAcpServer({
    prompt: {
      updates: [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The service returned HTTP 429; insufficient credits and quota exceeded were reported upstream." }
        }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 0, "an answer is never classified as a provider rate limit");
  assert.equal(terminalOf(records)?.subtype, "success");
  assert.equal(terminalOf(records)?.is_error, false);
});

// ---------------------------------------------------------------------------
// Interactive approvals through the shared channel
// ---------------------------------------------------------------------------

test("a live Hub decision answers the CLI's own request with its own option id, clears the file, and nothing happens before the decision", async () => {
  const dir = newTmp("approve");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: {
      permission: permissionParams(),
      result: { stopReason: "end_turn" },
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "edit applied" } }]
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { prompt: "Edit the note", env: { JOBQUAY_HUB_URL: hub.url }, records }));
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    // While pending, the CLI has received NO answer: the tool cannot run.
    assert.equal(server.permissionAnswers.length, 0, "no answer before the human decision");
    const pendingApproval = readPendingApproval(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    assert.ok(pendingApproval);
    assert.equal(pendingApproval.provider, "command-code");
    assert.equal(pendingApproval.toolName, "edit");
    assert.deepEqual(pendingApproval.options.map((option) => option.id), [
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always"
    ]);
    assert.deepEqual(pendingApproval.detail, {
      title: "Edit: C:/tmp/disposable/note.txt",
      command: null,
      args: null,
      path: "C:/tmp/disposable/note.txt",
      cwd: null,
      description: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    });
    // The pending record is the ONLY approval stream record so far.
    assert.deepEqual(
      records.filter((record) => record.type === "approval").map((record) => record.phase),
      ["pending"]
    );

    const claim = claimApprovalDecision(root, decisionFor("allow_once"));
    assert.equal(claim.claimed, true);
    assert.equal(await pending, 0);
    assert.deepEqual(server.permissionAnswers, [{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    assert.equal(fs.existsSync(requestFile), false, "the consumed request file is cleared");
    assert.ok(
      records.some((record) => record.type === "approval" && record.phase === "resolved" && record.option_id === "allow_once"),
      "the resolution is published for the worker"
    );
    assert.equal(terminalOf(records)?.subtype, "success");
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no live Hub route the bridge keeps the historical non-interactive decline and writes no approval file", async () => {
  const dir = newTmp("noroute");
  const root = path.join(dir, "root");
  const server = new FakeCcAcpServer({
    prompt: {
      permission: permissionParams(),
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I could not edit the file." } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const code = await runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { records }));
    assert.equal(code, 0);
    assert.deepEqual(server.permissionAnswers, [{ outcome: { outcome: "cancelled" } }]);
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID))), false);
    assert.equal(records.some((record) => record.type === "approval"), false);
    // The missing route is proven on the completed turn: the denied operation
    // stays visible AND the bounded sub-cause says WHY no human was asked —
    // never presented as a human refusal.
    const terminal = terminalOf(records);
    assert.ok(terminal);
    assert.equal(terminal.finish_reason, "permission_denied");
    assert.equal(terminal.approval_outcome, "no_route");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected gate answers the provider's own reject option and keeps the denial as durable evidence", async () => {
  const dir = newTmp("reject");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: {
      permission: permissionParams(),
      updates: [
        { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed", content: { type: "text", text: "Permission denied by the user." } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The edit was not applied." } }
      ],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records }));
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    claimApprovalDecision(root, decisionFor("reject_once"));
    const code = await pending;
    assert.equal(code, 0, "the CLI's own stop reason for a denied tool is end_turn");
    assert.deepEqual(server.permissionAnswers, [{ outcome: { outcome: "selected", optionId: "reject_once" } }]);
    const terminal = terminalOf(records);
    assert.ok(terminal);
    assert.equal(terminal.finish_reason, "permission_denied", "the denied operation stays visible on the completed turn");
    assert.equal(terminal.approval_outcome, "rejected", "only the real selected reject option proves the human rejection");
    assert.equal(terminal.finalText, "The edit was not applied.");
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal cancel while an approval is pending clears the pending file, tells the CLI, and terminates as interrupted", async () => {
  const dir = newTmp("cancel");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: { permission: permissionParams(), result: { stopReason: "cancelled" } }
  });
  const records: Record<string, unknown>[] = [];
  const signalHandlers: Array<() => void> = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(
      bridgeArgs({ attempt }),
      bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records, signalHandlers })
    );
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    assert.equal(signalHandlers.length, 1);
    signalHandlers[0]?.();
    const code = await pending;
    assert.equal(code, 130);
    assert.deepEqual(server.permissionAnswers, [{ outcome: { outcome: "cancelled" } }], "a cancelled wait answers the CLI immediately");
    assert.equal(fs.existsSync(requestFile), false, "no pending approval outlives the cancellation");
    assert.ok(
      records.some((record) => record.type === "approval" && record.phase === "resolved" && record.decision === "cancelled")
    );
    assert.ok(server.clientNotifications.some((notification) => notification.method === "session/cancel"));
    const terminal = terminalOf(records);
    assert.ok(terminal);
    assert.equal(terminal.stop_reason, "cancelled");
    assert.equal(terminal.is_error, true);
    assert.equal(
      terminal.approval_outcome,
      "cancelled",
      "an abandoned wait is carried as its own proven cause, never as a human decision"
    );
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Complete operation detail: separately supplied shell arguments
// ---------------------------------------------------------------------------

/**
 * The installed CLI's own structured `shell_command` permission request
 * (captured from the real CLI 1.74.1: `kind=execute`, `title="Shell: node"`,
 * `rawInput={command:"node",args:["--version"],description,cwd}`). The CLI's
 * own title uses only `command`, so the arguments are visible ONLY through
 * `rawInput.args`.
 */
function executePermissionParams(rawInput: Record<string, unknown>, title = "Shell: node"): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    toolCall: { toolCallId: "call-exec-1", title, kind: "execute", status: "pending", rawInput },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Always reject", kind: "reject_always" }
    ]
  };
}

test("the provider's separately supplied shell arguments are shown as their own bounded detail entries, never dropped", async () => {
  const dir = newTmp("execargs");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: {
      permission: executePermissionParams({
        command: "node",
        args: ["wait-for-resume.cjs"],
        cwd: "C:/tmp/disposable/workspace",
        description: "Run the resume wait script"
      }),
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records }));
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    const approval = readPendingApproval(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    assert.ok(approval);
    assert.equal(approval.toolName, "execute");
    assert.equal(approval.detail?.command, "node", "the provider's own command string is preserved");
    assert.deepEqual(approval.detail?.args, ["wait-for-resume.cjs"], "the separately supplied argument survives");
    assert.equal(approval.detail?.description, "Run the resume wait script", "the provider's own description is carried");
    assert.equal(approval.detail?.cwd, "C:/tmp/disposable/workspace");
    assert.equal(approval.detail?.truncated, false);
    assert.equal(approval.detail?.redacted, false);

    // The pending stream record carries the SAME canonical detail to the worker.
    const pendingRecord = records.find((record) => record.type === "approval" && record.phase === "pending");
    assert.ok(pendingRecord, "the pending approval is published on the bridge stream");
    assert.deepEqual((pendingRecord.approval as Record<string, unknown>).detail, approval.detail);

    // The human decision path is unchanged: the CLI's own option id answers it.
    assert.equal(server.permissionAnswers.length, 0, "no answer before the human decision");
    const claim = claimApprovalDecision(root, decisionFor("allow_once"));
    assert.equal(claim.claimed, true);
    assert.equal(await pending, 0);
    assert.deepEqual(server.permissionAnswers, [{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
    assert.equal(fs.existsSync(requestFile), false, "the consumed request file is cleared");
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversized or multiline command detail is bounded/redacted truthfully instead of being dropped before the shared sanitizer", async () => {
  const dir = newTmp("execdetail");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: {
      permission: executePermissionParams({
        // Over the 600 display bound: it must be shown truncated, not dropped.
        command: "node " + "x".repeat(700),
        // A multiline argument keeps its own newline; a credential split across
        // two argv elements (`--api-key` + value) is redacted like the joined
        // command line would be.
        args: ["first line\nsecond line", "--api-key", "sk-dummy-sentinel-0123456789"],
        cwd: "C:/tmp/disposable"
      }),
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "detail recorded" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records }));
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    const approval = readPendingApproval(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    assert.ok(approval);
    assert.equal(approval.detail?.truncated, true, "an oversized command is marked truncated");
    assert.equal(approval.detail?.command?.length, 600, "the command is bounded, never dropped");
    assert.deepEqual(approval.detail?.args, ["first line\nsecond line", "--api-key", "<redacted>"], "argv boundaries and whitespace survive; the split credential value does not");
    assert.equal(approval.detail?.redacted, true, "the cross-element credential is marked redacted");
    assert.equal(JSON.stringify(approval.detail).includes("sk-dummy-sentinel-0123456789"), false, "the sentinel never reaches the durable detail");
    claimApprovalDecision(root, decisionFor("reject_once"));
    assert.equal(await pending, 0);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a provider command above the sanity scan bound is marked truncated even after cleanup shortens the visible remainder", async () => {
  const dir = newTmp("scancut");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const server = new FakeCcAcpServer({
    prompt: {
      // Over APPROVAL_DETAIL_SCAN_CAP: the bridge must hand the RAW provider
      // string to the shared sanitizer, which cuts it at the scan bound. The
      // trailing spaces are then trimmed away, so the visible remainder is the
      // short `node` — and the detail must STILL be honestly truncated (the
      // parent-reported case), with another field keeping it usable.
      permission: executePermissionParams({
        command: "node" + " ".repeat(APPROVAL_DETAIL_SCAN_CAP + 100),
        args: ["ok"],
        cwd: "C:/tmp/disposable"
      }),
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "scan cut" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const attempt = { jobId: JOB_ID, generation: GENERATION, dataRoot: root };
  try {
    const pending = runCcAcpBridge(bridgeArgs({ attempt }), bridgeIo(server, { env: { JOBQUAY_HUB_URL: hub.url }, records }));
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending approval file");
    const approval = readPendingApproval(root, JOB_ID, GENERATION, String(PERMISSION_REQUEST_ID));
    assert.ok(approval);
    assert.equal(approval.detail?.command, "node", "cleanup still trims the displayed command");
    assert.deepEqual(approval.detail?.args, ["ok"], "another field keeps the detail usable");
    assert.equal(approval.detail?.truncated, true, "the scan cut is marked even though the visible remainder is short");
    claimApprovalDecision(root, decisionFor("reject_once"));
    assert.equal(await pending, 0);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sessions: resume, load fallback, replay
// ---------------------------------------------------------------------------

test("an existing session resumes over ACP; replayed history is never translated into this attempt's stream", async () => {
  const server = new FakeCcAcpServer({
    attachReplay: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD GENERATION OUTPUT" } }],
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new answer" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing" }),
    bridgeIo(server, { prompt: "Continue", records })
  );
  assert.equal(code, 0);
  assert.equal(server.methods.includes("session/new"), false);
  assert.equal(server.methods[1], "session/resume");
  assert.deepEqual(server.requests[1]?.params, { sessionId: "session-existing", cwd: process.cwd(), mcpServers: [] });
  assert.equal(eventsOf(records)[0]?.session_id, "session-existing");
  const deltas = eventsOf(records).filter((event) => event.type === "text_delta").map((event) => event.delta);
  assert.deepEqual(deltas, ["new answer"], "the replayed history is not duplicated as new output");
  assert.equal(terminalOf(records)?.finalText, "new answer");
});

test("a capability that publishes resume but not the method falls back to session/load exactly once", async () => {
  const server = new FakeCcAcpServer({
    attachError: { method: "session/resume", code: -32601, message: "Method not found" },
    attach: defaultAttach({ sessionId: "session-existing" }),
    prompt: {
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "loaded" } }],
      result: { stopReason: "end_turn" }
    }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing" }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 0);
  assert.deepEqual(server.methods.slice(0, 3), ["initialize", "session/resume", "session/load"]);
});

test("a CLI that publishes neither resume nor load refuses to pretend the session continued", async () => {
  const server = new FakeCcAcpServer({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: {} } }
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(
    bridgeArgs({ resumeSessionId: "session-existing" }),
    bridgeIo(server, { records })
  );
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/resume"), false);
  assert.match(String(terminalOf(records)?.error ?? ""), /cannot be continued over ACP/);
});

// ---------------------------------------------------------------------------
// Unprovable configuration fails clearly
// ---------------------------------------------------------------------------

test("a model the CLI does not offer fails before the prompt", async () => {
  const server = new FakeCcAcpServer({});
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ model: "nobody/unknown-model" }), bridgeIo(server, { records }));
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/prompt"), false);
  assert.match(String(terminalOf(records)?.error ?? ""), /not offered/);
});

test("an effort the model does not publish fails before the prompt", async () => {
  const server = new FakeCcAcpServer({
    attach: defaultAttach({ configOptions: [MODEL_OPTION, { ...EFFORT_OPTION, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] }] })
  });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ effort: "max" }), bridgeIo(server, { records }));
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/prompt"), false);
  assert.match(String(terminalOf(records)?.error ?? ""), /does not support reasoning effort/);
});

test("a model with no effort option at all refuses a requested effort instead of silently dropping it", async () => {
  const server = new FakeCcAcpServer({ attach: defaultAttach({ configOptions: [MODEL_OPTION] }) });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs({ effort: "high" }), bridgeIo(server, { records }));
  assert.equal(code, 1);
  assert.equal(server.methods.includes("session/prompt"), false);
  assert.match(String(terminalOf(records)?.error ?? ""), /no reasoning effort setting/);
});

test("a session state without model/mode evidence is an honest failure, never an assumed success", async () => {
  const server = new FakeCcAcpServer({ attach: { sessionId: SESSION_ID } });
  const records: Record<string, unknown>[] = [];
  const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
  assert.equal(code, 1);
  assert.match(String(terminalOf(records)?.error ?? ""), /cannot be verified/);
});

// ---------------------------------------------------------------------------
// Terminal classification
// ---------------------------------------------------------------------------

const TERMINAL_CASES: Array<{
  name: string;
  script: ServerScript;
  expectCode: number;
  expectSubtype?: string;
  expectStopReason?: string;
  expectFinishReason?: string;
}> = [
  {
    name: "max_turn_requests is the resumable segment boundary (exit 8)",
    script: { prompt: { result: { stopReason: "max_turn_requests" } } },
    expectCode: 8,
    expectSubtype: "max_turns",
    expectStopReason: "max_turn_requests"
  },
  {
    name: "cancelled maps to the official interrupted code (130)",
    script: { prompt: { result: { stopReason: "cancelled" } } },
    expectCode: 130,
    expectStopReason: "cancelled"
  },
  {
    name: "a prompt result with no stop reason is an error, never a guessed success",
    script: { prompt: { result: {} } },
    expectCode: 1
  },
  {
    name: "an unknown stop reason is an error, never a guessed success",
    script: { prompt: { result: { stopReason: "a_new_thing" } } },
    expectCode: 1
  },
  {
    name: "end_turn with no assistant output is the CLI's own no-response class (9)",
    script: { prompt: { result: { stopReason: "end_turn" } } },
    expectCode: 9
  },
  {
    name: "a structured RATE_LIMITED error is the ONE fallback-eligible class (5)",
    script: { prompt: { error: { code: -32603, message: "The model request failed", data: { code: "RATE_LIMITED", status: 429 } } } },
    expectCode: 5
  },
  {
    name: "PREMIUM_CREDITS_EXHAUSTED is quota exhaustion (10), never a rate limit",
    script: { prompt: { error: { code: -32603, message: "Insufficient credits", data: { code: "PREMIUM_CREDITS_EXHAUSTED" } } } },
    expectCode: 10
  },
  {
    name: "an auth-required initialize is the official auth code (3)",
    script: { initializeError: { code: -32000, message: "Authentication required" } },
    expectCode: 3
  },
  {
    name: "a server-side 503 is the official server code (7)",
    script: { prompt: { error: { code: -32603, message: "upstream failed", data: { status: 503 } } } },
    expectCode: 7
  },
  {
    name: "an unclassified turn error is the no-response class (9), never a rate limit",
    script: { prompt: { error: { code: -32603, message: "something odd" } } },
    expectCode: 9
  },
  {
    name: "a child that exits with its own code during the prompt is classified with that code",
    script: { prompt: { exitCode: 7 } },
    expectCode: 7,
    expectFinishReason: "provider_exit"
  }
];

for (const terminalCase of TERMINAL_CASES) {
  test(terminalCase.name, async () => {
    const server = new FakeCcAcpServer(terminalCase.script);
    const records: Record<string, unknown>[] = [];
    const code = await runCcAcpBridge(bridgeArgs(), bridgeIo(server, { records }));
    assert.equal(code, terminalCase.expectCode);
    const terminal = terminalOf(records);
    assert.ok(terminal, "a terminal record is always published");
    assert.equal(terminal.is_error, true);
    if (terminalCase.expectSubtype) assert.equal(terminal.subtype, terminalCase.expectSubtype);
    if (terminalCase.expectStopReason) assert.equal(terminal.stop_reason, terminalCase.expectStopReason);
    if (terminalCase.expectFinishReason) assert.equal(terminal.finish_reason, terminalCase.expectFinishReason);
  });
}

// ---------------------------------------------------------------------------
// Pure argv contract of the bridge itself
// ---------------------------------------------------------------------------

test("the bridge argv round-trips validated values and refuses unsafe tokens", () => {
  const argv = buildCcAcpBridgeArgv({
    cliPath: "C:/Program Files/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    effort: "high",
    resumeSessionId: "session-abc",
    effortDefaultProven: true,
    attempt: { jobId: JOB_ID, generation: GENERATION, dataRoot: "C:/data root" }
  });
  assert.equal(argv.includes("--effort-default-proven"), true, "the value-less provenance flag is carried");
  const parsed = parseCcAcpBridgeArgv(argv);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.args, {
    cliPath: "C:/Program Files/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    effort: "high",
    resumeSessionId: "session-abc",
    effortDefaultProven: true,
    attempt: { jobId: JOB_ID, generation: GENERATION, dataRoot: "C:/data root" }
  });
  // No prompt is ever an argv token.
  assert.equal(argv.includes("Do the task"), false);
  // The flag is OPTIONAL: absent means unproven (false), never true.
  const withoutFlag = parseCcAcpBridgeArgv(["--cli", "/c", "--model", "deepseek/deepseek-v4-flash", "--permission", "standard"]);
  assert.equal(withoutFlag.ok && withoutFlag.args.effortDefaultProven, false, "an absent provenance flag is unproven");
  // The documented `default` synonym resolves to the canonical `standard` at
  // the bridge argv boundary too (one provider normalization function).
  const synonym = parseCcAcpBridgeArgv(["--cli", "/c", "--model", "deepseek/deepseek-v4-flash", "--permission", "default"]);
  assert.equal(synonym.ok && synonym.args.permissionMode, "standard", "the documented default synonym resolves to standard");

  for (const bad of [
    ["--model"],
    ["--model", "bad model"],
    ["--model", "deepseek/deepseek-v4-flash", "--permission", "auto"],
    ["--model", "deepseek/deepseek-v4-flash", "--effort", "minimal"],
    ["--model", "deepseek/deepseek-v4-flash", "--resume", "bad session!"],
    ["--model", "deepseek/deepseek-v4-flash", "--unknown", "x"],
    ["--model", "deepseek/deepseek-v4-flash", "--job-id", "bad id", "--generation", "1", "--data-root", "C:/x"],
    ["--model", "deepseek/deepseek-v4-flash", "--generation", "1"],
    ["--model", "deepseek/deepseek-v4-flash", "--job-id", "job-1", "--generation", "-1", "--data-root", "C:/x"],
    ["--model", "deepseek/deepseek-v4-flash", "--effort-default-proven", "--effort-default-proven"]
  ] as const) {
    const result = parseCcAcpBridgeArgv(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// The production adapter entry
// ---------------------------------------------------------------------------

test("the production provider entry launches the ACP bridge (never a print-mode process) with the validated values", () => {
  const adapter = createCommandCodeAdapter();
  const plan = adapter.buildRunPlan({
    cliPath: "C:/fake/bin/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    publishedPermissionModes: ["standard", "plan", "accept-edits", "yolo"],
    effort: "high",
    effortSupported: true,
    attempt: { jobId: JOB_ID, generation: GENERATION, dataRoot: "C:/data-root" }
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  // The child process is THIS Node runtime running the CrewDispatch bridge; the
  // official CLI is spawned by the bridge as `cmdc acp`.
  assert.equal(plan.plan.file, process.execPath);
  const bridgePath = plan.plan.args[0] ?? "";
  assert.ok(bridgePath.endsWith(path.join("providers", "command-code", "acp-bridge.js")), bridgePath);
  assert.equal(fs.existsSync(bridgePath), true, "the compiled bridge exists");
  // No print-mode branch: no `-p`, no `--output-format`.
  assert.equal(plan.plan.args.includes("-p"), false);
  assert.equal(plan.plan.args.includes("--output-format"), false);
  assert.equal(plan.plan.args.includes("--yolo"), false);
  // The validated values and the attempt identity travel to the bridge.
  assert.deepEqual(plan.argv, [
    "--cli", "C:/fake/bin/cmdc.cmd",
    "--model", "deepseek/deepseek-v4-flash",
    "--permission", "standard",
    "--effort", "high",
    "--job-id", JOB_ID,
    "--generation", String(GENERATION),
    "--data-root", "C:/data-root"
  ]);

  // The documented `default` synonym is accepted by the SAME published-list
  // check and produces the IDENTICAL bridge argv as the canonical `standard`:
  // standard approval behavior, never a different/broader permission.
  const synonymPlan = adapter.buildRunPlan({
    cliPath: "C:/fake/bin/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "default",
    publishedPermissionModes: ["standard", "plan", "accept-edits", "yolo"],
    effort: "high",
    effortSupported: true,
    attempt: { jobId: JOB_ID, generation: GENERATION, dataRoot: "C:/data-root" }
  });
  assert.equal(synonymPlan.ok, true);
  assert.ok(synonymPlan.ok && !synonymPlan.argv.includes("--yolo"));
  assert.deepEqual(synonymPlan.ok ? synonymPlan.argv : null, plan.argv);

  // Proven model-default provenance travels to the bridge as a value-less flag;
  // an absent hint adds nothing (the bridge stays strictly guarded).
  const resumed = adapter.buildRunPlan({
    cliPath: "C:/fake/bin/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    publishedPermissionModes: ["standard", "plan", "accept-edits", "yolo"],
    effort: null,
    effortSupported: true,
    resumeSessionId: "session-abc",
    effortDefaultProven: true,
    attempt: { jobId: JOB_ID, generation: GENERATION, dataRoot: "C:/data-root" }
  });
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.deepEqual(resumed.argv, [
      "--cli", "C:/fake/bin/cmdc.cmd",
      "--model", "deepseek/deepseek-v4-flash",
      "--permission", "standard",
      "--resume", "session-abc",
      "--effort-default-proven",
      "--job-id", JOB_ID,
      "--generation", String(GENERATION),
      "--data-root", "C:/data-root"
    ]);
  }
});

test("the production entry refuses an invalid model/effort before any process exists", () => {
  const adapter = createCommandCodeAdapter();
  const badModel = adapter.buildRunPlan({ cliPath: "C:/fake/cmdc.cmd", model: "bad model", permissionMode: "standard" });
  assert.equal(badModel.ok, false);
  assert.equal(badModel.ok === false && badModel.stage, "argv");
  // A level outside THIS model's own published list is refused before spawn.
  const badEffort = adapter.buildRunPlan({
    cliPath: "C:/fake/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    effort: "max",
    effortSupported: true,
    supportedEfforts: ["low", "high"]
  });
  assert.equal(badEffort.ok, false);
  const noEffortSupport = adapter.buildRunPlan({
    cliPath: "C:/fake/cmdc.cmd",
    model: "deepseek/deepseek-v4-flash",
    permissionMode: "standard",
    effort: "high",
    effortSupported: false
  });
  assert.equal(noEffortSupport.ok, false);
});

test("the provider's own stream parser consumes approval records and still folds the canonical terminal and usage", () => {
  const adapter = createCommandCodeAdapter();
  const state = adapter.createStreamState();
  const pending = {
    version: 1,
    kind: "tool_approval",
    provider: "command-code",
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: "7777",
    toolName: "edit",
    summary: null,
    detail: { title: "Edit: note.txt", command: null, path: "C:/note.txt", cwd: null, description: null, gate: null, reason: null, truncated: false, redacted: false },
    options: [{ id: "allow_once", kind: "allow_once", label: "Allow once" }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };
  const lines = [
    JSON.stringify({ type: "event", event: { type: "init", session_id: SESSION_ID, model: "deepseek/deepseek-v4-flash" } }),
    JSON.stringify({ type: "event", event: { type: "turn_start" } }),
    JSON.stringify({ type: "event", event: { type: "text_delta", delta: "working" } }),
    JSON.stringify({ type: "approval", phase: "pending", approval: pending }),
    JSON.stringify({ type: "event", event: { type: "usage", tokensIn: 10, tokensOut: 2 } }),
    JSON.stringify({ type: "event", event: { type: "turn_end" } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", finalText: "working" })
  ];
  for (const line of lines) adapter.parseStreamLine(line, state);
  assert.ok(state.approval, "the pending approval is part of the canonical state");
  assert.equal(state.approval?.requestId, "7777");
  const usage = adapter.normalizeUsage(state);
  assert.equal(usage.tokensIn, 10);
  assert.equal(usage.tokensOut, 2);
  assert.equal(usage.decodeTokens, null);
  assert.equal(state.terminal, true);
  assert.equal(state.finalResult, "working");
  assert.equal(state.sessionId, SESSION_ID);

  // A resolved record for the SAME request clears it; a resolved record for a
  // DIFFERENT request never does.
  adapter.parseStreamLine(JSON.stringify({ type: "approval", phase: "resolved", request_id: "other", option_id: null, decision: "cancelled" }), state);
  assert.ok(state.approval, "a foreign resolution never retires the current request");
  adapter.parseStreamLine(JSON.stringify({ type: "approval", phase: "resolved", request_id: "7777", option_id: "allow_once", decision: "selected" }), state);
  assert.equal(state.approval, null);
});

test("the canonical stream state reads only a bounded approval_outcome token and keeps missing evidence null", () => {
  const adapter = createCommandCodeAdapter();
  const outcomeOf = (record: Record<string, unknown>): string | null => {
    const state = adapter.createStreamState();
    adapter.parseStreamLine(JSON.stringify(record), state);
    return state.approvalOutcome;
  };
  // The canonical snake_case key the bridges write.
  assert.equal(outcomeOf({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", approval_outcome: "rejected" }), "rejected");
  assert.equal(outcomeOf({ type: "result", subtype: "error", is_error: true, stop_reason: "cancelled", approval_outcome: "expired" }), "expired");
  // The camelCase spelling is accepted for symmetry with the other canonical fields.
  assert.equal(outcomeOf({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", approvalOutcome: "no_route" }), "no_route");
  // A missing token (a legacy/recorded stream) stays null — never inferred.
  assert.equal(outcomeOf({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", finish_reason: "permission_denied" }), null);
  // An arbitrary provider payload can never become a token.
  assert.equal(outcomeOf({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", approval_outcome: "the user said no" }), null);
  assert.equal(outcomeOf({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", approval_outcome: 42 }), null);
});

test("boundedOneLine strips control sequences, collapses whitespace and caps the length", () => {
  assert.equal(boundedOneLine("a\u001b[31mred\u001b[0m\nb"), "ared b");
  assert.equal(boundedOneLine("x".repeat(500))?.length, 400);
  assert.equal(boundedOneLine("   \n\t  "), null);
  assert.equal(boundedOneLine(42), null);
});
