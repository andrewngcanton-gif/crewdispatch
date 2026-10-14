// notification-recovery.test.ts — unit coverage of the bounded local caller
// notification recovery: transport-PHASE-based eligibility, exact-session
// targeting, the ONE-additional-attempt budget, the conditional recovered text,
// result-read receipt suppression, and the approval revalidation races.
//
// Real local sockets stand in for the native inbox ON THE WIRE ONLY; no Claude
// host, model or network is involved. Durable state is built with the SAME
// store functions the product uses, so the tests exercise the real files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { listClaudeBindings, registerClaudeBinding } from "../../claude/binding";
import { claudeNotificationTransport } from "../../claude/transport";
import {
  requestClaudeSessionRecovery,
  RECOVERY_REQUEST_BUDGET_MS,
  RECOVERY_REQUEST_TIMEOUT_MS,
  START_TIMEOUT_MS as DAEMON_START_TIMEOUT_MS
} from "../../daemon/client";
import { createJobRecord } from "../../jobs/service";
import {
  approvalDecisionPath,
  claimApprovalDecision,
  writePendingApproval,
  type PendingApproval
} from "../../jobs/approval";
import { writeHubEndpoint } from "../../hub/endpoint";
import {
  claimTerminalRecoveryAttempt,
  ensureRoot,
  loadJob,
  readApprovalRecoveryResult,
  readTerminalRecoveryResult,
  readTerminalReadReceipt,
  saveJob,
  terminalReadReceiptPath,
  terminalRecoveryClaimPath,
  writeApprovalNotificationResult,
  writeNotificationResult,
  writeTerminalReadReceipt,
  writeTerminalRecoveryResult
} from "../../jobs/store";
import {
  runRecoveryPass,
  targetSessionId,
  terminalRecoveryVerdict,
  RECOVERY_MAX_JOBS_PER_PASS,
  type RecoveryPassOptions
} from "../../jobs/recovery";
import { deliverNotificationEvent, registerNotificationTransport } from "../../jobs/notifications";
import type { JobRecord, NotifyTarget, NotificationRecord } from "../../jobs/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "99999999-8888-4777-8666-555555555555";
const TOKEN = "native-token-recovery-marker-0123456789";
const HUB_PORT = 43211;
const TASK_MARKER = "TASK_MARKER_recovery_must_never_carry";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-recovery-"));
}

function pipePath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crewdispatch-recovery-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `crewdispatch-recovery-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

interface Inbox {
  address: string;
  frames: string[];
  close: () => Promise<void>;
}

/** A real local inbox endpoint that records the raw newline-delimited frames. */
function startInbox(name = "accept"): Promise<Inbox> {
  const address = pipePath(name);
  const frames: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = "";
    socket.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
    });
    socket.on("end", () => {
      frames.push(buf);
      socket.end();
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      resolve({
        address,
        frames,
        close: () =>
          new Promise<void>((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          })
      });
    });
  });
}

function claudeTarget(sessionId: string | null, bindingId: string | null = null): NotifyTarget {
  return {
    kind: "claude_session",
    callbackUrl: null,
    codexThreadId: null,
    claudeSessionId: sessionId,
    claudeBindingId: bindingId,
    source: sessionId ? "claude_session_id" : bindingId ? "claude_binding_id" : null
  };
}

interface JobSpec {
  target?: NotifyTarget;
  generation?: number;
  status?: JobRecord["status"];
}

/** Persist a terminal (by default) job bound to the supplied target. */
function makeJob(root: string, spec: JobSpec = {}): JobRecord {
  const job = createJobRecord({ task: TASK_MARKER, cwd: root, notifyTarget: spec.target ?? claudeTarget(SESSION) });
  job.generation = spec.generation ?? 0;
  job.status = spec.status ?? "done";
  job.startedAt = new Date().toISOString();
  job.finishedAt = job.status === "running" ? null : new Date().toISOString();
  saveJob(root, job);
  return job;
}

/** The ORIGINAL terminal-wake result of one generation. */
function writeOriginal(root: string, jobId: string, generation: number, extra: Partial<NotificationRecord> = {}): void {
  writeNotificationResult(root, jobId, generation, {
    generation,
    kind: "claude_session",
    attemptedAt: new Date().toISOString(),
    delivered: false,
    reason: "inbox_unreachable",
    by: "worker",
    phase: "not_written",
    ...extra
  });
}

/** A RUNNING job whose pending approval is materialized on disk, bound to the session. */
function runningApprovalJob(root: string, requestId = "req-1"): { job: JobRecord; approval: PendingApproval } {
  const job = makeJob(root, { status: "running" });
  const approval = writePendingApproval(root, {
    version: 1,
    kind: "tool_approval",
    provider: "command-code",
    jobId: job.id,
    generation: job.generation,
    requestId,
    toolName: "Bash",
    summary: null,
    detail: {
      command: "node build.cjs",
      args: null,
      description: null,
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
  });
  job.pendingApproval = approval;
  saveJob(root, job);
  return { job, approval };
}

function writeApprovalOriginal(root: string, jobId: string, generation: number, requestId: string, phase: NotificationRecord["phase"] = "not_written"): void {
  writeApprovalNotificationResult(root, jobId, generation, {
    generation,
    requestId,
    kind: "claude_session",
    attemptedAt: new Date().toISOString(),
    delivered: false,
    reason: "inbox_unreachable",
    by: "worker",
    phase
  });
}

function pingFetch(): typeof fetch {
  return (async () => ({ ok: true, json: async () => ({ ok: true, service: "jobquay" }) })) as unknown as typeof fetch;
}

function passDeps(extra: Record<string, unknown> = {}): RecoveryPassOptions["deps"] {
  return { env: {}, fetchFn: pingFetch(), timeoutMs: 3000, ...extra };
}

/** The message content of the n-th received frame group. */
function contentOf(inbox: Inbox, index: number): string {
  const lines = inbox.frames[index]!.split("\n").filter(Boolean);
  return (JSON.parse(lines[1]!) as { message: { content: string } }).message.content;
}

function tokenOf(inbox: Inbox, index: number): string {
  const lines = inbox.frames[index]!.split("\n").filter(Boolean);
  return (JSON.parse(lines[0]!) as { token: string }).token;
}

// ---------------------------------------------------------------------------
// Eligibility verdicts (pure)
// ---------------------------------------------------------------------------

test("terminal recovery eligibility follows the phase evidence and the exact session", () => {
  const root = tmpRoot();
  ensureRoot(root);
  try {
    // A callback target is never a recovery candidate.
    const callbackJob = makeJob(root, { target: { kind: "callback", callbackUrl: "http://127.0.0.1:9/wake", codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: "callback_url" } });
    assert.deepEqual(terminalRecoveryVerdict(root, callbackJob, SESSION), { eligible: false, reason: "not_claude_target" });

    // A job still running is not a terminal event.
    const running = makeJob(root, { status: "running" });
    assert.deepEqual(terminalRecoveryVerdict(root, running, SESSION), { eligible: false, reason: "not_terminal" });

    // Another session's target never matches.
    const other = makeJob(root, { target: claudeTarget(SESSION_B) });
    writeOriginal(root, other.id, 0);
    assert.deepEqual(terminalRecoveryVerdict(root, other, SESSION), { eligible: false, reason: "target_session_mismatch" });

    // A binding-only target whose binding record is gone cannot be tied: fail closed.
    const gone = makeJob(root, { target: claudeTarget(null, "a".repeat(32)) });
    writeOriginal(root, gone.id, 0);
    assert.deepEqual(terminalRecoveryVerdict(root, gone, SESSION), { eligible: false, reason: "target_session_unresolved" });

    // No original attempt at all is missing evidence, never eligibility.
    const none = makeJob(root);
    assert.deepEqual(terminalRecoveryVerdict(root, none, SESSION), { eligible: false, reason: "no_original_attempt" });

    // A successful original is never repeated.
    const delivered = makeJob(root);
    writeOriginal(root, delivered.id, 0, { delivered: true, reason: null, phase: "handoff" });
    assert.deepEqual(terminalRecoveryVerdict(root, delivered, SESSION), { eligible: false, reason: "original_delivered" });

    // An old record WITHOUT phase evidence is UNKNOWN and never eligible.
    const legacy = makeJob(root);
    writeOriginal(root, legacy.id, 0, { phase: null });
    assert.deepEqual(terminalRecoveryVerdict(root, legacy, SESSION), { eligible: false, reason: "original_phase_unknown" });

    // A write that already began (partial/held/timeout-after-write) is uncertain.
    const started = makeJob(root);
    writeOriginal(root, started.id, 0, { phase: "writing_started" });
    assert.deepEqual(terminalRecoveryVerdict(root, started, SESSION), { eligible: false, reason: "original_write_started" });

    // An already collected generation is suppressed.
    const collected = makeJob(root);
    writeOriginal(root, collected.id, 0);
    writeTerminalReadReceipt(root, collected.id, 0, "mcp-result");
    assert.deepEqual(terminalRecoveryVerdict(root, collected, SESSION), { eligible: false, reason: "already_collected" });

    // A consumed recovery budget is never reopened.
    const recovered = makeJob(root);
    writeOriginal(root, recovered.id, 0);
    writeTerminalRecoveryResult(root, recovered.id, 0, {
      event: "terminal",
      generation: 0,
      requestId: null,
      attemptedAt: new Date().toISOString(),
      delivered: true,
      reason: null,
      by: "claude-session-start"
    });
    assert.deepEqual(terminalRecoveryVerdict(root, recovered, SESSION), { eligible: false, reason: "already_recovered" });

    // The observed failure shape IS eligible.
    const ok = makeJob(root);
    writeOriginal(root, ok.id, 0);
    assert.deepEqual(terminalRecoveryVerdict(root, ok, SESSION), { eligible: true, generation: 0, status: "done" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetSessionId ties a session reference directly and a binding reference through its record", () => {
  const root = tmpRoot();
  ensureRoot(root);
  try {
    assert.equal(targetSessionId(root, claudeTarget(SESSION)), SESSION);
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: pipePath("tie"), token: TOKEN });
    assert.equal(targetSessionId(root, claudeTarget(null, binding.bindingId)), SESSION);
    assert.equal(targetSessionId(root, claudeTarget(null, "b".repeat(32))), null, "a gone binding record cannot be tied");
    assert.equal(targetSessionId(root, claudeTarget(null, null)), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The bounded pass: the observed failure shape and its budget
// ---------------------------------------------------------------------------

test("a reopened session recovers the provably-lost terminal wake exactly once, to the CURRENT binding", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("recover");
  try {
    // Original registration (the inbox the job was dispatched against) and its
    // provably not-written failure — the recorded shape of the defect.
    const original = registerClaudeBinding(root, { sessionId: SESSION, socket: pipePath("original-dead"), token: "old-token" });
    const job = makeJob(root);
    writeOriginal(root, job.id, 0);

    // The SAME session reopens: a NEW private binding with a live inbox.
    const live = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    assert.notEqual(live.bindingId, original.bindingId);

    const summary = await runRecoveryPass(root, { sessionId: SESSION, bindingId: live.bindingId, deps: passDeps() });
    assert.equal(summary.scanned, 1);
    assert.equal(summary.matching, 1);
    assert.deepEqual(summary.attempts, [
      { jobId: job.id, event: "terminal", generation: 0, requestId: null, delivered: true, reason: null }
    ]);

    // The wake reached the CURRENT inbox of the EXACT session with its own token.
    assert.equal(inbox.frames.length, 1);
    assert.equal(tokenOf(inbox, 0), TOKEN);
    const content = contentOf(inbox, 0);
    assert.ok(content.includes("recovery"));
    assert.ok(content.includes(job.id));
    assert.ok(content.includes("run 1"));
    assert.ok(content.includes("has not already been collected"));
    assert.equal(content.includes(TASK_MARKER), false, "the recovered wake never carries the task");
    assert.equal(content.includes(TOKEN), false, "the recovered wake never carries the token");

    // The recovery outcome is durable in its own sidecar.
    const persisted = readTerminalRecoveryResult(root, job.id, 0);
    assert.equal(persisted?.delivered, true);
    assert.equal(persisted?.by, "claude-session-start");

    // ONE additional attempt per exact event: a repeated pass sends nothing.
    const again = await runRecoveryPass(root, { sessionId: SESSION, bindingId: live.bindingId, deps: passDeps() });
    assert.equal(again.attempts.length, 0);
    assert.equal(inbox.frames.length, 1);
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repeated rebinding keeps ONE allowance and a stale registration never spends it", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inboxA = await startInbox("rebind-a");
  const inboxB = await startInbox("rebind-b");
  try {
    const first = registerClaudeBinding(root, { sessionId: SESSION, socket: inboxA.address, token: "token-a" });
    const job = makeJob(root);
    writeOriginal(root, job.id, 0);

    // Rebind: the FIRST binding id is now stale (the same session reopened
    // against a new inbox).
    const second = registerClaudeBinding(root, { sessionId: SESSION, socket: inboxB.address, token: "token-b" });
    assert.notEqual(second.bindingId, first.bindingId);

    // A STALE registration request (the old binding id) must not claim or send:
    // the newer registration's budget stays untouched.
    const stale = await runRecoveryPass(root, { sessionId: SESSION, bindingId: first.bindingId, deps: passDeps() });
    assert.equal(stale.attempts.length, 0);
    assert.equal(readTerminalRecoveryResult(root, job.id, 0), null, "a stale request consumes nothing");
    assert.equal(inboxA.frames.length, 0);
    assert.equal(inboxB.frames.length, 0);

    // The CURRENT registration still gets its ONE attempt, on the new inbox.
    const current = await runRecoveryPass(root, { sessionId: SESSION, bindingId: second.bindingId, deps: passDeps() });
    assert.equal(current.attempts.length, 1);
    assert.equal(inboxB.frames.length, 1, "the current binding receives the ONE recovered wake");
    assert.equal(inboxA.frames.length, 0, "the replaced inbox never receives it");

    // Rebinding again does NOT reset the allowance.
    const third = registerClaudeBinding(root, { sessionId: SESSION, socket: pipePath("rebind-c"), token: "token-c" });
    const after = await runRecoveryPass(root, { sessionId: SESSION, bindingId: third.bindingId, deps: passDeps() });
    assert.equal(after.attempts.length, 0);
    assert.equal(inboxB.frames.length, 1);
  } finally {
    await inboxA.close();
    await inboxB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a session rebound mid-pass stops the stale pass before it spends a later event's allowance", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inboxA = await startInbox("midpass-a");
  const inboxB = await startInbox("midpass-b");
  try {
    const first = registerClaudeBinding(root, { sessionId: SESSION, socket: inboxA.address, token: "token-a" });
    const jobA = makeJob(root);
    writeOriginal(root, jobA.id, 0);
    const jobB = makeJob(root);
    writeOriginal(root, jobB.id, 0);

    // The FIRST delivery yields and the session rebinds inside that window: the
    // pass that is still running has gone stale.
    let rebound: string | null = null;
    registerNotificationTransport({
      kind: "claude_session",
      async deliver() {
        rebound = registerClaudeBinding(root, {
          sessionId: SESSION,
          socket: inboxB.address,
          token: "token-b",
          now: () => new Date(Date.now() + 1000)
        }).bindingId;
        return { delivered: true, reason: null, phase: "handoff" };
      }
    });

    const stale = await runRecoveryPass(root, { sessionId: SESSION, bindingId: first.bindingId, deps: passDeps() });
    assert.equal(stale.attempts.length, 1, "the stale pass sends only the event it already claimed");
    const attempted = stale.attempts[0]!.jobId;
    const later = attempted === jobA.id ? jobB.id : jobA.id;

    // The decisive assertion: the stale pass must NOT have claimed the second
    // eligible event — its single allowance is still intact.
    assert.equal(fs.existsSync(terminalRecoveryClaimPath(root, later, 0)), false, "a stale pass never spends a later event's allowance");
    assert.equal(readTerminalRecoveryResult(root, later, 0), null);
    assert.equal(inboxB.frames.length, 0, "the stale pass never sends to the new inbox");

    // The CURRENT registration still gets its ONE attempt for that later event.
    assert.ok(rebound, "the session rebound during the first delivery");
    const fresh = await runRecoveryPass(root, { sessionId: SESSION, bindingId: rebound, deps: passDeps() });
    assert.equal(fresh.attempts.length, 1);
    assert.equal(fresh.attempts[0]!.jobId, later, "the fresh pass recovers the event the stale pass left alone");
  } finally {
    // Restore the production adapter: registration is last-wins.
    registerNotificationTransport(claudeNotificationTransport);
    await inboxA.close();
    await inboxB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("leftover binding files never admit a superseded registration", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("leftover");
  try {
    // The CURRENT registration of the session...
    const current = registerClaudeBinding(root, {
      sessionId: SESSION,
      socket: inbox.address,
      token: TOKEN,
      now: () => new Date(Date.parse("2026-10-05T00:00:10Z"))
    });
    // ...plus an OLDER leftover file for the SAME session, which overlapping
    // registration/cleanup can leave behind (registration only removes records
    // strictly older than itself).
    const leftover = registerClaudeBinding(root, {
      sessionId: SESSION,
      socket: pipePath("leftover-dead"),
      token: "leftover-token",
      now: () => new Date(Date.parse("2026-10-05T00:00:05Z"))
    });
    const files = listClaudeBindings(root).filter((b) => b.sessionId === SESSION);
    assert.equal(files.length, 2, "both registrations exist on disk");
    assert.equal(files[0]!.bindingId, current.bindingId, "the newest record is the authoritative current registration");

    const job = makeJob(root);
    writeOriginal(root, job.id, 0);

    // The leftover's own file still resolves DIRECTLY — which is exactly why
    // admission must compare against the session's current registration
    // instead of trusting the requested id.
    const superseded = await runRecoveryPass(root, { sessionId: SESSION, bindingId: leftover.bindingId, deps: passDeps() });
    assert.equal(superseded.attempts.length, 0, "a superseded registration never sends");
    assert.equal(fs.existsSync(terminalRecoveryClaimPath(root, job.id, 0)), false, "a superseded registration spends nothing");
    assert.equal(inbox.frames.length, 0);

    const ok = await runRecoveryPass(root, { sessionId: SESSION, bindingId: current.bindingId, deps: passDeps() });
    assert.equal(ok.attempts.length, 1);
    assert.equal(inbox.frames.length, 1);
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two sessions never cross-recover and non-Claude targets are ignored", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inboxB = await startInbox("cross-b");
  try {
    const jobA = makeJob(root, { target: claudeTarget(SESSION) });
    writeOriginal(root, jobA.id, 0);
    const callbackJob = makeJob(root, {
      target: { kind: "callback", callbackUrl: "http://127.0.0.1:9/wake", codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: "callback_url" }
    });
    writeOriginal(root, callbackJob.id, 0);

    const bindingB = registerClaudeBinding(root, { sessionId: SESSION_B, socket: inboxB.address, token: "token-b" });
    const summary = await runRecoveryPass(root, { sessionId: SESSION_B, bindingId: bindingB.bindingId, deps: passDeps() });
    assert.equal(summary.matching, 0, "another session's job is not a candidate");
    assert.equal(summary.attempts.length, 0);
    assert.equal(inboxB.frames.length, 0);
    assert.equal(readTerminalRecoveryResult(root, jobA.id, 0), null, "the other session's job keeps its allowance");
    assert.equal(readTerminalRecoveryResult(root, callbackJob.id, 0), null, "a callback target keeps its existing behavior");
  } finally {
    await inboxB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful, uncertain and evidence-less originals are never resent", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("noresend");
  try {
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    const delivered = makeJob(root);
    writeOriginal(root, delivered.id, 0, { delivered: true, reason: null, phase: "handoff" });
    const started = makeJob(root);
    writeOriginal(root, started.id, 0, { phase: "writing_started" });
    const legacy = makeJob(root);
    writeOriginal(root, legacy.id, 0, { phase: null });
    const noAttempt = makeJob(root);

    const summary = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(summary.matching, 4);
    assert.equal(summary.attempts.length, 0);
    assert.equal(inbox.frames.length, 0);
    for (const job of [delivered, started, legacy, noAttempt]) {
      assert.equal(readTerminalRecoveryResult(root, job.id, 0), null, "no allowance may be consumed");
    }
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an already-collected generation and an advanced generation are suppressed before any claim", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("collect");
  try {
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    const collected = makeJob(root);
    writeOriginal(root, collected.id, 0);
    writeTerminalReadReceipt(root, collected.id, 0, "mcp-result");

    // Historical terminal generation of a job that has since continued: the
    // ORIGINAL wake of generation 0 failed, but generation 0 is no longer the
    // current generation — only the current terminal generation is recoverable.
    const continued = makeJob(root, { generation: 1, status: "done" });
    writeOriginal(root, continued.id, 0);
    const running = makeJob(root, { generation: 1, status: "running" });
    writeOriginal(root, running.id, 0);

    const summary = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(summary.matching, 3);
    assert.equal(summary.attempts.length, 0);
    assert.equal(inbox.frames.length, 0);
    assert.equal(readTerminalRecoveryResult(root, collected.id, 0), null, "a collected generation spends nothing");
    assert.equal(readTerminalRecoveryResult(root, continued.id, 0), null, "an old generation spends nothing");
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two concurrent passes claim ONE recovery and a crashed claim stays consumed", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("concurrent");
  try {
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    const job = makeJob(root);
    writeOriginal(root, job.id, 0);

    const [a, b] = await Promise.all([
      runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() }),
      runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() })
    ]);
    assert.equal(a.attempts.length + b.attempts.length, 1, "the exclusive claim admits exactly one sender");
    assert.equal(inbox.frames.length, 1);

    // A crashed/incomplete claim (claim file without a result) is consumed
    // conservatively: the event is never resent.
    const crashed = makeJob(root);
    writeOriginal(root, crashed.id, 0);
    assert.equal(claimTerminalRecoveryAttempt(root, crashed.id, 0), true);
    const after = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(after.attempts.length, 0);
    assert.equal(readTerminalRecoveryResult(root, crashed.id, 0), null);
    assert.equal(inbox.frames.length, 1, "no send for the crashed claim");
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the pass is bounded and fails closed for invalid or missing references", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  try {
    assert.equal(RECOVERY_MAX_JOBS_PER_PASS, 100);
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: pipePath("bounds"), token: TOKEN });
    const bad = await runRecoveryPass(root, { sessionId: "not-a-session", bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(bad.scanned, 0);
    const gone = await runRecoveryPass(root, { sessionId: SESSION, bindingId: "c".repeat(32), deps: passDeps() });
    assert.equal(gone.scanned, 0, "a non-current binding id starts no pass");

    // The job scan is capped (test-only override) and never above the hard cap.
    for (let i = 0; i < 5; i += 1) makeJob(root);
    const capped = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps(), maxJobs: 2 });
    assert.equal(capped.scanned, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Approval recovery (reuses the shared validator; no auto-approval)
// ---------------------------------------------------------------------------

test("a provably-lost approval wake is recovered once and never auto-approved", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("approval");
  try {
    writeHubEndpoint(root, { port: HUB_PORT, pid: process.pid, instanceId: "test-instance" });
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    const { job, approval } = runningApprovalJob(root);
    writeApprovalOriginal(root, job.id, job.generation, approval.requestId);

    const summary = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.deepEqual(summary.attempts, [
      { jobId: job.id, event: "approval_required", generation: 0, requestId: approval.requestId, delivered: true, reason: null }
    ]);
    assert.equal(inbox.frames.length, 1);
    const content = contentOf(inbox, 0);
    assert.ok(content.includes("not finished"));
    assert.ok(content.includes("do not approve automatically"));
    assert.ok(content.includes(`http://127.0.0.1:${HUB_PORT}/ui`));
    assert.equal(content.includes('Call crewdispatch_result(id='), false);

    const persisted = readApprovalRecoveryResult(root, job.id, 0, approval.requestId);
    assert.equal(persisted?.delivered, true);

    // No decision was made and the pending approval is untouched: recovery only
    // re-notifies; the human still decides in the Dashboard.
    assert.equal(fs.existsSync(approvalDecisionPath(root, job.id, 0, approval.requestId)), false);
    const after = loadJob(root, job.id)!;
    assert.equal(after.pendingApproval?.requestId, approval.requestId);
    assert.equal(after.status, "running");

    // One additional attempt per exact approval event.
    const again = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(again.attempts.length, 0);
    assert.equal(inbox.frames.length, 1);
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an approval resolved, expired or cancelled between admission and send sends NOTHING", async () => {
  for (const race of ["resolved", "expired", "cancelled"] as const) {
    const root = tmpRoot();
    ensureRoot(root);
    const inbox = await startInbox(`race-${race}`);
    try {
      writeHubEndpoint(root, { port: HUB_PORT, pid: process.pid, instanceId: "test-instance" });
      const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
      const { job, approval } = runningApprovalJob(root);
      writeApprovalOriginal(root, job.id, job.generation, approval.requestId);

      // The Hub proof is AWAITED inside the pass; this fetch performs the race
      // exactly in that window, after the claim.
      const fetchFn = (async () => {
        if (race === "resolved") {
          claimApprovalDecision(root, {
            version: 1,
            jobId: job.id,
            generation: job.generation,
            requestId: approval.requestId,
            optionId: "allow",
            kind: "allow_once",
            decidedAt: new Date().toISOString(),
            by: "hub"
          });
        } else {
          const current = loadJob(root, job.id)!;
          if (race === "expired") current.pendingApproval!.expiresAt = new Date(Date.now() - 1000).toISOString();
          if (race === "cancelled") current.cancelIntent = { requested: true, requestedAt: new Date().toISOString(), by: "cancel" };
          saveJob(root, current);
        }
        return { ok: true, json: async () => ({ ok: true, service: "jobquay" }) };
      }) as unknown as typeof fetch;

      const summary = await runRecoveryPass(root, {
        sessionId: SESSION,
        bindingId: binding.bindingId,
        deps: passDeps({ fetchFn })
      });
      assert.equal(summary.attempts.length, 1, `[${race}] the claimed event is recorded`);
      assert.equal(summary.attempts[0]!.delivered, false, `[${race}] nothing was sent`);
      assert.equal(summary.attempts[0]!.reason, race, `[${race}] the honest suppression code is recorded`);
      assert.equal(inbox.frames.length, 0, `[${race}] no wake may reach the session`);
      assert.equal(readApprovalRecoveryResult(root, job.id, 0, approval.requestId)?.delivered, false);
    } finally {
      await inbox.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an approval whose session rebinds during the awaited Hub proof is not sent by the stale pass", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inboxA = await startInbox("hubrace-a");
  const inboxB = await startInbox("hubrace-b");
  try {
    writeHubEndpoint(root, { port: HUB_PORT, pid: process.pid, instanceId: "test-instance" });
    const first = registerClaudeBinding(root, { sessionId: SESSION, socket: inboxA.address, token: "token-a" });
    const { job, approval } = runningApprovalJob(root);
    writeApprovalOriginal(root, job.id, job.generation, approval.requestId);

    // The Hub proof is AWAITED inside the pass; the session rebinds exactly in
    // that window, after the claim.
    let rebound: string | null = null;
    const fetchFn = (async () => {
      rebound = registerClaudeBinding(root, {
        sessionId: SESSION,
        socket: inboxB.address,
        token: "token-b",
        now: () => new Date(Date.now() + 5000)
      }).bindingId;
      return { ok: true, json: async () => ({ ok: true, service: "jobquay" }) };
    }) as unknown as typeof fetch;

    const summary = await runRecoveryPass(root, {
      sessionId: SESSION,
      bindingId: first.bindingId,
      deps: passDeps({ fetchFn })
    });
    assert.equal(summary.attempts.length, 1, "the claimed event is recorded");
    assert.equal(summary.attempts[0]!.delivered, false, "nothing was sent");
    assert.equal(summary.attempts[0]!.reason, "binding_not_current", "the honest suppression code");
    assert.equal(inboxA.frames.length, 0, "a stale pass never sends the approval wake");
    assert.equal(inboxB.frames.length, 0);
    assert.equal(readApprovalRecoveryResult(root, job.id, 0, approval.requestId)?.delivered, false);
    assert.ok(rebound, "the session rebound during the Hub proof");

    // No decision was made: recovery never approves and never resolves.
    assert.equal(fs.existsSync(approvalDecisionPath(root, job.id, 0, approval.requestId)), false);
  } finally {
    await inboxA.close();
    await inboxB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("approvals without proven phase evidence, with a successful original, or already resolved are never recovered", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  const inbox = await startInbox("approval-skip");
  try {
    writeHubEndpoint(root, { port: HUB_PORT, pid: process.pid, instanceId: "test-instance" });
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });

    const started = runningApprovalJob(root, "req-started");
    writeApprovalOriginal(root, started.job.id, 0, "req-started", "writing_started");
    const legacy = runningApprovalJob(root, "req-legacy");
    writeApprovalOriginal(root, legacy.job.id, 0, "req-legacy", null);
    const resolved = runningApprovalJob(root, "req-resolved");
    writeApprovalOriginal(root, resolved.job.id, 0, "req-resolved");
    claimApprovalDecision(root, {
      version: 1,
      jobId: resolved.job.id,
      generation: 0,
      requestId: "req-resolved",
      optionId: "reject",
      kind: "reject_once",
      decidedAt: new Date().toISOString(),
      by: "hub"
    });

    const summary = await runRecoveryPass(root, { sessionId: SESSION, bindingId: binding.bindingId, deps: passDeps() });
    assert.equal(summary.attempts.length, 0);
    assert.equal(inbox.frames.length, 0);
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Receipts and adapter boundaries
// ---------------------------------------------------------------------------

test("the result-read receipt is durable, generation-scoped and readable", () => {
  const root = tmpRoot();
  ensureRoot(root);
  try {
    assert.equal(readTerminalReadReceipt(root, "job-x", 0), null);
    writeTerminalReadReceipt(root, "job-x", 0, "mcp-result");
    const rec = readTerminalReadReceipt(root, "job-x", 0);
    assert.equal(rec?.generation, 0);
    assert.equal(rec?.by, "mcp-result");
    assert.ok(rec?.at);
    assert.equal(readTerminalReadReceipt(root, "job-x", 1), null, "a receipt is scoped to its exact generation");
    assert.ok(fs.existsSync(terminalReadReceiptPath(root, "job-x", 0)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("callback and Codex adapters refuse the recovered event explicitly", async () => {
  const event = { event: "terminal_recovered", jobId: "job-1", generation: 0, status: "done", collected: false } as const;
  const callback = await deliverNotificationEvent(
    event,
    { kind: "callback", callbackUrl: "http://127.0.0.1:9/wake", codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: "callback_url" },
    { env: {} }
  );
  assert.deepEqual(callback, { delivered: false, reason: "unsupported_event" });
  const codex = await deliverNotificationEvent(
    event,
    { kind: "codex_thread", callbackUrl: null, codexThreadId: "thread-1", claudeSessionId: null, claudeBindingId: null, source: "codex_thread_id" },
    { env: {} }
  );
  assert.deepEqual(codex, { delivered: false, reason: "unsupported_event" });
});

test("the recovery request budget is one finite end-to-end bound that can still cover a cold start", () => {
  // The honest claim is a FINITE bound on the whole call (broker
  // connect/start + request round-trip), not "never waits": with a stopped
  // broker the budget is largely spent starting it, so it must be able to cover
  // the startup machinery's own bound.
  assert.ok(Number.isFinite(RECOVERY_REQUEST_BUDGET_MS) && RECOVERY_REQUEST_BUDGET_MS > 0, "the budget is finite");
  assert.ok(
    RECOVERY_REQUEST_BUDGET_MS > DAEMON_START_TIMEOUT_MS,
    "the budget must be able to cover the broker's own startup bound, or a stopped broker could never be recovered"
  );
  assert.ok(RECOVERY_REQUEST_BUDGET_MS > RECOVERY_REQUEST_TIMEOUT_MS, "and the request round-trip bound");
});

test("an older broker that does not know the recover operation is reported honestly and left untouched", async () => {
  const root = tmpRoot();
  ensureRoot(root);
  // A broker double that speaks the EXISTING protocol (ping works) but predates
  // the additive `recover` operation.
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string };
      const response =
        req.op === "ping"
          ? { version: 1, id: req.id, ok: true, op: "ping", result: { pong: true, pid: process.pid } }
          : { version: 1, id: req.id, ok: false, op: req.op, code: "unknown_operation", message: "Unknown CrewDispatch daemon operation." };
      socket.end(JSON.stringify(response) + "\n");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const port = (server.address() as net.AddressInfo).port;
    const dir = path.join(root, "daemon");
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, "daemon.json");
    const meta = {
      version: 1,
      pid: process.pid,
      port,
      token: "t".repeat(64),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      serverPath: __filename
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta), "utf8");
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket: pipePath("older"), token: TOKEN });

    const result = await requestClaudeSessionRecovery(root, { sessionId: SESSION, bindingId: binding.bindingId }, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, "unsupported_operation");
    assert.match(String(result.message), /predates|untouched/);
    // No restart, no kill, no metadata rewrite: the existing broker is untouched.
    assert.deepEqual(JSON.parse(fs.readFileSync(metaFile, "utf8")), meta);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
