// job-harness.test.ts — CROSS-PROCESS acceptance of the durable job service via
// the BUILT harness (`dist/cli/job-cli.js`), driven from separate processes with
// an isolated CrewDispatch data root, a DISPOSABLE ISOLATED TEST PROFILE, and a
// controlled executable fixture.
//
// It proves, without any mock of the service:
//   * `start` returns a stable job id promptly and the job keeps running after
//     the REQUESTING process is killed (accepted job lifetime ≠ caller lifetime);
//   * the job runs in the REQUESTED project cwd with the caller's environment
//     (the isolated test profile), not in a per-job isolation tree;
//   * explicit cancel kills the process TREE (child + grandchild) and leaves
//     exactly one terminal state, idempotently;
//   * the CLI's internal segment boundary resumes the SAME logical job with a
//     new generation when a session id is known;
//   * a terminal job can receive a later continuation (a new generation);
//   * restart reconciliation marks a dead owner's job interrupted and never
//     reruns a terminal one.
//
// The isolated profile is created HERE (the test boundary) with the batch-1
// `createCliIsolation` helper and passed into the harness/worker through the
// child process environment plus `--cwd`. The executable is a fixture, so this is
// NOT real-provider success evidence — the real-`cmdc` boundary is covered by
// `test:e2e:job-service`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { RECOVERY_PROMPT, createJobRecord } from "../../jobs/service";
import { readTreeConfirmation, saveJob } from "../../jobs/store";
import { evaluateWorkspace } from "../../jobs/workspace";
import { emptyUsage } from "../../jobs/types";
import { captureProcessIdentity, enumerateProcesses, isPidAlive, killProcessTree, type ProcessEntry } from "../../runtime/process";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { createFailureEvidence, runWithFailureEvidence } from "../helpers/failure-evidence";

const HARNESS = path.join(__dirname, "..", "..", "cli", "job-cli.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface HarnessRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function runHarness(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30000): Promise<HarnessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`harness timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(out) as Record<string, unknown>;
      } catch {
        json = {};
      }
      resolve({ code, stdout: out, stderr: err, json });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Teardown contract -------------------------------------------------------
// Every process this file starts whose CWD lives INSIDE a workspace must be
// PROVABLY GONE before the workspace is removed: on Windows the recursive remove
// of a directory that is a live process's current directory fails with
// EPERM/EBUSY. The detached job WORKER (`dist/cli/job-cli.js worker`, spawned by
// `start`/`resume`) keeps `<ws.dir>/root` as its cwd until it exits, so a
// workspace must not be removed until that EXACT worker has exited — a durable
// terminal status does NOT prove the worker process is gone. These bounds are
// FINITE waits for a real process exit (never an arbitrary sleep, never a
// blanket delete retry): a worker still alive/unknown after the bound stays a
// HARD failure that keeps its PID evidence.
const WORKER_EXIT_TIMEOUT_MS = 15000;
const CHILD_CLOSE_TIMEOUT_MS = 15000;

/**
 * Poll until `pid` is provably gone. Returns the last liveness reading: `false`
 * (gone), `true` (alive at the bound) or `null` (unprobeable at the bound) —
 * never a guess.
 */
async function pollPidGone(pid: number, timeoutMs: number, pollMs = 25): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = isPidAlive(pid);
    if (alive === false) return false;
    if (Date.now() >= deadline) return alive;
    await sleep(pollMs);
  }
}

/**
 * A one-shot observation of a child's `close` event.
 *
 * `close` (process exited AND its stdio drained) — NOT `exit` — is the correct
 * teardown signal: a descendant that INHERITED the child's pipes keeps them open
 * after the child's `exit`, so `close` can lag `exit` arbitrarily. The
 * observation is registered the MOMENT the child is spawned so an early close
 * can never be missed. `closed` never rejects, so it is safe to hold (unawaited)
 * during a test body without an unhandled rejection; the finite deadline is
 * applied only when cleanup begins (see `awaitObservedClose`).
 */
interface CloseObservation {
  /** Resolves the first time the child's `close` event fires. Never rejects. */
  closed: Promise<void>;
  /** True once `close` has already been observed. */
  closedAlready(): boolean;
}

/** Register a child's `close` observation immediately (call right after `spawn`). */
function observeClose(child: ChildProcess): CloseObservation {
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  return { closed: closedPromise, closedAlready: () => closed };
}

/**
 * Await the ACTUAL observed `close` (exit + drained stdio) of a child, with a
 * finite deadline that STARTS HERE — never at spawn, so a cleanup deadline is
 * never started long before cleanup is requested. Exit alone is NOT close. The
 * deadline timer exists only for the race and is always cleared, so no rejection
 * can escape during the test body.
 */
async function awaitObservedClose(obs: CloseObservation, child: ChildProcess, timeoutMs: number): Promise<void> {
  if (obs.closedAlready()) return;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`client pid=${child.pid} did not emit close within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([obs.closed, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Workspace {
  dir: string;
  root: string;
  /** The disposable isolated test profile handed to the harness/worker. */
  iso: CliIsolation;
  /** PIDs of detached workers THIS run started (their cwd is `<dir>/root`). */
  workers: number[];
  cleanup: () => Promise<void>;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-harness-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  if (process.platform === "win32") iso.env.JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN = "1";
  const workers: number[] = [];
  return {
    dir,
    root,
    iso,
    workers,
    cleanup: async () => {
      // Await the EXACT detached workers this run started before removing the
      // workspace. A worker still alive/unknown after the finite bound is an
      // honest HARD failure with PID evidence; we never delete anyway to conceal
      // a live process (the temp tree is left as evidence instead).
      for (const pid of workers) {
        const gone = await pollPidGone(pid, WORKER_EXIT_TIMEOUT_MS);
        if (gone !== false) {
          throw new Error(
            `detached job worker pid=${pid} was still ${gone === null ? "UNKNOWN (unprobeable)" : "ALIVE"} ` +
              `${WORKER_EXIT_TIMEOUT_MS}ms after the job settled; refusing to remove its owned workspace ${dir}`
          );
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Run a harness command that may launch a detached worker (`start`/`resume`) and
 * record the worker's PID, so the workspace is removed only after that exact
 * worker exits. Refused `resume`s report no worker and record nothing.
 */
async function runTracked(ws: Workspace, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<HarnessRun> {
  const run = await runHarness(args, cwd, env);
  const pid = run.json.workerPid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) ws.workers.push(pid);
  return run;
}

function writeFixture(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

const FIXTURE_HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });',
  'process.stdin.on("end", () => {'
];

function fixtureSuccess(): string[] {
  return [
    ...FIXTURE_HEADER,
    '  const sid = "fx-session-0001";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  out({ type: "assistant", message: { content: [{ type: "text", text: "echo:" + input.trim() }] } });',
    '  out({ type: "result", subtype: "success", result: "ok:" + input.trim(), session_id: sid, stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } });',
    "  process.exit(0);",
    "});"
  ];
}

function fixtureSlowSuccess(ms: number): string[] {
  return [
    ...FIXTURE_HEADER,
    '  const sid = "fx-session-slow";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    `  setTimeout(() => { out({ type: "result", subtype: "success", result: "slow:" + input.trim(), session_id: sid, stop_reason: "end_turn" }); process.exit(0); }, ${ms});`,
    "});"
  ];
}

function fixtureSegmentThenSuccess(): string[] {
  return [
    ...FIXTURE_HEADER,
    '  const fs = require("node:fs");',
    '  const path = require("node:path");',
    '  const sid = "fx-session-seg";',
    "  const resume = process.argv.includes(\"--resume\");",
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    // Record exactly what each attempt received on stdin, so the test can prove a
    // resumed attempt uses the fixed internal recovery prompt, never the task.
    '  fs.appendFileSync(path.join(process.cwd(), "segment-stdin.txt"), (resume ? "resume:" : "first:") + input + "\\n");',
    "  if (!resume) {",
    '    out({ type: "result", subtype: "max_turns", result: "partial", session_id: sid, stop_reason: "max_turns" });',
    "    process.exit(8);",
    "  }",
    '  out({ type: "result", subtype: "success", result: "final:" + input.trim(), session_id: sid, stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

/** Records the cwd + HOME the child actually received, then succeeds. */
function fixtureCwdProof(): string[] {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    '  const cwd = process.cwd();',
    '  const home = process.env.HOME || process.env.USERPROFILE || "";',
    '  fs.writeFileSync(path.join(cwd, "jobquay-cwd-proof.txt"), cwd + "\\n" + home + "\\n");',
    '  const sid = "fx-session-cwd";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  out({ type: "result", subtype: "success", result: "cwd:" + cwd, session_id: sid, stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}


function fixtureSuccessWithEscapedDescendant(): string[] {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    '  const sid = "fx-session-natural-escaped";',
    '  const escaped = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", windowsHide: true });',
    '  escaped.unref();',
    '  fs.writeFileSync(path.join(process.cwd(), "natural-escaped.pid"), String(escaped.pid));',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  out({ type: "result", subtype: "success", result: "escaped-success:" + input.trim(), session_id: sid, stop_reason: "end_turn" });',
    // Keep the root alive briefly after the terminal line so the product's
    // terminal-record hook can take a real pre-close Darwin process snapshot.
    '  setTimeout(() => process.exit(0), 250);',
    '});'
  ];
}
function fixtureHangWithGrandchild(): string[] {
  return [
    'const { spawn } = require("node:child_process");',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    '  const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-hang" } });',
    '  out({ type: "event", event: { type: "grandchild", pid: grand.pid } });',
    "  setInterval(() => {}, 1000);",
    "});"
  ];
}

/**
 * A CLI-shaped fixture that reaches the internal segment boundary (`max_turns`)
 * and, on the FIRST run, leaves a real DETACHED Node descendant behind (recording
 * its PID in the requested cwd) before exiting. A `--resume` run would report
 * success. This is the exact shape that used to start generation 1 over a
 * surviving descendant of the dead root.
 */
function fixtureSegmentWithDescendant(): string[] {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    '  const sid = "fx-session-descendant";',
    '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
    '  if (!process.argv.includes("--resume")) {',
    '    const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", windowsHide: true });',
    '    grand.unref();',
    '    fs.writeFileSync(path.join(process.cwd(), "segment-descendant.pid"), String(grand.pid));',
    '    out({ type: "result", subtype: "max_turns", result: "partial", session_id: sid, stop_reason: "max_turns" });',
    '    process.exit(8);',
    '  }',
    '  out({ type: "result", subtype: "success", result: "resumed:" + input.trim(), session_id: sid, stop_reason: "end_turn" });',
    '  process.exit(0);',
    '});'
  ];
}

/**
 * A real Node root that spawns a real, DETACHED Node grandchild (which survives
 * the root's exit) and then exits on its own. This is a real "root gone, a
 * descendant still alive" tree — the matrix-E condition.
 */
function writeOrphanTreeFixture(dir: string): string {
  const file = path.join(dir, "orphan-tree.js");
  fs.writeFileSync(
    file,
    [
      'const { spawn } = require("node:child_process");',
      'const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true, windowsHide: true });',
      "grand.unref();",
      'process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grand.pid }) + "\\n");',
      "setTimeout(() => process.exit(0), 300);"
    ].join("\n"),
    "utf8"
  );
  return file;
}

function spawnOrphanTree(file: string): Promise<{ parentPid: number; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("orphan-tree fixture did not report its pids in time")), 15000);
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as { parent: number; grandchild: number };
        resolve({ parentPid: parsed.parent, grandchildPid: parsed.grandchild });
      } catch (e) {
        reject(e as Error);
      }
    });
    child.on("error", reject);
  });
}

async function waitTerminal(root: string, jobId: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 25000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await runHarness(["status", "--root", root, "--job", jobId], cwd, env);
    const job = run.json.job as Record<string, unknown> | undefined;
    if (job && TERMINAL.has(String(job.status))) return job;
    if (Date.now() >= deadline) throw new Error(`job ${jobId} did not reach a terminal state in time`);
    await sleep(150);
  }
}

function readLog(root: string, jobId: string): string {
  try {
    return fs.readFileSync(path.join(root, "logs", `${jobId}.ndjson`), "utf8");
  } catch {
    return "";
  }
}

// --- Original-instance identity (birth) capture ------------------------------
// A raw `isPidAlive(pid)` is NOT sufficient evidence after a cancel: Windows
// reuses a freed PID, so a live PID may be a DIFFERENT process than the one the
// job recorded. Before cancelling we capture each original's PID + creation time
// (its "birth"); after the cancel we re-observe. A live process with a DIFFERENT
// birth is a reuse (the original exited); a live process with the SAME birth is
// a genuine survivor (a hard failure); an unprobeable/unknown identity is left
// UNKNOWN and NEVER read as stopped.
interface PidObservation {
  pid: number | null;
  alive: boolean | null;
  identity: { pid: number; ppid: number; createdAtMs: number | null } | null;
  scanOk: boolean;
  scanReason: string | null;
  observedAt: string;
}

async function observePids(pids: ReadonlyArray<number | null>): Promise<PidObservation[]> {
  const observedAt = new Date().toISOString();
  const valid = pids.map((p) => (p != null && Number.isInteger(p) && p > 0 ? p : null));
  let scanOk = false;
  let scanReason: string | null = "not_scanned";
  let entries: ProcessEntry[] = [];
  try {
    const scan = await enumerateProcesses();
    scanOk = scan.ok;
    scanReason = scan.reason ?? null;
    entries = scan.processes;
  } catch (e) {
    scanOk = false;
    scanReason = `enumeration_failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
  }
  return valid.map((pid) => {
    const alive = pid != null ? isPidAlive(pid) : null;
    const entry = pid != null ? entries.find((p) => p.pid === pid) ?? null : null;
    return {
      pid,
      alive,
      identity: entry ? { pid: entry.pid, ppid: entry.ppid, createdAtMs: entry.createdAtMs } : null,
      scanOk,
      scanReason,
      observedAt
    };
  });
}

/**
 * Assert the ORIGINAL instance behind `pid` — identified by the creation time
 * captured BEFORE the cancel — is gone. `before` is that pre-cancel observation;
 * `after` is the post-cancel re-observation.
 */
function assertOriginalExited(label: string, before: PidObservation, after: PidObservation): void {
  if (after.alive === false) return; // the PID is gone → the original exited
  if (after.alive !== true) {
    assert.fail(`${label} pid=${after.pid}: liveness is UNKNOWN after a reported os_tree_exited — not proof of exit`);
  }
  if (!after.scanOk) {
    assert.fail(`${label} pid=${after.pid}: still alive but the OS scan was UNKNOWN (${after.scanReason ?? "no reason"}) — cannot distinguish a genuine survivor from PID reuse`);
  }
  if (after.identity == null) {
    assert.fail(`${label} pid=${after.pid}: still alive but absent from the OS scan — identity UNKNOWN, not proof of exit`);
  }
  const beforeBirth = before.identity?.createdAtMs ?? null;
  const afterBirth = after.identity?.createdAtMs ?? null;
  if (beforeBirth == null || afterBirth == null) {
    assert.fail(`${label} pid=${after.pid}: still alive and its creation time is unreported (before=${beforeBirth}, after=${afterBirth}) — identity UNKNOWN, not proof of exit`);
  }
  assert.notEqual(
    afterBirth,
    beforeBirth,
    `${label} pid=${after.pid}: the SAME original instance (birth ${beforeBirth}) is still alive after cancel reported os_tree_exited`
  );
  // Different creation time → the recorded PID was reused by a NEW process; the
  // original exited (this is the reuse case the raw liveness probe cannot see).
}

test("start returns promptly and the job survives the requesting process being killed", { timeout: 60000 }, async () => {
  const ws = newWorkspace("disconnect");
  const fixture = writeFixture(ws.dir, "slow.js", fixtureSlowSuccess(2500));
  // The killed waiting CLIENT is tracked so its exact `close` is awaited before
  // the workspace is removed. The body exception (if any) and the teardown
  // exception are BOTH preserved, so a failing cleanup can never mask a failing
  // body (the masking that hid this failure's primary result).
  let waiter: ChildProcess | null = null;
  let waiterClose: CloseObservation | null = null;
  let primaryError: unknown = null;
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "disconnect me", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    assert.equal(started.code, 0, started.stderr);
    const jobId = String(started.json.jobId);
    assert.match(jobId, /^job-/);

    // A waiting CLIENT is killed mid-flight; the accepted job must keep running.
    waiter = spawn(process.execPath, [HARNESS, "wait", "--root", ws.root, "--job", jobId, "--timeout-ms", "30000"], {
      cwd: ws.dir,
      env: ws.iso.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    // Register the close observation IMMEDIATELY, so an early close is never missed.
    waiterClose = observeClose(waiter);
    await sleep(400);
    waiter.kill();
    const early = await runHarness(["status", "--root", ws.root, "--job", jobId], ws.dir, ws.iso.env);
    assert.equal(String((early.json.job as Record<string, unknown>).status), "running");

    const job = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
    assert.equal(job.status, "done");
    assert.equal(job.generation, 0);
    assert.equal((job.result as Record<string, unknown>).finalText, "slow:disconnect me");
    assert.match(readLog(ws.root, jobId), /"subtype":"success"/);
  } catch (e) {
    primaryError = e;
  }

  let cleanupError: unknown = null;
  try {
    // Await the exact killed CLIENT's observed close, then the tracked detached
    // WORKER's exit, before removing the workspace (see the teardown contract).
    if (waiter && waiterClose) await awaitObservedClose(waiterClose, waiter, CHILD_CLOSE_TIMEOUT_MS);
    await ws.cleanup();
  } catch (e) {
    cleanupError = e;
  }

  if (primaryError != null && cleanupError != null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "disconnect-harness: BOTH the test body and the workspace teardown failed (see the aggregated errors)"
    );
  }
  if (primaryError != null) throw primaryError;
  if (cleanupError != null) throw cleanupError;
});

/**
 * The close-wait boundary as a REAL separate-process distinction: a child that
 * has already EXITED but whose short-lived descendant still holds the child's
 * INHERITED stdio is NOT closed yet. `close` (exit + drained stdio) — not `exit`
 * — is the correct teardown signal, and the old `exitCode !== null` shortcut
 * would resolve on `exit` alone. This registers the close observation at spawn,
 * awaits the child's `exit`, then asserts the wait does NOT resolve until the
 * descendant releases the pipes and the real close fires. All processes, stdio
 * and cwd stay inside this run's disposable fixture; the descendant's lifetime
 * and every wait are bounded and cleaned up.
 */
test("the close wait resolves on the real close, not on exit alone (a descendant holds the inherited stdio)", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-harness-closeboundary-"));
  const marker = path.join(dir, "grandchild.pid");
  // The CHILD exits immediately; the descendant it spawns INHERITS the child's
  // stdio, so it holds this run's pipes open after the child's `exit`.
  const childSrc = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawn } = require("node:child_process");',
    // DETACHED + inherited stdio: the descendant SURVIVES this child's exit and
    // keeps this run's pipes open, so the parent's `close` must lag `exit`.
    'const grand = spawn(process.execPath, ["-e", "setTimeout(()=>{},1500)"], { detached: true, stdio: "inherit", windowsHide: true });',
    'grand.unref();',
    'fs.writeFileSync(path.join(process.cwd(), "grandchild.pid"), String(grand.pid));',
    "process.exit(0);"
  ].join("\n");
  let child: ChildProcess | null = null;
  let grandPid: number | null = null;
  try {
    child = spawn(process.execPath, ["-e", childSrc], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const obs = observeClose(child); // registered IMMEDIATELY: an early close cannot be missed
    const exited = once(child, "exit"); // registered immediately too, so a fast exit is not missed

    const deadline = Date.now() + 10000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(20);
    if (fs.existsSync(marker)) grandPid = Number(fs.readFileSync(marker, "utf8").trim());

    await exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the child must have exited");
    assert.equal(obs.closedAlready(), false, "exit alone is NOT a close while the descendant holds the inherited pipes");

    // The OLD `exitCode !== null` shortcut would resolve HERE. The fixed wait must
    // not resolve until the real close (the descendant released the pipes).
    let resolved = false;
    const waiting = awaitObservedClose(obs, child, 15000).then(() => {
      resolved = true;
    });
    await sleep(300); // the descendant (~1.5 s) is still holding the inherited stdio
    assert.equal(resolved, false, "the close wait must NOT resolve on exit alone");
    await waiting; // resolves only once the descendant exits and the real close fires
    assert.equal(resolved, true, "the close wait must resolve once the real close fires");
    assert.equal(obs.closedAlready(), true);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* best effort */ }
    }
    if (grandPid) await killProcessTree(grandPid, { graceMs: 2000 }).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the job runs in the requested project cwd with the caller environment, not a per-job isolation tree", { timeout: 60000 }, async () => {
  const ws = newWorkspace("cwdproof");
  const fixture = writeFixture(ws.dir, "cwd-proof.js", fixtureCwdProof());
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "cwd proof", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    assert.equal(started.code, 0, started.stderr);
    const jobId = String(started.json.jobId);
    const job = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
    assert.equal(job.status, "done");

    // The fixture's own write proves the child ran IN the requested cwd...
    const proof = path.join(ws.iso.cwd, "jobquay-cwd-proof.txt");
    assert.ok(fs.existsSync(proof), `the fixture must write into the requested project cwd: ${proof}`);
    const proofLines = fs.readFileSync(proof, "utf8").trim().split("\n");
    assert.equal(fs.realpathSync.native(proofLines[0] ?? ""), fs.realpathSync.native(ws.iso.cwd));
    // ...and with the isolated test environment (HOME) the test passed in.
    assert.equal(fs.realpathSync.native(proofLines[1] ?? ""), fs.realpathSync.native(ws.iso.cliHome));

    // Production must not have created any per-job isolation tree of its own.
    assert.equal(fs.existsSync(path.join(ws.root, "cli-runs")), false);
  } finally {
    await ws.cleanup();
  }
});

test("explicit cancel kills the child+grandchild tree and yields exactly one terminal state", { timeout: 60000 }, async () => {
  const ws = newWorkspace("cancel");
  const fixture = writeFixture(ws.dir, "hang.js", fixtureHangWithGrandchild());
  // Original-instance identities (PID + birth) captured BEFORE the cancel, and
  // the post-cancel re-observation. Retained via the failure-evidence utility so
  // a future failure keeps the exact decision-time identities, the kill
  // confirmation and the durable job/log state before teardown deletes the root.
  let childPid: number | null = null;
  let grandchildPid: number | null = null;
  let identities: Record<string, unknown> = {};
  const evidence = createFailureEvidence({
    name: "job-harness-explicit-cancel-tree",
    dataRoot: ws.root,
    workspaceDir: ws.dir,
    childPid: () => childPid,
    extra: () => ({ childPid, grandchildPid, identities })
  });
  await runWithFailureEvidence(
    evidence,
    async () => {
      const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "cancel me", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
      const jobId = String(started.json.jobId);

      // Wait until the running child pid is persisted, then read the grandchild pid.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && childPid == null) {
        const s = await runHarness(["status", "--root", ws.root, "--job", jobId], ws.dir, ws.iso.env);
        childPid = (s.json.job as Record<string, unknown>).childPid as number | null;
        if (childPid == null) await sleep(150);
      }
      assert.ok(childPid, "child pid should be persisted while running");
      await sleep(600);
      const log = readLog(ws.root, jobId);
      const m = /"grandchild","pid":(\d+)/.exec(log);
      assert.ok(m, `grandchild pid should appear in the log; log=${log}`);
      grandchildPid = Number(m[1]);
      assert.equal(isPidAlive(childPid), true);
      assert.equal(isPidAlive(grandchildPid), true);

      // Capture the ORIGINAL identities (PID + creation time) BEFORE the cancel.
      const beforeObs = await observePids([childPid, grandchildPid]);
      const childBefore = beforeObs[0]!;
      const grandBefore = beforeObs[1]!;
      identities = { child: { before: childBefore }, grandchild: { before: grandBefore } };
      assert.ok(childBefore.identity, "the original child must be identifiable before the cancel");
      assert.ok(grandBefore.identity, "the original grandchild must be identifiable before the cancel");

      const cancelled = await runHarness(["cancel", "--root", ws.root, "--job", jobId], ws.dir, ws.iso.env);
      identities = { ...identities, kill: cancelled.json.kill ?? null, cancelStatus: (cancelled.json.job as Record<string, unknown> | undefined)?.status ?? null };
      assert.equal(cancelled.code, 0, cancelled.stderr);
      const cjob = cancelled.json.job as Record<string, unknown>;
      assert.equal(cjob.status, "cancelled");
      assert.equal((cancelled.json.kill as Record<string, unknown>).confirmed, true);
      assert.equal((cancelled.json.kill as Record<string, unknown>).scope, "os_tree_exited", "cancel must expose a proven OS tree exit");

      // Re-observe: the ORIGINAL instances (by birth) must be gone. A reused PID
      // is not the original; a live SAME-birth process still fails.
      const afterObs = await observePids([childPid, grandchildPid]);
      const childAfter = afterObs[0]!;
      const grandAfter = afterObs[1]!;
      identities = {
        child: { before: childBefore, after: childAfter },
        grandchild: { before: grandBefore, after: grandAfter },
        kill: cancelled.json.kill ?? null
      };
      assertOriginalExited("direct child", childBefore, childAfter);
      assertOriginalExited("grandchild", grandBefore, grandAfter);

      // Idempotent: a second cancel changes nothing and does not re-kill.
      const again = await runHarness(["cancel", "--root", ws.root, "--job", jobId], ws.dir, ws.iso.env);
      const cjob2 = again.json.job as Record<string, unknown>;
      assert.equal(cjob2.status, "cancelled");
      assert.equal(cjob2.finishedAt, cjob.finishedAt, "the terminal timestamp must not change");

      const list = await runHarness(["list", "--root", ws.root], ws.dir, ws.iso.env);
      assert.equal(list.json.count, 1, "exactly one job record");
    },
    async () => {
      await ws.cleanup();
    }
  );
});


test(
  "Darwin natural success with an escaped descendant keeps tree evidence unresolved and protects the workspace",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch), timeout: 60_000 },
  async () => {
    const ws = newWorkspace("natural-escaped");
    const fixture = writeFixture(ws.dir, "natural-escaped.js", fixtureSuccessWithEscapedDescendant());
    let escapedPid = 0;
    try {
      const started = await runTracked(
        ws,
        ["start", "--root", ws.root, "--fixture", fixture, "--task", "natural escaped", "--cwd", ws.iso.cwd],
        ws.dir,
        ws.iso.env
      );
      const jobId = String(started.json.jobId);
      const job = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
      assert.equal(job.status, "done", "the provider's genuine success result remains authoritative");
      assert.equal((job.result as Record<string, unknown>).finalText, "escaped-success:natural escaped");
      assert.ok(job.childPid != null, "unresolved managed-tree root PID remains inspectable evidence");
      assert.equal(readTreeConfirmation(ws.root, jobId), null, "natural group exit is not a tree confirmation when an escaped descendant was observed");

      escapedPid = Number(fs.readFileSync(path.join(ws.iso.cwd, "natural-escaped.pid"), "utf8").trim());
      assert.ok(Number.isInteger(escapedPid) && escapedPid > 0);
      assert.equal(isPidAlive(escapedPid), true, "the escaped descendant demonstrates the old group did not contain all work");

      const occupancy = evaluateWorkspace(ws.root, ws.iso.cwd);
      assert.equal(occupancy.holder?.jobId, jobId, "the terminal record still protects its workspace while tree evidence is unresolved");
      assert.equal(occupancy.holder?.retainedChildPid, job.childPid);
    } finally {
      if (escapedPid > 0) await killProcessTree(escapedPid, { graceMs: 2_000 }).catch(() => undefined);
      await ws.cleanup();
    }
  }
);
test("the CLI segment boundary resumes the SAME job in a new generation", { timeout: 60000 }, async () => {
  const ws = newWorkspace("segment");
  const fixture = writeFixture(ws.dir, "segment.js", fixtureSegmentThenSuccess());
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "seg", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    const jobId = String(started.json.jobId);
    const job = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
    assert.equal(job.status, "done");
    assert.equal(job.generation, 1);
    const attempts = job.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.resumedFrom, "fx-session-seg");
    // A segment-boundary resume must NOT re-send the full task as a new user
    // message: the resumed attempt carries the fixed internal recovery prompt.
    assert.equal((job.result as Record<string, unknown>).finalText, `final:${RECOVERY_PROMPT}`);
    // Prove it on the wire: the FIRST attempt received the task, the resumed
    // attempt received the recovery prompt (never the task again).
    const recorded = fs
      .readFileSync(path.join(ws.iso.cwd, "segment-stdin.txt"), "utf8")
      .trim()
      .split("\n");
    assert.equal(recorded[0], "first:seg");
    assert.equal(recorded[1], `resume:${RECOVERY_PROMPT}`);
  } finally {
    await ws.cleanup();
  }
});

test("a terminal job accepts a later continuation as a new generation (--resume)", { timeout: 60000 }, async () => {
  const ws = newWorkspace("continuation");
  const fixture = writeFixture(ws.dir, "success.js", fixtureSuccess());
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "first", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    const jobId = String(started.json.jobId);
    const first = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
    assert.equal(first.status, "done");
    assert.equal(first.sessionId, "fx-session-0001");

    // The SAME isolated profile is passed to the continuation worker.
    const resumed = await runTracked(ws, ["resume", "--root", ws.root, "--job", jobId, "--task", "follow up", "--fixture", fixture], ws.dir, ws.iso.env);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.json.generation, 1);

    const job = await waitTerminal(ws.root, jobId, ws.dir, ws.iso.env);
    assert.equal(job.status, "done");
    assert.equal(job.generation, 1);
    assert.equal((job.result as Record<string, unknown>).finalText, "ok:follow up");
    const attempts = job.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1]?.resumedFrom, "fx-session-0001");
  } finally {
    await ws.cleanup();
  }
});

test("restart reconciliation settles a no-child dead owner but holds a dead-root job as orphaned, and never reruns a terminal one", { timeout: 40000 }, async () => {
  const ws = newWorkspace("reconcile");
  try {
    fs.mkdirSync(path.join(ws.root, "jobs"), { recursive: true });
    // (a) dead owner, NO CLI child was ever recorded → honestly interrupted.
    const deadOwner = createJobRecord({ task: "orphan", cwd: ws.iso.cwd });
    deadOwner.status = "running";
    deadOwner.owner = "jobquay-2147483647-x";
    deadOwner.ownerPid = 2147483647; // a PID that does not exist
    deadOwner.heartbeatAt = new Date(Date.now() - 600000).toISOString();
    deadOwner.childPid = null;
    saveJob(ws.root, deadOwner);

    // (b) dead owner, child ROOT already dead, NO tree confirmation → the TREE is
    //     unproven, so it must be held as the non-terminal `orphaned` (matrix E),
    //     never `interrupted`, and the PID must be kept.
    const deadRoot = createJobRecord({ task: "dead-root", cwd: ws.iso.cwd });
    deadRoot.status = "running";
    deadRoot.owner = "jobquay-2147483647-x";
    deadRoot.ownerPid = 2147483647;
    deadRoot.heartbeatAt = new Date(Date.now() - 600000).toISOString();
    deadRoot.childPid = 2147483646;
    deadRoot.childGeneration = 0;
    saveJob(ws.root, deadRoot);

    const done = createJobRecord({ task: "already done", cwd: ws.iso.cwd });
    done.status = "done";
    done.finishedAt = new Date().toISOString();
    saveJob(ws.root, done);

    const rec = await runHarness(["reconcile", "--root", ws.root], ws.dir, ws.iso.env);
    assert.equal(rec.code, 0, rec.stderr);
    const changed = rec.json.changed as Array<Record<string, unknown>>;
    assert.deepEqual(
      changed.map((c) => c.id).sort(),
      [deadOwner.id, deadRoot.id].sort()
    );
    const byId = new Map(changed.map((c) => [String(c.id), c]));
    assert.equal(byId.get(deadOwner.id)?.status, "interrupted");
    assert.equal(byId.get(deadRoot.id)?.status, "orphaned", "a dead root with no confirmation must not be terminal");

    const status = await runHarness(["status", "--root", ws.root, "--job", deadOwner.id], ws.dir, ws.iso.env);
    assert.equal((status.json.job as Record<string, unknown>).status, "interrupted");
    assert.equal((status.json.job as Record<string, unknown>).childPid, null);

    const deadRootStatus = await runHarness(["status", "--root", ws.root, "--job", deadRoot.id], ws.dir, ws.iso.env);
    const drj = deadRootStatus.json.job as Record<string, unknown>;
    assert.equal(drj.status, "orphaned");
    assert.equal(drj.childPid, 2147483646, "the child PID must be kept as evidence");

    const doneStatus = await runHarness(["status", "--root", ws.root, "--job", done.id], ws.dir, ws.iso.env);
    assert.equal((doneStatus.json.job as Record<string, unknown>).status, "done");
  } finally {
    await ws.cleanup();
  }
});

test("a job writes only inside its own data root", { timeout: 60000 }, async () => {
  const ws = newWorkspace("ownroot");
  const fixture = writeFixture(ws.dir, "success.js", fixtureSuccess());
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "own root", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    await waitTerminal(ws.root, String(started.json.jobId), ws.dir, ws.iso.env);
    const top = fs.readdirSync(ws.root).sort();
    for (const entry of top) {
      // `notify` holds the generation-scoped at-most-once terminal-wake claims
      // and result files; `terminal` holds the immutable terminal snapshots
      // (batch 3); `approval` holds the generation+request-scoped interactive
      // provider-approval request/decision files (JQ-20261001-26). Like
      // jobs/logs/cancel they live only inside CrewDispatch's own root.
      assert.ok(["jobs", "logs", "cancel", "notify", "terminal", "messages", "approval", "tree"].includes(entry), `unexpected top-level entry: ${entry}`);
    }
    // Production does not create a per-job CLI-isolation tree under the CrewDispatch root.
    assert.equal(fs.existsSync(path.join(ws.root, "cli-runs")), false);
    assert.ok(fs.existsSync(path.join(ws.root, "jobs")));
    assert.ok(fs.existsSync(path.join(ws.root, "logs")));
    const messageFile = path.join(ws.root, "messages", `${String(started.json.jobId)}.json`);
    assert.ok(fs.existsSync(messageFile), "the durable user-message side-car remains under the job data root");
  } finally {
    await ws.cleanup();
  }
});

test("a LIVE orphan child blocks a wrong terminal state and repeat runs; a confirmed kill reaches a safe cancelled", { timeout: 60000 }, async () => {
  const ws = newWorkspace("orphan");
  // A REAL, separate Node process stands in for the still-running CLI tree. It is
  // NOT a mock: the record's childPid is this process's real OS pid.
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true
  });
  try {
    const childPid = child.pid;
    assert.ok(childPid, "the orphan child must have a pid");
    await sleep(150);
    assert.equal(isPidAlive(childPid), true, "the orphan child must be alive");

    fs.mkdirSync(path.join(ws.root, "jobs"), { recursive: true });
    const job = createJobRecord({ task: "orphan", cwd: ws.iso.cwd });
    job.status = "running";
    job.generation = 0;
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647; // a PID that does not exist → owner provably dead
    job.heartbeatAt = new Date(Date.now() - 600000).toISOString();
    job.childPid = childPid;
    if (process.platform === "darwin") {
      const identity = captureProcessIdentity(childPid!);
      assert.ok(identity?.createdAtUs != null, "the Darwin orphan fixture has exact birth evidence");
      job.childStartedAtUs = identity!.createdAtUs!;
    }
    job.childGeneration = 0;
    job.attempts = [{
      generation: 0,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      endedAt: null,
      exitCode: null,
      kind: null,
      failureKind: null,
      segment: false,
      resumedFrom: null,
      model: null,
      modelSource: null,
      effort: null,
      rateLimited: false,
      switched: false,
      switchToModel: null,
      usage: emptyUsage()
    }];
    job.sessionId = "fx-session-orphan"; // a continuation WOULD otherwise be allowed
    saveJob(ws.root, job);

    // 1) reconcile must NOT write a wrong terminal state: with a live child it
    //    must hold the non-terminal orphaned state and keep the child PID.
    const rec = await runHarness(["reconcile", "--root", ws.root], ws.dir, ws.iso.env);
    assert.equal(rec.code, 0, rec.stderr);
    const changed = rec.json.changed as Array<Record<string, unknown>>;
    assert.deepEqual(changed.map((c) => c.id), [job.id]);
    assert.equal(changed[0]?.status, "orphaned");

    // 2) repeated reconcile/status is idempotent and never reruns the job.
    const rec2 = await runHarness(["reconcile", "--root", ws.root], ws.dir, ws.iso.env);
    assert.equal((rec2.json.changed as unknown[]).length, 0, "an orphaned job must not be re-reconciled");
    const s1 = await runHarness(["status", "--root", ws.root, "--job", job.id], ws.dir, ws.iso.env);
    const sj1 = s1.json.job as Record<string, unknown>;
    assert.equal(sj1.status, "orphaned");
    assert.equal(sj1.childPid, childPid, "the child PID must be preserved as evidence");
    assert.equal(sj1.finishedAt, null, "orphaned is not a finished job");
    assert.equal(isPidAlive(childPid), true, "the real child must still be alive");

    // 3) a continuation is refused: no new generation while the tree is unproven.
    const resume = await runTracked(ws, ["resume", "--root", ws.root, "--job", job.id, "--task", "again"], ws.dir, ws.iso.env);
    assert.equal(resume.code, 1);
    assert.equal(resume.json.code, "job_not_terminal");
    const s2 = await runHarness(["status", "--root", ws.root, "--job", job.id], ws.dir, ws.iso.env);
    assert.equal((s2.json.job as Record<string, unknown>).generation, 0, "no new generation may start");

    // 4) An explicit cancel that PROVES the tree exited reaches the safe terminal.
    const cancelled = await runHarness(["cancel", "--root", ws.root, "--job", job.id, "--wait-ms", "400"], ws.dir, ws.iso.env);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal((cancelled.json.kill as Record<string, unknown>).confirmed, true);
    const cj = cancelled.json.job as Record<string, unknown>;
    assert.equal(cj.status, "cancelled");
    assert.equal(cj.childPid, null);
    assert.equal(isPidAlive(childPid), false, "the real orphan child must be gone after the confirmed cancel");
  } finally {
    await killProcessTree(child.pid, { graceMs: 2000 }).catch(() => undefined);
    await ws.cleanup();
  }
});

test("a real dead ROOT with a live grandchild is never a false terminal and blocks resume (E, real processes)", { timeout: 60000 }, async () => {
  const ws = newWorkspace("e-real");
  const fixture = writeOrphanTreeFixture(ws.dir);
  const { parentPid, grandchildPid } = await spawnOrphanTree(fixture);
  try {
    assert.equal(isPidAlive(grandchildPid), true, "the detached grandchild must start alive");

    // The root exits on its own; the detached grandchild survives — a real dead
    // root with a live descendant, the exact matrix-E condition the old code
    // mislabelled as a proven tree exit.
    const deadline = Date.now() + 10000;
    while (isPidAlive(parentPid) !== false && Date.now() < deadline) await sleep(50);
    assert.equal(isPidAlive(parentPid), false, "the root must have exited");
    assert.equal(isPidAlive(grandchildPid), true, "the descendant must still be alive: the tree is NOT gone");

    fs.mkdirSync(path.join(ws.root, "jobs"), { recursive: true });
    const job = createJobRecord({ task: "e-real", cwd: ws.iso.cwd });
    job.status = "running";
    job.generation = 0;
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647; // owner provably dead
    job.heartbeatAt = new Date(Date.now() - 600000).toISOString();
    job.childPid = parentPid; // the recorded ROOT (now dead, descendant alive)
    job.childGeneration = 0;
    job.sessionId = "fx-session-e-real"; // a resume WOULD otherwise be allowed
    saveJob(ws.root, job);

    const rec = await runHarness(["reconcile", "--root", ws.root], ws.dir, ws.iso.env);
    assert.equal(rec.code, 0, rec.stderr);
    const changed = rec.json.changed as Array<Record<string, unknown>>;
    assert.deepEqual(changed.map((c) => c.id), [job.id]);
    assert.equal(changed[0]?.status, "orphaned", "a dead root with a live descendant must NOT be a terminal state");

    const s = await runHarness(["status", "--root", ws.root, "--job", job.id], ws.dir, ws.iso.env);
    const sj = s.json.job as Record<string, unknown>;
    assert.equal(sj.status, "orphaned");
    assert.equal(sj.childPid, parentPid, "the recorded root PID must be kept as evidence");
    assert.equal(sj.finishedAt, null, "orphaned is not a finished job");
    assert.equal(isPidAlive(grandchildPid), true, "the real descendant must still be alive");

    // No new generation may start over the unproven tree.
    const resume = await runTracked(ws, ["resume", "--root", ws.root, "--job", job.id, "--task", "again"], ws.dir, ws.iso.env);
    assert.equal(resume.code, 1);
    assert.equal(resume.json.code, "job_not_terminal");
    const s2 = await runHarness(["status", "--root", ws.root, "--job", job.id], ws.dir, ws.iso.env);
    assert.equal((s2.json.job as Record<string, unknown>).generation, 0, "no new generation may start");

    // Repeat reconcile is idempotent: no rerun, no rewrite.
    const rec2 = await runHarness(["reconcile", "--root", ws.root], ws.dir, ws.iso.env);
    assert.equal((rec2.json.changed as unknown[]).length, 0, "an orphaned job must not be re-reconciled");
  } finally {
    await killProcessTree(grandchildPid, { graceMs: 2000 }).catch(() => undefined);
    await killProcessTree(parentPid, { graceMs: 2000 }).catch(() => undefined);
    await ws.cleanup();
  }
});

/**
 * The segment-boundary tree-safety case, from the COMPILED harness with REAL
 * processes: generation 0 reaches `max_turns` and leaves a real DETACHED Node
 * descendant; the dead root must not be mistaken for a stopped tree, so
 * generation 1 must NEVER start while that descendant is alive.
 */
test("a max_turns segment with a surviving detached descendant never starts generation 1 (real processes)", { timeout: 60000, skip: process.platform !== "win32" && "Requires Windows preserved-PPID dead-root ancestry" }, async () => {
  const ws = newWorkspace("segment-descendant");
  // This fixture intentionally leaves a detached descendant; it must exercise
  // the real Windows process-table boundary, never the childless-fixture seam.
  ws.iso.env.JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN = "0";
  const fixture = writeFixture(ws.dir, "segment-descendant.js", fixtureSegmentWithDescendant());
  const marker = path.join(ws.iso.cwd, "segment-descendant.pid");
  let grandPid: number | null = null;
  try {
    const started = await runTracked(ws, ["start", "--root", ws.root, "--fixture", fixture, "--task", "segment", "--cwd", ws.iso.cwd], ws.dir, ws.iso.env);
    assert.equal(started.code, 0, started.stderr);
    const jobId = String(started.json.jobId);

    // The honest outcome is the non-terminal `orphaned` hold; a terminal state
    // would be a defect here. Poll until it settles.
    let job: Record<string, unknown> | null = null;
    const deadline = Date.now() + 30000;
    for (;;) {
      const s = await runHarness(["status", "--root", ws.root, "--job", jobId], ws.dir, ws.iso.env);
      const j = s.json.job as Record<string, unknown> | undefined;
      if (j && (String(j.status) === "orphaned" || TERMINAL.has(String(j.status)))) {
        job = j;
        break;
      }
      if (Date.now() >= deadline) throw new Error("segment-descendant job did not settle in time");
      await sleep(150);
    }
    assert.ok(job, "the job must be readable");
    if (fs.existsSync(marker)) grandPid = Number(fs.readFileSync(marker, "utf8").trim());

    assert.equal(job.status, "orphaned", "a surviving descendant must hold the job, not let generation 1 start");
    assert.equal(job.generation, 0, "generation 1 must NOT start while the descendant is alive");
    assert.equal((job.attempts as unknown[]).length, 1, "only the first attempt may have run");
    assert.ok(job.childPid, "the recorded (dead) root PID must be kept as evidence");
    assert.equal(job.finishedAt, null, "orphaned is not a finished job");
    assert.ok(grandPid && isPidAlive(grandPid) === true, "the real detached descendant must still be alive");

    // No second fixture run: no `--resume` run_start and no success result.
    const log = readLog(ws.root, jobId);
    assert.equal((log.match(/"run_start"/g) ?? []).length, 1, "the fixture must have started exactly once");
    assert.equal(log.includes('"subtype":"success"'), false, "the second (resume) fixture run must never have started");
  } finally {
    if (grandPid) await killProcessTree(grandPid, { graceMs: 2000 }).catch(() => undefined);
    await ws.cleanup();
  }
});

/**
 * An explicit cancel is the ONE entry point allowed to actively clean up a dead
 * root's surviving descendants. Here a real detached descendant survives its
 * root; a recorded generation start time makes the descendant locatable, so the
 * cancel kills it, confirms the tree exit and reaches a safe `cancelled`.
 */
test("an explicit cancel cleans up a dead root's surviving detached descendant and reaches cancelled (real processes)", { timeout: 60000, skip: process.platform !== "win32" && "Requires Windows preserved-PPID dead-root ancestry" }, async () => {
  const ws = newWorkspace("cancel-dead-root");
  const fixture = writeOrphanTreeFixture(ws.dir);
  const { parentPid, grandchildPid } = await spawnOrphanTree(fixture);
  try {
    const deadline = Date.now() + 10000;
    while (isPidAlive(parentPid) !== false && Date.now() < deadline) await sleep(50);
    assert.equal(isPidAlive(parentPid), false, "the root must have exited");
    assert.equal(isPidAlive(grandchildPid), true, "the detached descendant must still be alive");

    fs.mkdirSync(path.join(ws.root, "jobs"), { recursive: true });
    const job = createJobRecord({ task: "cancel-dead-root", cwd: ws.iso.cwd });
    job.status = "running";
    job.generation = 0;
    // This synthetic record has no real worker-owner process. Reuse the fixture's
    // already-observed-dead root PID solely as the owner-liveness witness. A huge
    // invented PID is NOT a portable dead-PID proof on Windows: process.kill(pid,0)
    // can report EINVAL/unknown rather than ESRCH, correctly blocking client
    // finalisation before the descendant-cleanup branch is reached.
    job.owner = `jobquay-${parentPid}-dead`;
    job.ownerPid = parentPid;
    job.heartbeatAt = new Date(Date.now() - 600000).toISOString();
    job.childPid = parentPid; // the recorded ROOT (now dead, descendant alive)
    job.childGeneration = 0;
    job.sessionId = "fx-session-cancel-dead-root";
    // A recorded generation start time is what lets the descendant be scoped to
    // this job's tree; the real descendant was created a moment ago.
    job.attempts = [{ generation: 0, startedAt: new Date(Date.now() - 2000).toISOString(), endedAt: null, exitCode: null, kind: null, failureKind: null, segment: false, resumedFrom: null, model: null, modelSource: null, effort: null, rateLimited: false, switched: false, switchToModel: null, usage: emptyUsage() }];
    saveJob(ws.root, job);

    // Previous hosted evidence already proved the production targeted CIM helper
    // can see this exact preserved-PPID descendant. Do not run a second identical
    // CIM query immediately before the real cancel: on a cold hosted provider that
    // extra probe can serialize with the cancel's own bounded query and turn the
    // acceptance itself into an artificial timeout. The cancel call below is the
    // production query we actually need to prove.
    const cancelled = await runHarness(["cancel", "--root", ws.root, "--job", job.id, "--wait-ms", "1500"], ws.dir, ws.iso.env);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    const cj = cancelled.json.job as Record<string, unknown>;
    assert.equal(cj.status, "cancelled", `a confirmed cleanup of the descendant must reach the safe terminal: ${JSON.stringify(cancelled.json)}`);
    assert.equal(cj.childPid, null, "a proven-stopped tree clears the PID");
    assert.equal((cancelled.json.kill as Record<string, unknown>).scope, "identified_descendants_stopped", "the bounded cleanup must be reported as such, never as an absolute tree exit");
    assert.equal(isPidAlive(grandchildPid), false, "the real descendant must be gone after the confirmed cancel");
  } finally {
    await killProcessTree(grandchildPid, { graceMs: 2000 }).catch(() => undefined);
    await killProcessTree(parentPid, { graceMs: 2000 }).catch(() => undefined);
    await ws.cleanup();
  }
});
