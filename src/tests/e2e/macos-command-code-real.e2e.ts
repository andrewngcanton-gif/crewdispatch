import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { probeCapabilities, readModelCatalog } from "../../providers/command-code/probe";
import { startHub, type HubHandle } from "../../hub/server";
import { shutdownJobDaemon } from "../../daemon/client";
import { loadJob } from "../../jobs/store";
import { approvalRequestPath } from "../../jobs/approval";
import { isPidAlive } from "../../runtime/process";
import { McpStdioClient } from "../helpers/mcp-client";

const CHECKOUT_MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const ACCEPT_SOURCE_ROOT = process.env.JOBQUAY_ACCEPT_SOURCE_ROOT?.trim() || null;
if (ACCEPT_SOURCE_ROOT && !path.isAbsolute(ACCEPT_SOURCE_ROOT)) {
  throw new Error("JOBQUAY_ACCEPT_SOURCE_ROOT must be an absolute unpacked candidate root");
}
const MODEL = "stealth/glyph-cluster:free";
const EFFORT = "xhigh";
const MARKER = "MAC21-GEN0-MARKER";
const FILE_NAME = "mac21-approval-probe.txt";
const FILE_TEXT = "MAC21-APPROVAL-OK\n";
const FIRST_TASK =
  `Create ${FILE_NAME} in the current workspace with exactly the text MAC21-APPROVAL-OK followed by one newline. ` +
  "Use a file-writing/editing tool, not shell, Python, Node, or another command runner. " +
  `After the file is written successfully, reply with exactly ${MARKER} and nothing else.`;
const FOLLOW_TASK =
  "What was the exact marker I asked you to reply with in the previous turn? Reply with only that marker and nothing else.";
const WB_MODEL = "hy3";
const WB_EFFORT = "high";
const WB_MARKER = "MACREL06-WB-G0-DONE";
const WB_FILE_NAME = "macrel06-wb-approval-probe.txt";
const WB_FILE_TEXT = "MACREL06-WB-APPROVAL-OK\n";
const WB_FIRST_TASK =
  "Use the Bash tool exactly once. Run this single command in the current workspace: printf 'MACREL06-WB-APPROVAL-OK\\n' > " +
  WB_FILE_NAME + " && cat " + WB_FILE_NAME + ". Do not use any other tool. After the command succeeds, reply with exactly " +
  WB_MARKER + " and nothing else.";
const WB_FOLLOW_TASK =
  "What exact marker did I ask you to reply with in the previous turn? Do not use tools. Reply with only that marker and nothing else.";
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Listener {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startListener(): Promise<Listener> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        bodies.push({ raw: body });
      }
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

async function startIsolatedHub(root: string): Promise<{ hub: HubHandle; url: string }> {
  const hub = startHub({ root, host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("listening", () => resolve());
    hub.server.once("error", reject);
  });
  return { hub, url: `http://127.0.0.1:${hub.port}` };
}

interface AcceptanceRuntime {
  mcpEntry: string;
  hubUrl: string;
  runtimeSource: "checkout" | "candidate-installed";
  installedTarget: string | null;
  close: () => Promise<void>;
}

function runJsonProcess(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, label: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  assert.equal(result.error, undefined, `${label} spawn error: ${String(result.error)}`);
  assert.equal(result.status, 0, `${label} failed status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(String(result.stdout || "")) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`${label} did not return JSON: ${String((error as Error).message)}; stdout=${String(result.stdout || "").slice(0, 2000)}`);
  }
  assert.equal(parsed.ok, true, `${label} returned ok=false: ${JSON.stringify(parsed)}`);
  return parsed;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = http.createServer((_req, res) => res.end("reserved"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function prepareAcceptanceRuntime(temp: string, jobRoot: string, env: NodeJS.ProcessEnv): Promise<AcceptanceRuntime> {
  if (!ACCEPT_SOURCE_ROOT) {
    const { hub, url } = await startIsolatedHub(jobRoot);
    return {
      mcpEntry: CHECKOUT_MCP_ENTRY,
      hubUrl: url,
      runtimeSource: "checkout",
      installedTarget: null,
      close: async () => {
        hub.server.closeAllConnections?.();
        await new Promise<void>((resolve) => hub.server.close(() => resolve()));
      }
    };
  }

  const candidateRoot = fs.realpathSync.native(path.resolve(ACCEPT_SOURCE_ROOT));
  const sourceInstaller = path.join(candidateRoot, "dist", "cli", "install-cli.js");
  assert.equal(fs.existsSync(sourceInstaller), true, `candidate installer missing: ${sourceInstaller}`);
  const installedTarget = path.join(temp, "installed-candidate");
  const installDataRoot = path.join(temp, "installer-data");
  const installEnv: NodeJS.ProcessEnv = {
    ...env,
    JOBQUAY_DATA_ROOT: installDataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(temp, "autostart-registry.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(temp, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(temp, "launchctl-state.json")
  };
  const install = runJsonProcess(sourceInstaller, ["install", "--target", installedTarget], temp, installEnv, "candidate install");
  assert.equal(install.packageVersion, "0.1.6", `candidate install version mismatch: ${JSON.stringify(install)}`);

  const mcpEntry = path.join(installedTarget, "dist", "mcp", "server.js");
  const installedCli = path.join(installedTarget, "dist", "cli", "crewdispatch-cli.js");
  const installedInstaller = path.join(installedTarget, "dist", "cli", "install-cli.js");
  for (const file of [mcpEntry, installedCli, installedInstaller]) {
    assert.equal(fs.existsSync(file), true, `installed candidate entry missing: ${file}`);
  }
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(installedTarget, "plugins", "crewdispatch", ".mcp.json"), "utf8")) as {
    mcpServers?: { crewdispatch?: { command?: string; args?: string[] } };
  };
  assert.equal(path.resolve(String(mcpConfig.mcpServers?.crewdispatch?.command || "")), path.resolve(process.execPath));
  assert.equal(path.resolve(String(mcpConfig.mcpServers?.crewdispatch?.args?.[0] || "")), path.resolve(mcpEntry));
  assert.equal(mcpEntry.startsWith(candidateRoot), false, "installed MCP entry must not point back to the unpacked candidate root");

  const port = await reserveLoopbackPort();
  const hub = runJsonProcess(installedCli, ["web", "--no-open", "--port", String(port), "--json"], temp, env, "installed candidate Hub");
  const apiBase = `http://127.0.0.1:${port}`;
  assert.equal(hub.url, `${apiBase}/ui`, `unexpected installed Hub URL: ${String(hub.url)}`);
  const ping = await fetch(`${apiBase}/api/ping`);
  assert.equal(ping.status, 200, `installed Hub ping failed (${ping.status})`);
  const pingBody = await ping.json() as Record<string, unknown>;
  assert.equal(pingBody.version, "0.1.6");

  return {
    mcpEntry,
    hubUrl: apiBase,
    runtimeSource: "candidate-installed",
    installedTarget,
    close: async () => {
      try {
        await fetch(`${apiBase}/api/hub/shutdown`, { method: "POST" });
      } catch {
        // Bounded cleanup continues through the managed uninstall below.
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${apiBase}/api/ping`);
          if (!response.ok) break;
        } catch {
          break;
        }
        await sleep(100);
      }
      const removed = runJsonProcess(installedInstaller, ["uninstall", "--target", installedTarget], temp, installEnv, "candidate uninstall");
      assert.equal(removed.ok, true);
    }
  };
}

function freeRow(raw: string, model: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const m = /^(\S+)\s{2,}(\S+)(?:\s+(.*))?$/.exec(t);
    if (m?.[1] === model && m[2] === "FREE") return t;
  }
  return null;
}

async function waitJob(root: string, id: string, predicate: (job: NonNullable<ReturnType<typeof loadJob>>) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && predicate(job)) return job;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${id}; last=${job ? `${job.status}/g${job.generation}/${job.error ?? ""}` : "missing"}`);
    }
    await sleep(150);
  }
}

async function resolveApproval(hubUrl: string, jobId: string, generation: number, requestId: string, optionId: string): Promise<void> {
  const response = await fetch(`${hubUrl}/api/jobs/${encodeURIComponent(jobId)}/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation, request_id: requestId, option_id: optionId })
  });
  assert.equal(response.status, 200, `approval POST failed (${response.status}): ${await response.text()}`);
}

async function waitResult(client: McpStdioClient, id: string, generation: number, timeoutMs = 600000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    if (Number(result.generation) === generation && TERMINAL.has(String(result.status))) return result;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${id} generation ${generation}`);
    await sleep(300);
  }
}

async function waitBodies(listener: Listener, count: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listener.bodies.length < count) {
    if (Date.now() >= deadline) throw new Error(`expected ${count} callback events, got ${listener.bodies.length}`);
    await sleep(100);
  }
}

async function readFreshWorkBuddy(hubUrl: string): Promise<{
  cliVersion: string | null;
  cliPath: string | null;
  catalogSource: string;
  catalogCount: number;
  modelMeta: Record<string, unknown>;
}> {
  const response = await fetch(hubUrl + "/api/providers/workbuddy-ai/settings?fresh=1");
  assert.equal(response.status, 200, "WorkBuddy fresh settings HTTP " + response.status);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.ok, true, "WorkBuddy fresh settings failed: " + JSON.stringify(body));
  const view = body.view as Record<string, unknown>;
  const cli = view.cli as Record<string, unknown>;
  const catalog = view.catalog as Record<string, unknown>;
  const modelMeta = (view.model_meta ?? {}) as Record<string, unknown>;
  assert.equal(cli.available, true, "WorkBuddy CLI unavailable: " + JSON.stringify(cli));
  assert.equal(catalog.available, true, "WorkBuddy catalog unavailable: " + JSON.stringify(catalog));
  assert.equal(catalog.reliable, true, "WorkBuddy catalog is not reliable: " + JSON.stringify(catalog));
  assert.equal(catalog.source, "workbuddy-product-snapshot");
  assert.ok(Array.isArray(catalog.models) && catalog.models.includes(WB_MODEL), WB_MODEL + " missing from WorkBuddy catalog");
  const meta = modelMeta[WB_MODEL] as Record<string, unknown> | undefined;
  assert.ok(meta, WB_MODEL + " metadata missing");
  assert.equal(meta.free, true, WB_MODEL + " is not currently Free-now; refusing the real prompt");
  const reasoning = meta.reasoning as Record<string, unknown> | undefined;
  assert.equal(reasoning?.app_default_effort, WB_EFFORT);
  assert.ok(Array.isArray(reasoning?.supported_efforts) && reasoning!.supported_efforts.includes(WB_EFFORT));
  return {
    cliVersion: typeof cli.version === "string" ? cli.version : null,
    cliPath: typeof cli.path === "string" ? cli.path : null,
    catalogSource: String(catalog.source),
    catalogCount: Number(catalog.count),
    modelMeta: meta
  };
}

test(
  "native macOS real Command Code: FREE model, xhigh effort, standard approval, generation-1 resume, usage and exact wakes",
  { timeout: 1200000 },
  async () => {
    assert.equal(process.platform, "darwin", "MAC-21 is a native macOS acceptance");
    assert.equal(process.arch, "arm64", "MAC-21 authenticated real-host receipt is arm64-only; Intel provider real-host coverage is unverified");
    assert.equal(process.env.JOBQUAY_ACCEPT_MACOS_COMMAND_CODE_REAL, "1", "set JOBQUAY_ACCEPT_MACOS_COMMAND_CODE_REAL=1 to authorize the real FREE-model run");

    const resolved = resolveCommandCodeCli({ env: process.env });
    assert.equal(resolved.ok, true, `official Command Code CLI unavailable (${resolved.source})`);
    assert.ok(resolved.path);
    const cliPath = path.resolve(resolved.path!);

    const caps = await probeCapabilities({ cliPath, env: process.env, cwd: process.cwd() });
    assert.equal(caps.ok, true, caps.errors.join("; "));
    assert.match(String(caps.version), /^\d+\.\d+\.\d+/, "the official CLI must publish a semantic version");
    const catalog0 = await readModelCatalog({ cliPath, env: process.env, cwd: process.cwd() });
    assert.equal(catalog0.ok, true, catalog0.error ?? "catalog probe failed");
    assert.equal(catalog0.source, "cli-list-models");
    assert.ok(catalog0.raw);
    const free0 = freeRow(catalog0.raw!, MODEL);
    assert.ok(free0, `${MODEL} is not currently published as standalone FREE; refusing the real prompt`);

    const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-mac21-real-"));
    const root = path.join(temp, "root");
    const project = path.join(temp, "workspace");
    fs.mkdirSync(path.join(project, ".commandcode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".commandcode", "settings.json"),
      `${JSON.stringify({
        model: MODEL,
        featureModels: {
          titleGeneration: MODEL,
          compaction: MODEL,
          toolDescription: MODEL,
          tasteOnboarding: MODEL,
          tasteLearning: MODEL,
          branchSummarization: MODEL
        },
        tasteLearning: false
      }, null, 2)}\n`,
      "utf8"
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JOBQUAY_DATA_ROOT: root,
      JOBQUAY_COMMAND_CODE_CLI_PATH: cliPath,
      CREWDISPATCH_DISPATCH_DASHBOARD: "0"
    };
    delete env.CODEX_THREAD_ID;
    delete env.JOBQUAY_TEST_FIXTURE;
    delete env.JOBQUAY_CLI_PATH;
    delete env.JOBQUAY_COMMAND_CODE_CLI_COMMAND;

    let listener: Listener | null = null;
    let runtime: AcceptanceRuntime | null = null;
    let client: McpStdioClient | null = null;
    let jobId = "";
    let sessionId = "";
    try {
      listener = await startListener();
      runtime = await prepareAcceptanceRuntime(temp, root, env);
      const hubUrl = runtime.hubUrl;
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const spawned = McpStdioClient.json(
        await client.callTool("crewdispatch_spawn", {
          provider: "command-code",
          model: MODEL,
          effort: EFFORT,
          permission_mode: "standard",
          task: FIRST_TASK,
          cwd: project,
          callback_url: listener.url
        })
      );
      assert.equal(spawned.accepted, true, JSON.stringify(spawned));
      assert.equal(spawned.provider, "command-code");
      assert.equal(Number(spawned.generation), 0);
      jobId = String(spawned.job_id);

      const pending0 = await waitJob(root, jobId, (job) => job.generation === 0 && job.pendingApproval != null, 180000);
      assert.equal(pending0.status, "running");
      assert.equal(pending0.permissionMode, "standard");
      assert.equal(pending0.model, MODEL);
      assert.equal(fs.existsSync(path.join(project, FILE_NAME)), false, "the file must not exist before approval");
      const approval = pending0.pendingApproval!;
      assert.equal(approval.provider, "command-code");
      assert.equal(approval.generation, 0);
      const operation = JSON.stringify(approval.detail ?? {});
      assert.match(operation, new RegExp(FILE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `approval must describe ${FILE_NAME}: ${operation}`);
      // The callback is the caller's notification that approval is required.
      // Wait for it BEFORE resolving the approval. Resolving first races the
      // notification's final stale-request revalidation and may correctly
      // suppress a no-longer-actionable approval alert.
      await waitBodies(listener, 1);
      assert.equal(listener.bodies.filter((b) => b.event === "approval_required" && b.generation === 0).length, 1);
      assert.equal(listener.bodies.filter((b) => b.status === "done" && b.job_id === jobId).length, 0);
      const allow = approval.options.find((option) => option.kind === "allow_once") ?? approval.options.find((option) => option.kind === "allow_always");
      assert.ok(allow, `provider published no bounded allow option: ${JSON.stringify(approval.options)}`);
      await resolveApproval(hubUrl, jobId, 0, approval.requestId, allow!.id);

      const result0 = await waitResult(client, jobId, 0);
      assert.equal(result0.status, "done", JSON.stringify(result0.result));
      assert.equal(result0.model, MODEL);
      assert.deepEqual(result0.model_chain, [MODEL]);
      assert.equal(result0.downgraded, false);
      assert.match(String((result0.result as Record<string, unknown>).final_text ?? ""), new RegExp(MARKER));
      assert.equal(fs.readFileSync(path.join(project, FILE_NAME), "utf8"), FILE_TEXT);

      const record0 = loadJob(root, jobId)!;
      sessionId = String(record0.sessionId ?? "");
      assert.ok(sessionId, "generation 0 must persist the provider session id");
      assert.equal(record0.model, MODEL);
      assert.equal(record0.modelSource, "explicit");
      assert.equal(record0.permissionMode, "standard");
      assert.equal(record0.attempts.length, 1);
      assert.equal(record0.attempts[0]!.effort, EFFORT);
      assert.equal(record0.attempts[0]!.rateLimited, false);
      assert.ok(record0.usage.tokensIn != null && record0.usage.tokensIn > 0, `generation 0 input usage unavailable: ${JSON.stringify(record0.usage)}`);
      assert.ok(record0.usage.tokensOut != null && record0.usage.tokensOut > 0, `generation 0 output usage unavailable: ${JSON.stringify(record0.usage)}`);

      await waitBodies(listener, 2);
      assert.equal(listener.bodies.filter((b) => b.event === "approval_required" && b.generation === 0).length, 1);
      assert.equal(listener.bodies.filter((b) => b.status === "done" && b.job_id === jobId).length, 1);

      const catalog1 = await readModelCatalog({ cliPath, env, cwd: project });
      assert.ok(catalog1.ok && catalog1.raw && freeRow(catalog1.raw, MODEL), `${MODEL} lost fresh FREE evidence before generation 1`);

      const followed = McpStdioClient.json(
        await client.callTool("crewdispatch_follow_up", { id: jobId, message: FOLLOW_TASK, callback_url: listener.url })
      );
      assert.equal(followed.ok, true, JSON.stringify(followed));
      assert.equal(followed.job_id, jobId);
      assert.equal(Number(followed.generation), 1);

      const result1 = await waitResult(client, jobId, 1);
      assert.equal(result1.status, "done", JSON.stringify(result1.result));
      assert.equal(result1.model, MODEL);
      assert.deepEqual(result1.model_chain, [MODEL]);
      assert.equal(result1.downgraded, false);
      assert.match(String((result1.result as Record<string, unknown>).final_text ?? ""), new RegExp(MARKER));

      const record1 = loadJob(root, jobId)!;
      assert.equal(record1.generation, 1);
      assert.equal(record1.sessionId, sessionId, "generation 1 must resume the exact provider session");
      assert.equal(record1.attempts.length, 2);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.model), [MODEL, MODEL]);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.effort), [EFFORT, EFFORT]);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.rateLimited), [false, false]);
      assert.equal(record1.attempts[1]!.resumedFrom, sessionId);
      assert.ok(record1.usage.tokensIn != null && record1.usage.tokensIn >= record0.usage.tokensIn!);
      assert.ok(record1.usage.tokensOut != null && record1.usage.tokensOut >= record0.usage.tokensOut!);

      await waitBodies(listener, 3);
      assert.equal(listener.bodies.filter((b) => b.event === "approval_required").length, 1, "follow-up must not duplicate the generation-0 approval");
      assert.equal(listener.bodies.filter((b) => b.status === "done" && b.job_id === jobId).length, 2, "one terminal wake per generation");

      await client.close();
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const reread = McpStdioClient.json(await client.callTool("crewdispatch_result", { id: jobId }));
      assert.equal(reread.status, "done");
      assert.equal(Number(reread.generation), 1);
      assert.equal(reread.model, MODEL);
      assert.match(String((reread.result as Record<string, unknown>).final_text ?? ""), new RegExp(MARKER));

      console.log(JSON.stringify({
        kind: "macos-command-code-real-v1",
        runtime_source: runtime.runtimeSource,
        installed_target: runtime.installedTarget,
        cli: cliPath,
        version: caps.version,
        free_model: MODEL,
        free_row: free0,
        effort: EFFORT,
        permission_mode: "standard",
        job_id: jobId,
        session_reused: true,
        generations: 2,
        approval_events: listener.bodies.filter((b) => b.event === "approval_required").length,
        terminal_wakes: listener.bodies.filter((b) => b.status === "done" && b.job_id === jobId).length,
        usage: record1.usage,
        attempts: record1.attempts.map((attempt) => ({ generation: attempt.generation, model: attempt.model, effort: attempt.effort, rateLimited: attempt.rateLimited, exitCode: attempt.exitCode }))
      }, null, 2));
    } finally {
      await client?.close().catch(() => undefined);
      await shutdownJobDaemon(root, env).catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await listener?.close().catch(() => undefined);
      try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Disposable acceptance tree. A cleanup failure does not rewrite the verdict.
      }
    }
  }
);



test(
  "MAC-REL-06 native macOS WorkBuddy exact artifact: fresh Free-now, approval, same-session follow-up, usage and wakes",
  { timeout: 1200000 },
  async () => {
    assert.equal(process.platform, "darwin", "WorkBuddy exact-artifact acceptance requires macOS");
    assert.equal(process.arch, "arm64", "authenticated WorkBuddy exact-artifact receipt is arm64-only");
    assert.equal(
      process.env.JOBQUAY_ACCEPT_MACOS_WORKBUDDY_EXACT,
      "1",
      "set JOBQUAY_ACCEPT_MACOS_WORKBUDDY_EXACT=1 to authorize the real Free-now WorkBuddy run"
    );
    assert.ok(ACCEPT_SOURCE_ROOT, "JOBQUAY_ACCEPT_SOURCE_ROOT must point to the unpacked exact candidate");

    const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-macrel06-wb-"));
    const root = path.join(temp, "root");
    const project = path.join(temp, "workspace");
    fs.mkdirSync(project, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JOBQUAY_DATA_ROOT: root,
      CREWDISPATCH_DISPATCH_DASHBOARD: "0"
    };
    delete env.CODEX_THREAD_ID;
    delete env.JOBQUAY_TEST_FIXTURE;
    delete env.JOBQUAY_CLI_PATH;

    let listener: Listener | null = null;
    let runtime: AcceptanceRuntime | null = null;
    let client: McpStdioClient | null = null;
    let jobId = "";
    let sessionId = "";
    try {
      listener = await startListener();
      runtime = await prepareAcceptanceRuntime(temp, root, env);
      assert.equal(runtime.runtimeSource, "candidate-installed", "WorkBuddy release evidence must run from the installed candidate");
      const fresh0 = await readFreshWorkBuddy(runtime.hubUrl);
      assert.match(String(fresh0.cliVersion ?? ""), /^\d+\.\d+\.\d+$/);

      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const spawned = McpStdioClient.json(
        await client.callTool("crewdispatch_spawn", {
          provider: "workbuddy-ai",
          model: WB_MODEL,
          effort: WB_EFFORT,
          permission_mode: "default",
          task: WB_FIRST_TASK,
          cwd: project,
          callback_url: listener.url
        })
      );
      assert.equal(spawned.accepted, true, JSON.stringify(spawned));
      assert.equal(spawned.provider, "workbuddy-ai");
      assert.equal(Number(spawned.generation), 0);
      jobId = String(spawned.job_id);

      const pending0 = await waitJob(root, jobId, (job) => job.generation === 0 && job.pendingApproval != null, 240000);
      assert.equal(pending0.status, "running");
      assert.equal(pending0.provider, "workbuddy-ai");
      assert.equal(pending0.model, WB_MODEL);
      assert.equal(pending0.permissionMode, "default");
      const approval = pending0.pendingApproval!;
      assert.equal(approval.provider, "workbuddy-ai");
      assert.equal(approval.generation, 0);
      assert.match(JSON.stringify(approval.detail ?? {}), new RegExp(WB_FILE_NAME.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));

      await waitBodies(listener, 1);
      assert.equal(
        listener.bodies.filter((body) => body.event === "approval_required" && body.generation === 0).length,
        1,
        "generation 0 must publish exactly one approval callback before the human decision"
      );
      const allow =
        approval.options.find((option) => option.kind === "allow_once") ??
        approval.options.find((option) => option.kind === "allow_always");
      assert.ok(allow, "WorkBuddy published no bounded allow option: " + JSON.stringify(approval.options));
      await resolveApproval(runtime.hubUrl, jobId, 0, approval.requestId, allow!.id);

      const result0 = await waitResult(client, jobId, 0);
      assert.equal(result0.status, "done", JSON.stringify(result0.result));
      assert.equal(result0.model, WB_MODEL);
      // model_chain is the accepted candidate chain, not the list of models that actually ran.
      // With an explicit hy3 primary on a fresh WorkBuddy config, the configured default
      // deepseek-v4.1-flash remains the next rate-limit candidate while the configured
      // fallback hy3 is deduped. A successful primary must still report downgraded=false
      // and the per-attempt audit below must show that only hy3 actually executed.
      assert.deepEqual(result0.model_chain, [WB_MODEL, "deepseek-v4.1-flash"]);
      assert.equal(result0.downgraded, false);
      assert.match(String((result0.result as Record<string, unknown>).final_text ?? ""), new RegExp(WB_MARKER));
      assert.equal(fs.readFileSync(path.join(project, WB_FILE_NAME), "utf8").replace(/\r\n/g, "\n"), WB_FILE_TEXT);

      const record0 = loadJob(root, jobId)!;
      sessionId = String(record0.sessionId ?? "");
      assert.ok(sessionId, "generation 0 must persist the WorkBuddy session id");
      assert.equal(record0.modelSource, "explicit");
      assert.equal(record0.attempts.length, 1);
      assert.equal(record0.attempts[0]!.model, WB_MODEL);
      assert.equal(record0.attempts[0]!.effort, WB_EFFORT);
      assert.equal(record0.attempts[0]!.rateLimited, false);
      assert.ok(record0.usage.tokensIn != null && record0.usage.tokensIn > 0);
      assert.ok(record0.usage.tokensOut != null && record0.usage.tokensOut > 0);
      assert.ok(record0.usage.toolCalls != null && record0.usage.toolCalls >= 1);

      await waitBodies(listener, 2);
      assert.equal(listener.bodies.filter((body) => body.status === "done" && body.job_id === jobId).length, 1);

      const fresh1 = await readFreshWorkBuddy(runtime.hubUrl);
      assert.equal(fresh1.modelMeta.free, true, WB_MODEL + " lost fresh Free-now evidence before generation 1");

      const followed = McpStdioClient.json(
        await client.callTool("crewdispatch_follow_up", {
          id: jobId,
          message: WB_FOLLOW_TASK,
          callback_url: listener.url
        })
      );
      assert.equal(followed.ok, true, JSON.stringify(followed));
      assert.equal(followed.job_id, jobId);
      assert.equal(Number(followed.generation), 1);

      const result1 = await waitResult(client, jobId, 1);
      assert.equal(result1.status, "done", JSON.stringify(result1.result));
      assert.equal(result1.model, WB_MODEL);
      assert.deepEqual(result1.model_chain, [WB_MODEL, "deepseek-v4.1-flash"]);
      assert.equal(result1.downgraded, false);
      assert.match(String((result1.result as Record<string, unknown>).final_text ?? ""), new RegExp(WB_MARKER));

      const record1 = loadJob(root, jobId)!;
      assert.equal(record1.generation, 1);
      assert.equal(record1.sessionId, sessionId, "generation 1 must resume the exact WorkBuddy session");
      assert.equal(record1.attempts.length, 2);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.model), [WB_MODEL, WB_MODEL]);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.effort), [WB_EFFORT, WB_EFFORT]);
      assert.deepEqual(record1.attempts.map((attempt) => attempt.rateLimited), [false, false]);
      assert.equal(record1.attempts[1]!.resumedFrom, sessionId);
      assert.ok(record1.usage.tokensIn != null && record1.usage.tokensIn >= record0.usage.tokensIn!);
      assert.ok(record1.usage.tokensOut != null && record1.usage.tokensOut >= record0.usage.tokensOut!);

      await waitBodies(listener, 3);
      assert.equal(listener.bodies.filter((body) => body.event === "approval_required").length, 1);
      assert.equal(
        listener.bodies.filter((body) => body.status === "done" && body.job_id === jobId).length,
        2,
        "one terminal wake per WorkBuddy generation"
      );

      await client.close();
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const reread = McpStdioClient.json(await client.callTool("crewdispatch_result", { id: jobId }));
      assert.equal(reread.status, "done");
      assert.equal(Number(reread.generation), 1);
      assert.equal(reread.model, WB_MODEL);
      assert.match(String((reread.result as Record<string, unknown>).final_text ?? ""), new RegExp(WB_MARKER));

      console.log(JSON.stringify({
        kind: "macos-workbuddy-exact-artifact-v1",
        runtime_source: runtime.runtimeSource,
        installed_target: runtime.installedTarget,
        cli: fresh0.cliPath,
        cli_version: fresh0.cliVersion,
        catalog_source: fresh0.catalogSource,
        catalog_count: fresh0.catalogCount,
        free_model: WB_MODEL,
        free_meta: fresh0.modelMeta,
        effort: WB_EFFORT,
        permission_mode: "default",
        job_id: jobId,
        session_reused: true,
        generations: 2,
        approval_events: listener.bodies.filter((body) => body.event === "approval_required").length,
        terminal_wakes: listener.bodies.filter((body) => body.status === "done" && body.job_id === jobId).length,
        usage: record1.usage,
        attempts: record1.attempts.map((attempt) => ({
          generation: attempt.generation,
          model: attempt.model,
          effort: attempt.effort,
          rateLimited: attempt.rateLimited,
          exitCode: attempt.exitCode
        }))
      }, null, 2));
    } finally {
      await client?.close().catch(() => undefined);
      await shutdownJobDaemon(root, env).catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await listener?.close().catch(() => undefined);
      try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Disposable acceptance tree. Cleanup failure does not rewrite the verdict.
      }
    }
  }
);
test(
  "MAC-23 native macOS real Command Code: pending approval survives caller reopen, cancel stops only owned work, and terminal wake is not duplicated",
  { timeout: 1200000 },
  async () => {
    assert.equal(process.platform, "darwin", "MAC-23 is a native macOS acceptance");
    assert.equal(process.arch, "arm64", "MAC-23 authenticated real-host receipt is arm64-only; Intel provider real-host coverage is unverified");
    assert.equal(process.env.JOBQUAY_ACCEPT_MACOS_COMMAND_CODE_REAL, "1", "set JOBQUAY_ACCEPT_MACOS_COMMAND_CODE_REAL=1 to authorize the real FREE-model run");

    const resolved = resolveCommandCodeCli({ env: process.env });
    assert.equal(resolved.ok, true, `official Command Code CLI unavailable (${resolved.source})`);
    assert.ok(resolved.path);
    const cliPath = path.resolve(resolved.path!);
    const caps = await probeCapabilities({ cliPath, env: process.env, cwd: process.cwd() });
    assert.equal(caps.ok, true, caps.errors.join("; "));
    const catalog = await readModelCatalog({ cliPath, env: process.env, cwd: process.cwd() });
    assert.equal(catalog.ok, true, catalog.error ?? "catalog probe failed");
    assert.ok(catalog.raw);
    const free = freeRow(catalog.raw!, MODEL);
    assert.ok(free, `${MODEL} is not currently published as standalone FREE; refusing the real cancel prompt`);

    const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-mac23-real-cancel-"));
    const root = path.join(temp, "root");
    const project = path.join(temp, "workspace");
    const fileName = "mac23-cancel-probe.txt";
    fs.mkdirSync(path.join(project, ".commandcode"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".commandcode", "settings.json"),
      `${JSON.stringify({
        model: MODEL,
        featureModels: {
          titleGeneration: MODEL,
          compaction: MODEL,
          toolDescription: MODEL,
          tasteOnboarding: MODEL,
          tasteLearning: MODEL,
          branchSummarization: MODEL
        },
        tasteLearning: false
      }, null, 2)}\n`,
      "utf8"
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JOBQUAY_DATA_ROOT: root,
      JOBQUAY_COMMAND_CODE_CLI_PATH: cliPath,
      CREWDISPATCH_DISPATCH_DASHBOARD: "0"
    };
    delete env.CODEX_THREAD_ID;
    delete env.JOBQUAY_TEST_FIXTURE;
    delete env.JOBQUAY_CLI_PATH;
    delete env.JOBQUAY_COMMAND_CODE_CLI_COMMAND;

    let listener: Listener | null = null;
    let runtime: AcceptanceRuntime | null = null;
    let sentinel: ReturnType<typeof spawn> | null = null;
    let client: McpStdioClient | null = null;
    let jobId = "";
    let childPid = 0;
    let requestId = "";
    try {
      listener = await startListener();
      runtime = await prepareAcceptanceRuntime(temp, root, env);
      sentinel = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        windowsHide: true
      });
      assert.ok(sentinel.pid && sentinel.pid > 0);
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const task =
        `Create ${fileName} in the current workspace with exactly MAC23-SHOULD-NOT-EXIST followed by one newline. ` +
        "Use a file-writing/editing tool, not shell, Python, Node, or another command runner. " +
        "After the file is written, reply with exactly MAC23-WRITE-DONE.";
      const spawnedJob = McpStdioClient.json(
        await client.callTool("crewdispatch_spawn", {
          provider: "command-code",
          model: MODEL,
          effort: EFFORT,
          permission_mode: "standard",
          task,
          cwd: project,
          callback_url: listener.url
        })
      );
      assert.equal(spawnedJob.accepted, true, JSON.stringify(spawnedJob));
      jobId = String(spawnedJob.job_id);

      const waiting = await waitJob(root, jobId, (job) => job.generation === 0 && job.pendingApproval != null, 180000);
      assert.equal(waiting.status, "running");
      assert.equal(waiting.model, MODEL);
      assert.equal(waiting.permissionMode, "standard");
      assert.ok(waiting.childPid && waiting.childPid > 0, "the real official CLI root is persisted");
      childPid = waiting.childPid!;
      requestId = waiting.pendingApproval!.requestId;
      assert.equal(fs.existsSync(path.join(project, fileName)), false, "the gated write must not happen before approval");
      assert.equal(isPidAlive(childPid), true, "the owned official CLI is alive while approval is pending");
      assert.equal(isPidAlive(sentinel.pid!), true, "the unrelated sentinel starts alive");

      await waitBodies(listener, 1);
      assert.equal(listener.bodies.filter((body) => body.event === "approval_required" && body.job_id === jobId).length, 1, "one approval wake before caller close");

      // Simulate the originating MCP client disappearing while the provider is
      // paused. The durable worker/daemon and workspace reservation must survive.
      await client.close();
      client = null;
      const stillWaiting = loadJob(root, jobId)!;
      assert.equal(stillWaiting.status, "running");
      assert.equal(stillWaiting.pendingApproval?.requestId, requestId);
      assert.equal(isPidAlive(childPid), true, "closing the MCP client never cancels accepted work");

      // A fresh client sees the SAME job and the same workspace reservation.
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const status = McpStdioClient.json(await client.callTool("crewdispatch_status", { id: jobId }));
      assert.equal((status.job as Record<string, unknown>).status, "running");
      const busy = await client.callTool("crewdispatch_spawn", {
        provider: "command-code",
        model: MODEL,
        effort: EFFORT,
        task: "This must never start because the workspace is occupied.",
        cwd: project
      });
      assert.equal(busy.isError, true);
      assert.equal(McpStdioClient.json(busy).code, "workspace_busy");

      const cancelled = McpStdioClient.json(
        await client.callTool("crewdispatch_cancel", { id: jobId, wait_seconds: 8 }, 20_000)
      );
      assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
      assert.equal(cancelled.cancelled, true);
      const kill = cancelled.kill as Record<string, unknown>;
      assert.equal(kill.confirmed, true, `owned Darwin execution must be confirmed stopped: ${JSON.stringify(kill)}`);

      const settled = await waitJob(root, jobId, (job) => TERMINAL.has(job.status), 30000);
      assert.equal(settled.status, "cancelled");
      assert.equal(settled.pendingApproval, null, "cancel clears the durable pending request");
      assert.equal(fs.existsSync(approvalRequestPath(root, jobId, 0, requestId)), false, "cancel removes the pending approval sidecar");
      assert.equal(fs.existsSync(path.join(project, fileName)), false, "cancelled approval never performs the file effect");

      const goneDeadline = Date.now() + 10000;
      while (isPidAlive(childPid) && Date.now() < goneDeadline) await sleep(100);
      assert.equal(isPidAlive(childPid), false, "the owned official CLI process is gone after cancel");
      assert.equal(isPidAlive(sentinel.pid!), true, "an unrelated process survives the targeted cancel");

      await waitBodies(listener, 2);
      await sleep(500);
      assert.equal(listener.bodies.filter((body) => body.event === "approval_required" && body.job_id === jobId).length, 1);
      assert.equal(listener.bodies.filter((body) => body.status === "cancelled" && body.job_id === jobId).length, 1, "exactly one terminal cancel wake");
      assert.equal(listener.bodies.length, 2, "no duplicate approval or terminal wake");

      // Repeated cancel after reopen is idempotent and cannot create another wake.
      await client.close();
      client = new McpStdioClient(runtime.mcpEntry, env, temp);
      await client.initialize();
      const repeated = McpStdioClient.json(await client.callTool("crewdispatch_cancel", { id: jobId, wait_seconds: 1 }));
      assert.equal(repeated.status, "cancelled");
      await sleep(500);
      assert.equal(listener.bodies.length, 2, "reopen + repeated cancel emits no duplicate notification");

      const result = McpStdioClient.json(await client.callTool("crewdispatch_result", { id: jobId }));
      assert.equal(result.status, "cancelled");
      assert.equal(result.generation, 0);
      assert.equal(result.model, MODEL);

      console.log(JSON.stringify({
        kind: "macos-command-code-real-cancel-v1",
        runtime_source: runtime.runtimeSource,
        installed_target: runtime.installedTarget,
        cli: cliPath,
        version: caps.version,
        free_model: MODEL,
        free_row: free,
        effort: EFFORT,
        job_id: jobId,
        request_id: requestId,
        client_reopened: true,
        workspace_busy_while_pending: true,
        owned_child_stopped: true,
        unrelated_sentinel_survived: true,
        approval_wakes: listener.bodies.filter((body) => body.event === "approval_required" && body.job_id === jobId).length,
        terminal_wakes: listener.bodies.filter((body) => body.status === "cancelled" && body.job_id === jobId).length
      }, null, 2));
    } finally {
      await client?.close().catch(() => undefined);
      await shutdownJobDaemon(root, env).catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      await listener?.close().catch(() => undefined);
      if (sentinel?.pid && isPidAlive(sentinel.pid)) {
        try { process.kill(sentinel.pid, "SIGKILL"); } catch { /* best effort */ }
      }
      try {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Disposable acceptance tree. Cleanup failure does not rewrite evidence.
      }
    }
  }
);
