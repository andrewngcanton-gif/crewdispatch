// claude-approval-real.test.ts — REAL boundary evidence for the Claude
// APPROVAL wake (the terminal wake has its own suite in claude-notify-real).
//
// The chain under test is the production one: the built MCP stdio entry
// dispatches through the independent local daemon, which owns the detached
// worker; the worker drives a controlled provider fixture through the REAL
// WorkBuddy adapter (the fixture substitutes only the provider process), pauses
// on a real `session/request_permission`-shaped approval, and the ORIGINAL
// session's native inbox receives exactly ONE typed approval message that says
// the job is NOT finished, forbids a result call and forbids automatic
// approval, and carries the proven Dashboard link. A second registered session
// must receive NOTHING. The caller then disconnects; a REAL Hub decision
// resumes the SAME job generation, and exactly one terminal wake follows.
//
// The receiver process stands in for the Claude host ON THE WIRE ONLY: it
// proves the production transport reached a separate OS process with the exact
// frames; it does NOT prove visible conversation receipt (installed-host gate).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { startHub, type HubHandle } from "../../hub/server";
import { loadJob, readApprovalNotificationResult, readNotificationResult } from "../../jobs/store";
import { approvalDecisionPath, approvalRequestPath } from "../../jobs/approval";
import { acpInitRecord, acpTerminalResultRecord } from "../../providers/workbuddy-ai/acp-normalizer";
import {
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID
} from "../fixtures/workbuddy-terminal-records";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const HOOK_ENTRY = path.join(__dirname, "..", "..", "claude", "hook.js");
const RECEIVER_ENTRY = path.join(__dirname, "..", "..", "tests", "helpers", "claude-inbox-receiver.js");
const REQUEST_ID = "req-claude-approval-1";
const OPERATION_MARKER = "CLAUDE_APPROVAL_OPERATION_MARKER_7f";
const DONE_MARKER = "CLAUDE_APPROVAL_DONE_MARKER_7f";
const TASK_MARKER = "CLAUDE_APPROVAL_TASK_MARKER_7f";
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipePath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crewdispatch-approval-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `crewdispatch-approval-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/**
 * A fixture script that behaves like the WorkBuddy bridge for ONE approval:
 * it materializes the pending request file, publishes the bounded approval
 * record on stdout, waits for the Hub's exclusive decision file, then publishes
 * the resolved record and a successful terminal result. The job identity is
 * read from the isolated data root (exactly one running job exists).
 */
function writePausedApprovalFixture(dir: string): string {
  const init = JSON.stringify(acpInitRecord(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, WORKBUDDY_TERMINAL_FIXTURE_MODEL));
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: DONE_MARKER
  });
  const fixture = path.join(dir, "paused-approval-fixture.cjs");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const root = process.env.JOBQUAY_DATA_ROOT;',
      '  const jobsDir = path.join(root, "jobs");',
      "  let job = null;",
      '  for (const name of fs.readdirSync(jobsDir)) {',
      '    if (!name.endsWith(".json")) continue;',
      '    try {',
      '      const candidate = JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8"));',
      '      if (candidate.provider === "workbuddy-ai" && candidate.status === "running") { job = candidate; break; }',
      "    } catch {}",
      "  }",
      '  if (!job) { process.stderr.write("no running workbuddy job\\n"); process.exit(3); }',
      `  const requestId = ${JSON.stringify(REQUEST_ID)};`,
      "  const generation = job.generation;",
      '  const requestPath = path.join(root, "approval", `${job.id}.gen-${generation}.${requestId}.request.json`);',
      '  const decisionPath = path.join(root, "approval", `${job.id}.gen-${generation}.${requestId}.decision.json`);',
      "  const pending = {",
      '    version: 1, kind: "tool_approval", provider: "workbuddy-ai", jobId: job.id, generation,',
      "    requestId, toolName: \"Bash\", summary: null,",
      '    detail: { command: "echo ' + OPERATION_MARKER + '", description: null, path: null, cwd: job.cwd, title: null, gate: "toolCallLoop", reason: "consecutive_same_tool", truncated: false, redacted: false },',
      "    options: [",
      '      { id: "allow", kind: "allow_once", label: "Allow" },',
      '      { id: "reject", kind: "reject_once", label: "Reject" }',
      "    ],",
      "    createdAt: new Date().toISOString(),",
      "    expiresAt: new Date(Date.now() + 600000).toISOString()",
      "  };",
      '  fs.mkdirSync(path.dirname(requestPath), { recursive: true });',
      '  fs.writeFileSync(requestPath, JSON.stringify(pending));',
      `  process.stdout.write(${JSON.stringify(init)} + "\\n");`,
      '  process.stdout.write(JSON.stringify({ type: "approval", phase: "pending", approval: pending }) + "\\n");',
      "  const timer = setInterval(() => {",
      "    if (!fs.existsSync(decisionPath)) return;",
      "    clearInterval(timer);",
      '    const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8"));',
      '    fs.rmSync(requestPath, { force: true });',
      '    process.stdout.write(JSON.stringify({ type: "approval", phase: "resolved", request_id: requestId, option_id: decision.optionId, decision: "selected" }) + "\\n");',
      `    process.stdout.write(${JSON.stringify(JSON.stringify(terminal.record))} + "\\n");`,
      `    process.exitCode = ${terminal.exitCode};`,
      "  }, 20);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crewdispatch-claude-approval-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-cla-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = writePausedApprovalFixture(dir);
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  return { dir, root, project, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

interface Receiver {
  address: string;
  outFile: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stop: () => Promise<void>;
}

/** Start the separate receiver process and wait for its READY line. */
async function startReceiver(name: string): Promise<Receiver> {
  const address = pipePath(name);
  const outFile = path.join(os.tmpdir(), `crewdispatch-approval-receiver-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const child = spawn(process.execPath, [RECEIVER_ENTRY, address, outFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the receiver process never became ready")), 10000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the receiver process exited early (${code})`));
    });
  });
  return {
    address,
    outFile,
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* the workspace cleanup also removes it */
      }
    }
  };
}

/** Run the REAL compiled hook entry as a separate process (the installed layout). */
function runHook(ws: Workspace, sessionId: string, socket: string, token: string): string {
  const result = spawnSync(process.execPath, [HOOK_ENTRY, "session-start"], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd: ws.project }),
    encoding: "utf8",
    timeout: 35000,
    windowsHide: true,
    env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

interface FrameGroup {
  group: number;
  frames: string;
}

function readGroups(file: string): FrameGroup[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FrameGroup);
}

async function waitGroups(file: string, n: number, timeoutMs = 30000): Promise<FrameGroup[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const groups = readGroups(file);
    if (groups.length >= n) return groups;
    if (Date.now() >= deadline) throw new Error(`expected ${n} frame groups in ${file}, saw ${groups.length}`);
    await sleep(100);
  }
}

function framesOf(group: FrameGroup): { auth: Record<string, unknown>; content: string } {
  const lines = group.frames.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "exactly two frames per wake");
  const auth = JSON.parse(lines[0]!) as Record<string, unknown>;
  const user = JSON.parse(lines[1]!) as { message: { role: string; content: string } };
  assert.equal(auth.type, "auth");
  assert.equal(user.message.role, "user");
  return { auth, content: user.message.content };
}

async function waitJob(root: string, id: string, predicate: (job: NonNullable<ReturnType<typeof loadJob>>) => boolean, timeoutMs = 90000): Promise<NonNullable<ReturnType<typeof loadJob>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && predicate(job)) return job;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the job state of ${id}`);
    await sleep(100);
  }
}

test("a real paused approval wakes the bound Claude session once, forbids a result call, and the Hub decision resumes the same run", { timeout: 180000 }, async () => {
  const ws = newWorkspace("full");
  const receiverA = await startReceiver("full-a");
  const receiverB = await startReceiver("full-b");
  const tokenA = "claude-approval-token-a";
  let hub: HubHandle | null = null;
  let client: McpStdioClient | null = null;
  try {
    hub = startHub({ root: ws.root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = `http://127.0.0.1:${hub.port}`;

    // The REAL SessionStart hook registers the ORIGINAL session (A); a second
    // unrelated session (B) is registered too, to prove no cross-delivery.
    const a = /claude_session_id="([^"]+)"/.exec(runHook(ws, "1a1a1a1a-2222-4333-8444-555555555555", receiverA.address, tokenA))!;
    runHook(ws, "2b2b2b2b-3333-4444-8555-666666666666", receiverB.address, "claude-approval-token-b");
    assert.ok(a[1]);

    client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("crewdispatch_spawn", {
        task: TASK_MARKER,
        cwd: ws.project,
        provider: "workbuddy-ai",
        model: "wb-fixture-model",
        claude_session_id: a[1]
      })
    );
    const id = String(spawned.job_id);
    assert.equal(spawned.accepted, true);

    // The CALLER process disconnects; the daemon-owned worker keeps running.
    await client.close();
    client = null;

    // The ORIGINAL session receives exactly ONE approval message with the
    // request/generation identity, the bounded operation and the proven link.
    await waitGroups(receiverA.outFile, 1);
    const approvalGroup = readGroups(receiverA.outFile)[0]!;
    const { auth, content } = framesOf(approvalGroup);
    assert.equal(auth.token, tokenA, "the approval frame carries the session's own token");
    assert.ok(content.includes(id), "the approval wake names the job");
    assert.ok(content.includes("not finished"), "the approval wake says the run is NOT finished");
    assert.ok(content.includes("Do not call crewdispatch_result"), "the approval wake forbids a result call");
    assert.ok(content.includes("do not approve automatically"), "the approval wake forbids automatic approval");
    assert.ok(
      content.includes(`${hubUrl}/ui?job=${encodeURIComponent(id)}&generation=0&request=${encodeURIComponent(REQUEST_ID)}`),
      `the approval wake carries the proven Dashboard deep link: ${content}`
    );
    assert.ok(content.includes(OPERATION_MARKER), "the bounded actual operation is shown to the human");
    assert.equal(content.includes("crewdispatch_result(id="), false, "the approval wake never asks for a result collection");
    assert.equal(content.includes(TASK_MARKER), false, "the wake never carries the task");
    assert.equal(content.includes(tokenA), false, "the message never carries the token");

    // No duplicate and NO cross-delivery to the other registered session.
    await sleep(700);
    assert.equal(readGroups(receiverA.outFile).length, 1, "exactly ONE approval wake");
    assert.equal(readGroups(receiverB.outFile).length, 0, "an unrelated session must never receive the wake");

    // The job is honestly still running and waiting, and NOT approved by the wake.
    const waiting = await waitJob(ws.root, id, (job) => job.pendingApproval != null);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.generation, 0);
    assert.equal(fs.existsSync(approvalDecisionPath(ws.root, id, 0, REQUEST_ID)), false, "the alert itself never approves anything");
    assert.ok(fs.existsSync(approvalRequestPath(ws.root, id, 0, REQUEST_ID)), "the provider request is still materialized for the Hub");

    // The HUMAN resolves it in the existing Hub: the real approval route claims
    // exactly one decision, and the same provider request continues the SAME
    // job generation and session.
    const resolved = await fetch(`${hubUrl}/api/jobs/${encodeURIComponent(id)}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: 0, request_id: REQUEST_ID, option_id: "allow" })
    });
    assert.equal(resolved.status, 200, `the Hub resolved the approval (${resolved.status})`);

    const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status), 90000);
    assert.equal(
      settled.status,
      "done",
      `status=${settled.status} failureKind=${settled.failureKind} stopReason=${settled.stopReason} error=${settled.error} result=${JSON.stringify(settled.result)}`
    );
    assert.equal(settled.generation, 0, "the SAME generation resumed after the approval");
    assert.equal(settled.sessionId, WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID);
    assert.equal(settled.result?.finalText, DONE_MARKER);
    assert.equal(settled.pendingApproval, null);

    // Exactly ONE terminal wake follows, on the same session, with the one-shot
    // result-collection hint — and still nothing on the unrelated session.
    await waitGroups(receiverA.outFile, 2);
    await sleep(700);
    const after = readGroups(receiverA.outFile);
    assert.equal(after.length, 2, "one approval wake + one terminal wake, no duplicates");
    const terminal = framesOf(after[1]!);
    assert.ok(terminal.content.includes(id));
    assert.ok(terminal.content.includes("crewdispatch_result"), "the terminal wake asks for the one-shot result collection");
    assert.equal(readGroups(receiverB.outFile).length, 0, "no wake may ever reach an unrelated session");

    // Durable evidence: the separate approval claim/result namespace and the
    // unchanged terminal notification record.
    const approvalRecord = readApprovalNotificationResult(ws.root, id, 0, REQUEST_ID);
    assert.ok(approvalRecord, "the approval wake outcome is durable");
    assert.equal(approvalRecord!.delivered, true);
    assert.equal(approvalRecord!.kind, "claude_session");
    assert.equal(approvalRecord!.by, "worker");
    const terminalRecord = readNotificationResult(ws.root, id, 0);
    assert.equal(terminalRecord?.delivered, true, "the terminal wake still delivers exactly once");
  } finally {
    if (client) await client.close().catch(() => undefined);
    await receiverA.stop();
    await receiverB.stop();
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    await ws.cleanup();
  }
});
