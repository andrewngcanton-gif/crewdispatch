// autostart.test.ts — unit coverage for user-scoped Dashboard autostart.
// Windows is redirected through the TEST-ONLY registry seam; macOS is
// redirected through disposable LaunchAgents + launchctl-state seams. These
// tests never touch the operator's real HKCU Run key or ~/Library/LaunchAgents.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTOSTART_VALUE_NAME,
  autostartMetadataPath,
  autostartShimPath,
  isJobQuayAutostartCommand,
  parseAutostartCommand,
  parseExportedRegValue,
  renderAutostartCommand,
  renderAutostartShim,
  resolveAutostartRegistry,
  tokenizeCommandLine
} from "../../install/autostart-windows";
import {
  inspectDashboardAutostart,
  registerDashboardAutostart,
  removeDashboardAutostart,
  writeAutostartPayloadInto
} from "../../install/autostart";

function createFakeInstall(root: string): void {
  fs.mkdirSync(path.join(root, "dist", "cli"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli", "jobquay-cli.js"), "// installed CLI entry\n", "utf8");
  fs.writeFileSync(path.join(root, ".jobquay-install.json"), "{\"product\":\"jobquay\"}\n", "utf8");
}

function workspace(): { root: string; install: string; registryFile: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-unit-"));
  const install = path.join(root, "install");
  const registryFile = path.join(root, "registry.json");
  createFakeInstall(install);
  return { root, install, registryFile, env: { JOBQUAY_TEST_AUTOSTART_REGISTRY: registryFile } };
}

test("the registered command is a quoted, console-free wscript invocation of the installed shim", () => {
  const shim = "D:\\installs\\jobquay\\autostart\\jobquay-dashboard.vbs";
  const command = renderAutostartCommand(shim, { SystemRoot: "C:\\Windows" });
  assert.equal(command, '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "D:\\installs\\jobquay\\autostart\\jobquay-dashboard.vbs"');
  const parsed = parseAutostartCommand(command);
  assert.equal(parsed.executable, "C:\\Windows\\System32\\wscript.exe");
  assert.equal(parsed.shimPath, shim);
  assert.equal(parsed.installRoot, "D:\\installs\\jobquay");
  assert.equal(isJobQuayAutostartCommand(command), true);
});

test("command tokenization and ownership recognition reject foreign values", () => {
  assert.deepEqual(tokenizeCommandLine('a "b c" d'), ["a", "b c", "d"]);
  assert.deepEqual(tokenizeCommandLine('  "a  b"   c  '), ["a  b", "c"]);
  assert.equal(isJobQuayAutostartCommand('"C:\\Windows\\System32\\wscript.exe" "C:\\other\\thing.vbs"'), false);
  assert.equal(isJobQuayAutostartCommand('"C:\\Program Files\\Other\\other.exe" --run'), false);
  assert.equal(isJobQuayAutostartCommand(""), false);
  assert.equal(parseAutostartCommand("").installRoot, null);
});

test("exported .reg values are read without codepage damage (including non-ASCII paths)", () => {
  const exported = [
    "\uFEFFWindows Registry Editor Version 5.00",
    "",
    "[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]",
    '"Other"="C:\\\\Other\\\\app.exe"',
    '"JobQuayDashboard"="\\"C:\\\\Windows\\\\System32\\\\wscript.exe\\" //B //NoLogo \\"D:\\\\\u8f6f\u4ef6\u5b89\u88c5\\\\CrewDispatch \u5e94\u7528\\\\autostart\\\\jobquay-dashboard.vbs\\""'
  ].join("\r\n");
  const value = parseExportedRegValue(exported, "JobQuayDashboard");
  assert.equal(value, '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "D:\\\u8f6f\u4ef6\u5b89\u88c5\\CrewDispatch \u5e94\u7528\\autostart\\jobquay-dashboard.vbs"');
  assert.equal(isJobQuayAutostartCommand(value!), true);
  assert.equal(parseExportedRegValue(exported, "jobquaydashboard"), value, "value names are case-insensitive");
  assert.equal(parseExportedRegValue(exported, "NotThere"), null);
  assert.equal(parseExportedRegValue("Windows Registry Editor Version 5.00\r\n\r\n[KEY]\r\n", "JobQuayDashboard"), null);
});

test("the generated shim launches the installed CLI hidden and never opens a browser", () => {
  const shim = renderAutostartShim("D:\\installs\\jobquay", "C:\\Program Files\\nodejs\\node.exe");
  assert.match(shim, /installRoot = "D:\\installs\\jobquay"/);
  assert.match(shim, /nodeExe = "C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(shim, /cliEntry = installRoot & "\\dist\\cli\\jobquay-cli\.js"/);
  assert.match(shim, /shell\.Run\(commandLine, 0, True\)/, "window style 0 = hidden console, no visible window");
  assert.match(shim, /& cliEntry & """ autostart run"/, "the shim reuses the shared ensure-Hub lifecycle with no open flags");
  assert.throws(() => renderAutostartShim('D:\\bad"path', "C:\\node.exe"), /cannot be embedded/);
});

test("registration writes only the CrewDispatch-owned value, pointing into the installation", () => {
  const { root, install, registryFile, env } = workspace();
  try {
    const result = registerDashboardAutostart(install, { env, platform: "win32" });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.registered, true);
    assert.equal(result.valueName, AUTOSTART_VALUE_NAME);
    assert.equal(result.command, renderAutostartCommand(autostartShimPath(install), env));
    assert.equal(fs.existsSync(autostartShimPath(install)), true, "the shim is written inside the installation");
    assert.equal(fs.existsSync(autostartMetadataPath(install)), true);
    assert.doesNotMatch(result.command!, /winProjects|src[\\/]/i, "the registration must not point at a source checkout");

    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { product: string; values: Record<string, string> };
    assert.equal(registry.product, "jobquay-test-autostart-registry");
    assert.deepEqual(Object.keys(registry.values), [AUTOSTART_VALUE_NAME]);

    // Idempotent: a second registration keeps exactly one value with the same command.
    const again = registerDashboardAutostart(install, { env, platform: "win32" });
    assert.equal(again.ok, true);
    assert.equal(again.command, result.command);
    const registryAgain = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { values: Record<string, string> };
    assert.deepEqual(Object.keys(registryAgain.values), [AUTOSTART_VALUE_NAME]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration refuses a directory that is not a managed installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-unmanaged-"));
  try {
    const target = path.join(root, "not-an-install");
    fs.mkdirSync(target, { recursive: true });
    const result = registerDashboardAutostart(target, { env: { JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(root, "r.json") }, platform: "win32" });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "not_managed");
    assert.equal(fs.existsSync(path.join(target, "autostart")), false);
    assert.equal(fs.existsSync(path.join(root, "r.json")), false, "nothing may be registered for a non-installation");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspection reports a healthy registration that targets the current installation", async () => {
  const { root, install, env } = workspace();
  const dataRoot = path.join(root, "data");
  try {
    registerDashboardAutostart(install, { env, platform: "win32" });
    const inspection = await inspectDashboardAutostart({ target: install, env, platform: "win32", probeHub: false, dataRoot });
    assert.equal(inspection.status, "healthy");
    assert.equal(inspection.ok, true);
    assert.equal(inspection.targetsThisInstall, true);
    assert.equal(inspection.matchesExpectedCommand, true);
    assert.equal(inspection.shim.exists, true);
    assert.equal(inspection.metadata.valid, true);
    assert.equal(inspection.metadata.nodeExists, true);
    assert.equal(inspection.metadata.cliEntryExists, true);
    assert.equal(inspection.registeredInstallRoot, path.resolve(install));
    assert.equal(inspection.lastRun, null, "no headless run has been recorded yet");
    assert.equal(inspection.error, null);

    const other = path.join(root, "other-install");
    createFakeInstall(other);
    const wrongTarget = await inspectDashboardAutostart({ target: other, env, platform: "win32", probeHub: false, dataRoot });
    assert.equal(wrongTarget.status, "broken");
    assert.equal(wrongTarget.ok, false);
    assert.equal(wrongTarget.targetsThisInstall, false);
    assert.equal(wrongTarget.error?.code, "other_install");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removal deletes only the CrewDispatch-owned entry and never another installation's", () => {
  const { root, install, registryFile, env } = workspace();
  try {
    const other = path.join(root, "other-install");
    createFakeInstall(other);
    registerDashboardAutostart(other, { env, platform: "win32" });

    const scoped = removeDashboardAutostart({ target: install, env, platform: "win32" });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.removed, false);
    assert.equal(scoped.reason, "points_at_other_install");
    assert.equal(scoped.registeredInstallRoot, path.resolve(other));
    assert.ok(fs.existsSync(registryFile), "the other installation's entry stays registered");

    const unscoped = removeDashboardAutostart({ env, platform: "win32" });
    assert.equal(unscoped.ok, true);
    assert.equal(unscoped.removed, true);
    assert.equal(unscoped.reason, "removed");
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { values: Record<string, string> };
    assert.deepEqual(registry.values, {});

    const again = removeDashboardAutostart({ env, platform: "win32" });
    assert.equal(again.ok, true);
    assert.equal(again.removed, false);
    assert.equal(again.reason, "not_registered");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a foreign value under the CrewDispatch name is reported, never deleted", async () => {
  const { root, registryFile, env } = workspace();
  try {
    fs.writeFileSync(registryFile, `${JSON.stringify({
      product: "jobquay-test-autostart-registry",
      values: { [AUTOSTART_VALUE_NAME]: '"C:\\SomeOtherApp\\launcher.exe" --start' }
    }, null, 2)}\n`, "utf8");

    const inspection = await inspectDashboardAutostart({ env, platform: "win32", probeHub: false, dataRoot: path.join(root, "data") });
    assert.equal(inspection.status, "broken");
    assert.equal(inspection.error?.code, "value_not_jobquay");

    const removal = removeDashboardAutostart({ env, platform: "win32" });
    assert.equal(removal.ok, true);
    assert.equal(removal.removed, false);
    assert.equal(removal.reason, "value_not_jobquay");
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as { values: Record<string, string> };
    assert.equal(registry.values[AUTOSTART_VALUE_NAME], '"C:\\SomeOtherApp\\launcher.exe" --start');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a registration write failure is reported as a degraded result without touching the install", () => {
  const { root, install, registryFile, env } = workspace();
  try {
    // Read-only emulated registry: reads keep working, the write is refused.
    fs.writeFileSync(registryFile, `${JSON.stringify({ product: "jobquay-test-autostart-registry", values: {} }, null, 2)}\n`, "utf8");
    fs.chmodSync(registryFile, 0o444);
    const result = registerDashboardAutostart(install, { env, platform: "win32" });
    assert.equal(result.ok, false);
    assert.equal(result.registered, false);
    assert.equal(result.error?.code, "autostart_registration_failed");
    assert.equal(fs.existsSync(path.join(install, ".jobquay-install.json")), true, "the installation stays intact");
    assert.equal(fs.existsSync(autostartShimPath(install)), true, "the payload shim is still in place");
  } finally {
    try { fs.chmodSync(registryFile, 0o666); } catch { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unsupported platforms remain an explicit, honest no-op", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-unsupported-"));
  try {
    const install = path.join(root, "install");
    createFakeInstall(install);
    const registered = registerDashboardAutostart(install, { platform: "linux", env: {} });
    assert.equal(registered.ok, true);
    assert.equal(registered.registered, false);
    assert.equal(registered.platformSupported, false);
    assert.match(registered.note ?? "", /Windows and macOS/i);

    const inspection = await inspectDashboardAutostart({ target: install, platform: "linux", env: {}, probeHub: false, dataRoot: path.join(root, "data") });
    assert.equal(inspection.status, "unsupported");
    assert.equal(inspection.ok, true);

    const removal = removeDashboardAutostart({ platform: "linux", env: {} });
    assert.equal(removal.ok, true);
    assert.equal(removal.reason, "platform_unsupported");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS LaunchAgent registration, inspection and scoped removal are exact and disposable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-macos-"));
  const install = path.join(root, "CrewDispatch install with spaces");
  const other = path.join(root, "other-install");
  const launchAgents = path.join(root, "Library", "LaunchAgents");
  const launchctlState = path.join(root, "launchctl-state.json");
  const dataRoot = path.join(root, "data");
  const launchPath = `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    JOBQUAY_DATA_ROOT: dataRoot,
    PATH: launchPath,
    JOBQUAY_TEST_LAUNCHAGENT_DIR: launchAgents,
    JOBQUAY_TEST_LAUNCHCTL_STATE: launchctlState
  };
  createFakeInstall(install);
  createFakeInstall(other);
  try {
    const registered = registerDashboardAutostart(install, { platform: "darwin", env, nodePath: process.execPath });
    assert.equal(registered.ok, true, JSON.stringify(registered.error));
    assert.equal(registered.registered, true);
    assert.equal(registered.platformSupported, true);
    assert.equal(registered.mechanism, "macos-user-launchagent");
    assert.equal(registered.valueName, "com.crewdispatch.dashboard");
    assert.ok(registered.shimPath);
    assert.equal(fs.existsSync(registered.shimPath!), true);
    assert.equal(fs.lstatSync(registered.shimPath!).isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(registered.shimPath!).mode & 0o777, 0o644);
    }
    const plist = fs.readFileSync(registered.shimPath!, "utf8");
    assert.match(plist, /<string>com\.crewdispatch\.dashboard<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
    assert.equal(plist.includes(`<key>PATH</key>\n    <string>${launchPath}</string>`), true, "the LaunchAgent preserves the exact provider-search PATH on every host OS");
    assert.match(plist, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(plist, /jobquay-cli\.js/);
    assert.doesNotMatch(plist, /\/bin\/(?:ba)?sh|open -g|osascript/i);

    const state = JSON.parse(fs.readFileSync(launchctlState, "utf8")) as { loaded: Record<string, string> };
    assert.deepEqual(Object.keys(state.loaded), ["com.crewdispatch.dashboard"]);
    assert.equal(path.resolve(state.loaded["com.crewdispatch.dashboard"]!), path.resolve(registered.shimPath!));

    const healthy = await inspectDashboardAutostart({ target: install, platform: "darwin", env, probeHub: false, dataRoot });
    assert.equal(healthy.status, "healthy", JSON.stringify(healthy.error));
    assert.equal(healthy.ok, true);
    assert.equal(healthy.targetsThisInstall, true);
    assert.equal(healthy.matchesExpectedCommand, true);
    assert.equal(healthy.metadata.nodeExists, true);
    assert.equal(healthy.metadata.cliEntryExists, true);

    fs.mkdirSync(path.join(dataRoot, "autostart"), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "autostart", "last-run.json"),
      JSON.stringify(
        {
          product: "jobquay",
          kind: "jobquay-dashboard-autostart-run",
          at: new Date().toISOString(),
          ok: false,
          action: "refused",
          port: 30123,
          url: null,
          ping_url: null,
          hub_pid: null,
          service: null,
          version: null,
          build_id: null,
          error: { code: "hub_start_failed", message: "foreign listener" }
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const failedRun = await inspectDashboardAutostart({ target: install, platform: "darwin", env, probeHub: false, dataRoot });
    assert.equal(failedRun.status, "broken");
    assert.equal(failedRun.ok, false);
    assert.equal(failedRun.error?.code, "hub_start_failed");
    fs.rmSync(path.join(dataRoot, "autostart", "last-run.json"), { force: true });

    const wrongTarget = await inspectDashboardAutostart({ target: other, platform: "darwin", env, probeHub: false, dataRoot });
    assert.equal(wrongTarget.status, "broken");
    assert.equal(wrongTarget.error?.code, "other_install");

    const scoped = removeDashboardAutostart({ target: other, platform: "darwin", env });
    assert.equal(scoped.ok, true);
    assert.equal(scoped.removed, false);
    assert.equal(scoped.reason, "points_at_other_install");
    assert.equal(fs.existsSync(registered.shimPath!), true, "another installation cannot remove this LaunchAgent");

    const removed = removeDashboardAutostart({ target: install, platform: "darwin", env });
    assert.equal(removed.ok, true, JSON.stringify(removed.error));
    assert.equal(removed.removed, true);
    assert.equal(removed.reason, "removed");
    assert.equal(fs.existsSync(registered.shimPath!), false);

    const disabled = await inspectDashboardAutostart({ target: install, platform: "darwin", env, probeHub: false, dataRoot });
    assert.equal(disabled.status, "disabled");
    assert.equal(disabled.registered, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS never overwrites or removes a foreign plist at the CrewDispatch label path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-macos-foreign-"));
  const install = path.join(root, "install");
  const launchAgents = path.join(root, "LaunchAgents");
  const plist = path.join(launchAgents, "com.crewdispatch.dashboard.plist");
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    JOBQUAY_DATA_ROOT: path.join(root, "data"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: launchAgents,
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(root, "launchctl-state.json")
  };
  createFakeInstall(install);
  fs.mkdirSync(launchAgents, { recursive: true });
  const foreign = "<?xml version=\"1.0\"?><plist><dict><key>Label</key><string>com.other.app</string></dict></plist>\n";
  fs.writeFileSync(plist, foreign, "utf8");
  try {
    const registered = registerDashboardAutostart(install, { platform: "darwin", env });
    assert.equal(registered.ok, false);
    assert.equal(registered.error?.code, "launchagent_foreign");
    assert.equal(fs.readFileSync(plist, "utf8"), foreign);

    const inspection = await inspectDashboardAutostart({ target: install, platform: "darwin", env, probeHub: false, dataRoot: env.JOBQUAY_DATA_ROOT! });
    assert.equal(inspection.status, "broken");
    assert.equal(inspection.error?.code, "launchagent_foreign");

    const removal = removeDashboardAutostart({ target: install, platform: "darwin", env });
    assert.equal(removal.ok, true);
    assert.equal(removal.removed, false);
    assert.equal(removal.reason, "value_not_jobquay");
    assert.equal(fs.readFileSync(plist, "utf8"), foreign);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspection reports a deliberately disabled autostart with a re-enable hint", async () => {
  const { root, install, env } = workspace();
  try {
    const inspection = await inspectDashboardAutostart({
      target: install,
      env,
      platform: "win32",
      probeHub: false,
      dataRoot: path.join(root, "data")
    });
    assert.equal(inspection.status, "disabled");
    assert.equal(inspection.registered, false);
    assert.match(inspection.hint ?? "", /autostart enable --target/);
    assert.equal(inspection.expectedCommand, renderAutostartCommand(autostartShimPath(install), env));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Windows payload writer is deterministic and stays inside the installation", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-payload-"));
  try {
    const stage = path.join(root, ".stage");
    const finalTarget = path.join(root, "install");
    fs.mkdirSync(stage, { recursive: true });
    writeAutostartPayloadInto(stage, finalTarget, { nodePath: "C:\\Program Files\\nodejs\\node.exe" });
    const shim = fs.readFileSync(path.join(stage, "autostart", "jobquay-dashboard.vbs"), "utf8");
    assert.match(shim, new RegExp(`installRoot = "${finalTarget.replace(/\\/g, "\\\\")}"`), "the shim records the FINAL install path, not the stage");
    const metadata = JSON.parse(fs.readFileSync(path.join(stage, "autostart", "jobquay-dashboard.json"), "utf8")) as { installRoot: string };
    assert.equal(metadata.installRoot, finalTarget);
    const before = fs.statSync(path.join(stage, "autostart", "jobquay-dashboard.vbs")).mtimeMs;
    writeAutostartPayloadInto(stage, finalTarget, { nodePath: "C:\\Program Files\\nodejs\\node.exe" });
    const after = fs.statSync(path.join(stage, "autostart", "jobquay-dashboard.vbs")).mtimeMs;
    assert.equal(after, before, "an identical payload is not rewritten");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the registry seam is selected only by the explicit TEST-ONLY env var", () => {
  assert.equal(resolveAutostartRegistry({}).kind, "windows-registry");
  assert.equal(resolveAutostartRegistry({ JOBQUAY_TEST_AUTOSTART_REGISTRY: "" }).kind, "windows-registry");
  assert.equal(resolveAutostartRegistry({ JOBQUAY_TEST_AUTOSTART_REGISTRY: "  " }).kind, "windows-registry");
  assert.equal(resolveAutostartRegistry({ JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(os.tmpdir(), "x.json") }).kind, "emulated-file");
});

test("macOS managed payload does not carry the Windows-only VBS autostart shim", { skip: process.platform !== "darwin" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-autostart-macos-payload-"));
  try {
    const stage = path.join(root, ".stage");
    fs.mkdirSync(stage, { recursive: true });
    writeAutostartPayloadInto(stage, path.join(root, "install"), { nodePath: process.execPath });
    assert.equal(fs.existsSync(path.join(stage, "autostart")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});