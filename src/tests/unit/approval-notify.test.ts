// approval-notify.test.ts — unit coverage of the provider-neutral APPROVAL wake:
// one typed `approval_required` event under ANY provider id, at-most-once
// claim/dedup, stale/resolved/expired/cancelled/terminal suppression, honest
// no-target/no-Hub/transport diagnostics without state mutation, and the safe
// Codex approval message (no result-collection instruction).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL_WAKE_MESSAGE_CAP,
  buildApprovalWakeMessage,
  buildCodexApprovalWakeArgs,
  buildCodexQueueSpawn,
  deliverTerminalNotification,
  type DeliveryDeps
} from "../../mcp/notify";
import {
  APPROVAL_OPERATION_CAP,
  approvalHubLink,
  approvalOperationSummary,
  deliverApprovalNotification,
  notificationCallbackBody,
  type ApprovalRequiredNotificationEvent
} from "../../jobs/notifications";
import { createJobRecord } from "../../jobs/service";
import {
  approvalDecisionPath,
  approvalRequestPath,
  claimApprovalDecision,
  clearPendingApproval,
  readApprovalDecision,
  writePendingApproval,
  type PendingApproval
} from "../../jobs/approval";
import { writeHubEndpoint } from "../../hub/endpoint";
import {
  approvalNotificationClaimPath,
  approvalNotificationResultPath,
  ensureRoot,
  loadJob,
  readApprovalNotificationResult,
  readApprovalNotificationResults,
  saveJob,
  writeTerminalSnapshot
} from "../../jobs/store";

const UUID = "12345678-1234-1234-1234-123456789abc";
const HUB_PORT = 43210;
const TASK_MARKER = "TASK_MARKER_approval_wake_must_never_carry";
const COMMAND = "node jq-asar-extract.cjs --out wb-main";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-approval-notify-"));
}

function pendingFor(jobId: string, generation: number, provider = "workbuddy-ai", requestId = "req-1"): PendingApproval {
  return {
    version: 1,
    kind: "tool_approval",
    provider,
    jobId,
    generation,
    requestId,
    toolName: "Bash",
    summary: null,
    detail: {
      command: COMMAND,
      args: null,
      description: "Extract main/*.js",
      path: null,
      cwd: "C:/workspace",
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    },
    options: [
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ],
    createdAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
}

interface RunningJob {
  root: string;
  jobId: string;
  requestId: string;
  approval: PendingApproval;
}

/** A RUNNING job whose pending approval is materialized on disk exactly like the provider bridge does. */
function runningJob(provider = "workbuddy-ai", requestId = "req-1"): RunningJob {
  const root = tmpRoot();
  ensureRoot(root);
  const job = createJobRecord({
    task: TASK_MARKER,
    cwd: root,
    provider,
    model: "fixture-model",
    notifyTarget: { kind: "callback", callbackUrl: "http://127.0.0.1:9/wake", codexThreadId: null, source: "callback_url" }
  });
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const approval = writePendingApproval(root, pendingFor(job.id, job.generation, provider, requestId));
  job.pendingApproval = approval;
  saveJob(root, job);
  return { root, jobId: job.id, requestId, approval };
}

/** A proven-Hub ping response, or a non-CrewDispatch one, or a dead listener. */
function pingFetch(service = "jobquay"): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ ok: true, service }) })) as unknown as typeof fetch;
}

const deadFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function hubRoot(root: string): void {
  writeHubEndpoint(root, { port: HUB_PORT, pid: process.pid, instanceId: "test-instance" });
}

function capturePost(bodies: string[]): NonNullable<DeliveryDeps["httpPostFn"]> {
  return async (_url, body) => {
    bodies.push(body);
    return { delivered: true, reason: null };
  };
}

function deps(extra: DeliveryDeps = {}): DeliveryDeps {
  return { env: {}, fetchFn: pingFetch(), ...extra };
}

test("a pending approval wakes the original callback once with the SAME typed event under any provider id", async () => {
  for (const provider of ["workbuddy-ai", "command-code"]) {
    const { root, jobId, requestId } = runningJob(provider);
    hubRoot(root);
    const bodies: string[] = [];
    const rec = await deliverApprovalNotification(root, jobId, 0, requestId, deps({ httpPostFn: capturePost(bodies) }), { by: "worker" });
    assert.ok(rec, `[${provider}] a live pending approval must be delivered`);
    assert.equal(rec!.delivered, true);
    assert.equal(rec!.kind, "callback");
    assert.equal(rec!.by, "worker");
    assert.equal(bodies.length, 1, `[${provider}] exactly one callback`);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ["cwd", "event", "expires_at", "generation", "hub_url", "job_id", "operation", "provider", "request_id", "tool"],
      `[${provider}] the approval body schema is explicit and provider-neutral`
    );
    assert.equal(body.event, "approval_required");
    assert.equal(body.job_id, jobId);
    assert.equal(body.generation, 0);
    assert.equal(body.request_id, requestId);
    assert.equal(body.provider, provider);
    assert.equal(body.tool, "Bash");
    assert.equal(body.operation, COMMAND);
    assert.equal(body.cwd, "C:/workspace");
    assert.equal(body.hub_url, `http://127.0.0.1:${HUB_PORT}/ui?job=${encodeURIComponent(jobId)}&generation=0&request=${encodeURIComponent(requestId)}`);
    assert.equal("status" in body, false, `[${provider}] an approval body never fabricates a terminal status`);
    assert.equal(bodies[0]!.includes(TASK_MARKER), false, "never the task text");
    const persisted = readApprovalNotificationResult(root, jobId, 0, requestId);
    assert.deepEqual(persisted, rec, "the delivery outcome is durable in its own result file");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate and concurrent requests deliver exactly one alert; the same request id in another job stays independent", async () => {
  const a = runningJob("workbuddy-ai", "shared-id");
  hubRoot(a.root);
  const bodies: string[] = [];
  const run = () => deliverApprovalNotification(a.root, a.jobId, 0, "shared-id", deps({ httpPostFn: capturePost(bodies) }));
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(bodies.length, 1, "concurrent duplicates share ONE attempt");
  assert.equal([first, second].filter((r) => r !== null).length, 1, "exactly one caller wins the claim");
  assert.equal(await run(), null, "a repeat event after the claim is a no-op");
  assert.equal(bodies.length, 1);

  // A DIFFERENT job with the same provider request id has its own identity.
  const b = runningJob("command-code", "shared-id");
  hubRoot(b.root);
  const otherBodies: string[] = [];
  const rec = await deliverApprovalNotification(b.root, b.jobId, 0, "shared-id", deps({ httpPostFn: capturePost(otherBodies) }));
  assert.ok(rec?.delivered);
  assert.equal(otherBodies.length, 1, "the same request id in another job is delivered independently");
  fs.rmSync(a.root, { recursive: true, force: true });
  fs.rmSync(b.root, { recursive: true, force: true });
});

test("stale, resolved, replaced, expired, cancelled, terminal and generation-mismatched approvals are suppressed before any claim", async () => {
  const cases: Array<{ name: string; root: string; jobId: string }> = [];
  const withJob = (name: string, mutate: (root: string, jobId: string) => void): void => {
    const ws = runningJob();
    hubRoot(ws.root);
    mutate(ws.root, ws.jobId);
    cases.push({ name, root: ws.root, jobId: ws.jobId });
  };
  withJob("a claimed decision", (root, jobId) => {
    claimApprovalDecision(root, {
      version: 1,
      jobId,
      generation: 0,
      requestId: "req-1",
      optionId: "allow",
      kind: "allow_once",
      decidedAt: new Date().toISOString(),
      by: "hub"
    });
  });
  withJob("an expired request", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.pendingApproval!.expiresAt = new Date(Date.now() - 1000).toISOString();
    saveJob(root, job);
  });
  withJob("a replaced request", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.pendingApproval!.requestId = "req-2";
    saveJob(root, job);
  });
  withJob("a cancelled job", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.cancelIntent = { requested: true, requestedAt: new Date().toISOString(), by: "cancel" };
    saveJob(root, job);
  });
  withJob("a terminal job", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    saveJob(root, job);
  });
  withJob("a later generation", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.generation = 1;
    saveJob(root, job);
  });
  withJob("a removed provider request file", (root, jobId) => {
    clearPendingApproval(root, jobId, 0, "req-1");
  });

  for (const entry of cases) {
    const bodies: string[] = [];
    const rec = await deliverApprovalNotification(entry.root, entry.jobId, 0, "req-1", deps({ httpPostFn: capturePost(bodies) }));
    assert.equal(rec, null, `${entry.name} must be suppressed`);
    assert.equal(bodies.length, 0, `${entry.name} must not call anyone`);
    assert.equal(
      fs.existsSync(approvalNotificationClaimPath(entry.root, entry.jobId, 0, "req-1")),
      false,
      `${entry.name} is rejected BEFORE the at-most-once claim`
    );
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

test("a missing target or a failed transport is recorded diagnostically and never mutates the job, request or decision", async () => {
  // (a) no target at all: recorded, nothing sent.
  const none = runningJob();
  const noneJob = loadJob(none.root, none.jobId)!;
  noneJob.notifyTarget = { kind: "none", callbackUrl: null, codexThreadId: null, source: null };
  saveJob(none.root, noneJob);
  const noneBodies: string[] = [];
  const noneRec = await deliverApprovalNotification(none.root, none.jobId, 0, none.requestId, deps({ httpPostFn: capturePost(noneBodies) }));
  assert.deepEqual({ delivered: noneRec!.delivered, reason: noneRec!.reason, kind: noneRec!.kind }, { delivered: false, reason: "no_target", kind: "none" });
  assert.equal(noneBodies.length, 0);

  // (b) the callback rejects: recorded, state untouched.
  const failed = runningJob();
  hubRoot(failed.root);
  const requestPath = approvalRequestPath(failed.root, failed.jobId, 0, failed.requestId);
  const beforeJob = JSON.stringify(loadJob(failed.root, failed.jobId));
  const beforeRequest = fs.readFileSync(requestPath, "utf8");
  const failedRec = await deliverApprovalNotification(failed.root, failed.jobId, 0, failed.requestId, deps({
    httpPostFn: async () => ({ delivered: false, reason: "http_status_500" })
  }));
  assert.equal(failedRec!.delivered, false);
  assert.equal(failedRec!.reason, "http_status_500");
  assert.equal(JSON.stringify(loadJob(failed.root, failed.jobId)), beforeJob, "the job record is never rewritten by a delivery");
  assert.equal(fs.readFileSync(requestPath, "utf8"), beforeRequest, "the pending request is never rewritten");
  assert.equal(readApprovalDecision(failed.root, failed.jobId, 0, failed.requestId), null, "no decision is fabricated");
  assert.equal(fs.existsSync(approvalDecisionPath(failed.root, failed.jobId, 0, failed.requestId)), false);
  assert.equal(
    fs.existsSync(approvalNotificationResultPath(failed.root, failed.jobId, 0, failed.requestId)),
    true,
    "the failure is durable diagnostic evidence"
  );
  fs.rmSync(none.root, { recursive: true, force: true });
  fs.rmSync(failed.root, { recursive: true, force: true });
});

test("no proven Hub means no fabricated link: the attempt is recorded as no_hub and nobody is called", async () => {
  const missing = runningJob(); // no endpoint marker at all
  const missingBodies: string[] = [];
  const missingRec = await deliverApprovalNotification(missing.root, missing.jobId, 0, missing.requestId, deps({
    fetchFn: deadFetch,
    httpPostFn: capturePost(missingBodies)
  }));
  assert.deepEqual({ delivered: missingRec!.delivered, reason: missingRec!.reason }, { delivered: false, reason: "no_hub" });
  assert.equal(missingBodies.length, 0);

  const foreign = runningJob();
  hubRoot(foreign.root); // marker exists, but the listener is not a CrewDispatch Hub
  const foreignBodies: string[] = [];
  const foreignRec = await deliverApprovalNotification(foreign.root, foreign.jobId, 0, foreign.requestId, deps({
    fetchFn: pingFetch("someone-else"),
    httpPostFn: capturePost(foreignBodies)
  }));
  assert.deepEqual({ delivered: foreignRec!.delivered, reason: foreignRec!.reason }, { delivered: false, reason: "no_hub" });
  assert.equal(foreignBodies.length, 0);
  fs.rmSync(missing.root, { recursive: true, force: true });
  fs.rmSync(foreign.root, { recursive: true, force: true });
});

test("the Codex approval wake is a safe argv carrying identity/operation/link and NO result-collection instruction", async () => {
  const event: ApprovalRequiredNotificationEvent = {
    event: "approval_required",
    jobId: "job-approval-1",
    generation: 2,
    requestId: "req-9",
    provider: "workbuddy-ai",
    toolName: "Bash",
    operation: `${COMMAND}\nsecond line must be flattened`,
    cwd: "C:/workspace",
    hubUrl: `http://127.0.0.1:${HUB_PORT}/ui?job=job-approval-1&generation=2&request=req-9`,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const message = buildApprovalWakeMessage(event);
  assert.ok(message.includes("job-approval-1"), "job identity");
  assert.ok(message.includes("run 3"), "the human run number is generation + 1, matching the Dashboard");
  assert.ok(message.includes(COMMAND), "the bounded actual operation");
  assert.ok(message.includes(`/ui?job=job-approval-1`), "the exact Hub deep link");
  assert.match(message, /waiting for human approval/i, "the job is waiting, not terminal");
  assert.match(message, /do not call crewdispatch_result/i, "the caller is told not to collect a result");
  assert.match(message, /do not approve automatically/i, "the caller is told not to auto-approve");
  assert.equal(message.includes("exactly once to collect"), false, "no result-collection instruction");
  assert.equal(message.includes("\n"), false, "the message is one line");
  assert.ok(message.length <= APPROVAL_WAKE_MESSAGE_CAP, `bounded message (${message.length} <= ${APPROVAL_WAKE_MESSAGE_CAP})`);

  const args = buildCodexApprovalWakeArgs(UUID, event);
  assert.deepEqual(args, ["queue", "--thread", UUID, "--message", message]);
  assert.equal(buildCodexApprovalWakeArgs("bad id!", event), null, "an invalid thread id never gets an argv");
  const spawn = buildCodexQueueSpawn("codex", args!, { platform: "linux", env: {} });
  assert.equal(spawn.file, "codex");
  assert.equal(spawn.shellShim, null);

  // An over-long operation is clipped with an explicit mark, never reported as
  // absent and never allowed to push the complete link out of the message.
  const long = buildApprovalWakeMessage({ ...event, operation: "x".repeat(5000) });
  assert.ok(long.length <= APPROVAL_WAKE_MESSAGE_CAP, `long operation stays bounded (${long.length})`);
  assert.match(long, /Operation: x+ \[truncated\]/, "a clipped operation is explicitly marked");
  assert.equal(long.includes("not provided"), false, "budget pressure never fabricates an absence");
  assert.ok(long.includes(event.hubUrl), "the complete link survives clipping");
  assert.equal(long.includes("\n"), false);

  // End-to-end through the codex transport: the recorded argv carries exactly
  // this message, spawned shell-free.
  const ws = runningJob("workbuddy-ai", "req-9");
  hubRoot(ws.root);
  const job = loadJob(ws.root, ws.jobId)!;
  job.notifyTarget = { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" };
  saveJob(ws.root, job);
  const calls: Array<{ file: string; args: readonly string[]; options: { shell?: boolean; windowsHide?: boolean } }> = [];
  class FakeChild extends EventEmitter {
    kill(): boolean {
      return true;
    }
  }
  const spawnFn = ((file: string, spawned: readonly string[], options: { shell?: boolean; windowsHide?: boolean }) => {
    calls.push({ file, args: spawned, options });
    const child = new FakeChild();
    setImmediate(() => child.emit("close", 0));
    return child;
  }) as unknown as NonNullable<DeliveryDeps["spawnFn"]>;
  const rec = await deliverApprovalNotification(ws.root, ws.jobId, 0, "req-9", deps({
    platform: "linux",
    codexCliPath: "codex",
    spawnFn
  }));
  assert.equal(rec!.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.shell, false, "the Codex wake is shell-free");
  assert.deepEqual(calls[0]!.args.slice(0, 4), ["queue", "--thread", UUID, "--message"]);
  const sent = calls[0]!.args[4]!;
  assert.ok(sent.includes(ws.jobId));
  assert.equal(sent.includes("exactly once to collect"), false);
  fs.rmSync(ws.root, { recursive: true, force: true });
});

/**
 * A Hub ping the TEST controls: `started` resolves once the probe is in flight
 * and `release()` lets it answer, so durable state can change mid-probe.
 */
function deferredPingFetch(): { fetchFn: typeof fetch; started: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const fetchFn = (async () => {
    markStarted();
    await gate;
    return { ok: true, json: async () => ({ ok: true, service: "jobquay" }) };
  }) as unknown as typeof fetch;
  return { fetchFn, started, release: () => release() };
}

test("a worst-case VALID approval identity keeps the complete link, the real operation and the required guidance", () => {
  const jobId = "j".repeat(128);
  const requestId = "r".repeat(64);
  const generation = 123456789;
  const link = approvalHubLink("http://127.0.0.1:65535", { jobId, generation, requestId });
  const message = buildApprovalWakeMessage({
    event: "approval_required",
    jobId,
    generation,
    requestId,
    provider: "workbuddy-ai",
    toolName: "Bash",
    operation: "echo marker",
    cwd: null,
    hubUrl: link,
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });
  assert.ok(message.length <= APPROVAL_WAKE_MESSAGE_CAP, `worst-case VALID message stays bounded (${message.length} <= ${APPROVAL_WAKE_MESSAGE_CAP})`);
  assert.ok(message.includes(link), "the COMPLETE deep link is present byte-for-byte and is never truncated");
  assert.match(message, /Operation: echo marker\b/, "the published operation is shown");
  assert.equal(message.includes("not provided"), false, "a published operation is never reported absent due to budget");
  assert.equal(message.includes("did not publish"), false);
  assert.equal(message.includes("[truncated]"), false, "an operation that fits is not marked truncated");
  assert.match(message, /waiting for human approval/i, "the essential waiting guidance survives");
  assert.match(message, /do not call crewdispatch_result/i, "the essential do-not-collect guidance survives");
  assert.match(message, /do not approve automatically/i, "the essential do-not-auto-approve guidance survives");
  assert.ok(message.includes("run 123456790"), "the human run number is generation + 1");
  assert.equal(message.includes("\n"), false);
});

test("an extreme valid request id and run number still keep the complete link under the documented bound", () => {
  const jobId = "j".repeat(128);
  const requestId = "é".repeat(128); // 128 UTF-16 code units -> the worst-case percent encoding
  const generation = Number.MAX_SAFE_INTEGER;
  const link = approvalHubLink("http://127.0.0.1:65535", { jobId, generation, requestId });
  const message = buildApprovalWakeMessage({
    event: "approval_required",
    jobId,
    generation,
    requestId,
    provider: "workbuddy-ai",
    toolName: null,
    operation: "echo marker",
    cwd: null,
    hubUrl: link,
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });
  assert.ok(message.length <= APPROVAL_WAKE_MESSAGE_CAP, `the documented bound covers the extreme valid identity (${message.length} <= ${APPROVAL_WAKE_MESSAGE_CAP})`);
  assert.ok(message.includes(link), "the complete encoded link survives");
  assert.match(message, /Operation: echo marker\b/);
});

test("a missing operation is stated as absent while the complete link and guidance survive", () => {
  const jobId = "j".repeat(128);
  const requestId = "r".repeat(64);
  const generation = 123456789;
  const link = approvalHubLink("http://127.0.0.1:65535", { jobId, generation, requestId });
  const message = buildApprovalWakeMessage({
    event: "approval_required",
    jobId,
    generation,
    requestId,
    provider: "workbuddy-ai",
    toolName: null,
    operation: null,
    cwd: null,
    hubUrl: link,
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });
  assert.match(message, /Operation: not provided by the provider\./, "an absent operation is stated honestly");
  assert.ok(message.includes(link), "the complete link is present even when no operation exists");
  assert.match(message, /do not call crewdispatch_result/i);
  assert.ok(message.length <= APPROVAL_WAKE_MESSAGE_CAP);
});

test("a request that stops being current while the Hub proof is in flight is suppressed after the claimed attempt", async () => {
  interface CaseEntry {
    name: string;
    reason: string;
    root: string;
    jobId: string;
    mutate: (root: string, jobId: string) => void;
  }
  const entries: CaseEntry[] = [];
  const addCase = (name: string, reason: string, mutate: (root: string, jobId: string) => void): void => {
    const ws = runningJob();
    hubRoot(ws.root);
    entries.push({ name, reason, root: ws.root, jobId: ws.jobId, mutate });
  };

  addCase("a claimed decision", "resolved", (root, jobId) => {
    claimApprovalDecision(root, {
      version: 1,
      jobId,
      generation: 0,
      requestId: "req-1",
      optionId: "allow",
      kind: "allow_once",
      decidedAt: new Date().toISOString(),
      by: "hub"
    });
  });
  addCase("a replaced request", "stale", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.pendingApproval!.requestId = "req-2";
    saveJob(root, job);
  });
  addCase("an expired request", "expired", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.pendingApproval!.expiresAt = new Date(Date.now() - 1000).toISOString();
    saveJob(root, job);
  });
  addCase("a cancelled job", "cancelled", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.cancelIntent = { requested: true, requestedAt: new Date().toISOString(), by: "cancel" };
    saveJob(root, job);
  });
  addCase("a later generation", "stale", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.generation = 1;
    saveJob(root, job);
  });
  addCase("a cleared pending approval", "stale", (root, jobId) => {
    const job = loadJob(root, jobId)!;
    job.pendingApproval = null;
    saveJob(root, job);
  });
  addCase("a removed provider request file", "stale", (root, jobId) => {
    clearPendingApproval(root, jobId, 0, "req-1");
  });

  for (const entry of entries) {
    const posts: string[] = [];
    const deferred = deferredPingFetch();
    const attempt = deliverApprovalNotification(entry.root, entry.jobId, 0, "req-1", deps({
      fetchFn: deferred.fetchFn,
      httpPostFn: capturePost(posts)
    }));
    await deferred.started;
    entry.mutate(entry.root, entry.jobId);
    const stateBefore = JSON.stringify(loadJob(entry.root, entry.jobId));
    deferred.release();
    const rec = await attempt;
    assert.ok(rec, `${entry.name}: the claimed attempt records a durable diagnostic`);
    assert.equal(rec!.delivered, false, `${entry.name}: nothing is delivered`);
    assert.equal(rec!.reason, entry.reason, `${entry.name}: the stable suppression reason is recorded`);
    assert.equal(posts.length, 0, `${entry.name}: the transport adapter is never called`);
    assert.ok(
      fs.existsSync(approvalNotificationResultPath(entry.root, entry.jobId, 0, "req-1")),
      `${entry.name}: the diagnostic lives in the already-claimed result`
    );
    assert.equal(JSON.stringify(loadJob(entry.root, entry.jobId)), stateBefore, `${entry.name}: delivery writes no job state`);
    const again = await deliverApprovalNotification(entry.root, entry.jobId, 0, "req-1", deps({
      fetchFn: deferred.fetchFn,
      httpPostFn: capturePost(posts)
    }));
    assert.equal(again, null, `${entry.name}: the request-level claim is never reopened or retried`);
    assert.equal(posts.length, 0);
    fs.rmSync(entry.root, { recursive: true, force: true });
  }
});

test("the alert uses the original request's captured target, never a later record's target", async () => {
  const ws = runningJob("workbuddy-ai", "req-1");
  hubRoot(ws.root);
  const posts: Array<{ url: string; body: string }> = [];
  const deferred = deferredPingFetch();
  const attempt = deliverApprovalNotification(ws.root, ws.jobId, 0, "req-1", deps({
    fetchFn: deferred.fetchFn,
    httpPostFn: async (url, body) => {
      posts.push({ url, body });
      return { delivered: true, reason: null };
    }
  }));
  await deferred.started;
  // The record's target changes while the probe is in flight (for example a
  // continuation refreshing the destination). The ORIGINAL generation's target,
  // captured when the request was validated, must be the one notified.
  const job = loadJob(ws.root, ws.jobId)!;
  job.notifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:9/later-target", codexThreadId: null, source: "callback_url" };
  saveJob(ws.root, job);
  deferred.release();
  const rec = await attempt;
  assert.equal(rec!.delivered, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, "http://127.0.0.1:9/wake", "the captured original target is notified, not the later record's target");
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("a post-probe suppression never consumes the independent terminal wake", async () => {
  const ws = runningJob("workbuddy-ai", "req-1");
  hubRoot(ws.root);
  const approvalPosts: string[] = [];
  const deferred = deferredPingFetch();
  const attempt = deliverApprovalNotification(ws.root, ws.jobId, 0, "req-1", deps({
    fetchFn: deferred.fetchFn,
    httpPostFn: capturePost(approvalPosts)
  }));
  await deferred.started;
  const job = loadJob(ws.root, ws.jobId)!;
  job.status = "done";
  job.finishedAt = new Date().toISOString();
  job.pendingApproval = null;
  saveJob(ws.root, job);
  deferred.release();
  const rec = await attempt;
  assert.equal(rec!.delivered, false);
  assert.equal(rec!.reason, "stale");
  assert.equal(approvalPosts.length, 0);

  // The approval claim is in its OWN namespace: the terminal wake for the same
  // generation is still claimable and delivers the unchanged short body.
  writeTerminalSnapshot(ws.root, ws.jobId, 0, "done", job.notifyTarget, "test");
  const terminalPosts: string[] = [];
  const terminalRec = await deliverTerminalNotification(ws.root, ws.jobId, deps({ httpPostFn: capturePost(terminalPosts) }), { generation: 0 });
  assert.equal(terminalRec!.delivered, true);
  assert.deepEqual(Object.keys(JSON.parse(terminalPosts[0]!)).sort(), ["job_id", "status"]);
  fs.rmSync(ws.root, { recursive: true, force: true });
});

test("the terminal callback body stays byte-compatible; the operation summary is command/title/description/tool and bounded", () => {
  assert.equal(
    notificationCallbackBody({ event: "terminal", jobId: "job-1", generation: 3, status: "done" }),
    JSON.stringify({ job_id: "job-1", status: "done" })
  );
  assert.equal(notificationCallbackBody({ event: "terminal", jobId: "job-1", generation: 3, status: "error" }).includes("generation"), false);

  const approval = pendingFor("job-1", 0);
  assert.equal(approvalOperationSummary(approval), COMMAND, "the actual command wins");
  assert.equal(approvalOperationSummary({ detail: { ...approval.detail!, command: null }, summary: null, toolName: "Bash" }), "Extract main/*.js", "description before tool");
  assert.equal(approvalOperationSummary({ detail: null, summary: null, toolName: "Bash" }), "Bash", "tool-name fallback");
  assert.equal(approvalOperationSummary({ detail: null, summary: null, toolName: null }), null, "nothing published stays null");
  const bounded = approvalOperationSummary({ detail: { ...approval.detail!, command: "y".repeat(APPROVAL_OPERATION_CAP + 50) }, summary: null, toolName: null });
  assert.equal(bounded!.length, APPROVAL_OPERATION_CAP);

  // Separately supplied argv: the summary is DISPLAY NOTATION, not a runnable
  // shell command line. Simple tokens stay compact; anything non-simple —
  // an empty or whitespace-only entry, a spaced/quoted value, a glob or any
  // shell metacharacter — switches the whole list to an explicitly labelled
  // JSON array, and an empty argument is never dropped.
  const withArgs = (args: string[]): string | null =>
    approvalOperationSummary({ detail: { ...approval.detail!, command: "node", args }, summary: null, toolName: null });
  assert.equal(withArgs(["wait-for-resume.cjs"]), "node wait-for-resume.cjs", "simple tokens stay compact");
  assert.equal(withArgs(["", "next"]), 'node args:["","next"]', "an empty argument is kept and labelled, never dropped");
  assert.equal(withArgs(["a b"]), 'node args:["a b"]', "a spaced value is shown as labelled JSON");
  assert.equal(withArgs(["*.cjs"]), 'node args:["*.cjs"]', "a star glob is not presented as a plain token");
  assert.equal(withArgs(["file?.txt"]), 'node args:["file?.txt"]', "a question-mark glob is not presented as a plain token");
  assert.equal(withArgs(["--flag", "value"]), "node --flag value", "ordinary flags stay compact");
  // The summary is ONE line by contract, so whitespace runs collapse inside the
  // notation (the exact bytes are on the approval card); the entry itself is
  // still present and counted.
  assert.equal(withArgs(["  "]), 'node args:[" "]', "a whitespace-only entry stays present in the labelled list");
  assert.equal(withArgs(["a  b"]), 'node args:["a b"]', "the one-line notation collapses internal runs");

  assert.equal(
    approvalHubLink("http://127.0.0.1:30080/", approval),
    `http://127.0.0.1:30080/ui?job=job-1&generation=0&request=req-1`
  );
});

test("every approval-wake result is namespace-scoped and the terminal result scanner never sees it", async () => {
  const ws = runningJob();
  hubRoot(ws.root);
  await deliverApprovalNotification(ws.root, ws.jobId, 0, ws.requestId, deps({ httpPostFn: capturePost([]) }));
  const results = readApprovalNotificationResults(ws.root, ws.jobId);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.requestId, ws.requestId);
  assert.equal(results[0]!.generation, 0);
  // The terminal claim/result namespace is untouched: no terminal claim file
  // exists for this generation, so a later terminal wake is still possible.
  assert.equal(fs.existsSync(path.join(ws.root, "notify", `${ws.jobId}.gen-0.claim`)), false);
  assert.equal(fs.existsSync(path.join(ws.root, "notify", `${ws.jobId}.gen-0.result.json`)), false);
  const claim = path.join(ws.root, "notify", "approval");
  assert.ok(fs.readdirSync(claim).some((name) => name.endsWith(".approval.claim")), "the approval claim lives in its own subdirectory");
  fs.rmSync(ws.root, { recursive: true, force: true });
});
