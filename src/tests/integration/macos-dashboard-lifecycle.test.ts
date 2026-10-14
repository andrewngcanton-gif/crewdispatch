import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataRootId } from "../../hub/endpoint";
import { browserCommand } from "../../dashboard/launcher";

const CHECKOUT_CLI_ENTRY = path.join(__dirname, "..", "..", "cli", "crewdispatch-cli.js");
const ACCEPT_SOURCE_ROOT = process.env.JOBQUAY_ACCEPT_SOURCE_ROOT?.trim() || null;
if (ACCEPT_SOURCE_ROOT && !path.isAbsolute(ACCEPT_SOURCE_ROOT)) {
  throw new Error("JOBQUAY_ACCEPT_SOURCE_ROOT must be an absolute unpacked candidate root");
}
const SOURCE_ROOT = ACCEPT_SOURCE_ROOT ? fs.realpathSync.native(path.resolve(ACCEPT_SOURCE_ROOT)) : null;

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

function runCli(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[]
): { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> } {
  const run = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true
  });
  assert.ifError(run.error);
  const stdout = run.stdout || "";
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // Caller asserts status/output below.
  }
  return { status: run.status, stdout, stderr: run.stderr || "", json };
}

async function pingHub(port: number, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/ping",
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once("timeout", () => request.destroy(new Error("ping_timeout")));
    request.once("error", reject);
  });
}

async function waitDown(port: number): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      await pingHub(port, 250);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test(
  "native macOS Hub lifecycle reuses same root, refuses other root, and keeps regular regression browser-safe",
  { timeout: 60_000, skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
  async () => {
    const sandbox = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-macos-dashboard-"));
    const rootA = path.join(sandbox, "root-a");
    const rootB = path.join(sandbox, "root-b");
    const port = await freePort();
    const envA = { ...process.env, JOBQUAY_DATA_ROOT: rootA };
    const envB = { ...process.env, JOBQUAY_DATA_ROOT: rootB };
    let hubPid: number | null = null;
    let cliEntry = CHECKOUT_CLI_ENTRY;
    let installedTarget: string | null = null;
    let installedInstaller: string | null = null;
    const installEnv: NodeJS.ProcessEnv = {
      ...process.env,
      JOBQUAY_DATA_ROOT: path.join(sandbox, "installer-data"),
      JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(sandbox, "autostart-registry.json"),
      JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(sandbox, "LaunchAgents"),
      JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(sandbox, "launchctl-state.json")
    };
    if (SOURCE_ROOT) {
      const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
      assert.equal(pkg.version, "0.1.3");
      assert.equal(pkg.license, "Apache-2.0");
      const sourceInstaller = path.join(SOURCE_ROOT, "dist", "cli", "install-cli.js");
      installedTarget = path.join(sandbox, "installed-candidate");
      const installed = spawnSync(process.execPath, [sourceInstaller, "install", "--target", installedTarget], {
        cwd: sandbox,
        env: installEnv,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true
      });
      assert.ifError(installed.error);
      assert.equal(installed.status, 0, installed.stderr || installed.stdout);
      const installedJson = JSON.parse(installed.stdout) as Record<string, unknown>;
      assert.equal(installedJson.ok, true);
      assert.equal(installedJson.packageVersion, "0.1.3");
      cliEntry = path.join(installedTarget, "dist", "cli", "crewdispatch-cli.js");
      installedInstaller = path.join(installedTarget, "dist", "cli", "install-cli.js");
      assert.equal(fs.existsSync(cliEntry), true);
      assert.equal(cliEntry.startsWith(SOURCE_ROOT), false, "Dashboard CLI must run from the installed target, not the unpacked candidate");
    }

    try {
      const first = runCli(cliEntry, sandbox, envA, ["web", "--no-open", "--port", String(port), "--json"]);
      assert.equal(first.status, 0, first.stderr || first.stdout);
      assert.equal(first.json.action, "started");
      assert.equal(first.json.opened, false);
      hubPid = Number(first.json.hub_pid);
      assert.ok(Number.isInteger(hubPid) && hubPid > 0);
      assert.equal(first.json.url, `http://127.0.0.1:${port}/ui`);

      const ping = await pingHub(port, 3_000);
      assert.equal(ping.status, 200);
      assert.equal(ping.json.service, "jobquay");
      assert.equal(ping.json.root_id, dataRootId(rootA));
      assert.equal(ping.json.build_id, first.json.build_id);

      const ui = await fetch(`http://127.0.0.1:${port}/ui`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      assert.equal(ui.status, 200, "the installed Hub must serve the Dashboard UI");
      const html = await ui.text();
      assert.match(html, /<title>CrewDispatch · Local sessions<\/title>/);
      assert.match(html, /<h1>CrewDispatch<\/h1>/);

      const reuse = runCli(cliEntry, sandbox, envA, ["web", "--no-open", "--port", String(port), "--json"]);
      assert.equal(reuse.status, 0, reuse.stderr || reuse.stdout);
      assert.equal(reuse.json.action, "reused");
      assert.equal(reuse.json.started, false);
      assert.equal(reuse.json.hub_pid, null);
      assert.equal(reuse.json.opened, false);
      assert.equal(reuse.json.build_id, first.json.build_id);

      const wrongRoot = runCli(cliEntry, sandbox, envB, ["web", "--no-open", "--port", String(port), "--json"]);
      assert.equal(wrongRoot.status, 1, wrongRoot.stderr || wrongRoot.stdout);
      assert.equal(wrongRoot.json.ok, false);
      assert.equal(wrongRoot.json.code, "hub_root_mismatch");
      assert.equal(hubPid != null && process.kill(hubPid, 0), true, "wrong-root refusal never kills the existing Hub");

      const exactUiUrl = `http://127.0.0.1:${port}/ui`;
      assert.deepEqual(browserCommand("darwin", exactUiUrl, envA), {
        file: "/usr/bin/open",
        args: ["-g", exactUiUrl]
      });

      // A real browser-open was captured during MAC-15 acceptance. Do not keep
      // reopening disposable loopback URLs during every shared regression run:
      // the Hub is intentionally torn down in finally, which leaves a dead tab
      // in the operator's real browser. Re-run the visible acceptance only when
      // explicitly requested.
      if (process.env.JOBQUAY_ACCEPT_MACOS_BROWSER_OPEN === "1") {
        const opened = runCli(cliEntry, sandbox, envA, ["web", "--port", String(port), "--json"]);
        assert.equal(opened.status, 0, opened.stderr || opened.stdout);
        assert.equal(opened.json.action, "reused");
        assert.equal(opened.json.opened, true);
        assert.equal(opened.json.url, exactUiUrl);
        const browserPid = Number(opened.json.browser_pid);
        assert.ok(Number.isInteger(browserPid) && browserPid > 0, "real /usr/bin/open process was spawned");
      }
    } finally {
      if (hubPid) {
        try { process.kill(hubPid); } catch {}
        await waitDown(port);
      }
      if (installedTarget && installedInstaller && fs.existsSync(installedInstaller)) {
        const removed = spawnSync(process.execPath, [installedInstaller, "uninstall", "--target", installedTarget], {
          cwd: sandbox,
          env: installEnv,
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true
        });
        assert.ifError(removed.error);
        assert.equal(removed.status, 0, removed.stderr || removed.stdout);
        assert.equal((JSON.parse(removed.stdout) as Record<string, unknown>).ok, true);
      }
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
);
