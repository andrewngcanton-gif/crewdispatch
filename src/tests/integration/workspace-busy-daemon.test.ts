// workspace-busy-daemon.test.ts — JQ-20261002-44 real boundary coverage for the
// shared EXACT-workspace occupancy guard.
//
// Boundaries exercised here are REAL: the local daemon/broker (`startDaemon`),
// the real caller-side daemon client, TWO separate OS caller processes per
// concurrent dispatch, the real worker, the real durable job store and the
// production fixture runner (which replaces the provider PROCESS only — no CLI
// is executed and no credential/profile/network is touched).
//
// The controlled fixture is deliberately long-lived: it appends one invocation
// record, emits a session/run_start, then waits for a release file. That keeps
// the accepted job ACTIVE while the test probes the guard, exactly like a real
// long-running task would.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startDaemon, type DaemonHandle } from "../../daemon/server";
import { continueJobViaDaemon, JobDaemonError, shutdownJobDaemon, startJobViaDaemon } from "../../daemon/client";
import { createJobRecord, requestCancel } from "../../jobs/service";
import { appendUserMessageOrThrow } from "../../jobs/messages";
import { listJobs, loadJob, readTreeRecovery, saveJob, treeRecoveryPath, writeTreeConfirmation } from "../../jobs/store";
import { canonicalWorkspacePath } from "../../jobs/workspace";
import { isPidAlive, readBootTime } from "../../runtime/process";
import { emptyUsage, type JobAttempt, type JobRecord } from "../../jobs/types";
import { createFailureEvidence, runCleanupSteps, runWithFailureEvidence } from "../helpers/failure-evidence";
import { installRecoveryObservations } from "../helpers/recovery-observations";

const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const DAEMON_CLIENT_JS = path.join(__dirname, "..", "..", "daemon", "client.js");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Workspace {
  dir: string;
  root: string;
  project: string;
  fixture: string;
  fixtureLog: string;
  releaseFile: string;
  callerScript: string;
  env: NodeJS.ProcessEnv;
}

/** A long-lived CLI stand-in: records the invocation, then waits for the release file. */
function writeFixture(dir: string): string {
  const fixture = path.join(dir, "workspace-fixture.cjs");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const log = process.env.JOBQUAY_TEST_FIXTURE_LOG;',
      '  if (log) fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), argv: args, stdin: input, pid: process.pid }) + "\\n");',
      '  const sid = "fx-workspace-session";',
      '  process.stdout.write(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: sid } }) + "\\n");',
      '  const release = process.env.JOBQUAY_TEST_RELEASE_FILE;',
      "  const deadline = Date.now() + 30000;",
      "  const finish = () => {",
      '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "WS_OK:" + input.trim(), session_id: sid, stop_reason: "end_turn" }) + "\\n");',
      "    process.exit(0);",
      "  };",
      "  if (!release) return finish();",
      "  const timer = setInterval(() => {",
      "    if (fs.existsSync(release) || Date.now() > deadline) { clearInterval(timer); finish(); }",
      "  }, 50);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

/** A REAL caller process: the production daemon client, one dispatch per process. */
function writeCallerScript(dir: string): string {
  const script = path.join(dir, "workspace-caller.cjs");
  fs.writeFileSync(
    script,
    [
      "const { startJobViaDaemon } = require(process.env.JOBQUAY_TEST_DAEMON_CLIENT);",
      "(async () => {",
      '  const task = process.env.JOBQUAY_TEST_TASK || "caller task";',
      "  try {",
      "    const r = await startJobViaDaemon(process.env.JOBQUAY_TEST_ROOT, {",
      "      task,",
      "      cwd: process.env.JOBQUAY_TEST_CWD,",
      '      runner: "fixture",',
      "      fixturePath: process.env.JOBQUAY_TEST_FIXTURE,",
      "      env: process.env",
      "    });",
      '    process.stdout.write(JSON.stringify({ ok: true, jobId: r.job.id, workerPid: r.workerPid, task }) + "\\n");',
      "  } catch (e) {",
      '    process.stdout.write(JSON.stringify({ ok: false, code: (e && e.code) || null, message: String((e && e.message) || e), task }) + "\\n");',
      "  }",
      "})();"
    ].join("\n"),
    "utf8"
  );
  return script;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-workspace-${name}-`));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = writeFixture(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    JOBQUAY_TEST_DAEMON_CLIENT: DAEMON_CLIENT_JS,
    JOBQUAY_TEST_ROOT: root,
    JOBQUAY_TEST_FIXTURE_LOG: path.join(dir, "fixture-invocations.jsonl"),
    JOBQUAY_TEST_RELEASE_FILE: path.join(dir, "release.txt")
  };
  // A test must never reach a real user thread/callback destination.
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CALLBACK_URL;
  delete env.JOBQUAY_CALLBACK_URL;
  return {
    dir,
    root,
    project,
    fixture,
    fixtureLog: String(env.JOBQUAY_TEST_FIXTURE_LOG),
    releaseFile: String(env.JOBQUAY_TEST_RELEASE_FILE),
    callerScript: writeCallerScript(dir),
    env
  };
}

/** Run ONE real caller process and read its single JSON result line. */
function runCaller(ws: Workspace, overrides: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ws.callerScript], {
      env: { ...ws.env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last) {
        reject(new Error(`caller process produced no result (exit ${code}): ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(last) as Record<string, unknown>);
      } catch (e) {
        reject(new Error(`caller result is not JSON: ${last} (${String((e as Error)?.message || e)})`));
      }
    });
  });
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function waitStatus(root: string, id: string, statuses: readonly string[], timeoutMs = 30000): Promise<JobRecord> {
  return waitFor(() => {
    const job = loadJob(root, id);
    return job && statuses.includes(job.status) ? job : null;
  }, timeoutMs, `job ${id} to reach ${statuses.join("/")}`);
}

function invocations(ws: Workspace): Array<{ cwd: string; argv: string[]; stdin: string; pid: number }> {
  if (!fs.existsSync(ws.fixtureLog)) return [];
  return fs
    .readFileSync(ws.fixtureLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd: string; argv: string[]; stdin: string; pid: number });
}

async function release(ws: Workspace): Promise<void> {
  fs.writeFileSync(ws.releaseFile, "1", "utf8");
}

/** Stop a TEST-owned child and wait for its exit (never a product decision). */
function stopOwnedChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    try {
      child.kill();
    } catch {
      resolve();
    }
  });
}

function terminalAttempt(generation: number, startedAtMs: number): JobAttempt {
  return {
    generation,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: null,
    exitCode: 0,
    kind: "success",
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
  };
}

async function cleanup(ws: Workspace, daemon: DaemonHandle | null): Promise<void> {
  let removed = false;
  let lastError: unknown = null;
  // Attempt EVERY owned cleanup step even if an earlier one throws; a step error
  // is collected, never used to skip the remaining steps, and all errors are
  // preserved together (AggregateError) rather than only the first.
  const stepError = await runCleanupSteps([
    { name: "release-write", run: () => { fs.writeFileSync(ws.releaseFile, "1", "utf8"); } },
    { name: "shutdownJobDaemon", run: () => shutdownJobDaemon(ws.root, ws.env) },
    { name: "daemon.close", run: () => daemon?.close() },
    {
      name: "remove-workspace",
      run: async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            fs.rmSync(ws.dir, { recursive: true, force: true });
            removed = true;
            return;
          } catch (e) {
            lastError = e;
            const code = (e as NodeJS.ErrnoException)?.code;
            if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw e;
            await sleep(100);
          }
        }
        throw lastError ?? new Error("temporary workspace root was not removed");
      }
    }
  ]).then(
    () => null,
    (e: unknown) => e
  );

  // The original hygiene assertion is kept: the disposable root must be removed.
  let assertionError: unknown = null;
  try {
    assert.equal(removed, true, `temporary workspace root can be cleaned; last error=${String((lastError as Error)?.message || lastError || "none")}`);
  } catch (e) {
    assertionError = e;
  }

  if (stepError && assertionError) {
    throw new AggregateError(
      [stepError, assertionError],
      `workspace cleanup failed: ${String((stepError as Error)?.message || stepError)} | ${String((assertionError as Error)?.message || assertionError)}`
    );
  }
  if (stepError) throw stepError;
  if (assertionError) throw assertionError;
}

test("two REAL caller processes -> one daemon concurrently submit the same cwd: exactly one accepted, the other refused with workspace_busy", { timeout: 120000 }, async () => {
  const ws = newWorkspace("concurrent");
  const daemon = await startDaemon(ws.root);
  try {
    const canonical = canonicalWorkspacePath(ws.project);
    const [first, second] = await Promise.all([
      runCaller(ws, { JOBQUAY_TEST_TASK: "CALLER_ONE", JOBQUAY_TEST_CWD: ws.project }),
      runCaller(ws, { JOBQUAY_TEST_TASK: "CALLER_TWO", JOBQUAY_TEST_CWD: ws.project })
    ]);
    const results = [first, second];
    const accepted = results.filter((r) => r.ok === true);
    const refused = results.filter((r) => r.ok === false);
    assert.equal(accepted.length, 1, `exactly one caller is accepted: ${JSON.stringify(results)}`);
    assert.equal(refused.length, 1, "the other caller is refused, never silently queued");
    const winner = accepted[0]!;
    const loser = refused[0]!;
    const jobId = String(winner.jobId);
    assert.equal(loser.code, "workspace_busy", "the refusal uses the stable code");
    const message = String(loser.message);
    assert.ok(message.includes(jobId), "the refusal names the holder job");
    assert.ok(message.includes("command-code"), "the refusal names the holder provider");
    assert.ok(message.includes(canonical), "the refusal names the canonical cwd");
    assert.ok(/status (queued|running)/.test(message), "the refusal names the holder run state");

    // Exactly ONE accepted job, ONE worker, ONE provider process: the refused
    // dispatch produced no job, no history, no worker and no fixture invocation.
    const { jobs } = listJobs(ws.root);
    assert.equal(jobs.length, 1, "the refused dispatch created no job record");
    assert.equal(jobs[0]!.id, jobId);
    assert.equal(jobs[0]!.cwd, path.resolve(ws.project));
    const active = await waitStatus(ws.root, jobId, ["queued", "running"]);
    assert.ok(active.status === "queued" || active.status === "running");
    // The fixture records its invocation once its stdin ends (the real prompt
    // write); wait for it, then prove the refused caller started NOTHING.
    await waitFor(() => (invocations(ws).length >= 1 ? true : null), 20000, "the accepted provider process to start");
    assert.equal(invocations(ws).length, 1, "only the accepted job started a provider process");
    assert.equal(fs.existsSync(path.join(ws.root, "messages", `${jobId}.json`)), true);

    // The holder finishes normally; the workspace is then free again.
    await release(ws);
    const done = await waitStatus(ws.root, jobId, ["done", "error"]);
    assert.equal(done.status, "done");
    assert.equal(done.result?.finalText, `WS_OK:${done.task.trim()}`);
    const third = await startJobViaDaemon(ws.root, {
      task: "CALLER_THREE",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    assert.ok(third.job.id);
    assert.notEqual(third.job.id, jobId, "a new accepted task after the holder became terminal");
  } finally {
    await cleanup(ws, daemon);
  }
});

test("different working directories may run concurrently through the same daemon", { timeout: 120000 }, async () => {
  const ws = newWorkspace("distinct");
  const other = path.join(ws.dir, "project-two");
  fs.mkdirSync(other, { recursive: true });
  const daemon = await startDaemon(ws.root);
  try {
    const [a, b] = await Promise.all([
      runCaller(ws, { JOBQUAY_TEST_TASK: "DISTINCT_A", JOBQUAY_TEST_CWD: ws.project }),
      runCaller(ws, { JOBQUAY_TEST_TASK: "DISTINCT_B", JOBQUAY_TEST_CWD: other })
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    const { jobs } = listJobs(ws.root);
    assert.equal(jobs.length, 2, "both distinct directories were accepted");
    assert.notEqual(jobs[0]!.cwd, jobs[1]!.cwd);
    await waitFor(() => (invocations(ws).length >= 2 ? true : null), 20000, "both provider processes to start");
    assert.equal(invocations(ws).length, 2, "both provider processes started");
    await release(ws);
    await waitStatus(ws.root, String(a.jobId), ["done", "error"]);
    await waitStatus(ws.root, String(b.jobId), ["done", "error"]);
  } finally {
    await cleanup(ws, daemon);
  }
});

test("a junction/symlink alias and a differently-cased spelling of the same real directory conflict", { timeout: 120000 }, async (t) => {
  const ws = newWorkspace("alias");
  const alias = path.join(ws.dir, "alias-project");
  try {
    fs.symlinkSync(ws.project, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    t.diagnostic(`alias creation skipped: ${String((e as Error)?.message || e)}`);
    fs.rmSync(ws.dir, { recursive: true, force: true });
    return;
  }
  const daemon = await startDaemon(ws.root);
  try {
    const held = await startJobViaDaemon(ws.root, {
      task: "ALIAS_HOLDER",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    await waitStatus(ws.root, held.job.id, ["queued", "running"]);
    const aliased = await runCaller(ws, { JOBQUAY_TEST_TASK: "ALIAS_CALLER", JOBQUAY_TEST_CWD: alias });
    assert.equal(aliased.ok, false, "the alias must conflict with the real directory");
    assert.equal(aliased.code, "workspace_busy");
    assert.ok(String(aliased.message).includes(held.job.id));
    if (process.platform === "win32") {
      const upper = await runCaller(ws, { JOBQUAY_TEST_TASK: "CASE_CALLER", JOBQUAY_TEST_CWD: ws.project.toUpperCase() });
      assert.equal(upper.ok, false, "a differently-cased spelling must conflict on Windows");
      assert.equal(upper.code, "workspace_busy");
    }
    assert.equal(listJobs(ws.root).jobs.length, 1, "no job was created through an alias");
  } finally {
    await cleanup(ws, daemon);
  }
});

test("a rejected continuation leaves the terminal record, generation and messages byte-identical, and the workspace frees when the holder ends", { timeout: 120000 }, async () => {
  const ws = newWorkspace("continue");
  const daemon = await startDaemon(ws.root);
  try {
    // Job A completes in the shared directory.
    const a = await startJobViaDaemon(ws.root, {
      task: "CONTINUE_A",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    await release(ws);
    const aDone = await waitStatus(ws.root, a.job.id, ["done", "error"]);
    assert.equal(aDone.status, "done");
    const recordFile = path.join(ws.root, "jobs", `${a.job.id}.json`);
    const messagesFile = path.join(ws.root, "messages", `${a.job.id}.json`);
    const recordBefore = fs.readFileSync(recordFile, "utf8");
    const messagesBefore = fs.readFileSync(messagesFile, "utf8");
    const invocationsBefore = invocations(ws).length;

    // Job B holds the directory.
    fs.rmSync(ws.releaseFile, { force: true });
    const b = await startJobViaDaemon(ws.root, {
      task: "CONTINUE_B",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    await waitStatus(ws.root, b.job.id, ["queued", "running"]);

    await assert.rejects(
      () => continueJobViaDaemon(ws.root, { jobId: a.job.id, task: "FOLLOW_UP_MUST_NOT_START", env: ws.env }),
      (e: unknown) => e instanceof JobDaemonError && e.code === "workspace_busy" && String((e as Error).message).includes(b.job.id)
    );

    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "the terminal record is byte-identical after the refusal");
    assert.equal(fs.readFileSync(messagesFile, "utf8"), messagesBefore, "the durable message history is byte-identical");
    assert.equal(loadJob(ws.root, a.job.id)!.generation, 0, "no generation was bumped");
    assert.equal(invocations(ws).length, invocationsBefore, "no provider process was started by the refused continuation");
    assert.equal(listJobs(ws.root).jobs.length, 2, "no new job was created");

    // The holder finishes; the SAME continuation is then accepted on the same
    // logical job/session.
    await release(ws);
    await waitStatus(ws.root, b.job.id, ["done", "error"]);
    const followed = await continueJobViaDaemon(ws.root, { jobId: a.job.id, task: "FOLLOW_UP_NOW", env: ws.env });
    assert.equal(followed.job.generation, 1);
    assert.equal(followed.job.id, a.job.id, "the continuation keeps the same logical job");
    await waitStatus(ws.root, a.job.id, ["done", "error"]);
  } finally {
    await cleanup(ws, daemon);
  }
});

test("a NEW dispatch is refused while a terminal record's retained child tree is unresolved, and accepted once the tree is proven stopped", { timeout: 120000 }, async () => {
  const ws = newWorkspace("terminal-child");
  const daemon = await startDaemon(ws.root);
  // An OWNED, harmless sleeping child: it is the retained terminal evidence and
  // is stopped by THIS test only. The guard must never kill it.
  const sleeping = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const childPid = sleeping.pid;
  assert.ok(childPid);
  try {
    await waitFor(() => (isPidAlive(childPid!) === true ? true : null), 10000, "the owned sleeping child to be alive");
    const canonical = canonicalWorkspacePath(ws.project);
    const holder = createJobRecord({ task: "TERMINAL_CHILD_HOLDER", cwd: ws.project });
    holder.status = "done";
    holder.finishedAt = new Date().toISOString();
    holder.childPid = childPid!;
    holder.childGeneration = holder.generation;
    saveJob(ws.root, holder);
    const recordFile = path.join(ws.root, "jobs", `${holder.id}.json`);
    const recordBefore = fs.readFileSync(recordFile, "utf8");

    // A REAL caller process dispatches a NEW task into the held directory.
    const refused = await runCaller(ws, { JOBQUAY_TEST_TASK: "TERMINAL_CHILD_NEW", JOBQUAY_TEST_CWD: ws.project });
    assert.equal(refused.ok, false, `the new dispatch must be refused: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, "workspace_busy", "the refusal uses the stable code");
    const message = String(refused.message);
    assert.ok(message.includes(holder.id), "the refusal names the terminal holder");
    assert.ok(message.includes(canonical), "the refusal names the canonical directory");
    assert.ok(message.includes("done"), "the refusal names the terminal holder status");
    assert.ok(message.includes(String(childPid)), "the refusal names the retained child PID");

    // No side effects: no new job, no provider process, no terminal snapshot,
    // and the terminal record is byte-identical.
    assert.equal(listJobs(ws.root).jobs.length, 1, "the refused dispatch created no job");
    assert.equal(invocations(ws).length, 0, "the refused dispatch started no provider process");
    assert.equal(
      fs.existsSync(path.join(ws.root, "terminal", `${holder.id}.gen-0.json`)),
      false,
      "the refusal wrote no terminal snapshot"
    );
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "the terminal record is byte-identical after the refusal");
    assert.equal(loadJob(ws.root, holder.id)!.childPid, childPid, "the retained evidence is intact");
    assert.equal(isPidAlive(childPid!), true, "the guard never killed the owned child");

    // The retained tree is REALLY stopped and the generation-scoped proof is
    // written through the production confirmation store; the next dispatch is
    // accepted WITHOUT rewriting the old terminal record.
    await new Promise<void>((resolve) => {
      // A killed child reports exitCode=null + signalCode; accept either.
      if (sleeping.exitCode != null || sleeping.signalCode != null) {
        resolve();
        return;
      }
      sleeping.once("exit", () => resolve());
      try {
        sleeping.kill();
      } catch {
        resolve();
      }
    });
    await waitFor(() => (isPidAlive(childPid!) === false ? true : null), 10000, "the owned child to exit");
    writeTreeConfirmation(ws.root, holder.id, holder.generation, childPid!, "root_exited", "workspace-test");

    const accepted = await runCaller(ws, { JOBQUAY_TEST_TASK: "TERMINAL_CHILD_AFTER_PROOF", JOBQUAY_TEST_CWD: ws.project });
    assert.equal(accepted.ok, true, `the dispatch is accepted after the proof: ${JSON.stringify(accepted)}`);
    assert.notEqual(accepted.jobId, holder.id);
    await waitFor(() => (invocations(ws).length >= 1 ? true : null), 20000, "the new provider process to start");
    assert.equal(listJobs(ws.root).jobs.length, 2, "the accepted dispatch created its own job");
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "accepting the new task never rewrites the old terminal record");
    assert.equal(loadJob(ws.root, holder.id)!.childPid, childPid, "the old terminal record keeps its evidence");

    await release(ws);
    await waitStatus(ws.root, String(accepted.jobId), ["done", "error"]);
  } finally {
    try {
      if (sleeping.exitCode == null && sleeping.signalCode == null) sleeping.kill();
    } catch {
      /* best effort: the child is owned by this test */
    }
    await cleanup(ws, daemon);
  }
});

test("production recovery releases a terminal holder for an independent job once its real owned child exits (no test-written confirmation)", { timeout: 180000, skip: process.platform !== "win32" && "Requires Windows preserved-PPID dead-root snapshot recovery; Darwin requires reboot proof" }, async () => {
  const ws = newWorkspace("auto-recovery");
  // Scoped observation of the ACTUAL in-process recovery report and OS probes
  // (wrappers call the original exactly once and are restored in `finally`).
  const focus = { childPid: null as number | null };
  const observer = installRecoveryObservations({ focusPids: () => (focus.childPid != null ? [focus.childPid] : []) });
  let daemon: DaemonHandle | null = null;
  // A holder object so teardown/finally can see the child the body created
  // without TypeScript narrowing a `let ... = null` to `never`.
  const ownedChild: { child: ReturnType<typeof spawn> | null } = { child: null };
  let callerOutcomes: unknown = null;
  const failureEvidence = createFailureEvidence({
    name: "workspace-busy-daemon production-recovery",
    dataRoot: ws.root,
    workspaceDir: ws.dir,
    childPid: () => focus.childPid,
    extra: () => ({ callerOutcomes }),
    observations: () => observer.snapshot()
  });
  try {
    await runWithFailureEvidence(
      failureEvidence,
      async () => {
        daemon = await startDaemon(ws.root);
        // An OWNED, harmless sleeping child is the retained terminal evidence. The
        // product must never kill it; only THIS test stops it (after the first probe).
        const sleeping = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
        ownedChild.child = sleeping;
        const childPid = sleeping.pid;
        assert.ok(childPid);
        focus.childPid = childPid;
        await waitFor(() => (isPidAlive(childPid!) === true ? true : null), 10000, "the owned sleeping child to be alive");

    // The exact production shape of the defect: a TERMINAL record whose
    // finalize could not prove its managed tree stopped, so it retained
    // `childPid`/`childGeneration` and kept holding its exact workspace. The
    // generation's attempt start IS recorded (the retained child was spawned by
    // it), so the passive recovery can bind its proof to that generation.
    const startedAtMs = Date.now();
    const holder = createJobRecord({ task: "RECOVERY_HOLDER", cwd: ws.project });
    holder.status = "done";
    holder.stopReason = "success";
    holder.finishedAt = new Date().toISOString();
    holder.childPid = childPid!;
    holder.childGeneration = holder.generation;
    holder.attempts = [terminalAttempt(holder.generation, startedAtMs)];
    holder.result = {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      finalText: "RECOVERY_HOLDER_DONE",
      fallbackEligible: false
    };
    saveJob(ws.root, holder);
    appendUserMessageOrThrow(ws.root, holder.id, { text: "RECOVERY_HOLDER", generation: holder.generation, at: new Date().toISOString() });

    const recordFile = path.join(ws.root, "jobs", `${holder.id}.json`);
    const messagesFile = path.join(ws.root, "messages", `${holder.id}.json`);
    const recordBefore = fs.readFileSync(recordFile, "utf8");
    const messagesBefore = fs.readFileSync(messagesFile, "utf8");
    const recoveryFile = treeRecoveryPath(ws.root, holder.id);
    assert.equal(fs.existsSync(recoveryFile), false, "no recovery evidence exists before any proof");

    // (1) While the retained child is REALLY alive the holder keeps the
    // workspace: a real caller is refused and NOTHING is killed or rewritten.
    const refused = await runCaller(ws, { JOBQUAY_TEST_TASK: "RECOVERY_WHILE_ALIVE", JOBQUAY_TEST_CWD: ws.project });
    assert.equal(refused.ok, false, `a live retained child must keep blocking: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, "workspace_busy", "the refusal uses the stable code");
    const message = String(refused.message);
    assert.ok(message.includes(holder.id), "the refusal names the terminal holder");
    assert.ok(message.includes(String(childPid)), "the refusal names the retained child PID");
    assert.equal(isPidAlive(childPid!), true, "production recovery never kills the retained child");
    assert.equal(fs.existsSync(recoveryFile), false, "a live child produces no recovery evidence");
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "the terminal record is byte-identical after the refusal");
    assert.equal(fs.readFileSync(messagesFile, "utf8"), messagesBefore, "the message history is byte-identical after the refusal");
    assert.equal(listJobs(ws.root).jobs.length, 1, "the refused dispatch created no job");
    assert.equal(invocations(ws).length, 0, "the refused dispatch started no provider process");
    assert.equal(
      fs.existsSync(path.join(ws.root, "terminal", `${holder.id}.gen-${holder.generation}.json`)),
      false,
      "the refusal wrote no terminal snapshot"
    );
    assert.equal(fs.existsSync(path.join(ws.root, "notify", `${holder.id}.gen-${holder.generation}.claim`)), false, "no wake was claimed");
    assert.equal(fs.existsSync(path.join(ws.root, "notify", `${holder.id}.gen-${holder.generation}.result.json`)), false, "no wake result was recorded");

    // (2) The owned child GENUINELY exits (stopped by this test, never by the
    // product) and the daemon is RESTARTED: the release must be derived from
    // durable state, not from daemon memory.
    await stopOwnedChild(sleeping);
    await waitFor(() => (isPidAlive(childPid!) === false ? true : null), 10000, "the owned child to exit");
    await daemon.close();
    daemon = await startDaemon(ws.root);

    // (3) TWO REAL caller processes race for the same cwd through the fresh
    // daemon. The production admission recovery independently proves the
    // retained tree stopped (same boot session → bounded descendant snapshot),
    // persists generation-bound evidence, and the normal guard admits exactly
    // ONE of them — no test writes a confirmation or clears the child PID.
    const [one, two] = await Promise.all([
      runCaller(ws, { JOBQUAY_TEST_TASK: "RECOVERY_AFTER_EXIT_ONE", JOBQUAY_TEST_CWD: ws.project }),
      runCaller(ws, { JOBQUAY_TEST_TASK: "RECOVERY_AFTER_EXIT_TWO", JOBQUAY_TEST_CWD: ws.project })
    ]);
    const results = [one, two];
    callerOutcomes = results;
    const accepted = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    assert.equal(accepted.length, 1, `exactly one caller is accepted after the genuine exit: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1, "the other caller is refused, never silently queued");
    assert.equal(losers[0]!.code, "workspace_busy");
    const jobId = String(accepted[0]!.jobId);
    assert.notEqual(jobId, holder.id, "an INDEPENDENT new job was admitted");
    assert.ok(String(losers[0]!.message).includes(jobId), "the refused caller names the new holder");

    // The release came from the PRODUCTION recovery path: generation-bound
    // evidence exists, and the old terminal record / messages / result /
    // notification artifacts were never touched.
    const evidence = readTreeRecovery(ws.root, holder.id);
    assert.ok(evidence, "the production recovery persisted its evidence");
    assert.equal(evidence!.method, "descendant_snapshot");
    assert.equal(evidence!.generation, holder.generation);
    assert.equal(evidence!.childPid, childPid);
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBefore, "recovery never rewrites the old terminal record");
    assert.equal(fs.readFileSync(messagesFile, "utf8"), messagesBefore, "recovery never rewrites the message history");
    const holderAfter = loadJob(ws.root, holder.id)!;
    assert.equal(holderAfter.status, "done", "the old job stays done, never cancelled");
    assert.equal(holderAfter.result?.finalText, "RECOVERY_HOLDER_DONE", "the successful result is unchanged");
    assert.equal(holderAfter.childPid, childPid, "the retained evidence stays inspectable");
    assert.equal(holderAfter.childGeneration, holder.generation, "the retained generation binding is unchanged");
    assert.equal(holderAfter.cancelIntent.requested, false, "recovery never turns the job into a cancel");
    assert.equal(
      fs.existsSync(path.join(ws.root, "terminal", `${holder.id}.gen-${holder.generation}.json`)),
      false,
      "recovery wrote no terminal snapshot"
    );
    assert.equal(fs.existsSync(path.join(ws.root, "notify", `${holder.id}.gen-${holder.generation}.claim`)), false, "recovery claimed no wake");
    assert.equal(fs.existsSync(path.join(ws.root, "notify", `${holder.id}.gen-${holder.generation}.result.json`)), false, "recovery recorded no wake result");

    // Exactly ONE provider process started (the winner), and the old holder's
    // task never ran as a side effect.
    await waitFor(() => (invocations(ws).length >= 1 ? true : null), 20000, "the accepted provider process to start");
    assert.equal(invocations(ws).length, 1, "only the accepted new job started a provider process");
    assert.equal(listJobs(ws.root).jobs.length, 2, "the old holder and exactly one new job are durable");

    await release(ws);
    const done = await waitStatus(ws.root, jobId, ["done", "error"]);
    assert.equal(done.status, "done");
    assert.equal(done.result?.finalText, `WS_OK:${done.task.trim()}`, "the independent job ran its OWN task");
      },
      async () => {
        // Attempt EVERY owned cleanup step even after a failure; the observer
        // wrappers are restored in the outer `finally` regardless of the outcome.
        await runCleanupSteps([
          {
            name: "owned-child.kill",
            run: () => {
              const child = ownedChild.child;
              if (child && child.exitCode == null && child.signalCode == null) child.kill();
            }
          },
          { name: "cleanup", run: () => cleanup(ws, daemon) }
        ]);
      }
    );
  } finally {
    observer.restore();
    try {
      const child = ownedChild.child;
      if (child && child.exitCode == null && child.signalCode == null) child.kill();
    } catch {
      /* best effort: the child is owned by this test */
    }
  }
});

test("a legacy stopped confirmation plus a reused live PID: production admission releases ONLY with an independent boot proof, never signalling the live process", { timeout: 120000 }, async () => {
  const ws = newWorkspace("confirmed-reuse");
  const daemon = await startDaemon(ws.root);
  // An OWNED, harmless sleeping child stands in for the unrelated process that
  // now holds the holder's old PID. The product must never signal it.
  const sleeping = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const childPid = sleeping.pid;
  assert.ok(childPid);
  try {
    await waitFor(() => (isPidAlive(childPid!) === true ? true : null), 10000, "the owned sleeping child to be alive");
    const boot = await readBootTime();
    assert.equal(boot.ok, true, `the real OS boot instant must be readable: ${boot.reason}`);

    const holder = createJobRecord({ task: "CONFIRMED_REUSE_HOLDER", cwd: ws.project });
    holder.status = "done";
    holder.finishedAt = new Date().toISOString();
    holder.childPid = childPid!;
    holder.childGeneration = holder.generation;
    // Phase A: the generation started AFTER the current boot, so NO independent
    // proof exists. A legacy stopped confirmation must NOT release a live PID.
    holder.attempts = [terminalAttempt(holder.generation, Date.now())];
    saveJob(ws.root, holder);
    writeTreeConfirmation(ws.root, holder.id, holder.generation, childPid!, "os_tree_exited", "workspace-test");
    const recordFile = path.join(ws.root, "jobs", `${holder.id}.json`);
    const recoveryFile = treeRecoveryPath(ws.root, holder.id);
    const recordBeforeA = fs.readFileSync(recordFile, "utf8");

    const refused = await runCaller(ws, { JOBQUAY_TEST_TASK: "CONFIRMED_REUSE_REFUSED", JOBQUAY_TEST_CWD: ws.project });
    assert.equal(refused.ok, false, `a live reused PID must keep blocking without independent proof: ${JSON.stringify(refused)}`);
    assert.equal(refused.code, "workspace_busy", "the refusal uses the stable code");
    assert.ok(String(refused.message).includes(String(childPid)), "the refusal names the retained child PID");
    assert.equal(isPidAlive(childPid!), true, "the live process was never signalled");
    assert.equal(fs.existsSync(recoveryFile), false, "no independent proof, no recovery evidence");
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBeforeA, "the terminal record is byte-identical after the refusal");
    assert.equal(listJobs(ws.root).jobs.length, 1, "the refused dispatch created no job");
    assert.equal(invocations(ws).length, 0, "the refused dispatch started no provider process");

    // Phase B: the SAME holder's generation provably predates the current boot
    // (the historical-holder shape passive recovery exists for). The real boot
    // proof is the independent evidence; admission releases without a kill.
    const reloaded = loadJob(ws.root, holder.id)!;
    reloaded.attempts = [terminalAttempt(holder.generation, boot.bootTimeMs! - 60_000)];
    saveJob(ws.root, reloaded);
    const recordBeforeB = fs.readFileSync(recordFile, "utf8");

    const accepted = await runCaller(ws, { JOBQUAY_TEST_TASK: "CONFIRMED_REUSE_ACCEPTED", JOBQUAY_TEST_CWD: ws.project });
    assert.equal(accepted.ok, true, `the boot proof must release the workspace: ${JSON.stringify(accepted)}`);
    assert.notEqual(accepted.jobId, holder.id, "an INDEPENDENT new job was admitted");
    assert.equal(isPidAlive(childPid!), true, "production recovery never signalled the live reused PID");
    const evidence = readTreeRecovery(ws.root, holder.id);
    assert.ok(evidence, "the production recovery persisted its boot proof");
    assert.equal(evidence!.method, "boot_session_cleared");
    assert.equal(evidence!.childPid, childPid);
    assert.equal(evidence!.generation, holder.generation);
    assert.equal(evidence!.bootAtMs, boot.bootTimeMs);
    assert.equal(evidence!.generationStartedAtMs, boot.bootTimeMs! - 60_000);
    assert.equal(fs.readFileSync(recordFile, "utf8"), recordBeforeB, "recovery never rewrites the terminal record");
    assert.equal(loadJob(ws.root, holder.id)!.childPid, childPid, "the retained evidence stays inspectable");

    await waitFor(() => (invocations(ws).length >= 1 ? true : null), 20000, "the accepted provider process to start");
    assert.equal(invocations(ws).length, 1, "only the accepted new job started a provider process");
    await release(ws);
    const done = await waitStatus(ws.root, String(accepted.jobId), ["done", "error"]);
    assert.equal(done.status, "done");
    assert.equal(done.result?.finalText, `WS_OK:${done.task.trim()}`, "the independent job ran its OWN task");
  } finally {
    try {
      if (sleeping.exitCode == null && sleeping.signalCode == null) sleeping.kill();
    } catch {
      /* best effort: the child is owned by this test */
    }
    await cleanup(ws, daemon);
  }
});

test("done, cancel and a failed launch each release the workspace for the next accepted task", { timeout: 120000 }, async () => {
  const ws = newWorkspace("release");
  const daemon = await startDaemon(ws.root);
  try {
    // (a) A failed worker launch is a durable terminal error and frees the cwd.
    await assert.rejects(
      () => startJobViaDaemon(ws.root, {
        task: "SPAWN_FAILS",
        cwd: ws.project,
        runner: "fixture",
        fixturePath: ws.fixture,
        workerScript: path.join(ws.dir, "missing-worker.js"),
        env: ws.env
      }),
      (e: unknown) => e instanceof JobDaemonError && e.code === "worker_missing"
    );
    const failed = listJobs(ws.root).jobs.find((job) => job.task === "SPAWN_FAILS");
    assert.ok(failed);
    assert.equal(failed!.status, "error");
    const afterFailure = await startJobViaDaemon(ws.root, {
      task: "AFTER_SPAWN_FAILURE",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    assert.ok(afterFailure.job.id, "a failed launch released the workspace");

    // (b) An explicit cancel releases the workspace.
    const cancelled = await requestCancel(ws.root, afterFailure.job.id, { by: "workspace-test", waitMs: 8000 });
    assert.equal(cancelled.job?.status, "cancelled");
    const afterCancel = await startJobViaDaemon(ws.root, {
      task: "AFTER_CANCEL",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    assert.ok(afterCancel.job.id, "a cancelled holder released the workspace");

    // (c) A genuine completion releases the workspace.
    await release(ws);
    const done = await waitStatus(ws.root, afterCancel.job.id, ["done", "error"]);
    assert.equal(done.status, "done");
    const afterDone = await startJobViaDaemon(ws.root, {
      task: "AFTER_DONE",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    assert.ok(afterDone.job.id, "a completed holder released the workspace");
  } finally {
    await cleanup(ws, daemon);
  }
});

test("a daemon restart retains a LIVE worker's occupancy, while a stale-dead worker is reconciled by the shared liveness rules", { timeout: 120000 }, async () => {
  const ws = newWorkspace("restart");
  const second = path.join(ws.dir, "project-two");
  fs.mkdirSync(second, { recursive: true });
  let daemon: DaemonHandle | null = await startDaemon(ws.root);
  try {
    const live = await startJobViaDaemon(ws.root, {
      task: "RESTART_LIVE",
      cwd: ws.project,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    await waitStatus(ws.root, live.job.id, ["queued", "running"]);
    await waitFor(() => (invocations(ws).length === 1 ? true : null), 20000, "the live worker to start");

    // REAL daemon restart: the broker process/state goes away; the worker is an
    // independent process and keeps running.
    await daemon.close();
    daemon = await startDaemon(ws.root);

    // The live worker's occupancy is reconstructed from the durable record.
    await assert.rejects(
      () => startJobViaDaemon(ws.root, {
        task: "RESTART_REFUSED",
        cwd: ws.project,
        runner: "fixture",
        fixturePath: ws.fixture,
        env: ws.env
      }),
      (e: unknown) => e instanceof JobDaemonError && e.code === "workspace_busy" && String((e as Error).message).includes(live.job.id)
    );
    assert.equal(listJobs(ws.root).jobs.length, 1, "the refused restart dispatch created no job");

    // A stale-dead worker in a DIFFERENT directory is settled by the same
    // reconcile/liveness rules and frees its workspace for a new accepted task.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const deadPid = dead.pid;
    assert.ok(deadPid);
    await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
    const stale = createJobRecord({ task: "STALE_DEAD", cwd: second });
    stale.status = "running";
    stale.owner = `jobquay-${deadPid}-dead`;
    stale.ownerPid = deadPid!;
    stale.heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
    stale.childPid = null;
    saveJob(ws.root, stale);
    const afterStale = await startJobViaDaemon(ws.root, {
      task: "AFTER_STALE_DEAD",
      cwd: second,
      runner: "fixture",
      fixturePath: ws.fixture,
      env: ws.env
    });
    assert.ok(afterStale.job.id, "the stale-dead holder was reconciled, not left blocking");
    assert.equal(loadJob(ws.root, stale.id)!.status, "interrupted", "the stale-dead job was settled by the shared liveness rules");
    assert.equal(listJobs(ws.root).jobs.length, 3, "the live, stale and newly accepted jobs are all durable");

    // The live worker still holds its own directory after the restart.
    await release(ws);
    const done = await waitStatus(ws.root, live.job.id, ["done", "error"]);
    assert.equal(done.status, "done", "the live worker survived the daemon restart");
  } finally {
    await cleanup(ws, daemon);
  }
});
