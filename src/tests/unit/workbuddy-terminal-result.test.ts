// workbuddy-terminal-result.test.ts — JQ-20261001-14 regression.
//
// WorkBuddy ACP `session/prompt` returning only proves the transport delivered
// a terminal record; it is NOT a successful task result. The installed ACP
// schema publishes exactly end_turn | max_tokens | max_turn_requests | refusal |
// cancelled, and only end_turn is a normal completion.
//
// The pre-fix bridge stamped EVERY completion `subtype:"success" /
// is_error:false`, so the observed live record
// `{subtype:"success", result:null, stop_reason:"refusal", is_error:false}`
// became a durable `done` with no assistant result. These tests replay the
// EXACT observed record through the production WorkBuddy adapter and the real
// job service, and pin the end_turn success control.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord, runWorker } from "../../jobs/service";
import { loadJob, saveJob } from "../../jobs/store";
import type { JobRecord } from "../../jobs/types";
import { createFixtureRunner } from "../../cli/fixture-runner";
import { createWorkBuddyAiAdapter } from "../../providers/workbuddy-ai/index";
import {
  ACP_ERROR_DETAIL_CAP,
  ACP_FAILURE_CANCELLED,
  ACP_FAILURE_MAX_TOKENS,
  ACP_FAILURE_MAX_TURN_REQUESTS,
  ACP_FAILURE_MODEL_ERROR,
  ACP_FAILURE_APPROVAL_EXPIRED,
  ACP_FAILURE_APPROVAL_REJECTED,
  ACP_FAILURE_PERMISSION_REQUIRED,
  ACP_FAILURE_RATE_LIMIT,
  ACP_FAILURE_REFUSAL,
  ACP_FAILURE_STOP,
  acpErrorResultRecord,
  acpTerminalResultRecord,
  acpToolApprovalEvidence,
  classifyAcpStopReason,
  safeAcpErrorDetail,
  safeAcpFinishReason
} from "../../providers/workbuddy-ai/acp-normalizer";
import {
  WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD,
  WORKBUDDY_CONTENT_FILTER_MESSAGE,
  WORKBUDDY_CONTENT_FILTER_RESULT_RECORD,
  WORKBUDDY_END_TURN_RESULT_RECORD,
  WORKBUDDY_END_TURN_TEXT,
  WORKBUDDY_EXPLICIT_REFUSAL_MESSAGE,
  WORKBUDDY_EXPLICIT_REFUSAL_RESULT_RECORD,
  WORKBUDDY_MODEL_ERROR_MESSAGE,
  WORKBUDDY_MODEL_ERROR_RESULT_RECORD,
  WORKBUDDY_OBSERVED_REFUSAL_RESULT_RECORD,
  WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS,
  WORKBUDDY_PERMISSION_REQUIRED_RESULT_RECORD,
  WORKBUDDY_REFUSAL_RAW_ERROR_MESSAGE,
  WORKBUDDY_REFUSAL_SAFE_DETAIL,
  WORKBUDDY_REFUSAL_TEXT,
  WORKBUDDY_REFUSAL_TEXT_RESULT_RECORD,
  WORKBUDDY_QUOTA_ACP_PROMPT_RESULT,
  WORKBUDDY_QUOTA_ERROR_DETAIL,
  WORKBUDDY_QUOTA_MISSING_FINISH_ACP_PROMPT_RESULT,
  WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
  WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD,
  WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE,
  WORKBUDDY_QUOTA_RESULT_RECORD,
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
  workbuddyTerminalLines
} from "../fixtures/workbuddy-terminal-records";

/** The production adapter as the Windows Desktop bridge drives it. */
function win32Adapter() {
  return createWorkBuddyAiAdapter({ platform: "win32" });
}

function newTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-terminal-"));
}

/** A child fixture that emits `lines` on stdout and exits with `exitCode`. */
function writeStreamFixture(dir: string, lines: readonly string[], exitCode: number): string {
  const fixture = path.join(dir, "workbuddy-stream-fixture.cjs");
  fs.writeFileSync(
    fixture,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      `  const lines = ${JSON.stringify(lines)};`,
      '  for (const line of lines) process.stdout.write(line + "\\n");',
      `  process.exit(${exitCode});`,
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

/** Run one WorkBuddy job whose child streams `lines` and exits with `exitCode`. */
async function runWorkBuddyFixture(
  dir: string,
  lines: readonly string[],
  exitCode: number
): Promise<{ status: string | null; job: JobRecord }> {
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeStreamFixture(dir, lines, exitCode);
  const job = createJobRecord({
    task: "read package.json and report name/version",
    cwd,
    provider: "workbuddy-ai",
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
  });
  saveJob(root, job);
  const result = await runWorker({
    root,
    jobId: job.id,
    createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env, win32Adapter()),
    // This helper replays the Windows WorkBuddy Desktop adapter; pin the worker
    // platform to the same semantics instead of accidentally exercising Darwin
    // lifecycle evidence while running the unit suite on a Mac.
    platform: "win32",
    isAliveFn: () => false,
    enumerateFn: async () => ({ ok: true, processes: [] })
  });
  const reloaded = loadJob(root, job.id);
  assert.ok(reloaded, "the job must still exist after the worker finishes");
  return { status: result.status, job: reloaded };
}

test("the installed ACP stop-reason table treats only end_turn as a success", () => {
  assert.deepEqual(classifyAcpStopReason("end_turn"), { failureKind: null, message: null, exitCode: 0 });
  assert.deepEqual(classifyAcpStopReason(null), { failureKind: null, message: null, exitCode: 0 });

  const cases = [
    ["refusal", ACP_FAILURE_REFUSAL],
    ["max_tokens", ACP_FAILURE_MAX_TOKENS],
    ["max_turn_requests", ACP_FAILURE_MAX_TURN_REQUESTS],
    ["cancelled", ACP_FAILURE_CANCELLED]
  ] as const;
  for (const [reason, failureKind] of cases) {
    const outcome = classifyAcpStopReason(reason);
    assert.equal(outcome.failureKind, failureKind, `${reason} is a non-completion`);
    assert.match(String(outcome.message), new RegExp(`stop_reason=${reason}`), "the message names the provider's own reason");
    assert.doesNotMatch(String(outcome.message), /transport|connection|network|timed?\s?out/i, `${reason} never claims a transport failure`);
    assert.ok(outcome.exitCode > 0, "the outcome is carried to the exit classifier");
  }

  const unknown = classifyAcpStopReason("future_reason");
  assert.equal(unknown.failureKind, ACP_FAILURE_STOP, "an unknown stop reason must never fall back to success");
  assert.match(String(unknown.message), /future_reason/);
});

test("a refusal prompt result becomes a classified provider failure, never a success record", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: ""
  });
  assert.equal(terminal.exitCode, 11);
  assert.equal(terminal.record.subtype, "error");
  assert.equal(terminal.record.is_error, true);
  assert.equal(terminal.record.stop_reason, "refusal", "the provider's own stop reason is preserved verbatim");
  assert.equal(terminal.record.result, null, "no assistant result existed; none is fabricated");
  assert.deepEqual(terminal.record.error, {
    code: ACP_FAILURE_REFUSAL,
    message: "WorkBuddy AI refused this request (stop_reason=refusal); no task result was produced."
  });
  assert.equal("finish_reason" in terminal.record, false, "a transport that omits the finish reason keeps the historical record shape");
});

// ---------------------------------------------------------------------------
// JQ-20261001-23: the provider's own finishReason refines a refusal
// ---------------------------------------------------------------------------

test("classifyAcpStopReason uses the provider finish reason to refine ordinary refusal diagnostics", () => {
  const contentFilter = classifyAcpStopReason("refusal", "content_filter");
  assert.equal(contentFilter.failureKind, ACP_FAILURE_REFUSAL, "content_filter keeps the stable provider_refusal classification");
  assert.equal(contentFilter.exitCode, 11, "the exit code carries the same provider_refusal outcome");
  assert.match(String(contentFilter.message), /content filter/i);
  assert.match(String(contentFilter.message), /finish_reason=content_filter/);
  assert.doesNotMatch(String(contentFilter.message), /transport|connection|timed?\s?out/i);

  const explicit = classifyAcpStopReason("refusal", "refusal");
  assert.equal(explicit.failureKind, ACP_FAILURE_REFUSAL);
  assert.match(String(explicit.message), /explicitly refused/i);
  assert.doesNotMatch(String(explicit.message), /content filter/i);

  const legacy = classifyAcpStopReason("refusal");
  assert.match(String(legacy.message), /refused this request/);
  assert.doesNotMatch(String(legacy.message), /content filter|explicitly/i, "no detail is invented without a finish reason");

  // A finish reason never changes any OTHER stop reason's classification or message.
  assert.deepEqual(classifyAcpStopReason("max_tokens", "content_filter"), classifyAcpStopReason("max_tokens"));
  assert.deepEqual(classifyAcpStopReason("end_turn", "stop"), { failureKind: null, message: null, exitCode: 0 });
});

test("only a bounded safe finish reason token is ever carried", () => {
  assert.equal(safeAcpFinishReason("content_filter"), "content_filter");
  assert.equal(safeAcpFinishReason("  refusal  "), "refusal");
  assert.equal(safeAcpFinishReason("x".repeat(64)), "x".repeat(64));
  assert.equal(safeAcpFinishReason("x".repeat(65)), null, "an over-long value is omitted, never truncated");
  assert.equal(safeAcpFinishReason("refusal<script>alert(1)</script>"), null, "arbitrary provider payloads are never carried");
  assert.equal(safeAcpFinishReason(""), null);
  assert.equal(safeAcpFinishReason(null), null);
  assert.equal(safeAcpFinishReason(42), null);
});

test("a content-filter refusal records its exact bounded shape and content-filter diagnostic", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "content_filter"
  });
  assert.equal(terminal.exitCode, 11, "the content filter stays a provider_refusal");
  assert.deepEqual(terminal.record, WORKBUDDY_CONTENT_FILTER_RESULT_RECORD, "the exact record shape the bridge writes");
  assert.equal(terminal.record.stop_reason, "refusal", "the raw stop reason stays intact");
  assert.equal(terminal.record.finish_reason, "content_filter");
  assert.equal(terminal.record.result, null, "no assistant result is fabricated");
  assert.match(String((terminal.record.error as Record<string, unknown>).message), /content filter/i);
  assert.doesNotMatch(String((terminal.record.error as Record<string, unknown>).message), /^WorkBuddy AI refused this request /);
});

test("an explicit refusal (finish_reason=refusal) records the explicit-refusal diagnostic", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "refusal"
  });
  assert.equal(terminal.exitCode, 11);
  assert.deepEqual(terminal.record, WORKBUDDY_EXPLICIT_REFUSAL_RESULT_RECORD);
  assert.equal(terminal.record.stop_reason, "refusal");
  assert.equal(terminal.record.finish_reason, "refusal");
  assert.match(String((terminal.record.error as Record<string, unknown>).message), /explicitly refused/i);
});

test("an unsafe finish reason is omitted and keeps the honest generic refusal", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "content_filter<script>alert(1)</script>"
  });
  assert.equal("finish_reason" in terminal.record, false);
  assert.deepEqual(terminal.record.error, {
    code: ACP_FAILURE_REFUSAL,
    message: "WorkBuddy AI refused this request (stop_reason=refusal); no task result was produced."
  });
});

test("a genuine end_turn completion stays byte-identical even when a finish reason is supplied", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT,
    finishReason: "stop"
  });
  assert.equal(terminal.exitCode, 0);
  assert.deepEqual(terminal.record, WORKBUDDY_END_TURN_RESULT_RECORD, "normal success keeps its exact shape");
});

test("the production adapter names the content filter on a legacy success-shaped refusal carrying a finish reason", () => {
  const adapter = win32Adapter();
  const state = adapter.createStreamState();
  adapter.parseStreamLine(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "refusal",
    finish_reason: "content_filter",
    result: null
  }), state);

  assert.equal(state.resultSubtype, ACP_FAILURE_REFUSAL);
  assert.equal(state.isError, true);
  assert.equal(state.stopReason, "refusal");
  assert.equal(state.finishReason, "content_filter");
  assert.match(String(state.errorMsg), /content filter/i);
});

test("a genuine end_turn completion keeps the success record and its assistant result", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT
  });
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.record.subtype, "success");
  assert.equal(terminal.record.is_error, false);
  assert.equal(terminal.record.stop_reason, "end_turn");
  assert.equal(terminal.record.result, WORKBUDDY_END_TURN_TEXT);
});

test("a refusal that carries provider text preserves it as the result detail", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: WORKBUDDY_REFUSAL_TEXT
  });
  assert.equal(terminal.record.subtype, "error");
  assert.equal(terminal.record.stop_reason, "refusal");
  assert.equal(terminal.record.result, WORKBUDDY_REFUSAL_TEXT, "the provider's own text is kept, never rewritten");
});

test("the production adapter normalizes the observed refusal record to a non-success terminal state", () => {
  const adapter = win32Adapter();
  const state = adapter.createStreamState();
  for (const line of workbuddyTerminalLines(WORKBUDDY_OBSERVED_REFUSAL_RESULT_RECORD)) adapter.parseStreamLine(line, state);

  assert.equal(state.terminal, true);
  assert.notEqual(state.resultSubtype, "success", "the observed success subtype is corrected");
  assert.equal(state.resultSubtype, ACP_FAILURE_REFUSAL);
  assert.equal(state.isError, true);
  assert.equal(state.stopReason, "refusal", "the provider's original stop reason survives normalization");
  assert.equal(state.errorCode, ACP_FAILURE_REFUSAL);
  assert.match(String(state.errorMsg), /refused this request/i);
  assert.equal(state.finalResult, null, "finalText stays null when no assistant text existed");
});

test("the observed refusal record can never end the durable job as done", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(dir, workbuddyTerminalLines(WORKBUDDY_OBSERVED_REFUSAL_RESULT_RECORD), 0);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.stopReason, "refusal", "the provider's original stop reason is durable");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL, "the failure kind is stable and provider-specific");
    assert.equal(job.result?.ok, false);
    assert.equal(job.result?.subtype, ACP_FAILURE_REFUSAL);
    assert.equal(job.result?.stopReason, "refusal");
    assert.equal(job.result?.finalText, null, "no result existed; nothing is fabricated");
    assert.match(String(job.error), /refused this request/i);
    assert.doesNotMatch(String(job.error), /transport|connection|timed?\s?out/i, "an intentional refusal is not reported as a transport failure");
    assert.equal(job.finishReason, null, "the historical record carries no finish reason; none is invented");
    assert.equal(job.result?.finishReason ?? null, null, "the historical result carries no finish reason either");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the content-filter refusal ends durable state with a content-filter diagnostic, still provider_refusal (JQ-20261001-23)", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(
      dir,
      workbuddyTerminalLines(WORKBUDDY_CONTENT_FILTER_RESULT_RECORD),
      11
    );
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL, "the shared classification stays provider_refusal; no second taxonomy");
    assert.equal(job.stopReason, "refusal", "the provider's original stop reason is durable and intact");
    assert.equal(job.finishReason, "content_filter", "the provider's own finish reason is durable");
    assert.equal(job.result?.stopReason, "refusal");
    assert.equal(job.result?.finishReason, "content_filter");
    assert.equal(job.result?.finalText, null);
    assert.match(String(job.error), /content filter/i, "the durable diagnostic names the content filter");
    assert.notEqual(
      String(job.error),
      "WorkBuddy AI refused this request (stop_reason=refusal); no task result was produced.",
      "the diagnostic is never collapsed to a bare generic refusal"
    );
    assert.doesNotMatch(String(job.error), /transport|connection|timed?\s?out/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit refusal ends durable state with the explicit-refusal diagnostic", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(
      dir,
      workbuddyTerminalLines(WORKBUDDY_EXPLICIT_REFUSAL_RESULT_RECORD),
      11
    );
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL);
    assert.equal(job.stopReason, "refusal");
    assert.equal(job.finishReason, "refusal");
    assert.equal(job.result?.finishReason, "refusal");
    assert.match(String(job.error), /explicitly refused/i);
    assert.doesNotMatch(String(job.error), /content filter/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a normal end_turn completion still ends done with its own assistant result", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(dir, workbuddyTerminalLines(WORKBUDDY_END_TURN_RESULT_RECORD), 0);
    assert.equal(status, "done");
    assert.equal(job.status, "done");
    assert.equal(job.stopReason, "end_turn");
    assert.equal(job.failureKind, null);
    assert.equal(job.error, null);
    assert.equal(job.result?.ok, true);
    assert.equal(job.result?.subtype, "success");
    assert.equal(job.result?.finalText, WORKBUDDY_END_TURN_TEXT, "the real assistant result is preserved");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal with provider text stays an error and keeps the text in durable state", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(dir, workbuddyTerminalLines(WORKBUDDY_REFUSAL_TEXT_RESULT_RECORD), 0);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.stopReason, "refusal");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL);
    assert.equal(job.result?.finalText, WORKBUDDY_REFUSAL_TEXT, "the provider text is preserved as result detail");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the fixed bridge terminal record is classified through the provider exit code", async () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: ""
  });
  assert.equal(terminal.exitCode, 11);
  const dir = newTmp();
  try {
    const lines = [
      JSON.stringify({ type: "init", session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, model: WORKBUDDY_TERMINAL_FIXTURE_MODEL }),
      JSON.stringify(terminal.record)
    ];
    const { status, job } = await runWorkBuddyFixture(dir, lines, terminal.exitCode);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.stopReason, "refusal");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL);
    assert.equal(job.result?.exitCode, 11);
    assert.equal(job.result?.finalText, null);
    assert.match(String(job.error), /refused this request/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge terminal exit codes classify as provider failures on Windows and macOS only", () => {
  for (const desktop of [win32Adapter(), createWorkBuddyAiAdapter({ platform: "darwin" })]) {
    assert.deepEqual(desktop.classifyExit(5), {
      kind: "rate_limit",
      failureKind: "cli_rate_limited",
      stopReason: null,
      fatal: false,
      fallback: true
    }, "shared exit 5 bypasses the private bridge outcome table and remains fallback eligible");
    assert.deepEqual(desktop.classifyExit(11), {
      kind: ACP_FAILURE_REFUSAL,
      failureKind: ACP_FAILURE_REFUSAL,
      stopReason: null,
      fatal: false,
      fallback: false
    });
    assert.equal(desktop.classifyExit(12).failureKind, ACP_FAILURE_MAX_TOKENS);
    assert.equal(desktop.classifyExit(13).failureKind, ACP_FAILURE_MAX_TURN_REQUESTS);
    assert.equal(desktop.classifyExit(14).failureKind, ACP_FAILURE_CANCELLED);
    assert.equal(desktop.classifyExit(15).failureKind, ACP_FAILURE_STOP);
    assert.equal(desktop.classifyExit(16).failureKind, ACP_FAILURE_MODEL_ERROR, "the JSON-RPC model error keeps its own stable kind");
    assert.equal(desktop.classifyExit(16).fallback, false, "a model error is never rate-limit fallback eligible");
    assert.equal(desktop.classifyExit(0).kind, "success");
    assert.equal(desktop.classifyExit(0).fatal, false);
  }

  // Linux still launches the bundled CLI directly: the Desktop bridge's private
  // exit-code namespace must not be interpreted there.
  const linux = createWorkBuddyAiAdapter({ platform: "linux" });
  assert.equal(linux.classifyExit(11).kind, "unknown");
  assert.equal(linux.classifyExit(11).failureKind, null);
});
// ---------------------------------------------------------------------------
// JQ-20261001-24: the bounded refusal errorMessage and the JSON-RPC model error
// ---------------------------------------------------------------------------

test("only a bounded safe provider error detail is ever carried", () => {
  // The runtime's plain diagnostic form is carried as-is (trimmed).
  assert.equal(safeAcpErrorDetail("  Model service error: upstream rejected  "), "Model service error: upstream rejected");

  // The installed runtime's JSON-encoded classified error response contributes
  // ONLY its message field — the internal `data` payload never leaves.
  assert.equal(safeAcpErrorDetail(WORKBUDDY_REFUSAL_RAW_ERROR_MESSAGE), WORKBUDDY_REFUSAL_SAFE_DETAIL);
  assert.equal(safeAcpErrorDetail('{"code":-32004,"data":{"statusCode":500,"bizCode":"internal"}}'), null, "a payload-shaped value without a message is dropped");

  // A multi-line value contributes only its first line: a stack trace or payload
  // dump can never be carried.
  assert.equal(
    safeAcpErrorDetail("Model service error: boom\n    at read (C:\\work\\x.js:1:2)"),
    "Model service error: boom"
  );
  assert.equal(safeAcpErrorDetail("    at read (C:\\work\\x.js:1:2)"), null, "a bare code frame is dropped entirely");
  assert.equal(safeAcpErrorDetail('{"code":-32004,"message":'), null, "malformed JSON is dropped, never partially carried");

  // Credentials are redacted through the same policy the bridge uses.
  assert.equal(safeAcpErrorDetail("request failed: Bearer abc.def-123"), "request failed: Bearer <redacted>");

  // Oversized values are bounded, never carried whole.
  const oversized = safeAcpErrorDetail("x".repeat(ACP_ERROR_DETAIL_CAP + 50));
  assert.equal(oversized?.length, ACP_ERROR_DETAIL_CAP + 1);
  assert.ok(oversized?.endsWith("…"));

  assert.equal(safeAcpErrorDetail(42), null);
  assert.equal(safeAcpErrorDetail(""), null);
  assert.equal(safeAcpErrorDetail(null), null);
  assert.equal(safeAcpErrorDetail(undefined), null);
});

test("a refusal with finishReason + safe errorMessage preserves both cause and safe detail", () => {
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "content_filter",
    errorDetail: WORKBUDDY_REFUSAL_RAW_ERROR_MESSAGE
  });
  assert.equal(terminal.exitCode, 11, "the stable provider_refusal classification is unchanged");
  assert.equal(terminal.record.subtype, "error");
  assert.equal(terminal.record.stop_reason, "refusal", "the raw stop reason stays intact");
  assert.equal(terminal.record.finish_reason, "content_filter", "the finish reason remains the authoritative cause");
  assert.equal(terminal.record.error_detail, WORKBUDDY_REFUSAL_SAFE_DETAIL, "the safe detail is preserved");
  assert.deepEqual(terminal.record, WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD, "the exact record shape the bridge writes");
  assert.equal(JSON.stringify(terminal.record).includes("internal-must-not-leak"), false, "the internal data payload never reaches the record");
});

test("only the recorded ACP quota metadata shape enables the shared rate-limit fallback (JQ-20261002-32)", () => {
  const quota = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: WORKBUDDY_QUOTA_ACP_PROMPT_RESULT.stopReason,
    finalText: "",
    finishReason: WORKBUDDY_QUOTA_ACP_PROMPT_RESULT._meta["codebuddy.ai/finishReason"],
    errorDetail: WORKBUDDY_QUOTA_ACP_PROMPT_RESULT._meta["codebuddy.ai/errorMessage"]
  });
  assert.equal(quota.exitCode, 5, "the proven transient quota shape uses the canonical shared rate-limit code");
  assert.deepEqual(quota.record, WORKBUDDY_QUOTA_RESULT_RECORD);
  assert.equal(quota.record.stop_reason, "refusal", "the provider's raw stop reason remains available");
  assert.equal(quota.record.finish_reason, "tool_calls", "the provider finish reason remains available");
  assert.equal(quota.record.error_detail, WORKBUDDY_QUOTA_ERROR_DETAIL, "the bounded provider diagnostic remains available");
  assert.deepEqual(quota.record.error, { code: ACP_FAILURE_RATE_LIMIT, message: WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE });

  const unrelated429 = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "tool_calls",
    errorDetail: "The diagnostic mentions HTTP 429 records, but not a quota or frequency limit."
  });
  assert.equal(unrelated429.exitCode, 11, "an unrelated 429 remains an ordinary refusal");
  assert.equal((unrelated429.record.error as Record<string, unknown>).code, ACP_FAILURE_REFUSAL);

  const quotaTextOnly = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: WORKBUDDY_QUOTA_ERROR_DETAIL,
    finishReason: "tool_calls"
  });
  assert.equal(quotaTextOnly.exitCode, 11, "assistant text is never consulted for quota classification");

  const contentFilter = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "content_filter",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL
  });
  assert.equal(contentFilter.exitCode, 11, "a genuine content filter remains a provider refusal");
  assert.equal((contentFilter.record.error as Record<string, unknown>).code, ACP_FAILURE_REFUSAL);

  const cancelled = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL
  });
  assert.equal(cancelled.exitCode, 14, "a cancelled turn keeps its existing failure classification");
  assert.equal((cancelled.record.error as Record<string, unknown>).code, ACP_FAILURE_CANCELLED);

  const expired = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL,
    approval: acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS),
    approvalOutcome: "expired"
  });
  assert.equal(expired.exitCode, 18, "proven approval expiry keeps its existing precedence inside the gate shape");
  assert.equal((expired.record.error as Record<string, unknown>).code, ACP_FAILURE_APPROVAL_EXPIRED);

  // The SAME token WITHOUT the gate evidence is diagnostic only: the cancelled
  // turn keeps its own terminal cause, and the token rides the record.
  const expiredTokenOnly = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL,
    approvalOutcome: "expired"
  });
  assert.equal(expiredTokenOnly.exitCode, 14, "a side token never overwrites an unrelated cancellation (JQ-20261005-57)");
  assert.equal((expiredTokenOnly.record.error as Record<string, unknown>).code, ACP_FAILURE_CANCELLED);
  assert.equal(expiredTokenOnly.record.approval_outcome, "expired", "the proven diagnostic is still carried");

  const success = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT,
    finishReason: "stop",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL
  });
  assert.equal(success.exitCode, 0, "normal completion stays successful even with unrelated terminal metadata");
  assert.equal(success.record.subtype, "success");
  assert.equal("error_detail" in success.record, false);
});

test("the observed missing-finish-reason quota shape is the shared rate limit, never provider_refusal (JQ-20261002-43)", () => {
  // The live shape: stop_reason=refusal, NO finish_reason, the provider's exact
  // quota detail. The pre-fix classifier required finish_reason=tool_calls, so
  // the actual quota became provider_refusal (exit 11) and the configured
  // fallback was never reached.
  assert.deepEqual(
    classifyAcpStopReason("refusal", undefined, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL),
    { failureKind: ACP_FAILURE_RATE_LIMIT, message: WORKBUDDY_QUOTA_RATE_LIMIT_MESSAGE, exitCode: 5 }
  );
  assert.equal(
    classifyAcpStopReason("refusal", null, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).exitCode,
    5,
    "an explicit null finish reason keeps the same quota classification"
  );

  // The bridge writes this exact record from the recorded ACP prompt result and
  // exits with the canonical shared rate-limit code.
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: WORKBUDDY_QUOTA_MISSING_FINISH_ACP_PROMPT_RESULT.stopReason,
    finalText: "",
    finishReason: null,
    errorDetail: WORKBUDDY_QUOTA_MISSING_FINISH_ACP_PROMPT_RESULT._meta["codebuddy.ai/errorMessage"]
  });
  assert.equal(terminal.exitCode, 5, "the observed quota uses the canonical shared rate-limit exit code");
  assert.deepEqual(terminal.record, WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD);
  assert.equal(terminal.record.stop_reason, "refusal", "the provider's raw stop reason remains available");
  assert.equal("finish_reason" in terminal.record, false, "no finish reason is invented");
  assert.equal(
    terminal.record.error_detail,
    WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
    "the bounded provider diagnostic remains available"
  );

  // Exit 5 goes through the provider's REAL exit classifier: the shared
  // fallback policy sees a genuine rate limit, not a test-forced flag.
  const cls = win32Adapter().classifyExit(terminal.exitCode);
  assert.equal(cls.kind, "rate_limit");
  assert.equal(cls.fallback, true, "the normalized exit code is genuinely fallback eligible");

  // The previously accepted tool_calls shape remains a rate limit.
  assert.equal(classifyAcpStopReason("refusal", "tool_calls", null, null, WORKBUDDY_QUOTA_ERROR_DETAIL).exitCode, 5);

  // An EXPLICIT different finish reason keeps its own refusal semantics even
  // beside the exact quota detail: the provider published a more specific cause.
  assert.equal(
    classifyAcpStopReason("refusal", "content_filter", null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).exitCode,
    11,
    "a genuine content filter remains a provider refusal"
  );
  assert.equal(
    classifyAcpStopReason("refusal", "refusal", null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).exitCode,
    11,
    "an explicit model refusal remains a provider refusal"
  );

  // Ordinary refusals without the exact provider quota evidence stay refusals.
  assert.equal(classifyAcpStopReason("refusal", undefined, null, null, "Model service error: upstream content policy").exitCode, 11);
  assert.equal(classifyAcpStopReason("refusal", undefined, null, null, undefined).exitCode, 11);
  assert.equal(classifyAcpStopReason("refusal", undefined, null, null, null).exitCode, 11);
  assert.equal(
    classifyAcpStopReason("refusal", undefined, null, null, "The diagnostic mentions HTTP 429 records, but not a quota or frequency limit.").exitCode,
    11,
    "an unrelated 429 substring is never quota evidence"
  );
  assert.equal(
    classifyAcpStopReason("refusal", undefined, null, null, "quota exceeded: 429 requests were retried").exitCode,
    11,
    "a lookalike prefix without the recorded frequency-limit wording stays a refusal"
  );

  // Assistant text can never supply the evidence.
  const textOnly = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
    finishReason: null
  });
  assert.equal(textOnly.exitCode, 11, "assistant text is never consulted for quota classification");

  // Cancellation, other stop reasons and normal completions keep their existing
  // outcomes even with the quota detail present. The side approval token does
  // not change that: without the remembered gate shape it is diagnostic only
  // (JQ-20261005-57).
  assert.equal(
    classifyAcpStopReason("cancelled", undefined, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).failureKind,
    ACP_FAILURE_CANCELLED
  );
  assert.equal(
    classifyAcpStopReason("cancelled", undefined, null, "expired", WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).failureKind,
    ACP_FAILURE_CANCELLED,
    "an expiry token beside a cancelled turn with no gate evidence is diagnostic only"
  );
  assert.equal(
    classifyAcpStopReason("max_tokens", undefined, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).failureKind,
    ACP_FAILURE_MAX_TOKENS
  );
  assert.equal(
    classifyAcpStopReason("future_reason", undefined, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).failureKind,
    ACP_FAILURE_STOP
  );
  assert.equal(
    classifyAcpStopReason("end_turn", undefined, null, null, WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL).failureKind,
    null,
    "a normal completion is never overridden"
  );
});

test("a recorded success-shaped record carrying the missing-finish quota normalizes through the production adapter", () => {
  // Defense in depth for a recorded/legacy success-shaped record: the adapter's
  // own normalization must reach the same rate-limit classification the bridge
  // writes, using the stream's bounded error detail.
  const adapter = win32Adapter();
  const state = adapter.createStreamState();
  const legacyShaped = {
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "refusal",
    error_detail: WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
    result: null,
    session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
  };
  for (const line of workbuddyTerminalLines(legacyShaped)) adapter.parseStreamLine(line, state);
  assert.equal(state.terminal, true);
  assert.equal(state.isError, true);
  assert.equal(state.resultSubtype, ACP_FAILURE_RATE_LIMIT, "the recorded quota is normalized as a rate limit");
  assert.equal(state.errorCode, ACP_FAILURE_RATE_LIMIT);
  assert.equal(state.stopReason, "refusal", "the provider's original stop reason survives normalization");

  // The same record carrying the earlier turn's rejection token: the token is
  // diagnostic and never overrides the proven quota (JQ-20261005-57).
  const withToken = adapter.createStreamState();
  const tokenShaped = { ...legacyShaped, approval_outcome: "rejected" };
  for (const line of workbuddyTerminalLines(tokenShaped)) adapter.parseStreamLine(line, withToken);
  assert.equal(withToken.resultSubtype, ACP_FAILURE_RATE_LIMIT, "a side rejection token never overrides the proven quota");
  assert.equal(withToken.errorCode, ACP_FAILURE_RATE_LIMIT);
  assert.equal(withToken.approvalOutcome, "rejected", "the diagnostic token still reaches the canonical state");
});

test("the observed missing-finish quota ends the durable job as a rate limit, not provider_refusal", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(
      dir,
      workbuddyTerminalLines(WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD),
      5
    );
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.notEqual(job.failureKind, ACP_FAILURE_REFUSAL, "the actual quota is never persisted as a refusal");
    assert.equal(job.failureKind, "cli_rate_limited", "the durable classification is the shared rate limit");
    assert.equal(
      job.stopReason,
      "rate_limit_fallback_exhausted",
      "with no configured fallback the chain honestly reports exhaustion"
    );
    assert.equal(job.result?.stopReason, "rate_limit_fallback_exhausted");
    assert.equal(job.result?.fallbackEligible, true, "the attempt itself was genuinely fallback eligible");
    assert.equal(
      job.result?.errorDetail,
      WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
      "the bounded provider diagnostic is durable on the attempt result"
    );
    assert.equal(job.finishReason ?? null, null, "no finish reason is invented");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed errorMessage is dropped and leaves the historical record unchanged", () => {  for (const unsafe of ['{"code":-32004,"data":{"x":1}}', "    at read (C:\\work\\x.js:1:2)", 42, ""]) {
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: "refusal",
      finalText: "",
      finishReason: "content_filter",
      errorDetail: unsafe as unknown as string
    });
    assert.equal("error_detail" in terminal.record, false, `unsafe detail ${JSON.stringify(unsafe)} is omitted`);
    assert.equal(terminal.record.finish_reason, "content_filter");
    assert.equal(terminal.exitCode, 11);
  }
});

test("the safe error detail ends durable state without changing the classification", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(
      dir,
      workbuddyTerminalLines(WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD),
      11
    );
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL, "the shared classification stays provider_refusal");
    assert.equal(job.stopReason, "refusal");
    assert.equal(job.finishReason, "content_filter", "the cause stays the provider finish reason");
    assert.equal(job.errorDetail, WORKBUDDY_REFUSAL_SAFE_DETAIL, "the safe detail is durable");
    assert.equal(job.result?.errorDetail, WORKBUDDY_REFUSAL_SAFE_DETAIL, "the safe detail is durable on the result too");
    assert.match(String(job.error), /content filter/i, "the classification wording is unchanged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed or oversized error detail is dropped, never carried into durable state", async () => {
  const dir = newTmp();
  try {
    // 401 chars exceeds the shared parser's defensive bound: omitted entirely.
    const oversized = { ...WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD, error_detail: "x".repeat(401) };
    const oversizedRun = await runWorkBuddyFixture(dir, workbuddyTerminalLines(oversized), 11);
    assert.equal(oversizedRun.job.errorDetail, null);
    assert.equal(oversizedRun.job.result?.errorDetail ?? null, null);

    // A non-string value is never coerced into a detail.
    const nonString = { ...WORKBUDDY_CONTENT_FILTER_DETAIL_RESULT_RECORD, error_detail: 42 };
    const nonStringRun = await runWorkBuddyFixture(dir, workbuddyTerminalLines(nonString), 11);
    assert.equal(nonStringRun.job.errorDetail, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a proven model-service error is durable as provider_model_error with finish_reason=error", async () => {
  // The installed runtime rejects session/prompt as a JSON-RPC error when the
  // model stream ends with finish_reason=error; the bridge writes exactly this
  // record and exits 16 (see the fixture provenance).
  const rebuilt = acpErrorResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    code: ACP_FAILURE_MODEL_ERROR,
    message: WORKBUDDY_MODEL_ERROR_MESSAGE,
    finishReason: "error"
  });
  assert.deepEqual(rebuilt, WORKBUDDY_MODEL_ERROR_RESULT_RECORD);

  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(dir, workbuddyTerminalLines(WORKBUDDY_MODEL_ERROR_RESULT_RECORD), 16);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_MODEL_ERROR, "a model-service failure is not reduced to bridge_error");
    assert.equal(job.stopReason, ACP_FAILURE_MODEL_ERROR);
    assert.equal(job.finishReason, "error", "the proven provider finish reason survives");
    assert.equal(job.result?.finishReason, "error");
    assert.equal(job.result?.errorDetail ?? null, null, "no error detail was published; none is invented");
    assert.match(String(job.error), /model service ended the response with an error/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a session_end event can never override the authoritative prompt result", async () => {
  // The installed runtime's session_end notification builder publishes only a
  // stopReason (cli/dist/codebuddy-headless.js buildAcpSessionEndUpdate) beside
  // the authoritative session/prompt response. This is the strongest fixture
  // proof at the service boundary: even a session_end-shaped canonical event
  // (which the bridge does not emit; see the normalizer test) arriving after
  // the refusal result cannot change the outcome.
  const dir = newTmp();
  try {
    const lines = [
      ...workbuddyTerminalLines(WORKBUDDY_CONTENT_FILTER_RESULT_RECORD),
      JSON.stringify({ type: "event", event: { type: "session_end", stopReason: "end_turn" } })
    ];
    const { status, job } = await runWorkBuddyFixture(dir, lines, 11);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_REFUSAL);
    assert.equal(job.stopReason, "refusal");
    assert.equal(job.finishReason, "content_filter");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-25: the declined WorkBuddy interactive tool-approval gate
// ---------------------------------------------------------------------------

test("the exact live high-risk approval request proves a tool-approval gate with its bounded tool name and its OWN operation detail", () => {
  // The live job (job-mupil5r4-pd51wy): WorkBuddy's own log shows
  // `reason={"type":"toolValidation","message":"High-risk command safety check"}`,
  // but the ACP request below IS the complete wire shape — the decision reason
  // never travels. The one provable fact is the interactive tool approval
  // itself, plus the provider's OWN named operation fields (command,
  // description) so a human can decide. The request is never copied wholesale,
  // and the extracted text is bounded/redacted by the shared approval boundary.
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  assert.ok(approval);
  assert.equal(approval.kind, "tool_approval");
  assert.equal(approval.toolName, "Bash", "the gate is proven with the bounded provider tool name");
  assert.equal(
    approval.detail?.command,
    'cd "C:/Users/TestUser/AppData/Local/Temp" && rm -rf wb-main && node jq-asar-extract.cjs ' +
      '"C:/Program Files/WorkBuddy/resources/app.asar" "main/" wb-main ".js" && du -sh wb-main',
    "the provider's actual command is carried, verbatim and readable"
  );
  assert.equal(approval.detail?.description, "Extract main/*.js and find finishReason");
  assert.equal(approval.detail?.path, null);
  assert.equal(approval.detail?.cwd, null);
  assert.equal(approval.detail?.title, null);
  // The raw request keys never survive as such.
  const wire = JSON.stringify(approval);
  assert.equal(wire.includes("rawInput"), false, "no raw provider payload field survives");
  assert.equal(wire.includes("toolCallId"), false, "no provider tool-call identity survives");
});

test("a declined approval gate ends as provider_permission_required, never provider_cancelled", () => {
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval
  });
  assert.equal(terminal.exitCode, 17);
  // Preserve the historical fixture for replay; newly generated copy uses the current brand.
  assert.deepEqual(terminal.record, {
    ...WORKBUDDY_PERMISSION_REQUIRED_RESULT_RECORD,
    error: {
      code: "provider_permission_required",
      message: "WorkBuddy AI required an interactive approval for a tool action, and CrewDispatch is non-interactive, so the run stopped (stop_reason=cancelled, finish_reason=tool_calls); the task did not complete."
    }
  } as Record<string, unknown>, "the current branded record preserves the historical failure semantics");
  assert.equal(terminal.record.stop_reason, "cancelled", "the provider's own stop reason stays preserved verbatim");
  assert.equal(terminal.record.finish_reason, "tool_calls", "the proven finish reason stays preserved");
  const message = String((terminal.record.error as { message?: unknown }).message);
  assert.match(message, /required an interactive approval/i);
  assert.doesNotMatch(message, /reported the turn as cancelled/i, "it never reads like a plain cancellation");
  const wire = JSON.stringify(terminal.record);
  assert.equal(wire.includes("rm -rf"), false, "the tool's command text never reaches the terminal record");
  assert.equal(wire.includes("wb-main"), false, "the tool's arguments never reach the terminal record");

  // The bridge's own exit namespace carries the new outcome to the shared
  // classifier, and it is never rate-limit fallback eligible.
  const classified = win32Adapter().classifyExit(17);
  assert.equal(classified.failureKind, ACP_FAILURE_PERMISSION_REQUIRED);
  assert.equal(classified.kind, ACP_FAILURE_PERMISSION_REQUIRED);
  assert.equal(classified.fallback, false);
});

test("a PROVEN approval expiry is its own durable diagnostic, never a cancellation or a decline", () => {
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval,
    approvalOutcome: "expired"
  });
  assert.equal(terminal.exitCode, 18);
  assert.equal(terminal.record.stop_reason, "cancelled", "the provider's own stop reason is kept separately and verbatim");
  assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_APPROVAL_EXPIRED);
  const message = String((terminal.record.error as { message?: unknown }).message);
  assert.match(message, /deadline passed/i);
  assert.doesNotMatch(message, /reported the turn as cancelled/i, "it never reads like a plain cancellation");
  assert.doesNotMatch(message, /non-interactive/i, "it is not the declined-gate message");
  // The bridge's exit namespace carries it to the shared classifier, and it is
  // never rate-limit fallback eligible.
  const classified = win32Adapter().classifyExit(18);
  assert.equal(classified.failureKind, ACP_FAILURE_APPROVAL_EXPIRED);
  assert.equal(classified.kind, ACP_FAILURE_APPROVAL_EXPIRED);
  assert.equal(classified.fallback, false);

  // ONLY the proven expiry INSIDE the gate shape raises it. A remembered gate
  // WITHOUT the expiry keeps the declined-gate classification; a bare cancelled
  // turn stays cancelled; and a normal completion is never overridden. The
  // token alone (no remembered gate evidence) is diagnostic only: the
  // terminal cause of an unrelated cancellation stands (JQ-20261005-57).
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, null).failureKind, ACP_FAILURE_PERMISSION_REQUIRED);
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, "expired").failureKind, ACP_FAILURE_APPROVAL_EXPIRED);
  assert.equal(
    classifyAcpStopReason("cancelled", "tool_calls", null, "expired").failureKind,
    ACP_FAILURE_CANCELLED,
    "without the remembered gate the expiry token never re-labels the cancellation"
  );
  assert.equal(classifyAcpStopReason("cancelled", "stop", approval, null).failureKind, ACP_FAILURE_CANCELLED);
  assert.equal(classifyAcpStopReason("cancelled", "stop", null, null).failureKind, ACP_FAILURE_CANCELLED);
  assert.equal(classifyAcpStopReason("end_turn", "stop", approval, "expired").failureKind, null, "a normal completion is never overridden");
  assert.equal(classifyAcpStopReason(null, null, approval, "expired").failureKind, null);
});

test("a PROVEN human rejection is its own durable outcome, never a decline or a cancellation", () => {
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval,
    approvalOutcome: "rejected"
  });
  assert.equal(terminal.exitCode, 19);
  assert.equal(terminal.record.stop_reason, "cancelled", "the provider's own stop reason is kept separately and verbatim");
  assert.equal(terminal.record.approval_outcome, "rejected", "the bounded token rides the terminal record");
  assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_APPROVAL_REJECTED);
  const message = String((terminal.record.error as { message?: unknown }).message);
  assert.match(message, /rejected/i);
  assert.doesNotMatch(message, /non-interactive/i, "a human rejection is never the missing-route message");
  assert.doesNotMatch(message, /reported the turn as cancelled/i, "it never reads like a plain cancellation");
  const wire = JSON.stringify(terminal.record);
  assert.equal(wire.includes("rm -rf"), false, "no tool input reaches the terminal record");
  // The bridge's exit namespace carries it to the shared classifier, and it is
  // never rate-limit fallback eligible.
  const classified = win32Adapter().classifyExit(19);
  assert.equal(classified.failureKind, ACP_FAILURE_APPROVAL_REJECTED);
  assert.equal(classified.kind, ACP_FAILURE_APPROVAL_REJECTED);
  assert.equal(classified.fallback, false);

  // The proven rejection is the MOST specific outcome of the turn: it wins over
  // the declined-gate and cancellation classifications. The unavailable causes
  // keep the declined-gate classification; an abandoned wait stays cancelled;
  // and a normal completion is never overridden.
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, "rejected").failureKind, ACP_FAILURE_APPROVAL_REJECTED);
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, "expired").failureKind, ACP_FAILURE_APPROVAL_EXPIRED);
  for (const cause of ["no_route", "no_allow_option", "publish_failed"] as const) {
    assert.equal(
      classifyAcpStopReason("cancelled", "tool_calls", approval, cause).failureKind,
      ACP_FAILURE_PERMISSION_REQUIRED,
      `${cause} keeps the historical declined-gate classification`
    );
  }
  assert.equal(
    classifyAcpStopReason("cancelled", "tool_calls", approval, "cancelled").failureKind,
    ACP_FAILURE_CANCELLED,
    "an abandoned wait is never re-labelled as a declined gate"
  );
  assert.equal(classifyAcpStopReason("end_turn", "stop", approval, "rejected").failureKind, null, "a normal completion is never overridden");
  assert.equal(classifyAcpStopReason(null, null, approval, "rejected").failureKind, null);

  // Rate-limit evidence keeps its precedence over an UNAVAILABLE cause: the
  // quota shape is the turn's actual terminal cause, while a missing approval
  // route does not explain a refusal.
  assert.equal(
    classifyAcpStopReason("refusal", "tool_calls", null, "no_route", WORKBUDDY_QUOTA_ERROR_DETAIL).failureKind,
    ACP_FAILURE_RATE_LIMIT
  );
  assert.equal(
    classifyAcpStopReason("refusal", "tool_calls", null, "no_route", WORKBUDDY_QUOTA_ERROR_DETAIL).exitCode,
    5
  );
});

test("the recorded quota keeps the shared rate limit after an earlier rejected or expired gate (JQ-20261005-57)", () => {
  // Generation-0 regression: an UNCONDITIONAL `approvalOutcome === "rejected"`
  // branch ran BEFORE the recorded quota exception, so a turn whose earlier
  // tool gate was rejected and whose terminal cause is the provider's own
  // quota became provider_approval_rejected (exit 19) and the configured
  // fallback was disabled. The turn-level token is DIAGNOSTIC evidence, never
  // the terminal cause: the proven quota must stay the shared rate limit
  // (exit 5, fallback eligible) with the token still carried on the record.
  const quotaAfterRejected = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: "tool_calls",
    errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL,
    approvalOutcome: "rejected"
  });
  assert.equal(quotaAfterRejected.exitCode, 5, "a later proven quota is still the shared rate limit");
  assert.equal((quotaAfterRejected.record.error as Record<string, unknown>).code, ACP_FAILURE_RATE_LIMIT);
  assert.equal(quotaAfterRejected.record.approval_outcome, "rejected", "the earlier rejection stays diagnostic evidence");
  assert.equal(
    win32Adapter().classifyExit(quotaAfterRejected.exitCode).fallback,
    true,
    "the configured fallback stays eligible through the REAL exit classifier"
  );

  // The recorded missing-finish live shape with the same side token.
  const missingFinish = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "refusal",
    finalText: "",
    finishReason: null,
    errorDetail: WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
    approvalOutcome: "rejected"
  });
  assert.equal(missingFinish.exitCode, 5);
  assert.equal((missingFinish.record.error as Record<string, unknown>).code, ACP_FAILURE_RATE_LIMIT);
  assert.equal(missingFinish.record.approval_outcome, "rejected");
  assert.equal("finish_reason" in missingFinish.record, false, "no finish reason is invented");

  // AFTER an expiry: identical classification, identical diagnostic retention.
  for (const outcome of ["rejected", "expired"] as const) {
    for (const finish of [null, "tool_calls"] as const) {
      const cls = classifyAcpStopReason("refusal", finish, null, outcome, WORKBUDDY_QUOTA_ERROR_DETAIL);
      assert.equal(cls.failureKind, ACP_FAILURE_RATE_LIMIT, `${outcome} beside the quota shape keeps the rate limit`);
      assert.equal(cls.exitCode, 5);
    }
  }

  // Unrelated terminal causes are never overwritten by the side token: an
  // explicit content filter / refusal, an unrecognized stop reason and a
  // completion keep their own honest cause, and a cancellation WITHOUT the
  // remembered gate evidence stays cancelled.
  assert.equal(classifyAcpStopReason("refusal", "content_filter", null, "rejected", WORKBUDDY_QUOTA_ERROR_DETAIL).exitCode, 11);
  assert.equal(classifyAcpStopReason("refusal", "refusal", null, "expired", WORKBUDDY_QUOTA_ERROR_DETAIL).exitCode, 11);
  assert.equal(classifyAcpStopReason("future_reason", "tool_calls", null, "rejected").failureKind, ACP_FAILURE_STOP);
  // The literal `rate_limit` stop reason is NOT a supported native quota shape
  // (the recorded quota arrives as stop_reason=refusal); it is included ONLY
  // as an unrelated-stop counterexample.
  assert.equal(classifyAcpStopReason("rate_limit", null, null, "rejected").failureKind, ACP_FAILURE_STOP);
  assert.equal(classifyAcpStopReason("rate_limit", null, null, "rejected").exitCode, 15);
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", null, "rejected").failureKind, ACP_FAILURE_CANCELLED);
  assert.equal(classifyAcpStopReason("end_turn", null, null, "rejected").failureKind, null);

  // A REAL approval-caused interruption keeps its precise diagnosis.
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, "rejected").failureKind, ACP_FAILURE_APPROVAL_REJECTED);
  assert.equal(classifyAcpStopReason("cancelled", "tool_calls", approval, "expired").failureKind, ACP_FAILURE_APPROVAL_EXPIRED);
});

test("the terminal classification uses the CURRENT gate's own outcome, never another request's turn summary (JQ-20261005-57)", () => {
  // Generation-1 regression: the bridge merges every gate of a prompt turn into
  // the turn-level `approvalOutcome` (rejected > expired > unavailable), but
  // that summary must never label the gate CURRENTLY remembered. `gateOutcome`
  // is the per-request causal value; `approvalOutcome` stays the record's
  // diagnostic summary.
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  assert.ok(approval, "the live request proves the gate");

  // Earlier rejection, CURRENT gate expired.
  const expired = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval,
    approvalOutcome: "rejected",
    gateOutcome: "expired"
  });
  assert.equal(expired.exitCode, 18, "the CURRENT gate's expiry is the causal outcome");
  assert.equal((expired.record.error as Record<string, unknown>).code, ACP_FAILURE_APPROVAL_EXPIRED);
  assert.equal(expired.record.approval_outcome, "rejected", "the turn summary stays the bounded diagnostic");

  // Earlier expiry, CURRENT gate unofferable.
  const unofferable = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval,
    approvalOutcome: "expired",
    gateOutcome: "no_route"
  });
  assert.equal(unofferable.exitCode, 17, "the CURRENT gate's missing route is the causal outcome");
  assert.equal((unofferable.record.error as Record<string, unknown>).code, ACP_FAILURE_PERMISSION_REQUIRED);
  assert.equal(unofferable.record.approval_outcome, "expired");

  // A satisfied current gate proves no cause: an explicit null gateOutcome is
  // authoritative even beside a turn summary, and a completion stays a success.
  const allowed = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: "done",
    finishReason: "stop",
    approval: null,
    approvalOutcome: "rejected",
    gateOutcome: null
  });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.record.approval_outcome, "rejected");

  // Callers without a separate current-gate value keep the documented
  // fallback: the turn token is used as the causal value.
  const fallback = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "cancelled",
    finalText: "",
    finishReason: "tool_calls",
    approval,
    approvalOutcome: "expired"
  });
  assert.equal(fallback.exitCode, 18);
  assert.equal((fallback.record.error as Record<string, unknown>).code, ACP_FAILURE_APPROVAL_EXPIRED);
});

test("a completed turn that still carries an unresolved approval outcome keeps its result and explains the interruption", () => {
  // The production defect: the provider turn COMPLETED (end_turn) while the
  // gated operation was rejected/never approved. The completion stays a
  // success — the turn really finished — but the bounded token rides the
  // success record so the canonical result can explain that the operation did
  // not run instead of reading as an unqualified success.
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT,
    finishReason: "stop",
    approvalOutcome: "rejected"
  });
  assert.equal(terminal.exitCode, 0, "the provider turn really completed");
  assert.equal(terminal.record.subtype, "success");
  assert.equal(terminal.record.is_error, false);
  assert.equal(terminal.record.result, WORKBUDDY_END_TURN_TEXT, "the real assistant result is preserved");
  assert.equal(terminal.record.approval_outcome, "rejected", "the unresolved interruption stays visible on the completed result");

  const expired = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT,
    approvalOutcome: "expired"
  });
  assert.equal(expired.exitCode, 0);
  assert.equal(expired.record.approval_outcome, "expired");

  // Without the token a completed turn keeps the exact historical shape (and
  // the UI then has no interruption to explain).
  const clean = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: WORKBUDDY_END_TURN_TEXT
  });
  assert.equal("approval_outcome" in clean.record, false);
});

test("a completed run with an unresolved rejection is done AND keeps the bounded interruption evidence", async () => {
  const dir = newTmp();
  try {
    const completedRejection = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: "end_turn",
      finalText: WORKBUDDY_END_TURN_TEXT,
      finishReason: "stop",
      approvalOutcome: "rejected"
    });
    const lines = [
      JSON.stringify({ type: "init", session_id: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, model: WORKBUDDY_TERMINAL_FIXTURE_MODEL }),
      JSON.stringify(completedRejection.record)
    ];
    const { status, job } = await runWorkBuddyFixture(dir, lines, completedRejection.exitCode);
    assert.equal(status, "done", "the provider turn really completed");
    assert.equal(job.status, "done");
    assert.equal(job.failureKind, null, "the completion keeps its status semantics; the token is evidence, not a failure");
    assert.equal(job.approvalOutcome, "rejected", "the durable canonical field carries the proven cause");
    assert.equal(job.result?.approvalOutcome, "rejected", "the compact result carries it too");
    assert.equal(job.result?.finalText, WORKBUDDY_END_TURN_TEXT, "the real assistant result is still preserved");
    assert.equal(job.result?.ok, true, "the turn itself succeeded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a later clean completion never inherits a previous generation's approval outcome", async () => {
  const dir = newTmp();
  try {
    const root = path.join(dir, "root");
    const cwd = path.join(dir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });
    const fixture = writeStreamFixture(dir, workbuddyTerminalLines(WORKBUDDY_END_TURN_RESULT_RECORD), 0);
    const job = createJobRecord({
      task: "continue the task",
      cwd,
      provider: "workbuddy-ai",
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
    });
    // The record carries the PREVIOUS generation's proven rejection, exactly as
    // a follow-up continuation of a completed interrupted turn would.
    job.generation = 1;
    job.approvalOutcome = "rejected";
    saveJob(root, job);
    const result = await runWorker({
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env, win32Adapter()),
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });
    assert.equal(result.status, "done");
    const reloaded = loadJob(root, job.id);
    assert.ok(reloaded);
    assert.equal(reloaded.approvalOutcome, null, "the new generation starts with no inherited approval evidence");
    assert.equal(reloaded.result?.approvalOutcome ?? null, null, "the clean turn's own result carries none either");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain cancelled turn without a proven approval gate keeps provider_cancelled semantics", () => {
  const approval = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  // No remembered request at all: the historical classification is untouched.
  assert.deepEqual(classifyAcpStopReason("cancelled", "tool_calls"), {
    failureKind: ACP_FAILURE_CANCELLED,
    message: "WorkBuddy AI reported the turn as cancelled (stop_reason=cancelled); the task did not complete.",
    exitCode: 14
  });
  // A remembered gate without the tool_calls finish reason is not the proven
  // shape: the historical cancellation classification stays.
  assert.equal(classifyAcpStopReason("cancelled", "stop", approval).failureKind, ACP_FAILURE_CANCELLED);
  assert.equal(classifyAcpStopReason("cancelled", null, approval).failureKind, ACP_FAILURE_CANCELLED);
  // A different stop reason is never refined by the evidence.
  assert.equal(classifyAcpStopReason("refusal", "tool_calls", approval).failureKind, ACP_FAILURE_REFUSAL);
  assert.equal(classifyAcpStopReason("end_turn", "stop", approval).failureKind, null);
});

test("the approval-gate extraction is bounded and never carries malicious or question payloads", () => {
  // Questions are interactive requests, not tool-approval gates: the
  // AskUserQuestion / ExitPlanMode tools and a questions payload are excluded.
  const live = WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS as {
    [key: string]: unknown;
    toolCall: Record<string, unknown>;
  };
  const withToolName = (name: unknown): unknown => ({
    ...live,
    toolCall: { ...live.toolCall, _meta: { "codebuddy.ai/toolName": name } }
  });
  assert.equal(acpToolApprovalEvidence(withToolName("AskUserQuestion")), null);
  assert.equal(acpToolApprovalEvidence(withToolName("ExitPlanMode")), null);
  assert.equal(
    acpToolApprovalEvidence({
      ...live,
      toolCall: { ...live.toolCall, rawInput: { questions: [{ question: "pick one" }] } }
    }),
    null,
    "a question payload is never a permission gate"
  );

  // Structural proof is required: no toolCall / no toolCallId / no reject option.
  assert.equal(acpToolApprovalEvidence(null), null);
  assert.equal(acpToolApprovalEvidence("session/request_permission"), null);
  assert.equal(acpToolApprovalEvidence({ ...live, toolCall: null }), null);
  assert.equal(acpToolApprovalEvidence({ ...live, toolCall: { ...live.toolCall, toolCallId: "" } }), null);
  assert.equal(acpToolApprovalEvidence({ ...live, options: [{ kind: "allow_once", optionId: "allow" }] }), null);

  // Malicious/oversized values can never leak: an unsafe tool name is dropped,
  // the gate itself is still proven, and only the provider's OWN named
  // operation fields are extracted. Bounding and credential redaction happen at
  // the shared approval boundary (sanitizeApprovalDetail) before the text can
  // reach a file, a durable record, the Hub or the UI.
  const oversized = withToolName("x".repeat(5000));
  const oversizedEvidence = acpToolApprovalEvidence(oversized);
  assert.equal(oversizedEvidence?.kind, "tool_approval");
  assert.equal(oversizedEvidence?.toolName, null, "an unsafe tool name is dropped, never rewritten");
  assert.equal(oversizedEvidence?.detail?.description, "Extract main/*.js and find finishReason");
  const injection = withToolName("Bash; rm -rf /\n{\"payload\":true}");
  const injectionEvidence = acpToolApprovalEvidence(injection);
  assert.equal(injectionEvidence?.kind, "tool_approval");
  assert.equal(injectionEvidence?.toolName, null, "an injection-shaped tool name is dropped, never rewritten");
  const unsafeNested = acpToolApprovalEvidence({
    ...live,
    options: [{ kind: "reject_once", optionId: "reject", raw: "y".repeat(10000) }],
    toolCall: { ...live.toolCall, rawInput: { command: "z".repeat(10000) } }
  });
  assert.equal(unsafeNested?.kind, "tool_approval");
  assert.equal(unsafeNested?.toolName, "Bash");
  assert.equal(unsafeNested?.detail?.command, "z".repeat(10000), "only the named command field is carried");
  assert.equal(unsafeNested?.detail?.cwd, null, "unpublished operation fields stay null");
});

test("a declined approval gate ends durable state honestly and is not a cancellation", async () => {
  const dir = newTmp();
  try {
    const { status, job } = await runWorkBuddyFixture(dir, workbuddyTerminalLines(WORKBUDDY_PERMISSION_REQUIRED_RESULT_RECORD), 17);
    assert.notEqual(status, "done");
    assert.equal(job.status, "error");
    assert.equal(job.failureKind, ACP_FAILURE_PERMISSION_REQUIRED, "the gate is not reduced to a provider cancellation");
    assert.equal(job.stopReason, "cancelled", "the provider's own stop reason stays visible");
    assert.equal(job.finishReason, "tool_calls");
    assert.equal(job.cancelIntent.requested, false, "nothing cancelled the run; the provider required an approval");
    assert.match(String(job.error), /required an interactive approval/i);
    assert.doesNotMatch(String(job.error), /reported the turn as cancelled/i, "the durable cause never looks like cancellation");
    assert.equal(job.result?.kind, ACP_FAILURE_PERMISSION_REQUIRED);
    assert.equal(job.result?.exitCode, 17);
    assert.equal(JSON.stringify(job).includes("rm -rf"), false, "no tool argument text is durable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
