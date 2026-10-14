// jobs-reconcile.test.ts — owner/heartbeat reconciliation across restarts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../jobs/service";
import { isHeartbeatStale, isOwnerAlive, reconcileAll, reconcileJob, shouldReconcile } from "../../jobs/reconcile";
import { jobPath, loadJob, saveJob } from "../../jobs/store";
import { isTerminalStatus, type JobRecord } from "../../jobs/types";
import { WORKBUDDY_AI_PROVIDER } from "../../providers/workbuddy-ai/index";
import { providerTurnUnresolved } from "../../jobs/provider-turn";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");

function runningJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const job = createJobRecord({ task: "t", cwd: process.cwd() });
  job.status = "running";
  job.owner = "jobquay-4242-abc";
  job.ownerPid = 4242;
  job.heartbeatAt = new Date(NOW - 60000).toISOString(); // stale
  return { ...job, ...overrides };
}

test("heartbeat staleness is measured against the threshold", () => {
  const job = runningJob();
  assert.equal(isHeartbeatStale(job, NOW, 15000), true);
  assert.equal(isHeartbeatStale(job, NOW, 120000), false);
  assert.equal(isHeartbeatStale({ ...job, heartbeatAt: null }, NOW, 15000), true);
});

test("a stale heartbeat with a DEAD owner is reconciled to interrupted", () => {
  const job = runningJob();
  assert.equal(shouldReconcile(job, NOW, { isAliveFn: () => false }), true);
  const next = reconcileJob(job, NOW, { isAliveFn: () => false });
  assert.ok(next);
  assert.equal(next.status, "interrupted");
  assert.equal(next.stopReason, "owner_lost");
  assert.equal(next.childPid, null);
  assert.ok(next.finishedAt);
});

test("a stale heartbeat with a LIVE owner is NOT orphaned (silent but live)", () => {
  const job = runningJob();
  assert.equal(isOwnerAlive(job, () => true, { platform: "win32" }), true);
  assert.equal(shouldReconcile(job, NOW, { isAliveFn: () => true, platform: "win32" }), false);
  assert.equal(reconcileJob(job, NOW, { isAliveFn: () => true, platform: "win32" }), null);
});

test("Darwin owner identity treats a live reused PID as the original owner having exited", () => {
  const job = runningJob({ ownerStartedAtUs: 1_700_000_000_123_456 });
  const capture = () => ({
    pid: 4242,
    ppid: 1,
    createdAtMs: 1_700_000_000_123,
    createdAtUs: 1_700_000_000_123_457,
    pgid: 4242,
    sid: 4242,
    sessionLeader: true
  });
  assert.equal(isOwnerAlive(job, () => true, { platform: "darwin", captureIdentityFn: capture }), false);
  const opts = {
    platform: "darwin" as NodeJS.Platform,
    isAliveFn: () => true,
    captureOwnerIdentityFn: capture
  };
  assert.equal(shouldReconcile(job, NOW, opts), true);
  assert.equal(reconcileJob(job, NOW, opts)?.status, "interrupted");
});

test("Darwin live owner with absent or unreadable exact birth stays unknown", () => {
  const unpinned = runningJob({ ownerStartedAtUs: null });
  assert.equal(
    isOwnerAlive(unpinned, () => true, { platform: "darwin", captureIdentityFn: () => null }),
    null
  );
  assert.equal(
    shouldReconcile(unpinned, NOW, {
      platform: "darwin",
      isAliveFn: () => true,
      captureOwnerIdentityFn: () => null
    }),
    false
  );

  const pinned = runningJob({ ownerStartedAtUs: 123_456 });
  assert.equal(
    isOwnerAlive(pinned, () => true, { platform: "darwin", captureIdentityFn: () => null }),
    null
  );
});
test("a fresh heartbeat with a dead owner is left alone (not yet stale)", () => {
  const job = runningJob({ heartbeatAt: new Date(NOW).toISOString() });
  assert.equal(shouldReconcile(job, NOW, { isAliveFn: () => false }), false);
});

test("a dead owner with a recorded cancel intent reconciles to cancelled, not interrupted", () => {
  const job = runningJob({ cancelIntent: { requested: true, requestedAt: new Date(NOW - 5000).toISOString(), by: "x" } });
  const next = reconcileJob(job, NOW, { isAliveFn: () => false });
  assert.ok(next);
  assert.equal(next.status, "cancelled");
  assert.equal(next.stopReason, "cancelled");
});

test("a dead owner whose child tree is still ALIVE is orphaned (non-terminal), never cancelled, PID kept", () => {
  const job = runningJob({ childPid: 12345, childGeneration: 0 });
  const opts = { isAliveFn: () => false, isChildAliveFn: () => true };
  assert.equal(shouldReconcile(job, NOW, opts), true);
  const next = reconcileJob(job, NOW, opts);
  assert.ok(next);
  assert.equal(next.status, "orphaned");
  assert.equal(isTerminalStatus(next.status), false, "orphaned must not be terminal");
  assert.equal(next.childPid, 12345, "the child PID must be preserved as evidence");
  assert.equal(next.finishedAt, null, "orphaned is not a finished job");
  // Idempotent: an orphaned job is not re-reconciled and never auto-runs.
  assert.equal(shouldReconcile(next, NOW, opts), false);
  assert.equal(reconcileJob(next, NOW, opts), null);
});

test("a dead owner whose child liveness is UNKNOWN is orphaned with the PID preserved", () => {
  const job = runningJob({ childPid: 999, childGeneration: 0 });
  const next = reconcileJob(job, NOW, { isAliveFn: () => false, isChildAliveFn: () => null });
  assert.ok(next);
  assert.equal(next.status, "orphaned");
  assert.equal(isTerminalStatus(next.status), false);
  assert.equal(next.childPid, 999);
  assert.equal(next.finishedAt, null);
});

test("a dead owner with a cancel intent but a LIVE child is NOT reported cancelled", () => {
  const job = runningJob({
    childPid: 4242,
    childGeneration: 0,
    cancelIntent: { requested: true, requestedAt: new Date(NOW - 5000).toISOString(), by: "x" }
  });
  const next = reconcileJob(job, NOW, { isAliveFn: () => false, isChildAliveFn: () => true });
  assert.ok(next);
  assert.equal(next.status, "orphaned");
  assert.notEqual(next.status, "cancelled", "an unconfirmed tree must never be reported cancelled");
  assert.equal(next.childPid, 4242);
});

test("a dead owner whose child ROOT is dead but has NO tree confirmation is orphaned, never interrupted (E)", () => {
  // Matrix E: the root PID is gone, but that alone never proves the CLI process
  // TREE exited (descendants may have been reparented and survive). Without a
  // generation-scoped confirmation the honest state is the non-terminal
  // `orphaned` with the PID kept — never `interrupted`, never `cancelled`.
  const job = runningJob({ childPid: 12345, childGeneration: 0 });
  const opts = { isAliveFn: () => false, isChildAliveFn: () => false };
  const next = reconcileJob(job, NOW, opts);
  assert.ok(next);
  assert.equal(next.status, "orphaned", "a dead root PID alone must not settle a terminal state");
  assert.equal(isTerminalStatus(next.status), false);
  assert.equal(next.childPid, 12345, "the child PID must be kept as evidence");
  assert.equal(next.finishedAt, null, "orphaned is not a finished job");
  // Idempotent: not re-reconciled, never auto-resumed.
  assert.equal(shouldReconcile(next, NOW, opts), false);
  assert.equal(reconcileJob(next, NOW, opts), null);
});

test("a dead owner whose child root is dead settles terminal ONLY with a matching tree confirmation", () => {
  const job = runningJob({ childPid: 12345, childGeneration: 0 });
  const opts = { isAliveFn: () => false, isChildAliveFn: () => false, isTreeConfirmedFn: () => true };
  const next = reconcileJob(job, NOW, opts);
  assert.ok(next);
  assert.equal(next.status, "interrupted");
  assert.equal(next.childPid, null, "a proven-stopped tree clears the PID");
  assert.ok(next.finishedAt);
});

test("a dead owner whose child root is dead and a cancel intent is present is cancelled ONLY with a matching tree confirmation", () => {
  const job = runningJob({
    childPid: 12345,
    childGeneration: 0,
    cancelIntent: { requested: true, requestedAt: new Date(NOW - 5000).toISOString(), by: "x" }
  });
  // No confirmation → must NOT claim cancelled (E with an intent).
  const unconfirmed = reconcileJob(job, NOW, { isAliveFn: () => false, isChildAliveFn: () => false });
  assert.ok(unconfirmed);
  assert.equal(unconfirmed.status, "orphaned");
  assert.notEqual(unconfirmed.status, "cancelled");
  assert.equal(unconfirmed.childPid, 12345);
  // A matching confirmation → safe cancelled.
  const confirmed = reconcileJob(job, NOW, { isAliveFn: () => false, isChildAliveFn: () => false, isTreeConfirmedFn: () => true });
  assert.ok(confirmed);
  assert.equal(confirmed.status, "cancelled");
  assert.equal(confirmed.childPid, null);
});

test("terminal jobs are never touched by reconciliation", () => {
  const job = runningJob({ status: "done", finishedAt: new Date(NOW).toISOString() });
  assert.equal(shouldReconcile(job, NOW, { isAliveFn: () => false }), false);
  assert.equal(reconcileJob(job, NOW, { isAliveFn: () => false }), null);
});

test("reconcileAll persists only the changed jobs and never reruns terminal work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-reconcile-"));
  const dead = runningJob();
  const done = runningJob({ status: "done", finishedAt: new Date(NOW).toISOString() });
  saveJob(root, dead);
  saveJob(root, done);
  const result = reconcileAll(root, { now: () => new Date(NOW), isAliveFn: () => false });
  assert.equal(result.scanned, 2);
  assert.deepEqual(result.changed.map((j) => j.id), [dead.id]);
  assert.equal(loadJob(root, dead.id)?.status, "interrupted");
  assert.equal(loadJob(root, done.id)?.status, "done");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a second reconcile of an orphaned job performs NO extra write (idempotent, no rerun)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-reconcile-noop-"));
  const job = runningJob({ childPid: 12345, childGeneration: 0 });
  saveJob(root, job);
  const opts = { now: () => new Date(NOW), isAliveFn: () => false, isChildAliveFn: () => false };
  const first = reconcileAll(root, opts);
  assert.equal(first.changed.length, 1);
  assert.equal(loadJob(root, job.id)?.status, "orphaned");
  const before = fs.readFileSync(jobPath(root, job.id), "utf8");
  const second = reconcileAll(root, opts);
  assert.equal(second.changed.length, 0, "an orphaned job must not be re-reconciled");
  const after = fs.readFileSync(jobPath(root, job.id), "utf8");
  assert.equal(after, before, "a repeat reconcile must not rewrite the record");
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JQ-20261006-58: reconciliation must not settle a provider-owned out-of-tree
// turn from managed-tree proof alone.
// ---------------------------------------------------------------------------

const RECONCILE = { isAliveFn: () => false, isChildAliveFn: () => false, isTreeConfirmedFn: () => true };

function wbJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return runningJob({ provider: WORKBUDDY_AI_PROVIDER, sessionId: "sess-wb-1", childPid: 2147483646, childGeneration: 0, ...overrides });
}

test("a stale dead-owner WorkBuddy turn is NOT settled from a persisted tree confirmation while its cleanup is unresolved (JQ-20261006-58)", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop owns the out-of-tree turn only on Windows/macOS" }, () => {
  const job = wbJob();
  assert.equal(providerTurnUnresolved(job), true);
  const next = reconcileJob(job, NOW, RECONCILE);
  assert.ok(next);
  assert.equal(next.status, "orphaned");
  assert.equal(next.stopReason, "provider_turn_unresolved");
  assert.equal(next.childPid, 2147483646, "ownership evidence is retained");
  assert.equal(next.finishedAt, null);
  assert.equal(isTerminalStatus(next.status), false);

  // Control: the same shape under Command Code still settles (managed-tree-only).
  const cc = runningJob({ childPid: 2147483646, childGeneration: 0 });
  assert.equal(reconcileJob(cc, NOW, RECONCILE)?.status, "interrupted");
});

test("a persisted cancelIntent never lets reconcile settle a provider-owned turn (JQ-20261006-58)", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop owns the out-of-tree turn only on Windows/macOS" }, () => {
  const intent = { requested: true, requestedAt: new Date(NOW).toISOString(), by: "test" };
  assert.equal(reconcileJob(wbJob({ cancelIntent: intent }), NOW, RECONCILE)?.status, "orphaned");
  const cc = runningJob({ childPid: 2147483646, childGeneration: 0, cancelIntent: intent });
  assert.equal(reconcileJob(cc, NOW, RECONCILE)?.status, "cancelled", "managed-tree-only behavior is preserved");
});

test("only a CURRENT-generation resolved cleanup permits settle; a stale generation does not (JQ-20261006-58)", { skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop owns the out-of-tree turn only on Windows/macOS" }, () => {
  const resolvedCleanup = {
    state: "no_owned_work" as const,
    provider: WORKBUDDY_AI_PROVIDER,
    generation: 0,
    route: null,
    sessionId: "sess-wb-1",
    survivingPids: [],
    detail: null,
    at: new Date(NOW).toISOString(),
    by: "test"
  };
  const current = wbJob({ cancelCleanup: resolvedCleanup });
  assert.equal(providerTurnUnresolved(current), false);
  assert.equal(reconcileJob(current, NOW, RECONCILE)?.status, "interrupted");

  const stale = wbJob({ generation: 1, childGeneration: 1, cancelCleanup: resolvedCleanup });
  assert.equal(providerTurnUnresolved(stale), true, "a previous generation's cleanup is never current proof");
  assert.equal(reconcileJob(stale, NOW, RECONCILE)?.status, "orphaned");
});

test("a queued / never-started WorkBuddy job (no session) is unaffected by the provider-turn guard (JQ-20261006-58)", () => {
  const queued = runningJob({ provider: WORKBUDDY_AI_PROVIDER, sessionId: null, childPid: null, childGeneration: null });
  assert.equal(providerTurnUnresolved(queued), false);
  assert.equal(reconcileJob(queued, NOW, { isAliveFn: () => false })?.status, "interrupted");
});
