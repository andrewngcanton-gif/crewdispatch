// claude-client-install.test.ts — isolated user-scope installation tests for
// the Claude Code caller integration: install/reinstall/uninstall/doctor on
// disposable config directories and homes, preservation of unrelated settings,
// conflict handling, real hook execution in the installed layout and the CLI
// entry. The production user configuration is NEVER touched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserNodeRuntime } from "../../install/node-runtime";
import { doctorClaudeClient, installClaudeClient, resolveClaudeClientPaths, uninstallClaudeClient } from "../../claude/client-install";
import { listClaudeBindings, registerClaudeBinding } from "../../claude/binding";
import { RECOVERY_REQUEST_BUDGET_MS } from "../../daemon/client";
import { InstallError } from "../../install/manager";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const USER_NODE = resolveUserNodeRuntime()!.path;
const SKILL_SOURCE = path.join(REPO_ROOT, "plugins", "crewdispatch", "skills", "crewdispatch", "SKILL.md");
const COMMAND_SOURCE = path.join(REPO_ROOT, "integrations", "claude", "commands", "crewdispatch.md");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "mcp", "server.js");
const HOOK_ENTRY = path.join(REPO_ROOT, "dist", "claude", "hook.js");
const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli", "install-cli.js");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `crewdispatch-claude-install-${prefix}-`));
}

interface Sandbox {
  dir: string;
  configDir: string;
  home: string;
  dataRoot: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function sandbox(name: string): Sandbox {
  const dir = tmpDir(name);
  const configDir = path.join(dir, "claude-config");
  const home = path.join(dir, "home");
  const dataRoot = path.join(dir, "data");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  return { dir, configDir, home, dataRoot, env: { ...process.env, JOBQUAY_DATA_ROOT: dataRoot }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function userConfigFile(sb: Sandbox): string {
  return path.join(sb.configDir, ".claude.json");
}

function settingsFile(sb: Sandbox): string {
  return path.join(sb.configDir, "settings.json");
}

/** Seed unrelated user configuration that must survive every operation. */
function seedUnrelated(sb: Sandbox): void {
  fs.writeFileSync(
    userConfigFile(sb),
    `${JSON.stringify(
      {
        mcpServers: { "other-server": { command: "other", args: ["--x"] } },
        theme: "dark",
        projects: { "C:\\proj": { allowedTools: ["Read"] } }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    settingsFile(sb),
    `${JSON.stringify(
      {
        permissions: { allow: ["Bash(git status)"] },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo unrelated-start" }] }]
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function installOpts(sb: Sandbox) {
  return { configDir: sb.configDir, homeDir: sb.home, env: sb.env, sourceRoot: REPO_ROOT };
}

/**
 * Write a disposable CLI shim that prints the given `--version` output.
 * The caller places it in a directory whose path contains a space so the
 * Windows shell-quoting of the production probe is exercised for real.
 */
function writeCliShim(dir: string, output: string): string {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, `@echo off\r\necho ${output}\r\nexit /b 0\r\n`);
    return shim;
  }
  const shim = path.join(dir, "claude");
  fs.writeFileSync(shim, `#!/bin/sh\necho '${output}'\n`, "utf8");
  fs.chmodSync(shim, 0o755);
  return shim;
}

test("an isolated install writes only the managed entries/files and preserves everything else", () => {
  const sb = sandbox("install");
  try {
    seedUnrelated(sb);
    if (process.platform !== "win32") {
      fs.chmodSync(userConfigFile(sb), 0o640);
      fs.chmodSync(settingsFile(sb), 0o600);
    }
    const result = installClaudeClient(installOpts(sb));
    assert.equal(result.ok, true);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.secretsWritten, false);

    // User config: our MCP entry added; every unrelated key/value preserved.
    const config = readJson(userConfigFile(sb));
    assert.deepEqual(config.mcpServers, {
      "other-server": { command: "other", args: ["--x"] },
      crewdispatch: { command: USER_NODE, args: [SERVER_ENTRY] }
    });
    assert.equal(config.theme, "dark");
    assert.equal(((config.mcpServers as Record<string, Record<string, unknown>>).crewdispatch as Record<string, unknown>).command, USER_NODE, "MCP launch pins the stable user-managed Node runtime for sparse GUI PATHs");
    assert.deepEqual(config.projects, { "C:\\proj": { allowedTools: ["Read"] } });

    // Settings: our two hooks appended; unrelated hooks/settings preserved.
    const settings = readJson(settingsFile(sb));
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(userConfigFile(sb)).mode & 0o777, 0o640, "existing user-config mode is preserved exactly");
      assert.equal(fs.statSync(settingsFile(sb)).mode & 0o777, 0o600, "existing settings mode is preserved exactly");
      assert.equal(fs.statSync(path.join(sb.configDir, "crewdispatch-install.json")).mode & 0o777, 0o600, "managed manifest is private");
    }
    const hooks = settings.hooks as Record<string, unknown[]>;
    assert.equal(hooks.PreToolUse!.length, 1);
    assert.equal(hooks.SessionStart!.length, 2, "the unrelated SessionStart hook is preserved");
    assert.equal(JSON.stringify(hooks.SessionStart![0]).includes("echo unrelated-start"), true);
    const startCommand = ((hooks.SessionStart![1] as Record<string, unknown>).hooks as Array<Record<string, unknown>>)[0]!.command as string;
    assert.ok(startCommand.includes(HOOK_ENTRY));
    assert.ok(startCommand.includes("session-start"));
    const endCommand = ((hooks.SessionEnd![0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>)[0]!.command as string;
    assert.ok(endCommand.includes("session-end"));

    // Managed files match the shipped sources byte-for-byte.
    assert.equal(fs.readFileSync(path.join(sb.configDir, "skills", "crewdispatch", "SKILL.md"), "utf8"), fs.readFileSync(SKILL_SOURCE, "utf8"));
    assert.equal(fs.readFileSync(path.join(sb.configDir, "commands", "crewdispatch.md"), "utf8"), fs.readFileSync(COMMAND_SOURCE, "utf8"));

    // The manifest records hashes and paths but never a credential.
    const manifest = readJson(path.join(sb.configDir, "crewdispatch-install.json"));
    assert.equal(manifest.product, "crewdispatch");
    assert.equal(JSON.stringify(manifest).includes("token"), false);
    assert.equal(JSON.stringify(manifest).includes(sb.home), false, "no secret or home credential path is recorded");

    // Reinstall is idempotent: everything managed is preserved, no conflicts.
    const again = installClaudeClient(installOpts(sb));
    assert.equal(again.ok, true);
    assert.deepEqual(again.conflicts, []);
    for (const expected of ["mcpServers.crewdispatch", "hooks.SessionStart", "hooks.SessionEnd", "skills/crewdispatch/SKILL.md", "commands/crewdispatch.md"]) {
      assert.ok(again.preserved.includes(expected), `${expected} must be reported as preserved`);
    }
    assert.equal(readJson(userConfigFile(sb)).theme, "dark");
  } finally {
    sb.cleanup();
  }
});

test("a fresh config uses an absolute Node MCP command, private POSIX JSON modes, and uninstall restores absent files", () => {
  const sb = sandbox("fresh-private");
  try {
    assert.equal(fs.existsSync(userConfigFile(sb)), false);
    assert.equal(fs.existsSync(settingsFile(sb)), false);
    const installed = installClaudeClient(installOpts(sb));
    assert.equal(installed.ok, true);
    const entry = ((readJson(userConfigFile(sb)).mcpServers as Record<string, Record<string, unknown>>).crewdispatch as Record<string, unknown>);
    assert.equal(entry.command, USER_NODE);
    assert.ok(path.isAbsolute(String(entry.command)));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(userConfigFile(sb)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(settingsFile(sb)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(sb.configDir, "crewdispatch-install.json")).mode & 0o777, 0o600);
    }
    const uninstalled = uninstallClaudeClient(installOpts(sb));
    assert.equal(uninstalled.ok, true);
    assert.equal(fs.existsSync(userConfigFile(sb)), false, "installer-created user config is removed when it becomes empty");
    assert.equal(fs.existsSync(settingsFile(sb)), false, "installer-created settings are removed when they become empty");
  } finally {
    sb.cleanup();
  }
});

test("the installed SessionStart hook timeout outlasts the bounded recovery request budget", () => {
  // Cross-layer contract: the host's per-hook timeout must exceed the I/O
  // budget the hook code allows itself. With the old 10s host timeout Claude
  // could kill the real hook while its bounded 15s recovery request was still
  // running — before the request returned and before the hook guidance reached
  // stdout — so the advertised finite bound was unreachable on the installed
  // path.
  const sb = sandbox("hook-timeout");
  try {
    seedUnrelated(sb);
    const first = installClaudeClient(installOpts(sb));
    assert.equal(first.ok, true);
    assert.deepEqual(first.conflicts, []);

    const readTimeouts = (): { start: number; end: number } => {
      const hooks = readJson(settingsFile(sb)).hooks as Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
      return {
        start: hooks.SessionStart!.find((g) => JSON.stringify(g).includes("session-start"))!.hooks[0]!.timeout,
        end: hooks.SessionEnd!.find((g) => JSON.stringify(g).includes("session-end"))!.hooks[0]!.timeout
      };
    };

    const installed = readTimeouts();
    // Finite, and comfortably beyond the recovery budget (15s) plus the hook's
    // own registration and ordinary startup overhead.
    assert.ok(Number.isFinite(installed.start), "the host timeout stays finite");
    assert.ok(
      installed.start * 1000 > RECOVERY_REQUEST_BUDGET_MS,
      `the host budget ${installed.start}s must exceed the ${RECOVERY_REQUEST_BUDGET_MS}ms recovery request budget`
    );
    assert.ok(
      installed.start * 1000 >= RECOVERY_REQUEST_BUDGET_MS * 2,
      `the host budget must leave real headroom over the request budget, got ${installed.start}s`
    );
    // SessionEnd performs only the synchronous cleanup and no recovery
    // request, so it keeps its shorter bound.
    assert.equal(installed.end, 10);
  } finally {
    sb.cleanup();
  }
});

/** Rewrite the manifest's recorded SessionStart entry (the ownership snapshot). */
function setRecordedSessionStart(sb: Sandbox, entry: Record<string, unknown> | null): void {
  const manifestPath = path.join(sb.configDir, "crewdispatch-install.json");
  const manifest = readJson(manifestPath);
  (manifest.hookEntries as Record<string, unknown>).sessionStart = entry;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The single inner hook entry of the group whose command equals `command`. */
function innerWithCommand(list: unknown[], command: string): Record<string, unknown> | null {
  for (const group of list) {
    const inner = (group as { hooks?: unknown[] }).hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      if ((hook as { command?: unknown }).command === command) return hook as Record<string, unknown>;
    }
  }
  return null;
}

/** The installer's managed entry, located by EXACTLY the recorded command. */
function managedIndex(sb: Sandbox, command: string): number {
  const list = (readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!;
  const idx = list.findIndex((g) => innerWithCommand([g], command) !== null);
  assert.notEqual(idx, -1, "the managed entry must be present in the settings list");
  return idx;
}

/** Rewrite the live managed SessionStart entry, located by the recorded command. */
function setLiveSessionStart(sb: Sandbox, command: string, entry: Record<string, unknown>): void {
  const settings = readJson(settingsFile(sb));
  const list = settings.hooks as Record<string, unknown[]>;
  list.SessionStart![managedIndex(sb, command)] = entry;
  settings.hooks = list;
  fs.writeFileSync(settingsFile(sb), `${JSON.stringify(settings, null, 2)}\n`);
}

function liveStartEntry(sb: Sandbox, command: string): Record<string, unknown> {
  const list = (readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!;
  return list[managedIndex(sb, command)] as Record<string, unknown>;
}

test("an untouched managed hook entry upgrades, and any user edit to it is preserved", () => {
  // Ownership rule: the live entry is installer-owned ONLY while it deep-equals
  // the entry the manifest recorded. Compared EXACTLY — not normalized, not by
  // command match, and never "desired vs recorded".
  const sb = sandbox("hook-ownership");
  try {
    seedUnrelated(sb);
    assert.equal(installClaudeClient(installOpts(sb)).ok, true);
    const manifestPath = path.join(sb.configDir, "crewdispatch-install.json");
    const manifest = readJson(manifestPath);
    const recorded = (manifest.hookEntries as Record<string, { hooks: Array<Record<string, unknown>> }>).sessionStart!;
    const command = recorded.hooks[0]!.command as string;

    // (a) recorded 10 / live 10 — untouched managed state upgrades to 30.
    setLiveSessionStart(sb, command, { hooks: [{ type: "command", command, timeout: 10 }] });
    setRecordedSessionStart(sb, { hooks: [{ type: "command", command, timeout: 10 }] });
    const upgraded = installClaudeClient(installOpts(sb));
    assert.equal(upgraded.ok, true, "untouched managed state is not a conflict");
    assert.ok(
      upgraded.changed.some((c) => c.startsWith("hooks.SessionStart") && c.includes("upgraded")),
      "the untouched managed entry must be upgraded"
    );
    assert.equal((liveStartEntry(sb, command).hooks as Array<Record<string, unknown>>)[0]!.timeout, 30);

    // (b) recorded 30 / live 45 — the user changed the timeout by hand. It is
    //     a user edit and must be preserved and reported, even though the
    //     installer wants 30. (This is the exact parent repro shape.)
    setLiveSessionStart(sb, command, { hooks: [{ type: "command", command, timeout: 45 }] });
    const edited = installClaudeClient(installOpts(sb));
    assert.equal(edited.ok, false, "a user-edited timeout is a conflict");
    assert.ok(edited.conflicts.some((c) => c.target.endsWith("hooks.SessionStart")));
    assert.equal(
      (liveStartEntry(sb, command).hooks as Array<Record<string, unknown>>)[0]!.timeout,
      45,
      "the user's 45s must survive the reinstall"
    );

    // (c) A repeated reinstall must STILL report the conflict. If the conflict
    //     branch overwrote the manifest ownership snapshot with the desired
    //     entry, the user's 45s would silently become installer-owned.
    const again = installClaudeClient(installOpts(sb));
    assert.equal(again.ok, false, "the conflict must persist across reinstalls");
    assert.ok(again.conflicts.some((c) => c.target.endsWith("hooks.SessionStart")));
    assert.equal(
      (liveStartEntry(sb, command).hooks as Array<Record<string, unknown>>)[0]!.timeout,
      45,
      "a second reinstall must not adopt the user's edit as managed state"
    );
    // The recorded snapshot still describes the ORIGINAL managed state, not the
    // user's edit and not the desired entry.
    const afterManifest = readJson(manifestPath);
    assert.equal(
      ((afterManifest.hookEntries as Record<string, { hooks: Array<Record<string, unknown>> }>).sessionStart!.hooks[0] as Record<string, unknown>).timeout,
      30,
      "the recorded ownership snapshot must not be rewritten by a conflict"
    );

    // (d) An added key is a user edit too.
    setLiveSessionStart(sb, command, { hooks: [{ type: "command", command, timeout: 30, async: true }] });
    const addedKey = installClaudeClient(installOpts(sb));
    assert.equal(addedKey.ok, false);
    assert.equal(
      (liveStartEntry(sb, command).hooks as Array<Record<string, unknown>>)[0]!.async,
      true,
      "an added key is preserved"
    );

    // (e) A user who REPLACES our command entirely. Nothing of ours is left to
    //     conflict with, so the installer re-adds its own managed entry beside
    //     the user's — and the user's command must survive untouched.
    setLiveSessionStart(sb, command, { hooks: [{ type: "command", command: "echo mine", timeout: 30 }] });
    const commandEdit = installClaudeClient(installOpts(sb));
    const afterCommandEdit = (readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!;
    const userEntry = innerWithCommand(afterCommandEdit, "echo mine");
    assert.ok(userEntry, "the user's own hook is still present");
    assert.equal(userEntry!.timeout, 30);
    assert.ok(
      innerWithCommand(afterCommandEdit, command) !== null,
      "the managed entry is re-added alongside the user's own hook"
    );
    assert.ok(
      !JSON.stringify(afterCommandEdit).includes("echo mine\":false"),
      "the user's command string was not rewritten"
    );
    // Unrelated configuration is untouched throughout.
    assert.deepEqual(readJson(settingsFile(sb)).permissions, { allow: ["Bash(git status)"] });
  } finally {
    sb.cleanup();
  }
});

test("a moved install path upgrades only an untouched previous entry", () => {
  // The path-change branch replaces the PREVIOUSLY RECORDED entry. It must
  // apply the same exact ownership rule: untouched managed state moves to the
  // new path, a user-edited entry is preserved and reported.
  const sb = sandbox("hook-path-change");
  try {
    seedUnrelated(sb);
    assert.equal(installClaudeClient(installOpts(sb)).ok, true);
    const current = (readJson(path.join(sb.configDir, "crewdispatch-install.json")).hookEntries as Record<string, {
      hooks: Array<Record<string, unknown>>;
    }>).sessionStart!;
    const currentCommand = current.hooks[0]!.command as string;
    // Simulate an EARLIER install at a genuinely different path: a foreign hook
    // entry is live, and the manifest records it as ours.
    const oldHook = path.join(sb.dir, "old", "hook.js");
    const oldCommand = `"${process.execPath}" "${oldHook}" session-start`;
    const oldEntry = { hooks: [{ type: "command", command: oldCommand, timeout: 10 }] };
    setRecordedSessionStart(sb, oldEntry);
    setLiveSessionStart(sb, currentCommand, oldEntry);
    assert.ok(
      innerWithCommand((readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!, oldCommand) !== null,
      "the stale-path entry must be live"
    );

    // Untouched previous entry: the path change is an upgrade.
    const moved = installClaudeClient(installOpts(sb));
    assert.equal(moved.ok, true, "an untouched previous entry may be replaced when the install path moved");
    assert.ok(moved.changed.some((c) => c.startsWith("hooks.SessionStart") && c.includes("upgraded")));
    const live = (readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!;
    assert.equal(
      innerWithCommand(live, oldCommand),
      null,
      "the stale-path entry is replaced, not duplicated"
    );
    assert.ok(innerWithCommand(live, currentCommand) !== null, "the entry now points at the current install path");

    // Now the user edits the (current-path) managed entry, and the path moves
    // again. The user edit must win.
    setLiveSessionStart(sb, currentCommand, { hooks: [{ type: "command", command: currentCommand, timeout: 45 }] });
    setRecordedSessionStart(sb, current);
    const userMoved = installClaudeClient(installOpts(sb));
    assert.equal(userMoved.ok, false, "a user edit is a conflict even on the path-change branch");
    assert.ok(userMoved.conflicts.some((c) => c.target.endsWith("hooks.SessionStart")));
    const kept = innerWithCommand(
      (readJson(settingsFile(sb)).hooks as Record<string, unknown[]>).SessionStart!,
      currentCommand
    );
    assert.ok(kept, "the user's entry is still present");
    assert.equal(
      kept!.timeout,
      45,
      "the user's edit is preserved on the path-change branch"
    );
  } finally {
    sb.cleanup();
  }
});

test("a reinstall upgrades only entries/files the previous manifest owned", () => {
  const sb = sandbox("upgrade");
  try {
    installClaudeClient(installOpts(sb));
    const manifestPath = path.join(sb.configDir, "crewdispatch-install.json");
    const manifest = readJson(manifestPath);

    // Simulate an OLDER managed install: the config carries the previous
    // (recorded) shapes and the manifest records them as owned.
    const oldServer = path.join(sb.dir, "old", "server.js");
    const oldMcp = { command: "node", args: [oldServer] };
    const oldHook = path.join(sb.dir, "old", "hook.js");
    const oldStart = { hooks: [{ type: "command", command: `"${process.execPath}" "${oldHook}" session-start`, timeout: 10 }] };
    const config = readJson(userConfigFile(sb));
    (config.mcpServers as Record<string, unknown>).crewdispatch = oldMcp;
    fs.writeFileSync(userConfigFile(sb), `${JSON.stringify(config, null, 2)}\n`);
    const settings = readJson(settingsFile(sb));
    (settings.hooks as Record<string, unknown[]>).SessionStart = [oldStart];
    fs.writeFileSync(settingsFile(sb), `${JSON.stringify(settings, null, 2)}\n`);
    manifest.mcpEntry = oldMcp;
    (manifest.hookEntries as Record<string, unknown>).sessionStart = oldStart;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = installClaudeClient(installOpts(sb));
    assert.equal(result.ok, true);
    assert.deepEqual(result.conflicts, []);
    assert.ok(result.changed.some((c) => c.startsWith("mcpServers.crewdispatch") && c.includes("upgraded")));
    assert.ok(result.changed.some((c) => c.startsWith("hooks.SessionStart") && c.includes("upgraded")));
    assert.deepEqual((readJson(userConfigFile(sb)).mcpServers as Record<string, unknown>).crewdispatch, { command: USER_NODE, args: [SERVER_ENTRY] });
  } finally {
    sb.cleanup();
  }
});

test("a user-edited managed entry or file is reported as a conflict and preserved", () => {
  const sb = sandbox("conflict");
  try {
    installClaudeClient(installOpts(sb));
    // The user edits the skill file and replaces our MCP entry with their own.
    const skill = path.join(sb.configDir, "skills", "crewdispatch", "SKILL.md");
    fs.writeFileSync(skill, `${fs.readFileSync(skill, "utf8")}\nUSER EDIT\n`);
    const config = readJson(userConfigFile(sb));
    (config.mcpServers as Record<string, unknown>).crewdispatch = { command: "node", args: ["user-owned.js"] };
    fs.writeFileSync(userConfigFile(sb), `${JSON.stringify(config, null, 2)}\n`);

    const result = installClaudeClient(installOpts(sb));
    assert.equal(result.ok, false);
    assert.equal(result.conflicts.length >= 2, true);
    assert.equal(fs.readFileSync(skill, "utf8").includes("USER EDIT"), true, "the edited file is never overwritten");
    assert.deepEqual((readJson(userConfigFile(sb)).mcpServers as Record<string, unknown>).crewdispatch, { command: "node", args: ["user-owned.js"] });
  } finally {
    sb.cleanup();
  }
});

test("uninstall removes only managed, unmodified entries/files and preserves foreign edits", () => {
  const sb = sandbox("uninstall");
  try {
    seedUnrelated(sb);
    installClaudeClient(installOpts(sb));
    const skill = path.join(sb.configDir, "skills", "crewdispatch", "SKILL.md");
    fs.writeFileSync(skill, "EDITED AFTER INSTALL\n");

    const result = uninstallClaudeClient(installOpts(sb));
    assert.equal(result.ok, false, "the edited file is a reported conflict");
    assert.ok(result.conflicts.some((c) => c.target.includes("SKILL.md")));
    assert.equal(fs.existsSync(skill), true, "an edited managed file is preserved");
    assert.equal(fs.existsSync(path.join(sb.configDir, "commands", "crewdispatch.md")), false, "the untouched managed file is removed");

    const config = readJson(userConfigFile(sb));
    assert.equal((config.mcpServers as Record<string, unknown>).crewdispatch, undefined);
    assert.deepEqual((config.mcpServers as Record<string, unknown>)["other-server"], { command: "other", args: ["--x"] });
    assert.equal(config.theme, "dark");
    const settings = readJson(settingsFile(sb));
    const hooks = settings.hooks as Record<string, unknown[]>;
    assert.equal(hooks.SessionStart!.length, 1, "the unrelated SessionStart hook survives");
    assert.equal(JSON.stringify(hooks.SessionStart![0]).includes("echo unrelated-start"), true);
    assert.equal(hooks.SessionEnd, undefined, "an empty managed event is removed");
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] });
    assert.equal(fs.existsSync(path.join(sb.configDir, "crewdispatch-install.json")), false, "the manifest is removed last");

    assert.throws(
      () => uninstallClaudeClient(installOpts(sb)),
      (e: unknown) => e instanceof InstallError && e.code === "not_managed"
    );
  } finally {
    sb.cleanup();
  }
});

test("malformed or linked user configuration is refused instead of overwritten", (t) => {
  const sb = sandbox("refuse");
  try {
    fs.writeFileSync(userConfigFile(sb), "{not json");
    assert.throws(
      () => installClaudeClient(installOpts(sb)),
      (e: unknown) => e instanceof InstallError && e.code === "invalid_user_config"
    );
    assert.equal(fs.readFileSync(userConfigFile(sb), "utf8"), "{not json", "the malformed file is untouched");

    fs.rmSync(userConfigFile(sb));
    const target = path.join(sb.dir, "target-settings.json");
    fs.writeFileSync(target, "{}\n");
    try {
      fs.symlinkSync(target, settingsFile(sb), "file");
    } catch {
      t.diagnostic("symlink creation refused by the OS; the linked-settings case is skipped");
      return;
    }
    assert.throws(
      () => installClaudeClient(installOpts(sb)),
      (e: unknown) => e instanceof InstallError && e.code === "unsafe_managed_file"
    );
    assert.equal(fs.readFileSync(target, "utf8"), "{}\n", "the link target is untouched");
  } finally {
    sb.cleanup();
  }
});

test("config locations resolve to the official default or the explicit directory, with spaces preserved", () => {
  const home = tmpDir("paths-home");
  const explicit = path.join(tmpDir("paths-explicit"), "dir with spaces", "claude cfg");
  try {
    const def = resolveClaudeClientPaths({ homeDir: home, env: {} as NodeJS.ProcessEnv });
    assert.equal(def.configDir, path.join(home, ".claude"));
    assert.equal(def.userConfigFile, path.join(home, ".claude.json"));
    assert.equal(def.explicitConfigDir, false);

    const envDir = resolveClaudeClientPaths({ homeDir: home, env: { CLAUDE_CONFIG_DIR: explicit } as NodeJS.ProcessEnv });
    assert.equal(envDir.configDir, path.resolve(explicit));
    assert.equal(envDir.userConfigFile, path.join(path.resolve(explicit), ".claude.json"));
    assert.equal(envDir.settingsFile, path.join(path.resolve(explicit), "settings.json"));

    const opt = resolveClaudeClientPaths({ homeDir: home, configDir: explicit, env: { CLAUDE_CONFIG_DIR: path.join(home, "ignored") } as NodeJS.ProcessEnv });
    assert.equal(opt.configDir, path.resolve(explicit), "an explicit option wins over the environment");

    // A real install into the default layout puts the user config next to the
    // home and the settings under ~/.claude.
    const result = installClaudeClient({ homeDir: home, env: {} as NodeJS.ProcessEnv, sourceRoot: REPO_ROOT });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(home, ".claude.json")), true);
    assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), true);

    // A path with spaces installs and uninstalls cleanly.
    const spaced = installClaudeClient({ configDir: explicit, env: {} as NodeJS.ProcessEnv, sourceRoot: REPO_ROOT });
    assert.equal(spaced.ok, true);
    const removed = uninstallClaudeClient({ configDir: explicit, env: {} as NodeJS.ProcessEnv, sourceRoot: REPO_ROOT });
    assert.equal(removed.ok, true);
    assert.equal(fs.existsSync(path.join(path.resolve(explicit), "commands", "crewdispatch.md")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(explicit)), { recursive: true, force: true });
  }
});

test("doctor separates install integrity and the MCP probe from wake capability", async () => {
  const sb = sandbox("doctor");
  try {
    installClaudeClient(installOpts(sb));
    const report = (await doctorClaudeClient(installOpts(sb))) as Record<string, unknown>;
    assert.equal(report.ok, true);
    const checks = report.checks as Record<string, unknown>;
    assert.equal((checks.manifest as Record<string, unknown>).ok, true);
    assert.equal((checks.mcpRegistration as Record<string, unknown>).ok, true);
    assert.equal((checks.hooks as Record<string, unknown>).ok, true);
    assert.equal((checks.mcpProbe as Record<string, unknown>).ok, true, "the installed server entry must answer initialize + tools/list");
    const wake = checks.wake as Record<string, unknown>;
    assert.equal(wake.status, "no_binding");
    assert.equal(wake.visibleReceiptProven, false, "wake receipt is never claimed from an install check");

    // A registered binding is reported as registration evidence only.
    const token = "doctor-secret-token-marker";
    registerClaudeBinding(sb.dataRoot, { sessionId: "11111111-2222-4333-8444-555555555555", socket: "\\\\.\\pipe\\doctor-test", token });
    const withBinding = (await doctorClaudeClient(installOpts(sb))) as Record<string, unknown>;
    const wake2 = (withBinding.checks as Record<string, unknown>).wake as Record<string, unknown>;
    assert.equal(wake2.status, "binding_registered");
    assert.equal(wake2.bindingCount, 1);
    assert.deepEqual(wake2.sessions, ["11111111-2222-4333-8444-555555555555"]);
    assert.equal(JSON.stringify(withBinding).includes(token), false, "doctor must never read or print the token");
    assert.equal(listClaudeBindings(sb.dataRoot).length, 1);

    // A missing install is a conflict, not a crash.
    const empty = sandbox("doctor-empty");
    try {
      const missing = (await doctorClaudeClient(installOpts(empty))) as Record<string, unknown>;
      assert.equal(missing.ok, false);
      assert.ok((missing.conflicts as Array<Record<string, unknown>>).some((c) => String(c.reason).includes("manifest")));
    } finally {
      empty.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("doctor parses the real --version shape, older versions and malformed output", { timeout: 60000 }, async () => {
  const sb = sandbox("doctor-cli");
  try {
    installClaudeClient(installOpts(sb));
    // The shim lives in a path containing a space: the production probe must
    // quote the executable on Windows (an unquoted spaced path fails in cmd).
    const shimDir = path.join(sb.dir, "claude bin");
    const runDoctor = async (output: string) => {
      const shim = writeCliShim(shimDir, output);
      const report = (await doctorClaudeClient({ ...installOpts(sb), claudeCliPath: shim })) as Record<string, unknown>;
      return {
        cli: (report.checks as Record<string, unknown>).claudeCli as Record<string, unknown>,
        warnings: report.warnings as string[]
      };
    };

    // Official installed output (exit 0): the semantic version is extracted —
    // the old parser returned the last token, i.e. "Code)".
    const official = await runDoctor("2.1.286 (Claude Code)");
    assert.equal(official.cli.available, true);
    assert.equal(official.cli.version, "2.1.286");
    assert.equal(official.cli.meetsMessagingMin, true);
    assert.equal(official.warnings.some((w) => w.includes("2.1.286")), false, "a supported version must not warn");

    // Exactly the documented minimum stays supported.
    const boundary = await runDoctor("2.1.248 (Claude Code)");
    assert.equal(boundary.cli.version, "2.1.248");
    assert.equal(boundary.cli.meetsMessagingMin, true);

    // An older host below the minimum is reported as unsupported, with both versions named.
    const older = await runDoctor("2.1.247 (Claude Code)");
    assert.equal(older.cli.version, "2.1.247");
    assert.equal(older.cli.meetsMessagingMin, false);
    assert.ok(older.warnings.some((w) => w.includes("2.1.247") && w.includes("2.1.248")));

    // Malformed output: the CLI ran, but no version is invented and the
    // compatibility warning states that the version could not be parsed.
    const malformed = await runDoctor("Claude Code development build");
    assert.equal(malformed.cli.available, true);
    assert.equal(malformed.cli.version, null);
    assert.equal(malformed.cli.meetsMessagingMin, null);
    assert.ok(malformed.warnings.some((w) => w.includes("could not be parsed")));
  } finally {
    sb.cleanup();
  }
});

test("the installed hook command executes in the installed layout and cleans up exactly", () => {
  const sb = sandbox("hook");
  try {
    installClaudeClient(installOpts(sb));
    const settings = readJson(settingsFile(sb));
    const hooks = settings.hooks as Record<string, unknown[]>;
    const startCommand = ((hooks.SessionStart![0] as Record<string, unknown>).hooks as Array<Record<string, unknown>>)[0]!.command as string;
    // The recorded command names the real compiled hook entry with a mode.
    assert.ok(startCommand.includes("session-start"));
    assert.ok(startCommand.includes("hook.js"));

    const session = "21212121-4343-4545-8787-898989898989";
    const token = "installed-hook-token-marker";
    const socket = process.platform === "win32" ? "\\\\.\\pipe\\crewdispatch-installed-hook" : "/tmp/crewdispatch-installed-hook.sock";
    const env = { ...sb.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token };
    const started = spawnSync(process.execPath, [HOOK_ENTRY, "session-start"], {
      input: JSON.stringify({ session_id: session, hook_event_name: "SessionStart" }),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env
    });
    assert.equal(started.status, 0);
    assert.ok(started.stdout.includes(session));
    assert.equal(started.stdout.includes(token), false);
    assert.equal(started.stdout.includes(socket), false);
    const bindings = listClaudeBindings(sb.dataRoot);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]!.sessionId, session);

    const ended = spawnSync(process.execPath, [HOOK_ENTRY, "session-end"], {
      input: JSON.stringify({ session_id: session, hook_event_name: "SessionEnd" }),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env
    });
    assert.equal(ended.status, 0);
    assert.equal(listClaudeBindings(sb.dataRoot).length, 0);
  } finally {
    sb.cleanup();
  }
});

test("a hand-edited manifest cannot make uninstall follow a path outside the config directory", () => {
  const sb = sandbox("traversal");
  try {
    installClaudeClient(installOpts(sb));
    const outside = path.join(sb.dir, "outside.txt");
    fs.writeFileSync(outside, "OUTSIDE\n");
    const manifestPath = path.join(sb.configDir, "crewdispatch-install.json");
    const manifest = readJson(manifestPath);
    // A hostile/broken record whose path escapes the config directory, with the
    // matching hash, must still never be followed or deleted.
    const escapedHash = crypto.createHash("sha256").update(fs.readFileSync(outside)).digest("hex");
    (manifest.files as Array<Record<string, unknown>>).push({ path: "../outside.txt", sha256: escapedHash });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = uninstallClaudeClient(installOpts(sb));
    assert.equal(result.ok, false);
    assert.ok(result.conflicts.some((c) => String(c.reason).includes("escapes the config directory")));
    assert.equal(fs.readFileSync(outside, "utf8"), "OUTSIDE\n", "the outside file is never deleted");
  } finally {
    sb.cleanup();
  }
});

test("the CLI entry installs, diagnoses and uninstalls an explicit config directory", { timeout: 60000 }, async () => {
  const sb = sandbox("cli");
  try {
    const run = (args: string[], timeout = 30000) =>
      spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: "utf8", timeout, windowsHide: true, env: sb.env });
    const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

    const installed = run(["claude-install", "--config", sb.configDir]);
    assert.equal(installed.status, 0, installed.stderr);
    const installReport = json(installed.stdout);
    assert.equal(installReport.ok, true);
    assert.equal(installReport.command, "claude-install");
    assert.equal(installReport.secretsWritten, false);

    const reinstall = run(["claude-reinstall", "--config", sb.configDir]);
    assert.equal(reinstall.status, 0);
    assert.equal(json(reinstall.stdout).ok, true);

    const doctor = run(["claude-doctor", "--config", sb.configDir]);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert.equal(json(doctor.stdout).ok, true);

    // --target does not apply to the user-level Claude install.
    const badTarget = run(["claude-install", "--target", sb.dir]);
    assert.equal(badTarget.status, 2);
    assert.equal((json(badTarget.stdout).error as Record<string, unknown>).code, "unsupported_option");

    const uninstalled = run(["claude-uninstall", "--config", sb.configDir]);
    assert.equal(uninstalled.status, 0);
    assert.equal(json(uninstalled.stdout).ok, true);

    const after = run(["claude-doctor", "--config", sb.configDir]);
    assert.equal(after.status, 1, "doctor must fail when nothing is installed");
    assert.equal(json(after.stdout).ok, false);
  } finally {
    sb.cleanup();
  }
});

test("the hook never blocks a session even when the data root is unusable", () => {
  const sb = sandbox("hook-fail");
  try {
    // A data root that cannot be created (a file in the way) must not fail the hook.
    const blocked = path.join(sb.dir, "blocked-root");
    fs.writeFileSync(blocked, "not a directory");
    const result = spawnSync(process.execPath, [HOOK_ENTRY, "session-start"], {
      input: JSON.stringify({ session_id: "31313131-5353-4545-8787-919191919191" }),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      env: { ...sb.env, JOBQUAY_DATA_ROOT: blocked, CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\x", CLAUDE_CODE_MESSAGING_TOKEN: "t" }
    });
    assert.equal(result.status, 0, "the hook always exits 0");
  } finally {
    sb.cleanup();
  }
});
