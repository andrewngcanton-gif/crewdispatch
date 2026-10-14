// mcp-real-cli.e2e.ts — REAL-ENTRY acceptance of the MCP dispatch path against
// the user-installed official `cmdc`, under a DISPOSABLE ISOLATED TEST PROFILE.
//
// Run with:  npm.cmd run test:e2e:mcp
//
// What this proves:
//   * the BUILT MCP server (`dist/mcp/server.js`) answers real JSON-RPC
//     initialize/tools/list/tools/call as a separate process;
//   * `jobquay_spawn` dispatches a job whose child is the REAL official CLI,
//     driven by the PRODUCTION path (caller env + requested cwd);
//   * the child reaches an honest terminal state and exactly one terminal state
//     is written, with no child left behind;
//   * the whole chain (the CLI probes and the prompt child) ran against the
//     DISPOSABLE isolated home the TEST created (sandbox sentinel).
//
// It does NOT claim a successful real task: with no dedicated test credential the
// real run stops at auth, so real success / real `--resume` remain an explicit
// gap covered by the regression suite. No paid prompt is sent and no
// credential is forwarded.
//
// SAFETY: never enumerates/reads/copies/deletes the real `~/.commandcode`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { createCliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a real cmdc child runs from the MCP entry under an isolated test profile and reaches an honest terminal state", { timeout: 300000 }, async () => {
  const resolution = resolveCommandCodeCli({});
  if (!resolution.ok || !resolution.path) {
    console.log(`[e2e:mcp] skipped: Command Code CLI not resolved (source=${resolution.source})`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-mcp-real-"));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "jobquay-mcp-iso-" });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const sentinel = path.join(iso.cliHome, "jobquay-sandbox-sentinel");
  fs.writeFileSync(sentinel, "jobquay-mcp-e2e-sandbox\n", "utf8");

  // The real-CLI gate verifies the provider boundary, not the Dashboard:
  // never start the shared Hub on the default port.
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, CREWDISPATCH_DISPATCH_DASHBOARD: "0" };
  const client = new McpStdioClient(MCP_ENTRY, env, dir);
  let jobId: string | null = null;
  try {
    const init = await client.initialize();
    assert.equal((init.serverInfo as Record<string, unknown>).name, "crewdispatch");
    const tools = (await client.listTools()).map((t) => String(t.name));
    assert.ok(tools.includes("crewdispatch_spawn"));

    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", {
        task: "Reply with the single word: pong",
        cwd: project,
        permission_mode: "plan"
      })
    );
    assert.equal(spawned.ok, true);
    jobId = String(spawned.job_id);
    assert.match(jobId, /^job-/);

    let job: Record<string, unknown> | null = null;
    const deadline = Date.now() + 240000;
    for (;;) {
      const r = McpStdioClient.json(await client.callTool("jobquay_result", { id: jobId }));
      if (TERMINAL.has(String(r.status))) {
        job = r;
        break;
      }
      if (Date.now() >= deadline) throw new Error("real cmdc job did not reach a terminal state in time");
      await sleep(500);
    }

    const result = job.result as Record<string, unknown> | null;
    console.log(
      "[e2e:mcp] real cmdc job:",
      JSON.stringify({
        status: job.status,
        generation: job.generation,
        exitCode: result?.exit_code ?? null,
        kind: result?.kind ?? null,
        notify: job.notify
      })
    );

    assert.notEqual(job.status, "done", "an unauthenticated run must not report success");
    assert.ok(job.finished_at, "a terminal state must carry finishedAt");

    const record = JSON.parse(fs.readFileSync(path.join(root, "jobs", `${jobId}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(path.resolve(String(record.cwd)), path.resolve(project), "the job must carry the requested project cwd");
    assert.equal(record.childPid, null, "no child process should remain after a terminal state");

    assert.equal(fs.existsSync(path.join(root, "cli-runs")), false, "production must not create a per-job CLI-isolation tree");
    assert.ok(fs.existsSync(sentinel), "the sandbox sentinel must be untouched");
    assert.ok(fs.existsSync(path.join(iso.cliHome, ".commandcode")), "the real CLI must have written into the isolated test profile home");
    console.log(`[e2e:mcp] isolated profile used: cliHome=${iso.cliHome}`);
  } finally {
    if (jobId) {
      try {
        await client.callTool("jobquay_cancel", { id: jobId, wait_seconds: 8 });
      } catch {
        /* best effort */
      }
    }
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
