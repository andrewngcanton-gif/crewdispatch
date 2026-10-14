// claude-recovery-real.test.ts — REAL boundary evidence for the bounded local
// caller notification recovery.
//
// The observed defect: a Claude-owned job reached a terminal state while the
// conversation was CLOSED; the result was saved correctly, but the single
// notification failed (`inbox_unreachable`, phase `not_written`). Reopening the
// SAME session registered a NEW private binding and nothing was replayed.
//
// The chain exercised here is the production one: the REAL compiled SessionStart
// hook → the REAL authenticated local daemon (started/reused through
// `ensureJobDaemon`) → the PRODUCTION notification layer and Claude transport →
// a SEPARATE receiver process on a disposable named pipe / Unix socket. No
// `deliver()` shortcut and no direct pass invocation is taken: the recovery is
// triggered exactly the way an installed session triggers it.
//
// The receiver process stands in for the Claude host ON THE WIRE ONLY: it proves
// the transport reached a separate OS process with the exact expected frames and
// does NOT prove visible conversation receipt (that is the installed-host gate).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { TEST_DIRECT_DURABLE_LAUNCH_ENV } from "../../runtime/durable-launch";
import { McpStdioClient } from "../helpers/mcp-client";
import { listClaudeBindings } from "../../claude/binding";
import { createJobRecord } from "../../jobs/service";
import {
  jobPath,
  loadJob,
  readNotificationResult,
  readTerminalReadReceipt,
  readTerminalRecoveryResult,
  saveJob,
  terminalRecoveryClaimPath,
  writeNotificationResult
} from "../../jobs/store";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const HOOK_ENTRY = path.join(__dirname, "..", "..", "claude", "hook.js");
const RECEIVER_ENTRY = path.join(__dirname, "..", "..", "tests", "helpers", "claude-inbox-receiver.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const SESSION = "1a1a1a1a-2222-4333-8444-555555555555";

const HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

// The fixture APPENDS one line to an isolated receipt on EVERY entry, so a test
// can prove — independently of status/PID/null — that recovery never executed a
// worker again. This is the oracle that replaces "childPid === null".
function fixtureEcho(): string[] {
  return [
    'const fs = require("node:fs");',
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  const receipt = process.env.JOBQUAY_TEST_FIXTURE_RECEIPT;',
    '  if (receipt) fs.appendFileSync(receipt, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\\n");',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-rec" } });',
    '  out({ type: "result", subtype: "success", result: "RECOVERED-DONE-MARKER", session_id: "fx-session-rec", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  /** Isolated fixture-entry receipt (one line per fixture execution). */
  receipt: string;
  cleanup: () => void;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), `crewdispatch-claude-recovery-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-rec-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, `${name}.js`);
  fs.writeFileSync(fixture, fixtureEcho().join("\n"), "utf8");
  const receipt = path.join(dir, `${name}.runs.jsonl`);
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture, JOBQUAY_TEST_FIXTURE_RECEIPT: receipt };
  // These recovery fixtures never create managed descendants. On hosted Windows
  // keep the notification/recovery acceptance focused on the real hook + daemon +
  // wire path instead of paying the unrelated process-table boundary in the
  // daemon's passive terminal-holder sweep. Real descendant acceptance lives in
  // job-harness and explicitly disables this test-only seam.
  if (process.platform === "win32") {
    env.JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN = "1";
    // This suite proves SessionStart -> authenticated daemon -> recovery -> wire.
    // The real outside-Job-Object WMI creation boundary has its own dedicated
    // acceptance; repeating it for every recovery workspace only saturates cold
    // hosted CIM and can fail the unrelated hook contract before recovery starts.
    env[TEST_DIRECT_DURABLE_LAUNCH_ENV] = "1";
  }
  return { dir, root, project, env, receipt, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

/** How many times the fixture actually executed (its own receipt), never a guess. */
function fixtureRuns(ws: Workspace): number {
  try {
    return fs.readFileSync(ws.receipt, "utf8").split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * The recovery-relevant observable fields of a job record. Recovery must never
 * CHANGE any of them (including a legitimately RETAINED `childPid`): the oracle
 * is pre/post equality, not an assumption that the PID is null.
 */
function jobObservable(root: string, id: string): Record<string, unknown> {
  const job = loadJob(root, id);
  assert.ok(job, `job ${id} must exist`);
  return {
    status: job.status,
    generation: job.generation,
    sessionId: job.sessionId,
    childPid: job.childPid,
    childGeneration: job.childGeneration,
    owner: job.owner,
    ownerPid: job.ownerPid,
    attempts: job.attempts.length,
    finalText: job.result?.finalText ?? null
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipePath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crewdispatch-recovery-real-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Darwin's AF_UNIX sun_path is short; os.tmpdir() under /var/folders can make
  // a perfectly valid test name exceed it. /tmp is the stable short socket root.
  if (process.platform === "darwin") return path.join("/tmp", `cdr-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  return path.join(os.tmpdir(), `crewdispatch-recovery-real-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

interface Receiver {
  address: string;
  outFile: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stop: () => Promise<void>;
}

/** Start the separate receiver process and wait for its READY line. */
async function startReceiver(name: string): Promise<Receiver> {
  const address = pipePath(name);
  const outFile = path.join(fs.realpathSync.native(os.tmpdir()), `crewdispatch-recovery-receiver-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const child = spawn(process.execPath, [RECEIVER_ENTRY, address, outFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the receiver process never became ready")), 10000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the receiver process exited early (${code})`));
    });
  });
  return {
    address,
    outFile,
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* the workspace cleanup also removes it */
      }
    }
  };
}

/** Run the REAL compiled hook entry as a separate process (the installed layout). */
function runHook(ws: Workspace, socket: string, token: string): string {
  const result = spawnSync(process.execPath, [HOOK_ENTRY, "session-start"], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", cwd: ws.project }),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  const diagnostic = String(result.stderr ?? "").trim();
  assert.equal(diagnostic, "", `SessionStart recovery diagnostic: ${diagnostic}`);
  return result.stdout;
}

interface FrameGroup {
  group: number;
  frames: string;
}

function readGroups(file: string): FrameGroup[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FrameGroup);
}

async function waitGroups(file: string, n: number, timeoutMs = 30000): Promise<FrameGroup[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const groups = readGroups(file);
    if (groups.length >= n) return groups;
    if (Date.now() >= deadline) throw new Error(`expected ${n} frame groups in ${file}, saw ${groups.length}`);
    await sleep(100);
  }
}

function framesOf(group: FrameGroup): { auth: Record<string, unknown>; content: string } {
  const lines = group.frames.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "exactly two frames per wake");
  const auth = JSON.parse(lines[0]!) as Record<string, unknown>;
  const user = JSON.parse(lines[1]!) as { message: { role: string; content: string } };
  assert.equal(auth.type, "auth");
  assert.equal(user.message.role, "user");
  return { auth, content: user.message.content };
}

async function waitJob(root: string, id: string, predicate: (job: NonNullable<ReturnType<typeof loadJob>>) => boolean, timeoutMs = 90000): Promise<NonNullable<ReturnType<typeof loadJob>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && predicate(job)) return job;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the job state of ${id}`);
    await sleep(100);
  }
}

async function waitOriginalResult(root: string, id: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readNotificationResult(root, id, 0)) return;
    if (Date.now() >= deadline) throw new Error(`the original wake outcome was never recorded for ${id}`);
    await sleep(100);
  }
}

/** Spawn one job bound to SESSION through the real MCP entry, then disconnect. */
async function spawnAndDisconnect(ws: Workspace, task: string): Promise<string> {
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task, cwd: ws.project, claude_session_id: SESSION }));
    return String(spawned.job_id);
  } finally {
    await client.close();
  }
}

test("reopening the same session replays the provably-lost terminal wake exactly once", { timeout: 180000 }, async () => {
  const ws = newWorkspace("replay");
  let receiver: Receiver | null = null;
  try {
    // 1. The ORIGINAL session registers against an inbox nobody is listening on
    //    (the conversation is closed), then dispatches a job and disconnects.
    runHook(ws, pipePath("original-closed"), "recovery-token-original");
    const id = await spawnAndDisconnect(ws, "RECOVERY_TASK_MARKER_1a");
    await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
    await waitOriginalResult(ws.root, id);

    // The recorded failure is the EXACT shape of the defect: the original
    // attempt provably never began writing to the inbox.
    const original = readNotificationResult(ws.root, id, 0);
    assert.equal(original?.delivered, false);
    assert.equal(original?.reason, "inbox_unreachable");
    assert.equal(original?.phase, "not_written");

    // 2. The SAME session reopens against a NEW live inbox; the REAL hook
    //    registers the new private binding and asks the daemon for recovery.
    const jobFileBefore = fs.readFileSync(jobPath(ws.root, id), "utf8");
    const runsBefore = fixtureRuns(ws);
    const observableBefore = jobObservable(ws.root, id);
    receiver = await startReceiver("replay-live");
    assert.equal(runsBefore, 1, "the independent fixture-entry receipt must observe the original execution");
    const token = "recovery-token-reopened";
    runHook(ws, receiver.address, token);

    // 3. Exactly ONE recovered wake reaches the CURRENT inbox of the session.
    await waitGroups(receiver.outFile, 1);
    await sleep(800); // a stray duplicate attempt would arrive within this window
    const groups = readGroups(receiver.outFile);
    assert.equal(groups.length, 1, "exactly ONE recovered wake per exact event");
    const { auth, content } = framesOf(groups[0]!);
    assert.equal(auth.token, token, "the recovered wake uses the CURRENT registration's token");
    assert.ok(content.includes("recovery"), "the wake is identifiable as a recovery");
    assert.ok(content.includes(id), "the recovered wake names the job");
    assert.ok(content.includes("run 1"), "the recovered wake names the run");
    assert.ok(content.includes("has not already been collected"), "the collection request is conditional");
    assert.equal(content.includes("exactly once"), false, "the unconditional one-shot wording is never repeated");
    assert.equal(content.includes("RECOVERED-DONE-MARKER"), false, "the wake never carries the result text");

    // 4. Durable evidence: the original outcome is immutable and the recovery
    //    outcome lives in its own sidecar namespace.
    const originalAfter = readNotificationResult(ws.root, id, 0);
    assert.deepEqual(originalAfter, original, "the original attempt/outcome is immutable");
    const recovered = readTerminalRecoveryResult(ws.root, id, 0);
    assert.equal(recovered?.delivered, true);
    assert.equal(recovered?.by, "claude-session-start");
    assert.ok(fs.existsSync(terminalRecoveryClaimPath(ws.root, id, 0)), "the ONE-attempt budget is durable");

    // 5. The job itself is untouched: still `done`, same result, and the
    //    recovery-relevant fields (status/generation/session/childPid/owner/
    //    attempts) are UNCHANGED. The PID is NOT assumed null: a genuine `done`
    //    legitimately RETAINS the child evidence when the managed tree could not
    //    be confirmed stopped (service.ts:2147). The independent fixture-entry
    //    receipt proves no worker was executed again.
    const job = loadJob(ws.root, id)!;
    assert.equal(job.status, "done");
    assert.equal(job.result?.finalText, "RECOVERED-DONE-MARKER");
    assert.equal(job.generation, 0);
    assert.deepEqual(jobObservable(ws.root, id), observableBefore, "recovery must never change the job record's observable fields");
    assert.equal(fixtureRuns(ws), runsBefore, "recovery must never execute the fixture again (no new worker)");
    assert.equal(
      fs.readFileSync(jobPath(ws.root, id), "utf8"),
      jobFileBefore,
      "recovery must never rewrite the job record (no status/result/usage mutation)"
    );

    // 6. Rebinding AGAIN does not reset the allowance: the next SessionStart
    //    hook runs a pass that sends nothing.
    const third = registerViaHook(ws, "replay-third");
    await sleep(1500);
    assert.equal(readGroups(receiver.outFile).length, 1, "repeated rebinding keeps ONE allowance");
    assert.equal(listClaudeBindings(ws.root).filter((b) => b.sessionId === SESSION).length, 1, "exactly one current registration");
    assert.ok(third.length > 0);
  } finally {
    if (receiver) await receiver.stop();
    await ws.cleanup();
  }
});

/** Register one more incarnation of SESSION against a fresh dead address. */
function registerViaHook(ws: Workspace, name: string): string {
  return runHook(ws, pipePath(name), `recovery-token-${name}`);
}

/** Run the REAL compiled SessionEnd hook (the production cleanup path). */
function runEndHook(ws: Workspace, socket: string, token: string): string {
  const result = spawnSync(process.execPath, [HOOK_ENTRY, "session-end"], {
    input: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionEnd", cwd: ws.project }),
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
  });
  assert.equal(result.status, 0, `end hook exited ${result.status}: ${result.stderr}`);
  return result.stderr ?? "";
}

test("a job that finished after the real SessionEnd removed the binding is recovered once on reopen", { timeout: 180000 }, async () => {
  const ws = newWorkspace("sessionend");
  let receiver: Receiver | null = null;
  try {
    // 1. A REAL SessionStart registers a live inbox binding for this session.
    const firstSocket = pipePath("sessionend-first");
    const firstToken = "recovery-token-sessionend-first";
    runHook(ws, firstSocket, firstToken);
    assert.equal(listClaudeBindings(ws.root).filter((b) => b.sessionId === SESSION).length, 1, "the binding is registered");

    // 2. The conversation CLOSES: the REAL SessionEnd hook removes that exact
    //    incarnation. This is the ordinary lifecycle, not a crafted record.
    const endDiag = runEndHook(ws, firstSocket, firstToken);
    assert.equal(endDiag.trim(), "", `the normal SessionEnd reported a problem: ${endDiag}`);
    assert.equal(listClaudeBindings(ws.root).length, 0, "no binding remains while the conversation is closed");

    // 3. A job bound to this exact session completes while it is closed: the
    //    terminal wake has no inbox at all, so it provably never wrote.
    const id = await spawnAndDisconnect(ws, "RECOVERY_TASK_MARKER_5e");
    await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
    await waitOriginalResult(ws.root, id);
    const original = readNotificationResult(ws.root, id, 0);
    assert.equal(original?.delivered, false);
    assert.equal(original?.reason, "no_binding", "the job finished while no inbox existed");
    assert.equal(original?.phase, "not_written", "an absent inbox is a proven pre-write absence, not an unknown");

    // 4. The SAME session reopens: a fresh real SessionStart registers a NEW
    //    binding and asks the real daemon for recovery.
    const jobFileBefore = fs.readFileSync(jobPath(ws.root, id), "utf8");
    const runsBefore = fixtureRuns(ws);
    const observableBefore = jobObservable(ws.root, id);
    receiver = await startReceiver("sessionend-live");
    assert.equal(runsBefore, 1, "the independent fixture-entry receipt must observe the original execution");
    const reopenToken = "recovery-token-sessionend-reopen";
    runHook(ws, receiver.address, reopenToken);

    // 5. Exactly ONE recovered wake reaches the CURRENT inbox.
    await waitGroups(receiver.outFile, 1);
    await sleep(800); // a stray duplicate would arrive within this window
    const groups = readGroups(receiver.outFile);
    assert.equal(groups.length, 1, "exactly ONE recovered wake per exact event");
    const { auth, content } = framesOf(groups[0]!);
    assert.equal(auth.token, reopenToken, "the wake uses the CURRENT registration's token");
    assert.ok(content.includes(id), "the recovered wake names the job");
    assert.ok(content.includes("has not already been collected"), "the collection request is conditional");
    assert.equal(content.includes("RECOVERED-DONE-MARKER"), false, "the wake never carries the result text");

    // 6. Durable evidence and no side effects on the job.
    const recovered = readTerminalRecoveryResult(ws.root, id, 0);
    assert.equal(recovered?.delivered, true);
    assert.equal(recovered?.by, "claude-session-start");
    assert.ok(fs.existsSync(terminalRecoveryClaimPath(ws.root, id, 0)), "the ONE-attempt budget is durable");
    assert.deepEqual(readNotificationResult(ws.root, id, 0), original, "the original attempt/outcome is immutable");
    // The recovery-relevant fields are UNCHANGED — compared pre/post, never
    // assumed. A genuine `done` may RETAIN `childPid` when the managed tree
    // could not be confirmed stopped (service.ts:2147); that retained pre-existing
    // PID is not evidence that recovery created a worker, and recovery must not
    // clear it, change the success outcome or suppress/replace the result.
    const job = loadJob(ws.root, id)!;
    assert.equal(job.status, "done");
    assert.equal(job.result?.finalText, "RECOVERED-DONE-MARKER");
    assert.deepEqual(jobObservable(ws.root, id), observableBefore, "recovery must never change status/generation/session/childPid/owner/attempts");
    assert.equal(fixtureRuns(ws), runsBefore, "recovery must never execute the fixture again (no new worker)");
    assert.equal(
      fs.readFileSync(jobPath(ws.root, id), "utf8"),
      jobFileBefore,
      "recovery must never rewrite the job record"
    );

    // 7. Rebinding again does not reset the allowance.
    registerViaHook(ws, "sessionend-third");
    await sleep(1500);
    assert.equal(readGroups(receiver.outFile).length, 1, "repeated rebinding keeps ONE allowance");
  } finally {
    if (receiver) await receiver.stop();
    await ws.cleanup();
  }
});

test("recovery leaves a successful result's RETAINED managed-tree evidence untouched (deterministic)", { timeout: 180000 }, async () => {
  const ws = newWorkspace("retained");
  let receiver: Receiver | null = null;
  try {
    // 1. A REAL SessionStart registers a live inbox binding for this session.
    runHook(ws, pipePath("retained-original"), "recovery-token-retained-original");
    assert.equal(listClaudeBindings(ws.root).filter((b) => b.sessionId === SESSION).length, 1, "the binding is registered");

    // 2. Seed a TERMINAL `done` job whose SUCCESS legitimately RETAINED the child
    //    evidence because the managed tree could not be confirmed stopped (the
    //    ordinary lifecycle, service.ts:2147), with the exact proven
    //    no-write original wake shape. This makes the retained-evidence case
    //    DETERMINISTIC instead of load-dependent.
    const job = createJobRecord(
      {
        task: "RETAINED_EVIDENCE_TASK",
        cwd: ws.project,
        notifyTarget: {
          kind: "claude_session",
          callbackUrl: null,
          codexThreadId: null,
          claudeSessionId: SESSION,
          claudeBindingId: null,
          source: "claude_session_id"
        }
      },
      () => new Date()
    );
    job.status = "done";
    job.generation = 0;
    job.sessionId = "retained-fx-session";
    job.childPid = 2147483646; // a dead root retained when the tree was not confirmed stopped
    job.childGeneration = 0;
    job.owner = "jobquay-2147483647-dead";
    job.ownerPid = 2147483647;
    job.finishedAt = new Date().toISOString();
    job.result = { ok: true, subtype: "success", kind: "success", exitCode: 0, stopReason: "end_turn", finalText: "RETAINED-DONE-MARKER", fallbackEligible: false };
    saveJob(ws.root, job);
    writeNotificationResult(ws.root, job.id, 0, {
      generation: 0,
      kind: "claude_session",
      attemptedAt: new Date().toISOString(),
      delivered: false,
      reason: "inbox_unreachable",
      by: "test",
      phase: "not_written"
    });

    const runsBefore = fixtureRuns(ws);
    const observableBefore = jobObservable(ws.root, job.id);
    const bytesBefore = fs.readFileSync(jobPath(ws.root, job.id), "utf8");

    // 3. Reopen the SAME session against a live inbox: the REAL hook + daemon run
    //    the recovery pass for the exact session.
    receiver = await startReceiver("retained-live");
    const reopenToken = "recovery-token-retained-reopen";
    runHook(ws, receiver.address, reopenToken);

    await waitGroups(receiver.outFile, 1);
    await sleep(800);
    const groups = readGroups(receiver.outFile);
    assert.equal(groups.length, 1, "exactly ONE recovered wake per exact event");
    const { auth, content } = framesOf(groups[0]!);
    assert.equal(auth.token, reopenToken, "the wake uses the CURRENT registration's token");
    assert.ok(content.includes(job.id), "the recovered wake names the job");
    assert.equal(content.includes("RETAINED-DONE-MARKER"), false, "the wake never carries the result text");

    const recovered = readTerminalRecoveryResult(ws.root, job.id, 0);
    assert.equal(recovered?.delivered, true);
    assert.equal(recovered?.by, "claude-session-start");
    assert.equal(recovered?.generation, 0);
    assert.ok(fs.existsSync(terminalRecoveryClaimPath(ws.root, job.id, 0)), "the ONE-attempt budget is durable");

    // 4. Recovery preserved the RETAINED evidence and the whole record: it did
    //    not create a worker, rerun the fixture, clear the PID, change the
    //    success outcome or mutate any observable field. The retained PID is
    //    compared pre/post, never assumed null.
    assert.deepEqual(jobObservable(ws.root, job.id), observableBefore, "recovery must never change the record");
    assert.equal(jobObservable(ws.root, job.id).childPid, 2147483646, "retained managed-tree evidence is preserved");
    assert.equal(fixtureRuns(ws), runsBefore, "recovery is never a rerun (fixture-entry count unchanged)");
    assert.equal(fs.readFileSync(jobPath(ws.root, job.id), "utf8"), bytesBefore, "the record is byte-identical");

    // 5. Rebinding again does not reset the allowance.
    registerViaHook(ws, "retained-third");
    await sleep(1500);
    assert.equal(readGroups(receiver.outFile).length, 1, "repeated rebinding keeps ONE allowance");
  } finally {
    if (receiver) await receiver.stop();
    await ws.cleanup();
  }
});

test("a result already collected through the real MCP entry is never re-woken", { timeout: 180000 }, async () => {
  const ws = newWorkspace("collected");
  let receiver: Receiver | null = null;
  let client: McpStdioClient | null = null;
  try {
    runHook(ws, pipePath("collected-original"), "recovery-token-collected");
    const id = await spawnAndDisconnect(ws, "RECOVERY_TASK_MARKER_2b");
    await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
    await waitOriginalResult(ws.root, id);

    // The result is collected through the REAL MCP result entry BEFORE the
    // session reopens: the per-generation receipt is written there.
    client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client.initialize();
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    assert.equal(result.status, "done");
    assert.equal(result.result_read_receipt, undefined, "a successful receipt write is silent");
    assert.equal(readTerminalReadReceipt(ws.root, id, 0)?.by, "mcp-result");

    // Reopen the SAME session against a live inbox: the pass must send NOTHING.
    receiver = await startReceiver("collected-live");
    runHook(ws, receiver.address, "recovery-token-collected-live");
    await sleep(2500);
    assert.equal(readGroups(receiver.outFile).length, 0, "an already-collected generation is not re-woken");
    assert.equal(readTerminalRecoveryResult(ws.root, id, 0), null, "no allowance was consumed");
    assert.equal(fs.existsSync(terminalRecoveryClaimPath(ws.root, id, 0)), false, "nothing was claimed");
  } finally {
    if (client) await client.close().catch(() => undefined);
    if (receiver) await receiver.stop();
    await ws.cleanup();
  }
});

test("a successfully delivered original wake is never re-sent on reopen", { timeout: 180000 }, async () => {
  const ws = newWorkspace("delivered");
  const receiverA = await startReceiver("delivered-a");
  let receiverB: Receiver | null = null;
  try {
    // The original session has a LIVE inbox: the original wake succeeds.
    runHook(ws, receiverA.address, "recovery-token-delivered-a");
    const id = await spawnAndDisconnect(ws, "RECOVERY_TASK_MARKER_3c");
    await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
    await waitGroups(receiverA.outFile, 1);
    // The frame group proves the transport WROTE, not that the producer has
    // finished. The notification outcome is persisted by the job lifecycle
    // AFTER the socket closes, so reading it here can race that write under
    // full-suite load. Wait for the durable outcome itself, exactly as the
    // other lifecycle tests do — no sidecar is fabricated, no expectation is
    // weakened, and the timeout stays bounded.
    await waitOriginalResult(ws.root, id);
    const original = readNotificationResult(ws.root, id, 0);
    assert.equal(original?.delivered, true);
    assert.equal(original?.phase, "handoff");

    // Reopening the same session (a new binding on a new inbox) must NOT
    // replay a successful handoff.
    receiverB = await startReceiver("delivered-b");
    runHook(ws, receiverB.address, "recovery-token-delivered-b");
    await sleep(2500);
    assert.equal(readGroups(receiverB.outFile).length, 0, "a successful original is never re-sent");
    assert.equal(readGroups(receiverA.outFile).length, 1, "the original inbox receives nothing more");
    assert.equal(readTerminalRecoveryResult(ws.root, id, 0), null, "no allowance was consumed");
  } finally {
    await receiverA.stop();
    if (receiverB) await receiverB.stop();
    await ws.cleanup();
  }
});

/** Start the REAL compiled hook entry without waiting for it to exit. */
function spawnHook(ws: Workspace, socket: string, token: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_ENTRY, "session-start"], {
      windowsHide: true,
      env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.once("error", () => resolve({ status: -1, stderr }));
    child.once("exit", (code) => resolve({ status: code, stderr }));
    child.stdin.end(JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", cwd: ws.project }));
  });
}

test("two concurrent hook processes for the same session claim at most ONE recovery", { timeout: 180000 }, async () => {
  const ws = newWorkspace("concurrent");
  let receiverA: Receiver | null = null;
  let receiverB: Receiver | null = null;
  try {
    // The original attempt provably never wrote (the conversation was closed).
    runHook(ws, pipePath("concurrent-original"), "recovery-token-concurrent-original");
    const id = await spawnAndDisconnect(ws, "RECOVERY_TASK_MARKER_4d");
    await waitJob(ws.root, id, (job) => TERMINAL.has(job.status));
    await waitOriginalResult(ws.root, id);

    // Two REAL hook processes register the SAME session against two live
    // inboxes at the same time and BOTH ask the daemon for recovery. Whichever
    // registration ends up current, the durable exclusive claim allows at most
    // ONE recovery attempt: a second claim — and therefore a second send — is
    // impossible, even across processes.
    receiverA = await startReceiver("concurrent-a");
    receiverB = await startReceiver("concurrent-b");
    const [a, b] = await Promise.all([
      spawnHook(ws, receiverA.address, "recovery-token-concurrent-a"),
      spawnHook(ws, receiverB.address, "recovery-token-concurrent-b")
    ]);
    assert.equal(a.status, 0, `concurrent hook A exited ${a.status}: ${a.stderr}`);
    assert.equal(b.status, 0, `concurrent hook B exited ${b.status}: ${b.stderr}`);

    // Let both daemon passes settle; a stray duplicate would arrive here.
    await sleep(3500);

    const groupsA = readGroups(receiverA.outFile);
    const groupsB = readGroups(receiverB.outFile);
    assert.ok(groupsA.length + groupsB.length <= 1, "two concurrent registrations can never produce two sends");
    if (groupsA.length + groupsB.length === 1) {
      const { content } = framesOf((groupsA.length ? groupsA : groupsB)[0]!);
      assert.ok(content.includes(id), "a concurrent recovery still names the exact job");
      assert.ok(content.includes("has not already been collected"), "the concurrent wake stays conditional");
    }
    // The outcome sidecar is written only after the ONE claim; a losing or
    // crashed process can never reopen the allowance.
    const outcome = readTerminalRecoveryResult(ws.root, id, 0);
    if (outcome) {
      assert.ok(fs.existsSync(terminalRecoveryClaimPath(ws.root, id, 0)), "a completed recovery always has its claim");
      if (outcome.delivered) {
        assert.equal(groupsA.length + groupsB.length, 1, "a delivered recovery has exactly one send");
      }
    }
  } finally {
    if (receiverA) await receiverA.stop();
    if (receiverB) await receiverB.stop();
    await ws.cleanup();
  }
});
