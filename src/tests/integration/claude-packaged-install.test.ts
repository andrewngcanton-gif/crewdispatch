// claude-packaged-install.test.ts — the PACKAGED-runtime regression for the
// Claude caller integration. Every earlier suite used the source checkout as
// `sourceRoot` and therefore could not see that the production payload copier
// (`copyPayload`) did not carry the Claude command asset. This test exercises
// the real packaging path: the production installer copies the runtime into a
// disposable target, the Claude user install then runs FROM that packaged
// runtime against an isolated config directory and data root, and the
// generated MCP entry and hook commands are invoked exactly as recorded.
// Reinstall/uninstall keep the normal managed-file protection. No production
// config, home or data root is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdioClient } from "../helpers/mcp-client";
import { listClaudeBindings } from "../../claude/binding";
import { RECOVERY_REQUEST_BUDGET_MS } from "../../daemon/client";
import { resolveUserNodeRuntime } from "../../install/node-runtime";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ACCEPT_SOURCE_ROOT = process.env.JOBQUAY_ACCEPT_SOURCE_ROOT?.trim() || null;
if (ACCEPT_SOURCE_ROOT && !path.isAbsolute(ACCEPT_SOURCE_ROOT)) {
  throw new Error("JOBQUAY_ACCEPT_SOURCE_ROOT must be an absolute unpacked candidate root");
}
const SOURCE_ROOT = ACCEPT_SOURCE_ROOT ? fs.realpathSync.native(path.resolve(ACCEPT_SOURCE_ROOT)) : REPO_ROOT;
const SOURCE_INSTALLER = path.join(SOURCE_ROOT, "dist", "cli", "install-cli.js");
const SOURCE_COMMAND = path.join(SOURCE_ROOT, "integrations", "claude", "commands", "crewdispatch.md");

function run(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 900000) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  assert.ifError(result.error);
  return result;
}

/** Parse a recorded hook command `"<node>" "<hook.js>" <mode>` (quotes optional). */
function parseHookCommand(command: string): { node: string; hook: string; mode: string } {
  const m = /^(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s+(\S+)$/.exec(command.trim());
  assert.ok(m, `unexpected hook command shape: ${command}`);
  return { node: (m[1] ?? m[2])!, hook: (m[3] ?? m[4])!, mode: m[5]! };
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("the packaged runtime carries the Claude assets and installs/wakes from its own layout", { timeout: 900000 }, async () => {
  if (ACCEPT_SOURCE_ROOT) {
    const pkg = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(pkg.version, "0.1.3", "exact-artifact Claude acceptance requires the 0.1.3 candidate");
    assert.equal(pkg.license, "Apache-2.0");
  }
  const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "jobquay-claude-packaged-"));
  const runtime = path.join(tempRoot, "runtime");
  const configDir = path.join(tempRoot, "claude-config");
  const dataRoot = path.join(tempRoot, "data");
  const foreignCwd = path.join(tempRoot, "foreign-cwd");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(foreignCwd, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(tempRoot, "autostart.json"),
    JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(tempRoot, "LaunchAgents"),
    JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(tempRoot, "launchctl-state.json")
  };
  const sessionId = "7b7b7b7b-1234-4abc-8def-0123456789ab";
  const socket = process.platform === "win32" ? "\\\\.\\pipe\\claude-packaged-test" : "/tmp/claude-packaged-test.sock";
  const token = "packaged-layout-token-marker";
  let client: McpStdioClient | null = null;
  try {
    // 1. The REAL production installer packages the runtime into a disposable
    // target (this is the copyPayload path the parent probe exposed).
    const installed = run(SOURCE_INSTALLER, ["install", "--target", runtime], foreignCwd, env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal((JSON.parse(installed.stdout) as Record<string, unknown>).ok, true);

    // The Claude command asset travels with the payload, byte-identical.
    const packagedCommand = path.join(runtime, "integrations", "claude", "commands", "crewdispatch.md");
    assert.equal(fs.existsSync(packagedCommand), true, "the packaged runtime must carry the Claude command asset");
    assert.equal(sha256(packagedCommand), sha256(SOURCE_COMMAND));

    // 2. The PACKAGED runtime installs the Claude caller integration into an
    // isolated config directory — never the production one.
    const runtimeInstaller = path.join(runtime, "dist", "cli", "install-cli.js");
    const claudeInstall = run(runtimeInstaller, ["claude-install", "--config", configDir], foreignCwd, env);
    assert.equal(claudeInstall.status, 0, claudeInstall.stderr || claudeInstall.stdout);
    const claudeJson = JSON.parse(claudeInstall.stdout) as Record<string, unknown>;
    assert.equal(claudeJson.ok, true);
    assert.equal(claudeJson.secretsWritten, false, "no credential may be written by the install");

    // The generated MCP entry pins the exact Node runtime and points INTO the packaged runtime.
    // This must not rely on a GUI/LaunchAgent PATH containing a bare `node` executable.
    const userConfig = JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8")) as {
      mcpServers: { crewdispatch: { command: string; args: string[] } };
    };
    assert.equal(
      path.resolve(userConfig.mcpServers.crewdispatch.command),
      path.resolve(resolveUserNodeRuntime()!.path),
      "Claude MCP config pins the stable user-managed Node path discovered from PATH"
    );
    const serverEntry = path.resolve(userConfig.mcpServers.crewdispatch.args[0]!);
    assert.equal(serverEntry, path.join(runtime, "dist", "mcp", "server.js"));
    assert.equal(serverEntry.startsWith(SOURCE_ROOT), false, "the packaged entry must not point back at its source candidate/checkout");
    assert.equal(serverEntry.startsWith(REPO_ROOT), false, "the packaged entry must not point at the source checkout");

    // The generated hook commands point at the packaged hook entry.
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, "settings.json"), "utf8")) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string; timeout: number }> }>;
        SessionEnd: Array<{ hooks: Array<{ command: string; timeout: number }> }>;
      };
    };
    const start = parseHookCommand(settings.hooks.SessionStart[0]!.hooks[0]!.command);
    const end = parseHookCommand(settings.hooks.SessionEnd[0]!.hooks[0]!.command);
    assert.equal(path.resolve(start.hook), path.join(runtime, "dist", "claude", "hook.js"));
    assert.equal(start.mode, "session-start");
    assert.equal(end.mode, "session-end");

    // The PACKAGED layout must carry the same host budgets: SessionStart has to
    // outlast the bounded recovery request, or the host kills the real hook
    // before its bounded request (and its stdout guidance) can complete.
    assert.ok(
      settings.hooks.SessionStart[0]!.hooks[0]!.timeout * 1000 > RECOVERY_REQUEST_BUDGET_MS,
      `the packaged SessionStart host budget ${settings.hooks.SessionStart[0]!.hooks[0]!.timeout}s must exceed the ${RECOVERY_REQUEST_BUDGET_MS}ms recovery request budget`
    );
    assert.equal(settings.hooks.SessionEnd[0]!.hooks[0]!.timeout, 10);

    // 3. The generated MCP server starts from the packaged layout with the
    // isolated data root and serves the caller tools.
    client = new McpStdioClient(serverEntry, env, foreignCwd);
    await client.initialize();
    const tools = (await client.listTools()).map((tool) => String(tool.name));
    for (const required of ["crewdispatch_spawn", "crewdispatch_result", "crewdispatch_follow_up", "crewdispatch_status"]) {
      assert.equal(tools.includes(required), true, `the packaged MCP server must expose ${required}`);
    }

    // 4. The generated SessionStart hook command runs as recorded and registers
    // the exact session in the isolated data root; the SessionEnd command with
    // the same token cleans it up.
    const hookEnv: NodeJS.ProcessEnv = {
      ...env,
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_CODE_MESSAGING_TOKEN: token
    };
    const started = spawnSync(start.node, [start.hook, start.mode], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd: foreignCwd }),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: hookEnv
    });
    assert.ifError(started.error);
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /claude_session_id="/);
    assert.equal(started.stdout.includes(token), false, "the guidance must never carry the token");
    const registered = listClaudeBindings(dataRoot);
    assert.equal(registered.length, 1);
    assert.equal(registered[0]!.sessionId, sessionId);
    assert.equal(registered[0]!.token, token);

    const ended = spawnSync(end.node, [end.hook, end.mode], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionEnd" }),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: hookEnv
    });
    assert.ifError(ended.error);
    assert.equal(ended.status, 0, ended.stderr);
    assert.equal(listClaudeBindings(dataRoot).length, 0, "the exact incarnation is cleaned up");

    // 5. Reinstall is idempotent; an edited managed file is a conflict that is
    // preserved; uninstall removes only unmodified managed assets.
    const reinstall = run(runtimeInstaller, ["claude-reinstall", "--config", configDir], foreignCwd, env);
    assert.equal(reinstall.status, 0, reinstall.stderr || reinstall.stdout);
    assert.equal((JSON.parse(reinstall.stdout) as Record<string, unknown>).ok, true, "a clean reinstall reports no conflict");

    const installedSkill = path.join(configDir, "skills", "crewdispatch", "SKILL.md");
    fs.writeFileSync(installedSkill, `${fs.readFileSync(installedSkill, "utf8")}\nUSER EDIT MUST SURVIVE\n`, "utf8");
    const conflicted = run(runtimeInstaller, ["claude-reinstall", "--config", configDir], foreignCwd, env);
    const conflictedJson = JSON.parse(conflicted.stdout) as { ok: boolean; conflicts: Array<{ target: string }> };
    assert.equal(conflictedJson.ok, false, "an edited managed file is a reported conflict");
    assert.ok(conflictedJson.conflicts.some((c) => c.target.includes("SKILL.md")));
    assert.equal(fs.readFileSync(installedSkill, "utf8").includes("USER EDIT MUST SURVIVE"), true, "the edit is never overwritten");

    // After the conflict the edited file has left the managed set: uninstall
    // removes the remaining managed assets and leaves the user's file alone.
    const removed = run(runtimeInstaller, ["claude-uninstall", "--config", configDir], foreignCwd, env);
    const removedJson = JSON.parse(removed.stdout) as { ok: boolean; conflicts: Array<{ target: string }> };
    assert.equal(removedJson.ok, true, "the edited file is no longer managed, so uninstall reports no conflict");
    assert.equal(fs.existsSync(installedSkill), true, "the edited managed file is preserved");
    assert.equal(fs.readFileSync(installedSkill, "utf8").includes("USER EDIT MUST SURVIVE"), true);
    assert.equal(fs.existsSync(path.join(configDir, "commands", "crewdispatch.md")), false, "an unmodified managed file is removed");
    assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), false, "an installer-created user config is restored to absent once its managed entry is removed");
    assert.equal(fs.existsSync(path.join(configDir, "settings.json")), false, "installer-created settings are restored to absent once managed hooks are removed");
    assert.equal(fs.existsSync(path.join(configDir, "crewdispatch-install.json")), false, "the manifest is removed last");
  } finally {
    if (client) await client.close().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
