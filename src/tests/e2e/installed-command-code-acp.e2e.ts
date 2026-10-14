// installed-command-code-acp.e2e.ts — EXPLICIT, opt-in acceptance of the NEW
// Command Code ACP production entry against the REAL installed official CLI.
//
// Run with:  npm.cmd run test:e2e:command-code:acp
//
// DELIBERATELY EXCLUDED from `npm test`: it spends real (free-tier) model
// entitlement through the operator's authorized official login and it answers
// interactive permission requests. It runs only when asked for by name.
//
// What this closes that the recorded-shape fixture integration cannot:
//   * the REAL `cmdc acp` server performs the configure-before-prompt sequence
//     (session/new -> set model -> set mode -> prompt) for a standard-mode job;
//   * the REAL CLI raises its own `session/request_permission` for a file edit,
//     the job record exposes it while the file is still UNCHANGED, the real Hub
//     approval route claims exactly the provider's own `allow_once` option, and
//     the SAME session then performs ONLY the intended edit and completes;
//   * a follow-up generation resumes that SAME real session (the second task
//     can only be answered from the resumed conversation);
//   * real usage counters, the model-default null effort and the absence of a
//     synthesized Decode are read from the durable record.
//
// Safety rules (enforced in code, not just prose):
//   * it answers ONLY its own approval. The pure guard
//     (`src/tests/helpers/cc-acp-approval-guard.ts`) sends a decision ONLY when
//     the pending request matches THIS job + generation + provider + request id,
//     is an `edit` whose explicit path resolves to EXACTLY this run's probe file
//     under this run's project directory, and offers the provider's own
//     allow_once option. A missing path, a title-only filename mention, a
//     shell/execute action, any other (inside- or outside-tree) file, a
//     conflicting cwd or a missing native option fails the test WITHOUT an
//     answer;
//   * it stops THIS run's isolated daemon through the existing API and confirms
//     its PID exited before deleting the tree — never the production root;
//   * every path it deletes is its own `jobquay-installed-cc-acp-` temp tree;
//   * it never signals a process: a non-terminal job is stopped through the
//     product's own `jobquay_cancel`, and captured PIDs are only waited on;
//   * the operator's CLI profile is NOT read, copied or modified. The official
//     CLI may persist its own session turn under its real profile as part of
//     this authorized run, exactly like production; that is reported, not
//     cleaned;
//   * no Codex wake is possible: CODEX_THREAD_ID is removed and the only
//     notification target is this run's loopback callback.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { probeCapabilities, readModelCatalog } from "../../providers/command-code/probe";
import type { ModelCatalogResult } from "../../providers/provider";
import { isValidSessionIdFor } from "../../jobs/runner";
import { approvalDecisionPath, approvalRequestPath } from "../../jobs/approval";
import { startHub, type HubHandle } from "../../hub/server";
import { isPidAlive } from "../../runtime/process";
import { daemonPaths, shutdownJobDaemon } from "../../daemon/client";
import { McpStdioClient } from "../helpers/mcp-client";
import { approvalIsThisRunsProbe, type CcAcpApprovalExpectation } from "../helpers/cc-acp-approval-guard";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ACCEPT_CLI_PATH = process.env.JOBQUAY_ACCEPT_COMMAND_CODE_CLI_PATH?.trim();
if (ACCEPT_CLI_PATH && !path.isAbsolute(ACCEPT_CLI_PATH)) {
  throw new Error("JOBQUAY_ACCEPT_COMMAND_CODE_CLI_PATH must be an absolute official CLI path");
}
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const MCP_ENTRY = path.join(REPO_ROOT, "dist", "mcp", "server.js");

/** The one model this acceptance may use: the CLI's public FREE stealth id. */
const MODEL = "stealth/space-bunny-alpha";
const PROBE_FILE = "jobquay-acp-approval-probe.txt";
const PROBE_TEXT = "JOBQUAY-ACP-APPROVAL-OK\n";
const MARKER = "JOBQUAY-ACP-GEN0";
/** The provider operation kind this run expects for its ONE allowed probe edit. */
const EXPECTED_TOOL_KIND = "edit";
/** The provider's own native allow option id this run may send. */
const ALLOW_OPTION_ID = "allow_once";
const TASK0 =
  `Create ${PROBE_FILE} in the current workspace with exactly the text JOBQUAY-ACP-APPROVAL-OK followed by one newline. ` +
  "Use a file-writing/editing tool, not shell, PowerShell, Python, Node, or another command runner. " +
  `After the file is written successfully, reply with exactly the single word ${MARKER} and nothing else.`;
// The follow-up never contains the marker: only a session that really resumed
// from generation 0 can answer which word was requested there.
const TASK1 =
  "What was the exact single word I asked you to reply with at the start of this session? Reply with just that word and nothing else.";
/** Every path this test is allowed to delete starts with this temp prefix. */
const OWNED_TEMP_PREFIX = "jobquay-installed-cc-acp-";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function readRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

function isOwnedTempTree(root: string): boolean {
  const tmp = path.resolve(os.tmpdir());
  const target = path.resolve(root);
  const rel = path.relative(tmp, target);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside && path.basename(target).startsWith(OWNED_TEMP_PREFIX);
}

async function removeOwnedTree(root: string): Promise<{ removed: boolean; lastError: string | null }> {
  if (!isOwnedTempTree(root)) {
    throw new Error(`refusing to remove a path that is not this run's temp tree: ${root}`);
  }
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      lastError = errorMessage(e);
    }
    if (!fs.existsSync(root)) return { removed: true, lastError: null };
    await sleep(200);
  }
  return { removed: false, lastError: lastError ?? "the tree still existed after every retry" };
}

/**
 * Stop THIS run's own isolated daemon through the existing API and confirm its
 * recorded PID is gone. It reads the daemon record under THIS data root only
 * (`<root>/daemon/daemon.json`), so the production root and any unrelated daemon
 * are never touched. A daemon that already removed its own record is confirmed.
 */
async function stopOwnedDaemon(
  root: string,
  env: NodeJS.ProcessEnv
): Promise<{ confirmed: boolean; pid: number | null; reason: string | null }> {
  await shutdownJobDaemon(root, env);
  let pid: number | null = null;
  try {
    const meta = JSON.parse(fs.readFileSync(daemonPaths(root, env).meta, "utf8")) as { pid?: unknown };
    if (Number.isInteger(meta.pid) && (meta.pid as number) > 0) pid = meta.pid as number;
  } catch {
    // The daemon removed its own record on exit: nothing is left to confirm.
    pid = null;
  }
  if (pid == null) return { confirmed: true, pid: null, reason: null };
  const deadline = Date.now() + 15000;
  while (isPidAlive(pid) === true && Date.now() < deadline) await sleep(150);
  if (isPidAlive(pid) === true) return { confirmed: false, pid, reason: `daemon pid ${pid} was still alive after shutdown` };
  return { confirmed: true, pid, reason: null };
}

// ---------------------------------------------------------------------------
// FREE-model evidence (same strict price/tag-column rule as the print acceptance)
// ---------------------------------------------------------------------------

function parseModelRow(raw: string, model: string): { line: string; priceTag: string } | null {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const m = /^(\S+)\s{2,}(\S+)(?:\s+(.*))?$/.exec(t);
    if (!m || m[1] !== model) continue;
    return { line: t, priceTag: m[2]! };
  }
  return null;
}

function assertFreeModelEvidence(catalog: ModelCatalogResult, where: string): string {
  assert.equal(catalog.ok, true, `${where}: public catalog probe failed (${catalog.error ?? "unknown"})`);
  assert.equal(catalog.source, "cli-list-models", `${where}: catalog source was ${catalog.source}`);
  assert.ok(catalog.raw, `${where}: cmdc --list-models produced no raw output to check`);
  assert.ok(catalog.models.includes(MODEL), `${where}: the official catalog does not publish ${MODEL}`);
  const row = parseModelRow(catalog.raw, MODEL);
  assert.ok(row, `${where}: no columnar price/tag row for ${MODEL} in the official --list-models output`);
  assert.equal(
    row.priceTag,
    "FREE",
    `${where}: the price/tag column of ${MODEL} is ${JSON.stringify(row.priceTag)}, not FREE; refusing to send a real prompt`
  );
  return row.line;
}

// ---------------------------------------------------------------------------
// Loopback terminal-wake listener
// ---------------------------------------------------------------------------

interface WakeListener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

async function startListener(): Promise<WakeListener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

// ---------------------------------------------------------------------------
// Job record waits
// ---------------------------------------------------------------------------

type PendingView = Record<string, unknown>;

interface ApprovalOrTerminal {
  kind: "approval" | "terminal";
  record: Record<string, unknown>;
  pending?: PendingView;
}

async function waitForApprovalOrTerminal(
  root: string,
  jobId: string,
  generation: number,
  timeoutMs: number,
  answered: Set<string>
): Promise<ApprovalOrTerminal> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readRecord(root, jobId);
    if (TERMINAL.has(String(record.status))) return { kind: "terminal", record };
    const pending = record.pendingApproval as PendingView | null | undefined;
    if (pending && typeof pending === "object") {
      const requestId = typeof pending.requestId === "string" ? pending.requestId : "";
      if (requestId && !answered.has(requestId)) return { kind: "approval", record, pending };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `job ${jobId} generation ${generation} neither finished nor asked for approval within ${timeoutMs}ms ` +
          `(status=${String(record.status)}, pending=${JSON.stringify(record.pendingApproval ?? null).slice(0, 200)})`
      );
    }
    await sleep(150);
  }
}

/** Wait until the running generation persists a live worker + CLI-root PID pair. */
async function waitForRunningTree(root: string, jobId: string, timeoutMs: number): Promise<{ childPid: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readRecord(root, jobId);
    if (TERMINAL.has(String(record.status))) throw new Error(`job ended before its tree was observed: ${String(record.status)}`);
    const childPid = record.childPid;
    if (String(record.status) === "running" && Number.isInteger(childPid) && isPidAlive(childPid as number) === true) {
      return { childPid: childPid as number };
    }
    if (Date.now() >= deadline) throw new Error(`job ${jobId} never persisted a live CLI root`);
    await sleep(100);
  }
}

async function waitForTerminalGeneration(
  client: McpStdioClient,
  id: string,
  generation: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (Number(result.generation) === generation && TERMINAL.has(String(result.status))) return result;
    if (Date.now() >= deadline) {
      throw new Error(`job ${id} generation ${generation} did not finish within ${timeoutMs}ms (last=${JSON.stringify(result).slice(0, 400)})`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// The ONLY approval this test may answer
// ---------------------------------------------------------------------------

/**
 * Build the strict expectation for THIS run's single allowed approval. The pure
 * `approvalIsThisRunsProbe` guard (src/tests/helpers/cc-acp-approval-guard.ts)
 * rejects everything else: a different file, a shell/execute action, a
 * title-only mention, a pathless request, an outside path, a conflicting cwd,
 * a wrong job/generation/provider/request or a missing native option.
 */
function probeExpectation(jobId: string, generation: number, probePath: string, projectDir: string): CcAcpApprovalExpectation {
  return {
    jobId,
    generation,
    provider: "command-code",
    toolKind: EXPECTED_TOOL_KIND,
    probePath,
    projectDir,
    optionId: ALLOW_OPTION_ID
  };
}

async function resolveViaHub(hubBase: string, jobId: string, generation: number, requestId: string): Promise<Response> {
  return await fetch(`${hubBase}/api/jobs/${encodeURIComponent(jobId)}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation, request_id: requestId, option_id: ALLOW_OPTION_ID })
  });
}

// ---------------------------------------------------------------------------
// The acceptance entry
// ---------------------------------------------------------------------------

test("the ACP production entry pauses a real standard-mode job for its own disposable-file approval, then resumes the same session", {
  timeout: 1200000
}, async () => {
  assert.ok(fs.existsSync(MCP_ENTRY), `build first: MCP entry missing at ${MCP_ENTRY}`);
  if (process.platform !== "win32") {
    assert.fail("this acceptance is Windows-only: its CLI/profile assumptions were measured on win32");
  }

  const cliResolution = resolveCommandCodeCli({
    env: { ...process.env, JOBQUAY_COMMAND_CODE_CLI_PATH: ACCEPT_CLI_PATH || "" }
  });
  if (!cliResolution.ok || !cliResolution.path) {
    assert.fail(`official cmdc.cmd is required; installed ACP acceptance is blocked (source=${cliResolution.source})`);
  }
  const cliPath = path.resolve(cliResolution.path as string);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), OWNED_TEMP_PREFIX));
  const root = path.join(workspace, "data-root");
  const project = path.join(workspace, "project");
  const foreignCwd = path.join(workspace, "unrelated-cwd");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(foreignCwd, { recursive: true });
  const probePath = path.join(project, PROBE_FILE);

  const mcpEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: cliPath,
    // This real-CLI gate verifies the ACP provider boundary, not the
    // Dashboard: never start the shared Hub on the default port.
    CREWDISPATCH_DISPATCH_DASHBOARD: "0"
  };
  delete mcpEnv.JOBQUAY_TEST_FIXTURE;
  delete mcpEnv.JOBQUAY_CLI_PATH;
  delete mcpEnv.JOBQUAY_COMMAND_CODE_CLI_COMMAND;
  delete mcpEnv.CODEX_THREAD_ID;

  let client: McpStdioClient | null = null;
  let hub: HubHandle | null = null;
  let listener: WakeListener | null = null;
  let jobId: string | null = null;
  let childPid: number | null = null;
  let sessionId: string | null = null;
  let failure: unknown = null;
  const problems: string[] = [];

  try {
    // ---- 0. FREE-model preflight (fail fast, before any prompt) -------------
    const caps = await probeCapabilities({ cliPath, env: mcpEnv, cwd: foreignCwd });
    assert.equal(caps.ok, true, `public cmdc probes failed: ${caps.errors.join("; ")}`);
    assert.match(String(caps.version), /^\d+\.\d+\.\d+/, `unexpected cmdc --version output: ${String(caps.version)}`);
    const catalog0 = await readModelCatalog({ cliPath, env: mcpEnv, cwd: foreignCwd });
    const freeLine = assertFreeModelEvidence(catalog0, "preflight");
    console.log(`[installed-cc-acp] preflight: version="${String(caps.version).trim()}" cli=${cliPath} freeLine="${freeLine}"`);

    // ---- 1. Real Hub on the disposable root (the bridge's approval route) ---
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubBase = `http://127.0.0.1:${hub.port}`;
    const ping = (await (await fetch(`${hubBase}/api/ping`)).json()) as Record<string, unknown>;
    assert.equal(ping.service, "jobquay", "the approval route must be this run's real Hub");
    listener = await startListener();

    // ---- 2. Dispatch a STANDARD-mode job through the production MCP entry ---
    client = new McpStdioClient(MCP_ENTRY, mcpEnv, foreignCwd);
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", {
        provider: "command-code",
        model: MODEL,
        task: TASK0,
        cwd: project,
        permission_mode: "standard",
        callback_url: listener.url
      })
    );
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal(spawned.provider, "command-code");
    jobId = String(spawned.job_id);
    assert.match(jobId, /^job-/);
    console.log(`[installed-cc-acp] spawned job=${jobId} model=${MODEL} mode=standard cwd=${project}`);

    const running = await waitForRunningTree(root, jobId, 60000);
    childPid = running.childPid;

    // ---- 3. The REAL CLI pauses: pending approval, file still UNCHANGED -----
    const first = await waitForApprovalOrTerminal(root, jobId, 0, 300000, new Set());
    assert.equal(
      first.kind,
      "approval",
      `the standard-mode job must pause for its own permission request, not finish (${JSON.stringify(first.record.result ?? null).slice(0, 400)})`
    );
    const pending0 = first.pending!;
    const guard0 = approvalIsThisRunsProbe(pending0, probeExpectation(jobId, 0, probePath, project));
    assert.equal(guard0.ok, true, `refusing to answer a request that is not this run's own probe (${guard0.reason})`);
    assert.equal(fs.existsSync(probePath), false, "no edit may happen while the approval is pending");
    const options0 = pending0.options as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(options0) && options0.some((option) => option.id === ALLOW_OPTION_ID), JSON.stringify(options0));
    assert.equal(typeof pending0.requestId, "string", "the request identity is published");
    const requestId0 = String(pending0.requestId);
    assert.equal(
      typeof pending0.detail === "object" && pending0.detail !== null && JSON.stringify(pending0.detail).includes(PROBE_FILE),
      true,
      `the CLI's own operation detail must name this run's probe file: ${JSON.stringify(pending0.detail)}`
    );

    // The REAL Hub serves the same bounded pending approval.
    const served = (await (await fetch(`${hubBase}/api/jobs/${jobId}/approval`)).json()) as Record<string, unknown>;
    assert.equal(served.pending_approval !== null && served.pending_approval !== undefined, true, JSON.stringify(served));
    assert.equal((served.pending_approval as Record<string, unknown>).request_id, requestId0);
    console.log(
      `[installed-cc-acp] pending approval request=${requestId0} tool=${String(pending0.toolName)} detail=${JSON.stringify(pending0.detail).slice(0, 200)}`
    );

    // ---- 4. ONE real Hub decision: allow_once --------------------------------
    const answered = await resolveViaHub(hubBase, jobId, 0, requestId0);
    assert.equal(answered.status, 200, `Hub approval POST failed: ${answered.status} ${await answered.text()}`);
    const decisionFile = approvalDecisionPath(root, jobId, 0, requestId0);
    assert.equal(fs.existsSync(decisionFile), true, "the Hub must claim exactly one decision file");
    const decision = JSON.parse(fs.readFileSync(decisionFile, "utf8")) as Record<string, unknown>;
    assert.equal(decision.optionId, "allow_once");
    assert.equal(decision.requestId, requestId0);

    // ---- 5. The SAME session performs ONLY the intended edit, then finishes --
    const result0 = await waitForTerminalGeneration(client, jobId, 0, 600000);
    assert.equal(result0.status, "done", JSON.stringify(result0.result));
    assert.equal(result0.model, MODEL);
    const compact0 = result0.result as Record<string, unknown>;
    assert.equal(compact0.exit_code, 0, `generation 0 must exit 0 (${JSON.stringify(compact0)})`);
    assert.equal(compact0.kind, "success");
    assert.match(String(compact0.final_text), new RegExp(MARKER), `generation 0 final text: ${String(compact0.final_text)}`);
    assert.equal(fs.existsSync(probePath), true, "the approved edit must have created the probe file");
    assert.equal(fs.readFileSync(probePath, "utf8"), PROBE_TEXT, "the approved edit must persist the exact requested content");

    const record0 = readRecord(root, jobId);
    assert.equal(record0.permissionMode, "standard", "the requested native standard mode must be persisted");
    assert.equal(record0.childPid, null, "the managed CLI child must be gone at terminal completion");
    assert.equal(isPidAlive(childPid), false, "the captured CLI root must have exited");
    assert.equal(record0.pendingApproval, null, "the pending approval must be cleared after the turn");
    assert.equal(fs.existsSync(approvalRequestPath(root, jobId, 0, requestId0)), false, "the request file must be cleared");
    sessionId = String(record0.sessionId ?? "");
    assert.ok(isValidSessionIdFor("command-code", sessionId), `a real resumable session id must be persisted: ${JSON.stringify(record0.sessionId)}`);
    const attempts0 = record0.attempts as Array<Record<string, unknown>>;
    assert.deepEqual(attempts0.map((attempt) => attempt.generation), [0]);
    assert.equal(attempts0[0]!.effort, null, "no requested effort must remain the model/provider default (null)");
    const usage0 = attempts0[0]!.usage as Record<string, unknown>;
    assert.ok(
      usage0 && (usage0.tokensIn != null || usage0.tokensOut != null),
      `the real prompt result must publish token usage: ${JSON.stringify(usage0)}`
    );
    assert.equal(usage0.decodeTokens, null, "ACP publishes no model-request boundary: Decode must stay null, never synthesized");
    assert.equal(usage0.decodeSeconds, null, "ACP publishes no model-request boundary: Decode must stay null, never synthesized");
    console.log(`[installed-cc-acp] gen0 done session=${sessionId} usage=${JSON.stringify(usage0)}`);

    // ---- 6. Follow-up resumes the REAL session (new generation) --------------
    const catalog1 = await readModelCatalog({ cliPath, env: mcpEnv, cwd: foreignCwd });
    assertFreeModelEvidence(catalog1, "pre-follow-up re-confirmation");
    const followed = McpStdioClient.json(await client.callTool("jobquay_follow_up", { id: jobId, message: TASK1, callback_url: listener.url }));
    assert.equal(followed.ok, true, JSON.stringify(followed));
    assert.equal(followed.job_id, jobId);
    assert.equal(Number(followed.generation), 1);

    // A follow-up question should not need approval; if the model still raises
    // one, it is answered ONLY through the same strict identity guard.
    const answeredIds = new Set<string>();
    for (;;) {
      const step = await waitForApprovalOrTerminal(root, jobId, 1, 600000, answeredIds);
      if (step.kind === "terminal") break;
      const pending = step.pending!;
      const guard = approvalIsThisRunsProbe(pending, probeExpectation(jobId, 1, probePath, project));
      assert.equal(guard.ok, true, `refusing to answer a request that is not this run's own probe (${guard.reason})`);
      const requestId = String(pending.requestId);
      answeredIds.add(requestId);
      const response = await resolveViaHub(hubBase, jobId, 1, requestId);
      assert.equal(response.status, 200, `Hub approval POST failed during generation 1: ${response.status} ${await response.text()}`);
      console.log(`[installed-cc-acp] gen1 approved its own request=${requestId}`);
    }
    const result1 = McpStdioClient.json(await client.callTool("jobquay_result", { id: jobId }));
    assert.equal(result1.status, "done", JSON.stringify(result1.result));
    const compact1 = result1.result as Record<string, unknown>;
    assert.equal(compact1.exit_code, 0, `generation 1 must exit 0 (${JSON.stringify(compact1)})`);
    // The follow-up never contains the marker: only the resumed session can
    // answer it, so this is behavioural session/resume evidence.
    assert.match(String(compact1.final_text), new RegExp(MARKER), `generation 1 must recall the marker: ${String(compact1.final_text)}`);
    const record1 = readRecord(root, jobId);
    assert.equal(record1.sessionId, sessionId, "the follow-up must reuse the SAME real provider session");
    assert.equal(record1.childPid, null);
    const attempts1 = record1.attempts as Array<Record<string, unknown>>;
    assert.deepEqual(attempts1.map((attempt) => attempt.generation), [0, 1]);
    assert.equal(attempts1[1]!.resumedFrom, sessionId, "the second attempt must resume from the persisted session");
    console.log(`[installed-cc-acp] gen1 done session=${sessionId} final="${String(compact1.final_text).trim()}"`);

    // ---- 7. The caller was notified: one approval_required + one terminal per generation
    const wakeDeadline = Date.now() + 30000;
    while (listener.bodies.length < 3 && Date.now() < wakeDeadline) await sleep(100);
    const bodies = listener.bodies.map((body) => JSON.parse(body) as Record<string, unknown>);
    const approvalBodies = bodies.filter((body) => body.event === "approval_required");
    const terminalBodies = bodies.filter((body) => body.event === undefined);
    assert.equal(approvalBodies.length, 1, `exactly one approval_required notification: ${JSON.stringify(bodies)}`);
    assert.equal(terminalBodies.length, 2, `exactly one terminal notification per generation: ${JSON.stringify(bodies)}`);
    const approvalBody = approvalBodies[0]!;
    assert.equal(approvalBody.job_id, jobId);
    assert.equal(approvalBody.generation, 0);
    assert.equal(approvalBody.request_id, requestId0);
    assert.equal(approvalBody.provider, "command-code");
    // The CLI truncates its OWN display title (the full path stays in the
    // durable pending detail, asserted above), so the notification carries the
    // bounded one-line operation: non-empty, not the bare tool name, and
    // recognizably this run's probe.
    assert.equal(typeof approvalBody.operation, "string", "the approval notification carries the provider's own operation text");
    assert.notEqual(String(approvalBody.operation).trim(), "", "the operation text is not empty");
    assert.notEqual(String(approvalBody.operation).trim(), "edit", "the operation text is the actual operation, not the bare tool name");
    assert.match(String(approvalBody.operation), /jobquay/, "the operation text names this run's probe file");
    assert.ok(
      String(approvalBody.hub_url).startsWith(`${hubBase}/ui?job=`),
      `the approval notification carries this run's live Hub link: ${String(approvalBody.hub_url)}`
    );
    assert.equal(typeof approvalBody.expires_at, "string", "the approval notification carries the request expiry");
    for (const body of terminalBodies) {
      assert.deepEqual(Object.keys(body).sort(), ["job_id", "status"]);
      assert.equal(body.job_id, jobId);
      assert.equal(body.status, "done");
    }
    console.log(`[installed-cc-acp] notifications approval=1 terminal=${terminalBodies.length}`);
  } catch (e) {
    failure = e;
  }

  // -------------------------------------------------------------------------
  // Cleanup: stop a non-terminal job through the product, prove the CLI tree is
  // gone, close the MCP client/listener/Hub, stop THIS root's daemon and confirm
  // it exited, then remove only this run's own temp tree (kept on failure).
  // -------------------------------------------------------------------------
  if (jobId) {
    const recordFile = path.join(root, "jobs", `${jobId}.json`);
    if (fs.existsSync(recordFile) && !TERMINAL.has(String(readRecord(root, jobId).status))) {
      try {
        if (!client) {
          client = new McpStdioClient(MCP_ENTRY, mcpEnv, foreignCwd);
          await client.initialize();
        }
        await client.callTool("jobquay_cancel", { id: jobId, wait_seconds: 8 });
        const after = McpStdioClient.json(await client.callTool("jobquay_result", { id: jobId }));
        if (!TERMINAL.has(String(after.status))) problems.push(`job ${jobId} never proved terminal (status=${String(after.status)})`);
      } catch (e) {
        problems.push(`could not cancel/confirm job ${jobId}: ${errorMessage(e)}`);
      }
    }
  }
  if (childPid != null && isPidAlive(childPid) !== false) {
    // Only WAIT: never signal. A 30s bounded wait, then an honest residue report.
    const deadline = Date.now() + 30000;
    while (isPidAlive(childPid) === true && Date.now() < deadline) await sleep(200);
    if (isPidAlive(childPid) === true) problems.push(`captured CLI root PID ${childPid} did not exit; nothing was signalled`);
  }
  try {
    if (client) await client.close();
  } catch (e) {
    problems.push(`could not close the MCP client: ${errorMessage(e)}`);
  }
  try {
    if (listener) await listener.close();
  } catch (e) {
    problems.push(`could not close the loopback wake listener: ${errorMessage(e)}`);
  }
  try {
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
  } catch (e) {
    problems.push(`could not close the Hub: ${errorMessage(e)}`);
  }
  // Stop THIS run's isolated daemon (an owned process) and confirm it exited
  // BEFORE the tree is removed. It runs on success and failure and only ever
  // reads this data root's own daemon record — never the production root.
  try {
    const stopped = await stopOwnedDaemon(root, mcpEnv);
    if (!stopped.confirmed) {
      problems.push(`this run's daemon did not exit: ${stopped.reason ?? "unknown"} (pid=${String(stopped.pid)})`);
    }
  } catch (e) {
    problems.push(`could not shut down this run's daemon: ${errorMessage(e)}`);
  }

  if (problems.length === 0 && !failure) {
    const removal = await removeOwnedTree(workspace);
    if (!removal.removed) problems.push(`could not remove this run's temp tree ${workspace}: ${removal.lastError ?? "unknown"}`);
  } else {
    // A failed acceptance keeps its whole tree (records, logs, workspace) for
    // diagnosis; the Hub is closed but nothing is deleted.
    problems.push(`this run's temp tree was KEPT for diagnosis: ${workspace}`);
  }
  console.log(
    `[installed-cc-acp] cleanup job=${String(jobId)} session=${String(sessionId)} problems=${problems.length} ` +
      `note=the official CLI may retain its own session turn under the operator profile (not read or modified by this test)`
  );

  // The PRIMARY failure must always be readable: compose one message instead of
  // an AggregateError whose individual errors a TAP reporter may not print.
  if (failure && problems.length > 0) {
    throw new Error(`${errorMessage(failure)}; cleanup: ${problems.join(" | ")}`);
  }
  if (failure) throw failure;
  if (problems.length > 0) {
    throw new Error(`cleanup verification failed for job=${String(jobId)} root=${workspace}: ${problems.join(" | ")}`);
  }
});
