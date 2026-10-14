// command-code-acp-model-default-effort.test.ts — CROSS-PROCESS acceptance of
// the model-default effort PROVENANCE rule through the BUILT MCP entry.
//
// The real Command Code ACP CLI (1.74.1) RESOLVES a model-default request
// (effort null) to a concrete level (`medium` for `stealth/space-bunny-alpha`).
// A continuation that resumes the same session then sees that concrete value.
// The bridge must continue under the model-default intent when the WORKER can
// prove this job never selected an explicit effort for that model on its own
// session — and must keep refusing when it cannot.
//
// This drives the REAL production chain (built MCP entry -> daemon -> detached
// worker -> production adapter -> REAL ACP bridge -> a controlled ACP CLI
// fixture that resolves the default to `medium`), so the durable-attempt
// provenance derivation itself is exercised, not merely a boolean passed to the
// bridge. The fixture's public/ACP shapes mirror the installed CLI's recorded
// wire (see tests/helpers/cc-acp-fixture.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { createJobRecord } from "../../jobs/service";
import { saveJob } from "../../jobs/store";
import { emptyUsage } from "../../jobs/types";
import { McpStdioClient } from "../helpers/mcp-client";
import { promptEventsFor, readCcAcpLog, writeCcAcpCmdcFixture } from "../helpers/cc-acp-fixture";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const MODEL_A = "fixture/model-a";
const MODEL_B = "fixture/model-b";
const SESSION = "session-model-default";

interface Workspace {
  dir: string;
  root: string;
  iso: CliIsolation;
  fakeCli: string;
  log: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function newWorkspace(name: string, models: readonly string[]): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-defeffort-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const cliDir = path.join(dir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  // The fixture resolves a model-default request to `medium` and does NOT offer
  // `default` as a selectable level — the exact shape that produced the real
  // false rejection.
  const { shim } = writeCcAcpCmdcFixture(cliDir, {
    models,
    defaultModel: models[0] ?? MODEL_A,
    defaultEffort: "medium",
    sessionId: SESSION
  });
  const log = path.join(dir, "fake-invocations.jsonl");
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, FAKE_CLI_LOG: log };
  return { dir, root, iso, fakeCli: shim, log, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state (last=${JSON.stringify(r).slice(0, 300)})`);
    await sleep(150);
  }
}

function jobRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

async function configure(client: McpStdioClient, ws: Workspace, extra: Record<string, unknown> = {}): Promise<void> {
  const updated = McpStdioClient.json(
    await client.callTool("jobquay_settings_update", {
      cli_path: ws.fakeCli,
      default_model: MODEL_A,
      permission_mode: "accept-edits",
      ...extra
    })
  );
  assert.equal(updated.ok, true, JSON.stringify(updated));
}

test("a fresh model-default turn that resolves to a concrete provider value continues null on the SAME session follow-up", { timeout: 120000 }, async () => {
  const ws = newWorkspace("proven", [MODEL_A]);
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    await configure(client, ws);

    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "first turn", cwd: project }));
    const id = String(spawned.job_id);
    const done0 = await waitTerminal(client, id);
    assert.equal(done0.status, "done", JSON.stringify(done0.result));
    const rec0 = jobRecord(ws.root, id);
    assert.equal(rec0.sessionId, SESSION, "the fresh attempt created the controlled session");
    assert.equal((rec0.attempts as Array<Record<string, unknown>>)[0]?.effort, null, "the primary ran at the model default");

    // The SAME session follow-up is still a model-default request. Without the
    // provenance rule the bridge would refuse it as a remembered explicit level.
    const followed = McpStdioClient.json(await client.callTool("jobquay_follow_up", { id, message: "second turn" }));
    assert.equal(followed.ok, true, JSON.stringify(followed));
    const done1 = await waitTerminal(client, id);
    assert.equal(done1.status, "done", `the model-default continuation must succeed, not be refused: ${JSON.stringify(done1.result)}`);
    assert.equal((done1.result as Record<string, unknown>).kind, "success");

    const rec1 = jobRecord(ws.root, id);
    const attempts = rec1.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.effort, null, "the follow-up stays at the accepted model default (null)");
    assert.equal(attempts[1]?.resumedFrom, SESSION, "the follow-up resumes the SAME owned session");

    // The provider was reached twice on the SAME session (no refusal, no new one).
    const prompts = promptEventsFor(ws.log, project);
    assert.equal(prompts.length, 2, "both generations prompted the provider");
    assert.deepEqual(prompts.map((p) => p.model), [MODEL_A, MODEL_A]);
    const resumes = readCcAcpLog(ws.log).filter((e) => e.kind === "resume");
    assert.equal(resumes[resumes.length - 1]?.sessionId, SESSION, "the follow-up resumed the owned session");
    assert.equal(readCcAcpLog(ws.log).some((e) => e.kind === "model"), false, "the same session needed no model switch");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("a previous EXPLICIT effort for the SAME model keeps a later null follow-up protected (no silent inheritance)", { timeout: 120000 }, async () => {
  const ws = newWorkspace("protected", [MODEL_A]);
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    await configure(client, ws);

    // Normal flows keep a continuation's effort FROZEN to the accepted intent, so
    // an explicit-then-null SAME-MODEL sequence is only reachable through a
    // durable record whose accepted (null) plan continues a session that an
    // earlier attempt ran at an explicit level. Seed exactly that record and
    // drive the REAL continuation path so the provenance derivation is exercised.
    const seed = createJobRecord({ task: "seeded explicit first turn", cwd: project });
    seed.provider = "command-code";
    seed.runner = "command-code";
    seed.status = "done";
    seed.finishedAt = new Date().toISOString();
    seed.sessionId = SESSION;
    seed.model = MODEL_A;
    seed.modelSource = "config-default";
    seed.effort = null;
    seed.modelChainPlan = [{ model: MODEL_A, source: "config-default", effort: null }];
    seed.acceptedIntent = { primaryModel: MODEL_A, primarySource: "config-default", primaryEffort: null, fallbacks: [] };
    seed.attempts = [
      {
        generation: 0,
        startedAt: new Date(Date.now() - 60000).toISOString(),
        endedAt: new Date(Date.now() - 59000).toISOString(),
        exitCode: 0,
        kind: "success",
        failureKind: null,
        segment: false,
        resumedFrom: null,
        model: MODEL_A,
        modelSource: "config-default",
        effort: "high",
        rateLimited: false,
        switched: false,
        switchToModel: null,
        usage: emptyUsage()
      }
    ];
    saveJob(ws.root, seed);

    const followed = McpStdioClient.json(await client.callTool("jobquay_follow_up", { id: seed.id, message: "second turn" }));
    assert.equal(followed.ok, true, JSON.stringify(followed));
    const done1 = await waitTerminal(client, seed.id);
    assert.equal(done1.status, "error", `an explicit remembered effort must not be inherited: ${JSON.stringify(done1.result)}`);
    assert.match(String(done1.error), /remembers reasoning effort/);

    // The refused generation attached the session but never reached a prompt.
    assert.equal(promptEventsFor(ws.log, project).length, 0, "the protected generation never reached a prompt");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("a cross-model rate-limit fallback does not inherit the primary's explicit effort (provenance is model-bound)", { timeout: 120000 }, async () => {
  const ws = newWorkspace("crossmodel", [MODEL_A, MODEL_B]);
  ws.env.FAKE_SUCCESS_MODEL = MODEL_B; // A rate-limits (exit 5) -> fall back to B
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    // Primary (A, high) is an explicit effort; the fallback (B) is null/default.
    await configure(client, ws, { default_effort: "high", rate_limit_fallback_model: MODEL_B });

    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "cross model", cwd: project }));
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done", `the fallback model default must be accepted: ${JSON.stringify(done.result)}`);
    assert.equal(done.model, MODEL_B);

    const rec = jobRecord(ws.root, id);
    const attempts = rec.attempts as Array<Record<string, unknown>>;
    assert.deepEqual(
      attempts.map((a) => [a.model, a.effort]),
      [
        [MODEL_A, "high"],
        [MODEL_B, null]
      ],
      "the primary ran explicit; the fallback ran the model default"
    );
    assert.equal(attempts[1]?.resumedFrom, SESSION);
    // Two prompts on the SAME session, the second on the other model.
    const prompts = promptEventsFor(ws.log, project);
    assert.equal(prompts.length, 2);
    assert.deepEqual(prompts.map((p) => p.model), [MODEL_A, MODEL_B]);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
