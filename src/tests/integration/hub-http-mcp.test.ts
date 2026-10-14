// hub-http-mcp.test.ts — CROSS-PROCESS acceptance for the CrewDispatch Hub.
//
// This is the REQUIRED external evidence for M1 batch 7A: a REAL, independently
// started Hub HTTP process AND a REAL, independently started MCP process are
// pointed at the SAME disposable temp CrewDispatch root, and a CONTROLLED official-CLI
// fixture (a Node child driven through the product's own runner) creates jobs
// via MCP — NEVER via the Hub (the Hub has no task-creation path). The tests
// prove the Hub observes the MCP-created jobs and drives follow-up/cancel
// through the EXACT production paths, that settings persist across a Hub
// restart, that the diagnostics cleanup removes only terminal job groups
// (never active jobs or job metadata), that cross-origin writes are rejected,
// and that a new-task POST is 404.
//
// Everything runs under an isolated CLI profile in a temp root; no real user
// CrewDispatch data, official CLI profile, or notification target is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { prepareContinuation, startJob } from "../../jobs/service";
import { loadUserMessagesInfo } from "../../jobs/messages";
import { listJobs } from "../../jobs/store";
import { startHub } from "../../hub/server";
import { enforceRetention } from "../../hub/retention";
import { killProcessTree } from "../../runtime/process";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const HUB_ENTRY = path.join(__dirname, "..", "..", "hub", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

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
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-hub" } });',
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: "fx-session-hub", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

function fixtureWithReasoning(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "assistant", content: "VISIBLE_CONTENT_MARKER", reasoning: "SECRET_REASONING_MARKER", nested: { thinking: "SECRET_THINKING_MARKER" } });',
    '  out({ type: "event", event: { type: "thinking_start" } });',
    '  out({ type: "event", event: { type: "thinking_delta", delta: "SECRET_STREAM_REASONING_DELTA" } });',
    '  out({ type: "event", event: { type: "message_update", content: [{ type: "thinking", thinking: "SECRET_STREAM_REASONING_SNAPSHOT" }, { type: "text", text: "VISIBLE_STREAM_TEXT" }] } });',
    '  out({ type: "event", event: { type: "thinking_end", text: "SECRET_STREAM_REASONING_COMPLETE" } });',
    '  out({ type: "event", event: { type: "tool_queued", toolCallId: "call-1", toolName: "read_file", input: { paths: ["README.md"] } } });',
    '  out({ type: "event", event: { type: "tool_completed", toolCallId: "call-1", toolName: "read_file", result: [{ type: "text", text: "VISIBLE_TOOL_RESULT_MARKER" }] } });',
    '  out({ type: "event", event: { type: "model_request_end", model: "deepseek/deepseek-v4.1-flash", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 }, stopReason: "tool_calls" } });',
    '  out({ type: "result", subtype: "success", result: "VISIBLE_RESULT_MARKER", session_id: "fx-session-reasoning", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

function fixtureSlowSuccess(ms: number): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-hub" } });',
    `  setTimeout(() => { out({ type: "result", subtype: "success", result: "SLOW-DONE", session_id: "fx-session-hub", stop_reason: "end_turn" }); process.exit(0); }, ${ms});`,
    "});"
  ];
}

interface Workspace {
  dir: string;
  root: string;
  project: string;
  fixture: string;
  env: NodeJS.ProcessEnv;
  mcp: McpStdioClient;
  hub: ChildProcess;
  hubPort: number;
  hubUrl: string;
  cleanup: () => Promise<void>;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  if (child.pid) await killProcessTree(child.pid, { graceMs: 1000 }).catch(() => undefined);
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore a process that exited between the check and signal */
  }
  await Promise.race([closed, sleep(1500)]);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHub(hub: ChildProcess, timeoutMs = 15000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)\/api/.exec(buf);
      if (m) {
        hub.stderr?.removeListener("data", onData);
        resolve(Number(m[1]));
      } else if (Date.now() >= deadline) {
        hub.stderr?.removeListener("data", onData);
        reject(new Error("hub did not start in time"));
      }
    };
    hub.stderr?.on("data", onData);
  });
}

async function makeWorkspace(name: string, fixtureLines: string[]): Promise<Workspace> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-hub-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, `${name}.js`);
  fs.writeFileSync(fixture, fixtureLines.join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    JOBQUAY_TEST_NOW: "2026-09-24T00:00:00.000Z"
  };
  const mcp = new McpStdioClient(MCP_ENTRY, env, dir);
  await mcp.initialize();
  const port = await getFreePort();
  const hub = spawn(process.execPath, [HUB_ENTRY], {
    env: { ...env, HUB_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  const hubPort = await waitForHub(hub);
  const workspace: Workspace = {
    dir,
    root,
    project,
    fixture,
    env,
    mcp,
    hub,
    hubPort,
    hubUrl: `http://127.0.0.1:${hubPort}`,
    cleanup: async () => {
      await mcp.close().catch(() => undefined);      await stopChild(workspace.hub);
      // Closing the MCP process is not evidence that the durable daemon exited.
      // Reuse the shared bounded test finalizer so Windows never removes a root
      // while its broker is still releasing heartbeat/meta handles.
      await McpStdioClient.cleanupWorkspace(root, dir);
    }
  };
  return workspace;
}

async function restartHub(ws: Workspace): Promise<void> {
  await stopChild(ws.hub);
  const next = spawn(process.execPath, [HUB_ENTRY], {
    env: { ...ws.env, HUB_PORT: String(ws.hubPort) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  await waitForHub(next, 15000);
  ws.hub = next;
}

interface HubResp {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

function hubRequest(url: string, opts: { method?: string; body?: unknown; origin?: string; host?: string } = {}): Promise<HubResp> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        method: opts.method ?? "GET",
        headers: {
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
          ...(opts.origin ? { Origin: opts.origin } : {}),
          ...(opts.host ? { Host: opts.host } : {})
        }
      },
      (res) => {
        let b = "";
        res.on("data", (d: Buffer) => (b += d.toString("utf8")));
        res.on("end", () => {
          let parsed: any = null;
          try {
            parsed = b ? JSON.parse(b) : null;
          } catch {
            parsed = b;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mcpSpawn(ws: Workspace, task: string): Promise<string> {
  const r = McpStdioClient.json(await ws.mcp.callTool("jobquay_spawn", { task, cwd: ws.project }));
  assert.equal(r.ok, true, "spawn must succeed");
  return String(r.job_id);
}

async function waitMcpTerminal(ws: Workspace, id: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await ws.mcp.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

async function waitMcpActiveDiagnostics(ws: Workspace, id: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const diagnosticFiles = [
    path.join(ws.root, "logs", `${id}.ndjson`),
    path.join(ws.root, "logs", `${id}.worker.log`),
    path.join(ws.root, "jobs", `${id}.json`)
  ];
  for (;;) {
    const r = McpStdioClient.json(await ws.mcp.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) throw new Error(`job ${id} became terminal before its active diagnostics were ready`);
    if (diagnosticFiles.every((file) => fs.existsSync(file))) return;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not create its active diagnostics before timeout`);
    await sleep(150);
  }
}

test("Hub observes MCP-created job: first message, terminal, pagination, incremental log, follow-up same id, cancel", { timeout: 90000 }, async () => {
  const ws = await makeWorkspace("flow", fixtureEcho());
  try {
    const id = await mcpSpawn(ws, "TASK_MARKER_hub_flow — must appear as the original task");
    await waitMcpTerminal(ws, id);
    await sleep(700); // let the detached worker fully exit before a follow-up

    // ---- Hub sees the job (terminal) ----
    const detail = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(detail.status, "done", "hub must see the terminal status");
    assert.equal(detail.task, "TASK_MARKER_hub_flow — must appear as the original task", "hub shows the ORIGINAL first task");
    assert.equal(detail.assistant_content, "DONE-MARKER", "hub shows the recorded assistant content");
    assert.deepEqual(detail.assistant_messages, [{ generation: 0, text: "DONE-MARKER", at: detail.finished_at }], "hub persists the generation-0 assistant reply");
    assert.equal(detail.assistant_missing, false);
    assert.ok(detail.model, "hub reports a model");
    assert.ok(detail.usage, "hub reports usage object");
    assert.equal(detail.follow_ups.length, 0, "no follow-ups yet");

    // ---- pagination (page size must be one of the allowed options) ----
    const list = (await hubRequest(`${ws.hubUrl}/api/jobs?limit=20`)).body;
    assert.equal(list.total, 1);
    assert.equal(list.has_more, false);
    assert.equal(list.limit, 20, "echoes the requested page size");
    assert.equal(list.jobs[0].job_id, id);
    // default page size is 50
    const def = (await hubRequest(`${ws.hubUrl}/api/jobs`)).body;
    assert.equal(def.limit, 50);
    // an illegal page size is rejected (contract: reject unknown/illegal fields)
    const badLimit = (await hubRequest(`${ws.hubUrl}/api/jobs?limit=2`)).body;
    assert.equal(badLimit.error, "bad_pagination", "non-allowed page size is rejected");

    // ---- incremental bounded log (no fabricated reasoning) ----
    const logAll = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?limit=1000`)).body;
    assert.equal(logAll.terminal, true);
    assert.equal(logAll.drained, true, "reading with a large limit drains the log");
    assert.ok(Array.isArray(logAll.entries) && logAll.entries.length >= 2, "log has entries");
    const hasResult = logAll.entries.some((e: any) => e.data && e.data.type === "result");
    assert.ok(hasResult, "log contains the CLI result record");
    const hasReasoning = logAll.entries.some((e: any) => "reasoning" in e);
    assert.equal(hasReasoning, false, "no fabricated reasoning field");

    // cursor advances and is bounded
    const first = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?cursor=0&limit=1`)).body;
    assert.equal(first.entries.length, 1);
    assert.match(first.cursor, /^\d+$/, "cursor is an opaque byte offset at the next record boundary");
    assert.ok(Number(first.cursor) > 0);
    assert.ok(first.read_bytes <= 256 * 1024);
    assert.equal(first.drained, false);

    // ---- follow-up (terminal only) reuses the SAME job id ----
    const followUp = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/follow-up`, {
      method: "POST",
      body: { message: "FOLLOWUP_MARKER_hub" }
    });
    assert.equal(followUp.status, 200, `follow-up must succeed (got ${followUp.status}: ${JSON.stringify(followUp.body)})`);
    assert.equal(followUp.body?.generation, 1, `follow-up opens generation 1 (body=${JSON.stringify(followUp)})`);
    assert.equal(followUp.body.job_id, id, "follow-up keeps the SAME job id");

    await waitMcpTerminal(ws, id);
    const after = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(after.status, "done");
    assert.equal(after.follow_ups.length, 1, "hub shows the follow-up message");
    assert.equal(after.follow_ups[0].text, "FOLLOWUP_MARKER_hub");
    assert.equal(after.follow_ups[0].generation, 1);
    assert.equal(after.user_messages[1].source, "dashboard", "a Hub composer follow-up is labelled as Dashboard provenance only in local UI metadata");
    assert.equal(after.task, "TASK_MARKER_hub_flow — must appear as the original task", "original task preserved across follow-up");
    assert.equal(after.history_available, true);
    assert.deepEqual(after.assistant_messages.map((m: any) => [m.generation, m.text]), [[0, "DONE-MARKER"], [1, "DONE-MARKER"]], "hub keeps both assistant replies across a follow-up");

    // The Hub reads the durable side-car again after a real process restart.
    await restartHub(ws);
    const restarted = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(restarted.task, "TASK_MARKER_hub_flow — must appear as the original task");
    assert.equal(restarted.follow_ups[0].text, "FOLLOWUP_MARKER_hub");
    assert.equal(restarted.history_available, true);
    assert.deepEqual(restarted.assistant_messages.map((m: any) => [m.generation, m.text]), [[0, "DONE-MARKER"], [1, "DONE-MARKER"]], "assistant history survives a Hub restart");

    // Simulate an older durable job that predates the message side-car. Its
    // current `job.task` is the follow-up, so the Hub must report no original
    // task instead of relabeling the latest task as the original.
    fs.unlinkSync(path.join(ws.root, "messages", `${id}.json`));
    const legacy = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(legacy.task, null);
    assert.equal(legacy.history_available, false);
    assert.equal(legacy.history_reason, "missing");
    assert.deepEqual(legacy.follow_ups, []);

    // ---- cancel a RUNNING job returns cancelled (explicit cancel path) ----
    const wsSlow = await makeWorkspace("slowcancel", fixtureSlowSuccess(4000));
    try {
      const sid = await mcpSpawn(wsSlow, "slow job to cancel");
      // cancel while it is still running
      const cancelled = (await hubRequest(`${wsSlow.hubUrl}/api/jobs/${sid}/cancel`, { method: "POST", body: { wait_seconds: 6 } })).body;
      assert.equal(cancelled.status, "cancelled", "explicit cancel must terminate a running job");
      assert.equal(cancelled.job_id, sid);
    } finally {
      await wsSlow.cleanup();
    }
  } finally {
    await ws.cleanup();
  }
});

test("Hub HTTP list and detail preserve each persisted provider", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("providers", fixtureEcho());
  try {
    const missingWorker = path.join(ws.dir, "worker-must-not-run.js");
    const tasks = [
      { provider: "command-code", task: "UI_PROVIDER_MARKER_command-code" },
      { provider: "workbuddy-ai", task: "UI_PROVIDER_MARKER_workbuddy-ai", model: "hy4-preview-f" }
    ];

    // Exercise the normal durable job creation path, then stop before execution:
    // the intentionally missing worker leaves a persisted terminal record and
    // cannot invoke either provider CLI or spend model quota.
    for (const item of tasks) {
      assert.throws(
        () => startJob({
          root: ws.root,
          cwd: ws.project,
          task: item.task,
          provider: item.provider,
          model: "model" in item ? item.model : null,
          workerScript: missingWorker,
          env: ws.env
        }),
        (error: any) => error?.code === "worker_missing"
      );
    }

    const list = (await hubRequest(`${ws.hubUrl}/api/jobs?limit=20`)).body;
    assert.equal(list.total, tasks.length);
    for (const item of tasks) {
      const summary = list.jobs.find((job: any) => job.display_title === item.task);
      assert.ok(summary, `Hub list contains ${item.task}`);
      assert.equal(summary.provider, item.provider);
      const detail = (await hubRequest(`${ws.hubUrl}/api/jobs/${summary.job_id}`)).body;
      assert.equal(detail.provider, item.provider);
      assert.equal(detail.task, item.task);
    }
  } finally {
    await ws.cleanup();
  }
});

test("Hub rejects a follow-up on a NON-terminal job (409) and a new-task POST is 404", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("reject", fixtureSlowSuccess(3000));
  try {
    const id = await mcpSpawn(ws, "running job");
    // immediately attempt follow-up while running → not terminal
    const fu = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/follow-up`, {
      method: "POST",
      body: { message: "nope" }
    });
    assert.equal(fu.status, 409, "follow-up on a non-terminal job is rejected");
    assert.equal(fu.body.code, "job_not_terminal");

    // new-task POST must be 404 (no Hub task-creation path)
    const created = await hubRequest(`${ws.hubUrl}/api/jobs`, { method: "POST", body: { task: "should not be created" } });
    assert.equal(created.status, 404, "Hub has no task-creation path");
    assert.equal(created.body.error, "not_supported");

    // no duplicate / extra jobs were created by the Hub: total must equal what MCP made
    const list = (await hubRequest(`${ws.hubUrl}/api/jobs`)).body;
    assert.equal(list.total, 1, "the Hub created no jobs of its own");
    // This case intentionally asserts while the fixture is still running. Let
    // that owned worker reach its normal terminal before test teardown so the
    // Windows temp-root removal never races a still-live fixture process.
    await waitMcpTerminal(ws, id);
  } finally {
    await ws.cleanup();
  }
});

test("default Hub log response deeply redacts reasoning; opt-in exposes only CLI-emitted reasoning", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("reasoning", fixtureWithReasoning());
  try {
    const id = await mcpSpawn(ws, "reasoning privacy job");
    await waitMcpTerminal(ws, id);
    const detail = await hubRequest(`${ws.hubUrl}/api/jobs/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.usage.tokensIn, 10);
    assert.equal(detail.body.usage.tokensOut, 4);
    assert.equal(detail.body.usage.cacheRead, 3);
    assert.equal(detail.body.usage.cacheMiss, 7);
    assert.equal(detail.body.usage.toolCalls, 1);
    const logFile = path.join(ws.root, "logs", `${id}.ndjson`);
    fs.appendFileSync(
      logFile,
      `{"type":"broken","reasoning":"SECRET_MALFORMED_REASONING_MARKER"\n{"thinking":"SECRET_TRUNCATED_REASONING_MARKER`,
      "utf8"
    );
    const hidden = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?limit=1000`);
    assert.equal(hidden.status, 200);
    const hiddenText = JSON.stringify(hidden.body);
    assert.equal(hiddenText.includes("SECRET_REASONING_MARKER"), false, "root reasoning is absent from the complete default JSON response");
    assert.equal(hiddenText.includes("SECRET_THINKING_MARKER"), false, "nested thinking is absent from the complete default JSON response");
    assert.equal(hiddenText.includes("SECRET_MALFORMED_REASONING_MARKER"), false, "parse failures do not return raw bytes by default");
    assert.equal(hiddenText.includes("SECRET_TRUNCATED_REASONING_MARKER"), false, "incomplete tail bytes are not returned");
    assert.ok(hiddenText.includes("VISIBLE_CONTENT_MARKER"), "ordinary assistant content remains visible");
    assert.ok(hiddenText.includes("VISIBLE_RESULT_MARKER"), "ordinary CLI result content remains visible");

    const visible = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?limit=1000&include_reasoning=true`);
    assert.equal(visible.status, 200);
    const visibleText = JSON.stringify(visible.body);
    assert.ok(visibleText.includes("SECRET_REASONING_MARKER"), "explicit opt-in exposes real root reasoning");
    assert.ok(visibleText.includes("SECRET_THINKING_MARKER"), "explicit opt-in exposes real nested thinking");
    assert.equal(visibleText.includes("SECRET_MALFORMED_REASONING_MARKER"), false, "opt-in still never echoes unparseable raw bytes");
    assert.equal(visibleText.includes("SECRET_TRUNCATED_REASONING_MARKER"), false, "opt-in still never echoes an incomplete tail");
    assert.ok(visibleText.includes("SECRET_STREAM_REASONING_DELTA"), "explicit opt-in exposes real streaming thinking delta");
    assert.ok(visibleText.includes("SECRET_STREAM_REASONING_COMPLETE"), "explicit opt-in exposes real completed thinking block");

    const compactHidden = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?limit=1000&activity=1`);
    assert.equal(compactHidden.status, 200);
    const compactHiddenText = JSON.stringify(compactHidden.body);
    assert.equal(compactHiddenText.includes("SECRET_STREAM_REASONING_DELTA"), false, "compact hidden activity never leaks thinking delta");
    assert.equal(compactHiddenText.includes("SECRET_STREAM_REASONING_COMPLETE"), false, "compact hidden activity never leaks completed reasoning");
    assert.equal(compactHiddenText.includes('"thinking_delta"'), false, "compact activity removes token-level thinking noise");
    assert.equal(compactHiddenText.includes('"message_update"'), false, "compact activity removes snapshot message noise");
    assert.ok(compactHiddenText.includes("VISIBLE_TOOL_RESULT_MARKER"), "compact activity preserves meaningful tool completion events");
    assert.ok(compactHiddenText.includes("deepseek/deepseek-v4.1-flash"), "compact activity preserves model lifecycle events");

    const compactVisible = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?limit=1000&activity=1&include_reasoning=true`);
    assert.equal(compactVisible.status, 200);
    const compactVisibleText = JSON.stringify(compactVisible.body);
    assert.equal(compactVisibleText.includes("SECRET_STREAM_REASONING_DELTA"), false, "compact activity does not emit token-level reasoning deltas");
    assert.ok(compactVisibleText.includes("SECRET_STREAM_REASONING_COMPLETE"), "compact opt-in exposes the complete reasoning block");
    assert.ok(compactVisible.body.entries.some((entry: any) => entry.data?.event?.type === "thinking_end" && entry.reasoning?.includes("SECRET_STREAM_REASONING_COMPLETE")));
    assert.ok(visibleText.includes("VISIBLE_CONTENT_MARKER"));
  } finally {
    await ws.cleanup();
  }
});

test("Hub current-run log scope starts at the latest CrewDispatch generation and exposes its reasoning immediately", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("current-run-log", fixtureEcho());
  try {
    const id = await mcpSpawn(ws, "current-run scope job");
    await waitMcpTerminal(ws, id);
    await sleep(700);
    const followUp = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/follow-up`, {
      method: "POST",
      body: { message: "second run" }
    });
    assert.equal(followUp.status, 200);
    assert.equal(followUp.body?.generation, 1);
    await waitMcpTerminal(ws, id);

    const logFile = path.join(ws.root, "logs", `${id}.ndjson`);
    const run2Noise = Array.from({ length: 7000 }, (_, i) =>
      JSON.stringify({ type: "event", event: { type: "thinking_delta", delta: `noise-${i}-${"x".repeat(140)}` } })
    );
    fs.writeFileSync(
      logFile,
      [
        JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "run-1" } }),
        JSON.stringify({ type: "event", event: { type: "thinking_end", text: "FIRST_RUN_REASONING" } }),
        JSON.stringify({ type: "event", event: { type: "message_end", content: [{ type: "text", text: "FIRST_RUN_RESULT" }] } }),
        JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "run-2" } }),
        ...run2Noise,
        JSON.stringify({ type: "event", event: { type: "thinking_end", text: "SECOND_RUN_REASONING" } }),
        JSON.stringify({ type: "event", event: { type: "tool_completed", toolName: "read_file", result: [{ type: "text", text: "SECOND_RUN_TOOL" }] } }),
        JSON.stringify({ type: "event", event: { type: "message_end", content: [{ type: "text", text: "SECOND_RUN_RESULT" }] } })
      ].join("\n") + "\n",
      "utf8"
    );

    let cursor = "0";
    const currentEntries: any[] = [];
    for (let page = 0; page < 8; page += 1) {
      const current = await hubRequest(
        `${ws.hubUrl}/api/jobs/${id}/log?cursor=${encodeURIComponent(cursor)}&limit=200&activity=1&scope=current&include_reasoning=true`
      );
      assert.equal(current.status, 200);
      currentEntries.push(...current.body.entries);
      const previous = cursor;
      cursor = current.body.cursor;
      if (current.body.drained || cursor === previous) break;
      assert.equal(current.body.pending, false, "a bounded read-window boundary is pageable immediately when more bytes already exist");
    }
    const currentText = JSON.stringify(currentEntries);
    assert.equal(currentText.includes("FIRST_RUN_REASONING"), false);
    assert.equal(currentText.includes("FIRST_RUN_RESULT"), false);
    assert.ok(currentText.includes("SECOND_RUN_REASONING"));
    assert.ok(currentText.includes("SECOND_RUN_TOOL"));
    assert.ok(currentText.includes("SECOND_RUN_RESULT"));
    assert.equal(currentEntries[0]?.data?.event?.type, "run_start");
    assert.equal(currentEntries[0]?.data?.event?.sessionId, "run-2");

    const full = await hubRequest(
      `${ws.hubUrl}/api/jobs/${id}/log?cursor=0&limit=200&activity=1&include_reasoning=true`
    );
    const fullText = JSON.stringify(full.body);
    assert.ok(fullText.includes("FIRST_RUN_REASONING"), "unscoped history still begins with Run 1");
  } finally {
    await ws.cleanup();
  }
});

test("Hub log reads bounded byte batches, resumes append-only cursors, and safely skips oversized records", { timeout: 90000 }, async () => {
  const ws = await makeWorkspace("bounded-log", fixtureEcho());
  try {
    const id = await mcpSpawn(ws, "bounded incremental log job");
    await waitMcpTerminal(ws, id);
    const logFile = path.join(ws.root, "logs", `${id}.ndjson`);

    // Make the controlled product log several times larger than one HTTP read
    // budget, with stable sequence markers to prove no cursor gaps or repeats.
    const initialRows = 6000;
    const chunk: string[] = [];
    for (let seq = 0; seq < initialRows; seq += 1) {
      chunk.push(`${JSON.stringify({
        type: "bulk",
        seq,
        content: `BULK_CONTENT_${seq}_${"x".repeat(128)}`,
        ...(seq === 17 ? { nested: { reasoning: "SECRET_BULK_REASONING_MARKER" } } : {})
      })}\n`);
    }
    fs.appendFileSync(logFile, chunk.join(""), "utf8");
    assert.ok(fs.statSync(logFile).size > 3 * 256 * 1024, "controlled product log is substantially larger than one read batch");
    const incompleteTail = JSON.stringify({ type: "bulk", seq: initialRows, content: "APPEND_TAIL_CONTENT" });
    fs.appendFileSync(logFile, incompleteTail, "utf8");

    const seen: number[] = [];
    const allResponses: string[] = [];
    let cursor = "0";
    let pageCount = 0;
    let tailCursor: string | null = null;
    while (pageCount < 100) {
      const page = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?cursor=${encodeURIComponent(cursor)}&limit=1000`);
      assert.equal(page.status, 200);
      assert.ok(page.body.read_bytes <= 256 * 1024, `actual bytes read in page ${pageCount} stay capped`);
      assert.ok(page.body.entries.length <= page.body.limit);
      assert.equal(page.body.limit, 200, "oversized requested entry limit is clamped to the hard maximum");
      if (pageCount === 0) assert.equal(page.body.read_bytes, 256 * 1024, "first request reads exactly one bounded byte window");
      const json = JSON.stringify(page.body);
      assert.equal(json.includes("SECRET_BULK_REASONING_MARKER"), false, "default batches never expose nested reasoning");
      allResponses.push(json);
      for (const entry of page.body.entries) {
        if (entry.data?.type === "bulk" && Number.isInteger(entry.data.seq)) seen.push(entry.data.seq);
      }
      pageCount += 1;
      cursor = page.body.cursor;
      if (page.body.pending) {
        tailCursor = cursor;
        assert.equal(page.body.drained, false, "incomplete tail is pending, not drained");
        break;
      }
      assert.equal(page.body.cursor_error, undefined);
      if (page.body.drained) break;
    }
    assert.ok(tailCursor, "pagination reaches the incomplete append-only tail");
    assert.deepEqual(seen, Array.from({ length: initialRows }, (_, seq) => seq), "large log pages preserve order without gaps or duplicates");
    assert.equal(new Set(seen).size, initialRows);
    assert.ok(allResponses.join("").includes("BULK_CONTENT_17"), "ordinary content remains visible");
    assert.equal(allResponses.join("").includes("SECRET_BULK_REASONING_MARKER"), false);

    // Finish the held tail after the cursor was returned, then append ordinary
    // rows, a multi-batch oversized row, and a normal row after it.
    const oversizedSecret = "SECRET_OVERSIZED_REASONING_MARKER";
    const oversizedLine = `${JSON.stringify({ type: "bulk", seq: "oversized", content: oversizedSecret })}${"x".repeat(1024 * 1024)}`;
    fs.appendFileSync(logFile, `\n${JSON.stringify({ type: "bulk", seq: initialRows + 1, content: "AFTER_APPEND_1" })}\n`);
    fs.appendFileSync(logFile, `${JSON.stringify({ type: "bulk", seq: initialRows + 2, content: "AFTER_APPEND_2" })}\n`);
    fs.appendFileSync(logFile, `${oversizedLine}\n${JSON.stringify({ type: "bulk", seq: initialRows + 3, content: "AFTER_OVERSIZED_LINE" })}\n`);

    const continued: number[] = [];
    let oversizedErrors = 0;
    let sawDiscardCursor = false;
    cursor = tailCursor;
    for (let pageCount2 = 0; pageCount2 < 100; pageCount2 += 1) {
      const page = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?cursor=${encodeURIComponent(cursor)}&limit=1000`);
      assert.equal(page.status, 200);
      assert.ok(page.body.read_bytes <= 256 * 1024, "continued page stays within actual-read budget");
      assert.ok(page.body.entries.length <= page.body.limit && page.body.limit <= 200);
      const json = JSON.stringify(page.body);
      assert.equal(json.includes(oversizedSecret), false, "oversized bytes are never returned raw");
      assert.equal(json.includes("SECRET_BULK_REASONING_MARKER"), false);
      for (const entry of page.body.entries) {
        if (entry.error === "line_too_large") oversizedErrors += 1;
        if (entry.data?.type === "bulk" && Number.isInteger(entry.data.seq)) continued.push(entry.data.seq);
      }
      cursor = page.body.cursor;
      if (cursor.startsWith("d:")) sawDiscardCursor = true;
      if (page.body.drained) break;
    }
    assert.equal(oversizedErrors, 1, "an oversized line yields one safe diagnostic");
    assert.equal(sawDiscardCursor, true, "long-record skipping resumes through an opaque discard cursor");
    assert.deepEqual(continued, [initialRows, initialRows + 1, initialRows + 2, initialRows + 3]);

    const badCursor = await hubRequest(`${ws.hubUrl}/api/jobs/${id}/log?cursor=not-a-cursor`);
    assert.equal(badCursor.status, 200);
    assert.equal(badCursor.body.cursor, "0", "invalid cursor is safely reset to the beginning");
    assert.equal(badCursor.body.cursor_error, "invalid_cursor_reset_to_start");
    assert.ok(badCursor.body.read_bytes <= 256 * 1024);
  } finally {
    await ws.cleanup();
  }
});

test("message history gates accepted jobs and follow-ups, including worker-spawn failures and restart view", { timeout: 90000 }, async () => {
  const ws = await makeWorkspace("message-durability", fixtureEcho());
  try {
    // A side-car write failure rejects the start before a queued job record can
    // make that generation look accepted.
    const blockedRoot = path.join(ws.dir, "blocked-history-root");
    fs.mkdirSync(blockedRoot, { recursive: true });
    fs.writeFileSync(path.join(blockedRoot, "messages"), "not a directory", "utf8");
    assert.throws(
      () => startJob({
        root: blockedRoot,
        task: "must not be accepted without history",
        cwd: ws.project,
        runner: "fixture",
        fixturePath: ws.fixture,
        workerScript: HUB_ENTRY,
        env: ws.env
      }),
      (e: any) => e?.code === "message_history_write_failed"
    );
    assert.equal(listJobs(blockedRoot).jobs.length, 0, "history failure leaves no accepted job record");

    // A worker-launch failure remains an explicit terminal job with its original
    // message durably recorded, so the failed attempt can still be inspected.
    const spawnFailureRoot = path.join(ws.dir, "spawn-failure-root");
    assert.throws(
      () => startJob({
        root: spawnFailureRoot,
        task: "persist before failed worker launch",
        cwd: ws.project,
        runner: "fixture",
        fixturePath: ws.fixture,
        workerScript: path.join(ws.dir, "missing-worker.js"),
        env: ws.env
      }),
      (e: any) => e?.code === "worker_missing"
    );
    const spawnFailureJobs = listJobs(spawnFailureRoot).jobs;
    assert.equal(spawnFailureJobs.length, 1);
    assert.equal(spawnFailureJobs[0]!.status, "error");
    const spawnFailureHistory = loadUserMessagesInfo(spawnFailureRoot, spawnFailureJobs[0]!.id);
    assert.equal(spawnFailureHistory.complete, true);
    assert.equal(spawnFailureHistory.messages[0]!.text, "persist before failed worker launch");

    // The separately running MCP and Hub observe the same service path. A
    // follow-up whose worker cannot launch is an error generation with the
    // message retained and readable after the Hub process restarts.
    const id = await mcpSpawn(ws, "ORIGINAL_FOR_FAILED_FOLLOWUP");
    await waitMcpTerminal(ws, id);
    const failedFollowUp = await prepareContinuation({
      root: ws.root,
      jobId: id,
      task: "FOLLOWUP_PERSISTED_BEFORE_FAILED_LAUNCH",
      fixturePath: ws.fixture,
      workerScript: path.join(ws.dir, "missing-followup-worker.js"),
      env: ws.env
    });
    assert.equal(failedFollowUp.ok, false);
    if (!failedFollowUp.ok) assert.equal(failedFollowUp.code, "worker_missing");
    const failedRecord = listJobs(ws.root).jobs.find((job) => job.id === id);
    assert.ok(failedRecord);
    assert.equal(failedRecord.status, "error");
    assert.equal(failedRecord.generation, 1);
    assert.equal(failedRecord.task, "FOLLOWUP_PERSISTED_BEFORE_FAILED_LAUNCH");
    const history = loadUserMessagesInfo(ws.root, id);
    assert.equal(history.complete, true);
    assert.deepEqual(history.messages.map((message) => message.text), [
      "ORIGINAL_FOR_FAILED_FOLLOWUP",
      "FOLLOWUP_PERSISTED_BEFORE_FAILED_LAUNCH"
    ]);

    await restartHub(ws);
    const detail = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(detail.status, "error");
    assert.equal(detail.task, "ORIGINAL_FOR_FAILED_FOLLOWUP");
    assert.equal(detail.follow_ups[0].text, "FOLLOWUP_PERSISTED_BEFORE_FAILED_LAUNCH");
    assert.equal(detail.history_available, true);
  } finally {
    await ws.cleanup();
  }
});

test("settings saved via Hub persist across a Hub restart", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("settings", fixtureEcho());
  try {
    const putSettings = await hubRequest(`${ws.hubUrl}/api/settings`, {
      method: "PUT",
      body: { default_model: "cmd/kept-model" }
    });
    assert.equal(putSettings.status, 200, "settings PUT succeeds");
    assert.equal(putSettings.body.config.default_model, "cmd/kept-model");

    const putWorkBuddy = await hubRequest(`${ws.hubUrl}/api/providers/workbuddy-ai/settings`, {
      method: "PUT",
      body: {
        default_model: "hy4-preview-f",
        rate_limit_fallback_model: "hy3",
        permission_mode: "plan",
        default_effort: "max",
        rate_limit_fallback_effort: "low"
      }
    });
    assert.equal(putWorkBuddy.status, 200, "WorkBuddy AI settings PUT succeeds");
    assert.equal(putWorkBuddy.body.config.default_model, "hy4-preview-f");
    assert.equal(putWorkBuddy.body.config.rate_limit_fallback_model, "hy3");

    const rejectSchedule = await hubRequest(`${ws.hubUrl}/api/providers/workbuddy-ai/settings`, {
      method: "PUT",
      body: { time_slots: [] }
    });
    assert.equal(rejectSchedule.status, 400, "WorkBuddy AI rejects time-slot settings");
    assert.equal(rejectSchedule.body.error, "config_unknown_field");

    const putGlobal = await hubRequest(`${ws.hubUrl}/api/global-settings`, {
      method: "PUT",
      body: { jobs_page_size: 20, diag_retention_days: 10, diag_max_total_bytes: 1234567 }
    });
    assert.equal(putGlobal.status, 200, "global-settings PUT succeeds");
    assert.equal(putGlobal.body.jobs_page_size, 20);
    assert.equal(putGlobal.body.diag_retention_days, 10);
    assert.equal(putGlobal.body.diag_max_total_bytes, 1234567);

    // restart the Hub process
    await stopChild(ws.hub);
    const hub2 = spawn(process.execPath, [HUB_ENTRY], {
      env: { ...ws.env, HUB_PORT: String(ws.hubPort) },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    await waitForHub(hub2, 15000);
    try {
      const gotSettings = (await hubRequest(`${ws.hubUrl}/api/settings`)).body as {
        ok: boolean;
        config: { default_model: string };
        cli: { available: boolean };
        catalog: { reliable: boolean; models: string[]; refreshed_at: string | null };
        capabilities: { supports_effort: boolean };
        diagnostics: unknown[];
      };
      assert.equal(gotSettings.ok, true);
      assert.equal(gotSettings.config.default_model, "cmd/kept-model", "Command Code setting persisted across restart");
      const mcpSettings = McpStdioClient.json(await ws.mcp.callTool("jobquay_settings_get", {}));
      assert.deepEqual(gotSettings, mcpSettings, "Hub and MCP expose the same readSettings view for this data root");
      assert.equal(gotSettings.cli.available, false, "the isolated missing CLI is reported as unavailable");
      assert.equal(gotSettings.catalog.reliable, false, "an unavailable CLI cannot claim a reliable catalog");
      assert.deepEqual(gotSettings.catalog.models, []);
      assert.equal(gotSettings.catalog.refreshed_at, null);
      assert.equal(gotSettings.capabilities.supports_effort, false);
      assert.ok(Array.isArray(gotSettings.diagnostics));

      const gotWorkBuddy = (await hubRequest(`${ws.hubUrl}/api/providers/workbuddy-ai/settings`)).body as {
        ok: boolean;
        config: {
          default_model: string | null;
          rate_limit_fallback_model: string | null;
          permission_mode: string;
          default_effort: string | null;
          rate_limit_fallback_effort: string | null;
        };
        cli: { available: boolean };
        catalog: { reliable: boolean };
        features: { time_scheduling_active: boolean };
      };
      assert.equal(gotWorkBuddy.ok, true);
      assert.equal(gotWorkBuddy.config.default_model, "hy4-preview-f", "WorkBuddy AI default persisted across restart");
      assert.equal(gotWorkBuddy.config.rate_limit_fallback_model, "hy3");
      assert.equal(gotWorkBuddy.config.permission_mode, "plan");
      assert.equal(gotWorkBuddy.config.default_effort, "max");
      assert.equal(gotWorkBuddy.config.rate_limit_fallback_effort, "low");
      assert.equal(gotWorkBuddy.features.time_scheduling_active, false, "WorkBuddy AI has no clock-based switching feature");
      assert.equal(typeof gotWorkBuddy.cli.available, "boolean", "WorkBuddy AI CLI availability is reported");
      assert.equal(typeof gotWorkBuddy.catalog.reliable, "boolean", "WorkBuddy AI catalog reliability is reported");
      const gotGlobal = (await hubRequest(`${ws.hubUrl}/api/global-settings`)).body;
      assert.equal(gotGlobal.jobs_page_size, 20, "page size persisted");
      assert.equal(gotGlobal.diag_retention_days, 10, "retention days persisted");
      assert.equal(gotGlobal.diag_max_total_bytes, 1234567, "max bytes persisted");
    } finally {
      await stopChild(hub2);
    }
  } finally {
    await ws.cleanup();
  }
});

test("diagnostics cleanup clears ONLY terminal job groups, never active jobs or metadata", { timeout: 90000 }, async () => {
  const ws = await makeWorkspace("retention", fixtureEcho());
  try {
    // Tiny total-byte cap so the cleanup has something to enforce.
    const putGlobal = await hubRequest(`${ws.hubUrl}/api/global-settings`, {
      method: "PUT",
      body: { diag_retention_days: 0, diag_max_total_bytes: 1 }
    });
    assert.equal(putGlobal.status, 200);

    // Terminal job
    const terminalId = await mcpSpawn(ws, "terminal job for cleanup");
    await waitMcpTerminal(ws, terminalId);
    await sleep(300); // let the worker flush its log
    const termNdr = path.join(ws.root, "logs", `${terminalId}.ndjson`);
    const termWorker = path.join(ws.root, "logs", `${terminalId}.worker.log`);
    const termMeta = path.join(ws.root, "jobs", `${terminalId}.json`);
    assert.ok(fs.existsSync(termNdr), "terminal job log exists before cleanup");
    assert.ok(fs.existsSync(termWorker), "terminal job worker log exists before cleanup");
    assert.ok(fs.existsSync(termMeta), "terminal job metadata exists before cleanup");

    // Make the second fixture deterministically long-running. The original fast
    // echo could already become terminal within the old fixed 500ms wait on a
    // fast POSIX host, turning this retention test into a timing race.
    fs.writeFileSync(ws.fixture, fixtureSlowSuccess(30_000).join("\n"), "utf8");

    // Active (running) job — do NOT wait for it to finish. Wait for the
    // diagnostic group itself instead of assuming every hosted architecture
    // creates worker logs within a fixed 500ms startup window.
    const activeId = await mcpSpawn(ws, "active job kept");
    await waitMcpActiveDiagnostics(ws, activeId);
    const actNdr = path.join(ws.root, "logs", `${activeId}.ndjson`);
    const actWorker = path.join(ws.root, "logs", `${activeId}.worker.log`);
    const actMeta = path.join(ws.root, "jobs", `${activeId}.json`);

    // Run the cleanup
    const cleanup = await hubRequest(`${ws.hubUrl}/api/diagnostics/cleanup`, { method: "POST" });
    assert.equal(cleanup.status, 200, "cleanup endpoint succeeds");
    assert.equal(cleanup.body.removedGroups, 1, "exactly one terminal group removed");
    assert.equal(cleanup.body.keptActive, 1, "the active group was protected");
    assert.ok(cleanup.body.removedBytes > 0, "bytes were reclaimed");

    // Terminal group's diagnostic files are GONE; its METADATA remains.
    assert.equal(fs.existsSync(termNdr), false, "terminal ndjson log cleared");
    assert.equal(fs.existsSync(termWorker), false, "terminal worker log cleared");
    assert.ok(fs.existsSync(termMeta), "terminal job METADATA must NOT be cleared");

    // Active job's logs and metadata remain untouched.
    assert.ok(fs.existsSync(actNdr), "active job ndjson log kept");
    assert.ok(fs.existsSync(actWorker), "active job worker log kept");
    assert.ok(fs.existsSync(actMeta), "active job metadata kept");

    // Audit persisted with cumulative counts
    const audit = (await hubRequest(`${ws.hubUrl}/api/diagnostics/audit`)).body;
    assert.equal(audit.audit.totals.removedGroups, 1);
    assert.ok(audit.audit.totals.removedBytes > 0);

    // Stop the still-running active fixture, then wait for its durable terminal
    // state before teardown. This test is about retention semantics, not whether
    // a loaded hosted runner can finish provider/worker teardown inside the Hub's
    // short cancel response budget.
    const cancel = await hubRequest(`${ws.hubUrl}/api/jobs/${activeId}/cancel`, { method: "POST", body: { wait_seconds: 6 } });
    assert.equal(cancel.status, 200, "cleanup fixture cancellation is accepted");
    await waitMcpTerminal(ws, activeId, 35_000);
  } finally {
    await ws.cleanup();
  }
});

test("retention reports partial unlink failures, retries leftovers, and coordinates with follow-up", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("retention-retry", fixtureEcho());
  try {
    const id = await mcpSpawn(ws, "retention retry terminal job");
    await waitMcpTerminal(ws, id);
    const diagnosticPaths = [
      path.join(ws.root, "logs", `${id}.ndjson`),
      path.join(ws.root, "logs", `${id}.worker.log`)
    ];
    const beforeSizes = new Map(diagnosticPaths.map((file) => [file, fs.statSync(file).size]));
    let failedOnce = false;
    let continuationAttempt: ReturnType<typeof prepareContinuation> | null = null;
    const first = enforceRetention(ws.root, {
      policy: { maxAgeMs: 0, maxBytes: 1 },
      beforeUnlink: (jobId) => {
        if (!continuationAttempt) {
          continuationAttempt = prepareContinuation({
            root: ws.root,
            jobId,
            task: "must not become active during retention",
            fixturePath: ws.fixture,
            workerScript: HUB_ENTRY,
            env: ws.env
          });
        }
      },
      unlinkFile: (file) => {
        if (!failedOnce) {
          failedOnce = true;
          const e = Object.assign(new Error("controlled unlink denial"), { code: "EACCES" });
          throw e;
        }
        fs.unlinkSync(file);
      }
    });
    assert.equal(first.removedFiles, 1);
    assert.equal(first.removedGroups, 0, "a partially deleted diagnostic group is not reported as complete");
    assert.equal(first.failedFiles, 1);
    assert.equal(first.partialGroups, 1);
    assert.equal(first.removedBytes, [...beforeSizes].filter(([file]) => !fs.existsSync(file)).reduce((sum, [file, size]) => sum + size, 0));
    assert.equal(diagnosticPaths.filter((file) => fs.existsSync(file)).length, 1, "one failed exact file remains retryable");

    assert.ok(continuationAttempt, "the interleaving callback attempted a terminal-to-running transition");
    const blocked = await (continuationAttempt as ReturnType<typeof prepareContinuation>);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.code, "job_transition_busy");
    const stillTerminal = (await hubRequest(`${ws.hubUrl}/api/jobs/${id}`)).body;
    assert.equal(stillTerminal.status, "done", "retention and follow-up coordination kept the job terminal");
    assert.equal(stillTerminal.generation, 0);

    const remainingSize = diagnosticPaths.filter((file) => fs.existsSync(file)).reduce((sum, file) => sum + fs.statSync(file).size, 0);
    const retry = enforceRetention(ws.root, { policy: { maxAgeMs: 0, maxBytes: 1 } });
    assert.equal(retry.removedFiles, 1);
    assert.equal(retry.removedGroups, 1, "the retry removes the remaining diagnostic file");
    assert.equal(retry.removedBytes, remainingSize);
    assert.equal(diagnosticPaths.some((file) => fs.existsSync(file)), false);
    const audit = (await hubRequest(`${ws.hubUrl}/api/diagnostics/audit`)).body.audit;
    assert.equal(audit.totals.failedFiles, 1);
    assert.equal(audit.totals.partialGroups, 1);
    assert.equal(audit.totals.removedFiles, 2);
    assert.ok(audit.runs.some((run: any) => run.errors.some((error: any) => error.code === "EACCES")));
  } finally {
    await ws.cleanup();
  }
});

test("cross-origin write requests are rejected (403)", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("cors", fixtureEcho());
  try {
    const evil = "http://evil.example.com";
    const cancelX = await hubRequest(`${ws.hubUrl}/api/jobs/nope/cancel`, { method: "POST", origin: evil });
    assert.equal(cancelX.status, 403, "cross-origin cancel write is rejected");
    assert.equal(cancelX.body.error, "cross_origin_rejected");

    const followX = await hubRequest(`${ws.hubUrl}/api/jobs/nope/follow-up`, { method: "POST", body: { message: "x" }, origin: evil });
    assert.equal(followX.status, 403, "cross-origin follow-up write is rejected");

    const settingsX = await hubRequest(`${ws.hubUrl}/api/settings`, { method: "PUT", body: { default_model: "x" }, origin: evil });
    assert.equal(settingsX.status, 403, "cross-origin settings write is rejected");

    const globalX = await hubRequest(`${ws.hubUrl}/api/global-settings`, { method: "PUT", body: { jobs_page_size: 20 }, origin: evil });
    assert.equal(globalX.status, 403, "cross-origin global-settings write is rejected");

    const cleanupX = await hubRequest(`${ws.hubUrl}/api/diagnostics/cleanup`, { method: "POST", origin: evil });
    assert.equal(cleanupX.status, 403, "cross-origin cleanup write is rejected");

    // Reproduce the forged Host+Origin pair that used to compare equal. It
    // targets a real write and must leave persistent settings unchanged.
    const beforeSpoof = (await hubRequest(`${ws.hubUrl}/api/global-settings`)).body;
    const forgedOrigin = `http://evil.example:${ws.hubPort}`;
    const spoofed = await hubRequest(`${ws.hubUrl}/api/global-settings`, {
      method: "PUT",
      body: { jobs_page_size: 20 },
      origin: forgedOrigin,
      host: `evil.example:${ws.hubPort}`
    });
    assert.equal(spoofed.status, 403, "matching attacker-controlled Host and Origin are rejected");
    assert.equal(spoofed.body.error, "host_rejected", "the all-route Host guard rejects the forged authority before the write-origin guard");
    assert.equal(spoofed.headers["access-control-allow-origin"], undefined, "the Hub does not enable permissive CORS");
    const afterSpoof = (await hubRequest(`${ws.hubUrl}/api/global-settings`)).body;
    assert.equal(afterSpoof.jobs_page_size, beforeSpoof.jobs_page_size, "the rejected write has zero persistent side effect");

    const reboundRead = await hubRequest(`${ws.hubUrl}/api/jobs`, { host: `evil.example:${ws.hubPort}` });
    assert.equal(reboundRead.status, 403, "a DNS-rebound Host cannot read local jobs without an Origin header");
    assert.equal(reboundRead.body.error, "host_rejected");
    const reboundPage = await hubRequest(`${ws.hubUrl}/ui`, { host: `evil.example:${ws.hubPort}` });
    assert.equal(reboundPage.status, 403, "a DNS-rebound Host cannot read the UI entry either");

    // Local UI origins remain usable under both supported loopback spellings.
    const local127 = await hubRequest(`${ws.hubUrl}/api/global-settings`, {
      method: "PUT",
      body: { jobs_page_size: 20 },
      origin: `http://127.0.0.1:${ws.hubPort}`
    });
    assert.equal(local127.status, 200, "127.0.0.1 UI origin is accepted");
    const localHost = await hubRequest(`${ws.hubUrl}/api/global-settings`, {
      method: "PUT",
      body: { jobs_page_size: 50 },
      origin: `http://localhost:${ws.hubPort}`
    });
    assert.equal(localHost.status, 200, "localhost UI origin is accepted");

    // same-origin (no Origin header) is allowed for a no-op-ish write
    const sameOrigin = await hubRequest(`${ws.hubUrl}/api/diagnostics/cleanup`, { method: "POST" });
    assert.equal(sameOrigin.status, 200, "same-origin cleanup write is allowed");
  } finally {
    await ws.cleanup();
  }
});

test("built Hub serves its browser UI with a strict script boundary and no task creation action", { timeout: 60000 }, async () => {
  const ws = await makeWorkspace("ui-static", fixtureEcho());
  try {
    const page = await fetch(`${ws.hubUrl}/ui`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(html, /id="navSettings"/);
    assert.doesNotMatch(html, /id="slots"/);
    assert.doesNotMatch(html, /id="addSlot"/);
    assert.doesNotMatch(html, /id="inFlightSwitch"/);
    assert.doesNotMatch(html, /Model schedule/);
    assert.match(html, /id="followupText"/);
    assert.match(html, /id="consoleView" class="console-view"/);
    assert.match(html, /\.app\s*\{[^}]*grid-template-rows:minmax\(0,1fr\);[^}]*overflow:hidden;/);
    assert.match(html, /\.main\s*\{[^}]*min-height:0;[^}]*overflow:hidden;/);
    assert.match(html, /\.console-view\s*\{[^}]*flex:1 1 auto;[^}]*min-height:0;[^}]*overflow:hidden;/);
    assert.match(html, /\.composer\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto;[^}]*grid-template-areas:"input send" "tip tip";/);
    assert.match(html, /\.composer textarea\s*\{[^}]*grid-area:input;[^}]*width:100%;/);
    assert.match(html, /\.composer > button\s*\{[^}]*grid-area:send;[^}]*align-self:end;/);
    // T5: the sidebar's unread marker is a small dot plus a BOLD title; a
    // read/seen title keeps the normal weight, with screen-reader-only text
    // (no verbose visible label).
    assert.match(html, /\.job-title\s*\{[^}]*font-weight:400;/);
    assert.match(html, /\.job\.unread \.job-title\s*\{[^}]*font-weight:700;/);
    assert.match(html, /\.job-unread-dot\s*\{[^}]*border-radius:50%;[^}]*background:var\(--blue\);/);
    assert.match(html, /\.sr-only\s*\{[^}]*position:absolute;[^}]*clip:rect\(0 0 0 0\);/);
    assert.match(html, /Ctrl\/Cmd\+Enter to send · Enter for a new line/);
    assert.match(html, /id="jobProvider"/);
    assert.match(html, /id="settingsProvider"/);
    assert.match(html, /<option value="command-code">Command Code<\/option>/);
    assert.match(html, /<option value="workbuddy-ai">WorkBuddy AI<\/option>/);
    assert.match(html, /id="commandCodeSettingsCard" class="settings-card"/);
    assert.match(html, /id="workBuddySettingsCard" class="settings-card hidden"/);
    // Permission stays a normal visible setting (never moved into an "Advanced"
    // section). Label, dropdown and the inline explanation share ONE full-width
    // row; the note is plain text (never a warning card) and the dropdown is
    // explicitly associated with both its label and its note.
    assert.match(html, /<div class="permission-row">/);
    assert.match(html, /<label for="permissionMode">Permission<\/label>/);
    assert.match(html, /<select id="permissionMode" aria-describedby="yoloWarning"><\/select>/);
    assert.match(html, /<div id="yoloWarning" class="permission-note hidden"><\/div>/);
    assert.match(html, /<label for="wbPermissionMode">Permission<\/label>/);
    assert.match(html, /<select id="wbPermissionMode" aria-describedby="wbYoloWarning"><\/select>/);
    assert.match(html, /<div id="wbYoloWarning" class="permission-note hidden"><\/div>/);
    assert.doesNotMatch(html, /id="yoloWarning" class="settings-warning/);
    assert.doesNotMatch(html, /id="wbYoloWarning" class="settings-warning/);
    assert.doesNotMatch(html, /Advanced/);
    assert.doesNotMatch(html, /CLI path \(optional\)/);
    assert.doesNotMatch(html, /These settings apply to Command Code only/);
    assert.doesNotMatch(html, /Uses the isolated/);
    assert.match(html, /id="cliInfo" class="settings-status hidden" role="status" aria-live="polite"/);
    assert.match(html, /id="wbCliInfo" class="settings-status hidden" role="status" aria-live="polite"/);
    assert.match(html, /<h2>Sessions & logs<\/h2><p class="settings-subtitle">Global settings shared by all providers\.<\/p>/);
    assert.match(html, /\.settings-status\.loading > div:first-child::before/);
    // WorkBuddy AI's waiting line is plain `loading...` at normal weight: the
    // narrow modifier keeps the shared 650 weight for non-loading status copy.
    assert.match(html, /\.settings-status\.loading\.wb-loading > div:first-child \{ font-weight:400; \}/);
    assert.match(html, /id="catalogInfo" class="settings-status hidden"/);
    assert.match(html, /id="effectiveInfo" class="settings-status hidden"/);
    assert.match(html, /id="wbCatalogInfo" class="settings-status hidden"/);
    assert.match(html, /id="wbEffectiveInfo" class="settings-status hidden"/);
    assert.match(html, /\.settings-status\s*\{[^}]*border-top:1px solid var\(--line\);[^}]*font-size:12px;/);
    assert.match(html, /<small>Local development sessions<\/small>/);
    // Release-pass UI copy: the product-owned shell is English — any CJK in the
    // served HTML would be an untranslated, user-visible string.
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/);
    // No task-creation control exists anywhere in the shell. The page only says
    // that new tasks are dispatched through the CrewDispatch MCP; no button/link/form may
    // offer creating or starting a task.
    assert.doesNotMatch(html, /id="newTask"/);
    assert.match(html, /New tasks are dispatched through the CrewDispatch MCP/);
    assert.match(html, /Cascadia Mono/);
    assert.match(html, /id="jobEffort"/);
    assert.match(html, /id="jobFallback"/);
    const interactive = [...html.matchAll(/<(button|a|form)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    assert.ok(interactive.length >= 5, "the UI shell keeps its real controls");
    for (const control of interactive) {
      assert.doesNotMatch(control, /\b(?:new|create)\s+task\b/i, "no task-creation control in the UI shell");
    }

    const client = await fetch(`${ws.hubUrl}/ui/client.js`);
    const script = await client.text();
    assert.equal(client.status, 200);
    assert.match(client.headers.get("content-type") ?? "", /javascript/);
    assert.ok(script.length > 1000, "the built browser client is served, not a placeholder");
    assert.match(script, /async function refreshJobsList\(\)/);
    assert.match(script, /\/api\/jobs\?offset=0&limit=\$\{limit\}/);
    assert.match(script, /void refreshJobsList\(\);/);
    assert.match(script, /setInterval\([\s\S]*2500\)/);
    // The Permission note is contextual per provider and mode: each visible mode
    // explains its own behavior, with provider-specific WorkBuddy distinctions.
    assert.match(script, /function renderPermissionNote\(element, provider, mode\)/);
    assert.match(script, /provider === "workbuddy-ai"/);
    assert.match(script, /renderPermissionNote\(ui\.yoloWarning, "command-code", draft\.permission_mode\)/);
    assert.match(script, /renderPermissionNote\(ui\.wbYoloWarning, "workbuddy-ai", draft\.permission_mode\)/);
    assert.match(script, /renderPermissionNote\(ui\.yoloWarning, "command-code", settingsState\.draft\.permission_mode\)/);
    assert.match(script, /renderPermissionNote\(ui\.wbYoloWarning, "workbuddy-ai", workBuddySettingsState\.draft\.permission_mode\)/);
    assert.match(script, /May request permission to edit files or run commands/);
    assert.match(script, /Suggests changes without editing project files/);
    assert.match(script, /Auto-approves normal edits; commands may need approval/);
    assert.match(script, /Skips routine approvals; explicit rules and safety checks still apply/);
    assert.match(script, /Runs most actions automatically; risky commands may need approval/);
    assert.match(script, /Skips permission checks; repeated actions may still pause the task/);
    assert.match(script, /Provider rules apply; approvals may pause the task/);
    assert.doesNotMatch(script, /Non-yolo modes can pause unattended tasks/);
    assert.doesNotMatch(script, /yolo skips confirmation prompts/);
    assert.match(script, /cliInfo\.classList\.toggle\("hidden"/);
    assert.match(script, /catalogInfo\.classList\.toggle\("hidden"/);
    assert.match(script, /effectiveInfo\.classList\.add\("hidden"/);
    assert.match(script, /wbCatalogInfo\.classList\.toggle\("hidden"/);
    assert.match(script, /wbEffectiveInfo\.classList\.add\("hidden"/);
    assert.match(script, /assistant_messages/);
    assert.match(script, /assistantByGeneration/);
    assert.match(script, /event\.isComposing/);
    assert.match(script, /ui\.composer\.requestSubmit\(\)/);
    // The provider loading state is ONE shared rendering with the exact
    // user-facing copy. It covers only the process-free catalog phase, which
    // answers in milliseconds, so NO provider may claim a seconds-long bound
    // here. No cached/stale/updating state exists any more.
    assert.match(script, /function renderProviderLoadingState\(/);
    assert.match(script, /"Loading Command Code…"/);
    assert.match(script, /"loading\.\.\."/);
    assert.match(script, /classList\.toggle\("wb-loading", provider === "workbuddy-ai"\)/);
    assert.doesNotMatch(script, /may take 5[–-]20 seconds/, "the loading state no longer covers the slow CLI phase, so it must not claim a 5–20s bound");
    assert.doesNotMatch(script, /Loading models and settings…/);
    assert.doesNotMatch(script, /Loading Command Code settings…/);
    assert.doesNotMatch(script, /"Loading WorkBuddy AI…"/);
    assert.doesNotMatch(script, /Loading WorkBuddy AI settings…/);
    assert.doesNotMatch(script, /Checking local CLI…/);
    assert.doesNotMatch(script, /Checking WorkBuddy AI…/);
    assert.doesNotMatch(script, /"Updating…"/);
    assert.match(script, /classList\.add\("loading"\)/);
    // ONE provider-neutral fresh loader for both providers: a fresh `?fresh=1`
    // read before the form is rendered, with billing metadata gated on
    // billing_verified. No cache-first/revalidate request may exist.
    assert.match(script, /function loadProviderSettingsFresh\(/);
    assert.match(script, /\?fresh=1/);
    assert.doesNotMatch(script, /\?cache=1/);
    assert.doesNotMatch(script, /\?revalidate=1/);
    assert.match(script, /function commandCodeBillingVerified\(/);
    assert.match(script, /function workBuddyBillingVerified\(/);
    assert.match(script, /billing_verified/);
    assert.match(script, /Free now/);
    // ONE shared provider-neutral free-first ordering helper drives BOTH model
    // dropdowns: it is defined exactly once and called by the two renderers, so
    // the two providers cannot drift into independent sorting implementations.
    assert.match(script, /function stableFreeFirstOrder\(/);
    assert.equal(
      (script.match(/stableFreeFirstOrder\(/g) ?? []).length,
      3,
      "exactly one shared free-first ordering helper definition plus its two dropdown call sites"
    );
    assert.match(script, /stableFreeFirstOrder\(settingsModelChoices\(\), view\?\.model_meta, billingVerified\)/);
    assert.match(script, /stableFreeFirstOrder\(offered, view\?\.model_meta, billingVerified\)/);
    // T5: ONE generation-aware terminal-revision identity and ONE unread
    // predicate drive the sidebar; read state is a bounded, versioned
    // localStorage store with an in-memory fallback (never a backend field).
    assert.match(script, /const READ_STATE_STORAGE_KEY = "jobquay\.read-state";/);
    assert.match(script, /const READ_STATE_VERSION = 1;/);
    assert.match(script, /const READ_STATE_MAX_ENTRIES = 5000;/);
    assert.match(script, /function terminalRevision\(/);
    assert.match(script, /return `\$\{job\.generation\}\|\$\{job\.status\}\|\$\{job\.finished_at \?\? ""\}`;/);
    assert.match(script, /function isUnreadRevision\(/);
    assert.match(script, /function isUnreadJob\(/);
    assert.match(script, /function noteJobsForReadState\(/);
    assert.match(script, /function markRevisionRead\(/);
    assert.match(script, /window\.localStorage\.getItem\(READ_STATE_STORAGE_KEY\)/);
    assert.match(script, /window\.localStorage\.setItem\(READ_STATE_STORAGE_KEY/);
    assert.match(script, /readStateStorageBroken = true;/);
    assert.equal(
      (script.match(/isUnreadJob\(/g) ?? []).length,
      2,
      "exactly one shared unread predicate definition plus its single sidebar call site"
    );
    assert.equal(
      (script.match(/isUnreadRevision\(/g) ?? []).length,
      2,
      "exactly one read/unread decision helper plus the unread predicate that uses it"
    );
    assert.equal(
      (script.match(/noteJobsForReadState\(/g) ?? []).length,
      3,
      "exactly one read-state fold helper plus its two list call sites"
    );
    assert.match(script, /markRevisionRead\(detail\.job_id, revision\)/);
    assert.match(script, /Unread result/);
    assert.match(script, /Unspecified \(Provider default\)/);
    assert.doesNotMatch(script, /Unspecified \(CLI default\)/);
    assert.match(script, /promotion_next_boundary_at/);
    assert.match(script, /scheduleWorkBuddyPromotionRefresh/);
    assert.match(script, /visibilitychange/);
    assert.match(script, /pageshow/);
    assert.match(script, /Cache \$\{/);
    assert.match(script, /Decode \$\{/);
    assert.match(script, /formatFallback/);
    assert.match(script, /renderSelectedProviderSettings/);
    assert.match(script, /settingsProvider\.addEventListener\("change"/);
    assert.doesNotMatch(script, /ui\.addSlot|ui\.inFlightSwitch|function renderSlots/);
    assert.match(script, /view\.offered_models\.length \? view\.offered_models : view\.catalog\.models/);
    assert.doesNotMatch(script, /\/api\/jobs\/create|\/api\/jobs\/new/);
  } finally {
    await ws.cleanup();
  }
});

test("startHub rejects non-loopback hosts and binds only the IPv4 loopback address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-hub-bind-"));
  try {
    assert.throws(() => startHub({ root: path.join(dir, "bad"), host: "0.0.0.0", port: 0 }), /loopback/);
    const handle = startHub({ root: path.join(dir, "good"), host: "localhost", port: 0 });
    await new Promise<void>((resolve, reject) => {
      handle.server.once("listening", resolve);
      handle.server.once("error", reject);
    });
    const address = handle.server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(address.address, "127.0.0.1");
    assert.equal(handle.port, address.port);
    await new Promise<void>((resolve, reject) => handle.server.close((e) => e ? reject(e) : resolve()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
