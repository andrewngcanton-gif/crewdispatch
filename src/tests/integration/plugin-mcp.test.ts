// plugin-mcp.test.ts — REAL verification that the plugin's generated `.mcp.json`
// can actually launch the CrewDispatch MCP server from a cwd that is NOT the repo.
//
// The old config used a RELATIVE entry ("dist/mcp/server.js"); an MCP host starts
// the server with its own working directory, so that relative path resolved
// against the host cwd and node failed with MODULE_NOT_FOUND (verified in
// the regression suite). The generator pins the entry to an absolute
// path derived from the checkout; this test generates an isolated config from the
// portable template, checks that the entry names this checkout's built server (canonical comparison:
// Windows paths are case-insensitive, so a drive-letter case difference like
// `D:\` vs `d:\` is the same file; POSIX stays case-sensitive) and then starts
// the server as a REAL separate process from a disposable temp cwd.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpStdioClient } from "../helpers/mcp-client";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "crewdispatch");
const TEMPLATE = path.join(PLUGIN_DIR, "mcp.template.json");
const GENERATOR = path.join(REPO_ROOT, "scripts", "generate-plugin-mcp.cjs");
// Canonical absolute path with platform filesystem semantics, mirroring the
// installer's own `canonical()` (src/install/manager.ts): Windows paths are
// case-insensitive (drive-letter case differences name the same file), other
// platforms keep exact case. String canonicalisation only — not a realpath
// lookup — so the assertion below still requires the entry to name exactly this
// checkout's `dist/mcp/server.js`, not just any existing file.
function canonical(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface McpConfig {
  mcpServers: Record<string, { command?: string; args?: string[] }>;
}

test("the generated plugin .mcp.json launches the built MCP server initialize/tools/list from a foreign cwd", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-plugin-cwd-"));
  const generatedPluginDir = path.join(dir, "plugin");
  fs.mkdirSync(generatedPluginDir, { recursive: true });
  fs.copyFileSync(TEMPLATE, path.join(generatedPluginDir, "mcp.template.json"));

  const expectedEntry = path.join(REPO_ROOT, "dist", "mcp", "server.js");
  const generated = spawnSync(
    process.execPath,
    [GENERATOR, "--plugin-dir", generatedPluginDir, "--entry", expectedEntry, "--quiet"],
    { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 30_000 }
  );
  assert.ifError(generated.error);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const configPath = path.join(generatedPluginDir, ".mcp.json");
  assert.ok(fs.existsSync(configPath), "the generator must create .mcp.json in the selected plugin directory");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as McpConfig;
  const server = cfg.mcpServers.crewdispatch;
  assert.ok(server, "the config must declare the `crewdispatch` server");
  assert.equal(path.resolve(server.command!), path.resolve(process.execPath), "generated MCP command must pin the current Node runtime");
  assert.ok(Array.isArray(server.args) && server.args.length === 1, "exactly one server entry argument");
  const entry = server.args![0]!;
  assert.equal(path.isAbsolute(entry), true, "the server entry must be an ABSOLUTE path (cwd-independent)");
  assert.equal(
    canonical(entry),
    canonical(expectedEntry),
    "the generated server entry must point at this checkout's built dist/mcp/server.js"
  );
  assert.ok(fs.existsSync(entry), "the configured entry must exist (build first)");

  // The committed migratable template keeps the placeholder and no hard-coded checkout path.
  const template = fs.readFileSync(TEMPLATE, "utf8");
  assert.ok(template.includes('"__CREWDISPATCH_SERVER_ENTRY__"'), "the template must keep the server-entry placeholder");
  assert.ok(template.includes('"__CREWDISPATCH_NODE_ENTRY__"'), "the template must keep the Node-entry placeholder");

  const root = path.join(dir, "root");
  const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: root };
  // A cwd that is deliberately NOT the repo root.
  const foreignCwd = path.join(dir, "elsewhere");
  fs.mkdirSync(foreignCwd, { recursive: true });
  const client = new McpStdioClient(entry, env, foreignCwd, server.command);
  try {
    const init = await client.initialize();
    const serverInfo = init.serverInfo as Record<string, unknown>;
    assert.equal(serverInfo.name, "crewdispatch", "the server must answer the real MCP handshake");
    const tools = (await client.listTools()).map((t) => String(t.name));
    assert.ok(tools.includes("crewdispatch_spawn"));
    assert.ok(tools.includes("crewdispatch_status"));
    assert.ok(tools.includes("crewdispatch_result"));
    assert.ok(tools.includes("crewdispatch_follow_up"));
    assert.ok(tools.includes("crewdispatch_cancel"));
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
