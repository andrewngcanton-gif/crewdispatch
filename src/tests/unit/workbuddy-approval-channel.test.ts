// WorkBuddy interactive approval — JQ-20261001-26.
//
// One running WorkBuddy turn may demand an explicit tool approval
// (`session/request_permission`). These tests prove the interactive channel:
// a bounded display-safe pending object, an exclusive first-write-wins decision
// claim, the exact provider option echoed back on the SAME JSON-RPC request,
// expiry/teardown clearance and the unchanged safe non-interactive decline when
// no Hub route exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import {
  APPROVAL_ARGS_MAX,
  APPROVAL_DEFAULT_TIMEOUT_MS,
  APPROVAL_DETAIL_CAP,
  APPROVAL_DETAIL_SCAN_CAP,
  APPROVAL_LABEL_CAP,
  approvalDecisionPath,
  approvalRequestPath,
  canonicalApprovalKind,
  claimApprovalDecision,
  clearHubApprovalEndpoint,
  readPendingApproval,
  sanitizeApprovalDetail,
  writeHubApprovalEndpoint,
  type ApprovalDecision,
  type PendingApproval
} from "../../jobs/approval";
import { COMMAND_CODE_PROVIDER } from "../../providers/command-code/capability";
import {
  ApprovalChannel,
  applyApprovalStreamLine,
  approvalOptionsFromParams,
  approvalOutcomeOfAnswer,
  approvalPendingRecord,
  approvalResolvedRecord,
  mergeApprovalOutcome,
  WORKBUDDY_APPROVAL_PROVIDER_ID
} from "../../providers/workbuddy-ai/approval-channel";
import {
  ACP_FAILURE_APPROVAL_EXPIRED,
  ACP_FAILURE_APPROVAL_REJECTED,
  ACP_FAILURE_PERMISSION_REQUIRED,
  acpInitRecord,
  acpTerminalResultRecord,
  acpToolApprovalEvidence,
  createAcpNormalizer
} from "../../providers/workbuddy-ai/acp-normalizer";
import { AcpClient } from "../../providers/workbuddy-ai/desktop-bridge";
import { createWorkBuddyAiAdapter, WORKBUDDY_AI_PROVIDER } from "../../providers/workbuddy-ai/index";
import { createJobRecord, runWorker } from "../../jobs/service";
import { jobPath, loadJob, saveJob } from "../../jobs/store";
import { createFixtureRunner } from "../../cli/fixture-runner";
import {
  WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS,
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID
} from "../fixtures/workbuddy-terminal-records";

const JOB_ID = "job-approval-fixture";
const GENERATION = 2;
const REQUEST_ID = "9001";

function newTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-approval-${prefix}-`));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A minimal live CrewDispatch-Hub ping endpoint (the approval route probe). */
async function startFakeHub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/ping") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "jobquay", version: "test", build_id: "test" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake hub did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

function identity(dataRoot: string) {
  return { jobId: JOB_ID, generation: GENERATION, dataRoot, provider: WORKBUDDY_APPROVAL_PROVIDER_ID };
}

function decisionFor(optionId: string, overrides: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    version: 1,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: REQUEST_ID,
    optionId,
    kind: canonicalApprovalKind(optionId) ?? "unknown",
    decidedAt: new Date().toISOString(),
    by: "hub",
    ...overrides
  };
}

function liveEvidence() {
  const evidence = acpToolApprovalEvidence(WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
  assert.ok(evidence, "the live request must prove a tool-approval gate");
  return evidence;
}

function channelFor(
  dataRoot: string,
  emitted: Record<string, unknown>[],
  options: { hubUrl?: string | null; timeoutMs?: number; markerPort?: number | null } = {}
): ApprovalChannel {
  if (options.markerPort != null) writeHubApprovalEndpoint(dataRoot, { port: options.markerPort, pid: process.pid });
  return new ApprovalChannel(identity(dataRoot), {
    emit: (record) => emitted.push(record),
    env: options.hubUrl ? { JOBQUAY_HUB_URL: options.hubUrl } : {},
    pollMs: 15,
    timeoutMs: options.timeoutMs ?? 5000
  });
}

// ---------------------------------------------------------------------------
// The bounded pending object + the exclusive decision claim
// ---------------------------------------------------------------------------

test("a live approval becomes one bounded pending object; the Hub decision is claimed exactly once and answers with the provider's own option", async () => {
  const dir = newTmp("roundtrip");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const emitted: Record<string, unknown>[] = [];
  const channel = channelFor(root, emitted, { hubUrl: hub.url });
  try {
    const pendingAnswer = channel.request(REQUEST_ID, liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, REQUEST_ID);
    await waitFor(() => fs.existsSync(requestFile), 5000, "the pending request file");

    const pending = readPendingApproval(root, JOB_ID, GENERATION, REQUEST_ID);
    assert.ok(pending, "the pending approval must be materialized");
    assert.equal(pending.provider, WORKBUDDY_APPROVAL_PROVIDER_ID);
    assert.equal(pending.jobId, JOB_ID);
    assert.equal(pending.generation, GENERATION);
    assert.equal(pending.requestId, REQUEST_ID);
    assert.equal(pending.toolName, "Bash");
    assert.deepEqual(pending.options, [
      { id: "allow_always", kind: "allow_always", label: "Always Allow" },
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ]);
    // REVISED contract: the pending object DOES carry one bounded provider-neutral
    // operation detail — the actual command and the provider's description — so a
    // human can decide. It is the ONLY provider text that survives, and it is
    // extracted field by field, never copied wholesale.
    assert.deepEqual(pending.detail, {
      command:
        'cd "C:/Users/TestUser/AppData/Local/Temp" && rm -rf wb-main && node jq-asar-extract.cjs ' +
        '"C:/Program Files/WorkBuddy/resources/app.asar" "main/" wb-main ".js" && du -sh wb-main',
      args: null,
      description: "Extract main/*.js and find finishReason",
      path: null,
      cwd: null,
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    }, "the actual command is carried verbatim and readable");

    // Display-safety: the raw provider payload still never materializes — only
    // the named operation fields. No rawInput key, no tool-call identity, no
    // provider meta, no prompt text.
    const text = fs.readFileSync(requestFile, "utf8");
    assert.equal(text.includes("rawInput"), false, "no raw provider payload field survives");
    assert.equal(text.includes("toolCallId"), false, "no provider tool-call identity survives");
    assert.equal(text.includes("codebuddy.ai"), false, "no provider meta keys survive");
    assert.equal(text.includes("request_permission"), false, "no transport method name survives");
    assert.deepEqual(emitted, [{ type: "approval", phase: "pending", approval: pending }], "one pending stream record, exactly the durable object");

    // First-write-wins: the winner's decision is what every later caller sees.
    const claim = claimApprovalDecision(root, decisionFor("allow"));
    assert.equal(claim.claimed, true);
    const duplicate = claimApprovalDecision(root, decisionFor("reject"));
    assert.equal(duplicate.claimed, false, "a second answer can never resolve the same request twice");
    assert.equal(duplicate.existing?.optionId, "allow", "a duplicate answer reads the winner back");

    const answer = await pendingAnswer;
    assert.deepEqual(
      answer,
      { kind: "selected", optionId: "allow", allows: true, rejects: false },
      "the exact provider option is returned for the SAME request"
    );
    assert.equal(fs.existsSync(requestFile), false, "the consumed request file is cleared");
    assert.equal(emitted.filter((record) => record.phase === "resolved").length, 1);
    assert.deepEqual(emitted[1], { type: "approval", phase: "resolved", request_id: REQUEST_ID, option_id: "allow", decision: "selected" });
    assert.equal(fs.existsSync(approvalDecisionPath(root, JOB_ID, GENERATION, REQUEST_ID)), true, "the winning decision stays on disk for late callers");
  } finally {
    channel.dispose();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the operation detail is extracted field by field, bounded, control-stripped and credential-redacted", () => {
  // Only the provider's OWN named fields are read; the actual command is kept
  // readable (newlines preserved) and preferred over the paraphrase.
  const evidence = acpToolApprovalEvidence({
    options: [{ kind: "reject_once", optionId: "reject" }],
    toolCall: {
      toolCallId: "call-1",
      title: "Bash",
      description: "tool-level description",
      rawInput: {
        command: "npm run build\nnpm test",
        file_path: "C:/repo/src/index.ts",
        cwd: "C:/repo",
        env: { SECRET_TOKEN: "must-not-leak" },
        extra: "must-not-leak"
      }
    }
  });
  assert.ok(evidence);
  assert.deepEqual(evidence.detail, {
    command: "npm run build\nnpm test",
    description: "tool-level description",
    path: "C:/repo/src/index.ts",
    cwd: "C:/repo",
    title: "Bash",
    gate: null,
    reason: null
  }, "only the named operation fields are extracted, never env/extra");

  const detail = sanitizeApprovalDetail(evidence.detail);
  assert.ok(detail);
  assert.equal(detail.command, "npm run build\nnpm test", "the multiline command stays readable");
  assert.equal(detail.path, "C:/repo/src/index.ts");
  assert.equal(detail.cwd, "C:/repo");
  assert.equal(detail.redacted, false);
  assert.equal(detail.truncated, false);

  // Obvious credentials are redacted; the flag is honest.
  const secret = sanitizeApprovalDetail({
    command: 'curl -H "Authorization: Bearer sk-live-abcdef123456" --data "password=hunter2" https://x',
    cwd: "Authorization: Basic Zm9vOmJhcg=="
  });
  assert.ok(secret);
  assert.equal(secret.redacted, true);
  assert.equal(secret.command?.includes("sk-live-abcdef123456"), false, "the bearer token never survives");
  assert.equal(secret.command?.includes("hunter2"), false, "the password value never survives");
  assert.equal(secret.cwd?.includes("Zm9vOmJhcg=="), false, "the basic-auth value never survives");
  assert.match(secret.command ?? "", /<redacted>/);

  // A whitespace-separated CLI flag is a credential too, even without `:`/`=`.
  const flagged = sanitizeApprovalDetail({
    command: "deploy --password hunter2 --api-key sk-live-abcdef123456 --region eu"
  });
  assert.ok(flagged);
  assert.equal(flagged.redacted, true);
  assert.equal(flagged.command?.includes("hunter2"), false, "a --password flag value never survives");
  assert.equal(flagged.command?.includes("sk-live-abcdef123456"), false, "an --api-key flag value never survives");
  assert.match(flagged.command ?? "", /--password <redacted>/);
  assert.match(flagged.command ?? "", /--api-key <redacted>/);
  assert.match(flagged.command ?? "", /--region eu/, "an unrelated flag is untouched");
  // A bare keyword in prose is still left alone (no `:`/`=`/dash/quotes).
  const prose = sanitizeApprovalDetail({ command: "echo the password value is stored" });
  assert.ok(prose);
  assert.equal(prose.redacted, false, "ordinary prose is not treated as a credential");

  // Control/ANSI sequences are stripped, and the result is bounded with an
  // honest truncation mark.
  const ansi = sanitizeApprovalDetail({ command: "\u001b[31mred\u001b[0m\u0007ok" });
  assert.equal(ansi?.command, "redok");
  const huge = sanitizeApprovalDetail({ command: "x".repeat(APPROVAL_DETAIL_CAP + 250) });
  assert.equal(huge?.truncated, true);
  assert.equal(huge?.command?.length, APPROVAL_DETAIL_CAP);

  // Nothing usable -> null (the UI then says so explicitly).
  assert.equal(sanitizeApprovalDetail(null), null);
  assert.equal(sanitizeApprovalDetail({}), null);
  assert.equal(sanitizeApprovalDetail({ command: "   ", description: "\u0000" }), null);
  // Re-normalizing keeps the honest marks instead of clearing them.
  const roundTrip = sanitizeApprovalDetail({ ...huge, truncated: true });
  assert.equal(roundTrip?.truncated, true);
});

test("the shared detail sanitizer bounds and redacts separately supplied arguments without re-joining argv", () => {
  // The provider published the executable and the arguments separately: both
  // survive as their own canonical fields, each argument as its own entry.
  const separated = sanitizeApprovalDetail({ command: "node", args: ["wait-for-resume.cjs", "a b", "c\t d"] });
  assert.ok(separated);
  assert.equal(separated.command, "node");
  assert.deepEqual(separated.args, ["wait-for-resume.cjs", "a b", "c\t d"], "argv boundaries and an argument's own whitespace are preserved");
  assert.equal(separated.truncated, false);
  assert.equal(separated.redacted, false);
  // A single string is accepted as a one-element list (the provider's own wire
  // accepts both shapes).
  assert.deepEqual(sanitizeApprovalDetail({ args: "single-arg" })?.args, ["single-arg"]);

  // The EXACT argument value is the point: ordinary whitespace — leading and
  // trailing spaces, tabs, trailing spaces before a newline, consecutive
  // newlines — is preserved byte-for-byte, never trimmed or collapsed.
  const exact = sanitizeApprovalDetail({
    command: "node",
    args: [" leading and trailing ", "tab\there", "a\n\n\nb", "trail   \nnext"]
  });
  assert.deepEqual(
    exact?.args,
    [" leading and trailing ", "tab\there", "a\n\n\nb", "trail   \nnext"],
    "an argument's own whitespace survives exactly"
  );
  assert.equal(exact?.truncated, false, "preserving whitespace is not a truncation");

  // An EMPTY argument is real, known argv data: kept verbatim in order, never
  // marked truncated, and never a reason to stop the list.
  const empty = sanitizeApprovalDetail({ command: "node", args: ["", "next"] });
  assert.deepEqual(empty?.args, ["", "next"], "an empty argument is preserved in order with the entries after it");
  assert.equal(empty?.truncated, false, "an empty argument is not malformed data");
  const blank = sanitizeApprovalDetail({ args: ["   ", ""] });
  assert.deepEqual(blank?.args, ["   ", ""], "whitespace-only and empty entries are preserved");
  assert.equal(blank?.truncated, false);
  // Idempotent for the empty entry too: persistence re-normalizes the record.
  assert.deepEqual(sanitizeApprovalDetail(empty)?.args, ["", "next"]);

  // The sanity scan cut is tracked SEPARATELY from the display bound: a huge
  // value that cleanup trims (or redaction shortens) to something tiny is
  // STILL honestly truncated, and another field keeps the detail usable.
  const scanTrimmed = sanitizeApprovalDetail({ command: "node" + " ".repeat(APPROVAL_DETAIL_SCAN_CAP + 100) });
  assert.equal(scanTrimmed?.command, "node", "cleanup still trims the displayed text");
  assert.equal(scanTrimmed?.truncated, true, "the scan cut is marked even though the remainder is short");
  const scanEmptied = sanitizeApprovalDetail({ args: ["ok"], title: " ".repeat(APPROVAL_DETAIL_SCAN_CAP + 100) });
  assert.equal(scanEmptied?.title, null, "cleanup can leave nothing displayable for the cut field");
  assert.deepEqual(scanEmptied?.args, ["ok"], "another field keeps the detail usable");
  assert.equal(scanEmptied?.truncated, true, "the emptied over-scan field still marks the detail truncated");
  const scanRedacted = sanitizeApprovalDetail({ command: "--token=" + "x".repeat(APPROVAL_DETAIL_SCAN_CAP + 100) });
  assert.equal(scanRedacted?.command, "--token=<redacted>", "the cut value still goes through the shared redaction");
  assert.equal(scanRedacted?.truncated, true, "the scan cut survives redaction");
  assert.equal(scanRedacted?.redacted, true);

  // An argument is bounded like every other detail field, with an honest mark.
  const longArg = sanitizeApprovalDetail({ args: ["y".repeat(APPROVAL_DETAIL_CAP + 10)] });
  assert.equal(longArg?.truncated, true);
  assert.equal(longArg?.args?.[0]?.length, APPROVAL_DETAIL_CAP);
  const many = sanitizeApprovalDetail({ args: Array.from({ length: APPROVAL_ARGS_MAX + 4 }, (_, index) => `arg-${index}`) });
  assert.equal(many?.truncated, true, "a list longer than the bound is marked truncated");
  assert.equal(many?.args?.length, APPROVAL_ARGS_MAX);
  // An element that cannot be displayed STOPS the list: the shown entries stay
  // a truthful argv PREFIX (a skipped middle element could imply a different
  // argument order), and the detail carries the honest truncation mark.
  const nonStrings = sanitizeApprovalDetail({ args: ["ok", 42, "never-shown"] });
  assert.deepEqual(nonStrings?.args, ["ok"], "an element that cannot be displayed is never stringified, and the list stops there");
  assert.equal(nonStrings?.truncated, true, "a stopped element list is an honest truncation mark");

  // Credentials inside one argument, and a flag/value split across TWO
  // arguments, are redacted exactly like the joined command line.
  const inline = sanitizeApprovalDetail({ command: "deploy", args: ["--token=sk-dummy-inline-0123456789", "--region", "eu"] });
  assert.equal(inline?.redacted, true);
  assert.equal(JSON.stringify(inline).includes("sk-dummy-inline-0123456789"), false);
  assert.match(inline?.args?.[0] ?? "", /--token=<redacted>/);
  assert.equal(inline?.args?.[2], "eu", "an unrelated argument is untouched");
  const split = sanitizeApprovalDetail({ command: "deploy", args: ["--api-key", "sk-dummy-split-0123456789", "keep-me"] });
  assert.equal(split?.redacted, true, "a credential split across argv elements is redacted");
  assert.deepEqual(split?.args, ["--api-key", "<redacted>", "keep-me"]);
  assert.equal(JSON.stringify(split).includes("sk-dummy-split-0123456789"), false);

  // Idempotent: re-normalizing an already-sanitized args list changes nothing.
  const again = sanitizeApprovalDetail(separated);
  assert.deepEqual(again?.args, separated.args);
  assert.equal(again?.truncated, separated.truncated);
  assert.equal(again?.redacted, separated.redacted);
  // No args at all stays null — never an empty array.
  assert.equal(sanitizeApprovalDetail({ command: "node" })?.args, null);
});

test("a gate with only a provider title still yields a detail; a gate with no operation fields yields null", () => {
  const titled = acpToolApprovalEvidence({
    options: [{ kind: "reject_once", optionId: "reject" }],
    toolCall: { toolCallId: "call-2", title: "Delete file" }
  });
  assert.ok(titled);
  assert.deepEqual(titled.detail, { command: null, description: null, path: null, cwd: null, title: "Delete file", gate: null, reason: null });

  // The provider's OWN gate/reason tokens are read from the ACP wire meta when
  // it published them, and only then. A gate that carries just those still
  // yields a displayable detail; a gate that carries none of the named fields
  // still yields null.
  const gated = acpToolApprovalEvidence({
    options: [{ kind: "reject_once", optionId: "reject" }],
    toolCall: {
      toolCallId: "call-4",
      _meta: {
        "codebuddy.ai/toolName": "Edit",
        "codebuddy.ai/approvalKind": "toolCallLoop",
        "codebuddy.ai/approvalCategory": "consecutive_same_tool"
      }
    }
  });
  assert.ok(gated);
  assert.equal(gated.detail?.gate, "toolCallLoop");
  assert.equal(gated.detail?.reason, "consecutive_same_tool");
  assert.equal(gated.detail?.command, null, "no command is invented for a loop gate");

  const bare = acpToolApprovalEvidence({
    options: [{ kind: "reject_once", optionId: "reject" }],
    toolCall: { toolCallId: "call-3", _meta: { "codebuddy.ai/toolName": "Bash" } }
  });
  assert.ok(bare, "the gate is still proven");
  assert.equal(bare.detail, null, "no operation fields -> no detail, never a fabricated one");
});

test("allow_always and a provider-declined option both round-trip the provider's own semantics", async () => {
  const dir = newTmp("semantics");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  try {
    const always = channelFor(root, [], { hubUrl: hub.url });
    const alwaysAnswer = always.request("9002", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9002")), 5000, "the allow_always request");
    assert.equal(claimApprovalDecision(root, decisionFor("allow_always", { requestId: "9002" })).claimed, true);
    assert.deepEqual(await alwaysAnswer, { kind: "selected", optionId: "allow_always", allows: true, rejects: false });
    always.dispose();

    // A provider-declined choice is STILL the provider's own option id in the
    // reply, but it is not an allow: the bridge must keep the gate evidence.
    const reject = channelFor(root, [], { hubUrl: hub.url });
    const rejectAnswer = reject.request("9003", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9003")), 5000, "the reject request");
    assert.equal(claimApprovalDecision(root, decisionFor("reject", { requestId: "9003" })).claimed, true);
    assert.deepEqual(
      await rejectAnswer,
      { kind: "selected", optionId: "reject", allows: false, rejects: true },
      "a canonical reject kind is the explicit classification evidence for a human rejection"
    );
    reject.dispose();
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a decision for another request identity, or an option the provider never published, is never consumed", async () => {
  const dir = newTmp("stale");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const channel = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 300 });
  try {
    // The approval provider id is the canonical adapter id (no drift between the
    // durable record's `provider` and the pending approval's).
    assert.equal(WORKBUDDY_APPROVAL_PROVIDER_ID, WORKBUDDY_AI_PROVIDER);

    // A decision claimed for an OLDER generation (a different file path) can
    // never answer this generation's request: after it sat on disk, the live
    // generation-2 request still has to expire unanswered.
    assert.equal(claimApprovalDecision(root, decisionFor("allow", { generation: GENERATION - 1 })).claimed, true);
    const nextGeneration = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 300 });
    const crossGeneration = nextGeneration.request("9012", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9012")), 5000, "the cross-generation request");
    assert.deepEqual(await crossGeneration, { kind: "declined", reason: "expired" }, "a stale generation's decision cannot answer a later request");
    nextGeneration.dispose();

    // An unknown option (even at the correct path) must not be echoed back.
    const unknownOption = channel.request("9004", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9004")), 5000, "the request file");
    assert.equal(claimApprovalDecision(root, decisionFor("rm-rf-now", { requestId: "9004" })).claimed, true);
    assert.deepEqual(await unknownOption, { kind: "declined", reason: "expired" }, "an unpublished option can never be selected");

    // A decision whose payload names a different request is invisible to this
    // request (identity mismatch), so it also never resolves it.
    const stale = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 300 });
    const staleAnswer = stale.request("9005", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9005")), 5000, "the stale request file");
    fs.writeFileSync(
      approvalDecisionPath(root, JOB_ID, GENERATION, "9005"),
      JSON.stringify({ ...decisionFor("allow"), requestId: "999999" }),
      "utf8"
    );
    assert.deepEqual(await staleAnswer, { kind: "declined", reason: "expired" }, "a foreign request identity cannot answer this one");
    stale.dispose();
  } finally {
    channel.dispose();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the pending approval expires on its own and leaves no pending state behind", async () => {
  const dir = newTmp("expiry");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const emitted: Record<string, unknown>[] = [];
  const channel = channelFor(root, emitted, { hubUrl: hub.url, timeoutMs: 250 });
  try {
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, "9006");
    const answer = await channel.request("9006", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    assert.deepEqual(answer, { kind: "declined", reason: "expired" });
    assert.equal(fs.existsSync(requestFile), false, "an expired request is cleared");
    assert.deepEqual(emitted[1], { type: "approval", phase: "resolved", request_id: "9006", option_id: null, decision: "expired" });
  } finally {
    channel.dispose();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared channel publishes the one-hour default for both provider identities; an explicit short override stays authoritative", async () => {
  const dir = newTmp("default-ttl");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  try {
    // The shared manual-approval wait is exactly one hour. It is a bounded
    // interactive GATE deadline only — never a task wall-clock timeout — and the
    // provider command caps / ACP request budgets keep their own separate values.
    assert.equal(APPROVAL_DEFAULT_TIMEOUT_MS, 3_600_000);

    // Both first-release provider identities construct the channel WITHOUT a
    // timeout override in production, so the shared default is what a real
    // pending request publishes for each of them.
    for (const provider of [WORKBUDDY_APPROVAL_PROVIDER_ID, COMMAND_CODE_PROVIDER]) {
      const requestId = `default-ttl-${provider}`;
      const emitted: Record<string, unknown>[] = [];
      const channel = new ApprovalChannel(
        { jobId: JOB_ID, generation: GENERATION, dataRoot: root, provider },
        { emit: (record) => emitted.push(record), env: { JOBQUAY_HUB_URL: hub.url }, pollMs: 15 }
      );
      try {
        const pendingAnswer = channel.request(requestId, liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
        const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, requestId);
        await waitFor(() => fs.existsSync(requestFile), 5000, `the ${provider} pending request`);
        const pending = readPendingApproval(root, JOB_ID, GENERATION, requestId);
        assert.ok(pending, `the ${provider} pending approval is materialized`);
        assert.equal(pending!.provider, provider, "the pending record carries the requesting provider identity");
        assert.deepEqual(emitted[0], approvalPendingRecord(pending!), "the published record is exactly the durable object");
        assert.equal(
          Date.parse(pending!.expiresAt) - Date.parse(pending!.createdAt),
          3_600_000,
          `the ${provider} channel without an override publishes exactly the one-hour default`
        );
        // Retire the wait deterministically instead of sleeping an hour.
        channel.cancel();
        assert.deepEqual(await pendingAnswer, { kind: "declined", reason: "disposed" });
      } finally {
        channel.dispose();
      }
    }

    // An explicit short override stays authoritative: the published window is
    // exactly the requested value, not the default.
    const overrideId = "default-ttl-override";
    const override = new ApprovalChannel(
      { jobId: JOB_ID, generation: GENERATION, dataRoot: root, provider: WORKBUDDY_APPROVAL_PROVIDER_ID },
      { emit: () => undefined, env: { JOBQUAY_HUB_URL: hub.url }, pollMs: 15, timeoutMs: 45_000 }
    );
    try {
      const overrideAnswer = override.request(overrideId, liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
      await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, overrideId)), 5000, "the short-override pending request");
      const pending = readPendingApproval(root, JOB_ID, GENERATION, overrideId);
      assert.ok(pending, "the short-override pending approval is materialized");
      assert.equal(
        Date.parse(pending!.expiresAt) - Date.parse(pending!.createdAt),
        45_000,
        "an explicit short override remains respected, not widened to the default"
      );
      override.cancel();
      assert.deepEqual(await overrideAnswer, { kind: "declined", reason: "disposed" });
    } finally {
      override.dispose();
    }
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge teardown (dispose) invalidates the pending approval for good; a prompt-end cancel leaves the channel usable", async () => {
  const dir = newTmp("teardown");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const emitted: Record<string, unknown>[] = [];
  try {
    // Prompt end: the wait is abandoned, the file cleared, the channel survives.
    const channel = channelFor(root, emitted, { hubUrl: hub.url });
    const abandoned = channel.request("9007", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9007")), 5000, "the abandoned request");
    channel.cancel();
    assert.deepEqual(await abandoned, { kind: "declined", reason: "disposed" });
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9007")), false);

    const next = channel.request("9008", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9008")), 5000, "the next request");
    assert.equal(claimApprovalDecision(root, decisionFor("allow", { requestId: "9008" })).claimed, true);
    assert.deepEqual(
      await next,
      { kind: "selected", optionId: "allow", allows: true, rejects: false },
      "a cancelled wait does not retire the channel"
    );

    // Bridge teardown: terminal for this channel and its pending state.
    const teardownEmitted: Record<string, unknown>[] = [];
    const teardown = channelFor(root, teardownEmitted, { hubUrl: hub.url });
    const pending = teardown.request("9009", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9009")), 5000, "the teardown request");
    teardown.dispose();
    assert.deepEqual(await pending, { kind: "declined", reason: "disposed" });
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9009")), false, "teardown clears the pending file");
    const teardownResolved = teardownEmitted.filter((record) => record.phase === "resolved");
    assert.deepEqual(teardownResolved, [{ type: "approval", phase: "resolved", request_id: "9009", option_id: null, decision: "disposed" }], "teardown publishes exactly ONE resolution for the pending request");
    assert.deepEqual(await teardown.request("9010", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS), { kind: "declined", reason: "disposed" });
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9010")), false, "a retired channel never materializes a new pending approval");
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no interactive Hub route keeps the historical immediate decline with no pending state at all", async () => {
  const dir = newTmp("nohub");
  const root = path.join(dir, "root");
  const emitted: Record<string, unknown>[] = [];
  try {
    // No marker and no explicit URL.
    const bare = channelFor(root, emitted);
    const started = Date.now();
    assert.deepEqual(await bare.request(REQUEST_ID, liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS), {
      kind: "declined",
      reason: "unavailable",
      cause: "no_route"
    });
    assert.ok(Date.now() - started < 4000, "the decline path is bounded, never a stalled turn");
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, REQUEST_ID)), false, "no request file without a route");
    assert.deepEqual(emitted, [], "no pending record without a route");

    // A stale marker pointing at a dead listener is the same safe decline.
    const deadPort = 9;
    writeHubApprovalEndpoint(root, { port: deadPort, pid: process.pid });
    const staleMarker = channelFor(root, []);
    assert.deepEqual(await staleMarker.request("9011", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS), {
      kind: "declined",
      reason: "unavailable",
      cause: "no_route"
    });
    clearHubApprovalEndpoint(root, process.pid);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every answer maps to exactly its proven outcome; only a real selected reject is a human rejection", () => {
  // A PROVEN allow explains nothing: no human-intent token is invented.
  assert.equal(approvalOutcomeOfAnswer({ kind: "selected", optionId: "allow", allows: true, rejects: false }), null);
  assert.equal(approvalOutcomeOfAnswer({ kind: "selected", optionId: "allow_always", allows: true, rejects: false }), null);
  // Only the provider's own selected CANONICAL reject option proves a human
  // rejection; the classification is the answer's explicit `rejects` evidence.
  assert.equal(approvalOutcomeOfAnswer({ kind: "selected", optionId: "reject", allows: false, rejects: true }), "rejected");
  assert.equal(approvalOutcomeOfAnswer({ kind: "selected", optionId: "deny", allows: false, rejects: true }), "rejected");
  // A selected option the canonical vocabulary does not recognize is neither:
  // no human intent may be inferred from an unknown provider kind.
  assert.equal(
    approvalOutcomeOfAnswer({ kind: "selected", optionId: "custom_1", allows: false, rejects: false }),
    null,
    "an unknown option kind proves no canonical decision"
  );
  // The channel's own resolutions.
  assert.equal(approvalOutcomeOfAnswer({ kind: "declined", reason: "expired" }), "expired");
  assert.equal(approvalOutcomeOfAnswer({ kind: "declined", reason: "disposed" }), "cancelled");
  // The unavailable sub-causes are carried verbatim, never collapsed.
  assert.equal(approvalOutcomeOfAnswer({ kind: "declined", reason: "unavailable", cause: "no_route" }), "no_route");
  assert.equal(approvalOutcomeOfAnswer({ kind: "declined", reason: "unavailable", cause: "no_allow_option" }), "no_allow_option");
  assert.equal(approvalOutcomeOfAnswer({ kind: "declined", reason: "unavailable", cause: "publish_failed" }), "publish_failed");
});

test("a provider-owned UNKNOWN option kind selected through the decision route is not a human rejection", async () => {
  // The provider published one allow option BESIDE one option whose kind is
  // outside the canonical vocabulary. The exact native id must still be echoed
  // back, but selecting it proves no canonical rejection: the bridge keeps its
  // conservative gate behavior and no `rejected` token is invented.
  const dir = newTmp("unknownkind");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const channel = channelFor(root, [], { hubUrl: hub.url });
  try {
    const params = {
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "custom_provider_kind", name: "Do the custom thing", optionId: "custom_1" }
      ]
    };
    const pending = channel.request("9020", liveEvidence(), params);
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9020")), 5000, "the unknown-kind request");
    const stored = readPendingApproval(root, JOB_ID, GENERATION, "9020");
    assert.ok(stored, "the pending request is materialized for the Hub");
    assert.equal(
      stored!.options.find((option) => option.id === "custom_1")?.kind,
      "custom_provider_kind",
      "the provider's own kind token is published verbatim"
    );
    assert.equal(canonicalApprovalKind("custom_provider_kind"), null, "the kind is genuinely outside the canonical vocabulary");

    assert.equal(claimApprovalDecision(root, decisionFor("custom_1", { requestId: "9020" })).claimed, true);
    const answer = await pending;
    assert.deepEqual(
      answer,
      { kind: "selected", optionId: "custom_1", allows: false, rejects: false },
      "the exact native option id is preserved and no canonical decision is inferred"
    );
    assert.equal(approvalOutcomeOfAnswer(answer), null, "an unknown kind never becomes a human rejection");
  } finally {
    channel.dispose();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the most specific proven outcome wins within one turn; equally specific causes keep the first", () => {
  assert.equal(mergeApprovalOutcome(null, "cancelled"), "cancelled");
  assert.equal(mergeApprovalOutcome("cancelled", "no_route"), "no_route");
  assert.equal(mergeApprovalOutcome("no_route", "expired"), "expired");
  assert.equal(mergeApprovalOutcome("expired", "rejected"), "rejected");
  assert.equal(mergeApprovalOutcome("rejected", "expired"), "rejected", "a later weaker cause never downgrades a human decision");
  assert.equal(mergeApprovalOutcome("expired", null), "expired");
  assert.equal(mergeApprovalOutcome(null, null), null);
  assert.equal(
    mergeApprovalOutcome("no_allow_option", "publish_failed"),
    "no_allow_option",
    "equally specific unavailable causes keep the FIRST observed one (stable, never an invented ordering)"
  );
});

test("the remaining unavailable sub-causes are proven by the channel itself: no allow option, publish failure", async () => {
  const dir = newTmp("subcause");
  try {
    const root = path.join(dir, "root");
    // The provider published only reject options: nothing could ever be offered.
    const noAllow = channelFor(root, []);
    assert.deepEqual(
      await noAllow.request("9101", liveEvidence(), { options: [{ kind: "reject_once", optionId: "reject" }] }),
      { kind: "declined", reason: "unavailable", cause: "no_allow_option" },
      "a gate that offers no allow choice is proven as such before any route probe"
    );
    noAllow.dispose();

    // A live route exists, but the pending request cannot be written: the
    // honest cause is a publish failure, not a missing route or a decision.
    const hub = await startFakeHub();
    const blocked = path.join(dir, "blocked-file");
    fs.writeFileSync(blocked, "not a directory");
    const broken = new ApprovalChannel(
      { jobId: JOB_ID, generation: GENERATION, dataRoot: path.join(blocked, "root"), provider: WORKBUDDY_APPROVAL_PROVIDER_ID },
      { emit: () => undefined, env: { JOBQUAY_HUB_URL: hub.url }, pollMs: 15, timeoutMs: 500 }
    );
    try {
      assert.deepEqual(
        await broken.request("9102", liveEvidence(), WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS),
        { kind: "declined", reason: "unavailable", cause: "publish_failed" }
      );
    } finally {
      broken.dispose();
      await hub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the approval stream records drive the canonical state and resolve only the matching request", () => {
  const adapter = createWorkBuddyAiAdapter({ platform: "win32" });
  const state = adapter.createStreamState();
  // Read through a helper: an assert.equal on the property itself would narrow
  // the mutable parse state for the rest of the test.
  const approvalRequestIdOf = (value: { approval: PendingApproval | null }): string | null =>
    value.approval ? value.approval.requestId : null;
  assert.equal(approvalRequestIdOf(state), null);
  const pending: PendingApproval = {
    version: 1,
    kind: "tool_approval",
    provider: WORKBUDDY_APPROVAL_PROVIDER_ID,
    jobId: JOB_ID,
    generation: GENERATION,
    requestId: REQUEST_ID,
    toolName: "Bash",
    summary: null,
    detail: null,
    options: [{ id: "allow", kind: "allow_once", label: "Allow" }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString()
  };

  assert.equal(applyApprovalStreamLine(JSON.stringify(approvalPendingRecord(pending)), state), true);
  assert.equal(approvalRequestIdOf(state), REQUEST_ID);
  assert.equal(state.unknownLines, 0, "an approval record is consumed by the provider, not counted as unknown");

  // A record for a DIFFERENT request must never clear the current one.
  applyApprovalStreamLine(JSON.stringify(approvalResolvedRecord({ requestId: "other", optionId: null, decision: "disposed" })), state);
  assert.equal(approvalRequestIdOf(state), REQUEST_ID);
  applyApprovalStreamLine(JSON.stringify(approvalResolvedRecord({ requestId: REQUEST_ID, optionId: "allow", decision: "selected" })), state);
  assert.equal(approvalRequestIdOf(state), null);

  // The adapter pipeline itself recognizes the record (no unknown-line growth)
  // and drops a malformed pending object instead of presenting it.
  adapter.parseStreamLine(JSON.stringify(approvalPendingRecord(pending)), state);
  assert.equal(approvalRequestIdOf(state), REQUEST_ID);
  adapter.parseStreamLine(JSON.stringify({ type: "approval", phase: "pending", approval: { kind: "tool_approval", jobId: JOB_ID } }), state);
  assert.equal(approvalRequestIdOf(state), null, "a malformed pending approval is never actionable");
  assert.equal(state.unknownLines, 0);
});

test("only provider-published options with safe ids/labels are extracted from the request", () => {
  const options = approvalOptionsFromParams({
    options: [
      { optionId: "allow", kind: "allow_once", name: "Allow", raw: "x".repeat(5000) },
      { optionId: "bad id!", kind: "allow_once", name: "Nope" },
      { optionId: "deny", kind: "reject", name: "Deny\nNow" },
      { optionId: "allow", kind: "allow_always", name: "duplicate id dropped" }
    ]
  });
  assert.deepEqual(options, [
    { id: "allow", kind: "allow_once", label: "Allow" },
    { id: "deny", kind: "reject", label: "Deny Now" }
  ]);
});

test("same-kind provider options keep their distinct bounded labels through extraction", () => {
  // The real Command Code ACP planning question published THREE options that
  // all carry `kind=allow_once` with DISTINCT provider labels (each already
  // clipped at the provider boundary's label cap). Extraction must keep every
  // label: the card renders the provider's own label as the choice text, so a
  // collapsed or dropped label would make the three choices indistinguishable.
  const observedLabels = [
    "Eligible-only, recovery disabled (Recommended): Codex records re",
    "Recover only provably-FAILED codex handoffs: Recover a codex_thr",
    "Not in scope at all: Recovery ships for claude_session only; no"
  ];
  const options = approvalOptionsFromParams({
    options: observedLabels.map((name, index) => ({ optionId: `option_${index}`, kind: "allow_once", name }))
  });
  assert.deepEqual(
    options,
    observedLabels.map((label, index) => ({ id: `option_${index}`, kind: "allow_once", label })),
    "three same-kind options keep three distinct provider labels in the provider's order"
  );
  assert.equal(new Set(options.map((option) => option.label)).size, 3, "no label is collapsed into a shared canonical phrase");
  for (const option of options) {
    assert.equal(option.label.length <= APPROVAL_LABEL_CAP, true, "each label stays inside the shared display bound");
  }

  // A missing or blank provider name falls back to the provider's own id (the
  // durable/UI contract reads a label equal to the id as "no usable label" and
  // only then shows the readable canonical kind wording).
  assert.deepEqual(
    approvalOptionsFromParams({
      options: [
        { optionId: "allow", kind: "allow_once" },
        { optionId: "deny", kind: "reject_once", name: "  " }
      ]
    }),
    [
      { id: "allow", kind: "allow_once", label: "allow" },
      { id: "deny", kind: "reject_once", label: "deny" }
    ],
    "a missing or blank provider name falls back to the option id, never an invented alias"
  );
});

// ---------------------------------------------------------------------------
// The real AcpClient: the SAME JSON-RPC request, answered from the Hub
// ---------------------------------------------------------------------------

interface FakeAcp {
  endpoint: string;
  replies: unknown[];
  prompts: number;
  close: () => Promise<void>;
}

/**
 * A fake ACP endpoint that emits the EXACT live approval request during the
 * first prompt and waits for the client's answer before completing the stream —
 * exactly like the installed runtime.
 */
async function startFakeAcp(promptResult: Record<string, unknown>): Promise<FakeAcp> {
  const PERMISSION_REQUEST_ID = 9001;
  let prompts = 0;
  const replies: unknown[] = [];
  const openStreams = new Map<number, ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string; result?: unknown };
        if (message.method === "session/prompt") {
          prompts += 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          openStreams.set(message.id as number, res);
          res.write(
            "data: " +
              JSON.stringify({
                jsonrpc: "2.0",
                id: PERMISSION_REQUEST_ID,
                method: "session/request_permission",
                params: WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS
              }) +
              "\n\n"
          );
          return;
        }
        if (message.id === PERMISSION_REQUEST_ID && "result" in message) {
          replies.push(message.result);
          for (const [promptId, stream] of openStreams) {
            openStreams.delete(promptId);
            stream.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: promptId, result: promptResult }) + "\n\n");
            stream.end();
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake ACP did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}/api/v1/acp`,
    replies,
    get prompts() { return prompts; },
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of openStreams.values()) stream.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

test("an APPROVED WorkBuddy gate answers the SAME JSON-RPC request with the provider option and the prompt continues", async () => {
  const dir = newTmp("approved");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startFakeAcp({ stopReason: "end_turn", _meta: { "codebuddy.ai/finishReason": "end_turn" } });
  const channel = channelFor(root, [], { hubUrl: hub.url });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const prompt = client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run the high-risk command");
    const requestFile = approvalRequestPath(root, JOB_ID, GENERATION, REQUEST_ID);
    await waitFor(() => fs.existsSync(requestFile), 5000, "the bridge's pending approval file");
    assert.equal(claimApprovalDecision(root, decisionFor("allow")).claimed, true);

    const result = await prompt;
    assert.deepEqual(acp.replies, [{ outcome: { outcome: "selected", optionId: "allow" } }], "the SAME request is answered with the provider's published option id");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.approval, null, "a satisfied gate leaves no JQ-25 evidence behind");
    assert.equal(result.approvalOutcome, null, "a PROVEN allow leaves nothing to explain; no human-intent token is invented");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome
    });
    assert.equal(terminal.exitCode, 0, "an approved, continuing run is a normal completion");
    assert.equal("approval_outcome" in terminal.record, false, "a normal completion keeps its exact historical shape");
    assert.equal(fs.existsSync(requestFile), false, "the pending file is cleared once consumed");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a REJECTED WorkBuddy gate is answered with the provider's reject option and carries the distinct human-rejection outcome", async () => {
  const dir = newTmp("rejected");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startFakeAcp({ stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } });
  const channel = channelFor(root, [], { hubUrl: hub.url });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const prompt = client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run the high-risk command");
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, REQUEST_ID)), 5000, "the reject approval file");
    assert.equal(claimApprovalDecision(root, decisionFor("reject")).claimed, true);

    const result = await prompt;
    assert.deepEqual(acp.replies, [{ outcome: { outcome: "selected", optionId: "reject" } }], "the provider's own reject option is echoed, never an alias");
    assert.equal(result.approval?.kind, "tool_approval", "a declined gate keeps its proof");
    assert.equal(result.approval?.toolName, "Bash");
    assert.match(
      String(result.approval?.detail?.command),
      /jq-asar-extract\.cjs/,
      "the gate also keeps the provider's own operation detail"
    );
    assert.equal(
      result.approvalOutcome,
      "rejected",
      "only the real selected reject option proves a human rejection"
    );
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome
    });
    assert.equal(terminal.exitCode, 19, "a proven rejection is its own durable outcome, never the non-interactive decline");
    assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_APPROVAL_REJECTED);
    assert.equal(terminal.record.approval_outcome, "rejected", "the bounded token rides the terminal record");
    assert.equal(terminal.record.stop_reason, "cancelled", "the provider's own stop reason stays preserved verbatim");
    const message = String((terminal.record.error as { message?: unknown }).message);
    assert.match(message, /rejected/i);
    assert.doesNotMatch(message, /non-interactive/i, "it is never the missing-route message");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PROVEN approval expiry is answered with the expiry reason and raises the distinct durable diagnostic", async () => {
  const dir = newTmp("expired");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startFakeAcp({ stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } });
  // A route exists but no decision ever arrives: the bounded wait expires.
  const channel = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 300 });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const result = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run the high-risk command");
    assert.deepEqual(
      acp.replies,
      [{ outcome: { outcome: "cancelled", reason: "CrewDispatch's interactive approval expired." } }],
      "the provider is told the deadline passed, not that CrewDispatch is non-interactive"
    );
    assert.equal(result.approvalOutcome, "expired", "the expiry is proven for THIS prompt turn");
    assert.equal(result.approval?.kind, "tool_approval", "the gate proof is still remembered");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome
    });
    assert.equal(terminal.exitCode, 18, "the proven expiry has its own terminal outcome");
    assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_APPROVAL_EXPIRED);
    assert.equal(terminal.record.approval_outcome, "expired", "the bounded token rides the terminal record");
    assert.equal(terminal.record.stop_reason, "cancelled", "the raw provider stop reason is kept separately");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no Hub route the bridge declines immediately, exactly as before, and keeps JQ-25", async () => {
  const dir = newTmp("decline");
  const root = path.join(dir, "root");
  const acp = await startFakeAcp({ stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } });
  const channel = channelFor(root, []);
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const result = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run the high-risk command");
    assert.deepEqual(acp.replies, [{ outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } }]);
    assert.equal(fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, REQUEST_ID)), false, "no interactive state is created without a route");
    assert.equal(result.approvalOutcome, "no_route", "the missing route is proven, never inferred as a human decision");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome
    });
    assert.equal(terminal.exitCode, 17, "the unattended permission interruption classification is unchanged");
    assert.equal(terminal.record.approval_outcome, "no_route", "the proven sub-cause rides the unchanged classification");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Several gates inside ONE prompt: the causal outcome is the CURRENT gate's
// ---------------------------------------------------------------------------

interface ScriptedAcpPrompt {
  /**
   * The gate request ids this prompt may see.
   * - `sequential`: gate n+1 is sent after the client answered gate n; the
   *   prompt result follows the last reply.
   * - `manual`: the first gate is sent with the prompt and the TEST sends each
   *   later gate itself (`sendGate`), so a second gate can deterministically
   *   arrive while the first one still waits; the prompt result follows the
   *   last reply.
   * - `nowait`: every gate is sent at once and the prompt result follows after
   *   a short delay WITHOUT waiting for any reply — the request outlives its
   *   own prompt turn.
   */
  gates: number[];
  mode: "sequential" | "manual" | "nowait";
  result: Record<string, unknown>;
}

interface ScriptedAcp {
  endpoint: string;
  replies: Array<{ id: number; result: unknown }>;
  /** Send one scripted gate on its open prompt stream (manual mode). */
  sendGate: (gateId: number) => void;
  close: () => Promise<void>;
}

/**
 * A fake ACP endpoint that emits SEQUENTIAL `session/request_permission` gates
 * inside ONE prompt, exactly like the installed runtime. The provider PROCESS
 * is the only fixture here: the real AcpClient, the real ApprovalChannel, the
 * real request/decision files and the production classifier run unchanged.
 */
async function startScriptedAcp(script: ScriptedAcpPrompt[]): Promise<ScriptedAcp> {
  interface PromptState {
    gates: number[];
    mode: ScriptedAcpPrompt["mode"];
    result: Record<string, unknown>;
    sent: number;
    done: boolean;
  }
  const replies: Array<{ id: number; result: unknown }> = [];
  const openStreams = new Map<number, ServerResponse>();
  const promptState = new Map<number, PromptState>();
  const gateOwner = new Map<number, number>();
  const timers = new Set<NodeJS.Timeout>();
  let promptIndex = 0;

  const writeResult = (promptId: number): void => {
    const state = promptState.get(promptId);
    const stream = openStreams.get(promptId);
    if (!state || state.done || !stream) return;
    state.done = true;
    openStreams.delete(promptId);
    stream.write("data: " + JSON.stringify({ jsonrpc: "2.0", id: promptId, result: state.result }) + "\n\n");
    stream.end();
  };

  const sendGateFrame = (promptId: number, gateId: number): void => {
    const stream = openStreams.get(promptId);
    if (!stream) return;
    stream.write(
      "data: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id: gateId,
          method: "session/request_permission",
          params: WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS
        }) +
        "\n\n"
    );
  };

  const sendNextGate = (promptId: number): void => {
    const state = promptState.get(promptId);
    if (!state || state.sent >= state.gates.length) return;
    const gateId = state.gates[state.sent];
    if (gateId === undefined) return;
    state.sent += 1;
    sendGateFrame(promptId, gateId);
  };

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string; result?: unknown };
        if (message.method === "session/prompt") {
          const spec = script[promptIndex++];
          if (!spec) {
            res.statusCode = 500;
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          const promptId = message.id as number;
          openStreams.set(promptId, res);
          promptState.set(promptId, { gates: spec.gates, mode: spec.mode, result: spec.result, sent: 0, done: false });
          for (const gate of spec.gates) gateOwner.set(gate, promptId);
          if (spec.gates.length === 0) {
            writeResult(promptId);
          } else if (spec.mode === "sequential" || spec.mode === "manual") {
            sendNextGate(promptId);
          } else if (spec.mode === "nowait") {
            for (const gate of spec.gates) sendNextGate(promptId);
            const timer = setTimeout(() => {
              timers.delete(timer);
              writeResult(promptId);
            }, 150);
            timers.add(timer);
          }
          return;
        }
        if (typeof message.id === "number" && gateOwner.has(message.id) && "result" in message) {
          const promptId = gateOwner.get(message.id) as number;
          const state = promptState.get(promptId);
          replies.push({ id: message.id, result: message.result });
          if (state && !state.done) {
            if (state.mode === "sequential") sendNextGate(promptId);
            if (state.gates.every((gate) => replies.some((reply) => reply.id === gate))) writeResult(promptId);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("scripted ACP did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}/api/v1/acp`,
    replies,
    sendGate: (gateId: number) => {
      const promptId = gateOwner.get(gateId);
      if (promptId === undefined) throw new Error(`gate ${gateId} was never scripted`);
      sendGateFrame(promptId, gateId);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const stream of openStreams.values()) stream.end();
        openStreams.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

test("two gates in one prompt: an earlier rejection never labels the current gate's expiry (JQ-20261005-57)", async () => {
  const dir = newTmp("gate-reject-expire");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startScriptedAcp([
    {
      gates: [9001, 9002],
      mode: "sequential",
      result: { stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } }
    }
  ]);
  const channel = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 300 });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const prompt = client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run two gated commands");
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9001")), 5000, "the first gate's request file");
    assert.equal(claimApprovalDecision(root, decisionFor("reject", { requestId: "9001" })).claimed, true, "the first gate is rejected through the decision route");

    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9002")), 5000, "the second gate's request file");
    const result = await prompt;

    assert.deepEqual(
      acp.replies,
      [
        { id: 9001, result: { outcome: { outcome: "selected", optionId: "reject" } } },
        { id: 9002, result: { outcome: { outcome: "cancelled", reason: "CrewDispatch's interactive approval expired." } } }
      ],
      "each request is answered on its own id with its own proven outcome"
    );
    assert.equal(result.approvalOutcome, "rejected", "the turn-level diagnostic keeps the most specific proven cause");
    assert.equal(result.gateOutcome, "expired", "the CURRENT gate's own cause is its expiry, never the earlier rejection");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome,
      gateOutcome: result.gateOutcome
    });
    assert.equal(terminal.exitCode, 18, "the causal classification is the CURRENT gate's expiry");
    assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_APPROVAL_EXPIRED);
    assert.equal(terminal.record.approval_outcome, "rejected", "the bounded turn summary remains the honest diagnostic");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two gates in one prompt: an earlier expiry never labels the current unofferable gate (JQ-20261005-57)", async () => {
  const dir = newTmp("gate-expire-no-route");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startScriptedAcp([
    {
      gates: [9001, 9002],
      mode: "manual",
      result: { stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } }
    }
  ]);
  const channel = channelFor(root, [], { hubUrl: hub.url, timeoutMs: 800 });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const prompt = client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run two gated commands");
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9001")), 5000, "the first gate's request file");
    // The second gate arrives while the first one still waits: one interactive
    // approval per connection, so it can never be offered — proven no_route.
    acp.sendGate(9002);
    const result = await prompt;

    assert.deepEqual(
      acp.replies.map((reply) => ({ id: reply.id, result: reply.result })),
      [
        { id: 9002, result: { outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } } },
        { id: 9001, result: { outcome: { outcome: "cancelled", reason: "CrewDispatch's interactive approval expired." } } }
      ],
      "the unofferable gate is declined immediately; the waiting gate still expires on its own deadline"
    );
    assert.equal(result.approvalOutcome, "expired", "the turn-level diagnostic keeps the most specific proven cause");
    assert.equal(result.gateOutcome, "no_route", "the CURRENT gate's own cause is the missing route");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome,
      gateOutcome: result.gateOutcome
    });
    assert.equal(terminal.exitCode, 17, "the causal classification is the declined-gate interruption, not the earlier expiry");
    assert.equal((terminal.record.error as { code?: unknown }).code, ACP_FAILURE_PERMISSION_REQUIRED);
    assert.equal(terminal.record.approval_outcome, "expired", "the bounded turn summary remains the honest diagnostic");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two gates in one prompt: a later allow clears the current gate and the turn completes normally (JQ-20261005-57)", async () => {
  const dir = newTmp("gate-reject-allow");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startScriptedAcp([
    {
      gates: [9001, 9002],
      mode: "sequential",
      result: { stopReason: "end_turn", _meta: { "codebuddy.ai/finishReason": "end_turn" } }
    }
  ]);
  const channel = channelFor(root, [], { hubUrl: hub.url });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const prompt = client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run two gated commands");
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9001")), 5000, "the first gate's request file");
    assert.equal(claimApprovalDecision(root, decisionFor("reject", { requestId: "9001" })).claimed, true, "the first gate is rejected");
    await waitFor(() => fs.existsSync(approvalRequestPath(root, JOB_ID, GENERATION, "9002")), 5000, "the second gate's request file");
    assert.equal(claimApprovalDecision(root, decisionFor("allow", { requestId: "9002" })).claimed, true, "the second gate is allowed");
    const result = await prompt;

    assert.deepEqual(
      acp.replies,
      [
        { id: 9001, result: { outcome: { outcome: "selected", optionId: "reject" } } },
        { id: 9002, result: { outcome: { outcome: "selected", optionId: "allow" } } }
      ],
      "the second gate is answered with its own allow option"
    );
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.approval, null, "the satisfied gate leaves no remembered interruption behind");
    assert.equal(result.gateOutcome, null, "an allow proves no cause for the current gate");
    assert.equal(result.approvalOutcome, "rejected", "the turn-level diagnostic still records the earlier human rejection");
    const terminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome,
      gateOutcome: result.gateOutcome
    });
    assert.equal(terminal.exitCode, 0, "the turn completed after the later allow");
    assert.equal(terminal.record.approval_outcome, "rejected", "the bounded turn summary rides the success record");
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a gate whose prompt already ended can never label the next turn (JQ-20261005-57)", async () => {
  const dir = newTmp("gate-after-turn");
  const root = path.join(dir, "root");
  const hub = await startFakeHub();
  const acp = await startScriptedAcp([
    {
      gates: [9001],
      mode: "nowait",
      result: { stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } }
    },
    {
      gates: [],
      mode: "manual",
      result: { stopReason: "end_turn", _meta: { "codebuddy.ai/finishReason": "end_turn" } }
    }
  ]);
  const channel = channelFor(root, [], { hubUrl: hub.url });
  const client = new AcpClient(acp.endpoint, WORKBUDDY_TERMINAL_FIXTURE_MODEL, channel);
  try {
    await client.connect();
    const first = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "turn one");
    assert.equal(first.gateOutcome, null, "the gate was never answered before its turn ended");
    assert.equal(first.approvalOutcome, null, "no outcome was proven for the ended turn");
    const firstTerminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: first.stopReason,
      finalText: first.finalText,
      finishReason: first.finishReason,
      approval: first.approval,
      approvalOutcome: first.approvalOutcome,
      gateOutcome: first.gateOutcome
    });
    assert.equal(firstTerminal.exitCode, 17, "an unanswered gate keeps the historical declined-gate classification");

    // The next turn starts immediately; the old request settles after its own
    // prompt ended and must write nothing into this turn.
    const second = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "turn two");
    assert.equal(second.stopReason, "end_turn");
    assert.equal(second.approvalOutcome, null, "the old request's disposal never contaminates the next turn's diagnostic");
    assert.equal(second.gateOutcome, null, "the next turn's gate state is untouched");
    const secondTerminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: second.stopReason,
      finalText: second.finalText,
      finishReason: second.finishReason,
      approval: second.approval,
      approvalOutcome: second.approvalOutcome,
      gateOutcome: second.gateOutcome
    });
    assert.equal(secondTerminal.exitCode, 0);
    assert.equal("approval_outcome" in secondTerminal.record, false, "a clean completion keeps its exact historical shape");

    await waitFor(() => acp.replies.some((reply) => reply.id === 9001), 5000, "the late disposal reply to the old gate");
    const late = acp.replies.find((reply) => reply.id === 9001);
    assert.deepEqual(
      late?.result,
      { outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } },
      "the old request is still answered on its own id after its prompt ended"
    );
  } finally {
    await client.close();
    channel.dispose();
    await acp.close();
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Durable job state through the real worker
// ---------------------------------------------------------------------------

/** A child fixture that reports a pending approval, waits for a release file, then resolves and finishes. */
function writePausedApprovalFixture(dir: string, jobId: string, generation: number): { fixture: string; release: string } {
  const fixture = path.join(dir, "paused-approval-fixture.cjs");
  const release = path.join(dir, "release");
  const normalizer = createAcpNormalizer();
  const init = acpInitRecord(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, WORKBUDDY_TERMINAL_FIXTURE_MODEL);
  const pendingApproval: PendingApproval = {
    version: 1,
    kind: "tool_approval",
    provider: WORKBUDDY_APPROVAL_PROVIDER_ID,
    jobId,
    generation,
    requestId: REQUEST_ID,
    toolName: "Bash",
    summary: null,
    detail: null,
    options: [
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  const terminal = acpTerminalResultRecord({
    sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
    stopReason: "end_turn",
    finalText: normalizer.assistantText() ?? "done"
  });
  fs.writeFileSync(
    fixture,
    [
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", () => {',
      `  const init = ${JSON.stringify(JSON.stringify(init))};`,
      `  const pending = ${JSON.stringify(JSON.stringify(approvalPendingRecord(pendingApproval)))};`,
      `  const resolved = ${JSON.stringify(JSON.stringify(approvalResolvedRecord({ requestId: REQUEST_ID, optionId: "allow", decision: "selected" })))};`,
      `  const terminal = ${JSON.stringify(JSON.stringify(terminal.record))};`,
      '  process.stdout.write(init + "\\n");',
      '  process.stdout.write(pending + "\\n");',
      `  const release = ${JSON.stringify(release)};`,
      '  const timer = setInterval(() => {',
      '    if (!require("node:fs").existsSync(release)) return;',
      '    clearInterval(timer);',
      '    process.stdout.write(resolved + "\\n");',
      '    process.stdout.write(terminal + "\\n");',
      `    process.exit(${terminal.exitCode});`,
      '  }, 20);',
      "});"
    ].join("\n"),
    "utf8"
  );
  return { fixture, release };
}

test("the running job carries the bounded pending approval and never keeps it after the attempt ends", async () => {
  const dir = newTmp("worker");
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const job = createJobRecord({
    task: "run a tool that needs approval",
    cwd,
    provider: "workbuddy-ai",
    model: WORKBUDDY_TERMINAL_FIXTURE_MODEL
  });
  const { fixture, release } = writePausedApprovalFixture(dir, job.id, job.generation);
  saveJob(root, job);
  const running = runWorker({
    root,
    jobId: job.id,
    createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env, createWorkBuddyAiAdapter({ platform: "win32" })),
    isAliveFn: () => false,
    enumerateFn: async () => ({ ok: true, processes: [] })
  });
  try {
    await waitFor(() => loadJob(root, job.id)?.pendingApproval != null, 8000, "the durable pending approval");
    const mid = loadJob(root, job.id);
    assert.ok(mid);
    assert.equal(mid.status, "running", "a job waiting for approval is honestly still running");
    assert.equal(mid.pendingApproval?.toolName, "Bash", "only the bounded display-safe tool name is persisted");
    assert.equal(JSON.stringify(mid.pendingApproval).includes("rawInput"), false);
    assert.equal(JSON.stringify(mid.pendingApproval).includes("rm -rf"), false);

    fs.writeFileSync(release, "go");
    const result = await running;
    assert.equal(result.status, "done");
    const final = loadJob(root, job.id);
    assert.ok(final);
    assert.equal(final.pendingApproval, null, "a settled attempt can never leave a stale pending approval");
  } finally {
    fs.writeFileSync(release, "go");
    await running.catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the durable record round-trips one bounded pending approval and never fabricates a malformed or pre-v9 one", () => {
  const dir = newTmp("store");
  const root = path.join(dir, "root");
  try {
    const job = createJobRecord({ task: "store round trip", cwd: dir, provider: "workbuddy-ai", model: null });
    const pending: PendingApproval = {
      version: 1,
      kind: "tool_approval",
      provider: WORKBUDDY_APPROVAL_PROVIDER_ID,
      jobId: job.id,
      generation: job.generation,
      requestId: "555",
      toolName: "Bash",
      summary: null,
      detail: {
        command: "echo hello",
        args: null,
        description: null,
        path: null,
        cwd: null,
        title: null,
        gate: null,
        reason: null,
        truncated: false,
        redacted: false
      },
      options: [{ id: "allow", kind: "allow_once", label: "Allow" }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };
    job.pendingApproval = pending;
    saveJob(root, job);
    assert.deepEqual(loadJob(root, job.id)?.pendingApproval, pending, "the bounded pending approval round-trips exactly");

    // Persistence keeps the EXACT argv shape: an empty argument and an
    // argument with its own leading/trailing whitespace survive the durable
    // read/write round trip unchanged (normalization is idempotent for both).
    job.pendingApproval = {
      ...pending,
      requestId: "556",
      detail: { ...pending.detail!, command: "node", args: ["", " spaced arg ", "next"] }
    };
    saveJob(root, job);
    assert.deepEqual(
      loadJob(root, job.id)?.pendingApproval?.detail?.args,
      ["", " spaced arg ", "next"],
      "empty and whitespace-bearing arguments survive persistence in order"
    );

    // A malformed/partial object (or one carrying extra provider payload) is
    // dropped at the durable boundary, never presented as actionable.
    job.pendingApproval = {
      ...pending,
      rawInput: { command: "rm -rf wb-main" }
    } as unknown as PendingApproval;
    saveJob(root, job);
    const normalized = loadJob(root, job.id)?.pendingApproval;
    assert.ok(normalized);
    assert.equal(JSON.stringify(normalized).includes("rm -rf"), false, "unknown fields never survive normalization");
    assert.equal("rawInput" in normalized, false);
    job.pendingApproval = { kind: "tool_approval", jobId: job.id } as unknown as PendingApproval;
    saveJob(root, job);
    assert.equal(loadJob(root, job.id)?.pendingApproval, null, "a half-understood approval is never actionable");

    // A pre-v9 record simply has no pending approval (never a fabricated one).
    const legacy = { ...job, pendingApproval: pending, schemaVersion: 8 } as Record<string, unknown>;
    delete legacy.pendingApproval;
    fs.writeFileSync(jobPath(root, job.id), JSON.stringify(legacy), "utf8");
    const loadedLegacy = loadJob(root, job.id);
    assert.ok(loadedLegacy);
    assert.equal(loadedLegacy.pendingApproval, null);
    assert.equal(loadedLegacy.schemaVersion, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
