// workspace-busy-mcp.test.ts — JQ-20261002-44 real MCP entry coverage for the
// shared EXACT-workspace occupancy guard.
//
// The production MCP entry (`dist/mcp/server.js`) spawns the real local daemon;
// every dispatch goes through the real `startJobViaDaemon` /
// `continueJobViaDaemon` boundary and the real durable store. The controlled
// fixture replaces the provider PROCESS only (it stays alive until the test
// releases it), so the accepted job is genuinely active while the guard is
// probed.
//
// This is the caller-visible surface: a refused dispatch must be an ordinary
// MCP tool error carrying the stable `workspace_busy` code and the holder, and a
// refused follow-up must not change the terminal job it targeted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdioClient } from "../helpers/mcp-client";
import { shutdownJobDaemon } from "../../daemon/client";
import { createJobRecord } from "../../jobs/service";
import { appendUserMessageOrThrow, loadUserMessagesInfo } from "../../jobs/messages";
import { listJobs, loadJob, saveJob } from "../../jobs/store";
import { canonicalWorkspacePath } from "../../jobs/workspace";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Workspace {
  dir: string;
  root: string;
  project: string;
  fixture: string;
  fixtureLog: string;
  releaseFile: string;
  env: NodeJS.ProcessEnv;
}

function writeFixture(dir: string): string {
  const fixture = path.join(dir, "mcp-workspace-fixture.cjs");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const log = process.env.JOBQUAY_TEST_FIXTURE_LOG;',
      '  if (log) fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), stdin: input }) + "\\n");',
      '  const sid = "fx-workspace-session";',
      '  process.stdout.write(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: sid } }) + "\\n");',
      '  const release = process.env.JOBQUAY_TEST_RELEASE_FILE;',
      "  const deadline = Date.now() + 30000;",
      "  const finish = () => {",
      '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "MCP_WS_OK:" + input.trim(), session_id: sid, stop_reason: "end_turn" }) + "\\n");',
      "    process.exit(0);",
      "  };",
      "  if (!release) return finish();",
      "  const timer = setInterval(() => {",
      "    if (fs.existsSync(release) || Date.now() > deadline) { clearInterval(timer); finish(); }",
      "  }, 50);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-workspace-mcp-${name}-`));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = writeFixture(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    JOBQUAY_TEST_FIXTURE_LOG: path.join(dir, "fixture-invocations.jsonl"),
    JOBQUAY_TEST_RELEASE_FILE: path.join(dir, "release.txt")
  };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CALLBACK_URL;
  delete env.JOBQUAY_CALLBACK_URL;
  return {
    dir,
    root,
    project,
    fixture,
    fixtureLog: String(env.JOBQUAY_TEST_FIXTURE_LOG),
    releaseFile: String(env.JOBQUAY_TEST_RELEASE_FILE),
    env
  };
}

function invocations(ws: Workspace): Array<{ cwd: string; stdin: string }> {
  if (!fs.existsSync(ws.fixtureLog)) return [];
  return fs
    .readFileSync(ws.fixtureLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd: string; stdin: string });
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

async function waitActive(root: string, id: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && (job.status === "queued" || job.status === "running")) return;
    if (Date.now() >= deadline) throw new Error(`job ${id} never became active`);
    await sleep(50);
  }
}

test("the MCP entry refuses a second dispatch into an occupied cwd with workspace_busy, and a follow-up on another terminal job, then accepts both once the holder ends", { timeout: 180000 }, async () => {
  const ws = newWorkspace("entry");
  let client: McpStdioClient | null = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const canonical = canonicalWorkspacePath(ws.project);

    // Holder A: accepted through the real MCP entry, stays active on the fixture.
    const spawnedA = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "MCP_WS_HOLDER", cwd: ws.project }));
    assert.equal(spawnedA.ok, true, JSON.stringify(spawnedA));
    const idA = String(spawnedA.job_id);
    await waitActive(ws.root, idA);
    // The fixture records its invocation when its stdin ends (the real prompt
    // write); wait for it so the "no extra provider process" assertions below
    // are meaningful.
    const invocationsDeadline = Date.now() + 20000;
    while (invocations(ws).length < 1 && Date.now() < invocationsDeadline) await sleep(50);
    assert.equal(invocations(ws).length, 1, "the accepted job started exactly one provider process");

    // A second dispatch into the SAME directory is refused visibly.
    const refused = await client.callTool("crewdispatch_spawn", { task: "MCP_WS_REFUSED", cwd: ws.project });
    assert.equal(refused.isError, true, "the refusal is an ordinary MCP tool error");
    const refusedBody = McpStdioClient.json(refused);
    assert.equal(refusedBody.ok, false);
    assert.equal(refusedBody.code, "workspace_busy");
    assert.ok(String(refusedBody.message).includes(idA), "the refusal names the holder job");
    assert.ok(String(refusedBody.message).includes(canonical), "the refusal names the canonical cwd");
    assert.ok(String(refusedBody.message).includes("command-code"), "the refusal names the holder provider");

    // A terminal job in the same directory cannot be continued while A holds it.
    const terminal = createJobRecord({ task: "MCP_WS_TERMINAL", cwd: ws.project });
    terminal.status = "done";
    terminal.sessionId = "fx-workspace-session";
    terminal.finishedAt = new Date().toISOString();
    terminal.result = { ok: true, subtype: "success", kind: "success", exitCode: 0, stopReason: null, finalText: "prior", fallbackEligible: false };
    saveJob(ws.root, terminal);
    appendUserMessageOrThrow(ws.root, terminal.id, { text: terminal.task, generation: 0, at: terminal.createdAt });
    const recordBefore = fs.readFileSync(path.join(ws.root, "jobs", `${terminal.id}.json`), "utf8");
    const historyBefore = loadUserMessagesInfo(ws.root, terminal.id);

    const refusedFollowUp = await client.callTool("crewdispatch_follow_up", { id: terminal.id, message: "MCP_WS_FOLLOW_UP" });
    assert.equal(refusedFollowUp.isError, true);
    const followBody = McpStdioClient.json(refusedFollowUp);
    assert.equal(followBody.code, "workspace_busy");
    assert.ok(String(followBody.message).includes(idA));
    assert.equal(fs.readFileSync(path.join(ws.root, "jobs", `${terminal.id}.json`), "utf8"), recordBefore, "the refused follow-up left the terminal record byte-identical");
    assert.equal(loadJob(ws.root, terminal.id)!.generation, 0, "the refused follow-up bumped no generation");
    assert.deepEqual(loadUserMessagesInfo(ws.root, terminal.id), historyBefore, "the refused follow-up wrote no message");
    assert.equal(invocations(ws).length, 1, "no provider process was started by either refusal");
    assert.equal(listJobs(ws.root).jobs.length, 2, "no job was created by either refusal");

    // The holder is cancelled through the MCP entry; the workspace frees.
    const cancelled = McpStdioClient.json(await client.callTool("crewdispatch_cancel", { id: idA, wait_seconds: 8 }));
    assert.equal(cancelled.status, "cancelled");

    const followed = McpStdioClient.json(await client.callTool("crewdispatch_follow_up", { id: terminal.id, message: "MCP_WS_FOLLOW_UP" }));
    assert.equal(followed.ok, true, JSON.stringify(followed));
    assert.equal(followed.job_id, terminal.id, "the continuation keeps the same logical job");
    assert.equal(followed.generation, 1);
    fs.writeFileSync(ws.releaseFile, "1", "utf8");
    const done = await waitTerminal(client, terminal.id);
    assert.equal(done.status, "done");
    assert.equal(done.generation, 1);
  } finally {
    try { fs.writeFileSync(ws.releaseFile, "1", "utf8"); } catch { /* best effort */ }
    if (client) await client.close();
    await shutdownJobDaemon(ws.root, ws.env).catch(() => undefined);
    let removed = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        fs.rmSync(ws.dir, { recursive: true, force: true });
        removed = true;
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw e;
        await sleep(100);
      }
    }
    assert.equal(removed, true, "temporary MCP workspace root can be cleaned after handles settle");
  }
});
