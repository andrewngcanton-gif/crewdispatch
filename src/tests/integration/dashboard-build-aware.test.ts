// dashboard-build-aware.test.ts — regression for the "rebuilt CrewDispatch silently
// reused the older Hub process" defect.
//
// Root cause being pinned: `/api/ping` only published `service` + package
// version, and the package version is still 0.0.0-m1 across rebuilds, so
// `ensureHub` had no way to tell a freshly rebuilt Hub from an older process
// still holding the port. Because one Hub process snapshots one client.js/API
// revision for its whole life, the user kept seeing the old UI/API after a
// rebuild while `jobquay web` printed "Hub already running; reusing it.".
//
// Evidence layers:
//   * A (in-process, real HTTP): the Hub snapshots its build id when it starts
//     and NEVER recomputes it from the mutable build output, while a later Hub
//     from the same root reports the new build;
//   * B (real processes, staged build tree): `jobquay web` starts a Hub from
//     build A, the tree is rebuilt, the ensure path RESTARTS the Hub and the
//     newly opened Dashboard serves the new client revision.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle } from "../../hub/server";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const REPO_DIST = path.join(REPO_ROOT, "dist");
const REPO_NODE_MODULES = path.join(REPO_ROOT, "node_modules");

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Use Node's plain HTTP client rather than global fetch/undici. macOS 26 runners
 * have intermittently rejected undici's socket Type-of-Service call with EINVAL;
 * that is unrelated to the Hub build-restart contract this test exercises.
 */
function httpTextOnce(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP request timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
  });
}

async function httpTextWithRetry(url: string, timeoutMs = 8000): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await httpTextOnce(url, 3000);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await httpTextWithRetry(url);
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}
async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDown(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await httpTextOnce(`http://127.0.0.1:${port}/api/ping`, 300);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Stage a disposable build tree: the real build output plus the package
 * metadata, so the staged CLI and the staged Hub compute the same build id from
 * their own root.
 */
function stageTree(dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(REPO_DIST, path.join(dest, "dist"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dest, "package.json"));
}

function runCli(tree: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; json: Record<string, unknown>; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(tree, "dist", "cli", "jobquay-cli.js"), ...args], {
    cwd: tree,
    env: { ...env, NODE_PATH: REPO_NODE_MODULES },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
  assert.ifError(result.error);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    /* the caller asserts on status/stderr for non-JSON failures */
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

// ---------------------------------------------------------------------------
// A — the Hub build id is a startup snapshot, never a re-read of dist
// ---------------------------------------------------------------------------

test("a live Hub snapshots its build id at startup and never recomputes it after a rebuild", { timeout: 60000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-build-aware-snapshot-"));
  const appRoot = path.join(workspace, "app");
  const clientAsset = path.join(appRoot, "dist", "ui", "client.js");
  fs.mkdirSync(path.dirname(clientAsset), { recursive: true });
  fs.writeFileSync(clientAsset, "// jobquay client build A\n", "utf8");
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "jobquay", version: "0.0.0-m1" }), "utf8");

  let first: HubHandle | null = null;
  let second: HubHandle | null = null;
  const stop = async (hub: HubHandle | null): Promise<void> => {
    if (!hub) return;
    hub.server.closeAllConnections?.();
    await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
  };
  try {
    first = startHub({ root: path.join(workspace, "root-a"), host: "127.0.0.1", port: 0, identityRoot: appRoot, clientAssetPath: clientAsset, env: { JOBQUAY_DATA_ROOT: path.join(workspace, "root-a") } });
    await new Promise<void>((resolve, reject) => {
      first!.server.once("listening", () => resolve());
      first!.server.once("error", reject);
    });
    const urlA = `http://127.0.0.1:${first.port}`;
    const pingA = await getJson(`${urlA}/api/ping`);
    assert.equal(pingA.status, 200);
    assert.equal(pingA.body.service, "jobquay");
    assert.equal(pingA.body.version, "0.0.0-m1");
    assert.equal(typeof pingA.body.build_id, "string");
    const buildA = pingA.body.build_id as string;

    // The build output changes on disk while this process stays alive...
    fs.writeFileSync(clientAsset, "// jobquay client build B (rebuilt)\n", "utf8");
    // ...and the live Hub keeps reporting the build it actually loaded.
    for (let i = 0; i < 3; i += 1) {
      const again = await getJson(`${urlA}/api/ping`);
      assert.equal(again.body.build_id, buildA, `ping #${i + 1} after the rebuild still reports build A`);
    }

    // A Hub started from the same root now reports the NEW build...
    second = startHub({ root: path.join(workspace, "root-b"), host: "127.0.0.1", port: 0, identityRoot: appRoot, clientAssetPath: clientAsset, env: { JOBQUAY_DATA_ROOT: path.join(workspace, "root-b") } });
    await new Promise<void>((resolve, reject) => {
      second!.server.once("listening", () => resolve());
      second!.server.once("error", reject);
    });
    const pingB = await getJson(`http://127.0.0.1:${second.port}/api/ping`);
    assert.notEqual(pingB.body.build_id, buildA, "the rebuilt Hub must publish a different build id");
    assert.equal(pingB.body.version, pingA.body.version, "the package version is unchanged by a development rebuild");

    // ...while the old process still reports its own build (no cross-process leakage).
    assert.equal((await getJson(`${urlA}/api/ping`)).body.build_id, buildA);
  } finally {
    await stop(second);
    await stop(first);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — a rebuilt tree is never silently reused (the reported defect)
// ---------------------------------------------------------------------------

test("a rebuilt tree restarts the Hub and the new Dashboard serves the new client revision", { timeout: 120000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-build-aware-rebuild-"));
  const tree = path.join(workspace, "app");
  const dataRoot = path.join(workspace, "data");
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: dataRoot, NODE_PATH: REPO_NODE_MODULES };
  const pids: number[] = [];
  try {
    stageTree(tree);

    // ---- the first `jobquay web` starts the Hub from the staged build -------
    const first = runCli(tree, ["web", "--no-open", "--port", String(port), "--json"], env);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.action, "started");
    assert.equal(first.json.started, true);
    assert.equal(first.json.restarted, false);
    assert.equal(typeof first.json.build_id, "string");
    const buildA = first.json.build_id as string;
    const pidA = Number(first.json.hub_pid);
    assert.ok(Number.isInteger(pidA) && pidA > 0);
    pids.push(pidA);

    const pingA = await getJson(`http://127.0.0.1:${port}/api/ping`);
    assert.equal(pingA.body.build_id, buildA, "the running Hub reports the build it started from");

    // ---- the build changes (a rebuild while the old Hub is still running) ---
    const clientAsset = path.join(tree, "dist", "ui", "client.js");
    fs.appendFileSync(clientAsset, "\n// jobquay client rebuilt: revision B\n", "utf8");
    const oldClient = (await httpTextWithRetry(`http://127.0.0.1:${port}/ui/client.js`)).body;
    assert.equal(oldClient.includes("revision B"), false, "the live Hub still serves the pre-rebuild client");

    // ---- `jobquay web` must NOT report a reuse for the older build ----------
    const second = runCli(tree, ["web", "--no-open", "--port", String(port), "--json"], env);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(second.json.ok, true);
    assert.equal(second.json.action, "restarted", "a Hub running an older build must be restarted, never silently reused");
    assert.equal(second.json.restarted, true);
    assert.equal(second.json.started, true);
    assert.notEqual(second.json.build_id, buildA, "the replacement serves the rebuilt revision");
    const buildB = second.json.build_id as string;
    const pidB = Number(second.json.hub_pid);
    assert.ok(Number.isInteger(pidB) && pidB > 0);
    assert.notEqual(pidB, pidA, "the older Hub process was replaced by a new one");
    pids.push(pidB);

    // The old process is really gone and exactly one Hub serves the port.
    await waitFor(() => !isAlive(pidA), 10000, "the replaced Hub process to exit");
    assert.equal(isAlive(pidB), true);

    const pingB = await getJson(`http://127.0.0.1:${port}/api/ping`);
    assert.equal(pingB.body.build_id, buildB);

    // The newly opened Dashboard serves the CURRENT client/API revision.
    const newClient = (await httpTextWithRetry(`http://127.0.0.1:${port}/ui/client.js`)).body;
    assert.match(newClient, /revision B/, "the replacement Hub serves the rebuilt client bundle");

    // ---- an unchanged build is reused again, with no duplicate ---------------
    const third = runCli(tree, ["web", "--no-open", "--port", String(port), "--json"], env);
    assert.equal(third.status, 0, third.stderr || third.stdout);
    assert.equal(third.json.action, "reused");
    assert.equal(third.json.started, false);
    assert.equal(third.json.hub_pid, null);
    assert.equal(third.json.build_id, buildB);
  } finally {
    for (const pid of pids) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    await waitDown(port);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
