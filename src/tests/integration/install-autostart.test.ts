// install-autostart.test.ts — REAL Windows acceptance for the Dashboard
// autostart (T6), using only disposable temp roots.
//
// What this proves end to end:
//   * a fresh internal install registers the user-scoped login autostart for
//     THAT installation, through the TEST-ONLY emulated registry (the
//     operator's real HKCU Run key is never touched by automated tests);
//   * invoking the EXACT registered command, in the same hidden/background
//     mode Windows uses at login, cold-starts the installed artifact's Hub on
//     an isolated port and leaves it running detached;
//   * a second invocation reuses the healthy Hub (no duplicate listener);
//   * an unrelated server on the configured port is refused cleanly and stays
//     alive — no kill, no silent port change, no spawn loop;
//   * upgrade refreshes the registration to the current artifact, and the
//     `jobquay autostart status|disable|enable` surface is honest;
//   * uninstall removes only the CrewDispatch-owned entry and leaves user data
//     untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseAutostartCommand } from "../../install/autostart-windows";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE_INSTALLER = path.join(REPO_ROOT, "dist", "cli", "install-cli.js");
const AUTOSTART_VALUE = "JobQuayDashboard";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function runNode(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 600000): CliResult {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.trim(), `no JSON output (stderr=${result.stderr.slice(-2000)})`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    assert.fail(`output was not machine-readable JSON: ${String((error as Error).message)}; stdout=${result.stdout.slice(0, 1000)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function readRegistry(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { values?: Record<string, string> };
  return parsed.values ?? {};
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

async function waitForJobQuay(port: number, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) });
      const body = (await response.json()) as Record<string, unknown>;
      if (body.ok === true && body.service === "jobquay") return body;
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) throw new Error(`CrewDispatch Hub did not become reachable on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function waitDown(port: number): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Distinct PIDs LISTENING on 127.0.0.1:<port> according to netstat. */
function listeningPids(port: number): number[] {
  const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.ifError(result.error);
  const pids = new Set<number>();
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    if (!new RegExp(`127\\.0\\.0\\.1:${port}\\s`).test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[columns.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function readLastRun(dataRoot: string): Record<string, unknown> {
  const file = path.join(dataRoot, "autostart", "last-run.json");
  assert.equal(fs.existsSync(file), true, `the headless autostart must record a diagnostic at ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Invoke the registered command exactly as the Run value stores it. The
 * invocation is asynchronous on purpose: a synchronous child would block this
 * test process's event loop and starve the in-process foreign server used by
 * the refusal acceptance below.
 */
function invokeRegistered(command: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const parsed = parseAutostartCommand(command);
  assert.ok(parsed.executable, "the registered command must have an executable");
  return new Promise((resolve, reject) => {
    const child = spawn(parsed.executable!, parsed.tokens.slice(1), {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ status: code, stdout, stderr }));
  });
}

test("the registered Windows autostart cold-starts one hidden Hub, refuses a foreign port, and follows install/upgrade/uninstall", { timeout: 900000, skip: process.platform !== "win32" }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-accept-"));
  const target = path.join(workspace, "installed-jobquay");
  const foreignCwd = path.join(workspace, "unrelated-cwd");
  const dataRoot = path.join(workspace, "data-root");
  const registryFile = path.join(workspace, "autostart-registry.json");
  const dataSentinel = path.join(dataRoot, "keep-data.txt");
  fs.mkdirSync(foreignCwd, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(dataSentinel, "user data must survive install/upgrade/uninstall\n", "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: registryFile
  };
  // Deterministic default port for the status/endpoint assertions.
  delete env.PORT;
  delete env.HUB_PORT;
  const installedCli = path.join(target, "dist", "cli", "jobquay-cli.js");
  let hubPid: number | null = null;
  let hubPort: number | null = null;

  try {
    // ---- fresh install registers the autostart for THIS installation --------
    const installed = runNode(SOURCE_INSTALLER, ["install", "--target", target], foreignCwd, env);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const installAutostart = installed.json.autostart as Record<string, unknown>;
    assert.equal(installAutostart.ok, true, JSON.stringify(installAutostart));
    assert.equal(installAutostart.registered, true);
    assert.equal(installAutostart.valueName, AUTOSTART_VALUE);
    const registered = readRegistry(registryFile);
    assert.deepEqual(Object.keys(registered), [AUTOSTART_VALUE], "exactly one CrewDispatch-owned Run value is created");
    const command = registered[AUTOSTART_VALUE]!;
    const parsed = parseAutostartCommand(command);
    assert.equal(path.basename(parsed.executable!).toLowerCase(), "wscript.exe", "the entry uses the GUI script host, never a console host");
    assert.ok(parsed.tokens.includes("//B"), "batch mode: no interactive prompts or script-error dialogs");
    assert.equal(path.dirname(path.dirname(parsed.shimPath!)), target);
    assert.equal(command.includes(REPO_ROOT), false, "the registration must not point at the developer checkout");
    assert.equal(fs.readFileSync(parsed.shimPath!, "utf8").includes(REPO_ROOT), false, "the shim must not reference the checkout");
    assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.vbs")), true);
    assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.json")), true);

    // ---- F: cold start from no listener on an isolated port -----------------
    hubPort = await freePort();
    const hubEnv: NodeJS.ProcessEnv = { ...env, HUB_PORT: String(hubPort) };
    const coldStart = await invokeRegistered(command, hubEnv);
    assert.equal(coldStart.status, 0, `cold start failed: ${coldStart.stderr || coldStart.stdout}`);
    const ping = await waitForJobQuay(hubPort);
    assert.equal(ping.service, "jobquay");
    const ui = await fetch(`http://127.0.0.1:${hubPort}/ui`, { signal: AbortSignal.timeout(5000) });
    const uiBody = await ui.text();
    assert.equal(ui.status, 200);
    assert.match(uiBody, /CrewDispatch/);
    const firstRun = readLastRun(dataRoot);
    assert.equal(firstRun.ok, true, JSON.stringify(firstRun));
    assert.equal(firstRun.action, "started");
    assert.equal(firstRun.port, hubPort);
    hubPid = Number(firstRun.hub_pid);
    assert.ok(Number.isInteger(hubPid) && hubPid > 0, "the diagnostic records the Hub pid");
    assert.equal(isProcessAlive(hubPid), true, "the Hub is detached and outlives the login launcher");

    // ---- H: process/window evidence ----------------------------------------
    assert.match(fs.readFileSync(parsed.shimPath!, "utf8"), /shell\.Run\(commandLine, 0, True\)/, "hidden window style");
    assert.deepEqual(listeningPids(hubPort), [hubPid], "exactly one process listens on the configured port");

    // ---- repeated trigger: reuse, never a duplicate -------------------------
    const second = await invokeRegistered(command, hubEnv);
    assert.equal(second.status, 0, `second trigger failed: ${second.stderr || second.stdout}`);
    const secondRun = readLastRun(dataRoot);
    assert.equal(secondRun.action, "reused", JSON.stringify(secondRun));
    assert.equal(secondRun.hub_pid, null, "a reused Hub reports no new pid");
    assert.deepEqual(listeningPids(hubPort), [hubPid], "still exactly one listener after the second trigger");
    assert.equal(isProcessAlive(hubPid), true);

    // The explicit headless form is the same lifecycle and never opens a browser.
    const cliHeadless = runNode(installedCli, ["autostart", "run", "--json"], foreignCwd, hubEnv, 60000);
    assert.equal(cliHeadless.status, 0, cliHeadless.stdout);
    assert.equal((cliHeadless.json.record as Record<string, unknown>).action, "reused");

    // ---- G: an unrelated listener is refused cleanly and stays alive --------
    const foreignPort = await freePort();
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "not-jobquay" }));
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once("error", reject);
      foreignServer.listen(foreignPort, "127.0.0.1", resolve);
    });
    try {
      const foreignPidsBefore = listeningPids(foreignPort);
      assert.equal(foreignPidsBefore.length, 1, "the unrelated server is the only listener before the attempt");
      const refused = await invokeRegistered(command, { ...env, HUB_PORT: String(foreignPort) });
      assert.notEqual(refused.status, 0, "a foreign port must fail closed");
      const refusedRun = readLastRun(dataRoot);
      assert.equal(refusedRun.ok, false);
      assert.equal(refusedRun.action, "refused");
      assert.equal(refusedRun.port, foreignPort, "the refusal is about the configured port, not a silent alternative");
      assert.equal((refusedRun.error as Record<string, unknown>).code, "port_in_use");
      const stillThere = await fetch(`http://127.0.0.1:${foreignPort}/`, { signal: AbortSignal.timeout(3000) });
      assert.equal(stillThere.status, 200, "the unrelated service is left running");
      assert.deepEqual(listeningPids(foreignPort), foreignPidsBefore, "the unrelated listener is untouched and nothing else was bound");
    } finally {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    }

    // ---- upgrade refreshes the registration to the current artifact ---------
    const upgraded = runNode(SOURCE_INSTALLER, ["upgrade", "--target", target], foreignCwd, env);
    assert.equal(upgraded.status, 0, upgraded.stdout);
    assert.equal((upgraded.json.autostart as Record<string, unknown>).ok, true);
    const afterUpgrade = readRegistry(registryFile);
    assert.equal(afterUpgrade[AUTOSTART_VALUE]!.toLowerCase(), command.toLowerCase(), "upgrade keeps the registration on the current artifact");
    assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.vbs")), true);

    // ---- status / disable / enable UX --------------------------------------
    const status = runNode(installedCli, ["autostart", "status", "--target", target, "--json"], foreignCwd, env, 60000);
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.json.status, "healthy");
    assert.equal(status.json.targetsThisInstall, true);
    assert.equal(status.json.registered, true);
    assert.equal(status.json.matchesExpectedCommand, true);
    assert.ok(status.json.lastRun, "status reports the last headless run");
    const endpoint = status.json.hubEndpoint as Record<string, unknown>;
    assert.equal(endpoint.port, 30080, "the deterministic default port is reported, never a random alternative");
    assert.equal(typeof endpoint.state, "string");

    const disabled = runNode(installedCli, ["autostart", "disable", "--json"], foreignCwd, env, 60000);
    assert.equal(disabled.status, 0, disabled.stdout);
    assert.equal(disabled.json.removed, true);
    assert.deepEqual(readRegistry(registryFile), {});
    const statusDisabled = runNode(installedCli, ["autostart", "status", "--target", target, "--json"], foreignCwd, env, 60000);
    assert.equal(statusDisabled.status, 0, statusDisabled.stdout);
    assert.equal(statusDisabled.json.status, "disabled");
    assert.match(String(statusDisabled.json.hint), /autostart enable --target/);

    const enabled = runNode(installedCli, ["autostart", "enable", "--target", target, "--json"], foreignCwd, env, 60000);
    assert.equal(enabled.status, 0, enabled.stdout);
    assert.equal(enabled.json.registered, true);
    assert.equal(readRegistry(registryFile)[AUTOSTART_VALUE]!.toLowerCase(), command.toLowerCase());

    // ---- uninstall removes only the CrewDispatch-owned entry ---------------------
    const installedInstaller = path.join(target, "dist", "cli", "install-cli.js");
    const removed = runNode(installedInstaller, ["uninstall", "--target", target], foreignCwd, env);
    assert.equal(removed.status, 0, removed.stdout);
    const uninstallAutostart = removed.json.autostart as Record<string, unknown>;
    assert.equal(uninstallAutostart.ok, true);
    assert.equal(uninstallAutostart.removed, true, "uninstall removes the CrewDispatch-owned autostart entry");
    assert.deepEqual(readRegistry(registryFile), {}, "no CrewDispatch login entry survives uninstall");
    assert.equal(fs.existsSync(path.join(target, "autostart")), false, "the shim is removed with the managed installation");
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "user data must survive install/upgrade/uninstall\n", "user data is untouched");
    assert.equal(fs.existsSync(dataRoot), true, "the separate data root is never removed by the installer");
    assert.equal(fs.existsSync(path.join(dataRoot, "autostart", "last-run.json")), true, "the headless diagnostic is user data and survives uninstall");
  } finally {
    if (hubPid) {
      try { process.kill(hubPid); } catch { /* already gone */ }
    }
    if (hubPort) await waitDown(hubPort);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
