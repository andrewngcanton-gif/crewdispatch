import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserNodeRuntime } from "../../install/node-runtime";
import { McpStdioClient } from "../helpers/mcp-client";
import { renderWindowsCommandWrapper } from "../../install/manager";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ACCEPT_SOURCE_ROOT = process.env.JOBQUAY_ACCEPT_SOURCE_ROOT?.trim();
if (ACCEPT_SOURCE_ROOT && !path.isAbsolute(ACCEPT_SOURCE_ROOT)) {
  throw new Error("JOBQUAY_ACCEPT_SOURCE_ROOT must be an absolute unpacked candidate root");
}
const SOURCE_ROOT = ACCEPT_SOURCE_ROOT ? fs.realpathSync.native(path.resolve(ACCEPT_SOURCE_ROOT)) : REPO_ROOT;
const SOURCE_INSTALLER = path.join(SOURCE_ROOT, "dist", "cli", "install-cli.js");

function canonicalTempRoot(): string {
  return fs.realpathSync.native(os.tmpdir());
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function cleanProbeEnv(dataRoot: string, tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "PATHEXT", "COMSPEC", "SystemRoot", "WINDIR", "SYSTEMDRIVE"]) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  env.HOME = tempRoot;
  env.USERPROFILE = tempRoot;
  env.LOCALAPPDATA = path.join(tempRoot, "localappdata");
  env.APPDATA = path.join(tempRoot, "appdata");
  env.TEMP = path.join(tempRoot, "tmp");
  env.TMP = env.TEMP;
  env.TMPDIR = env.TEMP;
  env.JOBQUAY_DATA_ROOT = dataRoot;
  for (const dir of [env.LOCALAPPDATA, env.APPDATA, env.TEMP]) fs.mkdirSync(dir!, { recursive: true });
  return env;
}

function runInstaller(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.trim(), `installer emitted no JSON (stderr=${result.stderr.slice(-2000)})`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (e) {
    assert.fail(`installer output was not machine-readable JSON: ${String((e as Error).message)}; stdout=${result.stdout.slice(0, 1000)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function installedWrapperPath(target: string, name: string): string {
  return path.join(target, "bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function runInstalledWrapper(wrapper: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return spawnSync(comspec, ["/d", "/s", "/v:off", "/c", `"\"${wrapper}\" \"--help\""`], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      windowsVerbatimArguments: true
    });
  }
  return spawnSync(wrapper, ["--help"], {
    cwd,
    env: { ...env, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
}


function writeCommandCodeShim(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const shimPath = path.join(directory, process.platform === "win32" ? "cmdc.cmd" : "cmdc");
  const body = process.platform === "win32"
    ? [
        "@echo off",
        'if "%~1"=="--version" (echo 1.2.3& exit /b 0)',
        'if "%~1"=="--help" (echo Usage: cmdc --list-models& exit /b 0)',
        'if "%~1"=="--list-models" (echo provider/free-model& exit /b 0)',
        "exit /b 3",
        ""
      ].join("\r\n")
    : [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi',
        'if [ "$1" = "--help" ]; then echo "Usage: cmdc --list-models"; exit 0; fi',
        'if [ "$1" = "--list-models" ]; then echo provider/free-model; exit 0; fi',
        "exit 3",
        ""
      ].join("\n");
  fs.writeFileSync(shimPath, body, "utf8");
  if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

async function terminate(child: ChildProcess): Promise<void> {
  try {
    child.kill();
  } catch {
    /* process already exited */
  }
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Read the emulated autostart registry used by the TEST-ONLY seam. */
function readAutostartRegistry(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { values?: Record<string, string> };
  return parsed.values ?? {};
}

function autostartCommandFor(installRoot: string): string {
  return `"${path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe")}" //B //NoLogo "${path.join(installRoot, "autostart", "jobquay-dashboard.vbs")}"`;
}

async function probeHub(target: string, tempRoot: string): Promise<{ ui: string; ping: Record<string, unknown>; port: number }> {
  const dataRoot = path.join(tempRoot, "hub-data");
  const env = cleanProbeEnv(dataRoot, tempRoot);
  env.HUB_PORT = "0";
  const entry = path.join(target, "dist", "hub", "server.js");
  const child = spawn(process.execPath, [entry], { cwd: tempRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 32 * 1024) stderr += chunk.toString("utf8").slice(0, 32 * 1024 - stderr.length);
  });
  try {
    const deadline = Date.now() + 10000;
    let port = 0;
    while (Date.now() < deadline) {
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (match) {
        port = Number(match[1]);
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Hub exited early (${child.exitCode ?? child.signalCode}): ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(port > 0, `Hub did not report a loopback port: ${stderr}`);
    const ui = await fetch(`http://127.0.0.1:${port}/ui`, { signal: AbortSignal.timeout(5000) });
    const uiBody = await ui.text();
    const ping = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(5000) });
    const pingBody = (await ping.json()) as Record<string, unknown>;
    assert.equal(ui.status, 200);
    assert.match(uiBody, /CrewDispatch/);
    assert.equal(ping.status, 200);
    assert.equal(pingBody.ok, true);
    return { ui: uiBody, ping: pingBody, port };
  } finally {
    await terminate(child);
  }
}

test("Windows command wrapper rendering pins final paths and escapes batch percent expansion", () => {
  const wrapper = renderWindowsCommandWrapper(
    "C:\\Program Files\\Crew%Dispatch",
    "C:\\Program Files\\node%20\\node.exe",
    "crewdispatch-cli.js"
  );
  assert.match(wrapper, /^@echo off\r?$/m);
  assert.match(wrapper, /Crew%%Dispatch/);
  assert.match(wrapper, /node%%20/);
  assert.match(wrapper, /dist\\cli\\crewdispatch-cli\.js/);
  assert.match(wrapper, / %\*\r?$/m);
  assert.equal(wrapper.includes("$@"), false);
});

test("real install CLI installs an independent package, diagnoses both servers, upgrades and removes only managed files", { timeout: 900000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(canonicalTempRoot(), "jobquay-install-cli-"));
  const target = path.join(workspace, process.platform === "win32" ? "installed-jobquay" : "installed jobquay with spaces");
  const foreignCwd = path.join(workspace, "unrelated-cwd");
  const dataRoot = path.join(workspace, "separate-data-root");
  const outsideSentinel = path.join(workspace, "outside-target.keep");
  const userConfigSentinel = path.join(workspace, "user-config.keep");
  const dataSentinel = path.join(dataRoot, "keep-data.txt");
  const userFile = path.join(target, "operator-notes.txt");
  const unmanagedTarget = path.join(workspace, "unmanaged-existing-directory");
  // The Dashboard autostart is registered through the TEST-ONLY emulated
  // registry so this acceptance never writes a real HKCU login entry.
  const autostartRegistry = path.join(workspace, "autostart-registry.json");
  const launchAgentDir = path.join(workspace, "LaunchAgents");
  const launchctlState = path.join(workspace, "launchctl-state.json");
  fs.mkdirSync(foreignCwd, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(outsideSentinel, "outside target\n", "utf8");
  fs.writeFileSync(userConfigSentinel, "user configuration remains untouched\n", "utf8");
  fs.writeFileSync(dataSentinel, "separate data root\n", "utf8");
  const callerHome = path.join(workspace, "caller-home");
  const codexHome = path.join(callerHome, ".codex");
  const claudeConfig = path.join(callerHome, ".claude");
  fs.mkdirSync(callerHome, { recursive: true });
  const installerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: callerHome,
    USERPROFILE: callerHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    JOBQUAY_DATA_ROOT: dataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: autostartRegistry,
    JOBQUAY_TEST_LAUNCHAGENT_DIR: launchAgentDir,
    JOBQUAY_TEST_LAUNCHCTL_STATE: launchctlState
  };
  const runtimeEnv = cleanProbeEnv(dataRoot, workspace);
  const doctorEnv: NodeJS.ProcessEnv = {
    ...installerEnv,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    JOBQUAY_COMMAND_CODE_CLI_PATH: writeCommandCodeShim(path.join(workspace, "command-code-shim")),
    OPENAI_API_KEY: "doctor-test-credential-must-not-be-forwarded"
  };

  try {
  // This attempt checks the string-only protected-path guard. The installer rejects
  // the legacy path before lstat, enumeration, or file access; its contents are never read.
  const oldSelfUsePath = path.join(callerHome, ".workbuddy", "plugins", "wb-crew");
  const oldPathAttempt = runInstaller(SOURCE_INSTALLER, ["install", "--target", oldSelfUsePath], foreignCwd, installerEnv);
  assert.notEqual(oldPathAttempt.status, 0);
  assert.equal(((oldPathAttempt.json.error as Record<string, unknown>)?.code), "protected_target");
  if (process.platform === "darwin") {
    for (const protectedTarget of [
      path.join(callerHome, ".claude", "crewdispatch-install"),
      path.join(callerHome, "Library", "Application Support", "Claude", "crewdispatch-install"),
      path.join(callerHome, "Library", "Application Support", "Claude-3p", "crewdispatch-install"),
      path.join(callerHome, "Library", "LaunchAgents", "crewdispatch-install"),
      path.join("/Applications", "CrewDispatch-internal-test"),
      path.join("/System", "CrewDispatch-internal-test")
    ]) {
      const protectedAttempt = runInstaller(SOURCE_INSTALLER, ["install", "--target", protectedTarget], foreignCwd, installerEnv);
      assert.notEqual(protectedAttempt.status, 0);
      assert.equal(
        ((protectedAttempt.json.error as Record<string, unknown>)?.code),
        "protected_target",
        `macOS protected target must fail before traversal: ${protectedTarget}`
      );
    }
  }
  const rootAttempt = runInstaller(SOURCE_INSTALLER, ["install", "--target", path.parse(target).root], foreignCwd, installerEnv);
  assert.notEqual(rootAttempt.status, 0);
  assert.equal(((rootAttempt.json.error as Record<string, unknown>)?.code), "dangerous_root");
  const sourceSelfUninstall = runInstaller(SOURCE_INSTALLER, ["uninstall", "--target", SOURCE_ROOT], foreignCwd, installerEnv);
  assert.notEqual(sourceSelfUninstall.status, 0);
  assert.equal(
    ((sourceSelfUninstall.json.error as Record<string, unknown>)?.code),
    ACCEPT_SOURCE_ROOT ? "not_managed" : "source_checkout_overlap",
    "a Git checkout refuses self-uninstall; an unpacked candidate is simply not a managed installation"
  );

  const linkTarget = path.join(workspace, "link-target");
  const linkDestination = path.join(workspace, "link-destination");
  fs.mkdirSync(linkDestination, { recursive: true });
  fs.symlinkSync(linkDestination, linkTarget, process.platform === "win32" ? "junction" : "dir");
  const linkAttempt = runInstaller(SOURCE_INSTALLER, ["install", "--target", linkTarget], foreignCwd, installerEnv);
  assert.notEqual(linkAttempt.status, 0);
  assert.equal(((linkAttempt.json.error as Record<string, unknown>)?.code), "symlink_target");
  assert.deepEqual(fs.readdirSync(linkDestination), []);

  fs.mkdirSync(unmanagedTarget, { recursive: true });
  const unmanagedSentinel = path.join(unmanagedTarget, "keep.txt");
  fs.writeFileSync(unmanagedSentinel, "not an owned installation\n", "utf8");
  const unmanagedUpgrade = runInstaller(SOURCE_INSTALLER, ["upgrade", "--target", unmanagedTarget], foreignCwd, installerEnv);
  assert.notEqual(unmanagedUpgrade.status, 0);
  assert.equal(((unmanagedUpgrade.json.error as Record<string, unknown>)?.code), "not_managed");
  assert.equal(fs.readFileSync(unmanagedSentinel, "utf8"), "not an owned installation\n");

    const installed = runInstaller(SOURCE_INSTALLER, ["install", "--target", target], foreignCwd, installerEnv);
    assert.equal(installed.status, 0, installed.stdout);
    assert.equal(installed.json.ok, true);
    const installId = String(installed.json.installId);
    assert.ok(installId);
    assert.ok(fs.existsSync(path.join(target, ".jobquay-install.json")));
    assert.ok(fs.existsSync(path.join(target, "dist", "cli", "install-cli.js")));
    assert.equal(fs.existsSync(path.join(target, "src")), false, "installed runtime must not depend on the checkout source tree");
    assert.equal(fs.existsSync(path.join(target, "dist", "tests")), false, "test sources must not be copied into the install");
    const callers = installed.json.callers as Record<string, Record<string, unknown>>;
    assert.ok(callers.codex, "standard install reports Codex caller integration");
    assert.ok(callers.claude, "standard install reports Claude caller integration");
    assert.equal(callers.claude.ok, true, JSON.stringify(callers.claude));
    assert.equal(fs.existsSync(path.join(codexHome, "prompts", "crewdispatch.md")), true, "standard install registers the Codex composer prompt");
    assert.equal(fs.existsSync(path.join(target, ".agents", "plugins", "marketplace.json")), true, "installed runtime carries the local Codex marketplace");
    assert.equal(fs.existsSync(path.join(claudeConfig, "commands", "crewdispatch.md")), true, "standard install registers the Claude command");
    assert.equal(fs.existsSync(path.join(claudeConfig, "skills", "crewdispatch", "SKILL.md")), true, "standard install registers the Claude skill");
    assert.equal(fs.existsSync(path.join(claudeConfig, "crewdispatch-install.json")), true, "standard install records Claude caller ownership");
    const claudeSettings = JSON.parse(fs.readFileSync(path.join(claudeConfig, "settings.json"), "utf8")) as { hooks?: { SessionStart?: unknown[]; SessionEnd?: unknown[] } };
    assert.ok(Array.isArray(claudeSettings.hooks?.SessionStart) && claudeSettings.hooks!.SessionStart!.length > 0, "standard install registers the Claude SessionStart hook");
    assert.ok(Array.isArray(claudeSettings.hooks?.SessionEnd) && claudeSettings.hooks!.SessionEnd!.length > 0, "standard install registers the Claude SessionEnd hook");
    const claudeUserConfig = JSON.parse(fs.readFileSync(path.join(claudeConfig, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
    assert.ok(claudeUserConfig.mcpServers?.crewdispatch, "standard install registers the Claude CrewDispatch MCP server");

    // The reviewed third-party notice bundle must ship verbatim, be tracked by the
    // install marker, and be reported by the install result instead of a TODO.
    const sourceLicense = fs.readFileSync(path.join(SOURCE_ROOT, "LICENSE"), "utf8");
    const sourceLicenseSha = crypto.createHash("sha256").update(sourceLicense, "utf8").digest("hex");
    const sourceNotice = fs.readFileSync(path.join(SOURCE_ROOT, "THIRD_PARTY_NOTICES"), "utf8");
    const sourceNoticeSha = crypto.createHash("sha256").update(sourceNotice, "utf8").digest("hex");
    const installedNoticePath = path.join(target, "THIRD_PARTY_NOTICES");
    assert.equal(fs.existsSync(installedNoticePath), true, "the install must carry THIRD_PARTY_NOTICES");
    const installedNotice = fs.readFileSync(installedNoticePath, "utf8");
    assert.equal(installedNotice, sourceNotice, "the shipped notice file must be the reviewed source file byte for byte");
    assert.match(installedNotice, /Copyright \(c\) 2026 WorkBuddy Crew contributors/);
    assert.match(installedNotice, /Copyright \(c\) 2026 ZSeven-W/);
    assert.match(installedNotice, /Permission is hereby granted, free of charge/);
    assert.match(installedNotice, /CrewDispatch's own source and build output are licensed under the Apache License/);
    assert.match(installedNotice, /WorkBuddy AI app \/ CLI/);
    assert.match(installedNotice, /Never copied, bundled,/);
    assert.match(installedNotice, /licensing transition from the MIT License to the\s+Apache License, Version 2\.0/);
    assert.match(installedNotice, /node_modules\/@modelcontextprotocol\/core\/LICENSE/);
    assert.match(installedNotice, /node_modules\/@modelcontextprotocol\/server\/LICENSE/);
    assert.match(installedNotice, /node_modules\/zod\/LICENSE/);
    const installMarkerData = JSON.parse(fs.readFileSync(path.join(target, ".jobquay-install.json"), "utf8")) as {
      managedFiles: { path: string; sha256: string; mode?: number }[];
    };
    assert.ok(
      installMarkerData.managedFiles.some((file) => file.path === ".agents/plugins/marketplace.json"),
      "the local Codex marketplace is installer-owned"
    );
    const noticeEntry = installMarkerData.managedFiles.find((file) => file.path === "THIRD_PARTY_NOTICES");
    assert.ok(noticeEntry, "the install marker must manage THIRD_PARTY_NOTICES");
    assert.equal(noticeEntry.sha256, sourceNoticeSha, "the marker must record the shipped notice hash");
    assert.deepEqual(installed.json.thirdPartyNotices, { path: "THIRD_PARTY_NOTICES", sha256: sourceNoticeSha });
    assert.deepEqual(installed.json.productLicense, { path: "LICENSE", sha256: sourceLicenseSha, spdx: "Apache-2.0" });
    assert.match(String(installed.json.licenseStatus), /Apache-2\.0/);
    assert.match(String(installed.json.licenseStatus), /private only to prevent accidental npm publication/);

    const packageMeta = JSON.parse(fs.readFileSync(path.join(target, "node_modules", "@modelcontextprotocol", "server", "package.json"), "utf8")) as { license?: string };
    assert.equal(packageMeta.license, "MIT", "upstream package metadata currently says MIT");
    const serverLicense = fs.readFileSync(path.join(target, "node_modules", "@modelcontextprotocol", "server", "LICENSE"), "utf8");
    const coreLicense = fs.readFileSync(path.join(target, "node_modules", "@modelcontextprotocol", "core", "LICENSE"), "utf8");
    assert.match(serverLicense, /licensing transition from the MIT License to the Apache License/i);
    assert.match(coreLicense, /licensing transition from the MIT License to the Apache License/i);
    assert.ok(fs.existsSync(path.join(target, "node_modules", "zod", "LICENSE")));
    const installedProductLicense = fs.readFileSync(path.join(target, "LICENSE"), "utf8");
    assert.equal(installedProductLicense, sourceLicense, "the product license is shipped byte-for-byte");
    assert.match(installedProductLicense, /Apache License/);
    assert.match(installedProductLicense, /Version 2\.0, January 2004/);
    assert.match(installedProductLicense, /END OF TERMS AND CONDITIONS/);
    const licenseEntry = installMarkerData.managedFiles.find((file) => file.path === "LICENSE");
    assert.ok(licenseEntry, "the install marker must manage the product LICENSE");
    assert.equal(licenseEntry.sha256, sourceLicenseSha);

    const installedPlugin = path.join(target, "plugins", "crewdispatch");
    assert.equal(fs.existsSync(path.join(target, "integrations", "codex", "prompts", "crewdispatch.md")), true, "installed runtime must carry the Codex prompt asset");
    assert.equal(fs.existsSync(path.join(target, "scripts", "install-codex-command.cjs")), true, "installed runtime must carry the Codex prompt installer");
    assert.equal(fs.existsSync(path.join(target, "scripts", "uninstall-codex-command.cjs")), true, "installed runtime must carry the Codex prompt uninstaller");
    const config = JSON.parse(fs.readFileSync(path.join(installedPlugin, ".mcp.json"), "utf8")) as {
      mcpServers: { crewdispatch: { command: string; args: string[] } };
    };
    const mcpEntry = config.mcpServers.crewdispatch.args[0]!;
    assert.equal(path.resolve(config.mcpServers.crewdispatch.command), path.resolve(resolveUserNodeRuntime()!.path));
    assert.equal(path.isAbsolute(mcpEntry), true);
    assert.equal(path.resolve(mcpEntry), path.join(target, "dist", "mcp", "server.js"));

    for (const name of ["crewdispatch", "jobquay"]) {
      const wrapper = installedWrapperPath(target, name);
      const markerPath = `bin/${process.platform === "win32" ? `${name}.cmd` : name}`;
      assert.equal(fs.existsSync(wrapper), true, `${name} managed wrapper is installed`);
      assert.equal(fs.lstatSync(wrapper).isSymbolicLink(), false);
      const markerEntry = installMarkerData.managedFiles.find((file) => file.path === markerPath);
      assert.ok(markerEntry, `${name} wrapper is installer-owned`);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, `${name} wrapper stays executable`);
        assert.equal(markerEntry!.mode, 0o755, `${name} wrapper mode is part of ownership evidence`);
      }
      const wrapperSha = crypto.createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex");
      assert.equal(markerEntry!.sha256, wrapperSha, `${name} wrapper hash is part of ownership evidence`);
      const wrapperRun = runInstalledWrapper(wrapper, foreignCwd, runtimeEnv);
      assert.ifError(wrapperRun.error);
      assert.equal(wrapperRun.status, 0, String(wrapperRun.stderr || wrapperRun.stdout));
      assert.match(String(wrapperRun.stdout || ""), /CrewDispatch/);
    }

    // Windows owns one HKCU Run value; macOS owns one user LaunchAgent. The
    // explicit TEST seams keep this integration away from either real login store.
    const installAutostart = installed.json.autostart as Record<string, unknown>;
    assert.equal(installAutostart.ok, true, JSON.stringify(installAutostart));
    assert.equal(installAutostart.valueName, process.platform === "darwin" ? "com.crewdispatch.dashboard" : "JobQuayDashboard");
    if (process.platform === "win32") {
      assert.equal(installAutostart.registered, true);
      assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.vbs")), true);
      assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.json")), true);
      const registeredAfterInstall = readAutostartRegistry(autostartRegistry);
      assert.deepEqual(Object.keys(registeredAfterInstall), ["JobQuayDashboard"]);
      assert.equal(
        registeredAfterInstall.JobQuayDashboard!.toLowerCase(),
        autostartCommandFor(target).toLowerCase(),
        "the registered command must point at the installed artifact's own shim"
      );
      assert.equal(
        registeredAfterInstall.JobQuayDashboard!.startsWith(SOURCE_ROOT),
        false,
        "the registered autostart must never point at the source checkout"
      );
      const installedShim = fs.readFileSync(path.join(target, "autostart", "jobquay-dashboard.vbs"), "utf8");
      assert.equal(installedShim.startsWith(SOURCE_ROOT), false);
      assert.equal(installedShim.includes(SOURCE_ROOT), false, "the shim must not reference the source checkout");
    } else if (process.platform === "darwin") {
      assert.equal(installAutostart.platformSupported, true);
      assert.equal(installAutostart.registered, true);
      assert.equal(installAutostart.mechanism, "macos-user-launchagent");
      const plist = path.join(launchAgentDir, "com.crewdispatch.dashboard.plist");
      assert.equal(fs.existsSync(plist), true);
      assert.equal(fs.statSync(plist).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.vbs")), false, "macOS payload carries no Windows shim");
      const state = JSON.parse(fs.readFileSync(launchctlState, "utf8")) as { loaded: Record<string, string> };
      assert.deepEqual(Object.keys(state.loaded), ["com.crewdispatch.dashboard"]);
      assert.equal(path.resolve(state.loaded["com.crewdispatch.dashboard"]!), path.resolve(plist));
      assert.deepEqual(readAutostartRegistry(autostartRegistry), {});
    } else {
      assert.equal(installAutostart.platformSupported, false);
      assert.equal(installAutostart.registered, false);
      assert.deepEqual(readAutostartRegistry(autostartRegistry), {});
    }
    const installedDoctor = path.join(target, "dist", "cli", "install-cli.js");
    const doctorRun = runInstaller(installedDoctor, ["doctor", "--target", target], foreignCwd, doctorEnv);
    assert.equal(doctorRun.status, 0, doctorRun.stdout);
    assert.equal(doctorRun.json.command, "doctor");
    assert.equal(doctorRun.json.status, "healthy");
    const absentChecks = doctorRun.json.checks as Record<string, Record<string, unknown>>;
    assert.equal((absentChecks.target as Record<string, unknown>).ok, true);
    assert.equal((absentChecks.dependencies as Record<string, unknown>).ok, true);
    const noticesCheck = absentChecks.notices as Record<string, unknown>;
    assert.equal(noticesCheck.ok, true, JSON.stringify(noticesCheck));
    assert.equal(noticesCheck.path, "THIRD_PARTY_NOTICES");
    assert.equal(noticesCheck.matchesInstallMarker, true, "the doctor must compare the notice against the marker hash");
    assert.equal(noticesCheck.sha256, sourceNoticeSha);
    assert.deepEqual(noticesCheck.missingMarkers, []);
    const productLicenseCheck = absentChecks.productLicense as Record<string, unknown>;
    assert.equal(productLicenseCheck.ok, true, JSON.stringify(productLicenseCheck));
    assert.equal(productLicenseCheck.path, "LICENSE");
    assert.equal(productLicenseCheck.spdx, "Apache-2.0");
    assert.equal(productLicenseCheck.matchesInstallMarker, true);
    assert.equal(productLicenseCheck.sha256, sourceLicenseSha);
    assert.deepEqual(productLicenseCheck.missingMarkers, []);
    assert.equal((absentChecks.plugin as Record<string, unknown>).ok, true);
    assert.equal((absentChecks.runtime as Record<string, unknown>).ok, true);
    const platformCheck = absentChecks.platform as Record<string, unknown>;
    assert.equal(platformCheck.ok, process.platform === "win32" || (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)));
    if (process.platform === "darwin") {
      assert.equal(platformCheck.status, "healthy");
      assert.equal(platformCheck.arch, process.arch);

      const processHelper = absentChecks.processHelper as Record<string, unknown>;
      assert.equal(processHelper.ok, true, JSON.stringify(processHelper));
      assert.equal(processHelper.status, "healthy");
      assert.equal(processHelper.regular, true);
      assert.equal(processHelper.executable, true);
      assert.equal((processHelper.processProbe as Record<string, unknown>).ok, true);
      assert.equal((processHelper.bootProbe as Record<string, unknown>).ok, true);
    } else {
      assert.equal((absentChecks.processHelper as Record<string, unknown>).status, "not_applicable");
    }

    const wrappersCheck = absentChecks.wrappers as Record<string, unknown>;
    assert.equal(wrappersCheck.ok, true, JSON.stringify(wrappersCheck));
    assert.equal(wrappersCheck.status, "healthy");
    const wrappers = wrappersCheck.wrappers as Record<string, unknown>[];
    assert.equal(wrappers.length, 2);
    for (const wrapper of wrappers) {
      assert.equal(wrapper.ok, true, JSON.stringify(wrapper));
      if (process.platform !== "win32") assert.equal(wrapper.mode, 0o755);
      assert.equal(wrapper.pointsAtInstalledEntry, true);
      assert.equal(wrapper.runs, true);
    }
    const autostartCheck = absentChecks.autostart as Record<string, unknown>;
    assert.equal(autostartCheck.ok, true, JSON.stringify(autostartCheck));
    if (process.platform === "win32" || process.platform === "darwin") {
      assert.equal(autostartCheck.status, "healthy", JSON.stringify(autostartCheck));
      assert.equal(autostartCheck.registered, true);
      assert.equal(autostartCheck.targetsThisInstall, true, "doctor must confirm the autostart targets this installation");
      assert.equal(autostartCheck.matchesExpectedCommand, true);
    } else {
      assert.equal(autostartCheck.status, "unsupported");
      assert.equal(autostartCheck.platformSupported, false);
      assert.equal(autostartCheck.registered, null);
    }
    assert.equal(typeof (autostartCheck.hubEndpoint as Record<string, unknown>).state, "string", "doctor reports the Hub endpoint state");
    assert.equal((absentChecks.dataRoot as Record<string, unknown>).ok, true);
    const doctorDataRoot = absentChecks.dataRoot as Record<string, unknown>;
    assert.equal(doctorDataRoot.path, dataRoot);
    assert.equal(doctorDataRoot.source, "jobquay_env");
    assert.equal(doctorDataRoot.status, "healthy");
    assert.equal(doctorDataRoot.outsideInstallDirectory, true);
    assert.equal((absentChecks.probeCleanup as Record<string, unknown>).ok, true);
    assert.equal((absentChecks.probeCleanup as Record<string, unknown>).temporaryDataRemoved, true);
    const cmdc = absentChecks.commandCode as Record<string, unknown>;
    assert.equal(cmdc.ok, true, "doctor retains the existing Command Code metadata checks");
    assert.equal(cmdc.status, "healthy");
    assert.equal(((cmdc.isolation as Record<string, unknown>).temporaryDataRemoved), true);
    const cliProbes = cmdc.probes as Record<string, Record<string, unknown>>;
    for (const name of ["version", "help", "catalog"]) {
      assert.ok(cliProbes[name], `doctor includes the Command Code ${name} probe`);
      assert.equal(typeof cliProbes[name]!.ok, "boolean");
    }
    assert.equal(doctorRun.json.ok, true, "a healthy first-release install passes doctor");

    // Exercise the generated plugin entry through real MCP stdio and check its one-shot job list.
    const client = new McpStdioClient(mcpEntry, runtimeEnv, foreignCwd);
    try {
      const init = await client.initialize();
      assert.equal((init.serverInfo as Record<string, unknown>).name, "crewdispatch");
      const tools = (await client.listTools()).map((tool) => String(tool.name));
      assert.ok(tools.includes("crewdispatch_spawn"));
      assert.ok(tools.includes("crewdispatch_result"));
      assert.ok(tools.includes("crewdispatch_settings_get"));
      const statusResult = McpStdioClient.json(await client.callTool("jobquay_status", {}));
      assert.equal(statusResult.count, 0, "doctor and tools/list/status create no jobs or notifications");
      assert.deepEqual(statusResult.jobs, []);
    } finally {
      await client.close();
    }

    const hub = await probeHub(target, workspace);
    assert.ok(hub.port > 0);
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "separate data root\n");
    assert.deepEqual(fs.readdirSync(dataRoot).sort(), process.platform === "darwin" ? ["autostart", "keep-data.txt"] : ["keep-data.txt"]);
    assert.equal(fs.readFileSync(userConfigSentinel, "utf8"), "user configuration remains untouched\n");

    fs.writeFileSync(userFile, "operator notes must survive both operations\n", "utf8");
    // Windows upgrade must refresh a stale Run registration. macOS upgrade
    // refreshes the exact user LaunchAgent through its separate TEST seam.
    if (process.platform === "win32") {
      fs.writeFileSync(
        autostartRegistry,
        `${JSON.stringify({
          product: "jobquay-test-autostart-registry",
          values: { JobQuayDashboard: autostartCommandFor(path.join(workspace, "old-jobquay-location")) }
        }, null, 2)}\n`,
        "utf8"
      );
    }
    const upgraded = runInstaller(SOURCE_INSTALLER, ["upgrade", "--target", target], foreignCwd, installerEnv);
    assert.equal(upgraded.status, 0, upgraded.stdout);
    assert.equal(upgraded.json.ok, true);
    assert.equal(upgraded.json.installId, installId, "upgrade preserves managed installation identity");
    const upgradeAutostart = upgraded.json.autostart as Record<string, unknown>;
    assert.equal(upgradeAutostart.ok, true, JSON.stringify(upgradeAutostart));
    if (process.platform === "win32") {
      assert.equal(upgradeAutostart.registered, true);
      assert.equal(fs.existsSync(path.join(target, "autostart", "jobquay-dashboard.vbs")), true, "upgrade re-delivers the shim");
      assert.equal(
        readAutostartRegistry(autostartRegistry).JobQuayDashboard!.toLowerCase(),
        autostartCommandFor(target).toLowerCase(),
        "upgrade must update the registration to point at the current installed artifact"
      );
    } else if (process.platform === "darwin") {
      assert.equal(upgradeAutostart.platformSupported, true);
      assert.equal(upgradeAutostart.registered, true);
      const plist = path.join(launchAgentDir, "com.crewdispatch.dashboard.plist");
      assert.equal(fs.existsSync(plist), true, "upgrade keeps the LaunchAgent on the current installation");
      const plistText = fs.readFileSync(plist, "utf8");
      assert.match(plistText, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.deepEqual(readAutostartRegistry(autostartRegistry), {});
    } else {
      assert.equal(upgradeAutostart.platformSupported, false);
      assert.equal(upgradeAutostart.registered, false);
      assert.deepEqual(readAutostartRegistry(autostartRegistry), {});
    }
    assert.equal(fs.readFileSync(path.join(target, "THIRD_PARTY_NOTICES"), "utf8"), sourceNotice, "upgrade re-delivers the reviewed notice file");
    assert.deepEqual(upgraded.json.thirdPartyNotices, { path: "THIRD_PARTY_NOTICES", sha256: sourceNoticeSha });
    assert.equal(fs.readFileSync(userFile, "utf8"), "operator notes must survive both operations\n");
    assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "outside target\n");
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "separate data root\n");
    assert.equal(fs.readFileSync(userConfigSentinel, "utf8"), "user configuration remains untouched\n");

    if (process.platform !== "win32") {
      for (const name of ["crewdispatch", "jobquay"]) {
        const wrapper = path.join(target, "bin", name);
        assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, `upgrade re-delivers executable ${name} wrapper`);
        const wrapperRun = spawnSync(wrapper, ["--help"], {
          cwd: foreignCwd,
          env: { ...runtimeEnv, PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true
        });
        assert.ifError(wrapperRun.error);
        assert.equal(wrapperRun.status, 0, wrapperRun.stderr);
      }
      // A mode-only user edit must be treated exactly like a content edit:
      // uninstall preserves it instead of deleting a file the marker no longer owns.
      fs.chmodSync(path.join(target, "bin", "jobquay"), 0o644);
    }

    const removed = runInstaller(path.join(target, "dist", "cli", "install-cli.js"), ["uninstall", "--target", target], foreignCwd, installerEnv);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(removed.json.ok, true);
    assert.equal(removed.json.targetRemoved, false, "the target remains because it contains an unowned operator file");
    assert.equal(fs.existsSync(path.join(target, "THIRD_PARTY_NOTICES")), false, "a hash-matched notice is removed by uninstall");
    if (process.platform === "win32") {
      assert.deepEqual(fs.readdirSync(target), ["operator-notes.txt"]);
    } else {
      assert.deepEqual(fs.readdirSync(target).sort(), ["bin", "operator-notes.txt"]);
      assert.deepEqual(fs.readdirSync(path.join(target, "bin")), ["jobquay"]);
      assert.equal(fs.statSync(path.join(target, "bin", "jobquay")).mode & 0o777, 0o644, "mode-modified wrapper survives uninstall");
      assert.deepEqual(
        (removed.json.modifiedManagedFiles as { paths: string[] }).paths,
        ["bin/jobquay"],
        "mode-only wrapper edit is reported as a modified managed file"
      );
    }
    assert.equal(fs.readFileSync(userFile, "utf8"), "operator notes must survive both operations\n");
    assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "outside target\n");
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "separate data root\n");
    assert.equal(fs.readFileSync(userConfigSentinel, "utf8"), "user configuration remains untouched\n");
    assert.equal(fs.existsSync(path.join(target, ".jobquay-install.json")), false);
    assert.equal(fs.existsSync(path.join(target, "node_modules")), false);
    const uninstallAutostart = removed.json.autostart as Record<string, unknown>;
    assert.equal(uninstallAutostart.ok, true, JSON.stringify(uninstallAutostart));
    if (process.platform === "win32" || process.platform === "darwin") {
      assert.equal(uninstallAutostart.removed, true, "uninstall removes only the CrewDispatch-owned login entry");
      assert.equal(uninstallAutostart.reason, "removed");
      if (process.platform === "darwin") {
        assert.equal(fs.existsSync(path.join(launchAgentDir, "com.crewdispatch.dashboard.plist")), false);
      }
    } else {
      assert.equal(uninstallAutostart.platformSupported, false);
      assert.equal(uninstallAutostart.removed, false);
      assert.equal(uninstallAutostart.reason, "platform_unsupported");
    }
    assert.deepEqual(readAutostartRegistry(autostartRegistry), {}, "no CrewDispatch Run value survives uninstall");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a user-modified product LICENSE blocks upgrade and is preserved by uninstall", { timeout: 900000 }, () => {
  const workspace = fs.mkdtempSync(path.join(canonicalTempRoot(), "jobquay-license-preserve-"));
  const target = path.join(workspace, "installed-jobquay");
  const dataRoot = path.join(workspace, "separate-data-root");
  fs.mkdirSync(dataRoot, { recursive: true });
  const installerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(workspace, "autostart-registry.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(workspace, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(workspace, "launchctl-state.json")
  };
  try {
    const installed = runInstaller(SOURCE_INSTALLER, ["install", "--target", target], workspace, installerEnv);
    assert.equal(installed.status, 0, installed.stdout);
    const licensePath = path.join(target, "LICENSE");
    const original = fs.readFileSync(licensePath, "utf8");
    assert.match(original, /Apache License/);
    const edited = `${original}\noperator annotation appended by the install owner\n`;
    fs.writeFileSync(licensePath, edited, "utf8");
    const markerPath = path.join(target, ".jobquay-install.json");
    const markerBefore = fs.readFileSync(markerPath, "utf8");

    const upgradeAttempt = runInstaller(SOURCE_INSTALLER, ["upgrade", "--target", target], workspace, installerEnv);
    assert.notEqual(upgradeAttempt.status, 0, "upgrade must fail closed instead of overwriting a modified product license");
    assert.equal(((upgradeAttempt.json.error as Record<string, unknown>)?.code), "product_license_modified");
    assert.equal(fs.readFileSync(licensePath, "utf8"), edited);
    assert.equal(fs.readFileSync(markerPath, "utf8"), markerBefore, "failed upgrade leaves the old install marker untouched");

    const removed = runInstaller(path.join(target, "dist", "cli", "install-cli.js"), ["uninstall", "--target", target], workspace, installerEnv);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(removed.json.ok, true);
    assert.equal(fs.readFileSync(licensePath, "utf8"), edited, "a user-modified product license must survive uninstall");
    assert.deepEqual(
      (removed.json.modifiedManagedFiles as { paths: string[] }).paths,
      ["LICENSE"],
      "the modified product license must be reported as a modified managed file"
    );
    assert.deepEqual((removed.json.preserved as { paths: string[] }).paths, ["LICENSE"]);
    assert.equal(removed.json.targetRemoved, false);
    assert.deepEqual(fs.readdirSync(target), ["LICENSE"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a user-modified THIRD_PARTY_NOTICES is preserved and reported by uninstall", { timeout: 900000 }, () => {
  const workspace = fs.mkdtempSync(path.join(canonicalTempRoot(), "jobquay-notice-preserve-"));
  const target = path.join(workspace, "installed-jobquay");
  const dataRoot = path.join(workspace, "separate-data-root");
  fs.mkdirSync(dataRoot, { recursive: true });
  const installerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(workspace, "autostart-registry.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(workspace, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(workspace, "launchctl-state.json")
  };
  try {
    const installed = runInstaller(SOURCE_INSTALLER, ["install", "--target", target], workspace, installerEnv);
    assert.equal(installed.status, 0, installed.stdout);
    const noticePath = path.join(target, "THIRD_PARTY_NOTICES");
    const original = fs.readFileSync(noticePath, "utf8");
    assert.match(original, /Copyright \(c\) 2026 ZSeven-W/);
    const edited = `${original}\noperator annotation appended by the install owner\n`;
    fs.writeFileSync(noticePath, edited, "utf8");

    const removed = runInstaller(path.join(target, "dist", "cli", "install-cli.js"), ["uninstall", "--target", target], workspace, installerEnv);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(removed.json.ok, true);
    assert.equal(fs.readFileSync(noticePath, "utf8"), edited, "a user-modified notice must survive uninstall");
    assert.deepEqual(
      (removed.json.modifiedManagedFiles as { paths: string[] }).paths,
      ["THIRD_PARTY_NOTICES"],
      "the modified notice must be reported as a modified managed file"
    );
    assert.deepEqual((removed.json.preserved as { paths: string[] }).paths, ["THIRD_PARTY_NOTICES"]);
    assert.equal(removed.json.targetRemoved, false, "the target stays because the preserved notice remains");
    assert.deepEqual(fs.readdirSync(target), ["THIRD_PARTY_NOTICES"]);
    assert.equal(fs.existsSync(path.join(target, "node_modules")), false, "the rest of the managed install is still removed");
    assert.equal(fs.existsSync(path.join(target, ".jobquay-install.json")), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
