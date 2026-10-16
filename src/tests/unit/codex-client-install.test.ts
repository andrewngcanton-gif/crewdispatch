import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_INSTALL_MANIFEST,
  CODEX_MARKETPLACE_NAME,
  CODEX_PLUGIN_ID,
  canonicalCodexOwnershipPath,
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

test("Windows ownership path identity treats extended-length and ordinary local paths as identical", () => {
  const ordinary = "C:\\Users\\Jeff\\AppData\\Local\\Programs\\CrewDispatch";
  const extended = "\\\\?\\C:\\Users\\Jeff\\AppData\\Local\\Programs\\CrewDispatch";
  assert.equal(canonicalCodexOwnershipPath(ordinary, "win32"), canonicalCodexOwnershipPath(extended, "win32"));
});

test("Windows uninstall treats Codex's \\\\?\\ marketplace path as the same owned install root", { skip: process.platform !== "win32" }, () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    const installRun = (args: string[]): CodexCliResult => {
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected install command: ${args.join(" ")}`);
    };
    assert.equal(installCodexClient(fx.target, { env: fx.env, platform: "win32", runCli: installRun, runPromptScript: () => ok() }).ok, true);

    const extendedRoot = `\\\\?\\${fx.target}`;
    const uninstallRun = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") {
        return ok({ installed: [{ pluginId: CODEX_PLUGIN_ID, marketplaceSource: { sourceType: "local", source: extendedRoot } }] });
      }
      if (args[0] === "plugin" && args[1] === "remove") return ok({ pluginId: CODEX_PLUGIN_ID });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
        return ok({ marketplaces: [{ name: CODEX_MARKETPLACE_NAME, root: extendedRoot }] });
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      return fail(`unexpected uninstall command: ${args.join(" ")}`);
    };

    const removed = uninstallCodexClient(fx.target, { env: fx.env, platform: "win32", runCli: uninstallRun, runPromptScript: () => ok() });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace remove ${CODEX_MARKETPLACE_NAME} --json`));
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("macOS uninstall resolves symlinked marketplace roots to the same owned filesystem directory", { skip: process.platform !== "darwin" }, () => {
  const fx = fixture();
  const alias = path.join(fx.root, "runtime-alias");
  const calls: string[][] = [];
  try {
    fs.symlinkSync(fx.target, alias, "dir");
    const installRun = (args: string[]): CodexCliResult => {
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected install command: ${args.join(" ")}`);
    };
    assert.equal(installCodexClient(alias, { env: fx.env, platform: "darwin", runCli: installRun, runPromptScript: () => ok() }).ok, true);

    const uninstallRun = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") {
        return ok({ installed: [{ pluginId: CODEX_PLUGIN_ID, marketplaceSource: { sourceType: "local", source: fx.target } }] });
      }
      if (args[0] === "plugin" && args[1] === "remove") return ok({ pluginId: CODEX_PLUGIN_ID });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {
        return ok({ marketplaces: [{ name: CODEX_MARKETPLACE_NAME, root: fx.target }] });
      }
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      return fail(`unexpected uninstall command: ${args.join(" ")}`);
    };

    const removed = uninstallCodexClient(alias, { env: fx.env, platform: "darwin", runCli: uninstallRun, runPromptScript: () => ok() });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace remove ${CODEX_MARKETPLACE_NAME} --json`));
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("Codex caller install registers the local marketplace/plugin and uninstall removes only the owned registration", () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    const runCli = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID, version: "0.1.8" });
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

test("Codex caller uninstall removes manifest-owned registrations when marketplace snapshot listing fails", () => {
  const fx = fixture();
  const calls: string[][] = [];
  try {
    const installRun = (args: string[]): CodexCliResult => {
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected install command: ${args.join(" ")}`);
    };
    assert.equal(installCodexClient(fx.target, { env: fx.env, runCli: installRun, runPromptScript: () => ok() }).ok, true);

    const uninstallRun = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") return fail("marketplace root does not contain a supported manifest");
      if (args[0] === "plugin" && args[1] === "remove") return ok({ pluginId: CODEX_PLUGIN_ID });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return fail("failed to load marketplace(s)");
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      return fail(`unexpected uninstall command: ${args.join(" ")}`);
    };

    const removed = uninstallCodexClient(fx.target, { env: fx.env, runCli: uninstallRun, runPromptScript: () => ok() });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace remove ${CODEX_MARKETPLACE_NAME} --json`));
    assert.equal(fs.existsSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST)), false);
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

test("Codex caller install retires an owned registration whose previous install target is gone", () => {
  const fx = fixture();
  const staleTarget = path.join(fx.root, "old-runtime");
  const calls: string[][] = [];
  try {
    fs.mkdirSync(fx.codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(fx.codexHome, CODEX_INSTALL_MANIFEST),
      `${JSON.stringify({
        product: "crewdispatch",
        formatVersion: 1,
        target: staleTarget,
        marketplaceInstalled: true,
        pluginInstalled: true,
        promptInstalled: true
      }, null, 2)}\n`,
      "utf8"
    );

    const runCli = (args: string[]): CodexCliResult => {
      calls.push([...args]);
      if (args[0] === "plugin" && args[1] === "list") return fail("stale marketplace root");
      if (args[0] === "plugin" && args[1] === "remove") return ok({ pluginId: CODEX_PLUGIN_ID });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") return fail("stale marketplace root");
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") return ok({ marketplaceName: CODEX_MARKETPLACE_NAME });
      if (args[0] === "plugin" && args[1] === "add") return ok({ pluginId: CODEX_PLUGIN_ID });
      return fail(`unexpected command: ${args.join(" ")}`);
    };

    const installed = installCodexClient(fx.target, { env: fx.env, runCli, runPromptScript: () => ok() });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.ok(installed.warnings.some((warning) => /stale CrewDispatch Codex registration/.test(warning)));
    assert.ok(calls.some((args) => args.join(" ") === `plugin remove ${CODEX_PLUGIN_ID} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace remove ${CODEX_MARKETPLACE_NAME} --json`));
    assert.ok(calls.some((args) => args.join(" ") === `plugin marketplace add ${fx.target} --json`));
    const manifest = JSON.parse(fs.readFileSync(path.join(fx.codexHome, CODEX_INSTALL_MANIFEST), "utf8")) as Record<string, unknown>;
    assert.equal(manifest.target, fx.target);
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