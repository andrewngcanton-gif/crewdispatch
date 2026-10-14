// installed-command-code-real-cli.e2e.ts — EXPLICIT, manual acceptance of the
// INSTALLED absolute-path MCP entry driving the REAL user-installed official
// Command Code CLI on a FREE model for two same-session generations.
//
// Run with:  npm.cmd run test:e2e:command-code:installed
//
// DELIBERATELY EXCLUDED from `npm test`: it spends real (free-tier) model
// entitlement through the operator's own authorized official CLI login and it
// runs the real installer's dependency step. It runs only when asked for by
// name.
//
// This closes the installed-package boundary: earlier Command Code real-model
// evidence used the CHECKOUT entry (dist/mcp/server.js). Here the REAL source
// installer installs a runtime-only package
// into a unique one-time temp target, and the real work runs through the
// INSTALLED entry (<target>/plugins/crewdispatch/.mcp.json -> absolute
// <target>/dist/mcp/server.js) opened from a working directory unrelated to
// both the checkout and the target, with the official cmdc.cmd doing the actual
// model inference — but ONLY after the CLI's own public `--list-models` output
// re-confirmed, immediately before EACH real prompt (before `jobquay_spawn` and
// again before `jobquay_follow_up`), that the price/tag column of
// `stealth/space-bunny-alpha`'s own row is the standalone FREE token. A FREE
// word elsewhere on the line (e.g. in the description) is never accepted, and a
// `FREE` label on any other id's row is never accepted. If a confirmation
// fails, the test FAILS with the observed catalog evidence and sends NO prompt
// (and NO follow-up).
//
// Profile honesty (this entry does NOT claim isolation):
//   * the product path runs the user-installed official CLI with the caller's
//     own environment, so the operator's authorized official login is used
//     exactly as in production. The official CLI may therefore save its own
//     session turns under the operator's real ~/.commandcode as part of this
//     authorized run;
//   * this test never reads, copies, lists or deletes that profile, its
//     auth.json or its databases. It only runs the CLI's PUBLIC
//     `--version` / `--help` / `--list-models` probes;
//   * the CrewDispatch data root and the job workspace are disposable directories
//     inside this run's temp tree, and the project-scoped
//     `.commandcode/settings.json` written there pins the primary model and
//     every supported featureModels entry covered by the regression contract
//     to the same free id with taste learning off, so no auxiliary CLI feature
//     can land on a paid default;
//   * no Codex wake is possible for this job: CODEX_THREAD_ID is removed from
//     the MCP environment and the persisted target is this run's loopback
//     callback only;
//   * cleanup removes ONLY this run's own temp tree and never signals a
//     process: a non-terminal job is stopped through the product's own
//     `jobquay_cancel`, captured PIDs are only WAITED ON (by live OS identity,
//     so a recycled PID number is never mistaken for a survivor), and if the
//     tree cannot be removed it is reported and kept.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { probeCapabilities, readModelCatalog } from "../../providers/command-code/probe";
import type { ModelCatalogResult } from "../../providers/provider";
import { isValidSessionIdFor } from "../../jobs/runner";
import { loadUserMessagesInfo } from "../../jobs/messages";
import { readNotificationResults } from "../../jobs/store";
import { isPidAlive } from "../../runtime/process";
import { McpStdioClient } from "../helpers/mcp-client";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ACCEPT_SOURCE_ROOT = process.env.JOBQUAY_ACCEPT_SOURCE_ROOT?.trim();
if (ACCEPT_SOURCE_ROOT && !path.isAbsolute(ACCEPT_SOURCE_ROOT)) {
  throw new Error("JOBQUAY_ACCEPT_SOURCE_ROOT must be an absolute unpacked candidate root");
}
const ACCEPT_CLI_PATH = process.env.JOBQUAY_ACCEPT_COMMAND_CODE_CLI_PATH?.trim();
if (ACCEPT_CLI_PATH && !path.isAbsolute(ACCEPT_CLI_PATH)) {
  throw new Error("JOBQUAY_ACCEPT_COMMAND_CODE_CLI_PATH must be an absolute official CLI path");
}
const SOURCE_ROOT = ACCEPT_SOURCE_ROOT ? path.resolve(ACCEPT_SOURCE_ROOT) : REPO_ROOT;
const SOURCE_INSTALLER = path.join(SOURCE_ROOT, "dist", "cli", "install-cli.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

/** The one model this acceptance may use: the CLI's public FREE stealth id. */
const MODEL = "stealth/space-bunny-alpha";
const FIRST_MARKER = "JOBQUAY-BUNNY-GEN0";
const YOLO_WRITE_FILE = "jobquay-yolo-write-probe.txt";
const YOLO_WRITE_TEXT = "JOBQUAY-YOLO-WRITE-OK\n";
const FIRST_TASK =
  `Create ${YOLO_WRITE_FILE} in the current workspace with exactly the text JOBQUAY-YOLO-WRITE-OK followed by one newline. ` +
  "Use a file-writing/editing tool, not shell, PowerShell, Python, Node, or another command runner. " +
  `After the file is written successfully, reply with exactly the single word ${FIRST_MARKER} and nothing else.`;
// The follow-up carries NO marker: only a session that really continued from
// generation 0 can answer which word was requested there.
const FOLLOW_TASK = "What was the exact single word I asked you to reply with at the start of this session? Reply with just that word and nothing else.";
/** Every path this test is allowed to delete starts with this temp prefix. */
const OWNED_TEMP_PREFIX = "jobquay-installed-cc-";

/**
 * The project-scoped pin written ONLY into this run's disposable workspace
 * (never into the operator's profile). It reproduces the six featureModels
 * supported entries covered by the regression contract, all on the free id,
 * with taste learning off.
 */
const PROJECT_SETTINGS = {
  model: MODEL,
  featureModels: {
    titleGeneration: MODEL,
    compaction: MODEL,
    toolDescription: MODEL,
    tasteOnboarding: MODEL,
    tasteLearning: MODEL,
    branchSummarization: MODEL
  },
  tasteLearning: false
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listNames(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort();
}

/** Every file below `dir`, as paths relative to it (for the workspace audit). */
function filesInside(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, rel: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relPath);
      else found.push(relPath);
    }
  };
  walk(dir, "");
  return found.sort();
}

// ---------------------------------------------------------------------------
// Temp-tree ownership and removal
// ---------------------------------------------------------------------------

/**
 * Only a directory this test created inside `os.tmpdir()` under its own unique
 * prefix may ever be removed. A path outside the temp dir, or one that merely
 * lives there under a different name, is refused instead of deleted.
 */
function isOwnedTempTree(root: string): boolean {
  const tmp = path.resolve(os.tmpdir());
  const target = path.resolve(root);
  const rel = path.relative(tmp, target);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside && path.basename(target).startsWith(OWNED_TEMP_PREFIX);
}

interface RemoveResult {
  removed: boolean;
  lastError: string | null;
}

/** Remove an owned temp tree with bounded retries; a failure is RETURNED. */
async function removeTree(root: string): Promise<RemoveResult> {
  if (!isOwnedTempTree(root)) {
    throw new Error(`refusing to remove a path that is not this run's temp tree: ${root}`);
  }
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      lastError = errorMessage(e);
    }
    if (!fs.existsSync(root)) return { removed: true, lastError: null };
    await sleep(200);
  }
  return { removed: false, lastError: lastError ?? "the tree still existed after every retry" };
}

// ---------------------------------------------------------------------------
// Install CLI
// ---------------------------------------------------------------------------

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function runInstaller(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): CliResult {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 12 * 1024 * 1024,
    windowsHide: true
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.trim(), `installer emitted no JSON (stderr=${result.stderr.slice(-2000)})`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (e) {
    assert.fail(`installer output was not machine-readable JSON: ${errorMessage(e)}; stdout=${result.stdout.slice(0, 1000)}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// ---------------------------------------------------------------------------
// FREE-model confirmation from the CLI's own public catalog output
// ---------------------------------------------------------------------------

/** One published `cmdc --list-models` columnar row, split at its columns. */
export interface ModelRow {
  line: string;
  /** The token in the price/tag column directly after the id (never the description). */
  priceTag: string;
  description: string;
}

/**
 * The one `cmdc --list-models` columnar row that publishes `model`, or null.
 * The public shape is `<id><2+ spaces><price/tag>[ <description>]` — the same
 * shape the product's own catalog parser consumes (see
 * src/providers/command-code/catalog.ts `COLUMN_ROW_RE`), so the id must LEAD
 * its own line as the first column: a bare id line, an id that merely appears
 * inside another id's line, or a different id's row all fail to produce a row.
 */
export function parseModelRow(raw: string, model: string): ModelRow | null {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const m = /^(\S+)\s{2,}(\S+)(?:\s+(.*))?$/.exec(t);
    if (!m || m[1] !== model) continue;
    return { line: t, priceTag: m[2]!, description: m[3] ?? "" };
  }
  return null;
}

/**
 * Assert the catalog's own evidence that `model` is published AND that the
 * PRICE/TAG COLUMN of its own row is the standalone token `FREE`. Only the
 * column directly after the id is read: a `FREE` word anywhere else — in the
 * description ("FREE trial", "FREE fallback"), on another row, or as part of a
 * longer token ("FREEMIUM", "$0.05/M") — can never satisfy this. Returns the
 * exact published line for the log. `where` names the preflight moment so a
 * failure says exactly which one abstained.
 */
export function assertFreeModelEvidence(catalog: ModelCatalogResult, where: string): string {
  assert.equal(catalog.ok, true, `${where}: public catalog probe failed (${catalog.error ?? "unknown"})`);
  assert.equal(catalog.source, "cli-list-models", `${where}: catalog source was ${catalog.source}`);
  assert.ok(catalog.raw, `${where}: cmdc --list-models produced no raw output to check`);
  assert.ok(
    catalog.models.includes(MODEL),
    `${where}: the official catalog does not publish ${MODEL} (${catalog.models.length} ids)`
  );
  const row = parseModelRow(catalog.raw, MODEL);
  assert.ok(
    row,
    `${where}: no columnar price/tag row for ${MODEL} in the official --list-models output (a label elsewhere on the line is not a row)`
  );
  assert.equal(
    row.priceTag,
    "FREE",
    `${where}: the price/tag column of ${MODEL} is ${JSON.stringify(row.priceTag)}, not the standalone FREE token; refusing to send a real prompt (line: ${row.line})`
  );
  return row.line;
}

// ---------------------------------------------------------------------------
// Loopback terminal-wake listener
// ---------------------------------------------------------------------------

interface WakeListener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

/** A loopback-only terminal-wake target: nothing outside this test can reach it. */
async function startListener(): Promise<WakeListener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      bodies.push(body);
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

// ---------------------------------------------------------------------------
// Job store readers / waits
// ---------------------------------------------------------------------------

function readRecord(root: string, id: string): Record<string, unknown> {
  return readJson<Record<string, unknown>>(path.join(root, "jobs", `${id}.json`));
}

async function waitForGeneration(
  client: McpStdioClient,
  id: string,
  generation: number,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (Number(result.generation) === generation && TERMINAL.has(String(result.status))) return result;
    if (Date.now() >= deadline) {
      throw new Error(
        `job ${id} generation ${generation} did not finish within ${timeoutMs}ms (last=${JSON.stringify(result).slice(0, 600)})`
      );
    }
    await sleep(300);
  }
}

async function waitForDeliveredWake(
  client: McpStdioClient,
  listener: WakeListener,
  id: string,
  expected: number,
  timeoutMs = 30000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (listener.bodies.length >= expected) {
      const status = McpStdioClient.json(await client.callTool("jobquay_status", { id }));
      const notify = (status.job as Record<string, unknown>).notify as Record<string, unknown>;
      if (notify.attempted === true && notify.delivered === true) return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`expected ${expected} delivered terminal wakes for ${id}; got ${listener.bodies.length}`);
    }
    await sleep(100);
  }
}

/**
 * Wait until CrewDispatch has persisted the REAL worker and CLI-root PIDs of the
 * running generation, and return them. This is the capture point for process
 * identity: a PID is only ever considered later when its live creation time
 * still matches what was captured here (or, only when a creation time is
 * unreadable, when its full command line matches exactly).
 */
async function captureRunningTree(
  root: string,
  id: string,
  timeoutMs: number
): Promise<{ ownerPid: number; childPid: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = "no record yet";
  for (;;) {
    const file = path.join(root, "jobs", `${id}.json`);
    if (fs.existsSync(file)) {
      const record = readRecord(root, id);
      const ownerPid = record.ownerPid;
      const childPid = record.childPid;
      if (
        String(record.status) === "running" &&
        Number.isInteger(ownerPid) &&
        Number.isInteger(childPid) &&
        isPidAlive(ownerPid as number) === true &&
        isPidAlive(childPid as number) === true
      ) {
        return { ownerPid: ownerPid as number, childPid: childPid as number };
      }
      if (TERMINAL.has(String(record.status))) {
        throw new Error(`job ended before its running process tree could be observed: ${String(record.status)}`);
      }
      last = `status=${String(record.status)} ownerPid=${String(ownerPid)} childPid=${String(childPid)}`;
    }
    if (Date.now() >= deadline) {
      throw new Error(`job ${id} never persisted a live worker + CLI root (${last})`);
    }
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Read-only process identity (mirrors the fail-closed probe of the installed
// MCP integration test; this entry only ever WAITS on processes, never signals)
// ---------------------------------------------------------------------------

const SYSTEM_POWERSHELL = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

const IDENTITY_SCRIPT = [
  '$p = Get-CimInstance Win32_Process -Filter "ProcessId=__PID__";',
  "if ($null -eq $p) { Write-Output 'JOBQUAY_TEST_PROCESS_DEAD' } else {",
  "$t = 0; if ($p.CreationDate) { $t = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() };",
  "$o = [ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; created = [long]$t; cmd = [string]$p.CommandLine };",
  "$o | ConvertTo-Json -Compress }"
].join(" ");

export type IdentityProbe =
  | { state: "dead" }
  | { state: "alive"; createdAtMs: number | null; commandLine: string | null; parentPid: number | null }
  | { state: "unknown"; reason: string };

/** Interpret one CIM JSON record read for `requestedPid` (see the integration test). */
export function parseProcessIdentityOutput(stdout: string, requestedPid: number): IdentityProbe {
  const text = stdout.trim();
  if (text === "JOBQUAY_TEST_PROCESS_DEAD") return { state: "dead" };
  if (!text) return { state: "unknown", reason: "process identity read produced no output" };
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { state: "unknown", reason: "process identity read produced unreadable output" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "unknown", reason: "process identity read produced a non-record value" };
  }
  if (!Number.isInteger(value.pid) || value.pid !== requestedPid) {
    return {
      state: "unknown",
      reason: `process identity record carries PID ${JSON.stringify(value.pid)}, not the requested ${requestedPid}`
    };
  }
  return {
    state: "alive",
    createdAtMs: Number.isFinite(value.created) && Number(value.created) > 0 ? Number(value.created) : null,
    commandLine: typeof value.cmd === "string" && value.cmd ? value.cmd : null,
    parentPid: Number.isInteger(value.ppid) ? Number(value.ppid) : null
  };
}

async function probeProcessIdentity(pid: number): Promise<IdentityProbe> {
  if (!Number.isInteger(pid) || pid <= 0) return { state: "dead" };
  if (process.platform !== "win32" || !fs.existsSync(SYSTEM_POWERSHELL)) {
    return { state: "unknown", reason: "no Windows CIM process surface on this host" };
  }
  const script = IDENTITY_SCRIPT.replace("__PID__", String(pid));
  return await new Promise<IdentityProbe>((resolve) => {
    try {
      execFile(
        SYSTEM_POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 20000 },
        (error, stdout) => {
          if (error) {
            resolve({ state: "unknown", reason: `process identity read failed: ${errorMessage(error).slice(0, 200)}` });
            return;
          }
          resolve(parseProcessIdentityOutput(String(stdout ?? ""), pid));
        }
      );
    } catch (e) {
      resolve({ state: "unknown", reason: `process identity read failed: ${errorMessage(e).slice(0, 200)}` });
    }
  });
}

/** One process this run started, plus the identity captured while it was ours. */
export interface OwnedProcess {
  role: string;
  pid: number;
  createdAtMs: number | null;
  commandLine: string | null;
}

/**
 * Wait until none of `entries` is still THIS run's live process, and return the
 * PIDs that (at the deadline) still are. A live PID whose creation time differs
 * from the captured one is a REUSED NUMBER owned by a foreign process — not a
 * survivor. An identity that cannot be read is kept: exit is unproven, so the
 * wait fails closed.
 */
export async function waitForOwnedExit(entries: readonly OwnedProcess[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive: number[] = [];
    for (const entry of entries) {
      if (isPidAlive(entry.pid) === false) continue;
      const probe = await probeProcessIdentity(entry.pid);
      if (probe.state === "dead") continue;
      if (probe.state === "unknown") {
        alive.push(entry.pid);
        continue;
      }
      if (entry.createdAtMs != null && probe.createdAtMs != null && entry.createdAtMs !== probe.createdAtMs) continue;
      alive.push(entry.pid);
    }
    if (alive.length === 0 || Date.now() >= deadline) return alive;
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Directed tests of the pure FREE-evidence and removal helpers
// ---------------------------------------------------------------------------

test("the FREE check reads only the price/tag column of the exact published row", () => {
  const real = "stealth/space-bunny-alpha              FREE stealth model with 1M context";
  const otherIdWithFree = "poolside/laguna-s-2.1-free             FREE open-weight agentic coding";
  const raw = ["Available models  ·  2 models", "", "Open Source", real, otherIdWithFree].join("\n");
  const catalog = {
    ok: true,
    source: "cli-list-models",
    models: [MODEL, "poolside/laguna-s-2.1-free"],
    defaultModel: null,
    raw,
    error: null
  } as ModelCatalogResult;

  // The real published row must be accepted, and only its own columns are read.
  assert.deepEqual(parseModelRow(raw, MODEL), { line: real, priceTag: "FREE", description: "stealth model with 1M context" });
  assert.equal(assertFreeModelEvidence(catalog, "directed"), real);

  // A row for the right id whose PRICE column is paid must refuse even though
  // its description contains the word FREE (the regression the loose
  // /\bFREE\b/ line match allowed).
  const paidButFreeInDescription = raw.replace(real, "stealth/space-bunny-alpha              paid stealth model, FREE trial only");
  assert.throws(
    () => assertFreeModelEvidence({ ...catalog, raw: paidButFreeInDescription }, "directed"),
    /price\/tag column .*"paid"/,
    "a FREE word in the description of a paid row must never satisfy the check"
  );
  const priceThenFreeWord = raw.replace(real, "stealth/space-bunny-alpha              $0.05/M FREE fallback available");
  assert.throws(() => assertFreeModelEvidence({ ...catalog, raw: priceThenFreeWord }, "directed"), /"\$0\.05\/M"/);

  // FREE on a DIFFERENT id's row, or on a longer id that merely embeds the
  // model id, must not be mistaken for this id's label.
  assert.throws(
    () => assertFreeModelEvidence({ ...catalog, raw: otherIdWithFree }, "directed"),
    /no columnar price\/tag row/,
    "another id's FREE row must not satisfy the pinned id"
  );
  const embeddedId = "x/stealth/space-bunny-alpha-turbo  FREE";
  assert.throws(() => assertFreeModelEvidence({ ...catalog, raw: embeddedId }, "directed"), /no columnar price\/tag row/);
  const infixToken = raw.replace(real, "stealth/space-bunny-alpha              FREEMIUM preview");
  assert.throws(() => assertFreeModelEvidence({ ...catalog, raw: infixToken }, "directed"), /"FREEMIUM"/);

  // A row without a separate price/tag column, a removed id and a failed probe
  // must all refuse (fail closed, never fall through to a prompt).
  assert.throws(() => assertFreeModelEvidence({ ...catalog, raw: MODEL }, "directed"), /no columnar price\/tag row/);
  assert.throws(() => assertFreeModelEvidence({ ...catalog, models: [] }, "directed"), /does not publish/);
  assert.throws(() => assertFreeModelEvidence({ ...catalog, source: "unavailable", ok: false }, "directed"), /catalog probe failed/);
});

test("the removal guard refuses any path that is not this run's temp tree", async () => {
  await assert.rejects(removeTree(REPO_ROOT), /refusing to remove/, "the checkout must never be a removal target");
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-not-ours-cc-"));
  try {
    await assert.rejects(removeTree(foreign), /refusing to remove/, "a temp dir without this run's prefix must not be removed");
    assert.ok(fs.existsSync(foreign), "a refused removal must not delete anything");
  } finally {
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The acceptance entry
// ---------------------------------------------------------------------------

test("the installed MCP entry gives real Command Code YOLO file-write access, resumes the same session, and uninstalls safely", {
  timeout: 1200000
}, async () => {
  assert.ok(fs.existsSync(SOURCE_INSTALLER), `build first: source installer missing at ${SOURCE_INSTALLER}`);
  if (process.platform !== "win32") {
    assert.fail("this acceptance is Windows-only: its CLI-root identity and profile assumptions were measured on win32");
  }

  // Prefer the same bounded PATH discovery the product uses. CI/WebCodex
  // runners sometimes omit the user's npm-bin directory from PATH even though
  // the official CLI is installed and authenticated; for that harness-only
  // case an explicit absolute official CLI path may be supplied. Either route
  // still runs the exact same public --version/--help/--list-models preflights
  // and the installed CrewDispatch product path below.
  const cliResolution = resolveCommandCodeCli({
    env: {
      ...process.env,
      JOBQUAY_COMMAND_CODE_CLI_PATH: ACCEPT_CLI_PATH || ""
    }
  });
  if (!cliResolution.ok || !cliResolution.path) {
    assert.fail(`official cmdc.cmd is required; installed real-model acceptance is blocked (source=${cliResolution.source})`);
  }

  // ONE disposable tree holds the install target, the CrewDispatch data root, the
  // job workspace (with the project-scoped pin), the unrelated cwd and the
  // loopback listener. The operator's own profile is NOT redirected: the
  // official CLI uses its own authorized login, as in production.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), OWNED_TEMP_PREFIX));
  const target = path.join(workspace, "installed-jobquay");
  const foreignCwd = path.join(workspace, "unrelated-cwd");
  const dataRoot = path.join(workspace, "data-root");
  const project = path.join(workspace, "workspace");
  const outsideSentinel = path.join(workspace, "outside-target.keep");
  const dataSentinel = path.join(dataRoot, "keep-data.txt");
  fs.mkdirSync(foreignCwd, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.join(project, ".commandcode"), { recursive: true });
  fs.writeFileSync(outsideSentinel, "outside the install target\n", "utf8");
  fs.writeFileSync(dataSentinel, "data root survives uninstall\n", "utf8");
  const settingsPath = path.join(project, ".commandcode", "settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify(PROJECT_SETTINGS, null, 2)}\n`, "utf8");

  const installerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    // Never write a real HKCU login entry from an automated run.
    JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(workspace, "autostart-registry.json")
  };
  const mcpEnv: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: dataRoot,
    // The documented public override: pin the discovered official CLI so the
    // worker can never fall through to something else on PATH.
    JOBQUAY_COMMAND_CODE_CLI_PATH: cliResolution.path,
    // This real-CLI gate verifies the provider boundary, not the
    // Dashboard: never start the shared Hub on the default port.
    CREWDISPATCH_DISPATCH_DASHBOARD: "0"
  };
  // Test seams and wake fallbacks are removed: a fixture must never stand in
  // for the model boundary, and no real Codex thread may ever be woken.
  delete mcpEnv.JOBQUAY_TEST_FIXTURE;
  delete mcpEnv.JOBQUAY_CLI_PATH;
  delete mcpEnv.JOBQUAY_COMMAND_CODE_CLI_COMMAND;
  delete mcpEnv.CODEX_THREAD_ID;

  const productResolvedCli = resolveCommandCodeCli({ env: mcpEnv });
  assert.equal(productResolvedCli.source, "env-path", "the pinned CLI path must win the product's own precedence");
  const cliPath = path.resolve(productResolvedCli.path as string);

  let client: McpStdioClient | null = null;
  let listener: WakeListener | null = null;
  let mcpEntry: string | null = null;
  let jobId: string | null = null;
  let sessionId: string | null = null;
  let freeLine: string | null = null;
  let cliVersion: string | null = null;
  const owned: OwnedProcess[] = [];
  const rememberOwned = async (role: string, pid: number): Promise<void> => {
    if (!Number.isInteger(pid) || pid <= 0 || owned.some((entry) => entry.pid === pid)) return;
    const probe = await probeProcessIdentity(pid);
    owned.push({
      role,
      pid,
      createdAtMs: probe.state === "alive" ? probe.createdAtMs : null,
      commandLine: probe.state === "alive" ? probe.commandLine : null
    });
  };
  let failure: unknown = null;

  try {
    // ---- 0. Free-model preflight (fail fast, before the installer) ----------
    const caps0 = await probeCapabilities({ cliPath, env: mcpEnv, cwd: foreignCwd });
    assert.equal(caps0.ok, true, `public cmdc probes failed: ${caps0.errors.join("; ")}`);
    // `cmdc --version` publishes the bare semantic version on this build
    // (measured 1.65.2); the exact string is kept as evidence instead of an
    // assumed prefix.
    assert.match(String(caps0.version), /^\d+\.\d+\.\d+/, `unexpected cmdc --version output: ${String(caps0.version)}`);
    cliVersion = String(caps0.version).trim();
    const catalog0 = await readModelCatalog({ cliPath, env: mcpEnv, cwd: foreignCwd });
    freeLine = assertFreeModelEvidence(catalog0, "preflight");
    console.log(
      `[installed-cc] preflight: version="${cliVersion}" cli=${cliPath} catalog=${catalog0.source} models=${catalog0.models.length} freeLine="${freeLine}"`
    );

    // ---- 1. Real installer -> unique temp target, runtime-only package ------
    const installed = runInstaller(SOURCE_INSTALLER, ["install", "--target", target], foreignCwd, installerEnv);
    assert.equal(installed.status, 0, `install failed: ${installed.stdout}`);
    assert.equal(installed.json.ok, true);
    assert.ok(String(installed.json.installId), "the install must publish its managed identity");
    const marker = readJson<Record<string, unknown>>(path.join(target, ".jobquay-install.json"));
    assert.equal(marker.product, "jobquay");
    assert.equal(marker.formatVersion, 1);
    assert.equal(marker.installId, installed.json.installId);
    assert.ok(String(marker.packageVersion), "the install marker must carry the package version");
    assert.ok(String(marker.createdAt) && String(marker.updatedAt), "the install marker must carry its timestamps");
    const managedFiles = (marker.managedFiles as Array<{ path: string }>) ?? [];
    assert.ok(managedFiles.length > 0, "the install marker must list its managed files");
    for (const required of ["dist/mcp/server.js", "dist/cli/job-cli.js"]) {
      assert.ok(managedFiles.some((file) => file.path === required), `the marker must manage ${required}`);
    }
    assert.equal(fs.existsSync(path.join(target, "src")), false, "the installed runtime must not depend on the checkout source tree");
    assert.equal(fs.existsSync(path.join(target, "dist", "tests")), false, "test sources must not be copied into the install");
    assert.ok(fs.existsSync(path.join(target, "dist", "cli", "job-cli.js")), "the installed package must carry the detached worker entry");

    const mcpConfigPath = path.join(target, "plugins", "crewdispatch", ".mcp.json");
    const mcpConfig = readJson<{ mcpServers: { crewdispatch: { command: string; args: string[] } } }>(mcpConfigPath);
    const entry = mcpConfig.mcpServers.crewdispatch.args[0]!;
    assert.equal(path.resolve(mcpConfig.mcpServers.crewdispatch.command), path.resolve(process.execPath));
    assert.equal(mcpConfig.mcpServers.crewdispatch.args.length, 1);
    assert.equal(path.isAbsolute(entry), true, `the installed entry must be absolute: ${entry}`);
    assert.equal(path.resolve(entry), path.join(target, "dist", "mcp", "server.js"));
    assert.equal(
      path.resolve(entry).toLowerCase().startsWith(REPO_ROOT.toLowerCase()),
      false,
      "the installed entry must resolve inside the install target, never into the checkout"
    );
    assert.ok(fs.existsSync(entry));
    mcpEntry = path.resolve(entry);
    const entryHash = sha256File(mcpEntry);
    const mcpConfigHash = sha256File(mcpConfigPath);
    const markerHash = sha256File(path.join(target, ".jobquay-install.json"));
    const settingsHash = sha256File(settingsPath);
    const workspaceFilesBefore = filesInside(project);

    // ---- 2. Dispatch through the INSTALLED entry from an unrelated cwd -------
    listener = await startListener();
    client = new McpStdioClient(mcpEntry, mcpEnv, foreignCwd);
    const init = await client.initialize();
    assert.equal((init.serverInfo as Record<string, unknown>).name, "crewdispatch");
    const tools = (await client.listTools()).map((tool) => String(tool.name));
    for (const name of ["crewdispatch_spawn", "crewdispatch_result", "crewdispatch_follow_up", "crewdispatch_cancel", "crewdispatch_status"]) {
      assert.ok(tools.includes(name), `the installed entry must publish ${name}`);
    }
    const empty = McpStdioClient.json(await client.callTool("jobquay_status", {}));
    assert.equal(empty.count, 0, "no job may exist before the dispatch");

    // ---- 2b. Re-confirm FREE immediately before the first real prompt -------
    const caps1 = await probeCapabilities({ cliPath, env: mcpEnv, cwd: foreignCwd });
    assert.equal(caps1.ok, true, `public cmdc probes failed immediately before the prompt: ${caps1.errors.join("; ")}`);
    assert.equal(String(caps1.version).trim(), cliVersion, "the CLI version changed between preflights");
    const catalog1 = await readModelCatalog({ cliPath, env: mcpEnv, cwd: foreignCwd });
    freeLine = assertFreeModelEvidence(catalog1, "pre-prompt re-confirmation");
    console.log(`[installed-cc] pre-prompt re-confirmation: freeLine="${freeLine}"`);

    const spawnStarted = Date.now();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", {
        provider: "command-code",
        model: MODEL,
        task: FIRST_TASK,
        cwd: project,
        permission_mode: "yolo",
        callback_url: listener.url
      })
    );
    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    assert.equal(spawned.provider, "command-code");
    assert.equal(Number(spawned.generation), 0);
    jobId = String(spawned.job_id);
    assert.match(jobId, /^job-/);
    assert.equal((spawned.notify as Record<string, unknown>).kind, "callback");
    assert.ok(Date.now() - spawnStarted < 15000, "spawn must return asynchronously, before the job finishes");
    console.log(`[installed-cc] spawned job=${jobId} model=${MODEL} mode=yolo cwd=${project}`);

    // ---- 3. The job survives the closed client; the real worker is observed --
    const running = await captureRunningTree(dataRoot, jobId, 60000);
    await rememberOwned("worker-gen0", running.ownerPid);
    await rememberOwned("cli-root-gen0", running.childPid);
    const workerEntry = owned.find((item) => item.role === "worker-gen0")!;
    assert.ok(
      String(workerEntry.commandLine).includes(path.join(target, "dist", "cli", "job-cli.js")),
      `the observed worker must be the INSTALLED worker entry: ${String(workerEntry.commandLine)}`
    );
    assert.equal(
      String(workerEntry.commandLine).includes(path.join(REPO_ROOT, "dist", "cli", "job-cli.js")),
      false,
      "the worker must not run from the checkout"
    );
    const cliRootEntry = owned.find((item) => item.role === "cli-root-gen0")!;
    if (cliRootEntry.commandLine) {
      assert.ok(
        cliRootEntry.commandLine.toLowerCase().includes(cliPath.toLowerCase()),
        `the observed CLI root must be the pinned official cmdc.cmd: ${cliRootEntry.commandLine}`
      );
    } else {
      console.log("[installed-cc] note: the CLI-root command line was unreadable from CIM; worker/record evidence stands");
    }
    await client.close();
    client = null;

    // ---- 4. A NEW installed MCP process collects generation 0 ----------------
    client = new McpStdioClient(mcpEntry, mcpEnv, foreignCwd);
    await client.initialize();
    const result0 = await waitForGeneration(client, jobId, 0, 600000);
    assert.equal(result0.status, "done", JSON.stringify(result0.result));
    assert.equal(result0.provider, "command-code");
    assert.equal(result0.model, MODEL);
    assert.deepEqual(result0.model_chain, [MODEL], "an explicit free model must be the only chain candidate");
    assert.equal(result0.downgraded, false);
    const compact0 = result0.result as Record<string, unknown>;
    assert.equal(compact0.exit_code, 0, `generation 0 must exit 0 (${JSON.stringify(compact0)})`);
    assert.equal(compact0.kind, "success");
    assert.equal(compact0.fallback_eligible, false);
    assert.match(String(compact0.final_text), new RegExp(FIRST_MARKER), `generation 0 final text: ${String(compact0.final_text)}`);

    const record0 = readRecord(dataRoot, jobId);
    assert.equal(record0.provider, "command-code");
    assert.equal(record0.runner, "command-code");
    assert.equal(record0.permissionMode, "yolo", "the requested YOLO permission mode must be persisted");
    const yoloWritePath = path.join(project, YOLO_WRITE_FILE);
    assert.equal(fs.existsSync(yoloWritePath), true, "real Command Code YOLO must be able to create a workspace file in -p mode");
    assert.equal(
      fs.readFileSync(yoloWritePath, "utf8"),
      YOLO_WRITE_TEXT,
      "the real file-write tool must persist the exact requested content"
    );
    assert.equal(record0.model, MODEL);
    assert.equal(record0.modelSource, "explicit");
    assert.equal(record0.explicitModel, MODEL);
    assert.deepEqual(record0.modelChain, [MODEL]);
    assert.equal(record0.generation, 0);
    assert.equal(record0.promptKind, "task");
    assert.equal(record0.childPid, null, "the managed CLI child must be gone at terminal completion");
    assert.ok(record0.finishedAt, "a natural terminal job must have a finish time");
    assert.equal(isPidAlive(running.childPid), false, "the captured generation-0 CLI root must have exited");
    sessionId = String(record0.sessionId ?? "");
    assert.ok(
      isValidSessionIdFor("command-code", sessionId),
      `a real resumable session id must be persisted: ${JSON.stringify(record0.sessionId)}`
    );
    const logPath = path.join(dataRoot, String(record0.logPath));
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(FIRST_MARKER));
    assert.equal((record0.notifyTarget as Record<string, unknown>).kind, "callback");
    assert.equal((record0.notifyTarget as Record<string, unknown>).codexThreadId, null, "no Codex thread may be a wake target");
    assert.equal((record0.notifyTarget as Record<string, unknown>).callbackUrl, listener.url);
    const attempts0 = record0.attempts as Array<Record<string, unknown>>;
    assert.deepEqual(attempts0.map((attempt) => attempt.generation), [0], "exactly one attempt for generation 0");
    assert.deepEqual(attempts0.map((attempt) => attempt.model), [MODEL]);
    assert.deepEqual(attempts0.map((attempt) => attempt.rateLimited), [false]);
    assert.equal(attempts0[0]!.exitCode, 0);
    assert.equal(attempts0[0]!.resumedFrom, null);
    await waitForDeliveredWake(client, listener, jobId, 1);
    assert.equal(listener.bodies.length, 1, "exactly one terminal callback for generation 0");
    assert.deepEqual(listNames(path.join(dataRoot, "terminal"), ".json"), [`${jobId}.gen-0.json`]);
    assert.deepEqual(listNames(path.join(dataRoot, "notify"), ".result.json"), [`${jobId}.gen-0.result.json`]);
    console.log(`[installed-cc] gen0 done job=${jobId} session=${sessionId} final="${String(compact0.final_text).trim()}"`);

    // ---- 5. Follow-up on the SAME job/session through the same entry ---------
    // The FREE label is time-sensitive: re-read the CLI's own public catalog
    // and re-assert the price/tag column immediately before the second real
    // prompt. A failure here throws and the follow-up is NOT sent.
    const catalog2 = await readModelCatalog({ cliPath, env: mcpEnv, cwd: foreignCwd });
    const followUpFreeLine = assertFreeModelEvidence(catalog2, "pre-follow-up re-confirmation");
    console.log(`[installed-cc] pre-follow-up re-confirmation: freeLine="${followUpFreeLine}"`);
    const followed = McpStdioClient.json(
      await client.callTool("jobquay_follow_up", { id: jobId, message: FOLLOW_TASK, callback_url: listener.url })
    );
    assert.equal(followed.ok, true, JSON.stringify(followed));
    assert.equal(followed.job_id, jobId, "a follow-up must keep the logical job id");
    assert.equal(Number(followed.generation), 1);

    let gen1Tree: { ownerPid: number; childPid: number } | null = null;
    try {
      gen1Tree = await captureRunningTree(dataRoot, jobId, 45000);
      await rememberOwned("worker-gen1", gen1Tree.ownerPid);
      await rememberOwned("cli-root-gen1", gen1Tree.childPid);
    } catch (e) {
      console.log(`[installed-cc] generation 1 tree not observed while running: ${errorMessage(e)}`);
    }

    const result1 = await waitForGeneration(client, jobId, 1, 600000);
    assert.equal(result1.status, "done", JSON.stringify(result1.result));
    assert.equal(result1.provider, "command-code");
    assert.equal(result1.model, MODEL);
    assert.deepEqual(result1.model_chain, [MODEL]);
    assert.equal(result1.downgraded, false);
    const compact1 = result1.result as Record<string, unknown>;
    assert.equal(compact1.exit_code, 0, `generation 1 must exit 0 (${JSON.stringify(compact1)})`);
    assert.equal(compact1.kind, "success");
    // The follow-up message never contains the first marker: only the resumed
    // session can answer it, so this is behavioural `--resume` evidence.
    assert.match(
      String(compact1.final_text),
      new RegExp(FIRST_MARKER),
      `generation 1 must recall the generation-0 marker from the resumed session: ${String(compact1.final_text)}`
    );

    const record1 = readRecord(dataRoot, jobId);
    assert.equal(record1.generation, 1);
    assert.equal(record1.sessionId, sessionId, "the follow-up must reuse the SAME provider session");
    assert.equal(record1.childPid, null);
    assert.equal(record1.model, MODEL, "the follow-up keeps the accepted explicit model");
    assert.deepEqual(record1.modelChain, [MODEL]);
    assert.equal(record1.promptKind, "task");
    assert.equal(
      isPidAlive(running.childPid) === false && (gen1Tree == null || isPidAlive(gen1Tree.childPid) === false),
      true,
      "no managed CLI root may still be alive after generation 1"
    );
    const attempts1 = record1.attempts as Array<Record<string, unknown>>;
    assert.deepEqual(attempts1.map((attempt) => attempt.generation), [0, 1], "exactly one attempt per generation");
    assert.deepEqual(attempts1.map((attempt) => attempt.model), [MODEL, MODEL]);
    assert.deepEqual(attempts1.map((attempt) => attempt.rateLimited), [false, false]);
    assert.deepEqual(attempts1.map((attempt) => attempt.exitCode), [0, 0]);
    assert.equal(attempts1[1]!.resumedFrom, sessionId, "the second attempt must resume from the persisted session");
    assert.match(fs.readFileSync(logPath, "utf8"), new RegExp(FIRST_MARKER), "the job log must carry both generations' streams");

    // ---- 6. One snapshot + one short callback per generation; no duplicates --
    await waitForDeliveredWake(client, listener, jobId, 2);
    assert.equal(listener.bodies.length, 2, "each generation must wake the caller exactly once");
    for (const [index, body] of listener.bodies.entries()) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ["job_id", "status"], "the callback body is short and fixed");
      assert.equal(parsed.job_id, jobId);
      assert.equal(parsed.status, "done");
      assert.equal(body.includes(FIRST_MARKER), false, "the callback must not carry assistant text");
      assert.equal(body.includes(FIRST_TASK) || body.includes(FOLLOW_TASK), false, `callback ${index} must not carry task text`);
      assert.equal(body.includes(String(sessionId)), false, "the callback must not carry a provider session");
      for (const secret of ["sk-", "Bearer", "Authorization", "api_key", "apiKey"]) {
        assert.equal(body.includes(secret), false, `callback ${index} must not carry a credential (${secret})`);
      }
    }
    assert.deepEqual(
      listNames(path.join(dataRoot, "terminal"), ".json"),
      [`${jobId}.gen-0.json`, `${jobId}.gen-1.json`],
      "exactly one terminal snapshot per generation"
    );
    assert.deepEqual(
      listNames(path.join(dataRoot, "notify"), ".result.json"),
      [`${jobId}.gen-0.result.json`, `${jobId}.gen-1.result.json`],
      "exactly one recorded wake attempt per generation"
    );
    const notifications = readNotificationResults(dataRoot, jobId);
    assert.deepEqual(notifications.map((n) => n.generation), [0, 1]);
    assert.deepEqual(notifications.map((n) => n.kind), ["callback", "callback"]);
    assert.deepEqual(notifications.map((n) => n.delivered), [true, true]);
    const history = loadUserMessagesInfo(dataRoot, jobId);
    assert.deepEqual(history.messages.map((message) => message.generation), [0, 1], "no duplicate user message");
    assert.deepEqual(history.messages.map((message) => message.text), [FIRST_TASK, FOLLOW_TASK]);
    const status = McpStdioClient.json(await client.callTool("jobquay_status", {}));
    assert.equal(status.count, 1, "exactly one job must exist after both generations");
    assert.deepEqual(listNames(path.join(dataRoot, "jobs"), ".json"), [`${jobId}.json`]);

    // ---- 6b. Close and reopen the MCP entry once more: the result persists ---
    await client.close();
    client = new McpStdioClient(mcpEntry, mcpEnv, foreignCwd);
    await client.initialize();
    const reread = McpStdioClient.json(await client.callTool("jobquay_result", { id: jobId }));
    assert.equal(reread.status, "done");
    assert.equal(reread.generation, 1);
    assert.equal(reread.model, MODEL);
    assert.match(String((reread.result as Record<string, unknown>).final_text), new RegExp(FIRST_MARKER));
    const rereadRecord = readRecord(dataRoot, jobId);
    assert.equal(rereadRecord.sessionId, sessionId, "the reopened entry reads the same persisted session");
    assert.equal(rereadRecord.childPid, null);

    // ---- 6c. Every captured process of both generations has really exited ---
    const stillAlive = await waitForOwnedExit(owned, 30000);
    assert.deepEqual(
      stillAlive,
      [],
      `captured worker/CLI processes must be gone after both generations: ${stillAlive.join(", ")}`
    );
    const workspacesAfter = filesInside(project);
    const newWorkspaceFiles = workspacesAfter.filter((file) => !workspaceFilesBefore.includes(file));
    console.log(
      `[installed-cc] gen0/gen1=done attempts=2 callbacks=${listener.bodies.length} snapshots=${listNames(path.join(dataRoot, "terminal"), ".json").length}` +
        ` session=${sessionId} pids=${owned.map((item) => `${item.role}:${item.pid}`).join(",")}` +
        ` workspaceNewFiles=${newWorkspaceFiles.length ? newWorkspaceFiles.join(",") : "none"}`
    );
    assert.equal(sha256File(settingsPath), settingsHash, "the project-scoped model pin must be untouched by both runs");
    assert.ok(newWorkspaceFiles.every((file) => !file.includes("settings.json")), "the CLI must not rewrite the model pin");

    // ---- 7. The install entry and target were not changed by the runs --------
    assert.equal(sha256File(mcpEntry), entryHash, "the installed MCP entry must be untouched by the jobs");
    assert.equal(sha256File(mcpConfigPath), mcpConfigHash, "the installed .mcp.json must be untouched by the jobs");
    assert.equal(sha256File(path.join(target, ".jobquay-install.json")), markerHash, "the install marker must be untouched by the jobs");
    assert.equal(fs.existsSync(path.join(target, "src")), false);

    // ---- 8. Uninstall removes only the managed runtime -----------------------
    const uninstaller = path.join(target, "dist", "cli", "install-cli.js");
    const removed = runInstaller(uninstaller, ["uninstall", "--target", target], foreignCwd, installerEnv);
    assert.equal(removed.status, 0, removed.stdout);
    assert.equal(removed.json.ok, true);
    assert.equal(removed.json.command, "uninstall");
    assert.equal(removed.json.installId, installed.json.installId);
    assert.equal(path.resolve(String(removed.json.target)), path.resolve(target));
    assert.equal(removed.json.dataRootUntouched, true);
    assert.equal(removed.json.targetRemoved, true, "an installation with no unowned files must leave no directory behind");
    const removedPaths = (removed.json.removed as { paths: string[] }).paths;
    assert.ok(removedPaths.includes("dist/mcp/server.js"), `the managed MCP entry must be removed: ${JSON.stringify(removedPaths.slice(0, 5))}`);
    assert.ok(removedPaths.includes("dist/cli/job-cli.js"), "the managed worker entry must be removed");
    assert.equal((removed.json.preserved as { count: number }).count, 0, "nothing unowned may be preserved inside the target");
    assert.equal((removed.json.modifiedManagedFiles as { count: number }).count, 0, "no managed file may have been modified by the runs");
    assert.equal(fs.existsSync(target), false, "the managed runtime must be gone after uninstall");

    // The data root is RETAINED by the product and cleaned by this test instead.
    assert.equal(fs.readFileSync(dataSentinel, "utf8"), "data root survives uninstall\n");
    assert.ok(fs.existsSync(path.join(dataRoot, "jobs", `${jobId}.json`)), "the durable job record must survive uninstall");
    assert.ok(fs.existsSync(path.join(dataRoot, "messages", `${jobId}.json`)));
    assert.deepEqual(listNames(path.join(dataRoot, "terminal"), ".json"), [`${jobId}.gen-0.json`, `${jobId}.gen-1.json`]);
    assert.ok(fs.existsSync(logPath));
    // Nothing outside the target was touched by install + jobs + uninstall.
    assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "outside the install target\n");
    assert.ok(fs.existsSync(workspace), "the test's own temp root must still be intact for its self-cleanup");
    assert.ok(fs.existsSync(project), "the job workspace must not be touched by uninstall");
    console.log(
      `[installed-cc] uninstalled target=${target} installId=${String(installed.json.installId)} targetRemoved=${String(removed.json.targetRemoved)} ` +
        `preserved=${(removed.json.preserved as { count: number }).count} dataRootUntouched=${String(removed.json.dataRootUntouched)}`
    );
  } catch (e) {
    failure = e;
  }

  // -------------------------------------------------------------------------
  // Cleanup: prove nothing of this run survives, remove only our own tree.
  // No process is ever signalled by this test: a non-terminal job is stopped
  // through the product's own cancel, and captured PIDs are only waited on.
  // -------------------------------------------------------------------------
  const problems: string[] = [];
  try {
    if (listener) await listener.close();
  } catch (e) {
    problems.push(`could not close the loopback wake listener: ${errorMessage(e)}`);
  }
  if (jobId) {
    const recordFile = path.join(dataRoot, "jobs", `${jobId}.json`);
    if (fs.existsSync(recordFile) && !TERMINAL.has(String(readRecord(dataRoot, jobId).status))) {
      try {
        if (!client && mcpEntry && fs.existsSync(mcpEntry)) {
          client = new McpStdioClient(mcpEntry, mcpEnv, foreignCwd);
          await client.initialize();
        }
        if (!client) {
          problems.push(`job ${jobId} is not terminal and the installed entry is gone; tree kept at ${workspace}`);
        } else {
          await client.callTool("jobquay_cancel", { id: jobId, wait_seconds: 8 });
          const after = McpStdioClient.json(await client.callTool("jobquay_result", { id: jobId }));
          if (!TERMINAL.has(String(after.status))) {
            problems.push(`job ${jobId} never proved terminal (status=${String(after.status)}); tree kept at ${workspace}`);
          }
        }
      } catch (e) {
        problems.push(`could not cancel/confirm job ${jobId}: ${errorMessage(e)}; tree kept at ${workspace}`);
      }
    }
  }
  if (owned.length > 0) {
    const survivors = await waitForOwnedExit(owned, 15000);
    for (const pid of survivors) {
      const entry = owned.find((item) => item.pid === pid)!;
      problems.push(`process of this run did not exit (${entry.role} PID ${pid}); nothing was signalled`);
    }
  }
  try {
    if (client) await client.close();
  } catch (e) {
    problems.push(`could not close the MCP client: ${errorMessage(e)}`);
  }
  if (problems.length === 0) {
    const removal = await removeTree(workspace);
    if (!removal.removed) {
      problems.push(`could not remove this run's temp tree ${workspace}: ${removal.lastError ?? "unknown"}`);
    }
  } else {
    problems.push(`this run's temp tree was KEPT for diagnosis: ${workspace}`);
  }

  if (problems.length > 0) {
    const cleanupError = new Error(
      `cleanup verification failed for job=${String(jobId)} root=${workspace}: ${problems.join(" | ")}`
    );
    if (failure) throw new AggregateError([failure, cleanupError], "acceptance failed and cleanup reported residue");
    throw cleanupError;
  }
  if (failure) throw failure;
});
