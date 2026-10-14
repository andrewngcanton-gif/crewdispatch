// rate-limit-fallback-mcp.test.ts — CROSS-PROCESS acceptance of the M1 batch-5
// rate-limit DOWNGRADE chain through the BUILT MCP entry (`dist/mcp/server.js`).
//
// It drives the REAL production runner against a CONTROLLED official-CLI fixture
// that speaks the installed Command Code ACP protocol (a real separate child
// process — see tests/helpers/cc-acp-fixture.ts). The production entry launches
// the REAL ACP bridge, which configures model/effort/mode over JSON-RPC and
// prompts through `session/prompt`; only the CLI process is scripted. This
// exercises the production ACP transport, the persisted candidate chain, the
// real detached worker, cross-process record persistence and a REAL loopback
// HTTP terminal wake — none of which an in-process mock can prove.
//
// The controlled executable replaces ONLY the hard-to-produce CLI rate-limit
// result. A clear rate limit arrives as the installed CLI's own structured
// JSON-RPC error (`-32603` with `data.code = "RATE_LIMITED"`), which the bridge
// classifies with the official exit code 5. It is NOT a real `cmdc` measurement:
// the real-`cmdc` boundaries are covered by the opt-in installed-CLI gates.
//
// No real CLI profile, credential or notification target is touched: the CLI
// profile is a disposable isolated directory and the wake target is a loopback
// listener started by this test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { RECOVERY_PROMPT } from "../../jobs/service";
import { McpStdioClient } from "../helpers/mcp-client";
import { promptEventsFor, readCcAcpLog, sameFixtureCwd, writeCcAcpCmdcFixture } from "../helpers/cc-acp-fixture";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const SESSION = "fake-session-rl";
const MODELS = ["fake/model-a", "fake/model-b", "fake/model-c"];

interface Workspace {
  dir: string;
  root: string;
  iso: CliIsolation;
  fakeCli: string;
  log: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function newWorkspace(name: string, nowIso = "2026-09-24T09:00:00"): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-rlfb-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const cliDir = path.join(dir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  // A controlled ACP CLI publishing a 3-model catalog. Behavior is selected by
  // env: a set `FAKE_SUCCESS_MODEL` makes that model succeed and every other
  // model answer a structured rate limit; `FAKE_MODE=fatal` answers a fatal
  // error derived from `fatal <n>`; `FAKE_MODE=hang` never answers.
  const { shim } = writeCcAcpCmdcFixture(cliDir, { models: MODELS, defaultModel: "fake/model-a", sessionId: SESSION });
  const log = path.join(dir, "fake-invocations.jsonl");
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_NOW: nowIso, FAKE_CLI_LOG: log };
  return { dir, root, iso, fakeCli: shim, log, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPromptModel(log: string, project: string, model: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (promptModels(log, project).includes(model)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for primary prompt model ${model}`);
    await sleep(50);
  }
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
      resolve({ url: `http://127.0.0.1:${port}/wake`, bodies, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 60000, root?: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) {
      let durable = "(record unavailable)";
      try {
        if (root) durable = fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8");
      } catch {}
      throw new Error(`job ${id} did not reach a terminal state; last result=${JSON.stringify(r)}; durable=${durable.slice(0, 4000)}`);
    }
    await sleep(150);
  }
}

function jobRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

/** The effective model of every attempt against ONE project, in order. */
function promptModels(log: string, project: string): Array<string | null> {
  return promptEventsFor(log, project).map((entry) => entry.model ?? null);
}

/** Configure the first-release chain: default model-b > fallback model-c. */
async function configure(client: McpStdioClient, ws: Workspace, fallback = "fake/model-c"): Promise<void> {
  const updated = McpStdioClient.json(
    await client.callTool("jobquay_settings_update", {
      cli_path: ws.fakeCli,
      default_model: "fake/model-b",
      rate_limit_fallback_model: fallback,
      permission_mode: "accept-edits"
    })
  );
  assert.equal(updated.ok, true);
}

test("a clear rate limit downgrades the chain in order on the SAME session, wakes exactly once, and persists across an MCP restart", { timeout: 180000 }, async () => {
  const ws = newWorkspace("cascade");
  ws.env.FAKE_SUCCESS_MODEL = "fake/model-c";
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const listener = await startListener();
  let clientA: McpStdioClient | null = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  let clientB: McpStdioClient | null = null;
  const task = "RL_TASK_MARKER — must be sent verbatim once and never again";
  try {
    await clientA.initialize();
    await configure(clientA, ws);

    const spawned = McpStdioClient.json(await clientA.callTool("jobquay_spawn", { task, cwd: project, callback_url: listener.url }));
    assert.equal(spawned.ok, true);
    const id = String(spawned.job_id);
    const done = await waitTerminal(clientA, id);
    assert.equal(done.status, "done");
    assert.equal(done.generation, 1, "the chain advanced once (b → c)");
    assert.equal(done.model, "fake/model-c");
    assert.equal(done.model_source, "rate-limit-fallback");
    assert.deepEqual(done.model_chain, ["fake/model-b", "fake/model-c"]);
    assert.equal(done.downgraded, true, "the result view must surface the downgrade");
    assert.equal((done.result as Record<string, unknown>).final_text, "OK:fake/model-c");

    // The persisted record: three attempts, one candidate each, same session.
    const rec = jobRecord(ws.root, id);
    assert.equal(rec.model, "fake/model-c");
    assert.equal(rec.modelSource, "rate-limit-fallback");
    assert.deepEqual(rec.modelChain, ["fake/model-b", "fake/model-c"]);
    assert.equal(rec.promptKind, "recovery");
    const attempts = rec.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((a) => [a.model, a.modelSource, a.rateLimited]),
      [
        ["fake/model-b", "config-default", true],
        ["fake/model-c", "rate-limit-fallback", false]
      ]
    );
    assert.equal(attempts[0]?.resumedFrom, null);
    assert.equal(attempts[1]?.resumedFrom, SESSION);
    // Usage is the sum over the attempts that REPORTED turn usage. Over ACP a
    // rate-limited attempt fails with a structured JSON-RPC error and publishes
    // no turn counters, so only the successful (resumed) attempt contributes;
    // an unreported metric (cache) stays null.
    const usage = rec.usage as Record<string, number | null>;
    assert.equal(usage.tokensIn, 5);
    assert.equal(usage.tokensOut, 2);
    assert.equal(usage.cacheRead, null);

    // On the wire: the production ACP session carried the candidates IN ORDER;
    // only the first run was fresh; the resumed run attached the SAME session
    // and got the fixed internal recovery prompt — NEVER the task again.
    const prompts = promptEventsFor(ws.log, project);
    assert.equal(prompts.length, 2, "each candidate is called at most once");
    assert.deepEqual(prompts.map((p) => p.model), ["fake/model-b", "fake/model-c"]);
    assert.equal(prompts[0]!.text, task, "the task must reach the primary verbatim");
    assert.equal(prompts[1]!.text, RECOVERY_PROMPT, "a resumed attempt must NOT re-send the full task");
    assert.notEqual(prompts[1]!.text, task);
    const log = readCcAcpLog(ws.log);
    const modes = log.filter((entry) => entry.kind === "mode" && sameFixtureCwd(entry.cwd || "", project));
    assert.deepEqual(modes.map((entry) => entry.value), ["auto-accept", "auto-accept"], "accept-edits maps to the ACP auto-accept mode on each attempt");
    const resumes = log.filter((entry) => entry.kind === "resume" && sameFixtureCwd(entry.cwd || "", project));
    assert.equal(resumes[resumes.length - 1]?.sessionId, SESSION, "the SAME session must be resumed over ACP");
    assert.equal(log.some((entry) => entry.kind === "new" && sameFixtureCwd(entry.cwd || "", project)), true, "the first attempt created the session");

    // Exactly ONE terminal wake, with the short job id + status body only.
    await sleep(800);
    assert.equal(listener.bodies.length, 1, "exactly one terminal wake per generation");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.equal(body.job_id, id);
    assert.equal(body.status, "done");
    assert.equal(listener.bodies[0]!.includes("RL_TASK_MARKER"), false, "the wake must not contain the task");

    // ---- a FRESH MCP process reads the SAME persisted record ----
    await clientA.close();
    clientA = null;
    clientB = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await clientB.initialize();
    const after = McpStdioClient.json(await clientB.callTool("jobquay_result", { id }));
    assert.equal(after.status, "done");
    assert.equal(after.model, "fake/model-c");
    assert.deepEqual(after.model_chain, ["fake/model-b", "fake/model-c"]);
    assert.equal(after.downgraded, true);
    assert.equal((after.result as Record<string, unknown>).final_text, "OK:fake/model-c");
    assert.equal(after.generation, 1);
  } finally {
    if (clientA) await clientA.close();
    if (clientB) await clientB.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("the chain is canonical-id deduped: a fallback equal to the primary is not tried twice", { timeout: 120000 }, async () => {
  const ws = newWorkspace("dedup");
  ws.env.FAKE_SUCCESS_MODEL = "fake/model-b";
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    // The fallback equals the primary configured default (fake/model-b) → deduped.
    await configure(client, ws, "fake/model-b");
    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "dedup", cwd: project }));
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");
    assert.deepEqual(done.model_chain, ["fake/model-b"], "the duplicate fallback is dropped");
    assert.equal(done.generation, 0);
    assert.deepEqual(promptModels(ws.log, project), ["fake/model-b"]);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("auth (3), permission (4), insufficient credits (10) and unknown never downgrade", { timeout: 180000 }, async () => {
  const ws = newWorkspace("fatal");
  ws.env.FAKE_MODE = "fatal";
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    await configure(client, ws);
    // The fatal shape is derived from the task text (the MCP server's env is
    // fixed at spawn time, so a per-iteration env mutation would not reach the
    // worker): 3 auth, 4 permission, 10 credits, 99 unknown.
    for (const code of [3, 4, 10, 99]) {
      const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: `fatal ${code}`, cwd: project }));
      const id = String(spawned.job_id);
      const done = await waitTerminal(client, id);
      assert.equal(done.status, "error", `exit ${code} must be terminal`);
      assert.equal(done.generation, 0, `exit ${code} must not start a new generation`);
      assert.equal(done.model, "fake/model-b", `exit ${code} must keep the primary`);
      const rec = jobRecord(ws.root, id);
      assert.equal((rec.attempts as unknown[]).length, 1);
      assert.equal((rec.attempts as Array<Record<string, unknown>>)[0]?.rateLimited, false);
      // Only the primary was ever dispatched for THIS job.
      const prompts = promptEventsFor(ws.log, project).filter((p) => p.text === `fatal ${code}`);
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts.map((p) => p.model), ["fake/model-b"]);
    }
    // The fallback candidate (fake/model-c) must never have been dispatched.
    assert.equal(
      readCcAcpLog(ws.log).some((entry) => entry.kind === "prompt" && entry.model === "fake/model-c"),
      false
    );
    assert.equal(readCcAcpLog(ws.log).some((entry) => entry.kind === "resume"), false, "a fatal failure never resumes a session");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("an exhausted chain ends with a clear terminal error and never loops", { timeout: 120000 }, async () => {
  const ws = newWorkspace("exhaust");
  ws.env.FAKE_SUCCESS_MODEL = ""; // every candidate is rate limited
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    await configure(client, ws);
    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "exhaust", cwd: project }));
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id, 60000, ws.root);
    assert.equal(done.status, "error");
    assert.equal((done.result as Record<string, unknown>).stop_reason, "rate_limit_fallback_exhausted");
    assert.match(String(done.error), /downgrade candidates are exhausted: tried .+ in order/);
    const rec = jobRecord(ws.root, id);
    assert.equal(rec.stopReason, "rate_limit_fallback_exhausted");
    assert.equal(rec.generation, 1, "the chain advanced once, then stopped");
    assert.equal((rec.attempts as unknown[]).length, 2);
    assert.equal((rec.attempts as Array<Record<string, unknown>>).every((a) => a.rateLimited === true), true);
    assert.deepEqual(promptModels(ws.log, project), ["fake/model-b", "fake/model-c"]);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("an explicit cancel of a running primary is terminal and never starts a downgrade candidate", { timeout: 120000 }, async () => {
  const ws = newWorkspace("cancel");
  ws.env.FAKE_MODE = "hang"; // the primary never answers
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    await configure(client, ws);
    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "hang", cwd: project }));
    const id = String(spawned.job_id);
    // Cancel only after the primary has actually crossed the provider prompt
    // boundary. A fixed sleep is not a start signal and races badly on slower
    // translated/hosted runners.
    await waitForPromptModel(ws.log, project, "fake/model-b");
    const cancelled = McpStdioClient.json(await client.callTool("jobquay_cancel", { id, wait_seconds: 10 }));
    assert.equal(cancelled.status, "cancelled");
    const rec = jobRecord(ws.root, id);
    assert.equal(rec.status, "cancelled");
    assert.equal(rec.generation, 0, "a cancel never advances the chain");
    assert.equal((rec.attempts as unknown[]).length, 1);
    // Only the primary was dispatched; the downgrade candidate was never started.
    assert.deepEqual(promptModels(ws.log, project), ["fake/model-b"]);
    assert.equal(readCcAcpLog(ws.log).some((entry) => entry.kind === "resume"), false, "a cancelled primary never resumes a session");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
