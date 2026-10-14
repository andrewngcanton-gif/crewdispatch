// mcp-callback.test.ts — real loopback HTTP verification of the terminal wake.
//
// A REAL http listener on 127.0.0.1 receives the wake the detached worker sends
// through the built MCP entry. It proves: exactly one wake per terminal
// generation; the body carries only the short job id + status (no task,
// transcript or credential); a delivery failure is recorded WITHOUT changing the
// job's own terminal result; and an internal `max_turns` segment never wakes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { createFailureEvidence, runCleanupSteps, runWithFailureEvidence } from "../helpers/failure-evidence";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

const HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

function fixtureEcho(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-cb" } });',
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: "fx-session-cb", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

/** gen 0 hits the internal segment boundary; gen 1 (--resume) succeeds. */
function fixtureHangForConcurrentCancel(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-cancel-race" } });',
    '  setInterval(() => {}, 1000);',
    "});"
  ];
}

function fixtureSegmentThenSuccess(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  const sid = "fx-session-cb";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  if (!process.argv.includes("--resume")) {',
    '    out({ type: "result", subtype: "max_turns", result: "partial", session_id: sid, stop_reason: "max_turns" });',
    "    process.exit(8);",
    "  }",
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: sid, stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

function newWorkspace(name: string, fixtureLines: string[]): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-mcp-cb-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, `${name}.js`);
  fs.writeFileSync(fixture, fixtureLines.join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  return { dir, root, project, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Listener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

function startListener(status = 200): Promise<Listener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(status);
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

async function waitTerminal(
  client: McpStdioClient,
  id: string,
  timeoutMs = 30000,
  onObserve?: (r: Record<string, unknown>) => void
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    onObserve?.(r);
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

async function waitBodies(listener: Listener, n: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listener.bodies.length < n) {
    if (Date.now() >= deadline) throw new Error(`expected ${n} callback bodies, saw ${listener.bodies.length}`);
    await sleep(100);
  }
}

/**
 * Poll until the wake OUTCOME is persisted for the job's current generation. The
 * POST is sent just before the record is written, so reading the status once
 * immediately after `waitBodies` would race that write.
 */
async function waitNotify(client: McpStdioClient, id: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = McpStdioClient.json(await client.callTool("jobquay_status", { id }));
    const notify = (status.job as Record<string, unknown>).notify as Record<string, unknown>;
    if (notify.attempted === true) return notify;
    if (Date.now() >= deadline) throw new Error(`wake outcome was never persisted for ${id}`);
    await sleep(100);
  }
}

test("the terminal wake reaches a real loopback listener exactly once per generation with a short body", { timeout: 60000 }, async () => {
  const ws = newWorkspace("once", fixtureEcho());
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const task = "TASK_MARKER_cb9f — must never appear in the wake";
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", { task, cwd: ws.project, callback_url: listener.url })
    );
    const id = String(spawned.job_id);
    await waitTerminal(client, id);
    await waitBodies(listener, 1);
    await sleep(500); // give a stray duplicate a chance to arrive

    assert.equal(listener.bodies.length, 1, "exactly ONE wake per terminal generation");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["job_id", "status"]);
    assert.equal(body.job_id, id);
    assert.equal(body.status, "done");
    assert.equal(listener.bodies[0]!.includes("TASK_MARKER_cb9f"), false, "the wake must not contain the task");
    assert.equal(listener.bodies[0]!.includes("DONE-MARKER"), false, "the wake must not contain the result text");
    assert.equal(listener.bodies[0]!.includes("fx-session-cb"), false, "the wake must not contain the session id");

    // The delivery outcome is persisted on the job.
    const notify = await waitNotify(client, id);
    assert.equal(notify.kind, "callback");
    assert.equal(notify.attempted, true);
    assert.equal(notify.delivered, true);

    // A follow-up (same job, new generation) wakes again exactly once.
    const followed = McpStdioClient.json(await client.callTool("jobquay_follow_up", { id, message: "again" }));
    assert.equal(followed.generation, 1);
    await waitTerminal(client, id);
    await waitBodies(listener, 2);
    await sleep(500);
    assert.equal(listener.bodies.length, 2, "each terminal generation wakes exactly once");
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("an internal max_turns segment never wakes; only the real terminal generation does", { timeout: 60000 }, async () => {
  const ws = newWorkspace("segment", fixtureSegmentThenSuccess());
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  // Failure evidence is retained BEFORE teardown deletes the disposable root, so
  // a future timeout keeps the real last-observed MCP state, callback bodies and
  // durable job/attempt/tree/notify state instead of only "did not reach".
  let lastObserved: Record<string, unknown> | null = null;
  const evidence = createFailureEvidence({
    name: "mcp-callback internal-max_turns-segment",
    dataRoot: ws.root,
    workspaceDir: ws.dir,
    extra: () => ({
      mcpLastObserved: lastObserved,
      callbackCount: listener.bodies.length,
      callbackBodies: listener.bodies.map((b) => b.slice(0, 2048))
    })
  });
  await runWithFailureEvidence(
    evidence,
    async () => {
      await client.initialize();
      const spawned = McpStdioClient.json(
        await client.callTool("jobquay_spawn", { task: "segment", cwd: ws.project, callback_url: listener.url })
      );
      const id = String(spawned.job_id);
      const done = await waitTerminal(client, id, 30000, (r) => {
        lastObserved = r;
      });
      assert.equal(done.status, "done");
      assert.equal(done.generation, 1, "the segment auto-resumed into generation 1");
      await waitBodies(listener, 1);
      await sleep(600);
      assert.equal(listener.bodies.length, 1, "the internal segment must NOT wake; only the terminal generation does");
    },
    async () => {
      // Every owned cleanup step is attempted even if an earlier one throws; all
      // cleanup errors are preserved (AggregateError) alongside any body error.
      await runCleanupSteps([
        { name: "client.close", run: () => client.close() },
        { name: "listener.close", run: () => listener.close() },
        { name: "workspace.cleanup", run: () => ws.cleanup() }
      ]);
    }
  );
});

test("two concurrent cancel callers converge on one cancelled generation and one terminal wake", { timeout: 60000 }, async () => {
  const ws = newWorkspace("cancel-race", fixtureHangForConcurrentCancel());
  const listener = await startListener();
  const first = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const second = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const spawned = McpStdioClient.json(
      await first.callTool("crewdispatch_spawn", { task: "cancel-race", cwd: ws.project, callback_url: listener.url })
    );
    const id = String(spawned.job_id);

    const runningDeadline = Date.now() + 20000;
    for (;;) {
      const status = McpStdioClient.json(await first.callTool("crewdispatch_status", { id }));
      if ((status.job as Record<string, unknown>).status === "running") break;
      if (Date.now() >= runningDeadline) throw new Error(`job ${id} never reached running`);
      await sleep(100);
    }

    const [a, b] = await Promise.all([
      first.callTool("crewdispatch_cancel", { id, wait_seconds: 8 }),
      second.callTool("crewdispatch_cancel", { id, wait_seconds: 8 })
    ]);
    const ra = McpStdioClient.json(a);
    const rb = McpStdioClient.json(b);
    assert.equal(ra.status, "cancelled", JSON.stringify(ra));
    assert.equal(rb.status, "cancelled", JSON.stringify(rb));

    await waitBodies(listener, 1);
    await sleep(600);
    assert.equal(listener.bodies.length, 1, "concurrent cancel must produce one terminal wake");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.equal(body.job_id, id);
    assert.equal(body.status, "cancelled");

    const status = McpStdioClient.json(await first.callTool("crewdispatch_status", { id }));
    assert.equal((status.job as Record<string, unknown>).status, "cancelled");
  } finally {
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await listener.close().catch(() => undefined);
    await ws.cleanup();
  }
});

test("a failing callback is recorded but never changes the job's terminal result", { timeout: 60000 }, async () => {
  const ws = newWorkspace("failcb", fixtureEcho());
  const listener = await startListener(500); // the listener rejects the wake
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", { task: "failcb", cwd: ws.project, callback_url: listener.url })
    );
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done", "a failed wake must not change the job outcome");
    assert.equal((done.result as Record<string, unknown>).final_text, "DONE-MARKER");

    await waitBodies(listener, 1);
    const notify = await waitNotify(client, id);
    const status = McpStdioClient.json(await client.callTool("jobquay_status", { id }));
    assert.equal((status.job as Record<string, unknown>).status, "done");
    assert.equal(notify.attempted, true);
    assert.equal(notify.delivered, false);
    assert.match(String(notify.reason), /http_status_500/);
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});
