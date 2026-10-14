import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const INSTALLER = path.join(ROOT, "dist", "cli", "install-cli.js");

function runNode(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const run = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  assert.ifError(run.error);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(run.stdout || "{}"); } catch {}
  return { ...run, json };
}

test("complete-uninstall removes managed caller integration and optionally purges the dedicated data root", { timeout: 900_000 }, () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-complete-uninstall-"));
  const target = path.join(temp, "runtime");
  const dataRoot = path.join(temp, "JobQuay");
  const codexHome = path.join(temp, "codex-home");
  const claudeConfig = path.join(temp, "claude-config");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    LOCALAPPDATA: path.join(temp, "localappdata"),
    APPDATA: path.join(temp, "appdata"),
    JOBQUAY_DATA_ROOT: dataRoot,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(temp, "autostart-registry.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(temp, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(temp, "launchctl-state.json")
  };
  for (const dir of [dataRoot, codexHome, claudeConfig, env.LOCALAPPDATA!, env.APPDATA!]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "keep-until-purge.txt"), "data\n");

  try {
    const install = runNode(INSTALLER, ["install", "--target", target], temp, env);
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.equal(install.json.ok, true);

    const codexInstall = runNode(path.join(target, "scripts", "install-codex-command.cjs"), ["--codex-home", codexHome], temp, env);
    assert.equal(codexInstall.status, 0, codexInstall.stderr || codexInstall.stdout);
    const codexPrompt = path.join(codexHome, "prompts", "crewdispatch.md");
    assert.equal(fs.existsSync(codexPrompt), true);

    const claudeInstall = runNode(path.join(target, "dist", "cli", "install-cli.js"), ["claude-install", "--config", claudeConfig], temp, env);
    assert.equal(claudeInstall.status, 0, claudeInstall.stderr || claudeInstall.stdout);
    assert.equal(claudeInstall.json.ok, true);
    assert.equal(fs.existsSync(path.join(claudeConfig, "crewdispatch-install.json")), true, "Claude managed manifest was created");

    const complete = runNode(
      path.join(target, "dist", "cli", "install-cli.js"),
      ["complete-uninstall", "--target", target, "--purge-data"],
      temp,
      env
    );
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    assert.equal(complete.json.ok, true);
    assert.equal(complete.json.command, "complete-uninstall");
    assert.equal(complete.json.complete, true, JSON.stringify(complete.json));
    assert.equal((complete.json.data as Record<string, unknown>).removed, true);
    assert.equal(complete.json.dataRootUntouched, false);
    assert.equal(fs.existsSync(dataRoot), false, "explicit purge removes the dedicated data root");
    assert.equal(fs.existsSync(codexPrompt), false, "unmodified Codex prompt is removed");
    assert.equal(fs.existsSync(path.join(claudeConfig, "crewdispatch-install.json")), false, "Claude managed manifest is removed");
    assert.equal(fs.existsSync(path.join(target, ".jobquay-install.json")), false, "managed install marker is removed");
    assert.equal(fs.existsSync(target), false, "clean managed target is removed completely");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("complete-uninstall preserves a user-edited Codex prompt and leaves data untouched unless purge is explicit", { timeout: 900_000 }, () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-complete-uninstall-edited-"));
  const target = path.join(temp, "runtime");
  const dataRoot = path.join(temp, "JobQuay");
  const codexHome = path.join(temp, "codex-home");
  const claudeConfig = path.join(temp, "claude-config");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: temp,
    USERPROFILE: temp,
    LOCALAPPDATA: path.join(temp, "localappdata"),
    APPDATA: path.join(temp, "appdata"),
    JOBQUAY_DATA_ROOT: dataRoot,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(temp, "autostart-registry.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(temp, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(temp, "launchctl-state.json")
  };
  for (const dir of [dataRoot, codexHome, claudeConfig, env.LOCALAPPDATA!, env.APPDATA!]) fs.mkdirSync(dir, { recursive: true });
  const dataSentinel = path.join(dataRoot, "keep.txt");
  fs.writeFileSync(dataSentinel, "keep\n");

  try {
    const install = runNode(INSTALLER, ["install", "--target", target], temp, env);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const codexInstall = runNode(path.join(target, "scripts", "install-codex-command.cjs"), ["--codex-home", codexHome], temp, env);
    assert.equal(codexInstall.status, 0, codexInstall.stderr || codexInstall.stdout);
    const codexPrompt = path.join(codexHome, "prompts", "crewdispatch.md");
    fs.appendFileSync(codexPrompt, "\nuser customization\n");
    const customized = fs.readFileSync(codexPrompt, "utf8");

    const complete = runNode(path.join(target, "dist", "cli", "install-cli.js"), ["complete-uninstall", "--target", target], temp, env);
    assert.equal(complete.status, 0, complete.stderr || complete.stdout);
    assert.equal(complete.json.ok, true);
    assert.equal(complete.json.complete, false, "preserved caller edits are reported as an incomplete cleanup rather than deleted");
    const callers = complete.json.callers as Record<string, Record<string, unknown>>;
    const codexCleanup = callers.codex;
    assert.ok(codexCleanup);
    assert.equal(codexCleanup.ok, false);
    assert.equal(codexCleanup.status, "preserved_or_error");
    assert.equal(fs.readFileSync(codexPrompt, "utf8"), customized, "user-edited Codex prompt survives complete uninstall");
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "keep\n", "data remains without --purge-data");
    assert.equal(complete.json.dataRootUntouched, true);
    assert.equal(fs.existsSync(target), false, "clean managed runtime is still removed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
