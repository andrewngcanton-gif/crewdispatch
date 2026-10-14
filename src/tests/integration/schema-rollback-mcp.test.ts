// schema-rollback-mcp.test.ts — CROSS-PROCESS acceptance of the ROLLBACK
// version gate at the REAL entry (`dist/mcp/server.js`).
//
// A rollback that swaps back the installation files must never silently misread
// data written by a NEWER build. This test seeds a unique, TEST-OWNED
// `JOBQUAY_DATA_ROOT` (inside a disposable temp tree, with an untouched profile
// sentinel) with:
//   * ONE synthetic job record whose `schemaVersion` is JOB_SCHEMA_VERSION + 1.
//     It is deliberately TERMINAL, so a build that misread it would not only
//     return a success result but also attempt the terminal wake — extra file
//     evidence a regression cannot hide;
//   * ONE synthetic `config.json` whose `configVersion` is CONFIG_VERSION + 1
//     (only whitelisted keys, so the version gate — not an unknown field — is
//     what refuses it).
//
// Two SEPARATE MCP server processes (started from a cwd unrelated to the repo,
// the second while the first is still alive) speak real JSON-RPC against the
// SAME data root: initialize → tools/list → tools/call for
// result / status / settings_get / settings_update / spawn.
//
// What is proven:
//   * every direct read of the future record is REFUSED with the stable
//     `schema_too_new` code, and the diagnostic names both the record version
//     and the version this build supports — no stack, no success, no crash;
//   * the future config is refused with `config_version_too_new` on read, on
//     update, and on dispatch; a refused dispatch hands out no job id;
//   * the LIST never presents the future record as a job: it stays out of
//     `jobs`/`count` and is reported in `unreadable` by file name;
//   * afterwards the whole test-owned tree is file/dir sha256-identical
//     (no repair, overwrite, or extra job/message/log/notify/terminal file);
//   * the MCP server has no NEW descendant process after the refusals (a
//     worker/CLI would be one) and both server processes stay alive until
//     closed;
//   * a SECOND MCP process repeats the identical refusals on the same root and
//     the data is STILL unchanged.
//
// Scope honesty: this exercises THIS build's own version gate with
// future-versioned data at the real MCP entry. A true two-binary "old build
// reads data written by a new build" run is NOT performed here (no older build
// is produced); this pins the rollback compatibility contract.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { CONFIG_VERSION } from "../../config/schema";
import { JOB_SCHEMA_VERSION } from "../../jobs/types";
import { enumerateProcesses, findDescendants } from "../../runtime/process";
import { McpStdioClient, type McpToolResult } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const FUTURE_JOB_ID = "future-schema-record-0001";
/** One past what THIS build writes: exactly the record a newer build leaves behind. */
const FUTURE_SCHEMA_VERSION = JOB_SCHEMA_VERSION + 1;
/** One past what THIS build writes: exactly the settings a newer build leaves behind. */
const FUTURE_CONFIG_VERSION = CONFIG_VERSION + 1;
/** Refusal-only marker: a silently-accepted read would surface this text. */
const FIXTURE_TASK_MARKER = "SYNTHETIC_FUTURE_SCHEMA_RECORD_REFUSAL_ONLY";

interface Workspace {
  dir: string;
  root: string;
  project: string;
  iso: CliIsolation;
  env: NodeJS.ProcessEnv;
  jobFile: string;
  configFile: string;
  cleanup: () => void;
}

function newWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-schema-rollback-"));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "iso-schema-rollback-" });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  // The product's own directory skeleton, created up front, so the post-run
  // tree comparison also proves no per-job log/notify/terminal file appeared.
  for (const sub of ["jobs", "logs", "cancel", "notify", "terminal"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const jobFile = path.join(root, "jobs", `${FUTURE_JOB_ID}.json`);
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        schemaVersion: FUTURE_SCHEMA_VERSION,
        id: FUTURE_JOB_ID,
        provider: "command-code",
        runner: "command-code",
        status: "done",
        generation: 0,
        task: FIXTURE_TASK_MARKER,
        cwd: project,
        createdAt: "2026-09-24T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:01.000Z",
        finishedAt: "2026-09-24T00:00:01.000Z",
        sessionId: null,
        childPid: null,
        childGeneration: null,
        notifyTarget: { kind: "none", callbackUrl: null, codexThreadId: null, source: null },
        notifications: []
      },
      null,
      2
    ),
    "utf8"
  );
  const configFile = path.join(root, "config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        configVersion: FUTURE_CONFIG_VERSION,
        cliPath: null,
        defaultModel: "future/model-next",
        rateLimitFallbackModel: null,
        permissionMode: "plan",
        defaultEffort: null,
        rateLimitFallbackEffort: null,
        timeSlots: [],
        inFlightSwitch: false
      },
      null,
      2
    ),
    "utf8"
  );
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root };
  return {
    dir,
    root,
    project,
    iso,
    env,
    jobFile,
    configFile,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Only test-owned temp is ever removed; if Windows still holds a file,
        // name the leftover path instead of hiding it.
        console.error(`[schema-rollback] cleanup failed; test-owned temp left at ${dir}: ${String((e as Error)?.message || e)}`);
      }
    }
  };
}

/** sha256 per file (directories as "dir") — any added/removed/changed entry changes it. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p).split(path.sep).join("/");
      if (fs.statSync(p).isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(p);
      } else {
        out[rel] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

/** A refusal must be an error result with the stable code and no stack. */
function refused(result: McpToolResult, code: string, label: string): Record<string, unknown> {
  assert.equal(result.isError, true, `${label}: must be refused (isError), never a success result`);
  const body = McpStdioClient.json(result);
  assert.equal(body.ok, false, `${label}: must not report ok:true`);
  assert.equal(body.code, code, `${label}: must carry the stable ${code} refusal code`);
  const message = String(body.message ?? "");
  assert.ok(message.length > 0, `${label}: the refusal must carry a human-readable diagnostic`);
  assert.equal(/\n\s*at\s/.test(message), false, `${label}: the diagnostic must not expose a stack`);
  return body;
}

/** Live descendants of the MCP server PID (a spawned worker/CLI would be one). */
async function descendantsOf(rootPid: number): Promise<number[]> {
  const scan = await enumerateProcesses();
  assert.equal(scan.ok, true, `process enumeration is required to prove no CLI child was spawned: ${scan.reason ?? "unknown"}`);
  return findDescendants(scan.processes, rootPid, 0).pids;
}

/** The full refusal sequence, run once per MCP server process. */
async function refuseFutureData(client: McpStdioClient, ws: Workspace, label: string): Promise<void> {
  const init = await client.initialize();
  assert.equal((init.serverInfo as Record<string, unknown>).name, "crewdispatch", `${label}: real MCP handshake`);
  const names = (await client.listTools()).map((t) => String(t.name));
  assert.ok(names.includes("crewdispatch_result") && names.includes("crewdispatch_settings_update"), `${label}: expected tool surface`);

  // ---- the future job record: every direct read refuses with its stable code ----
  const resultBody = refused(
    await client.callTool("jobquay_result", { id: FUTURE_JOB_ID }),
    "schema_too_new",
    `${label} jobquay_result(future record)`
  );
  assert.match(String(resultBody.message), new RegExp(`schemaVersion ${FUTURE_SCHEMA_VERSION}`), `${label}: the diagnostic names the record version`);
  assert.match(String(resultBody.message), new RegExp(`supports \\(${JOB_SCHEMA_VERSION}\\)`), `${label}: the diagnostic names the supported version`);
  refused(await client.callTool("jobquay_status", { id: FUTURE_JOB_ID }), "schema_too_new", `${label} jobquay_status(id)`);

  // ---- the LIST never presents the future record as a job ----
  const list = McpStdioClient.json(await client.callTool("jobquay_status", {}));
  assert.equal(list.ok, true, `${label}: listing remains a successful read`);
  assert.equal(list.count, 0, `${label}: the future record must not be counted as a job`);
  assert.deepEqual(list.jobs, [], `${label}: the future record must not be presented as a job`);
  assert.deepEqual(list.unreadable, [`${FUTURE_JOB_ID}.json`], `${label}: the future record must be reported unreadable by name`);

  // ---- the future config: read and update both refuse ----
  const getBody = refused(await client.callTool("jobquay_settings_get", {}), "config_version_too_new", `${label} jobquay_settings_get`);
  assert.match(String(getBody.message), new RegExp(`Configuration version ${FUTURE_CONFIG_VERSION}`), `${label}: the diagnostic names the config version`);
  refused(
    await client.callTool("jobquay_settings_update", { default_model: "future/model-other" }),
    "config_version_too_new",
    `${label} jobquay_settings_update`
  );

  // ---- a dispatch under the future config is refused before any job/worker/CLI exists ----
  const spawnBody = refused(
    await client.callTool("jobquay_spawn", { task: FIXTURE_TASK_MARKER, cwd: ws.project }),
    "config_version_too_new",
    `${label} jobquay_spawn`
  );
  assert.equal("job_id" in spawnBody, false, `${label}: a refused dispatch must not hand out a job id`);

  // ---- the server survived every refusal ----
  assert.equal(client.alive, true, `${label}: the MCP server must stay alive across refusals`);
}

test("future-schema job record and config are refused with stable codes at the real MCP entry, byte-identically and without child processes", { timeout: 180000 }, async () => {
  const ws = newWorkspace();
  const sentinel = path.join(ws.iso.cliHome, "schema-rollback-sentinel");
  fs.writeFileSync(sentinel, "untouched\n", "utf8");
  const before = snapshotTree(ws.dir);
  const beforeJobBytes = fs.readFileSync(ws.jobFile, "utf8");
  const beforeConfigBytes = fs.readFileSync(ws.configFile, "utf8");

  let clientA: McpStdioClient | null = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  let clientB: McpStdioClient | null = null;
  try {
    // ---- MCP process A: the whole refusal sequence ----
    await refuseFutureData(clientA, ws, "process A");
    const pidA = clientA.pid;
    assert.ok(pidA != null, "the MCP server must have a live PID");
    // NOTE: an idle console-attached node server legitimately has a conhost.exe
    // child, so the invariant is "no NEW descendant" — a spawned worker/CLI
    // (node/cmd/cli shim) would be one, and the file tree evidence below catches
    // even a worker that spawned and exited between the two scans.
    const descendantsBefore = await descendantsOf(pidA!);

    // ---- MCP process B (a SEPARATE process, same data root, A still alive) ----
    clientB = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await refuseFutureData(clientB, ws, "process B");
    assert.notEqual(clientB.pid, clientA.pid, "the repeat must come from a SEPARATE MCP process");
    const newDescendants = (await descendantsOf(pidA!)).filter((pid) => !descendantsBefore.includes(pid));
    assert.deepEqual(newDescendants, [], "the refused calls must not spawn any worker/CLI descendant of the MCP server");

    // ---- the data root is unchanged while both servers are alive ----
    assert.equal(clientA.alive, true, "process A must survive both refusal sequences");
    assert.equal(clientB.alive, true, "process B must survive its refusal sequence");
    assert.deepEqual(snapshotTree(ws.dir), before, "no file in the test-owned tree may change or appear");

    // ---- both servers shut down cleanly; the tree is STILL unchanged ----
    await clientA.close();
    clientA = null;
    await clientB.close();
    clientB = null;
    assert.deepEqual(snapshotTree(ws.dir), before, "shutdown must not write either");

    // ---- direct byte evidence for the two future-versioned files ----
    assert.equal(fs.readFileSync(ws.jobFile, "utf8"), beforeJobBytes, "the future job record must be byte-identical");
    assert.equal(fs.readFileSync(ws.configFile, "utf8"), beforeConfigBytes, "the future config must be byte-identical");
    assert.deepEqual(fs.readdirSync(path.join(ws.root, "jobs")), [`${FUTURE_JOB_ID}.json`], "no new job record may appear");
    for (const sub of ["logs", "cancel", "notify", "terminal"]) {
      assert.deepEqual(fs.readdirSync(path.join(ws.root, sub)), [], `${sub}/ must stay empty (no message/log/notify/terminal file)`);
    }
    assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched\n", "the isolated profile sentinel must be untouched");
  } finally {
    if (clientB) await clientB.close();
    if (clientA) await clientA.close();
    ws.cleanup();
  }
});
