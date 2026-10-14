// mcp-reconcile-notify.test.ts — REAL verification that an MCP read/cancel which
// RECONCILES a stale dead-owner job to a terminal state performs exactly ONE
// generation-scoped terminal wake, with a real loopback listener and the BUILT
// MCP server as a separate process.
//
// It covers:
//   * `jobquay_status {id}` and `jobquay_result` reconciling a dead-owner job to
//     `interrupted` → exactly one POST; a repeat read does NOT repeat the wake;
//   * the `jobquay_status` LIST path (reconcileAll) waking a reconciled job;
//   * a job with NO callback/thread → a recorded `no_target` diagnostic and no POST.
//
// No daemon runs here: a dead-owner job that is never read through an MCP entry
// is not woken automatically (a documented product boundary, not an autonomous
// wake). A delivery failure never changes the job's terminal outcome.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createJobRecord } from "../../jobs/service";
import { ensureRoot, readNotificationResults, saveJob } from "../../jobs/store";
import type { JobRecord, NotifyTarget } from "../../jobs/types";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-reconcile-notify-${name}-`));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  // The caller environment can carry REAL overrides (a production
  // CREWDISPATCH_DATA_ROOT, a live CODEX_THREAD_ID or a Hub URL). This test must
  // never read, reconcile or wake anything outside its disposable root, so every
  // CrewDispatch/Codex override is scrubbed before the MCP entry is pointed at it.
  const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: root };
  delete env.CREWDISPATCH_DATA_ROOT;
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CLI_PATH;
  delete env.JOBQUAY_HUB_URL;
  delete env.JOBQUAY_TEST_FIXTURE;
  return { dir, root, project, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

/** A stale, dead-owner `running` job with no CLI child (the reconcile-to-terminal case). */
function deadOwnerJob(root: string, name: string, notifyTarget: NotifyTarget): JobRecord {
  ensureRoot(root);
  const job = createJobRecord({ task: `${name}-task-marker`, cwd: root, notifyTarget });
  job.status = "running";
  job.owner = "jobquay-2147483647-dead";
  job.ownerPid = 2147483647; // a PID that does not exist
  job.heartbeatAt = new Date(Date.now() - 600000).toISOString();
  job.childPid = null;
  job.childGeneration = null;
  return saveJob(root, job);
}

function callbackTarget(url: string): NotifyTarget {
  return { kind: "callback", callbackUrl: url, codexThreadId: null, source: "callback_url" };
}

test("jobquay_status reconciles a dead owner to interrupted and wakes it exactly once", { timeout: 60000 }, async () => {
  const ws = newWorkspace("status");
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    const job = deadOwnerJob(ws.root, "status", callbackTarget(listener.url));
    await client.initialize();

    const status = McpStdioClient.json(await client.callTool("jobquay_status", { id: job.id }));
    const view = status.job as Record<string, unknown>;
    assert.equal(view.status, "interrupted", "a dead owner with no child is reconciled terminal");
    assert.equal((view.notify as Record<string, unknown>).attempted, true);
    assert.equal((view.notify as Record<string, unknown>).delivered, true);

    await sleep(300);
    assert.equal(listener.bodies.length, 1, "exactly one wake for the reconciled terminal state");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["job_id", "status"]);
    assert.equal(body.job_id, job.id);
    assert.equal(body.status, "interrupted");

    // A repeat read must NOT re-deliver.
    await client.callTool("jobquay_status", { id: job.id });
    await client.callTool("jobquay_result", { id: job.id });
    await sleep(300);
    assert.equal(listener.bodies.length, 1, "repeated reads must not repeat the wake");

    const results = readNotificationResults(ws.root, job.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.delivered, true);
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("the jobquay_status LIST path (reconcileAll) wakes a reconciled terminal job", { timeout: 60000 }, async () => {
  const ws = newWorkspace("list");
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    const job = deadOwnerJob(ws.root, "list", callbackTarget(listener.url));
    await client.initialize();
    await client.callTool("jobquay_status", {}); // no id → reconcileAll sweep
    await sleep(300);
    assert.equal(listener.bodies.length, 1, "the sweep must wake the reconciled terminal job once");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.equal(body.job_id, job.id);
    assert.equal(body.status, "interrupted");
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("a reconciled job with no callback/thread records a no_target diagnostic and sends nothing", { timeout: 60000 }, async () => {
  const ws = newWorkspace("notarget");
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    const job = deadOwnerJob(ws.root, "notarget", { kind: "none", callbackUrl: null, codexThreadId: null, source: null });
    await client.initialize();
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id: job.id }));
    assert.equal(result.status, "interrupted");
    const notify = result.notify as Record<string, unknown>;
    assert.equal(notify.kind, "none");
    assert.equal(notify.attempted, true);
    assert.equal(notify.delivered, false);
    assert.equal(notify.reason, "no_target");

    await sleep(300);
    assert.equal(listener.bodies.length, 0, "no target means no network call at all");
    const results = readNotificationResults(ws.root, job.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.reason, "no_target");
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});
