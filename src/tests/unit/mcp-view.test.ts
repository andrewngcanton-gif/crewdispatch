// mcp-view.test.ts — the MCP views are field-whitelisted and length-bounded, so
// no raw task, workspace path, provider session id, log path or owner internals
// can ever reach a caller.
import test from "node:test";
import assert from "node:assert/strict";
import { createJobRecord } from "../../jobs/service";
import { compactJob, compactResult, compactSummary, MCP_TEXT_CAP } from "../../mcp/view";
import { emptyUsage } from "../../jobs/types";

function sample() {
  const job = createJobRecord({ task: "TASK_MARKER_xyz", cwd: "C:\\work\\secret-project" });
  job.sessionId = "provider-session-abc";
  job.logPath = "logs/job-1.ndjson";
  job.owner = "jobquay-1234-x";
  job.ownerPid = 1234;
  job.status = "done";
  job.result = {
    ok: true,
    subtype: "success",
    kind: "success",
    exitCode: 0,
    stopReason: "end_turn",
    finalText: "F".repeat(MCP_TEXT_CAP + 500),
    fallbackEligible: false
  };
  job.notifications = [{ generation: 0, kind: "callback", attemptedAt: new Date().toISOString(), delivered: true, reason: null, by: null }];
  return job;
}

test("compactJob exposes only the whitelisted fields and caps text", () => {
  const view = compactJob(sample());
  assert.deepEqual(
    Object.keys(view).sort(),
    [
      "attempts",
      "cancel_requested",
      "child_pid",
      "created_at",
      "downgraded",
      "error",
      "explicit_model",
      "failure_kind",
      "finished_at",
      "generation",
      "job_id",
      "model",
      "model_chain",
      "model_source",
      "notify",
      "provider",
      "result",
      "started_at",
      "status",
      "stop_reason",
      "switch",
      "usage"
    ].sort()
  );
  const text = JSON.stringify(view);
  assert.equal(text.includes("TASK_MARKER_xyz"), false, "no task");
  assert.equal(text.includes("secret-project"), false, "no workspace path");
  assert.equal(text.includes("provider-session-abc"), false, "no provider session id");
  assert.equal(text.includes("job-1.ndjson"), false, "no log path");
  assert.equal(text.includes("jobquay-1234-x"), false, "no owner id");
  assert.equal(text.includes("ownerPid"), false);
});

test("the view surfaces a rate-limit downgrade (model_chain + downgraded + per-attempt rate_limited)", () => {
  const job = sample();
  job.modelChain = ["m/a", "m/b", "m/c"];
  job.model = "m/c";
  job.modelSource = "rate-limit-fallback";
  job.attempts = [
    { generation: 0, startedAt: "t0", endedAt: "t1", exitCode: 5, kind: "rate_limit", failureKind: "rate_limit", segment: false, resumedFrom: null, model: "m/a", modelSource: "slot", effort: null, rateLimited: true, switched: false, switchToModel: null, usage: { ...emptyUsage(), tokensIn: 10 } },
    { generation: 1, startedAt: "t2", endedAt: "t3", exitCode: 5, kind: "rate_limit", failureKind: "rate_limit", segment: false, resumedFrom: "s", model: "m/b", modelSource: "config-default", effort: "medium", rateLimited: true, switched: false, switchToModel: null, usage: { ...emptyUsage(), tokensIn: 10 } },
    { generation: 2, startedAt: "t4", endedAt: "t5", exitCode: 0, kind: "success", failureKind: null, segment: false, resumedFrom: "s", model: "m/c", modelSource: "rate-limit-fallback", effort: "low", rateLimited: false, switched: false, switchToModel: null, usage: { ...emptyUsage(), tokensIn: 5 } }
  ];
  const view = compactJob(job);
  assert.deepEqual(view.model_chain, ["m/a", "m/b", "m/c"]);
  assert.equal(view.downgraded, true);
  assert.equal(view.model, "m/c");
  assert.equal(view.model_source, "rate-limit-fallback");
  assert.deepEqual(
    view.attempts.map((a) => [a.model, a.model_source, a.effort, a.rate_limited]),
    [
      ["m/a", "slot", null, true],
      ["m/b", "config-default", "medium", true],
      ["m/c", "rate-limit-fallback", "low", false]
    ]
  );

  // The primary is NOT a downgrade.
  const primary = sample();
  primary.modelChain = ["m/a", "m/b"];
  primary.model = "m/a";
  assert.equal(compactJob(primary).downgraded, false);
});

test("compactResult caps the final text", () => {
  const r = compactResult(sample());
  assert.ok(r);
  assert.equal(r!.final_text!.length, MCP_TEXT_CAP);
});

test("compactResult exposes the bounded approval outcome token, and null when the result carries none", () => {
  // A completed turn whose gated operation never ran: the MCP terminal result
  // itself must name the proven cause instead of leaving the caller to guess
  // from prose.
  const rejected = sample();
  rejected.result = { ...rejected.result!, approvalOutcome: "rejected" };
  assert.equal(compactResult(rejected)?.approval_outcome, "rejected");

  const expired = sample();
  expired.result = { ...expired.result!, approvalOutcome: "expired" };
  assert.equal(compactResult(expired)?.approval_outcome, "expired");

  // No evidence (a legacy/recorded result) stays null — never invented.
  assert.equal(compactResult(sample())?.approval_outcome, null);

  // The view is bounded like every other text field.
  const oversized = sample();
  oversized.result = { ...oversized.result!, approvalOutcome: "x".repeat(500) };
  assert.equal(compactResult(oversized)?.approval_outcome, "x".repeat(64));
});

test("the notify view reflects the current generation's delivery record", () => {
  const job = sample();
  job.notifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:9/w", codexThreadId: null, source: "callback_url" };
  job.notifications = [
    { generation: 0, kind: "none", attemptedAt: "t0", delivered: false, reason: "no_target", by: null },
    { generation: 1, kind: "callback", attemptedAt: "t1", delivered: false, reason: "http_status_500", by: null }
  ];
  job.generation = 1;
  const view = compactJob(job);
  // A transport that cannot prove a phase (HTTP callback) reports null — the
  // bounded recovery path treats that as UNKNOWN and never eligible.
  assert.deepEqual(view.notify, { kind: "callback", source: "callback_url", attempted: true, delivered: false, reason: "http_status_500", phase: null });

  // A Claude-inbox record carries its bounded transport phase verbatim.
  job.notifyTarget = { kind: "claude_session", callbackUrl: null, codexThreadId: null, claudeSessionId: "11111111-2222-4333-8444-555555555555", claudeBindingId: null, source: "claude_session_id" };
  job.notifications = [
    { generation: 1, kind: "claude_session", attemptedAt: "t1", delivered: false, reason: "inbox_unreachable", by: "worker", phase: "not_written" }
  ];
  assert.equal(compactJob(job).notify.phase, "not_written");
});

test("compactSummary carries only ids/status/timestamps/provider", () => {
  const s = compactSummary(sample());
  assert.deepEqual(Object.keys(s).sort(), ["created_at", "finished_at", "generation", "job_id", "provider", "status"]);
});

test("the MCP view serves the canonical paired decode fields and context gauges unchanged", () => {
  const job = sample();
  job.usage = {
    ...emptyUsage(),
    decodeTokens: 40,
    decodeSeconds: 2,
    contextUsed: 1200,
    contextWindow: 200000
  };
  const view = compactJob(job);
  // The paired-decode contract is canonical telemetry: MCP callers receive the
  // numerator/denominator exactly as persisted (and the context gauges too,
  // even though the Dashboard UI deliberately does not present them).
  assert.deepEqual(view.usage, job.usage);
});
