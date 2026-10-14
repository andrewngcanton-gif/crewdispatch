import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_INSTALL_MANIFEST,
  CODEX_MARKETPLACE_NAME,
  CODEX_PLUGIN_ID,
  installCodexClient,
  type CodexCliResult,
  uninstallCodexClient
} from "../../codex/client-install";

function ok(json: Record<string, unknown> = {}): CodexCliResult {
  return { ok: true, exitCode: 0, stdout: JSON.stringify(json), stderr: "", json, error: null };
}

function fail(message = "codex unavailable"): CodexCliResult {
  return { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: message };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-codex-client-"));
  const target = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(path.join(target, ".agents", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(target, ".agents", "plugins", "marketplace.json"), "{}\n");
  fs.writeFileSync(path.join(target, "scripts", "install-codex-command.cjs"), "// test\n");
  fs.writeFileSync(path.join(target, "scripts", "uninstall-codex-command.cjs"), "// test\n");
  return { root, target, codexHome, env: { ...process.env, CODEX_HOME: codexHome } as NodeJS.ProcessEnv };
}

test("Codex caller install registers the local marketplace/plugin and uninstall removes only the owned registration", () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    const runCli = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID, version: "0.1.4" });
      if (args[0] === "plugin" && args[1] === "list") {
        return ok({ installed: [{ pluginId: CODEX_PLUGIN_ID, marketplaceSource: { sourceType: "local", source: fx.target } }] });
      }
      if (args[0] === "plugin" && args[1] === "remove") return ok({ pluginId: CODEX_PLUGIN_ID });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
        return ok({ marketplaces: [{ name: CODEX_MARKETPLACE_NAME, root: fx.target }] });
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      return fail(`unexpected command: ${args.join(" ")}`);
    };
    const runPromptScript = (): CodexCliResult => ok();

    const installed = installCodexClient(fx.target, { env: fx.env, runCli, runPromptScript });
    assert.equal(installed.ok, true);
    assert.deepEqual(calls.slice(0, 2), [
      ["plugin", "marketplace", "add", fx.target, "--json"],
      ["plugin", "add", CODEX_PLUGIN_ID, "--json"]
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.target, fx.target);
    assert.equal(manifest.marketplaceInstalled, true);
    assert.equal(manifest.pluginInstalled, true);

    const removed = uninstallCodexClient(fx.target, { env: fx.env, runCli, runPromptScript });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), false);
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace remove ${CODEX_MARKETPLACE_NAME} --json`));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex caller uninstall stays complete when the plugin CLI was unavailable during install", () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    const runCli = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      return fail();
    };
    const runPromptScript = (): CodexCliResult => ok();
    const installed = installCodexClient(fx.target, { env: fx.env, runCli, runPromptScript });
    assert.equal(installed.ok, false);
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.marketplaceInstalled, false);
    assert.equal(manifest.pluginInstalled, false);

    calls.length = 0;
    const removed = uninstallCodexClient(fx.target, { env: fx.env, runCli, runPromptScript });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.deepEqual(calls, [], "uninstall must not probe/remove a plugin that the install manifest says was never installed");
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex caller install preserves a foreign ownership manifest without touching prompt or plugin state", () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    const manifestFile = path.join(fx.codexHome, CODEX_INSTALL_MANIFEST);
    const foreign = '{"product":"someone-else","target":"foreign"}\n';
    fs.writeFileSync(manifestFile, foreign, "utf8");
    const installed = installCodexClient(fx.target, {
      env: fx.env,
      runCli: (args) => { calls.push([...args]); return ok(); },
      runPromptScript: () => { throw new Error("prompt installer must not run"); }
    });
    assert.equal(installed.ok, false);
    assert.equal(installed.conflicts.length, 1);
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(manifestFile, "utf8"), foreign);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex caller uninstall preserves a live foreign plugin and keeps ownership evidence for retry", () => {
  const fx = fixture();
  try {
    const installRun = (args: string[]): CodexCliResult => {
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected install command: ${args.join(" ")}`);
    };
    assert.equal(installCodexClient(fx.target, { env: fx.env, runCli: installRun, runPromptScript: () => ok() }).ok, true);

    const calls: string[][] = [];
    const foreignRoot = path.join(fx.root, "foreign-runtime");
    const uninstallRun = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") {
        return ok({ installed: [{ pluginId: CODEX_PLUGIN_ID, marketplaceSource: { sourceType: "local", source: foreignRoot } }] });
      }
      throw new Error(`uninstall must not mutate foreign registration: ${args.join(" ")}`);
    };
    const removed = uninstallCodexClient(fx.target, { env: fx.env, runCli: uninstallRun, runPromptScript: () => ok() });
    assert.equal(removed.ok, false);
    assert.ok(removed.conflicts.some((conflict) => conflict.target === CODEX_PLUGIN_ID));
    assert.equal(calls.some((args) => args[0] === "plugin" && args[1] === "remove"), false);
    assert.equal(calls.some((args) => args[1] === "marketplace"), false, "marketplace remains while plugin ownership is unresolved");
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), true, "ownership manifest remains for a safe retry");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex caller uninstall preserves the marketplace and manifest when owned plugin removal fails", () => {
  const fx = fixture();
  try {
    const installRun = (args: string[]): CodexCliResult => {
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected install command: ${args.join(" ")}`);
    };
    assert.equal(installCodexClient(fx.target, { env: fx.env, runCli: installRun, runPromptScript: () => ok() }).ok, true);

    const calls: string[][] = [];
    const uninstallRun = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") {
        return ok({ installed: [{ pluginId: CODEX_PLUGIN_ID, marketplaceSource: { sourceType: "local", source: fx.target } }] });
      }
      if (args[0] === "plugin" && args[1] === "remove") return fail("remove failed");
      throw new Error(`marketplace must not be touched after plugin remove failure: ${args.join(" ")}`);
    };
    const removed = uninstallCodexClient(fx.target, { env: fx.env, runCli: uninstallRun, runPromptScript: () => ok() });
    assert.equal(removed.ok, false);
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.equal(calls.some((args) => args[1] === "marketplace"), false, "marketplace remains so the failed plugin removal can be retried");
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), true, "ownership manifest remains for a safe retry");
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});