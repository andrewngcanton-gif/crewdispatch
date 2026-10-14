// workbuddy-quota-fallback-mcp.test.ts — JQ-20261002-43 real boundary
// regression: the observed WorkBuddy MISSING-finish-reason quota must reach the
// existing rate-limit downgrade chain through the REAL entry path.
//
// Job `job-muqxgzqn-8k2k0g` (2026-10-02) ended `provider_refusal` (exit 11,
// `fallback_eligible:false`) because the classifier required
// `finish_reason=tool_calls` beside the provider's own
// `Quota exceeded: 429 usage exceeds frequency limit…` detail. This test drives
// the production MCP entry (`dist/mcp/server.js`) -> real local daemon -> real
// worker -> the REAL WorkBuddy AI adapter (stream normalization + exit
// classification) against a controlled provider process.
//
// Which boundary is a FIXTURE: the WorkBuddy provider PROCESS only. The
// installed Desktop bridge requires an authenticated WorkBuddy Desktop runtime,
// which is an opt-in acceptance (workbuddy-desktop-real.e2e.ts) and is NOT run
// here; the fixture child emits the EXACT bridge-shaped stdout records and the
// EXACT normalized bridge exit code (the same record writer the bridge uses,
// `acpTerminalResultRecord`), and everything downstream — provider
// normalization, exit classification, chain advance, session resume, durable
// state, usage summing and the terminal wake — is production code.
//
// No real CLI profile, credential, notification target, job or history is
// touched: the data root is a disposable isolated directory, the fixture is a
// narrowly named temp script, and the wake target is a loopback listener
// started by this test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { RECOVERY_PROMPT } from "../../jobs/service";
import { McpStdioClient } from "../helpers/mcp-client";
import { acpInitRecord, acpSuccessResultRecord, acpTerminalResultRecord, createAcpNormalizer } from "../../providers/workbuddy-ai/acp-normalizer";
import {
  WORKBUDDY_CONTENT_FILTER_RESULT_RECORD,
  WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
  WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD,
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID
} from "../fixtures/workbuddy-terminal-records";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const PRIMARY = WORKBUDDY_TERMINAL_FIXTURE_MODEL;
const FALLBACK = "deepseek-v4.1-pro";
const PRIMARY_EFFORT = "low";
const FALLBACK_EFFORT = "high";
const SESSION = WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID;
const FALLBACK_TEXT = "WB_FALLBACK_OK";
const PRIMARY_TOKENS_IN = 10;
const PRIMARY_TOKENS_OUT = 1;
const FALLBACK_TOKENS_IN = 5;
const FALLBACK_TOKENS_OUT = 2;

const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface Workspace {
  dir: string;
  root: string;
  iso: CliIsolation;
  fixture: string;
  log: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Canonical usage lines of ONE provider response, produced by the REAL
 * WorkBuddy normalizer (the same mapping the bridge runs for a `usage_update`).
 */
function usageLines(tokensIn: number, tokensOut: number): string[] {
  const normalizer = createAcpNormalizer();
  return normalizer
    .handleUpdate({
      sessionUpdate: "usage_update",
      used: tokensIn + tokensOut,
      size: 200000,
      cost: { amount: 0.5, currency: "" },
      _meta: {
        "codebuddy.ai/requestId": `req-${tokensIn}`,
        "codebuddy.ai/messageId": `m-${tokensIn}`,
        usage: { inputTokens: tokensIn, outputTokens: tokensOut }
      }
    })
    .map((record) => JSON.stringify(record));
}

/**
 * The controlled provider process. It records every invocation (cwd/argv/stdin)
 * and, on stdin end, writes the EXACT bridge-shaped stdout lines for the
 * selected model:
 *   - the primary reports the observed missing-finish quota record and exits 5
 *     (or, in `WB_FIXTURE_MODE=refusal`, the content-filter refusal and exits 11;
 *     or, in `WB_FIXTURE_MODE=quota-rejected`, the SAME quota record written by
 *     the production record writer with the turn's earlier rejected-gate
 *     `approval_outcome` token beside it, still exiting 5);
 *   - the configured fallback completes with its own end_turn record and exits 0.
 */
function writeFixture(dir: string): string {
  const primaryQuota = [JSON.stringify(acpInitRecord(SESSION, PRIMARY)), ...usageLines(PRIMARY_TOKENS_IN, PRIMARY_TOKENS_OUT), JSON.stringify(WORKBUDDY_QUOTA_MISSING_FINISH_RESULT_RECORD)];
  const primaryRefusal = [JSON.stringify(acpInitRecord(SESSION, PRIMARY)), ...usageLines(PRIMARY_TOKENS_IN, PRIMARY_TOKENS_OUT), JSON.stringify(WORKBUDDY_CONTENT_FILTER_RESULT_RECORD)];
  // The production record writer produces the real shape: the recorded quota
  // (stop_reason=refusal, NO finish reason, the provider's exact detail) plus
  // the turn's diagnostic approval token. It must still classify as the shared
  // rate limit (exit 5) so the configured fallback advances.
  const quotaAfterRejected = acpTerminalResultRecord({
    sessionId: SESSION,
    model: PRIMARY,
    stopReason: "refusal",
    finalText: "",
    finishReason: null,
    errorDetail: WORKBUDDY_QUOTA_MISSING_FINISH_ERROR_DETAIL,
    approvalOutcome: "rejected"
  });
  if (quotaAfterRejected.exitCode !== 5) throw new Error("fixture invariant: the quota after a rejected gate must stay exit 5");
  const primaryQuotaRejected = [
    JSON.stringify(acpInitRecord(SESSION, PRIMARY)),
    ...usageLines(PRIMARY_TOKENS_IN, PRIMARY_TOKENS_OUT),
    JSON.stringify(quotaAfterRejected.record)
  ];
  const fallback = [
    JSON.stringify(acpInitRecord(SESSION, FALLBACK)),
    ...usageLines(FALLBACK_TOKENS_IN, FALLBACK_TOKENS_OUT),
    JSON.stringify(acpSuccessResultRecord({ sessionId: SESSION, model: FALLBACK, stopReason: "end_turn", finalText: FALLBACK_TEXT }))
  ];
  const scripted: Record<string, Record<string, { lines: string[]; exit: number }>> = {
    [PRIMARY]: {
      quota: { lines: primaryQuota, exit: 5 },
      refusal: { lines: primaryRefusal, exit: 11 },
      "quota-rejected": { lines: primaryQuotaRejected, exit: quotaAfterRejected.exitCode }
    },
    [FALLBACK]: { quota: { lines: fallback, exit: 0 }, refusal: { lines: fallback, exit: 0 }, "quota-rejected": { lines: fallback, exit: 0 } }
  };
  const js = [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };',
    `const SCRIPTED = ${JSON.stringify(scripted)};`,
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => {',
    "  const log = process.env.WB_FIXTURE_LOG;",
    '  if (log) fs.appendFileSync(log, JSON.stringify({ cwd: process.cwd(), argv: args, stdin: input }) + "\\n");',
    '  const model = val("--model");',
    '  const mode = process.env.WB_FIXTURE_MODE === "refusal" ? "refusal" : process.env.WB_FIXTURE_MODE === "quota-rejected" ? "quota-rejected" : "quota";',
    "  const entry = SCRIPTED[model] && SCRIPTED[model][mode];",
    '  if (!entry) { process.stderr.write("unexpected fixture model: " + String(model) + "\\n"); process.exit(9); }',
    '  for (const line of entry.lines) process.stdout.write(line + "\\n");',
    "  process.exit(entry.exit);",
    "});"
  ].join("\n");
  const fixture = path.join(dir, "wb-quota-fixture.cjs");
  fs.writeFileSync(fixture, js, "utf8");
  return fixture;
}

/** The WorkBuddy configuration: primary is explicit, one configured fallback with its OWN effort. */
function writeWorkBuddyConfig(root: string): void {
  const file = path.join(root, "providers", "workbuddy-ai.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      configVersion: 1,
      cliPath: null,
      defaultModel: null,
      rateLimitFallbackModel: FALLBACK,
      permissionMode: "plan",
      defaultEffort: null,
      rateLimitFallbackEffort: FALLBACK_EFFORT
    }),
    "utf8"
  );
}

/** The declared fixture catalog: it proves both configured ids (test-only seam). */
const FIXTURE_CATALOG = JSON.stringify({
  ok: true,
  source: "workbuddy-product-snapshot",
  models: [PRIMARY, FALLBACK],
  defaultModel: null
});

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-wb-quota-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-wbq-${name}-` });
  const fixture = writeFixture(dir);
  const log = path.join(dir, "fixture-invocations.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    JOBQUAY_TEST_FIXTURE_CATALOG: FIXTURE_CATALOG,
    WB_FIXTURE_LOG: log
  };
  // A test must never reach a real user thread/callback destination.
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CALLBACK_URL;
  delete env.JOBQUAY_CALLBACK_URL;
  return { dir, root, iso, fixture, log, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Listener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

function startListener(): Promise<Listener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/wake`, bodies, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 90000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("crewdispatch_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

function jobRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

interface Invocation {
  cwd: string;
  argv: string[];
  stdin: string;
}

function invocations(log: string): Invocation[] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Invocation);
}

function canonicalExistingPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function invocationCwdMatches(invocation: Invocation, project: string): boolean {
  return canonicalExistingPath(invocation.cwd) === canonicalExistingPath(project);
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] ?? null : null;
}

test("the observed missing-finish WorkBuddy quota advances the configured fallback on the same session through the real MCP entry (JQ-20261002-43)", { timeout: 240000 }, async () => {
  const ws = newWorkspace("cascade");
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  writeWorkBuddyConfig(ws.root);
  const listener = await startListener();
  let client: McpStdioClient | null = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const task = "WB_QUOTA_TASK_MARKER — sent verbatim once and never again";
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("crewdispatch_spawn", {
        task,
        cwd: project,
        provider: "workbuddy-ai",
        model: PRIMARY,
        effort: PRIMARY_EFFORT,
        callback_url: listener.url
      })
    );
    assert.equal(spawned.ok, true);
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");
    assert.equal(done.generation, 1, "the chain advanced exactly once (primary -> configured fallback)");
    assert.equal(done.model, FALLBACK);
    assert.equal(done.model_source, "rate-limit-fallback");
    assert.deepEqual(done.model_chain, [PRIMARY, FALLBACK]);
    assert.equal(done.downgraded, true, "the result view surfaces the downgrade");
    assert.equal((done.result as Record<string, unknown>).final_text, FALLBACK_TEXT);

    // The persisted record: two attempts, the first one genuinely rate limited
    // by the NORMALIZED exit code 5 (never a manually forced worker flag), with
    // the provider's own stop reason and bounded quota detail preserved.
    const rec = jobRecord(ws.root, id);
    const attempts = rec.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((a) => [a.model, a.modelSource, a.rateLimited]),
      [
        [PRIMARY, "explicit", true],
        [FALLBACK, "rate-limit-fallback", false]
      ]
    );
    assert.equal(attempts[0]?.resumedFrom, null);
    assert.equal(attempts[0]?.exitCode, 5, "the attempt ended on the normalized canonical rate-limit exit code");
    assert.equal(attempts[0]?.kind, "rate_limit");
    assert.equal(attempts[1]?.resumedFrom, SESSION, "the fallback resumes the SAME provider session");
    assert.equal(attempts[0]?.effort, PRIMARY_EFFORT);
    assert.equal(attempts[1]?.effort, FALLBACK_EFFORT, "the fallback runs at its OWN configured effort");
    assert.equal(rec.finishReason ?? null, null, "no finish reason is invented for the observed quota shape");
    assert.equal(rec.errorDetail, null, "a successful job does not carry the superseded attempt's detail");
    // Usage is the sum over both attempts; the context gauge is the last value.
    const usage = rec.usage as Record<string, number | null>;
    assert.equal(usage.tokensIn, PRIMARY_TOKENS_IN + FALLBACK_TOKENS_IN);
    assert.equal(usage.tokensOut, PRIMARY_TOKENS_OUT + FALLBACK_TOKENS_OUT);
    assert.equal(usage.credits, 1);
    assert.equal(usage.contextUsed, FALLBACK_TOKENS_IN + FALLBACK_TOKENS_OUT);

    // On the wire: the production argv carried the primary first with the task,
    // then the configured fallback ONCE with the fixed recovery prompt.
    const inv = invocations(ws.log).filter((i) => invocationCwdMatches(i, project));
    assert.equal(inv.length, 2, "bounded single switch: each candidate is called at most once");
    assert.deepEqual(inv.map((i) => argValue(i.argv, "--model")), [PRIMARY, FALLBACK]);
    assert.deepEqual(inv.map((i) => argValue(i.argv, "--effort")), [PRIMARY_EFFORT, FALLBACK_EFFORT]);
    assert.equal(argValue(inv[0]!.argv, "--permission-mode"), "plan");
    assert.equal(inv[0]!.argv.includes("--resume"), false);
    assert.equal(inv[0]!.stdin, task, "the task must reach the primary verbatim");
    assert.equal(argValue(inv[1]!.argv, "--resume"), SESSION, "the SAME session must be resumed");
    assert.equal(inv[1]!.stdin, RECOVERY_PROMPT, "a resumed attempt must NOT re-send the full task");
    assert.notEqual(inv[1]!.stdin, task);

    // Exactly ONE terminal wake, with the short job id + status body only.
    await sleep(800);
    assert.equal(listener.bodies.length, 1, "exactly one terminal wake per generation");
    const body = JSON.parse(listener.bodies[0]!) as Record<string, unknown>;
    assert.equal(body.job_id, id);
    assert.equal(body.status, "done");
    assert.equal(listener.bodies[0]!.includes("WB_QUOTA_TASK_MARKER"), false, "the wake must not contain the task");
  } finally {
    if (client) await client.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("an ordinary WorkBuddy refusal with the same configured fallback never downgrades (negative coverage preserved)", { timeout: 180000, skip: process.platform === "win32" || process.platform === "darwin" ? false : "WorkBuddy Desktop bridge exit-11 refusal namespace is Windows/macOS" }, async () => {
  const ws = newWorkspace("refusal");
  ws.env.WB_FIXTURE_MODE = "refusal";
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  writeWorkBuddyConfig(ws.root);
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("crewdispatch_spawn", {
        task: "content filter probe",
        cwd: project,
        provider: "workbuddy-ai",
        model: PRIMARY,
        effort: PRIMARY_EFFORT
      })
    );
    assert.equal(spawned.ok, true);
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "error");
    assert.equal(done.generation, 0, "a genuine refusal never advances the chain");
    assert.equal(done.model, PRIMARY);
    assert.deepEqual(done.model_chain, [PRIMARY, FALLBACK], "the fallback candidate was configured but never reached");
    assert.equal(done.downgraded, false);

    const rec = jobRecord(ws.root, id);
    const attempts = rec.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.rateLimited, false);
    assert.equal(attempts[0]?.exitCode, 11);
    assert.equal(rec.failureKind, "provider_refusal");
    assert.equal(rec.finishReason, "content_filter", "the explicit provider cause is preserved");
    assert.equal((rec.result as Record<string, unknown>).fallbackEligible, false);

    const inv = invocations(ws.log).filter((i) => invocationCwdMatches(i, project));
    assert.equal(inv.length, 1, "only the primary was dispatched; the fallback was never called");
    assert.equal(argValue(inv[0]!.argv, "--model"), PRIMARY);
    assert.equal(inv[0]!.argv.includes("--resume"), false);
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("the recorded quota AFTER an earlier rejected gate still advances the configured fallback, and the later generation inherits no approval token (JQ-20261005-57)", { timeout: 240000 }, async () => {
  // Generation-0 regression: the unconditional rejected branch preceded the
  // recorded quota exception, so this exact turn stopped advancing the
  // configured fallback. The provider process is the labeled fixture boundary
  // (it writes the production record writer's own quota record carrying the
  // earlier turn's diagnostic `approval_outcome` and exits 5); the MCP entry,
  // daemon, worker, real WorkBuddy adapter, chain advance and durable state are
  // production code.
  const ws = newWorkspace("quotarejected");
  ws.env.WB_FIXTURE_MODE = "quota-rejected";
  const project = path.join(ws.iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  writeWorkBuddyConfig(ws.root);
  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("crewdispatch_spawn", {
        task: "WB_QUOTA_REJECTED_TASK_MARKER",
        cwd: project,
        provider: "workbuddy-ai",
        model: PRIMARY,
        effort: PRIMARY_EFFORT,
        callback_url: listener.url
      })
    );
    assert.equal(spawned.ok, true);
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");
    assert.equal(done.generation, 1, "the proven quota still advanced the configured fallback despite the rejected gate");
    assert.equal(done.model, FALLBACK);
    assert.equal(done.model_source, "rate-limit-fallback");
    assert.equal(done.downgraded, true, "the downgrade is surfaced exactly as for a plain quota");
    assert.equal((done.result as Record<string, unknown>).final_text, FALLBACK_TEXT);

    const rec = jobRecord(ws.root, id);
    const attempts = rec.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.exitCode, 5, "the primary ended on the canonical rate-limit exit code, never exit 19");
    assert.equal(attempts[0]?.kind, "rate_limit");
    assert.equal(attempts[0]?.rateLimited, true, "the attempt is genuinely fallback eligible");
    assert.equal(attempts[1]?.resumedFrom, SESSION, "the fallback resumes the SAME provider session");
    // The later generation never inherits the earlier turn's diagnostic token.
    assert.equal(rec.approvalOutcome ?? null, null, "the fallback generation starts with no inherited approval evidence");
    assert.equal(
      (rec.result as Record<string, unknown>).approvalOutcome ?? null,
      null,
      "the fallback's own result carries no earlier approval evidence"
    );

    const inv = invocations(ws.log).filter((i) => invocationCwdMatches(i, project));
    assert.equal(inv.length, 2, "bounded single switch: each candidate is called at most once");
    assert.deepEqual(inv.map((i) => argValue(i.argv, "--model")), [PRIMARY, FALLBACK]);
    assert.equal(argValue(inv[1]!.argv, "--resume"), SESSION);

    await sleep(800);
    assert.equal(listener.bodies.length, 1, "exactly one terminal wake");
    assert.equal((JSON.parse(listener.bodies[0]!) as Record<string, unknown>).status, "done");
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});
