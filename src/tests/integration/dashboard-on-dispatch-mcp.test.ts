// dashboard-on-dispatch-mcp.test.ts — REAL boundary coverage for the
// on-demand Dashboard startup from ordinary dispatch.
//
// Every layer is real: the BUILT MCP server (`dist/mcp/server.js`) as
// a separate stdio process, the real daemon client, the real daemon
// broker (created outside the caller's Job Object on Windows), the
// REAL Hub child process and REAL HTTP identity on an explicitly
// disposable port + data root. Only the provider PROCESS is a
// controlled fixture (the production path minus the provider binary).
//
// It proves:
//   * an initially-absent port -> first accepted task -> an OWNED Hub
//     serves /api/ping (jobquay identity, THIS data root) and /ui;
//   * a subsequent INDEPENDENT caller reuses the SAME Hub pid;
//   * closing the submitting MCP server kills neither the Hub nor the
//     accepted worker;
//   * start AND same-task continuation go through the same path;
//   * the accepted job is unique and the terminal result persists;
//   * a foreign listener on the port survives UNCHANGED while the task
//     still completes, with a truthful refused diagnostic instead of a
//     false ready claim or a dispatch failure;
//   * a Hub of ANOTHER data root is conservatively refused: the B
//     dispatch is accepted and completes once, the A-owned Hub keeps
//     its pid/root/UI, and B's diagnostic records the truthful refusal;
//   * a rejected dispatch never spawns a Hub.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createCliIsolation } from "../../cli/run-isolation";
import { killProcessTree, isPidAlive } from "../../runtime/process";
import { probeHubEndpoint } from "../../dashboard/launcher";
import { dataRootId } from "../../hub/endpoint";
import { readDispatchDashboardRecord } from "../../daemon/dashboard-ensure";
import { shutdownJobDaemon } from "../../daemon/client";
import { DASHBOARD_FIRST_USE_HINT } from "../../onboarding/dashboard-hint";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const OPT_IN = "1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null | Promise<T | null>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The REAL Hub identity endpoint (null while absent/unreachable). */
async function hubPing(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The REAL Hub /ui page. */
async function hubUi(port: number): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(1000) });
  } catch {
    return null;
  }
}

/** A controlled provider stand-in: run_start, then success after a delay. */
function writeEchoFixture(dir: string, delayMs = 0): string {
  const fixture = path.join(dir, "dispatch-echo.cjs");
  fs.writeFileSync(
    fixture,
    [
      "const out = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  out({ type: "event", event: { type: "run_start", sessionId: "fx-dispatch-echo" } });',
      `  setTimeout(() => { out({ type: "result", subtype: "success", result: "FX_DISPATCH_DONE", session_id: "fx-dispatch-echo", stop_reason: "end_turn" }); process.exit(0); }, ${delayMs});`,
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

interface Workspace {
  dir: string;
  root: string;
  projects: string[];
  fixture: string;
  hubPort: number;
  env: NodeJS.ProcessEnv;
}

async function newWorkspace(name: string, fixtureDelayMs = 0, projectCount = 1): Promise<Workspace> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-dispatch-dashboard-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const projects: string[] = [];
  for (let i = 0; i < projectCount; i += 1) {
    const project = path.join(iso.root, `project-${i}`);
    fs.mkdirSync(project, { recursive: true });
    projects.push(project);
  }
  const fixture = writeEchoFixture(dir, fixtureDelayMs);
  const hubPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    HUB_PORT: String(hubPort),
    // The real-boundary coverage opts INTO the actual lifecycle the
    // fixture dispatch would otherwise skip (test isolation default).
    CREWDISPATCH_DISPATCH_DASHBOARD: OPT_IN
  };
  return { dir, root, projects, fixture, hubPort, env };
}

async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw e;
      await sleep(100);
    }
  }
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    if (TERMINAL.has(String(result.status))) return result;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

test("the first accepted dispatch quietly starts the REAL Hub; independent callers reuse it; the submitter's exit kills neither Hub nor worker", { timeout: 120000 }, async () => {
  const ws = await newWorkspace("lifecycle", 1500, 2);
  let hubPid = 0;
  const first = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const second = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    // The port is initially ABSENT: no Hub exists for this root.
    assert.equal((await probeHubEndpoint(ws.hubPort)).state, "unreachable");

    await first.initialize();
    const t0 = Date.now();
    const spawned = McpStdioClient.json(await first.callTool("crewdispatch_spawn", { task: "bring up the dashboard", cwd: ws.projects[0] }));
    const elapsed = Date.now() - t0;
    assert.equal(spawned.ok, true);
    assert.equal(spawned.accepted, true);
    const jobId = String(spawned.job_id);
    assert.match(jobId, /^job-/);
    // The one-time first-use hint is surfaced, worded for the new
    // behavior, and NO readiness is claimed (startup is only scheduled).
    assert.equal(spawned.dashboard_hint, DASHBOARD_FIRST_USE_HINT);
    assert.equal(String(spawned.dashboard_hint).includes("no browser is opened"), true);
    const spawnedText = JSON.stringify(spawned);
    assert.equal(spawnedText.includes("dashboard_ready"), false, "a scheduled startup must not claim readiness");
    assert.ok(elapsed < 8000, `dispatch acceptance stays bounded (${elapsed}ms)`);

    // The OWNED Hub comes up on the controlled port with the REAL identity.
    const ping = await waitFor(() => hubPing(ws.hubPort), 30000, "the dispatch to bring up the real Hub");
    assert.equal(ping.service, "jobquay");
    assert.equal(ping.ok, true);
    assert.equal(ping.root_id, dataRootId(ws.root), "the Hub serves THIS data root, not merely a listener");
    assert.ok(typeof ping.version === "string" && (ping.version as string).length > 0, "the Hub reports its version");
    assert.ok(typeof ping.build_id === "string" && (ping.build_id as string).length > 0, "the Hub reports its build");
    hubPid = Number(ping.pid);
    assert.ok(Number.isInteger(hubPid) && hubPid > 0);

    // The REAL Dashboard UI is served by that same process.
    const ui = await hubUi(ws.hubPort);
    assert.ok(ui, "the Hub serves /ui");
    assert.equal(ui!.status, 200);
    assert.match(ui!.headers.get("content-type") ?? "", /text\/html/);
    const uiText = await ui!.text();
    assert.ok(uiText.includes("<title>CrewDispatch · Local sessions</title>"), "the CrewDispatch Dashboard page is served");

    // The durable diagnostic records the owned Hub truthfully.
    const started = await waitFor(() => readDispatchDashboardRecord(ws.root), 15000, "the first dispatch diagnostic to be persisted");
    assert.ok(started, "the dispatch wrote the bounded diagnostic");
    assert.equal(started!.ok, true);
    assert.equal(started!.action, "started");
    assert.equal(started!.port, ws.hubPort);
    assert.equal(started!.hub_pid, hubPid);

    // A SECOND, INDEPENDENT caller process dispatches its own job:
    // the SAME Hub pid is reused (no second Hub, no restart).
    await second.initialize();
    const spawnedSecond = McpStdioClient.json(await second.callTool("crewdispatch_spawn", { task: "second independent task", cwd: ws.projects[1] }));
    assert.equal(spawnedSecond.ok, true);
    const jobIdTwo = String(spawnedSecond.job_id);
    assert.notEqual(jobIdTwo, jobId);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnedSecond, "dashboard_hint"), false, "the first-use hint is one-time per data root");
    await waitFor(() => (readDispatchDashboardRecord(ws.root)?.action === "reused" ? true : null), 15000, "the second dispatch to reuse the healthy Hub");
    const pingAgain = await waitFor(() => hubPing(ws.hubPort), 10000, "the Hub to answer for the second caller");
    assert.equal(Number(pingAgain.pid), hubPid, "the independent caller reuses the SAME Hub process");

    // Accepted-job uniqueness: two distinct accepted jobs, no duplicate.
    const list = McpStdioClient.json(await second.callTool("crewdispatch_status", {}));
    assert.equal(list.count, 2);

    // The SUBMITTING MCP server goes away; the Hub and the worker survive.
    first.kill();
    await sleep(300);
    const doneOne = await waitTerminal(second, jobId);
    assert.equal(doneOne.status, "done");
    assert.equal((doneOne.result as Record<string, unknown>).final_text, "FX_DISPATCH_DONE");
    const doneTwo = await waitTerminal(second, jobIdTwo);
    assert.equal(doneTwo.status, "done");
    assert.equal(isPidAlive(hubPid), true, "the Hub survives the submitting caller");
    const pingAfter = await hubPing(ws.hubPort);
    assert.equal(Number(pingAfter!.pid), hubPid, "the Hub is still the SAME process after the submitter died");

    // Same-task continuation goes through the same common path and
    // reuses the same healthy Hub.
    const followed = McpStdioClient.json(await second.callTool("crewdispatch_follow_up", { id: jobId, message: "precise repair packet" }));
    assert.equal(followed.ok, true);
    assert.equal(followed.job_id, jobId);
    assert.equal(followed.generation, 1);
    const doneFollowed = await waitTerminal(second, jobId);
    assert.equal(doneFollowed.status, "done");
    assert.equal(doneFollowed.generation, 1);
    const pingFollowed = await hubPing(ws.hubPort);
    assert.equal(Number(pingFollowed!.pid), hubPid, "continuation reuses the healthy Hub");

    // The terminal result is durably persisted.
    const persisted = JSON.parse(fs.readFileSync(path.join(ws.root, "jobs", `${jobId}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.status, "done");
    assert.equal(persisted.generation, 1);
  } finally {
    await second.close().catch(() => undefined);
    await first.close().catch(() => undefined);
    await shutdownJobDaemon(ws.root, ws.env).catch(() => undefined);
    if (hubPid > 0 && isPidAlive(hubPid) === true) {
      await killProcessTree(hubPid, { graceMs: 2000 }).catch(() => undefined);
    }
    await removeTree(ws.dir);
  }
});

test("a foreign listener on the Hub port survives unchanged while the task still completes; the failure is recorded, never a false ready or dispatch error", { timeout: 120000 }, async () => {
  const ws = await newWorkspace("foreign", 0, 1);
  const hits: string[] = [];
  const foreign = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "not-jobquay", pid: process.pid }));
  });
  let client: McpStdioClient | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(ws.hubPort, "127.0.0.1", () => resolve());
    });
    assert.equal((await probeHubEndpoint(ws.hubPort)).state, "foreign");

    client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client.initialize();
    const spawned = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "complete despite the port conflict", cwd: ws.projects[0] }));

    // The dispatch SUCCEEDS: the Hub conflict never fails an accepted job.
    assert.equal(spawned.ok, true);
    assert.equal(spawned.accepted, true);
    const jobId = String(spawned.job_id);
    assert.equal(JSON.stringify(spawned).includes("dashboard_ready"), false, "no readiness is claimed for a refused port");

    // The task still completes to its persisted terminal state.
    const done = await waitTerminal(client, jobId);
    assert.equal(done.status, "done");

    // The foreign listener survived UNCHANGED: it was probed, never
    // asked to stop, and still answers as itself.
    assert.ok(hits.some((h) => h.includes("/api/ping")), "the foreign listener was probed");
    assert.equal(hits.some((h) => h.includes("hub/shutdown")), false, "a foreign listener is NEVER asked to stop");
    const stillForeign = await probeHubEndpoint(ws.hubPort);
    assert.equal(stillForeign.state, "foreign");

    // The failure is retained as a bounded, truthful diagnostic.
    const record = await waitFor(
      () => (readDispatchDashboardRecord(ws.root)?.ok === false ? readDispatchDashboardRecord(ws.root) : null),
      15000,
      "the refused ensure to be recorded"
    );
    assert.equal(record.action, "refused");
    assert.equal(record.error?.code, "port_in_use");
    assert.equal(record.url, null);
    assert.equal(record.hub_pid, null);
    assert.ok((record.error?.message ?? "").length > 0);
    // No Hub was started on the port: it still answers as the foreign service.
    const ping = await hubPing(ws.hubPort);
    assert.equal(ping!.service, "not-jobquay");
  } finally {
    await client?.close().catch(() => undefined);
    await shutdownJobDaemon(ws.root, ws.env).catch(() => undefined);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    await removeTree(ws.dir);
  }
});

test("a Hub of ANOTHER data root is conservatively refused: the B dispatch is accepted and completes, the A-owned Hub stays untouched", { timeout: 120000 }, async () => {
  const ws = await newWorkspace("wrongroot", 0, 1);
  // A REAL, separately-owned Hub process serves data root A on the
  // controlled port — the exact shape of the proven wrong-root reuse.
  const hubEntry = path.join(__dirname, "..", "..", "hub", "server.js");
  const rootA = path.join(ws.dir, "root-a");
  const rootB = ws.root;
  fs.mkdirSync(rootA, { recursive: true });
  let hub: ChildProcess | null = null;
  let client: McpStdioClient | null = null;
  try {
    hub = spawn(process.execPath, [hubEntry, "--port", String(ws.hubPort), "--root", rootA], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...ws.env, CREWDISPATCH_DATA_ROOT: rootA }
    });
    hub.unref();
    const ownedPing = await waitFor(async () => {
      const ping = await hubPing(ws.hubPort);
      return ping && ping.service === "jobquay" ? ping : null;
    }, 20000, "the A-owned Hub to answer the identity endpoint");
    assert.equal(ownedPing.root_id, dataRootId(rootA), "the A-owned Hub proves data root A");
    const ownedPid = Number(ownedPing.pid);
    assert.ok(Number.isInteger(ownedPid) && ownedPid > 0, "the A-owned Hub reports a live pid");

    // Dispatch a fixture job for data root B through the REAL MCP
    // entry, with the Hub port pointing at A's Hub.
    client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client.initialize();
    const spawned = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "wrong root ownership guard", cwd: ws.projects[0] }));
    assert.equal(spawned.ok, true, "the dispatch must stay accepted despite the Hub conflict");
    assert.equal(spawned.accepted, true);
    assert.equal(JSON.stringify(spawned).includes("dashboard_ready"), false, "no readiness is claimed for another root's Hub");
    const jobId = String(spawned.job_id);

    // The job completes exactly once (the refusal never fails the task).
    const done = await waitTerminal(client, jobId);
    assert.equal(done.status, "done");
    assert.equal((done.result as Record<string, unknown>).final_text, "FX_DISPATCH_DONE");

    // The A-owned Hub is UNCHANGED: same pid, same root identity,
    // UI still served — it was never asked to exit and never replaced.
    const pingAfter = await waitFor(() => hubPing(ws.hubPort), 15000, "the A-owned Hub to keep answering");
    assert.equal(Number(pingAfter!.pid), ownedPid, "the other root's Hub must survive with the same pid");
    assert.equal(pingAfter!.root_id, dataRootId(rootA), "the other root's Hub still proves its own root");
    assert.equal(isPidAlive(ownedPid), true);
    const ui = await hubUi(ws.hubPort);
    assert.equal(ui!.status, 200, "the other root's Hub still serves the Dashboard UI");
    assert.match(await ui!.text(), /CrewDispatch/);

    // B's diagnostic records the truthful refusal (never a false
    // ready/reused claim): wrong-root mismatch with both identities.
    const record = await waitFor(
      () => {
        const record = readDispatchDashboardRecord(rootB);
        return record && record.ok === false && record.action === "refused" ? record : null;
      },
      15000,
      "the wrong-root refusal to be recorded"
    );
    assert.equal(record.error?.code, "hub_root_mismatch");
    assert.match(record.error?.message ?? "", new RegExp(dataRootId(rootA)));
    assert.match(record.error?.message ?? "", new RegExp(dataRootId(rootB)));
    assert.equal(record.url, null);
    assert.equal(record.ping_url, null);
    assert.equal(record.hub_pid, null);
  } finally {
    await client?.close().catch(() => undefined);
    await shutdownJobDaemon(rootB, ws.env).catch(() => undefined);
    if (hub !== null) {
      if (hub.pid != null && isPidAlive(hub.pid) === true) {
        await killProcessTree(hub.pid, { graceMs: 2000 }).catch(() => undefined);
      }
      hub.kill();
    }
    await removeTree(ws.dir);
  }
});

test("a rejected dispatch never spawns a Hub", { timeout: 60000 }, async () => {
  const ws = await newWorkspace("rejected", 0, 1);
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const missing = path.join(ws.dir, "does-not-exist");
    const rejected = McpStdioClient.json(await client.callTool("crewdispatch_spawn", { task: "x", cwd: missing }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "invalid_cwd");

    // No Hub appears on the controlled port: a rejected dispatch
    // never brings one up.
    await sleep(1500);
    assert.equal((await probeHubEndpoint(ws.hubPort)).state, "unreachable");
    assert.equal(readDispatchDashboardRecord(ws.root), null, "a rejected dispatch records nothing");
    const list = McpStdioClient.json(await client.callTool("crewdispatch_status", {}));
    assert.equal(list.count, 0, "no job was created by the rejected call");
  } finally {
    await client.close().catch(() => undefined);
    await shutdownJobDaemon(ws.root, ws.env).catch(() => undefined);
    await removeTree(ws.dir);
  }
});
