import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliIsolation } from "../../cli/run-isolation";
import { DASHBOARD_FIRST_USE_HINT } from "../../onboarding/dashboard-hint";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function fixtureEcho(): string {
  return [
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-dashboard-hint" } });',
    '  out({ type: "result", subtype: "success", result: "OK", session_id: "fx-dashboard-hint", stop_reason: "end_turn" });',
    '  process.exit(0);',
    '});'
  ].join("\n");
}

async function waitTerminal(client: McpStdioClient, id: string): Promise<void> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(result.status))) return;
    if (Date.now() >= deadline) throw new Error("job " + id + " did not reach terminal state");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("MCP surfaces the Dashboard hint only on the first accepted dispatch for a data root", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-mcp-dashboard-hint-"));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "iso-dashboard-hint-" });
  const project = path.join(iso.root, "project");
  const fixture = path.join(dir, "fixture.js");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(fixture, fixtureEcho(), "utf8");
  const env = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  const client = new McpStdioClient(MCP_ENTRY, env, dir);
  try {
    await client.initialize();
    const first = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "first", cwd: project }));
    assert.equal(first.ok, true);
    assert.equal(first.dashboard_hint, DASHBOARD_FIRST_USE_HINT);
    await waitTerminal(client, String(first.job_id));

    const second = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "second", cwd: project }));
    assert.equal(second.ok, true);
    assert.equal(Object.prototype.hasOwnProperty.call(second, "dashboard_hint"), false);
    await waitTerminal(client, String(second.job_id));
  } finally {
    await client.close();
    await McpStdioClient.cleanupWorkspace(root, dir);
  }
});
