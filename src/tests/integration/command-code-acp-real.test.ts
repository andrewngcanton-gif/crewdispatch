// command-code-acp-real.test.ts — the REAL production chain for the Command Code
// ACP migration.
//
// The chain under test is the production one: the built MCP stdio entry
// dispatches through the independent local daemon, which owns the detached
// worker; the worker drives the REAL `command-code` adapter, whose run plan
// launches the REAL CrewDispatch ACP bridge; the bridge spawns the resolved CLI
// as `cmdc acp` through the Windows-safe shell-free spawn plan. Only the CLI
// process itself is a fixture — a scripted ACP server that speaks the installed
// CLI's own wire shapes (permission options, `{sessionId, toolCall, options}`,
// the `{outcome:{outcome,optionId}}` reply, `session/update`, the prompt
// result). No in-process shortcut replaces the transport.
//
// What this proves end to end:
//   * while an approval is pending the target file is UNCHANGED;
//   * a REAL Hub decision (the production approval route) answers the provider's
//     OWN request with its OWN option id, and only then does the intended edit
//     happen, in the SAME job generation/session;
//   * a rejection leaves the file unchanged, records the provider's own denial
//     evidence, and never retries with stronger permissions;
//   * two concurrent jobs in two directories with COLLIDING provider request ids
//     never cross;
//   * a follow-up continues the ACTUAL session over ACP (session/resume) in a
//     new generation;
//   * usage travels the real path (turn counters, cache, session-cumulative USD
//     cost reconciled to deltas) while Decode stays null — the ACP surface
//     publishes no model-request boundary (the recorded acceptance gap).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { startHub, type HubHandle } from "../../hub/server";
import { loadJob, readApprovalNotificationResult, readNotificationResult } from "../../jobs/store";
import { approvalDecisionPath, approvalRequestPath, readApprovalDecision, readPendingApproval } from "../../jobs/approval";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const PROVIDER = "command-code";
const MODEL = "fixture/model-a";
const EFFORT = "high";
const REQUEST_ID = "7777";
const NOTE_NAME = "note.txt";
const APPLIED_MARKER = "EDITED_BY_ALLOWED_APPROVAL";
const DENIED_MARKER = "EDIT_NOT_APPLIED_MARKER";
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The fixture CLI: public probes + a scripted ACP server
// ---------------------------------------------------------------------------

/**
 * Write a fake `cmdc` that answers the public probes and then behaves as the
 * installed CLI's own ACP server for ONE turn: it asks for an interactive
 * permission on a REAL edit of `<project>/note.txt` (or, when
 * `FAKE_APPROVAL_SHAPE=execute`, on the installed CLI's own structured
 * `shell_command` shape: `kind=execute`, `command` + separately supplied
 * `args`), performs the effect only when the answer selects an allow option,
 * and answers with the CLI's own prompt-result shape. Every protocol event is
 * appended to a JSONL log so the test can assert the exact configured
 * model/mode/effort and that no second prompt ever ran.
 */
function writeFakeAcpCli(dir: string): { shim: string } {
  const js = path.join(dir, "fake-cmdc.cjs");
  const fixture = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const mode = argv[0];
const logPath = path.join(process.cwd(), ".fake-cmdc-acp-log.jsonl");
function logEvent(event) { fs.appendFileSync(logPath, JSON.stringify(event) + "\n"); }
function write(text) { process.stdout.write(text); }

if (mode === "--version") { write("1.74.0-fixture\n"); process.exit(0); }
if (mode === "--help") {
  write([
    "Usage: cmdc [options] [prompt]",
    "  --model <id>              Model id",
    "  --permission-mode <mode>  Default permission mode. Choices: standard, plan, accept-edits, yolo",
    "  --effort <level>          Reasoning effort",
    ""
  ].join("\n"));
  process.exit(0);
}
if (mode === "--list-models") {
  write("fixture/model-a   FREE   Fixture model A (default)\nfixture/model-b   Fixture model B\n");
  process.exit(0);
}
if (mode !== "acp") { process.stderr.write("unsupported argv: " + argv.join(" ") + "\n"); process.exit(2); }

// ---- ACP server ----
// The project directory is the process cwd: the bridge spawns the CLI in the
// JOB's workspace, so two concurrent jobs get two distinct directories (and
// two distinct logs) without any extra environment.
const project = process.cwd();
const notePath = path.join(project, "note.txt");
const execMarkerPath = path.join(project, "executed.txt");
const approvalShape = process.env.FAKE_APPROVAL_SHAPE === "execute" ? "execute" : "edit";
let sessionId = "fixture-session-1";
let currentModel = "fixture/model-a";
let currentMode = "default";
// The installed CLI republishes its own config state (model + effort) after
// every change; the bridge verifies the requested effort against THIS reported
// state before prompting, so the fixture must mirror it rather than ack blindly.
let currentEffort = "default";
let buffer = "";
const pending = new Map();

function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(update) { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }); }
function attachState() {
  return {
    sessionId,
    modes: {
      currentModeId: currentMode,
      availableModes: [
        { id: "default", name: "Standard" },
        { id: "auto-accept", name: "Accept Edits" },
        { id: "plan", name: "Plan" },
        { id: "dont-ask", name: "Don't Ask" },
        { id: "bypass", name: "Bypass Permissions" }
      ]
    },
    models: {
      currentModelId: currentModel,
      availableModels: [
        { modelId: "fixture/model-a", name: "Fixture A" },
        { modelId: "fixture/model-b", name: "Fixture B" }
      ]
    },
    configOptions: [
      { id: "model", category: "model", type: "select", currentValue: currentModel, options: [{ value: "fixture/model-a" }, { value: "fixture/model-b" }] },
      { id: "effort", category: "thought_level", type: "select", currentValue: currentEffort, options: [{ value: "low" }, { value: "medium" }, { value: "high" }] }
    ]
  };
}

async function handlePrompt(requestId, params) {
  const text = Array.isArray(params.prompt) && params.prompt[0] ? params.prompt[0].text : null;
  logEvent({ kind: "prompt", text, model: currentModel, mode: currentMode, sessionId });
  notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "considering the request" } });
  // The installed CLI 1.74.1 raises BOTH shapes over ACP. In the structured
  // shell shape its own title uses only "command", so the separately supplied
  // "args" are visible ONLY in rawInput.
  const toolCall = approvalShape === "execute"
    ? {
        toolCallId: "call-exec-1",
        title: "Shell: node",
        kind: "execute",
        status: "pending",
        rawInput: { command: "node", args: ["wait-for-resume.cjs"], cwd: project, description: "Run the resume wait script" }
      }
    : {
        toolCallId: "call-1",
        title: "Edit: note.txt",
        kind: "edit",
        status: "pending",
        rawInput: { file_path: notePath, old_string: "hello", new_string: "EDITED" }
      };
  notify({ sessionUpdate: "tool_call", ...toolCall });
  const permissionId = 7777;
  const answer = new Promise((resolve) => pending.set(permissionId, resolve));
  send({
    jsonrpc: "2.0",
    id: permissionId,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall,
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        { optionId: "reject_always", name: "Always reject", kind: "reject_always" }
      ]
    }
  });
  const reply = await answer;
  const outcome = reply && reply.outcome ? reply.outcome : {};
  const optionId = outcome.outcome === "selected" ? outcome.optionId : null;
  logEvent({ kind: "answer", optionId, sessionId });
  if (optionId === "allow_once" || optionId === "allow_always") {
    if (approvalShape === "execute") {
      // The fixture performs the same observable effect the allowed command
      // would (a disposable marker in this test's own workspace); the real
      // command execution is the CLI's business, not CrewDispatch's.
      fs.writeFileSync(execMarkerPath, "EXECUTED_BY_ALLOWED_APPROVAL");
    } else {
      fs.writeFileSync(notePath, "EDITED_BY_ALLOWED_APPROVAL");
    }
    notify({ sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed", content: { type: "text", text: "operation applied" } });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: approvalShape === "execute" ? "EXEC_APPLIED_MARKER" : "EDIT_APPLIED_MARKER" } });
  } else {
    notify({ sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "failed", content: { type: "text", text: "Permission denied by the user." } });
    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "EDIT_NOT_APPLIED_MARKER" } });
  }
  notify({ sessionUpdate: "usage_update", used: 1234, size: 200000, cost: { amount: 0.004, currency: "USD" } });
  respond(requestId, {
    stopReason: "end_turn",
    _meta: { usage: { inputTokens: 111, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 4 } }
  });
}

function handleRequest(method, params, id) {
  if (method === "initialize") {
    respond(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {}, close: {} } } });
    return;
  }
  if (method === "session/new") { logEvent({ kind: "new" }); respond(id, attachState()); return; }
  if (method === "session/resume") { logEvent({ kind: "resume", sessionId: params.sessionId }); respond(id, attachState()); return; }
  if (method === "session/load") { logEvent({ kind: "load", sessionId: params.sessionId }); respond(id, attachState()); return; }
  if (method === "session/set_model") { currentModel = params.modelId; logEvent({ kind: "model", value: params.modelId }); respond(id, attachState()); return; }
  if (method === "session/set_config_option") { currentEffort = params.value; logEvent({ kind: "effort", value: params.value }); respond(id, attachState()); return; }
  if (method === "session/set_mode") { currentMode = params.modeId; logEvent({ kind: "mode", value: params.modeId }); respond(id, {}); return; }
  if (method === "session/close") { respond(id, {}); return; }
  if (method === "session/prompt") { void handlePrompt(id, params); return; }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method !== undefined) {
      if (message.id !== undefined) handleRequest(message.method, message.params || {}, message.id);
      continue;
    }
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.result !== undefined ? message.result : { error: message.error }); }
  }
});
process.stdin.on("end", () => { process.exit(0); });
`;
  fs.writeFileSync(js, fixture, "utf8");
  if (process.platform === "win32") {
    const shim = path.join(dir, "fake-cmdc.cmd");
    fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nendLocal & node "%dp0%\\fake-cmdc.cjs" %*\r\n`, "utf8");
    return { shim };
  }
  const shim = path.join(dir, "fake-cmdc");
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/fake-cmdc.cjs" "$@"\n`, "utf8");
  fs.chmodSync(shim, 0o755);
  return { shim };
}

function logFor(project: string): string {
  return path.join(project, ".fake-cmdc-acp-log.jsonl");
}

function readLog(logPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Workspace / harness helpers
// ---------------------------------------------------------------------------

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

function newWorkspace(name: string, extraEnv: NodeJS.ProcessEnv = {}): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-cc-acp-real-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const { shim } = writeFakeAcpCli(dir);
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: shim,
    ...extraEnv
  };
  return {
    dir,
    root,
    project,
    env,
    cleanup: () => McpStdioClient.cleanupWorkspace(root, dir)
  };
}

interface Listener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

function startListener(): Promise<Listener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/wake`,
        bodies,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

async function waitBodies(listener: Listener, n: number, timeoutMs = 90000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listener.bodies.length < n) {
    if (Date.now() >= deadline) throw new Error(`expected ${n} callback bodies, saw ${listener.bodies.length}`);
    await sleep(100);
  }
}

type LoadedJob = NonNullable<ReturnType<typeof loadJob>>;

async function waitJob(root: string, id: string, predicate: (job: LoadedJob) => boolean, timeoutMs = 90000): Promise<LoadedJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && predicate(job)) return job;
    if (Date.now() >= deadline) {
      const last = loadJob(root, id);
      throw new Error(
        `timed out waiting for ${id}; last status=${last?.status} generation=${last?.generation} ` +
          `error=${last?.error} failureKind=${last?.failureKind} stopReason=${last?.stopReason}`
      );
    }
    await sleep(100);
  }
}

async function startIsolatedHub(root: string): Promise<{ hub: HubHandle; url: string }> {
  const hub = startHub({ root, host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("listening", () => resolve());
    hub.server.once("error", reject);
  });
  return { hub, url: `http://127.0.0.1:${hub.port}` };
}

async function resolveApprovalInHub(
  hubUrl: string,
  jobId: string,
  generation: number,
  requestId: string,
  optionId: string
): Promise<void> {
  const response = await fetch(`${hubUrl}/api/jobs/${encodeURIComponent(jobId)}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation, request_id: requestId, option_id: optionId })
  });
  assert.equal(response.status, 200, `the Hub resolved the approval (${response.status})`);
}

function spawnCommandCodeJob(
  client: McpStdioClient,
  input: { task: string; cwd: string; model?: string; permissionMode?: string; effort?: string; callbackUrl?: string }
): Promise<Record<string, unknown>> {
  return client
    .callTool("crewdispatch_spawn", {
      task: input.task,
      cwd: input.cwd,
      provider: PROVIDER,
      model: input.model ?? MODEL,
      permission_mode: input.permissionMode ?? "standard",
      effort: input.effort ?? EFFORT,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {})
    })
    .then((result) => McpStdioClient.json(result));
}

async function withChain<T>(ws: Workspace, fn: (ctx: { client: McpStdioClient; hubUrl: string; hub: HubHandle }) => Promise<T>): Promise<T> {
  const { hub, url } = await startIsolatedHub(ws.root);
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    return await fn({ client, hubUrl: url, hub });
  } finally {
    await client.close().catch(() => undefined);
    hub.server.closeAllConnections?.();
    await new Promise<void>((resolve) => hub.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// Approve: pending = no edit; allow_once = the intended edit, same session
// ---------------------------------------------------------------------------

test(
  "a standard-mode Command Code job pauses with the file unchanged; a real Hub allow_once performs ONLY the intended edit in the same session",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("approve");
    const listener = await startListener();
    const notePath = path.join(ws.project, NOTE_NAME);
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawned = await spawnCommandCodeJob(client, {
          task: "Apply the approved edit to note.txt",
          cwd: ws.project,
          callbackUrl: listener.url
        });
        const id = String(spawned.job_id);
        assert.equal(spawned.accepted, true);

        // The original dispatcher receives exactly ONE typed approval event.
        await waitBodies(listener, 1);
        const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
        assert.equal(body.event, "approval_required");
        assert.equal(body.job_id, id);
        assert.equal(body.provider, PROVIDER);
        assert.equal(body.generation, 0);
        assert.equal(body.request_id, REQUEST_ID);
        assert.equal(body.tool, "edit", "the CLI's own published tool kind is carried");
        assert.match(String(body.operation ?? ""), /note\.txt/, "the actual operation is carried");
        assert.ok(String(body.hub_url).includes(`/ui?job=${encodeURIComponent(id)}`), "the link targets this exact job");

        // PENDING: the target file must not exist yet, and the job is honestly
        // still running.
        const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        assert.equal(waiting.status, "running");
        assert.equal(fs.existsSync(notePath), false, "no edit happens while the approval is pending");
        const pending = readPendingApproval(ws.root, id, 0, REQUEST_ID);
        assert.ok(pending, "the provider's request is materialized for the Hub");
        assert.equal(pending!.provider, PROVIDER);
        assert.equal(pending!.toolName, "edit");
        assert.deepEqual(pending!.options.map((option) => option.id), ["allow_once", "allow_always", "reject_once", "reject_always"]);
        const canonicalTarget = (value: string): string =>
          path.join(fs.realpathSync.native(path.dirname(value)), path.basename(value));
        assert.equal(
          canonicalTarget(String(pending!.detail?.path)),
          canonicalTarget(notePath),
          "the exact target path is shown"
        );
        // SEPARATE-PROCESS boundary: this pending record was written by the
        // production Command Code ACP bridge in a detached worker process, which
        // constructs the shared channel WITHOUT a timeout override. The shared
        // one-hour manual-approval default therefore governs the real bridge.
        assert.equal(
          Date.parse(pending!.expiresAt) - Date.parse(pending!.createdAt),
          3_600_000,
          "the real bridge with no override publishes exactly the shared one-hour approval default"
        );
        assert.equal(fs.existsSync(approvalDecisionPath(ws.root, id, 0, REQUEST_ID)), false, "the alert never approves anything");

        // The HUMAN resolves it in the real Hub.
        await resolveApprovalInHub(hubUrl, id, 0, REQUEST_ID, "allow_once");
        const decision = readApprovalDecision(ws.root, id, 0, REQUEST_ID);
        assert.ok(decision, "the decision is durably claimed");
        assert.equal(decision!.optionId, "allow_once");

        const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(
          settled.status,
          "done",
          `status=${settled.status} failureKind=${settled.failureKind} stopReason=${settled.stopReason} error=${settled.error}`
        );
        assert.equal(settled.generation, 0, "the SAME generation continued after the approval");
        assert.equal(settled.sessionId, "fixture-session-1", "the SAME provider session completed");
        assert.equal(settled.pendingApproval, null, "a settled run keeps no stale approval");
        assert.equal(fs.readFileSync(notePath, "utf8"), APPLIED_MARKER, "the intended edit happened exactly once");
        assert.equal(settled.result?.finalText, "EDIT_APPLIED_MARKER");
        // A real ALLOW is not an interruption: the canonical approval-outcome
        // token stays absent so the completed turn reads as a plain success.
        assert.equal(settled.approvalOutcome ?? null, null, "an allowed gate records no approval outcome");
        assert.equal(settled.result?.approvalOutcome ?? null, null, "and the compact result carries none either");

        // The fixture proves the EXACT configuration and that only ONE prompt ran.
        const log = readLog(logFor(ws.project));
        assert.deepEqual(
          log.filter((entry) => entry.kind === "prompt").map((entry) => entry.model),
          [MODEL],
          "exactly one prompt ran, on the requested model"
        );
        // The fixture session starts in the CLI's own Standard mode, so the
        // bridge correctly sets nothing; the prompt itself proves the mode, and
        // no stronger mode was ever selected.
        assert.deepEqual(log.filter((entry) => entry.kind === "prompt").map((entry) => entry.mode), ["default"]);
        assert.equal(log.some((entry) => entry.kind === "mode" && entry.value !== "default"), false);
        assert.deepEqual(log.filter((entry) => entry.kind === "effort").map((entry) => entry.value), [EFFORT], "the requested effort was set");
        assert.deepEqual(log.filter((entry) => entry.kind === "answer").map((entry) => entry.optionId), ["allow_once"]);

        // Usage travelled the real path.
        assert.equal(settled.usage.tokensIn, 111);
        assert.equal(settled.usage.tokensOut, 22);
        assert.equal(settled.usage.cacheRead, 33);
        assert.equal(settled.usage.cacheCreation, 4);
        assert.equal(settled.usage.cacheMiss, 78, "cacheMiss is derived from two REPORTED counters");
        assert.equal(settled.usage.totalCostUsd, 0.004);
        assert.equal(settled.usage.contextUsed, 1234);
        assert.equal(settled.usage.contextWindow, 200000);
        assert.equal(settled.usage.toolCalls, 1);
        // Recorded acceptance gap: the ACP surface publishes no model-request
        // boundary, so Decode is honestly absent rather than synthesized.
        assert.equal(settled.usage.decodeTokens, null);
        assert.equal(settled.usage.decodeSeconds, null);

        // Exactly ONE approval alert + ONE terminal wake.
        await waitBodies(listener, 2);
        await sleep(800);
        assert.equal(listener.bodies.length, 2, "one approval alert + one terminal wake, no duplicates");
        const terminalBody = JSON.parse(listener.bodies[1]!) as Record<string, unknown>;
        assert.equal(terminalBody.status, "done");
        const approvalRecord = readApprovalNotificationResult(ws.root, id, 0, REQUEST_ID);
        assert.equal(approvalRecord?.delivered, true);
        assert.equal(readNotificationResult(ws.root, id, 0)?.delivered, true);
      });
    } finally {
      await listener.close();
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// Execute: the CLI's structured `command` + separately supplied `args`
// ---------------------------------------------------------------------------
// This is the shape the installed CLI really publishes for `node
// wait-for-resume.cjs` (captured from the native wire; see the probe evidence
// noted in the PRD): the title carries only `command`, so the complete
// operation is visible ONLY if the adapter forwards `args` as its own field.
// A dropped `args` would show a human `node` for a real command with
// arguments — the exact acceptance defect this test guards.

test(
  "the structured shell shape keeps the separately supplied args: the pending approval shows the complete operation and an allow runs it",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("execargs", { FAKE_APPROVAL_SHAPE: "execute" });
    const listener = await startListener();
    const markerPath = path.join(ws.project, "executed.txt");
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawned = await spawnCommandCodeJob(client, {
          task: "Run the approved command",
          cwd: ws.project,
          callbackUrl: listener.url
        });
        const id = String(spawned.job_id);
        assert.equal(spawned.accepted, true);

        await waitBodies(listener, 1);
        const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
        assert.equal(body.event, "approval_required");
        assert.equal(body.tool, "execute", "the CLI's own published tool kind is carried");
        const operation = String(body.operation ?? "");
        assert.match(operation, /node/, "the executable is carried");
        assert.match(operation, /wait-for-resume\.cjs/, "the separately supplied argument is carried, not dropped");

        const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        assert.equal(waiting.status, "running");
        assert.equal(fs.existsSync(markerPath), false, "nothing runs while the approval is pending");

        const pending = readPendingApproval(ws.root, id, 0, REQUEST_ID);
        assert.ok(pending, "the provider's request is materialized for the Hub");
        assert.equal(pending!.toolName, "execute");
        assert.equal(pending!.detail?.title, "Shell: node");
        assert.equal(pending!.detail?.command, "node", "the executable is its own field");
        assert.deepEqual(pending!.detail?.args, ["wait-for-resume.cjs"], "the arguments survive as their own entries, never re-joined");
        assert.equal(pending!.detail?.truncated, false, "a short command is not falsely marked truncated");
        assert.equal(pending!.detail?.redacted, false, "a credential-free command is not falsely marked redacted");
        assert.equal(fs.existsSync(approvalDecisionPath(ws.root, id, 0, REQUEST_ID)), false, "the alert never approves anything");

        await resolveApprovalInHub(hubUrl, id, 0, REQUEST_ID, "allow_once");
        const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(
          settled.status,
          "done",
          `status=${settled.status} failureKind=${settled.failureKind} stopReason=${settled.stopReason} error=${settled.error}`
        );
        assert.equal(settled.generation, 0, "the SAME generation continued after the approval");
        assert.equal(settled.sessionId, "fixture-session-1");
        assert.equal(settled.pendingApproval, null);
        assert.equal(fs.readFileSync(markerPath, "utf8"), "EXECUTED_BY_ALLOWED_APPROVAL", "the allowed operation ran exactly once");
        assert.equal(settled.result?.finalText, "EXEC_APPLIED_MARKER");

        const log = readLog(logFor(ws.project));
        assert.deepEqual(log.filter((entry) => entry.kind === "prompt").length, 1, "exactly one prompt ran");
        assert.deepEqual(log.filter((entry) => entry.kind === "answer").map((entry) => entry.optionId), ["allow_once"]);
      });
    } finally {
      await listener.close();
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// Reject: no edit, denial evidence, no retry with stronger permissions
// ---------------------------------------------------------------------------

test(
  "a rejected Command Code gate leaves the file unchanged, keeps the denial evidence, and never retries with stronger permissions",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("reject");
    const notePath = path.join(ws.project, NOTE_NAME);
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawned = await spawnCommandCodeJob(client, { task: "Try the edit and respect a rejection", cwd: ws.project });
        const id = String(spawned.job_id);
        const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        assert.equal(waiting.status, "running");
        assert.equal(fs.existsSync(notePath), false);

        await resolveApprovalInHub(hubUrl, id, 0, REQUEST_ID, "reject_once");
        const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(settled.status, "done", "the CLI's own stop reason for a denied tool is end_turn");
        assert.equal(fs.existsSync(notePath), false, "a rejected edit never touches the file");
        assert.equal(settled.finishReason, "permission_denied", "the denial stays durable evidence");
        // The REAL human rejection is carried as the bounded canonical token on
        // the completed result, so the display can explain that the gated
        // operation did not run instead of reading as an unqualified success.
        assert.equal(settled.approvalOutcome, "rejected", "the real rejection reaches the canonical result");
        assert.equal(settled.result?.approvalOutcome, "rejected", "and the compact result carries it too");
        assert.equal(settled.pendingApproval, null);

        const log = readLog(logFor(ws.project));
        assert.deepEqual(log.filter((entry) => entry.kind === "prompt").length, 1, "no retry with stronger permissions");
        assert.deepEqual(log.filter((entry) => entry.kind === "prompt").map((entry) => entry.mode), ["default"], "the mode never escalated");
        assert.equal(log.some((entry) => entry.kind === "mode" && entry.value !== "default"), false);
        assert.deepEqual(log.filter((entry) => entry.kind === "answer").map((entry) => entry.optionId), ["reject_once"]);
        assert.equal(settled.attempts.length, 1, "no fallback attempt was started by a refusal");
      });
    } finally {
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// The documented `default` synonym: accepted as standard, reaches the SAME
// native approval gate (regression: it used to end plan_error before launch)
// ---------------------------------------------------------------------------

test(
  "a dispatched permission_mode=default is normalized to standard and reaches the same native approval gate",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("defaultsyn");
    const notePath = path.join(ws.project, NOTE_NAME);
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawned = await spawnCommandCodeJob(client, {
          task: "Try the edit dispatched with the documented default synonym",
          cwd: ws.project,
          permissionMode: "default"
        });
        const id = String(spawned.job_id);
        assert.equal(spawned.accepted, true);

        // Pre-fix this dispatch ended `plan_error` before any CLI process
        // existed (the installed CLI's published list has no `default` token).
        // It must now reach the provider's own interactive gate in Standard
        // mode: the file is still untouched while the human decision is open.
        const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        assert.equal(waiting.status, "running");
        assert.equal(fs.existsSync(notePath), false, "standard mode pauses for the human instead of editing");

        const log = readLog(logFor(ws.project));
        assert.deepEqual(
          log.filter((entry) => entry.kind === "prompt").map((entry) => entry.mode),
          ["default"],
          "the canonical standard mode reached the CLI's own native ACP mode id"
        );
        assert.equal(
          log.some((entry) => entry.kind === "mode" && entry.value !== "default"),
          false,
          "the synonym never escalated to a different mode"
        );

        // Resolve the gate as a rejection: no edit, denial evidence, and the
        // job settles normally (no plan_error, no stronger-permission retry).
        await resolveApprovalInHub(hubUrl, id, 0, REQUEST_ID, "reject_once");
        const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(
          settled.status,
          "done",
          `status=${settled.status} failureKind=${settled.failureKind} stopReason=${settled.stopReason} error=${settled.error}`
        );
        assert.equal(settled.finishReason, "permission_denied");
        assert.equal(settled.approvalOutcome, "rejected", "the rejection is carried on the completed result here too");
        assert.equal(fs.existsSync(notePath), false, "a rejected edit never touches the file");
        assert.equal(settled.attempts.length, 1, "no fallback attempt was started");
        assert.equal(settled.pendingApproval, null);
      });
    } finally {
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// Concurrency: colliding provider request ids never cross jobs
// ---------------------------------------------------------------------------

test(
  "two concurrent jobs in two directories with the SAME provider request id resolve independently",
  { timeout: 240000 },
  async () => {
    const ws = newWorkspace("concurrent");
    const projectA = path.join(ws.dir, "project-a");
    const projectB = path.join(ws.dir, "project-b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    const noteA = path.join(projectA, NOTE_NAME);
    const noteB = path.join(projectB, NOTE_NAME);
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawnInto = (cwd: string, task: string): Promise<Record<string, unknown>> =>
          client
            .callTool("crewdispatch_spawn", { task, cwd, provider: PROVIDER, model: MODEL, permission_mode: "standard", effort: EFFORT })
            .then((result) => McpStdioClient.json(result));
        const a = await spawnInto(projectA, "Edit note.txt in project A");
        const b = await spawnInto(projectB, "Edit note.txt in project B");
        const idA = String(a.job_id);
        const idB = String(b.job_id);
        assert.notEqual(idA, idB);

        const waitingA = await waitJob(ws.root, idA, (job) => job.pendingApproval != null);
        const waitingB = await waitJob(ws.root, idB, (job) => job.pendingApproval != null);
        assert.equal(waitingA.pendingApproval?.requestId, REQUEST_ID);
        assert.equal(waitingB.pendingApproval?.requestId, REQUEST_ID, "both providers used the SAME JSON-RPC request id");
        assert.notEqual(
          approvalRequestPath(ws.root, idA, 0, REQUEST_ID),
          approvalRequestPath(ws.root, idB, 0, REQUEST_ID),
          "the request files are scoped by job"
        );
        assert.equal(fs.existsSync(noteA), false);
        assert.equal(fs.existsSync(noteB), false);

        // Resolve A allow, B reject — each decision may only affect its own job.
        await resolveApprovalInHub(hubUrl, idA, 0, REQUEST_ID, "allow_once");
        await resolveApprovalInHub(hubUrl, idB, 0, REQUEST_ID, "reject_once");

        const settledA = await waitJob(ws.root, idA, (job) => TERMINAL.has(job.status));
        const settledB = await waitJob(ws.root, idB, (job) => TERMINAL.has(job.status));
        assert.equal(settledA.status, "done");
        assert.equal(settledB.status, "done");
        assert.equal(fs.readFileSync(noteA, "utf8"), APPLIED_MARKER, "job A performed its own edit");
        assert.equal(fs.existsSync(noteB), false, "job B's rejection never edited anything");
        assert.equal(settledA.finishReason, null);
        assert.equal(settledB.finishReason, "permission_denied");
        assert.equal(settledA.approvalOutcome ?? null, null, "the allowed job records no approval outcome");
        assert.equal(settledB.approvalOutcome, "rejected", "the rejected job records its own, never the other job's");
        assert.equal(settledA.pendingApproval, null);
        assert.equal(settledB.pendingApproval, null);

        const answers = [...readLog(logFor(projectA)), ...readLog(logFor(projectB))].filter((entry) => entry.kind === "answer");
        assert.equal(answers.length, 2, "both provider processes were answered");
        assert.deepEqual(
          answers.map((entry) => entry.optionId).sort(),
          ["allow_once", "reject_once"],
          "each decision used its own job's option"
        );
      });
    } finally {
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// Follow-up: the ACTUAL session continues over ACP
// ---------------------------------------------------------------------------

test(
  "a follow-up continues the ACTUAL ACP session (session/resume) as a new generation",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("followup");
    const notePath = path.join(ws.project, NOTE_NAME);
    try {
      await withChain(ws, async ({ client, hubUrl }) => {
        const spawned = await spawnCommandCodeJob(client, { task: "First turn", cwd: ws.project });
        const id = String(spawned.job_id);
        await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        await resolveApprovalInHub(hubUrl, id, 0, REQUEST_ID, "allow_once");
        const first = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(first.status, "done");
        assert.equal(first.generation, 0);
        assert.equal(first.sessionId, "fixture-session-1");

        // A follow-up on the SAME job must continue the SAME provider session.
        const followed = McpStdioClient.json(await client.callTool("crewdispatch_follow_up", { id, message: "Second turn" }));
        assert.equal(followed.accepted, true);
        // The new generation's own turn asks for its own decision again.
        const waitingSecond = await waitJob(ws.root, id, (job) => job.generation === 1 && job.pendingApproval != null);
        assert.equal(waitingSecond.pendingApproval?.generation, 1, "the approval belongs to the NEW generation");
        await resolveApprovalInHub(hubUrl, id, 1, REQUEST_ID, "allow_once");
        const second = await waitJob(ws.root, id, (job) => job.generation === 1 && TERMINAL.has(job.status));
        assert.equal(second.status, "done");
        assert.equal(second.sessionId, "fixture-session-1", "the SAME session id is carried into the next generation");
        // Both generations were ALLOWED, so neither carries an approval
        // outcome: an earlier run's evidence can never label a later one.
        assert.equal(first.approvalOutcome ?? null, null, "the allowed first generation records no approval outcome");
        assert.equal(second.approvalOutcome ?? null, null, "the follow-up generation starts and ends with no inherited approval evidence");

        const log = readLog(logFor(ws.project));
        const attaches = log.filter((entry) => entry.kind === "new" || entry.kind === "resume" || entry.kind === "load");
        assert.deepEqual(
          attaches.map((entry) => entry.kind),
          ["new", "resume"],
          "generation 0 created a session; generation 1 RESUMED the actual session (never a fresh one)"
        );
        assert.equal(attaches[1]?.sessionId, "fixture-session-1");
        assert.equal(log.filter((entry) => entry.kind === "prompt").length, 2, "each generation ran exactly one prompt");
        assert.equal(fs.readFileSync(notePath, "utf8"), APPLIED_MARKER);
      });
    } finally {
      await ws.cleanup();
    }
  }
);

// ---------------------------------------------------------------------------
// Cancellation: no live child is left behind
// ---------------------------------------------------------------------------

test(
  "cancelling a job whose approval is pending clears the approval and leaves no live child process",
  { timeout: 180000 },
  async () => {
    const ws = newWorkspace("cancel");
    try {
      await withChain(ws, async ({ client }) => {
        const spawned = await spawnCommandCodeJob(client, { task: "Wait forever for approval", cwd: ws.project });
        const id = String(spawned.job_id);
        const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
        assert.equal(waiting.status, "running");
        const childPid = waiting.childPid;
        assert.ok(typeof childPid === "number" && childPid > 0, "the owned child pid is recorded");

        // Product default is a short bounded owner-finalisation wait. Keep the
        // transport budget larger than that wait, then separately observe the
        // durable job to terminal so a slow background finalizer cannot hide
        // behind the MCP request itself.
        const cancelStartedAt = Date.now();
        const cancelled = McpStdioClient.json(await client.callTool("crewdispatch_cancel", { id, wait_seconds: 5 }, 15_000));
        const cancelCallMs = Date.now() - cancelStartedAt;
        assert.ok(cancelCallMs < 12_000, `cancel MCP call must stay bounded; took ${cancelCallMs}ms`);        const kill = (cancelled.kill ?? {}) as { confirmed?: boolean };
        assert.equal(kill.confirmed, true, "the owned process tree is confirmed stopped");
        const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
        assert.equal(settled.status, "cancelled");
        assert.equal(settled.pendingApproval, null, "no stale approval survives the cancellation");
        assert.equal(
          fs.existsSync(approvalRequestPath(ws.root, id, 0, REQUEST_ID)),
          false,
          "the pending request file is cleared with the run"
        );
        // The owned process tree is gone (bounded re-check).
        await sleep(1500);
        const alive = isAlive(childPid!);
        assert.equal(alive, false, `the owned child ${childPid} must not survive the cancel`);
      });
    } finally {
      await ws.cleanup();
    }
  }
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
