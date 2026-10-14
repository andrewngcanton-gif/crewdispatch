// approval-notify-real.test.ts — REAL boundary acceptance of the approval wake.
//
// The chain under test is the production one: the built MCP stdio entry
// dispatches through the independent local daemon, which owns the detached
// worker; the worker drives a controlled provider fixture through the REAL
// WorkBuddy adapter (the fixture substitutes only the provider process), pauses
// on a real `session/request_permission`-shaped approval, and the ORIGINAL
// dispatcher's loopback HTTP callback receives exactly ONE typed
// `approval_required` event. The caller then disconnects; a REAL Hub decision
// resumes the SAME job generation/session, and exactly one terminal wake
// follows.
//
// No test ever touches the production data root or a real Codex thread: the
// environment is an isolated data root and every notification destination is a
// local loopback listener.
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
import {
  approvalDecisionPath,
  approvalRequestPath,
  readApprovalDecision
} from "../../jobs/approval";
import {
  acpInitRecord,
  acpTerminalResultRecord
} from "../../providers/workbuddy-ai/acp-normalizer";
import {
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID
} from "../fixtures/workbuddy-terminal-records";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const REQUEST_ID = "req-approval-1";
const OPERATION_MARKER = "APPROVAL_OPERATION_MARKER_9f";
const DONE_MARKER = "APPROVAL_DONE_MARKER_9f";
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
      "let input = \"\";",
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
      "    version: 1, kind: \"tool_approval\", provider: \"workbuddy-ai\", jobId: job.id, generation,",
      "    requestId, toolName: \"Bash\", summary: null,",
      "    detail: { command: \"echo " + OPERATION_MARKER + "\", description: null, path: null, cwd: job.cwd, title: null, gate: \"toolCallLoop\", reason: \"consecutive_same_tool\", truncated: false, redacted: false },",
      "    options: [",
      "      { id: \"allow\", kind: \"allow_once\", label: \"Allow\" },",
      "      { id: \"reject\", kind: \"reject_once\", label: \"Reject\" }",
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
      "    let decision = null;",
      '    try { decision = JSON.parse(fs.readFileSync(decisionPath, "utf8")); } catch { return; }',
      '    if (!decision || typeof decision.optionId !== "string") return;',
      "    clearInterval(timer);",
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

function newWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-approval-real-"));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: "iso-approval-" });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = writePausedApprovalFixture(dir);
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  return { dir, root, project, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

interface Listener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

function startListener(): Promise<Listener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(b);
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

async function waitBodies(listener: Listener, n: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listener.bodies.length < n) {
    if (Date.now() >= deadline) throw new Error(`expected ${n} callback bodies, saw ${listener.bodies.length}`);
    await sleep(100);
  }
}

async function waitJob(root: string, id: string, predicate: (job: NonNullable<ReturnType<typeof loadJob>>) => boolean, timeoutMs = 60000): Promise<NonNullable<ReturnType<typeof loadJob>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && predicate(job)) return job;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the job state of ${id}`);
    await sleep(100);
  }
}

test("a real paused approval wakes the disconnected caller once, the Hub decision resumes the same run, then exactly one terminal wake follows", { timeout: 120000 }, async () => {
  const ws = newWorkspace();
  const listener = await startListener();
  let hub: HubHandle | null = null;
  let client: McpStdioClient | null = null;
  try {
    hub = startHub({ root: ws.root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = `http://127.0.0.1:${hub.port}`;

    client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("crewdispatch_spawn", {
        task: "APPROVAL_REAL_TASK_MARKER",
        cwd: ws.project,
        provider: "workbuddy-ai",
        model: "wb-fixture-model",
        callback_url: listener.url
      })
    );
    const id = String(spawned.job_id);
    assert.equal(spawned.accepted, true);

    // The CALLER process disconnects; the daemon-owned worker keeps running.
    await client.close();
    client = null;

    // The original dispatcher conversation receives exactly ONE typed approval
    // event, with identity, the bounded actual operation and a working link.
    await waitBodies(listener, 1);
    const approvalBodyRaw = listener.bodies[0]!;
    const approvalBody = JSON.parse(approvalBodyRaw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(approvalBody).sort(), ["cwd", "event", "expires_at", "generation", "hub_url", "job_id", "operation", "provider", "request_id", "tool"]);
    assert.equal(approvalBody.event, "approval_required");
    assert.equal(approvalBody.job_id, id);
    assert.equal(approvalBody.generation, 0);
    assert.equal(approvalBody.request_id, REQUEST_ID);
    assert.equal(approvalBody.provider, "workbuddy-ai");
    assert.equal(approvalBody.tool, "Bash");
    assert.equal(approvalBody.operation, `echo ${OPERATION_MARKER}`);
    assert.equal(approvalBody.cwd, ws.project);
    assert.ok(String(approvalBody.hub_url).startsWith(`${hubUrl}/ui?job=${encodeURIComponent(id)}&generation=0&request=`), "the link is the proven Hub's exact deep link");
    assert.equal(approvalBodyRaw.includes("APPROVAL_REAL_TASK_MARKER"), false, "the alert never carries the task");
    assert.equal(approvalBodyRaw.includes("status"), false, "no fabricated terminal status");

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
    const decision = readApprovalDecision(ws.root, id, 0, REQUEST_ID);
    assert.ok(decision, "the decision is durably claimed");
    assert.equal(decision!.optionId, "allow");

    const settled = await waitJob(ws.root, id, (job) => TERMINAL.has(job.status), 90000);
    assert.equal(
      settled.status,
      "done",
      `status=${settled.status} failureKind=${settled.failureKind} stopReason=${settled.stopReason} error=${settled.error} result=${JSON.stringify(settled.result)}`
    );
    assert.equal(settled.generation, 0, "the SAME generation resumed after the approval");
    assert.equal(settled.sessionId, WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "the SAME provider session completed");
    assert.equal(settled.result?.finalText, DONE_MARKER);
    assert.equal(settled.pendingApproval, null, "a settled run keeps no stale approval");

    // Exactly ONE approval alert and exactly ONE terminal wake, in order.
    await waitBodies(listener, 2);
    await sleep(800); // give a duplicate a chance to arrive
    assert.equal(listener.bodies.length, 2, "one approval alert + one terminal wake, no duplicates");
    const terminalBody = JSON.parse(listener.bodies[1]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(terminalBody).sort(), ["job_id", "status"]);
    assert.equal(terminalBody.job_id, id);
    assert.equal(terminalBody.status, "done");

    // Durable evidence: separate approval claim/result namespace, the real
    // decision, and the unchanged terminal notification record.
    const approvalRecord = readApprovalNotificationResult(ws.root, id, 0, REQUEST_ID);
    assert.ok(approvalRecord, "the approval wake outcome is durable");
    assert.equal(approvalRecord!.delivered, true);
    assert.equal(approvalRecord!.kind, "callback");
    assert.equal(approvalRecord!.by, "worker");
    const terminalRecord = readNotificationResult(ws.root, id, 0);
    assert.equal(terminalRecord?.delivered, true, "the existing terminal wake still delivers exactly once");
  } finally {
    if (client) await client.close().catch(() => undefined);
    await listener.close();
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    await ws.cleanup();
  }
});
