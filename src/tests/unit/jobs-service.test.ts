// jobs-service.test.ts — durable-failure behaviour of the job service when a
// worker cannot be launched.
//
// A queued record must never be left as a job that will never run: if the worker
// entry cannot be spawned (here: the worker script does not exist), the record is
// finalized to a durable `error` and the caller sees the failure. This is the
// spawn-failure path added after review; it is exercised here without a child
// process (the cross-process boundary is covered by
// src/tests/integration/job-harness.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type execFile } from "node:child_process";
import {
  JobServiceError,
  RECOVERY_PROMPT,
  createJobRecord,
  getStatus,
  prepareContinuation,
  requestCancel,
  runWorker,
  startJob
} from "../../jobs/service";
import { loadJob, readTerminalReadReceipt, readTerminalSnapshot, readTreeConfirmation, saveJob, writeCancelIntent, writeTreeConfirmation } from "../../jobs/store";
import { appendUserMessageOrThrow, loadUserMessagesInfo } from "../../jobs/messages";
import type { JobRunner, ModelCandidate } from "../../jobs/runner";
import { emptyUsage, isTerminalStatus, type JobRecord } from "../../jobs/types";
import { captureProcessIdentity, isPidAlive, killProcessTree } from "../../runtime/process";
import { createFixtureRunner } from "../../cli/fixture-runner";
import { providerCancelAllowsCancellation } from "../../jobs/provider-cancel";
import { jobResult } from "../../mcp/tools";
import type { ExitClassification, ProviderTurnCancelInput, ProviderTurnCancelResult, StreamState, UsageSnapshot } from "../../providers/provider";
import { WORKBUDDY_AI_PROVIDER } from "../../providers/workbuddy-ai/index";

/** An execFile stand-in that reports a taskkill FAILURE (the fallback path). */
const failingExecFile = ((...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: Error) => void;
  cb(new Error("taskkill failed (simulated)"));
}) as unknown as typeof execFile;

/** A runner stub: runWorker must not reach an attempt in the old_tree_alive case. */
function stubRunner(): JobRunner {
  return {
    kind: "fixture",
    // No CLI catalog: nothing can be PROVEN, so no boundary is ever armed.
    catalog: { ok: false, source: "unavailable", models: [], defaultModel: null },
    async resolveModel() {
      return { ok: true, model: "test/model", source: "config-default" as const, effort: null, explicitModel: null, code: null, error: null };
    },
    async resolveChain() {
      return {
        ok: true,
        chain: [{ model: "test/model", source: "config-default" as const, effort: null }],
        explicitModel: null,
        code: null,
        error: null,
        diagnostics: []
      };
    },
    buildAttempt() {
      return { ok: false, error: "unused in the old_tree_alive case" };
    },
    createState() {
      return {} as StreamState;
    },
    parseLine() {
      /* no-op */
    },
    normalizeUsage() {
      // The canonical usage shape is shared with JobUsage; a fake runner reports
      // "nothing measured" rather than a fabricated zero.
      return emptyUsage() satisfies UsageSnapshot;
    },
    classifyExit() {
      return { kind: "success", failureKind: null, stopReason: null, fatal: false, fallback: false } satisfies ExitClassification;
    }
  };
}

async function waitAlive(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid) !== true && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function newTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-spawnfail-"));
}

test("startJob finalizes a durable error (never a stuck queued job) when the worker cannot be launched", () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const missingWorker = path.join(dir, "does-not-exist.js");
    assert.throws(
      () => startJob({ root, task: "hello", cwd, workerScript: missingWorker }),
      (e: unknown) => e instanceof JobServiceError && e.code === "worker_missing"
    );

    const files = fs.readdirSync(path.join(root, "jobs")).filter((n) => n.endsWith(".json"));
    assert.equal(files.length, 1, "the queued record must still exist (as a durable failure)");
    const job = loadJob(root, files[0]!.replace(/\.json$/, ""));
    assert.ok(job);
    assert.equal(job!.status, "error");
    assert.equal(job!.failureKind, "worker_missing");
    assert.equal(job!.stopReason, "worker_missing");
    assert.ok(job!.finishedAt, "a durable failure must carry finishedAt");
    assert.equal(job!.childPid, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareContinuation finalizes a durable error when the continuation worker cannot be launched", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "first", cwd });
    job.status = "done";
    job.sessionId = "sess-abc-123";
    job.finishedAt = new Date().toISOString();
    saveJob(root, job);

    const missingWorker = path.join(dir, "does-not-exist.js");
    const res = await prepareContinuation({ root, jobId: job.id, task: "follow up", workerScript: missingWorker });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.code, "worker_missing");

    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, "error");
    assert.equal(reloaded!.failureKind, "worker_missing");
    assert.ok(reloaded!.finishedAt);
    assert.equal(reloaded!.generation, job.generation + 1, "the continuation still advanced the generation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareContinuation fresh-retries the same logical job when generation 0 failed before any session existed", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const originalTask = "ORIGINAL telemetry task";
    const followUp = "Infrastructure is repaired; continue the original task.";
    const job = createJobRecord({ task: originalTask, cwd, provider: "workbuddy-ai" });
    job.status = "error";
    job.finishedAt = new Date().toISOString();
    job.failureKind = "bridge_error";
    job.stopReason = "bridge_error";
    job.result = {
      ok: false,
      subtype: "error",
      kind: "unknown",
      exitCode: 1,
      stopReason: "bridge_error",
      finalText: null,
      fallbackEligible: false
    };
    saveJob(root, job);
    appendUserMessageOrThrow(root, job.id, { text: originalTask, generation: 0, at: job.createdAt });

    const missingWorker = path.join(dir, "does-not-exist.js");
    const res = await prepareContinuation({ root, jobId: job.id, task: followUp, workerScript: missingWorker });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.code, "worker_missing", "fresh retry reaches the normal worker launch path instead of no_session");

    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.generation, 1);
    assert.equal(reloaded!.sessionId, null);
    assert.ok(reloaded!.task.includes("ORIGINAL_TASK:\nORIGINAL telemetry task"));
    assert.ok(reloaded!.task.includes("FOLLOW_UP_1:\nInfrastructure is repaired; continue the original task."));

    const history = loadUserMessagesInfo(root, job.id);
    assert.equal(history.complete, true);
    assert.deepEqual(history.messages.map((m) => [m.generation, m.text]), [
      [0, originalTask],
      [1, followUp]
    ], "durable user history remains separate from the synthesized fresh-start execution task");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareContinuation still refuses no-session continuation when a fresh retry is not provably safe", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const done = createJobRecord({ task: "done without session", cwd, provider: "workbuddy-ai" });
    done.status = "done";
    done.finishedAt = new Date().toISOString();
    done.result = {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: null,
      finalText: "already completed",
      fallbackEligible: false
    };
    saveJob(root, done);
    appendUserMessageOrThrow(root, done.id, { text: done.task, generation: 0, at: done.createdAt });
    const doneResult = await prepareContinuation({ root, jobId: done.id, task: "again" });
    assert.equal(doneResult.ok, false);
    if (doneResult.ok) throw new Error("unreachable");
    assert.equal(doneResult.code, "no_session");

    const missingHistory = createJobRecord({ task: "lost original", cwd, provider: "workbuddy-ai" });
    missingHistory.status = "error";
    missingHistory.finishedAt = new Date().toISOString();
    missingHistory.result = {
      ok: false,
      subtype: "error",
      kind: "unknown",
      exitCode: 1,
      stopReason: "bridge_error",
      finalText: null,
      fallbackEligible: false
    };
    saveJob(root, missingHistory);
    const missingHistoryResult = await prepareContinuation({ root, jobId: missingHistory.id, task: "retry" });
    assert.equal(missingHistoryResult.ok, false);
    if (missingHistoryResult.ok) throw new Error("unreachable");
    assert.equal(missingHistoryResult.code, "no_session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createJobRecord accepts the two first-release providers and rejects unknown providers", () => {
  assert.equal(createJobRecord({ task: "t", cwd: process.cwd(), provider: "workbuddy-ai" }).runner, "workbuddy-ai");
  assert.throws(
    () => createJobRecord({ task: "t", cwd: process.cwd(), provider: "third-provider" }),
    (e: unknown) => e instanceof JobServiceError && e.code === "invalid_provider"
  );
  assert.equal(createJobRecord({ task: "t", cwd: process.cwd() }).provider, "command-code");
  assert.equal(createJobRecord({ task: "t", cwd: process.cwd(), provider: "command-code" }).provider, "command-code");
  assert.equal(createJobRecord({ task: "t", cwd: process.cwd(), provider: "workbuddy-ai", model: "hy4-preview-f" }).runner, "workbuddy-ai");
});

test("requestCancel never reports cancelled when the tree kill is UNCONFIRMED, and keeps the child PID", { skip: process.platform === "win32" ? false : "Windows taskkill fallback semantics" }, async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  try {
    const pid = child.pid;
    assert.ok(pid, "the live child must have a pid");
    await waitAlive(pid);
    assert.equal(isPidAlive(pid), true);

    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647; // a PID that does not exist → owner is dead
    job.heartbeatAt = new Date().toISOString(); // fresh → no reconcile on the status load
    job.childPid = pid;
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
    saveJob(root, job);

    const res = await requestCancel(root, job.id, {
      execFileFn: failingExecFile,
      enumerateFn: async () => ({ ok: false, processes: [], error: "simulated scan unavailable" }),
      graceMs: 100,
      pollMs: 10,
      waitMs: 0
    });
    assert.equal(res.kill.scope, "root_exited", "a root-only fallback proves the ROOT gone, never the tree");
    assert.notEqual(res.kill.scope, "os_tree_exited", "the tree exit must never be claimed when the tree kill failed");
    assert.ok(res.job);
    assert.notEqual(res.job.status, "cancelled", "an unconfirmed tree must never be reported cancelled");
    assert.equal(res.job.childPid, pid, "the child PID must be preserved as evidence for a retry");
    assert.equal(res.finalizedBy, "none");
  } finally {
    await killProcessTree(child.pid, { graceMs: 2000 }).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWorker refuses a new generation when an old tree cannot be confirmed exited, keeping the child PID", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.generation = 0;
    job.childPid = 4242;
    job.childGeneration = 0;
    saveJob(root, job);

    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      isAliveFn: () => true, // the old tree is (claimed) still alive
      execFileFn: failingExecFile, // and its kill cannot be confirmed
      graceMs: 50,
      delayFn: async () => undefined,
      createRunner: async () => stubRunner()
    });

    assert.equal(res.status, "orphaned");
    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded!.status, "orphaned");
    assert.equal(reloaded!.childPid, 4242, "the child PID must survive so a cancel can retry");
    assert.equal(reloaded!.childGeneration, 0);
    assert.equal(reloaded!.finishedAt, null, "orphaned is not a finished job");

    // A continuation is refused → no new generation may start.
    const cont = await prepareContinuation({ root, jobId: job.id, task: "again" });
    assert.equal(cont.ok, false);
    if (cont.ok) throw new Error("unreachable");
    assert.equal(cont.code, "job_not_terminal");
    assert.equal(loadJob(root, job.id)!.generation, 0, "no new generation may start while the tree is unproven");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWorker refuses a new generation when the old ROOT is dead but the tree is unconfirmed (E/G), keeping the child PID", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.generation = 0;
    job.childPid = 4242;
    job.childGeneration = 0;
    saveJob(root, job);

    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      isAliveFn: () => false, // the ROOT PID is already gone...
      graceMs: 50,
      delayFn: async () => undefined,
      createRunner: async () => stubRunner() // must never be reached
    });

    assert.equal(res.status, "orphaned", "a dead root PID must not permit a new generation");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "orphaned");
    assert.equal(reloaded!.childPid, 4242);
    assert.equal(reloaded!.childGeneration, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWorker honours a cancel intent recorded before any child existed (A: queued, never spawned)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job); // queued, childPid null
    writeCancelIntent(root, job.id, "test");

    const res = await runWorker({ platform: "win32", root, jobId: job.id, createRunner: async () => stubRunner() });
    assert.equal(res.status, "cancelled");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "cancelled");
    assert.equal(reloaded!.childPid, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWorker never finalises cancelled on a cancel intent alone when a child tree was recorded (A/E)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.generation = 0;
    job.childPid = 4242; // a recorded tree whose root is (claimed) dead
    job.childGeneration = 0;
    saveJob(root, job);
    writeCancelIntent(root, job.id, "test");

    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      isAliveFn: () => false, // root gone, but no tree confirmation exists
      graceMs: 50,
      delayFn: async () => undefined,
      createRunner: async () => stubRunner()
    });

    assert.equal(res.status, "orphaned", "the intent file alone is not tree-exit evidence");
    const reloaded = loadJob(root, job.id);
    assert.notEqual(reloaded!.status, "cancelled");
    assert.equal(reloaded!.childPid, 4242);
    assert.equal(reloaded!.cancelIntent.requested, true, "the cancel intent must be preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A fixture that starts a WB turn, flags readiness, then waits for a release file before exiting non-success. */
function writeWbWorkerCancelFixture(dir: string): string {
  const fixture = path.join(dir, "wb-cancel-worker-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const sid = "fx-wb-cancel-unit";',
      '  process.stdout.write(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: sid } }) + "\\n");',
      '  fs.writeFileSync("wb-unit-started.flag", "1");',
      '  const t = setInterval(() => {',
      '    if (fs.existsSync("wb-unit-release.flag")) {',
      '      clearInterval(t);',
      '      process.stdout.write(JSON.stringify({ type: "result", subtype: "error", result: null, session_id: sid, stop_reason: "error" }) + "\\n");',
      '      process.exit(1);',
      '    }',
      '  }, 20);',
      '});'
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a worker that closes before its heartbeat tick still resolves the provider-owned cleanup before `cancelled` (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeWbWorkerCancelFixture(dir);
  const started = path.join(cwd, "wb-unit-started.flag");
  const release = path.join(cwd, "wb-unit-release.flag");
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    saveJob(root, job);
    let cancelCalls = 0;
    const running = runWorker({ platform: "win32",
      root,
      jobId: job.id,
      // No heartbeat tick fires before the run closes: the run-close cancel path
      // must START the provider request itself and resolve it before claiming.
      heartbeatMs: 3_600_000,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] }),
      providerCancelWaitMs: 50,
      providerCancel: {
        turnSlotKeyFn: () => "slot-test",
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => {
          cancelCalls += 1;
          return { route: "test-route", requested: true, sessionId: input.sessionId, ownedRoots: [500000], slotKey: "slot-test", detail: null };
        }
      }
    });

    await waitForFile(started);
    writeCancelIntent(root, job.id, "test");
    fs.writeFileSync(release, "1");

    const res = await running;
    assert.equal(cancelCalls, 1, "the provider route must be asked even though the heartbeat tick never fired");
    assert.equal(res.status, "cancelled");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "cancelled");
    assert.equal(reloaded!.childPid, null);
    assert.equal(reloaded!.cancelCleanup?.state, "no_owned_work");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolved provider-owned tool keeps a pre-tick worker non-terminal with retained evidence (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeWbWorkerCancelFixture(dir);
  const started = path.join(cwd, "wb-unit-started.flag");
  const release = path.join(cwd, "wb-unit-release.flag");
  const ownedRoot = 500000;
  const tool = 500001;
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    saveJob(root, job);
    let cancelCalls = 0;
    const running = runWorker({ platform: "win32",
      root,
      jobId: job.id,
      heartbeatMs: 3_600_000,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      isAliveFn: (pid) => pid === tool,
      // The runtime's OWN tool (a descendant of the owned root) stays alive.
      enumerateFn: async () => ({ ok: true, processes: [{ pid: tool, ppid: ownedRoot, createdAtMs: Date.now() }] }),
      providerCancelWaitMs: 60,
      providerCancel: {
        turnSlotKeyFn: () => "slot-test",
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => {
          cancelCalls += 1;
          return { route: "test-route", requested: true, sessionId: input.sessionId, ownedRoots: [ownedRoot], slotKey: "slot-test", detail: null };
        }
      }
    });

    await waitForFile(started);
    writeCancelIntent(root, job.id, "test");
    fs.writeFileSync(release, "1");

    const res = await running;
    assert.equal(cancelCalls, 1);
    assert.equal(res.status, "orphaned", "an unresolved provider-owned tool must never be claimed as cancelled");
    const reloaded = loadJob(root, job.id);
    assert.notEqual(reloaded!.status, "cancelled");
    assert.equal(reloaded!.cancelCleanup?.state, "unresolved");
    assert.ok(reloaded!.childPid, "the child PID is retained as evidence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker whose provider-cancel seam THROWS keeps the job non-terminal with unresolved evidence (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeWbWorkerCancelFixture(dir);
  const started = path.join(cwd, "wb-unit-started.flag");
  const release = path.join(cwd, "wb-unit-release.flag");
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    saveJob(root, job);
    const running = runWorker({ platform: "win32",
      root,
      jobId: job.id,
      heartbeatMs: 3_600_000,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      isAliveFn: (pid) => pid === 600001,
      // An active external owned tool is visible — but the route throws.
      enumerateFn: async () => ({ ok: true, processes: [{ pid: 600001, ppid: 600000, createdAtMs: Date.now() }] }),
      providerCancelWaitMs: 60,
      providerCancel: {
        turnSlotKeyFn: () => {
          throw new Error("seam boom");
        },
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => ({
          route: "test-route",
          requested: true,
          sessionId: input.sessionId,
          ownedRoots: [600000],
          slotKey: "slot-test",
          detail: null
        })
      }
    });

    await waitForFile(started);
    writeCancelIntent(root, job.id, "test");
    fs.writeFileSync(release, "1");

    const res = await running;
    assert.equal(res.status, "orphaned", "a thrown seam is never proof of no provider work");
    const reloaded = loadJob(root, job.id);
    assert.notEqual(reloaded!.status, "cancelled");
    assert.equal(reloaded!.cancelCleanup?.state, "no_route", "an unreachable route keeps unresolved/no-route evidence");
    assert.ok(reloaded!.childPid, "ownership evidence is retained");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel with a THROWING provider seam never reports cancelled and retains ownership evidence (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    job.status = "running";
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647; // dead owner
    job.heartbeatAt = new Date().toISOString(); // fresh → no reconcile on the status load
    job.sessionId = "sess-wb-throw";
    job.childPid = 2147483646; // a dead recorded root
    job.childGeneration = 0;
    saveJob(root, job);

    const res = await requestCancel(root, job.id, {
      by: "test",
      waitMs: 0,
      graceMs: 100,
      pollMs: 10,
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] }),
      providerCancel: {
        turnSlotKeyFn: () => {
          throw new Error("seam boom");
        },
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => ({
          route: "test-route",
          requested: true,
          sessionId: input.sessionId,
          ownedRoots: [7],
          slotKey: "slot-test",
          detail: null
        })
      }
    });

    assert.notEqual(res.job?.status, "cancelled");
    assert.equal(isTerminalStatus(res.job!.status), false);
    assert.equal(res.job?.childPid, 2147483646, "ownership evidence is retained for a later retry");
    assert.equal(res.finalizedBy, "none");
    assert.ok(res.providerCancel);
    assert.equal(res.providerCancel!.state, "no_route");
    assert.equal(providerCancelAllowsCancellation(res.providerCancel!), false);
    assert.equal(loadJob(root, job.id)!.cancelCleanup?.state, "no_route");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a read-only getStatus never terminates a provider-owned turn without proof and writes no terminal snapshot (JQ-20261006-58)", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop owns the out-of-tree turn only on Windows/macOS" }, () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    Object.assign(job, {
      status: "running",
      owner: "jobquay-2147483647-x",
      ownerPid: 2147483647,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      sessionId: "sess-wb-getstatus",
      childPid: 2147483646,
      childGeneration: 0
    });
    saveJob(root, job);
    writeTreeConfirmation(root, job.id, 0, 2147483646, "os_tree_exited", "test");

    const viewed = getStatus(root, job.id, { thresholdMs: 0, isAliveFn: () => false, isChildAliveFn: () => false });
    assert.ok(viewed);
    assert.equal(viewed!.status, "orphaned", "a status read must not falsely settle a provider-owned turn");
    assert.equal(isTerminalStatus(viewed!.status), false);
    assert.equal(viewed!.childPid, 2147483646, "ownership evidence retained");
    assert.equal(readTerminalSnapshot(root, job.id, 0), null, "no terminal snapshot/wake before provider proof");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel with a persisted managed-tree confirmation still reaches the exact provider route and never settles early (JQ-20261006-58)", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop owns the out-of-tree turn only on Windows/macOS" }, async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
    Object.assign(job, {
      status: "running",
      owner: "jobquay-2147483647-x",
      ownerPid: 2147483647,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      sessionId: "sess-wb-tree",
      childPid: 2147483646,
      childGeneration: 0
    });
    saveJob(root, job);
    writeTreeConfirmation(root, job.id, 0, 2147483646, "os_tree_exited", "test");

    let routeChecks = 0;
    const res = await requestCancel(root, job.id, {
      waitMs: 0,
      thresholdMs: 0,
      graceMs: 100,
      pollMs: 10,
      isAliveFn: () => false,
      isChildAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] }),
      providerCancel: {
        turnSlotKeyFn: () => {
          routeChecks += 1;
          throw new Error("route unavailable");
        }
      }
    });

    assert.notEqual(res.job?.status, "interrupted");
    assert.notEqual(res.job?.status, "cancelled");
    assert.equal(res.job?.status, "orphaned");
    assert.equal(res.finalizedBy, "none");
    assert.equal(routeChecks, 1, "the exact provider route must be reached, not bypassed");
    assert.equal(res.providerCancel?.state, "no_route");
    assert.equal(res.job?.childPid, 2147483646, "ownership evidence retained");
    assert.equal(readTerminalSnapshot(root, job.id, 0), null, "no terminal snapshot/wake before provider proof");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261006-58 gen-3: durable cancellation outcome consistency
//
// The worker's cancel path may first write the NONTERMINAL intermediate hold
// (`orphaned` + `provider_tool_unresolved` + a CURRENT unresolved result) when
// the managed tree stopped but the provider-owned work could not yet be proven
// stopped. When the client later CONFIRMS the cleanup and settles `cancelled`,
// that stale per-attempt result must not survive into the terminal record: the
// established cancellation contract writes `result: null` (exactly like the
// worker's own cancelled finalizer at the `tree.stopped && providerCleaned`
// branch), so the served result payload states the same thing as the status.
// ---------------------------------------------------------------------------

/** The worker's intermediate orphaned/provider_tool_unresolved hold, verbatim. */
function staleUnresolvedJob(root: string, cwd: string): JobRecord {
  const job = createJobRecord({ task: "t", cwd, provider: WORKBUDDY_AI_PROVIDER });
  Object.assign(job, {
    status: "orphaned",
    owner: "jobquay-2147483647-x",
    ownerPid: 2147483647, // a PID that does not exist → the owner is dead
    // `orphaned` is never re-reconciled (only an explicit cancel moves it), so
    // this stays exactly the intermediate state a worker wrote.
    heartbeatAt: new Date().toISOString(),
    sessionId: "sess-wb-stale",
    childPid: 2147483646, // the dead recorded root of the stopped tree
    childGeneration: 0,
    stopReason: "provider_tool_unresolved",
    failureKind: "provider_tool_unresolved",
    error:
      "Cancel was requested and the CrewDispatch-managed process tree stopped, but the provider-owned work of this turn (it runs outside that tree) cannot be confirmed stopped; " +
      "the cancellation evidence is retained and the job stays pending rather than falsely reporting cancellation.",
    result: { ok: false, subtype: null, kind: "provider_tool_unresolved", exitCode: 1, stopReason: "provider_tool_unresolved", finalText: null, fallbackEligible: false },
    approvalOutcome: "expired",
    attempts: [
      { generation: 0, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, kind: null, failureKind: null, segment: false, resumedFrom: null, model: null, modelSource: null, effort: null, rateLimited: false, switched: false, switchToModel: null, usage: emptyUsage() }
    ]
  });
  saveJob(root, job);
  // This helper models the worker state AFTER its managed process tree has
  // already been proven stopped; only provider-owned cleanup remains unresolved.
  writeTreeConfirmation(root, job.id, job.generation, job.childPid!, "os_tree_exited", "test");
  return job;
}

test("a client-confirmed cancellation clears the worker's intermediate unresolved result and the served payload is consistent (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = staleUnresolvedJob(root, cwd);

    const res = await requestCancel(root, job.id, {
      by: "test",
      waitMs: 0,
      graceMs: 100,
      pollMs: 10,
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] }),
      providerCancel: {
        turnSlotKeyFn: () => "slot-wb-stale",
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => ({
          route: "test-route",
          requested: true,
          sessionId: input.sessionId,
          ownedRoots: [],
          slotKey: "slot-wb-stale",
          detail: null
        })
      }
    });

    // The confirmed cleanup settles `cancelled` — and the durable outcome is
    // EXACTLY the worker cancellation contract: no result, no failure kind, no
    // per-attempt approval token.
    assert.equal(res.finalizedBy, "client");
    assert.ok(res.job);
    assert.equal(res.job.status, "cancelled");
    assert.equal(res.job.result, null, "a proven cancellation carries NO result");
    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded.status, "cancelled");
    assert.equal(reloaded.result, null, "the stale provider_tool_unresolved result must not survive the terminal write");
    assert.equal(reloaded.stopReason, "cancelled");
    assert.equal(reloaded.error, null);
    assert.equal(reloaded.failureKind, null);
    assert.equal(reloaded.approvalOutcome ?? null, null, "a cancelled settlement carries no per-attempt approval token");
    assert.equal(reloaded.childPid, null, "a resolved tree clears the PID");
    assert.equal(reloaded.cancelCleanup?.state, "no_owned_work", "the durable evidence of what was proven is kept");
    // Attempt/audit history is preserved — the fix only corrects the outcome.
    assert.equal(reloaded.attempts.length, 1);
    assert.equal(reloaded.attempts[0]!.generation, 0);

    // One terminal snapshot (the wake source), and the REAL MCP result payload
    // serves the same durable facts (never the stale intermediate result).
    assert.equal(readTerminalSnapshot(root, job.id, 0)?.status, "cancelled");
    assert.equal(readTerminalReadReceipt(root, job.id, 0), null, "no read receipt before the result is served");
    const served = await jobResult({ id: job.id }, { root, sleep: async () => undefined });
    const payload = JSON.parse((served.content[0] as { text: string }).text) as { status: string; result: unknown; terminal: boolean };
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.terminal, true);
    assert.equal(payload.result, null, "the served result payload must be consistent with the cancelled status");
    assert.equal(readTerminalReadReceipt(root, job.id, 0)?.by, "mcp-result", "exactly the one result read is receipted");

    // Idempotent repeat: a terminal job is returned unchanged, still resultless.
    const again = await requestCancel(root, job.id, { waitMs: 0 });
    assert.equal(again.finalizedBy, "none");
    assert.equal(again.kill.reason, "already_terminal");
    assert.equal(loadJob(root, job.id)?.result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolved provider-owned cleanup retains the intermediate state and result, and stays nonterminal (JQ-20261006-58)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = staleUnresolvedJob(root, cwd);
    const ownedRoot = 987001;
    const survivorPid = 987002;

    const res = await requestCancel(root, job.id, {
      by: "test",
      waitMs: 0,
      graceMs: 100,
      pollMs: 10,
      providerCancelWaitMs: 50,
      isAliveFn: (pid) => pid === survivorPid,
      enumerateFn: async () => ({ ok: true, processes: [{ pid: survivorPid, ppid: ownedRoot, createdAtMs: Date.now() }] }),
      providerCancel: {
        turnSlotKeyFn: () => "slot-wb-stale",
        listJobsFn: () => {
          const current = loadJob(root, job.id);
          return current ? [current] : [];
        },
        cancelTurnFn: async (input: ProviderTurnCancelInput): Promise<ProviderTurnCancelResult> => ({
          route: "test-route",
          requested: true,
          sessionId: input.sessionId,
          ownedRoots: [ownedRoot],
          slotKey: "slot-wb-stale",
          detail: null
        })
      }
    });

    // The cleanup could not be proven stopped: the job must NOT be cancelled,
    // and the intermediate unresolved state/result stays as retained evidence.
    assert.equal(res.finalizedBy, "none");
    assert.ok(res.job);
    assert.equal(res.job.status, "orphaned");
    assert.equal(isTerminalStatus(res.job.status), false);
    assert.equal(res.job.childPid, 2147483646, "ownership evidence retained for a later retry");
    assert.equal(res.providerCancel?.state, "unresolved");
    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded.result?.kind, "provider_tool_unresolved", "an unresolved cleanup keeps its current result");
    assert.equal(reloaded.stopReason, "provider_tool_unresolved");
    assert.equal(reloaded.failureKind, "provider_tool_unresolved");
    assert.equal(reloaded.cancelCleanup?.state, "unresolved");
    assert.equal(readTerminalSnapshot(root, job.id, 0), null, "no terminal snapshot/wake before provider proof");
    assert.equal(readTerminalReadReceipt(root, job.id, 0), null);

    // The served payload is consistent with the NONTERMINAL state: it honestly
    // reports the retained unresolved result instead of a false cancellation.
    const served = await jobResult({ id: job.id }, { root, sleep: async () => undefined });
    const payload = JSON.parse((served.content[0] as { text: string }).text) as { status: string; terminal: boolean; result: { kind: string } | null };
    assert.equal(payload.status, "orphaned");
    assert.equal(payload.terminal, false);
    assert.equal(payload.result?.kind, "provider_tool_unresolved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel reaches a safe cancelled ONLY when the tree kill is confirmed (B)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: process.platform !== "win32",
    windowsHide: true
  });
  try {
    const pid = child.pid;
    assert.ok(pid);
    await waitAlive(pid);
    assert.equal(isPidAlive(pid), true);

    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647; // owner is dead
    job.heartbeatAt = new Date().toISOString(); // fresh → no reconcile on the status load
    job.childPid = pid;
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
    if (process.platform === "darwin") {
      const identity = captureProcessIdentity(pid!);
      assert.ok(identity?.createdAtUs != null, "the Darwin cancel fixture has exact birth evidence");
      job.childStartedAtUs = identity!.createdAtUs!;
    }
    saveJob(root, job);

    // Real OS tree kill against the real child → a CONFIRMED tree kill.
    const res = await requestCancel(root, job.id, { graceMs: 4000, waitMs: 0 });
    assert.equal(res.kill.scope, "os_tree_exited", `expected a confirmed OS tree kill: ${JSON.stringify(res.kill)}`);
    assert.equal(res.finalizedBy, "client");
    assert.ok(res.job);
    assert.equal(res.job.status, "cancelled");
    assert.equal(res.job.childPid, null, "a proven-stopped tree clears the PID");
    assert.equal(isPidAlive(pid), false, "the real child must be gone");
  } finally {
    await killProcessTree(child.pid, { graceMs: 2000 }).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel never reports cancelled when the recorded ROOT is already dead and the tree is unconfirmed (E)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    job.status = "running";
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647;
    job.heartbeatAt = new Date(Date.now() - 600000).toISOString(); // stale → reconcile fires
    job.childPid = 2147483646; // a PID that does not exist (root already gone)
    job.childGeneration = 0;
    saveJob(root, job);

    const res = await requestCancel(root, job.id, { graceMs: 100, pollMs: 10, waitMs: 0 });
    assert.equal(res.kill.scope, "root_exited", "a dead root is never tree-exit evidence");
    assert.notEqual(res.kill.scope, "os_tree_exited");
    assert.ok(res.job);
    assert.notEqual(res.job.status, "cancelled");
    assert.equal(isTerminalStatus(res.job.status), false, "must stay non-terminal");
    assert.equal(res.job.childPid, 2147483646, "the child PID must be preserved for a later retry/manual handling");
    assert.equal(res.finalizedBy, "none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareContinuation refuses when the recorded ROOT is dead but the tree is unconfirmed (G)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "first", cwd });
    job.status = "done";
    job.sessionId = "sess-abc-123";
    job.generation = 0;
    job.finishedAt = new Date().toISOString();
    job.childPid = 2147483646; // a leftover, now-dead root with no confirmation
    job.childGeneration = 0;
    saveJob(root, job);

    const res = await prepareContinuation({ root, jobId: job.id, task: "again", isAliveFn: () => false, workerScript: path.join(dir, "nope.js") });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.code, "old_tree_unconfirmed");
    assert.equal(loadJob(root, job.id)!.generation, 0, "no new generation may start over an unproven tree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuine completion wins over a concurrent cancel that never confirmed a tree kill (H)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = path.join(dir, "slow-success.js");
  fs.writeFileSync(
    fixture,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const sid = "fx-h-session";',
      "  setTimeout(() => {",
      '    process.stdout.write(JSON.stringify({ type: "event", event: { type: "run_start", sessionId: sid } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "ok:" + input.trim(), session_id: sid, stop_reason: "end_turn" }) + "\\n");',
      "    process.exit(0);",
      "  }, 700);",
      "});"
    ].join("\n"),
    "utf8"
  );
  try {
    const job = createJobRecord({ task: "hello", cwd });
    saveJob(root, job);

    const running = runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env)
    });
    // The cancel arrives DURING the run but no tree kill is ever confirmed.
    await new Promise((r) => setTimeout(r, 250));
    writeCancelIntent(root, job.id, "test");

    const res = await running;
    assert.equal(res.status, "done", "a genuinely completed job keeps its own real result");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "done");
    assert.equal(reloaded!.childPid, null);
    assert.equal(reloaded!.result?.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A CLI-shaped fixture: `max_turns` on the first run, success on `--resume`. */
function writeSegmentFixture(dir: string): string {
  const fixture = path.join(dir, "segment-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const sid = "fx-seg-unit";',
      '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
      '  if (!process.argv.includes("--resume")) {',
      '    out({ type: "result", subtype: "max_turns", result: "partial", session_id: sid, stop_reason: "max_turns" });',
      '    process.exit(8);',
      '  }',
      '  out({ type: "result", subtype: "success", result: "final:" + input.trim(), session_id: sid, stop_reason: "end_turn" });',
      '  process.exit(0);',
      '});'
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

test("a max_turns segment over a surviving descendant holds orphaned instead of starting generation 1", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeSegmentFixture(dir);
  const survivorPid = 987654;
  try {
    const job = createJobRecord({ task: "seg", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      // Force the group boundary to remain unproven so this test continues to
      // exercise the old-tree hold rather than native Darwin group confirmation.
      isAliveFn: (pid) => (pid === survivorPid ? true : false),
      isProcessGroupAliveFn: () => true,
      enumerateFn: async () => {
        const current = loadJob(root, job.id);
        return { ok: true, processes: [{ pid: survivorPid, ppid: current?.childPid ?? -1, createdAtMs: Date.now() }] };
      }
    });
    assert.equal(res.status, "orphaned", "a surviving descendant must never permit a new generation");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "orphaned");
    assert.equal(reloaded!.generation, 0, "generation 1 must not start over a surviving descendant");
    assert.equal(reloaded!.attempts.length, 1);
    assert.ok(reloaded!.childPid, "the recorded root PID must be kept as evidence");
    assert.equal(reloaded!.finishedAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a max_turns segment with NO surviving descendant resumes the same session into generation 1", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeSegmentFixture(dir);
  try {
    const job = createJobRecord({ task: "seg", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      isAliveFn: () => false, // the real fixture root has exited
      enumerateFn: async () => ({ ok: true, processes: [] }) // no descendants
    });
    assert.equal(res.status, "done");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "done");
    assert.equal(reloaded!.generation, 1);
    assert.equal(reloaded!.attempts.length, 2);
    assert.equal(reloaded!.attempts[1]?.resumedFrom, "fx-seg-unit");
    // The segment resume uses the fixed internal recovery prompt, never the task.
    assert.equal(reloaded!.result?.finalText, `final:${RECOVERY_PROMPT}`);
    assert.equal(reloaded!.childPid, null, "a proven-stopped tree clears the PID");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unavailable process scan keeps the job honest (orphaned) instead of starting generation 1", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeSegmentFixture(dir);
  try {
    const job = createJobRecord({ task: "seg", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      isAliveFn: () => false,
      isProcessGroupAliveFn: () => true,
      enumerateFn: async () => ({ ok: false, processes: [], reason: "test_unavailable" })
    });
    assert.equal(res.status, "orphaned", "an unknown tree must never permit a new generation");
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "orphaned");
    assert.equal(reloaded!.generation, 0);
    assert.ok(reloaded!.childPid, "the PID must be kept while the tree is unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareContinuation refuses a terminal job whose success left a surviving descendant", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const survivorPid = 987655;
  try {
    const job = createJobRecord({ task: "first", cwd });
    job.status = "done";
    job.sessionId = "sess-descendant-1";
    job.generation = 0;
    job.finishedAt = new Date().toISOString();
    job.childPid = 2147483646; // a dead recorded root
    job.childGeneration = 0;
    job.attempts = [
      { generation: 0, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: null, exitCode: 0, kind: "success", failureKind: null, segment: false, resumedFrom: null, model: null, modelSource: null, effort: null, rateLimited: false, switched: false, switchToModel: null, usage: emptyUsage() }
    ];
    saveJob(root, job);

    const res = await prepareContinuation({
      root,
      jobId: job.id,
      task: "again",
      workerScript: path.join(dir, "nope.js"),
      isAliveFn: (pid) => (pid === survivorPid ? true : false),
      enumerateFn: async () => ({ ok: true, processes: [{ pid: survivorPid, ppid: 2147483646, createdAtMs: Date.now() }] })
    });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.code, "old_tree_unconfirmed");
    assert.equal(loadJob(root, job.id)!.generation, 0, "no new generation may start over a surviving descendant");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel is a no-op on an already-completed job (H: natural completion wins)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const job = createJobRecord({ task: "t", cwd });
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.result = { ok: true, subtype: "success", kind: "success", exitCode: 0, stopReason: "end_turn", finalText: "ok", fallbackEligible: false };
    saveJob(root, job);

    const res = await requestCancel(root, job.id, { waitMs: 0 });
    assert.equal(res.job?.status, "done");
    assert.equal(res.finalizedBy, "none");
    assert.equal(res.kill.reason, "already_terminal");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bounded-scope regression cases (no_survivors / dead-root scan / kill failure)
//
// These lock the honest semantics after the scope rework: a negative process
// snapshot is NEVER reported as an absolute whole-tree guarantee, and a failed
// kill is never force-rewritten into success by the cancel response.
// ---------------------------------------------------------------------------

/** A dead-owner, dead-root job with a recorded generation start time. */
function deadRootJob(root: string, cwd: string, deadRoot: number) {
  const job = createJobRecord({ task: "t", cwd });
  job.status = "running";
  job.owner = "jobquay-2147483647-x";
  job.ownerPid = 2147483647; // a PID that does not exist → the owner is dead
  job.heartbeatAt = new Date(Date.now() - 600000).toISOString(); // stale → reconcile fires
  job.childPid = deadRoot;
  job.childGeneration = 0;
  job.attempts = [
    { generation: 0, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: null, exitCode: null, kind: null, failureKind: null, segment: false, resumedFrom: null, model: null, modelSource: null, effort: null, rateLimited: false, switched: false, switchToModel: null, usage: emptyUsage() }
  ];
  saveJob(root, job);
  return job;
}

test("requestCancel never upgrades a dead root's empty scan into an absolute tree exit (a failed kill is not rewritten)", { skip: process.platform !== "win32" && "Requires Windows preserved-PPID dead-root scan semantics" }, async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const deadRoot = 2147483646; // a PID that does not exist
    const job = deadRootJob(root, cwd, deadRoot);

    const res = await requestCancel(root, job.id, {
      isAliveFn: () => false, // the root is provably gone
      enumerateFn: async () => ({ ok: true, processes: [] }), // the CURRENT observation finds no descendant
      execFileFn: failingExecFile, // any kill attempt fails — it must not be rewritten into success
      graceMs: 50,
      pollMs: 5,
      waitMs: 0
    });

    assert.equal(res.finalizedBy, "client");
    assert.ok(res.job);
    assert.equal(res.job.status, "cancelled", "a dead root with an empty current scope may reach cancelled");
    assert.equal(res.job.childPid, null, "the resolved tree clears the PID");
    // The response must state ONLY the bounded truth: the root exited and the
    // current observation saw no survivor — never an absolute OS tree kill.
    assert.equal(res.kill.scope, "root_exited", `the scope must stay bounded: ${JSON.stringify(res.kill)}`);
    assert.notEqual(res.kill.scope, "os_tree_exited");
    assert.notEqual(res.kill.scope, "identified_descendants_stopped");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requestCancel keeps the job non-terminal when the current process scan is unavailable (an empty visible scope is required to stop)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const deadRoot = 2147483646;
    const job = deadRootJob(root, cwd, deadRoot);

    const res = await requestCancel(root, job.id, {
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: false, processes: [], reason: "test_unavailable" }),
      graceMs: 50,
      pollMs: 5,
      waitMs: 0
    });

    assert.equal(res.finalizedBy, "none");
    assert.ok(res.job);
    assert.notEqual(res.job.status, "cancelled");
    assert.equal(isTerminalStatus(res.job.status), false, "an unknown tree must stay non-terminal");
    assert.equal(res.job.childPid, deadRoot, "the PID must be kept while the tree is unknown");
    assert.equal(res.kill.scope, "root_exited", "the raw kill proved only the root gone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "requestCancel reports identified_descendants_stopped (never an absolute tree exit) after cleaning a dead root's scoped descendant",
  { skip: process.platform === "win32" ? false : "Windows taskkill semantics" },
  async () => {
    const dir = newTmp();
    const root = path.join(dir, "root");
    const cwd = path.join(dir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    try {
      const deadRoot = 2147483646;
      const survivorPid = 987001;
      let survivorAlive = true;
      const killingExecFile = ((...args: unknown[]) => {
        survivorAlive = false; // the (simulated) kill stops the identified descendant
        const cb = args[args.length - 1] as (e: Error | null) => void;
        cb(null);
      }) as unknown as typeof execFile;
      const job = deadRootJob(root, cwd, deadRoot);

      const res = await requestCancel(root, job.id, {
        isAliveFn: (pid) => (pid === survivorPid ? survivorAlive : false),
        enumerateFn: async () => ({ ok: true, processes: [{ pid: survivorPid, ppid: deadRoot, createdAtMs: Date.now() }] }),
        execFileFn: killingExecFile,
        graceMs: 50,
        pollMs: 5,
        waitMs: 0
      });

      assert.equal(res.finalizedBy, "client");
      assert.equal(res.job?.status, "cancelled");
      assert.equal(res.job?.childPid, null);
      assert.equal(
        res.kill.scope,
        "identified_descendants_stopped",
        `a bounded cleanup scope is expected: ${JSON.stringify(res.kill)}`
      );
      assert.notEqual(res.kill.scope, "os_tree_exited");
      const rec = readTreeConfirmation(root, job.id);
      assert.ok(rec, "the bounded cleanup must be persisted as evidence");
      assert.equal(rec!.scope, "identified_descendants_stopped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// M1 batch 5: the rate-limit DOWNGRADE chain (worker, real fixture child)
//
// These drive the REAL worker against a controlled child process through the
// production stream parser / exit classifier. The fixture replaces ONLY the hard
// to produce CLI rate-limit result — it is NOT a real `cmdc` measurement. The
// candidate chain is injected through the runner seam (the fixture runner has no
// CLI catalog, so it cannot build a multi-candidate chain by itself).
// ---------------------------------------------------------------------------

/** Wrap the fixture runner with an explicit, injected candidate chain. */
function chainRunner(fixture: string, env: NodeJS.ProcessEnv, chain: ModelCandidate[]): JobRunner {
  const base = createFixtureRunner(fixture, env);
  return {
    ...base,
    async resolveChain() {
      return { ok: true, chain, explicitModel: null, code: null, error: null, diagnostics: [] };
    }
  };
}

/**
 * A CLI-shaped fixture that records each invocation (model + resume + stdin) to
 * `rl-invocations.jsonl` in its cwd.
 *
 *   * with `FIX_RESUME_OK` (the default) a `--resume` run reports success and
 *     exits 0; otherwise a resumed run ALSO exits with `FIX_EXIT`;
 *   * any non-success run exits with `FIX_EXIT` (default 5, a model rate limit);
 *   * `FIX_NO_SESSION=1` omits the session id from BOTH the event and the result
 *     (so a rate limit cannot resume the same session).
 *
 * Usage is reported on every run so a test can prove the job total is the SUM
 * over attempts.
 */
function writeRateLimitFixture(dir: string): string {
  const fixture = path.join(dir, "rate-limit-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      "const args = process.argv.slice(2);",
      'const mi = args.indexOf("--model");',
      'const model = mi >= 0 ? args[mi + 1] : null;',
      'const ri = args.indexOf("--resume");',
      'const resume = ri >= 0 ? args[ri + 1] : null;',
      'const ei = args.indexOf("--effort");',
      'const effort = ei >= 0 ? args[ei + 1] : null;',
      'const exitCode = Number(process.env.FIX_EXIT || "5");',
      'const withSession = process.env.FIX_NO_SESSION !== "1";',
      'const resumeOk = process.env.FIX_RESUME_OK !== "0";',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  const sid = "fx-rl-session";',
      '  const sess = withSession ? { session_id: sid } : {};',
      '  fs.appendFileSync(path.join(process.cwd(), "rl-invocations.jsonl"), JSON.stringify({ model, resume, effort, stdin: input }) + "\\n");',
      '  out({ type: "event", event: { type: "run_start", ...(withSession ? { sessionId: sid } : {}) } });',
      "  if (resume && resumeOk) {",
      '    out({ type: "result", subtype: "success", result: "final:" + model, ...sess, stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } });',
      "    process.exit(0);",
      "  }",
      '  out({ type: "result", subtype: "error", result: "rate limited", ...sess, stop_reason: "rate_limit", usage: { input_tokens: 10, output_tokens: 1 } });',
      "  process.exit(exitCode);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

interface Invocation {
  model: string | null;
  resume: string | null;
  effort: string | null;
  stdin: string;
}

function readInvocations(cwd: string): Invocation[] {
  const file = path.join(cwd, "rl-invocations.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Invocation);
}

const TWO_CANDIDATES: ModelCandidate[] = [
  { model: "m/a", source: "slot", effort: "high" },
  { model: "m/b", source: "config-default", effort: "medium" }
];

test("a clear model rate limit (exit 5) downgrades to the next candidate on the SAME session with the recovery prompt", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    const job = createJobRecord({ task: "do the thing", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => chainRunner(fixture, ctx.env, TWO_CANDIDATES),
      isAliveFn: () => false, // the real fixture root has exited
      enumerateFn: async () => ({ ok: true, processes: [] }) // no descendants
    });
    assert.equal(res.status, "done");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.generation, 1);
    assert.deepEqual(reloaded.modelChain, ["m/a", "m/b"]);
    assert.equal(reloaded.model, "m/b");
    assert.equal(reloaded.modelSource, "config-default");
    assert.equal(reloaded.promptKind, "recovery");
    assert.equal(reloaded.result?.ok, true);
    assert.equal(reloaded.attempts.length, 2);
    assert.equal(reloaded.attempts[0]?.model, "m/a");
    assert.equal(reloaded.attempts[0]?.modelSource, "slot");
    assert.equal(reloaded.attempts[0]?.rateLimited, true);
    assert.equal(reloaded.attempts[0]?.resumedFrom, null);
    assert.equal(reloaded.attempts[1]?.model, "m/b");
    assert.equal(reloaded.attempts[1]?.modelSource, "config-default");
    assert.equal(reloaded.attempts[1]?.rateLimited, false);
    assert.equal(reloaded.attempts[1]?.resumedFrom, "fx-rl-session", "the SAME session must be resumed");
    // Each candidate carries its OWN effort: the accepted plan is frozen on the
    // record and the per-attempt effort is what actually ran.
    assert.equal(reloaded.attempts[0]?.effort, "high", "the primary runs at its own accepted effort");
    assert.equal(reloaded.attempts[1]?.effort, "medium", "the fallback candidate runs at ITS OWN effort, not the primary's");
    assert.deepEqual(
      reloaded.modelChainPlan.map((p) => [p.model, p.source, p.effort]),
      [
        ["m/a", "slot", "high"],
        ["m/b", "config-default", "medium"]
      ],
      "the accepted {model, source, effort} plan is frozen on the durable record"
    );
    assert.equal(reloaded.childPid, null, "a proven-stopped tree clears the PID");
    // Usage is the SUM over attempts; a metric no attempt reported stays null.
    assert.equal(reloaded.usage.tokensIn, 15);
    assert.equal(reloaded.usage.tokensOut, 3);
    assert.equal(reloaded.usage.cacheRead, null, "an unreported metric is never a fabricated 0");

    // On the wire: attempt 1 got the task with m/a; the downgraded attempt got
    // the fixed internal recovery prompt (NEVER the task) with m/b.
    const inv = readInvocations(cwd);
    assert.equal(inv.length, 2, "each candidate must be called at most once");
    assert.equal(inv[0]?.model, "m/a");
    assert.equal(inv[0]?.resume, null);
    assert.equal(inv[0]?.effort, "high");
    assert.equal(inv[0]?.stdin, "do the thing");
    assert.equal(inv[1]?.model, "m/b");
    assert.equal(inv[1]?.resume, "fx-rl-session");
    assert.equal(inv[1]?.effort, "medium", "the fallback candidate's OWN effort reaches the CLI");
    assert.equal(inv[1]?.stdin, RECOVERY_PROMPT, "the resumed attempt must NOT re-send the full task");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a job's accepted {model, effort} plan is frozen at dispatch: a later Settings edit cannot change a resumed generation", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    // The plan ACCEPTED when the job first dispatched.
    const job = createJobRecord({ task: "do the thing", cwd });
    job.modelChainPlan = [
      { model: "m/frozen-a", source: "config-default", effort: "high" },
      { model: "m/frozen-b", source: "rate-limit-fallback", effort: "low" }
    ];
    job.model = "m/frozen-a";
    job.modelSource = "config-default";
    job.effort = "high";
    saveJob(root, job);

    // The CURRENT settings now name a DIFFERENT chain with different efforts.
    const editedChain: ModelCandidate[] = [
      { model: "m/edited-a", source: "config-default", effort: "max" },
      { model: "m/edited-b", source: "rate-limit-fallback", effort: "medium" }
    ];
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => chainRunner(fixture, ctx.env, editedChain),
      isAliveFn: () => false, // the real fixture root has exited
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "done");
    const reloaded = loadJob(root, job.id)!;
    // The resumed generation used the FROZEN plan, not the edited settings.
    assert.deepEqual(reloaded.modelChain, ["m/frozen-a", "m/frozen-b"]);
    assert.equal(reloaded.model, "m/frozen-b");
    assert.deepEqual(
      reloaded.modelChainPlan.map((p) => [p.model, p.source, p.effort]),
      [
        ["m/frozen-a", "config-default", "high"],
        ["m/frozen-b", "rate-limit-fallback", "low"]
      ],
      "the accepted plan is preserved across the resume, untouched by the later Settings edit"
    );
    const inv = readInvocations(cwd);
    assert.equal(inv.length, 2, "the frozen plan's two candidates each ran exactly once");
    assert.equal(inv[0]?.model, "m/frozen-a");
    assert.equal(inv[0]?.effort, "high");
    assert.equal(inv[1]?.model, "m/frozen-b");
    assert.equal(inv[1]?.effort, "low", "the FROZEN fallback effort reaches the CLI, never the edited one");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only exit 5 downgrades: auth (3), permission (4), credits (10), network (6) and unknown never advance the chain", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    for (const code of [3, 4, 10, 6, 99]) {
      const job = createJobRecord({ task: "t", cwd });
      saveJob(root, job);
      const res = await runWorker({ platform: "win32",
        root,
        jobId: job.id,
        createRunner: async (ctx) => chainRunner(fixture, { ...ctx.env, FIX_EXIT: String(code) }, TWO_CANDIDATES),
        isAliveFn: () => false,
        enumerateFn: async () => ({ ok: true, processes: [] })
      });
      assert.equal(res.status, "error", `exit ${code} must be terminal`);
      const reloaded = loadJob(root, job.id)!;
      assert.equal(reloaded.status, "error");
      assert.equal(reloaded.generation, 0, `exit ${code} must NOT start a new generation`);
      assert.equal(reloaded.attempts.length, 1);
      assert.equal(reloaded.attempts[0]?.rateLimited, false);
      assert.equal(reloaded.model, "m/a", `exit ${code} must keep the primary`);
      const inv = readInvocations(cwd);
      assert.equal(inv.length, 1, `exit ${code} must call the CLI exactly once`);
      assert.equal(inv[0]?.model, "m/a");
      assert.equal(
        inv.some((x) => x.model === "m/b"),
        false,
        `exit ${code} must never dispatch the downgrade candidate`
      );
      // Clear the invocation log so the next iteration starts fresh.
      fs.rmSync(path.join(cwd, "rl-invocations.jsonl"), { force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate limit with NO usable session id ends honestly (never a context-less second session)", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => chainRunner(fixture, { ...ctx.env, FIX_NO_SESSION: "1" }, TWO_CANDIDATES),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.stopReason, "rate_limit_without_session");
    assert.equal(reloaded.failureKind, "rate_limit_without_session");
    assert.equal(reloaded.generation, 0, "no new generation may start without a session");
    assert.equal(reloaded.attempts.length, 1);
    assert.equal(readInvocations(cwd).length, 1, "the next candidate must never be called without a session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an exhausted chain ends with a clear terminal error naming the candidates tried", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    // FIX_EXIT=5 and the fixture NEVER succeeds on resume → every candidate is
    // rate limited. Each candidate runs at most once, then the chain is done.
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => chainRunner(fixture, { ...ctx.env, FIX_EXIT: "5", FIX_RESUME_OK: "0" }, TWO_CANDIDATES),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.stopReason, "rate_limit_fallback_exhausted");
    assert.equal(reloaded.generation, 1, "the chain advanced once, then stopped");
    assert.equal(reloaded.attempts.length, 2);
    assert.equal(reloaded.attempts.every((a) => a.rateLimited), true);
    assert.match(String(reloaded.error), /downgrade candidates are exhausted: tried .+ in order/);
    assert.equal(readInvocations(cwd).length, 2, "no candidate is retried / no loop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate limit with an UNPROVEN old tree holds orphaned and never starts the next candidate", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeRateLimitFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => chainRunner(fixture, ctx.env, TWO_CANDIDATES),
      isAliveFn: () => true, // the closed root is (claimed) still alive
      isProcessGroupAliveFn: () => true,
      execFileFn: failingExecFile, // and its kill cannot be confirmed
      graceMs: 50,
      delayFn: async () => undefined,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "orphaned");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "orphaned");
    assert.equal(reloaded.stopReason, "old_tree_alive");
    assert.equal(reloaded.finishedAt, null, "orphaned is not a finished job");
    assert.ok(reloaded.childPid, "the child PID must be kept as evidence");
    assert.equal(reloaded.generation, 0, "no new generation may start over an unproven tree");
    assert.equal(reloaded.attempts.length, 1);
    assert.equal(readInvocations(cwd).length, 1, "the next candidate must NOT be started over a live tree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-10: generic non-zero exit diagnostics keep the CLI's stderr
//
// `spawnAndStream` always captured a bounded stderr tail; the generic
// `decideOutcome` path used to discard it, so an actionable CLI message
// collapsed to `exit 1 (unknown)`. These drive the REAL worker through the
// production parser / exit classifier against a controlled child.
// ---------------------------------------------------------------------------

/**
 * A CLI-shaped fixture that writes controlled stderr, optionally publishes a
 * structured result record, and exits with `FIX_EXIT` (default 1):
 *
 *   * `FIX_STDERR` — text written verbatim to stderr;
 *   * `FIX_STDERR_CONTROL_ONLY=1` — stderr that normalizes to nothing useful;
 *   * `FIX_STDERR_NOISE=1` — a long noisy stderr tail ending in one actionable
 *     marker line;
 *   * `FIX_RESULT_ERROR` — a structured provider error message on stdout;
 *   * `FIX_RESULT_SUBTYPE` — a terminal result whose subtype is the given
 *     non-success value and whose provider stop reason is the same value, with
 *     NO `error` object (so no structured provider message exists);
 *   * `FIX_SUCCESS=1` — a terminal success result.
 *
 * The exit code is set through `process.exitCode` (not `process.exit`), so the
 * large noisy write is fully flushed before the process ends.
 */
function writeExitDiagnosticsFixture(dir: string): string {
  const fixture = path.join(dir, "exit-diagnostics-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      'const exitCode = Number(process.env.FIX_EXIT || "1");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      '  if (process.env.FIX_STDERR) process.stderr.write(process.env.FIX_STDERR);',
      '  if (process.env.FIX_STDERR_CONTROL_ONLY === "1") process.stderr.write("\\u0000\\u0001\\r\\n\\t \\u0007\\r\\n");',
      '  if (process.env.FIX_STDERR_NOISE === "1") {',
      '    for (let i = 0; i < 500; i += 1) process.stderr.write("noise-" + i + "\\t" + "x".repeat(60) + "\\r\\n");',
      '    process.stderr.write("FINAL: provider rejected the request: disk quota exceeded\\n");',
      '  }',
      '  if (process.env.FIX_SUCCESS === "1") {',
      '    out({ type: "result", subtype: "success", result: "final: ok", session_id: "fx-exit-session", stop_reason: "end_turn" });',
      '  } else if (process.env.FIX_RESULT_ERROR) {',
      '    out({ type: "result", subtype: "error", result: "failed", error: { message: process.env.FIX_RESULT_ERROR }, session_id: "fx-exit-session", stop_reason: "error" });',
      '  } else if (process.env.FIX_RESULT_SUBTYPE) {',
      '    out({ type: "result", subtype: process.env.FIX_RESULT_SUBTYPE, result: null, is_error: false, session_id: "fx-exit-session", stop_reason: process.env.FIX_RESULT_SUBTYPE });',
      '  }',
      '  process.exitCode = exitCode;',
      '});'
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

test("a generic non-zero exit (1) persists a bounded, normalized stderr diagnostic", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, {
          ...ctx.env,
          FIX_STDERR: 'could not parse args\r\nError: Unknown effort "xhigh". Supported: low, high, max.\r\n'
        }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "error");
    assert.equal(reloaded.stopReason, "cli_nonzero");
    assert.equal(reloaded.failureKind, "unknown");
    assert.equal(reloaded.generation, 0, "a generic exit-1 failure must never start a new generation");
    assert.equal(reloaded.attempts.length, 1);
    assert.equal(reloaded.result?.ok, false);
    const error = String(reloaded.error);
    assert.match(error, /exited with code 1 \(unknown\)/);
    assert.ok(
      error.includes('Unknown effort "xhigh". Supported: low, high, max.'),
      `the actionable CLI stderr message must survive: ${error}`
    );
    assert.equal(/[\r\n\u0000-\u001f\u007f]/.test(error), false, "the durable error must be ONE normalized line");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a structured provider error outranks stderr on a generic non-zero exit", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, {
          ...ctx.env,
          FIX_EXIT: "1",
          FIX_RESULT_ERROR: "structured provider failure",
          FIX_STDERR: "noisy stderr that must NOT win"
        }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "error");
    assert.equal(reloaded.error, "structured provider failure", "the structured provider error is authoritative");
    assert.equal(String(reloaded.error).includes("must NOT win"), false, "stderr never overrides a structured error");
    assert.equal(reloaded.result?.fallbackEligible, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fatal auth (3) / permission (4) classifications stay authoritative over stderr", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const cases = [
      { code: "3", kind: "auth", stopReason: "cli_auth_error", structured: "invalid api key" },
      { code: "4", kind: "permission", stopReason: "cli_permission_error", structured: null }
    ] as const;
    for (const c of cases) {
      const job = createJobRecord({ task: "t", cwd });
      saveJob(root, job);
      const res = await runWorker({ platform: "win32",
        root,
        jobId: job.id,
        createRunner: async (ctx) =>
          createFixtureRunner(fixture, {
            ...ctx.env,
            FIX_EXIT: c.code,
            FIX_STDERR: "stderr noise that must never replace the classification",
            ...(c.structured ? { FIX_RESULT_ERROR: c.structured } : {})
          }),
        isAliveFn: () => false,
        enumerateFn: async () => ({ ok: true, processes: [] })
      });
      assert.equal(res.status, "error", `exit ${c.code} must be terminal`);
      const reloaded = loadJob(root, job.id)!;
      assert.equal(reloaded.generation, 0, `exit ${c.code} must never advance a chain`);
      assert.equal(reloaded.attempts.length, 1);
      assert.equal(reloaded.result?.kind, c.kind);
      assert.equal(reloaded.result?.fallbackEligible, false);
      assert.equal(reloaded.stopReason, c.stopReason);
      assert.equal(reloaded.error, c.structured ?? c.stopReason, `fatal ${c.kind} keeps its stable code/message`);
      assert.equal(String(reloaded.error).includes("stderr noise"), false, "stderr never replaces a fatal classification");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or unusable stderr keeps the plain generic exit fallback", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    for (const extra of [{}, { FIX_STDERR_CONTROL_ONLY: "1" }]) {
      const job = createJobRecord({ task: "t", cwd });
      saveJob(root, job);
      const res = await runWorker({ platform: "win32",
        root,
        jobId: job.id,
        createRunner: async (ctx) => createFixtureRunner(fixture, { ...ctx.env, ...extra }),
        isAliveFn: () => false,
        enumerateFn: async () => ({ ok: true, processes: [] })
      });
      assert.equal(res.status, "error");
      const reloaded = loadJob(root, job.id)!;
      assert.equal(
        reloaded.error,
        "Command Code exited with code 1 (unknown).",
        `no useful stderr must keep the existing generic fallback (${JSON.stringify(extra)})`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a very long noisy stderr is normalized to one bounded line", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, { ...ctx.env, FIX_STDERR_NOISE: "1" }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const error = String(loadJob(root, job.id)!.error);
    assert.ok(error.includes("FINAL: provider rejected the request: disk quota exceeded"), `the terminal stderr line must survive: ${error.length} chars`);
    assert.equal(error.includes("noise-0"), false, "the kept slice is the TAIL, not the beginning");
    assert.equal(/[\r\n\u0000-\u001f\u007f]/.test(error), false, "control characters/newlines are normalized away");
    assert.ok(error.length <= 1000, `the persisted diagnostic must stay compact, got ${error.length} chars`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful exit never carries stderr into the durable result", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, {
          ...ctx.env,
          FIX_EXIT: "0",
          FIX_SUCCESS: "1",
          FIX_STDERR: "warning: deprecated flag used\n"
        }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "done");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.error, null, "a successful job carries no stderr diagnostic");
    assert.equal(reloaded.result?.ok, true);
    assert.equal(reloaded.result?.finalText, "final: ok");
    assert.equal(JSON.stringify(reloaded.result).includes("deprecated"), false, "stderr never enters a successful result");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-15: a process exit 0 is not proof of a successful task
//
// A provider can report refusal/cancel/error in its terminal record while the
// process itself exits 0. The durable outcome keeps whatever the classification
// and provider semantics say, but the human-readable fallback phrase must never
// name the exit-0 classification (`success`) as the outcome.
// ---------------------------------------------------------------------------

test("an exit-0 terminal refusal keeps its provider semantics and never claims exit 0 success", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, { ...ctx.env, FIX_EXIT: "0", FIX_RESULT_SUBTYPE: "refusal" }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error", "a provider refusal is terminal even when the process exits 0");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "error");
    // The exit-code CLASSIFICATION itself is untouched: exit 0 still classifies
    // as `success`; only the human-readable phrase must not claim the outcome.
    assert.equal(reloaded.result?.kind, "success");
    assert.equal(reloaded.result?.ok, false);
    assert.equal(reloaded.failureKind, "refusal");
    assert.equal(reloaded.stopReason, "refusal");
    assert.equal(reloaded.result?.subtype, "refusal");
    assert.equal(reloaded.result?.fallbackEligible, false);
    assert.equal(reloaded.generation, 0, "an exit-0 refusal must never start a new generation");
    assert.equal(reloaded.attempts.length, 1);
    const error = String(reloaded.error);
    assert.equal(/success/i.test(error), false, `the durable error must never claim success: ${error}`);
    assert.ok(error.includes("refusal"), `the provider stop reason must survive in the message: ${error}`);
    assert.match(error, /exited with code 0 \(refusal\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an exit 0 with no terminal success evidence keeps an explicit non-success label", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, { ...ctx.env, FIX_EXIT: "0" }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error", "exit 0 without a terminal success record is not a completed job");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "error");
    const error = String(reloaded.error);
    // The fallback must not name the exit-0 classification (`success`) — the
    // honest `no_success_result` label may still contain the substring, so the
    // check is on the misleading phrase itself.
    assert.equal(error.includes("（success）"), false, `a no-evidence exit 0 must not claim success: ${error}`);
    assert.equal(/exit 0 \(success\)/i.test(error), false, `no misleading phrase: ${error}`);
    assert.match(error, /exited with code 0 \(no_success_result\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuine exit-0 success keeps the unchanged successful outcome", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, { ...ctx.env, FIX_EXIT: "0", FIX_SUCCESS: "1" }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "done");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.error, null);
    assert.equal(reloaded.failureKind, null);
    assert.equal(reloaded.stopReason, "end_turn");
    assert.equal(reloaded.result?.ok, true);
    assert.equal(reloaded.result?.kind, "success");
    assert.equal(reloaded.result?.subtype, "success");
    assert.equal(reloaded.attempts.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-16: ANSI CSI/SGR sequences in stderr never leave residue
// ---------------------------------------------------------------------------

test("ANSI SGR sequences in stderr are stripped while the text survives", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, {
          ...ctx.env,
          FIX_EXIT: "1",
          FIX_STDERR: "\u001b[31mError: provider rejected the request\u001b[0m\r\n"
        }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const error = String(loadJob(root, job.id)!.error);
    assert.ok(error.includes("Error: provider rejected the request"), `the text must survive: ${error}`);
    assert.equal(error.includes("[31m"), false, `no SGR start residue: ${error}`);
    assert.equal(error.includes("[0m"), false, `no SGR reset residue: ${error}`);
    assert.equal(error.includes("\u001b"), false, `no escape byte survives: ${error}`);
    assert.equal(/[\r\n\u0000-\u001f\u007f]/.test(error), false, "the durable error must be ONE normalized line");
    assert.match(error, /exited with code 1 \(unknown\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ANSI-only stderr leaves no residue and keeps the plain fallback", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, { ...ctx.env, FIX_EXIT: "1", FIX_STDERR: "\u001b[31m\u001b[0m\r\n" }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    assert.equal(
      loadJob(root, job.id)!.error,
      "Command Code exited with code 1 (unknown).",
      "stderr that normalizes to nothing useful keeps the plain fallback"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary bracketed stderr text is not over-stripped", async () => {
  const dir = newTmp();
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeExitDiagnosticsFixture(dir);
  try {
    const job = createJobRecord({ task: "t", cwd });
    saveJob(root, job);
    const res = await runWorker({ platform: "win32",
      root,
      jobId: job.id,
      createRunner: async (ctx) =>
        createFixtureRunner(fixture, {
          ...ctx.env,
          FIX_EXIT: "1",
          FIX_STDERR: "warning: log marker [31m and [0m are literal text here"
        }),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(res.status, "error");
    const error = String(loadJob(root, job.id)!.error);
    assert.ok(error.includes("[31m and [0m are literal text here"), `literal bracketed text must survive: ${error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});