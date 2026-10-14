// mcp-stdio.test.ts — REAL-ENTRY acceptance of the built CrewDispatch MCP server
// (`dist/mcp/server.js`) over the official SDK's stdio transport.
//
// Every case spawns the BUILT server as a SEPARATE process and drives it with
// real JSON-RPC (initialize → tools/list → tools/call). The executed child is a
// controlled executable fixture (the production path except the provider binary),
// so this is cross-process service evidence, not a mock of the service.
//
// It proves:
//   * initialize / tools/list / tools/call work and the tool surface has no
//     provider/edition selector and no task in its metadata;
//   * crewdispatch_spawn returns a stable job id FAST while the job keeps running;
//   * the accepted job SURVIVES the MCP client process being killed;
//   * the requested cwd and the task bytes reach the child unchanged;
//   * the terminal result is collected once, and the status/result views are
//     bounded and whitelisted (no task marker, no provider session id);
//   * a follow-up continues the SAME job/session in a new generation;
//   * an explicit cancel kills the real child+grandchild process tree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { isPidAlive } from "../../runtime/process";
import { McpStdioClient, type McpToolResult } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface Workspace {
  dir: string;
  root: string;
  project: string;
  iso: CliIsolation;
  fixture: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function writeFixture(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

const HEADER = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

/** Writes the exact stdin it received to <cwd>/received-task.txt, then succeeds. */
function fixtureEcho(ms = 0): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  fs.writeFileSync(path.join(process.cwd(), "received-task.txt"), input);',
    '  const sid = "fx-session-echo";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    `  setTimeout(() => { out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: sid, stop_reason: "end_turn" }); process.exit(0); }, ${ms});`,
    "});"
  ];
}

/** Records its argv (to prove `--resume <sid>` reached the child), then succeeds. */
function fixtureResume(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  fs.appendFileSync(path.join(process.cwd(), "resume-args.txt"), process.argv.slice(2).join(" ") + "\\n");',
    '  const sid = "fx-session-echo";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: sid, stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

/** Spawns a real DETACHED grandchild, records its PID, then hangs. */
function fixtureHangGrandchild(): string[] {
  return [
    'const { spawn } = require("node:child_process");',
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });',
    '  fs.writeFileSync(path.join(process.cwd(), "grand.pid"), String(grand.pid));',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-hang" } });',
    "  setInterval(() => {}, 1000);",
    "});"
  ];
}

function newWorkspace(name: string, fixtureLines: string[]): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-mcp-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = writeFixture(dir, `${name}.js`, fixtureLines);
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  return { dir, root, project, iso, fixture, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

test("the built MCP server answers initialize/tools/list and exposes the provider-aware task-free tool surface", { timeout: 60000 }, async () => {
  const ws = newWorkspace("surface", fixtureEcho());
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    const init = await client.initialize();
    const serverInfo = init.serverInfo as Record<string, unknown>;
    assert.equal(serverInfo.name, "crewdispatch");
    assert.ok(typeof init.protocolVersion === "string" && init.protocolVersion.length > 0);

    const tools = await client.listTools();
    const names = tools.map((t) => String(t.name)).sort();
    assert.deepEqual(names, [
      "crewdispatch_cancel",
      "crewdispatch_follow_up",
      "crewdispatch_result",
      "crewdispatch_run",
      "crewdispatch_settings_get",
      "crewdispatch_settings_update",
      "crewdispatch_spawn",
      "crewdispatch_status"
    ]);

    // The dispatch tools expose an OPTIONAL first-release provider selector:
    // Command Code is the default and WorkBuddy AI is explicit.
    const raw = JSON.stringify(tools);
    const spawnTool = tools.find((t) => t.name === "crewdispatch_spawn")!;
    const runTool = tools.find((t) => t.name === "crewdispatch_run")!;
    const spawnSchema = spawnTool.inputSchema as Record<string, unknown>;
    const runSchema = runTool.inputSchema as Record<string, unknown>;
    for (const [name, schema] of [
      ["crewdispatch_spawn", spawnSchema],
      ["crewdispatch_run", runSchema]
    ] as const) {
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      assert.ok(props.provider, `${name} must publish an optional provider field`);
      assert.deepEqual([...((props.provider.enum as string[]) ?? [])].sort(), ["command-code", "workbuddy-ai"], `${name} provider enum`);
      const required = (schema.required as string[]) ?? [];
      assert.equal(required.includes("provider"), false, `${name} provider must be optional (not required)`);
      assert.match(String(props.provider.description ?? ""), /workbuddy-ai/i, `${name} provider description must mention workbuddy-ai`);
    }
    assert.equal(raw.includes('"edition"'), false, "no edition selector may be exposed");

    for (const name of ["crewdispatch_settings_get", "crewdispatch_settings_update"]) {
      const tool = tools.find((t) => t.name === name)!;
      assert.match(String(tool.description), /Command Code/i, `${name} must identify the Command Code settings surface`);
    }
    // Rate-limit fallback remains active, while first-release time scheduling and
    // in-flight clock-boundary switching stay disabled.
    const settingsUpdate = tools.find((t) => t.name === "crewdispatch_settings_update")!;
    const settingsUpdateDesc = String(settingsUpdate.description);
    assert.match(settingsUpdateDesc, /ACTIVE/i, "settings_update must state the rate-limit fallback is implemented");
    assert.match(settingsUpdateDesc, /time-of-day schedules.*disabled|in-flight.*disabled/i, "settings_update must state scheduling is disabled");

    // The spawn description carries the evidence-led task-packet guidance.
    const spawn = tools.find((t) => t.name === "crewdispatch_spawn")!;
    const desc = String(spawn.description);
    for (const needle of ["EVIDENCE-LED", "cwd", "INVESTIGATION", "acceptance", "IMPLEMENTATION", "codex_thread_id", "VERBATIM"]) {
      assert.ok(desc.includes(needle), `spawn description must mention ${needle}`);
    }
    assert.match(desc, /workbuddy-ai/i, "spawn description must publish the WorkBuddy AI provider");

    // The result/follow-up tool-selection descriptions stay succinct,
    // provider/client-neutral and consistent with the advisory continuation
    // policy: same-objective defects default to follow-up, spawn is for a new
    // objective, and an external acceptance owner is the exception.
    const resultDesc = String(tools.find((t) => t.name === "crewdispatch_result")!.description);
    const followDesc = String(tools.find((t) => t.name === "crewdispatch_follow_up")!.description);
    for (const [name, text] of [
      ["crewdispatch_result", resultDesc],
      ["crewdispatch_follow_up", followDesc]
    ] as const) {
      assert.match(text, /crewdispatch_spawn/, `${name} description must name the independent-dispatch tool`);
      assert.match(text, /external controller/i, `${name} description must keep the external-controller exception`);
      assert.equal(/command-code|workbuddy-ai|codex/i.test(text), false, `${name} description must stay provider/client-neutral`);
    }
    assert.match(resultDesc, /crewdispatch_follow_up/, "result description must name the same-job continuation tool");
    assert.match(resultDesc, /continuation_hint/, "result description must publish the terminal advisory field");
    assert.match(followDesc, /SAME objective/i, "follow_up description must state the same-objective default");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("spawn returns a stable id fast, the job survives the caller being killed, and the result is collected once", { timeout: 60000 }, async () => {
  const ws = newWorkspace("survive", fixtureEcho(1500));
  const task = "TASK_MARKER_a1b2c3 — keep these exact bytes";
  let id = "";
  const first = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await first.initialize();
    const t0 = Date.now();
    const spawned = McpStdioClient.json(await first.callTool("jobquay_spawn", { task, cwd: ws.project }));
    const elapsed = Date.now() - t0;
    assert.equal(spawned.ok, true);
    id = String(spawned.job_id);
    assert.match(id, /^job-/);
    // A cold first dispatch may include the one-time broker bootstrap (notably
    // the Windows CIM ownership handoff), so wall-clock time is no longer the
    // proof of asynchronous semantics. Keep a bounded cold-start guard, then
    // prove the accepted worker is STILL non-terminal when the id is returned.
    assert.ok(elapsed < 5000, `cold daemon + spawn should remain bounded (took ${elapsed}ms)`);

    const early = McpStdioClient.json(await first.callTool("crewdispatch_result", { id }));
    assert.equal(early.terminal, false, "spawn returns while the accepted job is still running");
    assert.equal(
      Object.prototype.hasOwnProperty.call(early, "continuation_hint"),
      false,
      "a non-terminal result carries no terminal acceptance guidance"
    );

    // Caller (MCP server process) goes away; the accepted job must keep running.
    first.kill();
    await sleep(300);
  } finally {
    first.kill();
  }

  const second = new McpStdioClient(MCP_ENTRY, { ...ws.env, JOBQUAY_DATA_ROOT: undefined, CREWDISPATCH_DATA_ROOT: ws.root }, ws.dir);
  try {
    await second.initialize();
    const done = await waitTerminal(second, id);
    assert.equal(done.status, "done");
    const result = done.result as Record<string, unknown>;
    assert.equal(result.final_text, "DONE-MARKER");

    // A terminal result carries ONE short advisory hint naming THIS job, the
    // same-objective repair default and the external-controller exception.
    // Focused regexes, not a snapshot of the whole prose.
    const hint = done.continuation_hint;
    assert.equal(typeof hint, "string", "a terminal result must carry continuation_hint");
    assert.ok((hint as string).includes(id), "the hint must name the actual current job id");
    assert.match(hint as string, /crewdispatch_follow_up/);
    assert.match(hint as string, /crewdispatch_spawn/);
    assert.match(hint as string, /SAME objective/i);
    assert.match(hint as string, /precise repair packet/i);
    assert.match(hint as string, /external controller/i);

    // A repeated one-shot read adds no new job, generation, attempt/history or
    // dispatch: it returns the SAME result and hint, leaves the jobs directory
    // unchanged and does not rewrite the job record. (The pre-existing
    // terminal-wake recovery is separate and unchanged.)
    const jobsDir = path.join(ws.root, "jobs");
    const recordFile = path.join(jobsDir, `${id}.json`);
    const jobsBefore = fs.readdirSync(jobsDir).sort();
    const recordBefore = fs.readFileSync(recordFile, "utf8");
    const again = McpStdioClient.json(await second.callTool("crewdispatch_result", { id }));
    assert.equal(again.status, "done");
    assert.equal((again.result as Record<string, unknown>).final_text, "DONE-MARKER");
    assert.equal(again.continuation_hint, hint, "the advisory hint is stable across reads");
    assert.equal(again.generation, 0);
    assert.deepEqual(fs.readdirSync(jobsDir).sort(), jobsBefore, "collecting a result must not create a job/generation/history file");
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "collecting a result must not rewrite the job record");

    // The task bytes reached the child unchanged, and the requested cwd was used.
    const received = fs.readFileSync(path.join(ws.project, "received-task.txt"), "utf8");
    assert.equal(received, task, "the child must receive the task bytes verbatim");
    const record = JSON.parse(recordBefore) as Record<string, unknown>;
    assert.equal(record.task, task);
    assert.equal(path.resolve(String(record.cwd)), path.resolve(ws.project));
    assert.equal(record.generation, 0);
    assert.equal((record.attempts as unknown[]).length, 1);

    // The status view is whitelisted: no raw task, no provider session id, no log path.
    const status = McpStdioClient.json(await second.callTool("crewdispatch_status", { id }));
    const statusText = JSON.stringify(status);
    assert.equal(statusText.includes("TASK_MARKER_a1b2c3"), false, "status must not leak the task");
    assert.equal(statusText.includes("fx-session-echo"), false, "status must not leak the provider session id");
    assert.equal(statusText.includes("logPath"), false);
    assert.equal(statusText.includes(".ndjson"), false);

    // A second terminal state / duplicate job must not exist.
    const list = McpStdioClient.json(await second.callTool("crewdispatch_status", {}));
    assert.equal(list.count, 1);
  } finally {
    await second.close();
    await ws.cleanup();
  }
});

test("a follow-up continues the SAME job/session in a new generation (--resume)", { timeout: 60000 }, async () => {
  const ws = newWorkspace("followup", fixtureResume());
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "first", cwd: ws.project }));
    const id = String(spawned.job_id);
    await waitTerminal(client, id);

    const followed = McpStdioClient.json(await client.callTool("crewdispatch_follow_up", { id, message: "second" }));
    assert.equal(followed.ok, true);
    assert.equal(followed.job_id, id, "follow-up keeps the SAME logical job id");
    assert.equal(followed.generation, 1, "follow-up advances the generation");

    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");
    assert.equal(done.generation, 1);

    // The child saw the ORIGINAL session id via --resume (same session).
    const args = fs.readFileSync(path.join(ws.project, "resume-args.txt"), "utf8").trim().split("\n");
    assert.ok(args.some((a) => a.includes("--resume fx-session-echo")), `expected a --resume of the same session, got: ${args.join(" | ")}`);

    const status = McpStdioClient.json(await client.callTool("crewdispatch_status", { id }));
    const job = status.job as Record<string, unknown>;
    assert.equal((job.attempts as unknown[]).length, 2);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("an explicit cancel kills the real child+grandchild process tree and yields exactly one terminal state", { timeout: 60000 }, async () => {
  const ws = newWorkspace("cancel", fixtureHangGrandchild());
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  let grandPid = 0;
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "hang", cwd: ws.project }));
    const id = String(spawned.job_id);

    // Wait until the grandchild PID is recorded.
    const pidFile = path.join(ws.project, "grand.pid");
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(pidFile)) {
      if (Date.now() >= deadline) throw new Error("grandchild was never spawned");
      await sleep(100);
    }
    grandPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandPid) && grandPid > 0);
    assert.equal(isPidAlive(grandPid), true, "the grandchild must be alive before the cancel");

    const cancelled = McpStdioClient.json(await client.callTool("crewdispatch_cancel", { id }));
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.cancelled, true);
    const kill = cancelled.kill as Record<string, unknown>;
    assert.equal(kill.scope, "os_tree_exited", "a real taskkill tree exit must be reported");

    // The real grandchild is gone.
    const goneDeadline = Date.now() + 10000;
    while (isPidAlive(grandPid) !== false && Date.now() < goneDeadline) await sleep(100);
    assert.equal(isPidAlive(grandPid), false, "the grandchild must be killed by the cancel");

    // Idempotent: exactly one terminal state, no new job.
    const status = McpStdioClient.json(await client.callTool("crewdispatch_status", { id }));
    assert.equal((status.job as Record<string, unknown>).status, "cancelled");

    // A cancelled job is terminal, so it carries the advisory hint — worded so
    // it never recommends an automatic resume without authorized remaining work.
    const cancelledResult = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    assert.equal(cancelledResult.status, "cancelled");
    const cancelHint = cancelledResult.continuation_hint;
    assert.equal(typeof cancelHint, "string", "a cancelled terminal result must carry continuation_hint");
    assert.ok((cancelHint as string).includes(id));
    assert.match(cancelHint as string, /not resumed automatically/i);
    assert.match(cancelHint as string, /authorized remaining work/i);
    assert.match(cancelHint as string, /external controller/i);
    assert.equal(/default to crewdispatch_follow_up/i.test(cancelHint as string), false, "a cancelled job is never an automatic repair default");

    const list = McpStdioClient.json(await client.callTool("crewdispatch_status", {}));
    assert.equal(list.count, 1);
  } finally {
    if (grandPid) {
      try {
        process.kill(grandPid);
      } catch {
        /* already gone */
      }
    }
    await client.close();
    await ws.cleanup();
  }
});

test("input validation returns stable codes through the MCP entry", { timeout: 60000 }, async () => {
  const ws = newWorkspace("validate", fixtureEcho());
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();

    const badThread: McpToolResult = await client.callTool("crewdispatch_spawn", { task: "x", cwd: ws.project, codex_thread_id: "bad id!" });
    assert.equal(badThread.isError, true);
    assert.equal(McpStdioClient.json(badThread).code, "invalid_codex_thread_id");

    const badCb = await client.callTool("crewdispatch_spawn", { task: "x", cwd: ws.project, callback_url: "ftp://nope" });
    assert.equal(badCb.isError, true);
    assert.equal(McpStdioClient.json(badCb).code, "invalid_callback_url");

    const badCwd = await client.callTool("crewdispatch_spawn", { task: "x", cwd: path.join(ws.dir, "does-not-exist") });
    assert.equal(badCwd.isError, true);
    assert.equal(McpStdioClient.json(badCwd).code, "invalid_cwd");

    const missing = await client.callTool("crewdispatch_result", { id: "job-nope" });
    assert.equal(missing.isError, true);
    assert.equal(McpStdioClient.json(missing).code, "not_found");
    assert.equal(JSON.stringify(missing).includes("continuation_hint"), false, "an unknown job carries no terminal acceptance guidance");

    // No job was created by any rejected call.
    const list = McpStdioClient.json(await client.callTool("crewdispatch_status", {}));
    assert.equal(list.count, 0);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
