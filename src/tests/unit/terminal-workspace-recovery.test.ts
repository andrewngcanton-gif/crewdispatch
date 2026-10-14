// terminal-workspace-recovery.test.ts — JQ-20261004-50 unit coverage for the
// shared PASSIVE recovery of a TERMINAL workspace holder whose retained managed
// child tree has genuinely exited.
//
// The production gap: a terminal record that kept `childPid`/`childGeneration`
// as evidence (the tree could not be proven stopped at finalize time) held its
// exact workspace forever, because reconciliation skips terminal jobs and only
// a continuation of that SAME job re-checked the tree. An independent new
// dispatch was refused `workspace_busy` indefinitely.
//
// `recoverTerminalHolders` is the bounded, non-destructive shared revalidation:
// boot proof first, then a bounded descendant snapshot. These tests pin the
// decision table with INDEPENDENT expected outcomes (the OS probes are real or
// explicitly injected; expected results are never read back from the
// implementation's own evidence):
//   * confirmed gone -> release (evidence persisted, record bytes untouched);
//   * live / unknown root -> block;
//   * dead root with a live scoped descendant -> block (descendant untouched);
//   * scan failure / unsupported enumeration / unknown identity -> block;
//   * PID reuse -> a boot-proven old tree releases without touching the current
//     unrelated process holding the old PID;
//   * wrong/new generation and a continuation race -> late evidence never
//     releases;
//   * repeated recovery is idempotent (no extra probe, no rewrite);
//   * a malformed / fabricated evidence file is never a release.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createJobRecord, prepareContinuation, type ContinuationInput } from "../../jobs/service";
import { appendUserMessageOrThrow } from "../../jobs/messages";
import { recoverOrphanedAfterBoot, recoverTerminalHolders as recoverTerminalHoldersImpl, type TerminalHolderRecoveryOptions } from "../../jobs/reconcile";
import {
  acquireWorkspace,
  canonicalWorkspacePath,
  workspaceBusyMessage
} from "../../jobs/workspace";
import {
  isTreeRecoveryConfirmed,
  jobPath,
  loadJob,
  readTreeConfirmation,
  readTreeRecovery,
  saveJob,
  treeRecoveryPath,
  writeTreeConfirmation
} from "../../jobs/store";
import { emptyUsage, type JobAttempt, type JobRecord } from "../../jobs/types";
import { captureProcessIdentity, isPidAlive, type BootTimeReading, type ProcessScan } from "../../runtime/process";

function newRoot(): { dir: string; root: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-terminal-recovery-"));
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd, { recursive: true });
  return { dir, root, cwd };
}

/** A PID that is provably gone: a real child that already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

/** An OWNED harmless sleeping child; the spawning test must stop it. */
function liveSleepingChild(): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  let killed = false;
  return {
    pid,
    stop: () => {
      if (!killed) {
        killed = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      return exited;
    }
  };
}

function attemptFor(generation: number, startedAtMs: number): JobAttempt {
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

/** A TERMINAL holder that retained an unresolved managed child tree. */
function terminalHolder(
  root: string,
  cwd: string,
  input: {
    childPid: number;
    childGeneration?: number;
    generation?: number;
    startedAtMs: number;
    /** Additional attempt starts of the SAME generation (worker restarts). */
    extraAttemptStartsMs?: number[];
    finishedAtMs?: number;
  }
): JobRecord {
  const job = createJobRecord({ task: "RECOVERY_UNIT_TASK", cwd });
  const generation = input.generation ?? 0;
  job.generation = generation;
  job.status = "done";
  job.finishedAt = new Date(input.finishedAtMs ?? Date.now()).toISOString();
  job.childPid = input.childPid;
  job.childGeneration = input.childGeneration ?? generation;
  job.attempts = [input.startedAtMs, ...(input.extraAttemptStartsMs ?? [])].map((ms) => attemptFor(generation, ms));
  saveJob(root, job);
  return job;
}

const NO_BOOT = (): Promise<BootTimeReading> => Promise.resolve({ ok: false, bootTimeMs: null, reason: "unsupported_platform" });
const bootAt = (ms: number) => (): Promise<BootTimeReading> => Promise.resolve({ ok: true, bootTimeMs: ms, reason: null });

// Historical terminal-holder tests below pin the Windows preserved-PPID model.
// Darwin has a stricter dead-root rule and gets dedicated coverage below.
function recoverTerminalHolders(root: string, opts: TerminalHolderRecoveryOptions = {}) {
  return recoverTerminalHoldersImpl(root, { platform: "win32", ...opts });
}

/** A process table that contains none of `rootPid`'s descendants. */
function emptyScan(): Promise<ProcessScan> {
  return Promise.resolve({ ok: true, processes: [{ pid: process.pid, ppid: 999_999_999, createdAtMs: Date.now() }] });
}

function recordBytes(root: string, id: string): string {
  return fs.readFileSync(jobPath(root, id), "utf8");
}

/** Write a (possibly malformed/fabricated) recovery evidence file verbatim. */
function writeEvidenceFile(root: string, id: string, rec: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "tree"), { recursive: true });
  fs.writeFileSync(treeRecoveryPath(root, id), JSON.stringify(rec), "utf8");
}

/** A worker spawn stand-in that starts no process. */
const noopSpawn = (() => ({ pid: 999_999, unref() {} })) as unknown as typeof spawn;

/**
 * An injected kill boundary: it records every invocation and never runs a real
 * kill executor. `throw` makes `runTaskkill` resolve a failure, so the
 * production fallback decides the rest — used only against test-owned children.
 */
function recordingExecFile(): { calls: { n: number }; fn: NonNullable<ContinuationInput["execFileFn"]> } {
  const calls = { n: 0 };
  const fn = (() => {
    calls.n += 1;
    throw new Error("injected kill boundary: no real executor");
  }) as unknown as NonNullable<ContinuationInput["execFileFn"]>;
  return { calls, fn };
}

test("reboot proof settles a Darwin-style orphaned managed tree without touching a reused live PID", async () => {
  const { dir, root, cwd } = newRoot();
  const reused = liveSleepingChild();
  try {
    const startedAtMs = Date.now() - 3_600_000;
    const job = createJobRecord({ task: "ORPHANED_BEFORE_REBOOT", cwd });
    job.status = "orphaned";
    job.stopReason = "owner_lost_child_unconfirmed";
    job.failureKind = "owner_lost_child_unconfirmed";
    job.error = "old tree was unconfirmed";
    job.finishedAt = null;
    job.childPid = reused.pid;
    job.childGeneration = 0;
    job.attempts = [attemptFor(0, startedAtMs)];
    saveJob(root, job);

    const report = await recoverOrphanedAfterBoot(root, {
      by: "unit-reboot",
      readBootTimeFn: bootAt(startedAtMs + 60_000)
    });

    assert.equal(report.candidates, 1);
    assert.equal(report.changed.length, 1, JSON.stringify(report));
    const next = loadJob(root, job.id)!;
    assert.equal(next.status, "interrupted");
    assert.equal(next.stopReason, "owner_lost");
    assert.equal(next.childPid, null);
    assert.equal(next.childGeneration, null);
    assert.equal(isPidAlive(reused.pid), true, "the current process reusing the historical PID is never signalled");
    assert.equal(readTreeRecovery(root, job.id)?.method, "boot_session_cleared");
  } finally {
    await reused.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphaned reboot recovery fails closed when the boot does not postdate the latest attempt", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const startedAtMs = Date.now() - 60_000;
    const job = createJobRecord({ task: "ORPHANED_SAME_BOOT", cwd });
    job.status = "orphaned";
    job.childPid = 2_146_000_001;
    job.childGeneration = 0;
    job.attempts = [attemptFor(0, startedAtMs)];
    saveJob(root, job);

    const report = await recoverOrphanedAfterBoot(root, {
      by: "unit-reboot",
      readBootTimeFn: bootAt(startedAtMs - 1_000)
    });

    assert.equal(report.changed.length, 0);
    assert.equal(report.blocked[0]?.reason, "boot_not_after_generation");
    assert.equal(loadJob(root, job.id)?.status, "orphaned");
    assert.equal(loadJob(root, job.id)?.childPid, job.childPid);
    assert.equal(readTreeRecovery(root, job.id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal holder with a provably gone root and no scoped descendants releases through validated recovery, leaving the record byte-identical", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs });
    const before = recordBytes(root, job.id);

    // The sync guard blocks BEFORE recovery (a dead root alone is never proof).
    const blocked = acquireWorkspace({ root, cwd });
    assert.equal(blocked.ok, false, "a dead root without evidence must still hold the workspace");
    if (!blocked.ok) assert.equal(blocked.holder?.retainedChildPid, pid);

    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.candidates, 1);
    assert.equal(report.released.length, 1, `expected a release, got ${JSON.stringify(report)}`);
    assert.equal(report.released[0]!.jobId, job.id);
    assert.equal(report.released[0]!.method, "descendant_snapshot");
    assert.equal(report.blocked.length, 0);

    const evidence = readTreeRecovery(root, job.id);
    assert.ok(evidence, "validated evidence is persisted in shared storage");
    assert.equal(evidence!.generation, 0);
    assert.equal(evidence!.childPid, pid);
    assert.equal(evidence!.method, "descendant_snapshot");

    // The record itself is preserved: status, result and retained evidence.
    assert.equal(recordBytes(root, job.id), before, "recovery must not rewrite the terminal record");
    const reloaded = loadJob(root, job.id)!;
    assert.equal(reloaded.status, "done");
    assert.equal(reloaded.childPid, pid, "the retained PID evidence is kept");
    assert.equal(reloaded.generation, 0);

    // The SAME sync admission check now releases, with no extra side effects.
    const released = acquireWorkspace({ root, cwd });
    assert.equal(released.ok, true, "validated recovery evidence releases the workspace");
    if (released.ok) released.release();
    assert.equal(fs.existsSync(path.join(root, "terminal", `${job.id}.gen-0.json`)), false, "recovery writes no terminal snapshot");
    assert.equal(fs.existsSync(path.join(root, "notify")), false, "recovery writes no notification file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live retained root blocks, names itself in the refusal, and is never killed by recovery", async () => {
  const { dir, root, cwd } = newRoot();
  const child = liveSleepingChild();
  try {
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: child.pid, startedAtMs });
    const before = recordBytes(root, job.id);

    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.candidates, 1);
    assert.equal(report.released.length, 0);
    assert.equal(report.blocked.length, 1);
    assert.equal(report.blocked[0]!.reason, "child_alive");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false, "no evidence for a live tree");

    assert.equal(isPidAlive(child.pid), true, "recovery must never kill the live owned child");
    assert.equal(recordBytes(root, job.id), before, "a blocked recovery writes nothing");

    const refused = acquireWorkspace({ root, cwd });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      const message = workspaceBusyMessage(refused.holder, refused.canonicalCwd);
      assert.ok(message.includes(job.id), "the refusal names the holder");
      assert.ok(message.includes(String(child.pid)), "the refusal names the retained child");
    }
  } finally {
    await child.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown root liveness blocks (never a benefit of the doubt)", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      isChildAliveFn: () => null,
      enumerateFn: emptyScan
    });
    assert.equal(report.blocked.length, 1);
    assert.equal(report.blocked[0]!.reason, "child_liveness_unknown");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead root with a live scoped descendant blocks, and the descendant is never touched", async () => {
  const { dir, root, cwd } = newRoot();
  const descendant = liveSleepingChild();
  try {
    const rootPid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: rootPid, startedAtMs });
    const before = recordBytes(root, job.id);

    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () =>
        Promise.resolve({
          ok: true,
          processes: [{ pid: descendant.pid, ppid: rootPid, createdAtMs: startedAtMs + 1000 }]
        })
    });
    assert.equal(report.released.length, 0);
    assert.equal(report.blocked[0]!.reason, "descendants_alive");
    assert.equal(isPidAlive(descendant.pid), true, "the live descendant is never signalled");
    assert.equal(recordBytes(root, job.id), before);
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    await descendant.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed / unsupported / thrown enumeration blocks (fail closed)", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });

    const unsupported = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => Promise.resolve({ ok: false, processes: [], reason: "unsupported_platform" })
    });
    assert.equal(unsupported.blocked[0]!.reason, "unsupported_platform");

    const failed = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => Promise.resolve({ ok: false, processes: [], reason: "enumeration_failed: boom" })
    });
    assert.equal(failed.blocked[0]!.reason, "enumeration_failed: boom");

    const thrown = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => Promise.reject(new Error("scan exploded"))
    });
    assert.match(thrown.blocked[0]!.reason ?? "", /enumeration_failed/);

    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false, "a failed scan never releases");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unidentifiable descendant (unknown creation time) blocks", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => Promise.resolve({ ok: true, processes: [{ pid: 4242, ppid: pid, createdAtMs: null }] })
    });
    assert.equal(report.blocked[0]!.reason, "descendant_identity_unknown");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing generation start blocks: a descendant scope that cannot be established is never assumed", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = createJobRecord({ task: "RECOVERY_UNIT_TASK", cwd });
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.childPid = pid;
    job.childGeneration = job.generation;
    // No attempts → no generation start time.
    saveJob(root, job);
    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.blocked[0]!.reason, "no_generation_start");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Darwin dead-root terminal recovery refuses a negative descendant snapshot without reboot proof", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    let enumerations = 0;
    const report = await recoverTerminalHoldersImpl(root, {
      platform: "darwin",
      by: "unit-darwin",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => {
        enumerations += 1;
        return emptyScan();
      }
    });
    assert.equal(report.released.length, 0);
    assert.equal(report.blocked[0]!.reason, "darwin_dead_root_unconfirmed");
    assert.equal(enumerations, 0, "Darwin never trusts a dead-root negative PPID snapshot");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PID reuse: a boot proof releases an old tree even when the old PID is now an unrelated live process, and that process is never touched", async () => {
  const { dir, root, cwd } = newRoot();
  const reused = liveSleepingChild();
  try {
    const startedAtMs = Date.now() - 3_600_000;
    const finishedAtMs = Date.now() - 3_500_000;
    const job = terminalHolder(root, cwd, { childPid: reused.pid, startedAtMs, finishedAtMs });
    let enumerations = 0;

    const report = await recoverTerminalHolders(root, {
      by: "unit",
      // The current boot is AFTER the generation's latest attempt start: the
      // recorded tree cannot exist, so the live process holding the old PID is
      // a DIFFERENT incarnation (never ours, never signalled).
      readBootTimeFn: bootAt(finishedAtMs + 60_000),
      enumerateFn: () => {
        enumerations += 1;
        return emptyScan();
      }
    });
    assert.equal(report.released.length, 1, `boot proof must release: ${JSON.stringify(report)}`);
    assert.equal(report.released[0]!.method, "boot_session_cleared");
    assert.equal(enumerations, 0, "a boot proof needs no process enumeration");
    assert.equal(isPidAlive(reused.pid), true, "the unrelated current process is never signalled");
    const evidence = readTreeRecovery(root, job.id);
    assert.equal(evidence!.bootAtMs, finishedAtMs + 60_000);

    // The SAME fixture without a valid boot reading blocks on the live PID.
    const second = newRoot();
    try {
      const job2 = terminalHolder(second.root, second.cwd, { childPid: reused.pid, startedAtMs, finishedAtMs });
      const blocked = await recoverTerminalHolders(second.root, {
        by: "unit",
        readBootTimeFn: bootAt(startedAtMs - 60_000),
        enumerateFn: emptyScan
      });
      assert.equal(blocked.released.length, 0);
      assert.equal(blocked.blocked[0]!.reason, "child_alive");
      assert.equal(fs.existsSync(treeRecoveryPath(second.root, job2.id)), false);
      assert.equal(isPidAlive(reused.pid), true);
    } finally {
      fs.rmSync(second.dir, { recursive: true, force: true });
    }
  } finally {
    await reused.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy stopped confirmation does not hide PID reuse: the boot proof still recovers and the unrelated live process is never touched", async () => {
  const { dir, root, cwd } = newRoot();
  const reused = liveSleepingChild();
  try {
    const startedAtMs = Date.now() - 3_600_000;
    const job = terminalHolder(root, cwd, { childPid: reused.pid, startedAtMs, finishedAtMs: startedAtMs + 60_000 });
    // A perfectly valid old stopped confirmation, written when the tree exited.
    writeTreeConfirmation(root, job.id, job.childGeneration ?? job.generation, reused.pid, "os_tree_exited", "unit");
    const before = recordBytes(root, job.id);

    // Without independent proof the live reused PID still blocks: a
    // confirmation alone is never "this live process is stopped".
    const noProof = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(startedAtMs - 1000),
      enumerateFn: emptyScan
    });
    assert.equal(noProof.released.length, 0, `a confirmation alone must not release a live PID: ${JSON.stringify(noProof)}`);
    assert.equal(noProof.blocked[0]!.reason, "child_alive");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false, "the legacy confirmation alone does not release the live reused PID");

    // The independent boot proof (postdating the generation start) IS the
    // release — and it leaves the unrelated current process alone.
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(Date.now() - 60_000),
      enumerateFn: emptyScan
    });
    assert.equal(report.candidates, 1, "a legacy-confirmed holder is still revalidated");
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(report.released[0]!.method, "boot_session_cleared");
    assert.equal(isPidAlive(reused.pid), true, "the unrelated current process is never signalled");
    assert.equal(recordBytes(root, job.id), before, "recovery never rewrites the terminal record");
    const released = acquireWorkspace({ root, cwd });
    assert.equal(released.ok, true, "validated evidence releases the workspace");
    if (released.ok) released.release();
  } finally {
    await reused.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a boot reading must postdate the retained child's spawn: a boot BEFORE the generation start is not a proof", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 3_600_000;
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs });

    const before = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(startedAtMs - 1000),
      enumerateFn: () => Promise.resolve({ ok: false, processes: [], reason: "unsupported_platform" })
    });
    assert.equal(before.released.length, 0, "a boot before the generation start proves nothing");
    assert.match(before.blocked[0]!.reason ?? "", /unsupported_platform/, "the snapshot fallback fails closed");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("worker restart safety: a boot between an EARLIER and the LATEST attempt of the same generation is never a proof", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const firstAttemptMs = Date.now() - 3_600_000;
    const latestAttemptMs = Date.now() - 60_000;
    // The generation survived a worker restart: the retained childPid belongs
    // to the LATEST attempt, so the boot (between the two attempts) cannot
    // prove the current child is gone.
    const job = terminalHolder(root, cwd, {
      childPid: pid,
      startedAtMs: firstAttemptMs,
      extraAttemptStartsMs: [latestAttemptMs]
    });
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(firstAttemptMs + 1000),
      enumerateFn: () => Promise.resolve({ ok: false, processes: [], reason: "unsupported_platform" })
    });
    assert.equal(report.released.length, 0, "an earlier attempt start must never bound the boot proof");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);

    // With a boot after the LATEST attempt start the same holder IS provable.
    const proven = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(latestAttemptMs + 60_000),
      enumerateFn: () => Promise.resolve({ ok: false, processes: [], reason: "unsupported_platform" })
    });
    assert.equal(proven.released.length, 1, JSON.stringify(proven));
    assert.equal(proven.released[0]!.method, "boot_session_cleared");
    assert.equal(readTreeRecovery(root, job.id)!.generationStartedAtMs, latestAttemptMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a wrong or NEW generation is never released by old evidence", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    // The live record is generation 1 with a retained child of generation 1...
    const job = terminalHolder(root, cwd, { childPid: pid, generation: 1, childGeneration: 1, startedAtMs });
    // ...while the (hypothetical late) evidence is bound to generation 0.
    fs.mkdirSync(path.join(root, "tree"), { recursive: true });
    fs.writeFileSync(
      treeRecoveryPath(root, job.id),
      JSON.stringify({
        id: job.id,
        generation: 0,
        childPid: pid,
        at: new Date().toISOString(),
        by: "unit",
        method: "descendant_snapshot",
        bootAtMs: null,
        generationStartedAtMs: startedAtMs,
        survivingPids: []
      }),
      "utf8"
    );
    assert.equal(isTreeRecoveryConfirmed(root, job), false, "a stale generation binding never matches");
    const blocked = acquireWorkspace({ root, cwd });
    assert.equal(blocked.ok, false, "old-generation evidence cannot release the new generation");

    // Evidence for the ACTUAL binding releases.
    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(readTreeRecovery(root, job.id)!.generation, 1);
    const released = acquireWorkspace({ root, cwd });
    assert.equal(released.ok, true);
    if (released.ok) released.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a continuation race: the record advances while recovery is validating, so no late evidence is written", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });

    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => {
        // Simulate the continuation winning the race DURING the scan: the same
        // logical job advances to a new queued generation with no retained PID.
        const current = loadJob(root, job.id)!;
        current.generation = 1;
        current.status = "queued";
        current.childPid = null;
        current.childGeneration = null;
        saveJob(root, current);
        return emptyScan();
      }
    });
    assert.equal(report.released.length, 0, "late evidence must not be written for a superseded identity");
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0]!.reason, "identity_changed");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
    assert.equal(loadJob(root, job.id)!.status, "queued", "recovery never rewrites the record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated recovery is idempotent: one probe for the first pass, nothing at all afterwards", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    let enumerations = 0;
    const enumerateFn = (): Promise<ProcessScan> => {
      enumerations += 1;
      return emptyScan();
    };
    const first = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn });
    assert.equal(first.released.length, 1);
    assert.equal(enumerations, 1);
    const evidenceAfterFirst = fs.readFileSync(treeRecoveryPath(root, job.id), "utf8");

    const second = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn });
    assert.equal(second.candidates, 0, "a released holder is not re-candidate");
    assert.equal(second.released.length, 0);
    assert.equal(enumerations, 1, "a repeated recovery performs no extra probe");
    assert.equal(fs.readFileSync(treeRecoveryPath(root, job.id), "utf8"), evidenceAfterFirst, "evidence is not rewritten");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one recovery call shares ONE enumeration across several terminal holders", async () => {
  const { dir, root } = newRoot();
  try {
    const cwdA = path.join(dir, "a");
    const cwdB = path.join(dir, "b");
    fs.mkdirSync(cwdA, { recursive: true });
    fs.mkdirSync(cwdB, { recursive: true });
    const pidA = await deadPid();
    const pidB = await deadPid();
    terminalHolder(root, cwdA, { childPid: pidA, startedAtMs: Date.now() - 60_000 });
    terminalHolder(root, cwdB, { childPid: pidB, startedAtMs: Date.now() - 60_000 });
    let enumerations = 0;
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: NO_BOOT,
      enumerateFn: () => {
        enumerations += 1;
        return emptyScan();
      }
    });
    assert.equal(report.candidates, 2);
    assert.equal(report.released.length, 2);
    assert.equal(enumerations, 1, "one bounded process-table read serves every candidate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live owner / active worker is not a recovery candidate and is never touched", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const job = createJobRecord({ task: "ACTIVE_WORKER", cwd });
    job.status = "running";
    job.owner = `jobquay-${process.pid}-live`;
    job.ownerPid = process.pid;
    job.heartbeatAt = new Date().toISOString();
    job.childPid = process.pid;
    job.childGeneration = job.generation;
    saveJob(root, job);
    const before = recordBytes(root, job.id);
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(Date.now() + 60_000),
      enumerateFn: emptyScan
    });
    assert.equal(report.candidates, 0, "a non-terminal record is never a recovery candidate");
    assert.equal(report.released.length + report.blocked.length + report.skipped.length, 0);
    assert.equal(recordBytes(root, job.id), before);
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery evidence naming a DIFFERENT job is never a release, and is simply ignored", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs });
    writeEvidenceFile(root, job.id, {
      id: "another-job",
      generation: 0,
      childPid: pid,
      at: new Date().toISOString(),
      by: "unit",
      method: "descendant_snapshot",
      bootAtMs: null,
      generationStartedAtMs: startedAtMs,
      survivingPids: []
    });
    assert.equal(readTreeRecovery(root, job.id), null, "evidence naming a different job is not this job's evidence");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false, "the real guard refuses");

    // The real proof still releases: the misplaced file was ignored, not fatal.
    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(readTreeRecovery(root, job.id)!.id, job.id);
    const released = acquireWorkspace({ root, cwd });
    assert.equal(released.ok, true);
    if (released.ok) released.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery evidence with a boot instant at/before its generation start is contradictory and never a release", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs });
    const base = {
      id: job.id,
      generation: 0,
      childPid: pid,
      at: new Date().toISOString(),
      by: "unit",
      method: "boot_session_cleared",
      generationStartedAtMs: startedAtMs,
      survivingPids: []
    };
    writeEvidenceFile(root, job.id, { ...base, bootAtMs: startedAtMs - 1000 });
    assert.equal(readTreeRecovery(root, job.id), null, "a boot before the generation start proves nothing");
    writeEvidenceFile(root, job.id, { ...base, bootAtMs: startedAtMs });
    assert.equal(readTreeRecovery(root, job.id), null, "a boot AT the generation start proves nothing");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false, "the real guard refuses");

    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(readTreeRecovery(root, job.id)!.method, "descendant_snapshot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery evidence that records live surviving PIDs is not a stopped-tree proof", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const startedAtMs = Date.now() - 60_000;
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs });
    writeEvidenceFile(root, job.id, {
      id: job.id,
      generation: 0,
      childPid: pid,
      at: new Date().toISOString(),
      by: "unit",
      method: "descendant_snapshot",
      bootAtMs: null,
      generationStartedAtMs: startedAtMs,
      survivingPids: [process.pid]
    });
    assert.equal(readTreeRecovery(root, job.id), null, "recorded survivors are never a release");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false, "the real guard refuses");

    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(readTreeRecovery(root, job.id)!.survivingPids.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed or fabricated evidence file is never a release", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    fs.mkdirSync(path.join(root, "tree"), { recursive: true });
    const file = treeRecoveryPath(root, job.id);

    // A boot proof WITHOUT its boot instant is not a proof.
    fs.writeFileSync(file, JSON.stringify({ id: job.id, generation: 0, childPid: pid, method: "boot_session_cleared" }), "utf8");
    assert.equal(readTreeRecovery(root, job.id), null, "an internally inconsistent record reads as null");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false);

    // A boot proof WITHOUT its generation start is not a proof either.
    fs.writeFileSync(
      file,
      JSON.stringify({ id: job.id, generation: 0, childPid: pid, method: "boot_session_cleared", bootAtMs: Date.now(), survivingPids: [] }),
      "utf8"
    );
    assert.equal(readTreeRecovery(root, job.id), null, "a missing generation start is contradictory");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);

    // A descendant snapshot carrying a boot instant contradicts its method.
    fs.writeFileSync(
      file,
      JSON.stringify({
        id: job.id,
        generation: 0,
        childPid: pid,
        method: "descendant_snapshot",
        bootAtMs: Date.now(),
        generationStartedAtMs: Date.now() - 1000,
        survivingPids: []
      }),
      "utf8"
    );
    assert.equal(readTreeRecovery(root, job.id), null, "method-inconsistent fields are contradictory");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);

    // A different PID binding is not a proof for THIS tree.
    fs.writeFileSync(
      file,
      JSON.stringify({ id: job.id, generation: 0, childPid: pid + 1, at: new Date().toISOString(), by: "x", method: "descendant_snapshot", bootAtMs: null, generationStartedAtMs: Date.now(), survivingPids: [] }),
      "utf8"
    );
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false);

    // An unknown method is not a proof either.
    fs.writeFileSync(
      file,
      JSON.stringify({ id: job.id, generation: 0, childPid: pid, at: new Date().toISOString(), by: "x", method: "trust_me", bootAtMs: null, generationStartedAtMs: Date.now(), survivingPids: [] }),
      "utf8"
    );
    assert.equal(isTreeRecoveryConfirmed(root, job), false);

    // And a genuinely malformed JSON file never crashes the guard.
    fs.writeFileSync(file, "{not json", "utf8");
    assert.equal(isTreeRecoveryConfirmed(root, job), false);
    assert.equal(acquireWorkspace({ root, cwd }).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery evidence is bound to the canonical workspace record, not to a path spelling", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    const job = terminalHolder(root, cwd, { childPid: pid, startedAtMs: Date.now() - 60_000 });
    const report = await recoverTerminalHolders(root, { by: "unit", readBootTimeFn: NO_BOOT, enumerateFn: emptyScan });
    assert.equal(report.released.length, 1);
    const canonical = canonicalWorkspacePath(cwd);
    const released = acquireWorkspace({ root, cwd: `${cwd}${path.sep}` });
    assert.equal(released.ok, true);
    if (released.ok) {
      assert.equal(released.canonicalCwd, canonical);
      released.release();
    }
    assert.equal(loadJob(root, job.id)!.status, "done", "the successful result is unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a continuation over a recovered old tree with a reused live PID never reaches a kill executor and starts the new generation", async () => {
  const { dir, root, cwd } = newRoot();
  const reused = liveSleepingChild();
  try {
    const generation = 0;
    const startedAtMs = Date.now() - 3_600_000;
    const job = createJobRecord({ task: "CONTINUE_RECOVERED_TREE", cwd });
    job.status = "done";
    job.sessionId = "session-recovered-1";
    job.finishedAt = new Date(Date.now() - 3_500_000).toISOString();
    job.childPid = reused.pid;
    job.childGeneration = generation;
    job.attempts = [attemptFor(generation, startedAtMs)];
    saveJob(root, job);
    appendUserMessageOrThrow(root, job.id, { text: job.task, generation, at: job.createdAt });

    // The production passive recovery proved the OLD generation stopped (a boot
    // proof postdating its latest attempt start) and released the workspace.
    const report = await recoverTerminalHolders(root, {
      by: "unit",
      readBootTimeFn: bootAt(Date.now() - 60_000),
      enumerateFn: emptyScan
    });
    assert.equal(report.released.length, 1, JSON.stringify(report));
    assert.equal(readTreeRecovery(root, job.id)!.method, "boot_session_cleared");

    const kill = recordingExecFile();
    const res = await prepareContinuation({
      root,
      jobId: job.id,
      task: "FOLLOW_UP_AFTER_RECOVERY",
      isAliveFn: isPidAlive,
      execFileFn: kill.fn,
      delayFn: () => Promise.resolve(),
      spawnWorkerFn: noopSpawn
    });
    assert.equal(kill.calls.n, 0, "a recovered old tree must never reach a kill executor");
    assert.equal(isPidAlive(reused.pid), true, "the unrelated process holding the reused PID is never signalled");
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.job.id, job.id, "the continuation keeps the same logical job");
    assert.equal(res.job.generation, generation + 1, "the new generation was persisted");
    assert.equal(res.job.status, "queued");
    assert.equal(res.job.childPid, null, "the old retained PID is not carried into the new generation");
    assert.equal(res.job.childGeneration, null);
    assert.equal(readTreeRecovery(root, job.id), null, "old-generation evidence is cleared for the new generation");
    assert.equal(fs.existsSync(treeRecoveryPath(root, job.id)), false);
  } finally {
    await reused.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Darwin continuation fails closed when the pre-kill snapshot sees a descendant outside the owned process group",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch), timeout: 20_000 },
  async () => {
    const { dir, root, cwd } = newRoot();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    const pid = child.pid;
    assert.ok(pid);
    const escapedPid = 2_147_000_001;
    try {
      const deadline = Date.now() + 5_000;
      let identity = captureProcessIdentity(pid!);
      while (!identity && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        identity = captureProcessIdentity(pid!);
      }
      assert.ok(identity?.createdAtUs != null && identity.createdAtMs != null);
      assert.equal(identity!.pgid, pid);
      assert.equal(identity!.sid, pid);

      const job = createJobRecord({ task: "DARWIN_ESCAPED_TREE", cwd });
      job.status = "done";
      job.sessionId = "session-darwin-escaped-1";
      job.finishedAt = new Date().toISOString();
      job.childPid = pid!;
      job.childStartedAtUs = identity!.createdAtUs!;
      job.childGeneration = 0;
      job.attempts = [attemptFor(0, identity!.createdAtMs!)];
      saveJob(root, job);
      appendUserMessageOrThrow(root, job.id, { text: job.task, generation: 0, at: job.createdAt });

      const res = await prepareContinuation({
        root,
        jobId: job.id,
        task: "MUST_NOT_START_OVER_ESCAPED_DESCENDANT",
        graceMs: 2_000,
        isAliveFn: (probePid) => probePid === escapedPid ? true : isPidAlive(probePid),
        enumerateFn: async () => ({
          ok: true,
          processes: [
            {
              pid: pid!,
              ppid: process.pid,
              createdAtMs: identity!.createdAtMs!,
              createdAtUs: identity!.createdAtUs!,
              pgid: pid!,
              sid: pid!,
              sessionLeader: true
            },
            {
              pid: escapedPid,
              ppid: pid!,
              createdAtMs: identity!.createdAtMs! + 1,
              createdAtUs: identity!.createdAtUs! + 1_000,
              pgid: escapedPid,
              sid: escapedPid,
              sessionLeader: true
            }
          ]
        }),
        spawnWorkerFn: noopSpawn
      });

      assert.equal(res.ok, false);
      if (res.ok) throw new Error("unreachable");
      assert.equal(res.code, "old_tree_unconfirmed");
      assert.equal(loadJob(root, job.id)!.generation, 0, "no new generation starts over an escaped descendant");
      assert.equal(readTreeConfirmation(root, job.id), null, "group exit is never persisted as whole-tree confirmation");
      assert.equal(isPidAlive(pid!), false, "the owned root group was still cleaned up");
    } finally {
      try { process.kill(-(pid as number), "SIGKILL"); } catch {}
      try { process.kill(pid as number, "SIGKILL"); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("without recovery evidence a genuinely live retained tree still takes the kill path and the continuation is refused", { skip: process.platform === "win32" ? false : "records the Windows taskkill executor boundary" }, async () => {
  const { dir, root, cwd } = newRoot();
  const live = liveSleepingChild();
  try {
    const generation = 0;
    const job = createJobRecord({ task: "LIVE_TREE_CONTINUATION", cwd });
    job.status = "done";
    job.sessionId = "session-live-tree-1";
    job.finishedAt = new Date().toISOString();
    job.childPid = live.pid;
    job.childGeneration = generation;
    job.attempts = [attemptFor(generation, Date.now() - 60_000)];
    saveJob(root, job);
    appendUserMessageOrThrow(root, job.id, { text: job.task, generation, at: job.createdAt });

    const kill = recordingExecFile();
    const res = await prepareContinuation({
      root,
      jobId: job.id,
      task: "MUST_BE_REFUSED",
      isAliveFn: isPidAlive,
      execFileFn: kill.fn,
      delayFn: () => new Promise((resolve) => setTimeout(resolve, 10)),
      graceMs: 200,
      spawnWorkerFn: noopSpawn
    });
    assert.ok(kill.calls.n >= 1, "an unproven live retained tree still reaches the kill boundary");
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.code, "old_tree_unconfirmed");
    assert.equal(loadJob(root, job.id)!.generation, generation, "no new generation was started over an unproven tree");
  } finally {
    await live.stop(); // the production fallback may already have signalled this TEST-OWNED child
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
