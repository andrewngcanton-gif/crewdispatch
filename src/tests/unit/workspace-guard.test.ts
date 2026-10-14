// workspace-guard.test.ts — JQ-20261002-44 unit coverage for the shared
// EXACT-workspace occupancy guard (`src/jobs/workspace.ts`).
//
// The guard is the product rule that at most ONE accepted active job may target
// a canonical working directory at a time. These tests pin the decision table
// directly against durable job records: what counts as a holder, what releases,
// what is NEVER freed (age/heartbeat alone, a live owner, an orphaned holder),
// and how a provably dead owner is settled by the shared reconcile rules.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  acquireWorkspace,
  canonicalWorkspacePath,
  evaluateWorkspace,
  findWorkspaceHolder,
  legacyWorkspaceLockFile,
  resolveWorkspaceIdentity,
  workspaceBusyMessage,
  workspaceKey,
  workspaceLockFile
} from "../../jobs/workspace";
import { createJobRecord } from "../../jobs/service";
import { loadJob, saveJob, writeTreeConfirmation } from "../../jobs/store";
import { isPidAlive } from "../../runtime/process";

function newRoot(): { dir: string; root: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-workspace-unit-"));
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

/** An OWNED harmless sleeping child; the test that spawned it must stop it. */
function liveSleepingChild(): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  assert.ok(pid);
  // A killed child reports exitCode=null + signalCode; only listening for the
  // ONE 'exit' event (created before any kill) is race-free on both paths.
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

function activeJob(root: string, cwd: string, status: "queued" | "running" | "orphaned" = "running") {
  const job = createJobRecord({ task: "WORKSPACE_UNIT_TASK", cwd });
  job.status = status;
  if (status === "running") {
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647;
    job.heartbeatAt = new Date().toISOString();
  }
  saveJob(root, job);
  return job;
}

test("the canonical workspace resolves normalized spellings, junctions and Windows case to one directory", async (t) => {
  const { dir, cwd } = newRoot();
  try {
    const canonical = canonicalWorkspacePath(cwd);
    assert.equal(canonical, fs.realpathSync.native(cwd), "an existing directory is compared by its OS real path");
    assert.equal(canonicalWorkspacePath(`${cwd}${path.sep}`), canonical, "a trailing separator is normalized away");
    assert.equal(canonicalWorkspacePath(path.join(cwd, ".", "sub", "..")), canonical, "dot segments are normalized");
    assert.equal(canonicalWorkspacePath(path.join(cwd, "..", path.basename(cwd))), canonical);

    // A junction (Windows) / directory symlink (POSIX) to the same real
    // directory must map to the SAME canonical workspace.
    const alias = path.join(dir, "alias");
    try {
      fs.symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      t.diagnostic(`alias creation skipped: ${String((e as Error)?.message || e)}`);
      return;
    }
    assert.equal(canonicalWorkspacePath(alias), canonical, "a junction/symlink alias resolves to the real directory");

    if (process.platform === "win32") {
      const upper = path.join(dir, path.basename(cwd).toUpperCase());
      assert.equal(canonicalWorkspacePath(upper), canonical, "a differently-cased spelling resolves to the same directory");
      assert.equal(workspaceKey(canonicalWorkspacePath(upper)), workspaceKey(canonical), "the comparison key folds Windows case");
    }
    // Different directories stay different workspaces (exact-cwd, not recursive).
    const other = path.join(dir, "other");
    fs.mkdirSync(other, { recursive: true });
    assert.notEqual(canonicalWorkspacePath(other), canonical);
    assert.notEqual(workspaceKey(canonicalWorkspacePath(other)), workspaceKey(canonical));
    assert.notEqual(canonicalWorkspacePath(path.join(dir)), canonical, "a PARENT directory is a different workspace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Darwin workspace identity uses the filesystem object, survives rename/alias, and keeps the legacy path lock",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
  () => {
    const { dir, root, cwd } = newRoot();
    const renamed = path.join(dir, "renamed-project");
    const alias = path.join(dir, "project-alias");
    try {
      const identity = resolveWorkspaceIdentity(cwd);
      assert.equal(identity.source, "filesystem");
      assert.match(String(identity.persistentIdentity), /^darwin-fs:\d+:\d+$/);
      assert.notEqual(identity.primaryKey, identity.legacyKey, "filesystem and legacy path locks are independent");

      fs.symlinkSync(cwd, alias, "dir");
      const viaAlias = resolveWorkspaceIdentity(alias);
      assert.equal(viaAlias.persistentIdentity, identity.persistentIdentity);
      assert.equal(viaAlias.primaryKey, identity.primaryKey);
      assert.equal(viaAlias.canonicalCwd, identity.canonicalCwd);

      const job = activeJob(root, cwd, "running");
      assert.equal(job.workspaceIdentity, identity.persistentIdentity, "accepted job persists exact workspace identity");

      const reservation = acquireWorkspace({ root, cwd: alias });
      assert.equal(reservation.ok, false, "alias sees the durable holder through filesystem identity");

      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      saveJob(root, job);
      const acquired = acquireWorkspace({ root, cwd });
      assert.equal(acquired.ok, true);
      if (!acquired.ok) return;
      const primaryLock = workspaceLockFile(root, cwd);
      const legacyLock = legacyWorkspaceLockFile(root, cwd);
      assert.equal(fs.existsSync(primaryLock), true, "new identity lock is held");
      assert.equal(fs.existsSync(legacyLock), true, "legacy path lock is also held for old-version compatibility");
      acquired.release();
      assert.equal(fs.existsSync(primaryLock), false);
      assert.equal(fs.existsSync(legacyLock), false);

      job.status = "running";
      job.finishedAt = null;
      saveJob(root, job);
      fs.unlinkSync(alias);
      fs.renameSync(cwd, renamed);
      const renamedIdentity = resolveWorkspaceIdentity(renamed);
      assert.equal(renamedIdentity.persistentIdentity, identity.persistentIdentity, "rename preserves device/inode identity");
      assert.notEqual(renamedIdentity.legacyKey, identity.legacyKey, "rename changes the historical path hash");
      assert.equal(
        findWorkspaceHolder(root, renamed)?.jobId,
        job.id,
        "persisted filesystem identity keeps an active job attached after rename"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "Darwin acquisition honors a live pre-MAC-14 legacy path lock",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
  () => {
    const { dir, root, cwd } = newRoot();
    try {
      const legacy = legacyWorkspaceLockFile(root, cwd);
      const primary = workspaceLockFile(root, cwd);
      assert.notEqual(primary, legacy);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");

      const refused = acquireWorkspace({ root, cwd, lockAttempts: 2, lockStepMs: 0 });
      assert.equal(refused.ok, false, "old-version lock prevents a new identity-key reservation");
      assert.equal(fs.existsSync(legacy), true, "live legacy lock is never stolen");
      assert.equal(fs.existsSync(primary), false, "failed dual-lock acquisition releases the primary lock");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("workspace identity falls back to the legacy exact path when the directory is not readable/existing", () => {
  const { dir } = newRoot();
  try {
    const missing = path.join(dir, "does-not-exist");
    const identity = resolveWorkspaceIdentity(missing);
    assert.equal(identity.source, "path_fallback");
    assert.equal(identity.persistentIdentity, null);
    assert.equal(identity.primaryKey, identity.legacyKey);
    assert.equal(identity.legacyKey, workspaceKey(canonicalWorkspacePath(missing)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a terminal record WITHOUT retained child evidence releases the workspace (every terminal status)", () => {
  const { dir, root, cwd } = newRoot();
  try {
    for (const status of ["queued", "running", "orphaned"] as const) {
      const job = activeJob(root, cwd, status);
      const holder = findWorkspaceHolder(root, canonicalWorkspacePath(cwd));
      assert.ok(holder, `${status} must hold the workspace`);
      assert.equal(holder!.jobId, job.id);
      assert.equal(holder!.provider, job.provider);
      assert.equal(holder!.runner, job.runner);
      assert.equal(holder!.status, status);
      assert.equal(holder!.generation, job.generation);
      assert.equal(holder!.retainedChildPid, null, "a non-terminal holder has no retained-child marker");
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      saveJob(root, job);
      assert.equal(findWorkspaceHolder(root, canonicalWorkspacePath(cwd)), null, "done releases the workspace");
    }
    // A terminal record with NO child evidence releases. (A terminal record that
    // RETAINS an unresolved managed child tree does NOT — see the dedicated test
    // below.)
    for (const status of ["error", "cancelled", "interrupted"] as const) {
      const job = activeJob(root, cwd, "running");
      job.status = status;
      job.finishedAt = new Date().toISOString();
      saveJob(root, job);
      assert.equal(findWorkspaceHolder(root, canonicalWorkspacePath(cwd)), null, `${status} releases the workspace`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TERMINAL record with a retained unresolved child tree still holds the workspace; only a valid stopped confirmation releases it", async () => {
  const { dir, root, cwd } = newRoot();
  const child = liveSleepingChild();
  try {
    const canonical = canonicalWorkspacePath(cwd);
    const job = createJobRecord({ task: "TERMINAL_CHILD", cwd });
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.childPid = child.pid;
    job.childGeneration = job.generation;
    saveJob(root, job);

    // (a) A LIVE retained child blocks a NEW dispatch, and the refusal identifies
    // the finished holder + the retained PID.
    assert.equal(isPidAlive(child.pid), true, "the owned child is alive");
    const live = acquireWorkspace({ root, cwd });
    assert.equal(live.ok, false, "a terminal record with a live retained child must block");
    if (!live.ok) {
      assert.equal(live.holder?.jobId, job.id);
      assert.equal(live.holder?.status, "done");
      assert.equal(live.holder?.retainedChildPid, child.pid);
      const message = workspaceBusyMessage(live.holder, live.canonicalCwd);
      assert.ok(message.includes(job.id), "the refusal names the holder job");
      assert.ok(message.includes("finished task"), "the refusal explains the holder is terminal");
      assert.ok(message.includes(String(child.pid)), "the refusal names the retained child PID");
      assert.ok(message.includes(canonical), "the refusal names the canonical cwd");
    }
    assert.equal(loadJob(root, job.id)!.childPid, child.pid, "the guard never clears the retained evidence");

    // (b) UNKNOWN liveness blocks too (never a benefit of the doubt).
    const unknown = acquireWorkspace({ root, cwd, reconcile: { isChildAliveFn: () => null } });
    assert.equal(unknown.ok, false, "unknown child liveness must block");

    // (c) A DEAD root WITHOUT a confirmation blocks.
    await child.stop();
    assert.equal(isPidAlive(child.pid), false, "the owned child is now gone");
    const deadNoProof = acquireWorkspace({ root, cwd });
    assert.equal(deadNoProof.ok, false, "a dead root alone never releases a retained child tree");

    // (d) A confirmation for a WRONG generation blocks.
    writeTreeConfirmation(root, job.id, job.generation + 1, child.pid, "root_exited", "workspace-test");
    const wrongGen = acquireWorkspace({ root, cwd });
    assert.equal(wrongGen.ok, false, "a confirmation for another generation never releases this tree");

    // (e) A valid generation-scoped stopped confirmation releases, WITHOUT
    // rewriting the terminal record.
    writeTreeConfirmation(root, job.id, job.childGeneration ?? job.generation, child.pid, "root_exited", "workspace-test");
    const released = acquireWorkspace({ root, cwd });
    assert.equal(released.ok, true, "a valid stopped confirmation releases the workspace");
    if (released.ok) released.release();
    assert.equal(loadJob(root, job.id)!.childPid, child.pid, "release never rewrites the terminal record");
    assert.equal(loadJob(root, job.id)!.status, "done", "release never changes the terminal status");
  } finally {
    await child.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Darwin terminal-holder guidance does not promise dead-root recovery from a later scan or continuation", () => {
  const holder = {
    jobId: "job-darwin-held",
    provider: "command-code",
    runner: "command-code" as const,
    status: "done" as const,
    generation: 0,
    ownerPid: 101,
    cwd: "/private/tmp/held",
    retainedChildPid: 202
  };
  const message = workspaceBusyMessage(holder, holder.cwd, "darwin");
  assert.match(message, /On macOS/);
  assert.match(message, /reparented/);
  assert.match(message, /later OS boot/);
  assert.match(message, /same-job continuation is not guaranteed/);
  assert.equal(message.includes("Continuing this finished task also resolves"), false);
});

test("a continuation may hold its OWN workspace, but never another job's", () => {
  const { dir, root, cwd } = newRoot();
  try {
    const own = activeJob(root, cwd, "queued");
    const acquired = acquireWorkspace({ root, cwd, excludeJobId: own.id });
    assert.equal(acquired.ok, true, "the same logical job is not 'another' holder");
    if (acquired.ok) acquired.release();

    const other = activeJob(root, cwd, "running");
    const refused = acquireWorkspace({ root, cwd, excludeJobId: other.id });
    assert.equal(refused.ok, false, "a DIFFERENT active job still holds the directory");
    if (!refused.ok) assert.equal(refused.holder?.jobId, own.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireWorkspace refuses an active holder, names it in the message, and releases cleanly", () => {
  const { dir, root, cwd } = newRoot();
  try {
    const job = activeJob(root, cwd, "running");
    const canonical = canonicalWorkspacePath(cwd);
    const refused = acquireWorkspace({ root, cwd });
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.holder?.jobId, job.id);
    assert.equal(refused.canonicalCwd, canonical);
    const message = workspaceBusyMessage(refused.holder, refused.canonicalCwd);
    assert.ok(message.includes(job.id), "the refusal names the holder job");
    assert.ok(message.includes("command-code"), "the refusal names the holder provider");
    assert.ok(message.includes("running"), "the refusal names the holder status");
    assert.ok(message.includes(canonical), "the refusal names the canonical cwd");
    assert.equal(message.includes("WORKSPACE_UNIT_TASK"), false, "the refusal never leaks the task");
    assert.equal(fs.existsSync(workspaceLockFile(root, canonical)), false, "a refusal leaves no lock behind");

    job.status = "cancelled";
    job.finishedAt = new Date().toISOString();
    saveJob(root, job);
    const acquired = acquireWorkspace({ root, cwd });
    assert.equal(acquired.ok, true, "the terminal holder releases the workspace");
    if (!acquired.ok) return;
    assert.equal(fs.existsSync(workspaceLockFile(root, canonical)), true, "the reservation mutex is held while reserving");
    acquired.release();
    assert.equal(fs.existsSync(workspaceLockFile(root, canonical)), false, "release removes the reservation mutex");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale heartbeat or a live owner NEVER frees a workspace by age alone", () => {
  const { dir, root, cwd } = newRoot();
  try {
    const job = createJobRecord({ task: "LIVE_OWNER", cwd });
    job.status = "running";
    // The owner is THIS test process (provably alive) with an ancient heartbeat.
    job.owner = `jobquay-${process.pid}-stale`;
    job.ownerPid = process.pid;
    job.heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
    saveJob(root, job);

    const acquired = acquireWorkspace({ root, cwd });
    assert.equal(acquired.ok, false, "a live owner keeps the workspace no matter how old the heartbeat is");
    if (!acquired.ok) assert.equal(acquired.holder?.jobId, job.id);
    const reloaded = loadJob(root, job.id);
    assert.equal(reloaded!.status, "running", "the guard never rewrites a live-owner record");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an orphaned holder (dead owner, unconfirmed child tree) is never freed by the guard", () => {
  const { dir, root, cwd } = newRoot();
  try {
    const job = createJobRecord({ task: "ORPHANED", cwd });
    job.status = "orphaned";
    job.owner = "jobquay-2147483647-x";
    job.ownerPid = 2147483647;
    job.heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
    job.childPid = 2147483646;
    job.childGeneration = 0;
    job.stopReason = "child_root_dead_tree_unconfirmed";
    saveJob(root, job);

    const acquired = acquireWorkspace({ root, cwd });
    assert.equal(acquired.ok, false, "an unconfirmed child tree keeps the workspace");
    if (!acquired.ok) assert.equal(acquired.holder?.status, "orphaned");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a provably dead owner is settled by the SHARED reconcile rules and then frees the workspace", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const pid = await deadPid();
    assert.equal(isPidAlive(pid), false, "the probe must see the dead owner");
    const job = createJobRecord({ task: "DEAD_OWNER", cwd });
    job.status = "running";
    job.owner = `jobquay-${pid}-dead`;
    job.ownerPid = pid;
    job.heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
    job.childPid = null;
    saveJob(root, job);

    const acquired = acquireWorkspace({ root, cwd });
    assert.equal(acquired.ok, true, "a stale dead owner is settled terminal, not left holding the workspace");
    if (acquired.ok) acquired.release();
    const settled = loadJob(root, job.id);
    assert.equal(settled!.status, "interrupted");
    assert.equal(settled!.stopReason, "owner_lost");
    assert.equal(fs.existsSync(path.join(root, "terminal", `${job.id}.gen-0.json`)), true, "the settle writes the generation snapshot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateWorkspace is a read-only-by-default evaluation that reports a live holder untouched", () => {
  const { dir, root, cwd } = newRoot();
  try {
    const job = createJobRecord({ task: "EVALUATE", cwd });
    job.status = "running";
    job.owner = `jobquay-${process.pid}-live`;
    job.ownerPid = process.pid;
    job.heartbeatAt = new Date(Date.now() - 3_600_000).toISOString();
    saveJob(root, job);
    const evaluation = evaluateWorkspace(root, cwd);
    assert.equal(evaluation.holder?.jobId, job.id);
    assert.equal(evaluation.canonicalCwd, canonicalWorkspacePath(cwd));
    assert.equal(loadJob(root, job.id)!.status, "running");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale reservation lock is reclaimed, a live one is never stolen (fail closed)", async () => {
  const { dir, root, cwd } = newRoot();
  try {
    const canonical = canonicalWorkspacePath(cwd);
    const lock = workspaceLockFile(root, canonical);
    fs.mkdirSync(path.dirname(lock), { recursive: true });

    const pid = await deadPid();
    fs.writeFileSync(lock, JSON.stringify({ pid, at: new Date().toISOString() }), "utf8");
    const acquired = acquireWorkspace({ root, cwd, lockAttempts: 2, lockStepMs: 0 });
    assert.equal(acquired.ok, true, "a lock owned by a dead PID is reclaimed");
    if (acquired.ok) acquired.release();

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    const refused = acquireWorkspace({ root, cwd, lockAttempts: 2, lockStepMs: 0 });
    assert.equal(refused.ok, false, "a live owner's lock is never stolen");
    if (!refused.ok) assert.equal(refused.holder, null, "contention without a durable holder reports no holder");
    assert.equal(fs.existsSync(lock), true, "the foreign lock is left in place");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
