// in-flight-usage-persistence.test.ts — the IN-FLIGHT canonical usage contract.
//
// While a provider process is still running, a streamed change to the attempt's
// canonical usage must reach the PERSISTED running job, so the Hub's existing
// 2.5s refresh of GET /api/jobs/:id shows fresh metrics before the process
// exits — while a streamed text/reasoning chunk (or a republication of the very
// same usage) must cause NO usage write at all. The terminal write stays
// authoritative and the canonical aggregation semantics stay unchanged
// (additive metrics summed across attempts, contextUsed/contextWindow latest
// observation, an unreported metric null — never a fabricated 0).
//
// The tests drive the REAL worker (`runWorker`) against a CONTROLLED child
// process whose stdout is folded through the production stream parser / usage
// normalizer (the fixture-runner seam, see src/cli/fixture-runner.ts). This is
// a service test, NOT a real-CLI measurement; the cross-process boundary is
// covered by job-harness.test.ts and the real-CLI boundary by the e2e suites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord, createUsageChangeDetector, runWorker, type RunWorkerResult } from "../../jobs/service";
import { jobPath, loadJob, logPath, saveJob } from "../../jobs/store";
import { emptyUsage, totalUsage, type JobRecord } from "../../jobs/types";
import { createCommandCodeAdapter } from "../../providers/command-code/index";
import { createFixtureRunner } from "../../cli/fixture-runner";
import { startHub, type HubHandle } from "../../hub/server";
import type { UsageSnapshot } from "../../providers/provider";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshot(partial: Partial<UsageSnapshot>): UsageSnapshot {
  return { ...emptyUsage(), ...partial } satisfies UsageSnapshot;
}

// ---------------------------------------------------------------------------
// The change detector (the focused unit seam of the in-flight persistence)
// ---------------------------------------------------------------------------

test("the canonical usage change detector reports only meaningful usage changes", () => {
  const detect = createUsageChangeDetector();

  // An all-unreported snapshot is never a "change": there is nothing to write.
  assert.equal(detect(snapshot({})), false);

  // The first REPORTED snapshot is the change.
  assert.equal(detect(snapshot({ tokensIn: 1200, contextUsed: 1200, contextWindow: 200000 })), true);

  // A republication of the same canonical snapshot is not a change.
  assert.equal(detect(snapshot({ tokensIn: 1200, contextUsed: 1200, contextWindow: 200000 })), false);

  // A real additive delta is a change.
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 1200, contextWindow: 200000 })), true);
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 1200, contextWindow: 200000 })), false);

  // A moved GAUGE is a change even when no additive metric moved.
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 2400, contextWindow: 200000 })), true);

  // A genuinely reported 0 is a measurement, not "unreported".
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 2400, contextWindow: 200000, tokensOut: 0 })), true);

  // Fields that stay unavailable (null) never differ from themselves.
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 2400, contextWindow: 200000, tokensOut: 0, credits: null })), false);

  // An all-unreported snapshot after a reported one is still not a write
  // candidate (a metric can never un-report within one attempt, but the
  // detector must never turn "nothing reported" into a write).
  assert.equal(detect(snapshot({})), false);
  assert.equal(detect(snapshot({ tokensIn: 1800, contextUsed: 2400, contextWindow: 200000, tokensOut: 0 })), false);
});

// ---------------------------------------------------------------------------
// The worker-level contract (controlled delayed stream, real child process)
// ---------------------------------------------------------------------------

/**
 * A CLI-shaped fixture whose usage stream is driven PHASE BY PHASE by marker
 * files, so the test can observe the persisted job while the child is still
 * running:
 *
 *   phase 1: the first canonical usage observation, then wait for `phase1.go`;
 *   phase 2: an IDENTICAL usage republication plus 50 no-usage text chunks
 *            (none of these may cause a usage write), then `chunks.done` and
 *            wait for `chunks.go`;
 *   phase 3: a CHANGED canonical observation (the context gauge moved and an
 *            additive delta arrived), then `phase3.done` and wait for
 *            `phase3.go`;
 *   then the terminal success record and exit 0.
 */
function writeUsageFixture(dir: string): string {
  const fixture = path.join(dir, "inflight-usage-fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
      "const cwd = process.cwd();",
      "const waitFile = (name) => new Promise((resolve) => {",
      "  const timer = setInterval(() => {",
      '    if (fs.existsSync(path.join(cwd, name))) { clearInterval(timer); resolve(); }',
      "  }, 20);",
      "});",
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (d) => { input += d; });',
      'process.stdin.on("end", async () => {',
      '  const sid = "fx-inflight-usage";',
      '  out({ type: "event", event: { type: "run_start", sessionId: sid } });',
      "  // Phase 1: the first canonical usage observation.",
      '  out({ type: "event", event: { type: "usage", contextUsed: 1200, contextWindow: 200000, tokensIn: 1200, tokensOut: 320, credits: 0.5 } });',
      '  fs.writeFileSync(path.join(cwd, "phase1.done"), "1");',
      '  await waitFile("phase1.go");',
      "  // Phase 2: an IDENTICAL usage republication plus 50 no-usage text chunks.",
      '  out({ type: "event", event: { type: "usage", contextUsed: 1200, contextWindow: 200000 } });',
      "  for (let i = 0; i < 50; i += 1) out({ type: \"event\", event: { type: \"text_delta\", delta: \"chunk-\" + i } });",
      '  fs.writeFileSync(path.join(cwd, "chunks.done"), "1");',
      '  await waitFile("chunks.go");',
      "  // Phase 3: a CHANGED canonical observation (gauge moved, additive delta).",
      '  out({ type: "event", event: { type: "usage", contextUsed: 2400, contextWindow: 200000, tokensIn: 600, tokensOut: 40 } });',
      '  fs.writeFileSync(path.join(cwd, "phase3.done"), "1");',
      '  await waitFile("phase3.go");',
      '  out({ type: "result", subtype: "success", result: "usage done", session_id: sid, stop_reason: "end_turn" });',
      "  process.exit(0);",
      "});"
    ].join("\n"),
    "utf8"
  );
  return fixture;
}

async function waitForFile(file: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await sleep(20);
  }
}

async function waitForLogContent(file: string, marker: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (fs.readFileSync(file, "utf8").includes(marker)) return;
    } catch {
      /* the log is created with the first streamed line */
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${marker} in ${file}`);
    await sleep(20);
  }
}

async function waitForJob(
  root: string,
  jobId: string,
  predicate: (job: JobRecord) => boolean,
  timeoutMs = 20000
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JobRecord | null = null;
  for (;;) {
    try {
      const job = loadJob(root, jobId);
      if (job) {
        last = job;
        if (predicate(job)) return job;
      }
    } catch {
      /* a concurrent atomic record write is retried */
    }
    if (Date.now() >= deadline) {
      throw new Error(`job did not reach the expected state in time (status=${last?.status ?? "?"}, usage=${JSON.stringify(last?.usage ?? null)})`);
    }
    await sleep(25);
  }
}

test("in-flight usage reaches the persisted running job before exit, updates on a changed snapshot, and no-usage chunks cause no write churn", { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-inflight-usage-"));
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = writeUsageFixture(dir);
  let hub: HubHandle | null = null;
  let worker: Promise<RunWorkerResult> | null = null;
  try {
    const job = createJobRecord({ task: "INFLIGHT_USAGE_TASK", cwd });
    saveJob(root, job);

    worker = runWorker({
      root,
      jobId: job.id,
      createRunner: async (ctx) => createFixtureRunner(fixture, ctx.env),
      // No heartbeat write may blur the "no usage churn" observation below.
      heartbeatMs: 3_600_000,
      isAliveFn: () => false,
      enumerateFn: async () => ({ ok: true, processes: [] })
    });

    // ---- Phase 1: the usage is visible on the RUNNING job, before exit ----
    await waitForFile(path.join(cwd, "phase1.done"));
    const running = await waitForJob(root, job.id, (j) => j.usage.tokensIn === 1200);
    assert.equal(running.status, "running", "usage must be persisted while the CLI is still running");
    assert.equal(running.finishedAt, null);
    assert.ok(running.childPid, "the CLI child must still be alive at this point");
    assert.equal(running.generation, 0);
    // The CURRENT attempt carries the in-flight usage and the job total is the
    // canonical aggregation over the attempts (one attempt here).
    assert.equal(running.attempts.length, 1);
    assert.equal(running.attempts[0]?.endedAt, null, "the attempt is still in flight");
    assert.equal(running.attempts[0]?.usage.tokensIn, 1200);
    assert.equal(running.usage.tokensOut, 320);
    assert.equal(running.usage.contextUsed, 1200);
    assert.equal(running.usage.contextWindow, 200000);
    assert.equal(running.usage.credits, 0.5);
    // Metrics the provider never reported stay unavailable (never 0).
    for (const unavailable of ["toolCalls", "cacheRead", "cacheMiss", "cacheCreation", "totalCostUsd", "decodeTokens", "decodeSeconds"]) {
      assert.equal((running.usage as unknown as Record<string, unknown>)[unavailable], null, `${unavailable} must stay unavailable`);
    }

    // The Hub's GET /api/jobs/:id reads the persisted record: it must expose
    // the fresh in-flight metrics to the existing 2.5s refresh.
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const detailResponse = await fetch(`http://127.0.0.1:${hub.port}/api/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as { status: string; usage: Record<string, number | null> };
    assert.equal(detail.status, "running");
    assert.equal(detail.usage.tokensIn, 1200, "GET /api/jobs/:id must expose the in-flight usage");
    assert.equal(detail.usage.tokensOut, 320);
    assert.equal(detail.usage.contextUsed, 1200);
    assert.equal(detail.usage.contextWindow, 200000);
    assert.equal(detail.usage.credits, 0.5);
    assert.equal(detail.usage.toolCalls, null);
    hub.server.closeAllConnections?.();
    await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    hub = null;

    // ---- Phase 2: identical/no-usage chunks must not cause usage writes ----
    // Bracket the whole phase-2 stream: capture the record the moment the
    // phase-1 usage is durable, release the phase-2 lines, and prove the record
    // is byte-identical afterwards. Any usage write caused by a chunk (or by
    // the identical republication) would change the record in between.
    const before = fs.readFileSync(jobPath(root, job.id), "utf8");
    fs.writeFileSync(path.join(cwd, "phase1.go"), "1");
    await waitForFile(path.join(cwd, "chunks.done"));
    // The raw log is appended immediately BEFORE each line is parsed, so a log
    // that carries the LAST phase-2 line proves every phase-2 line was consumed.
    await waitForLogContent(logPath(root, job.id), '"chunk-49"');
    await sleep(200);
    const after = fs.readFileSync(jobPath(root, job.id), "utf8");
    assert.equal(after, before, "an identical usage republication and no-usage text chunks must not write the job record again");
    const afterChunks = loadJob(root, job.id)!;
    assert.equal(afterChunks.status, "running");
    assert.equal(afterChunks.usage.tokensIn, 1200, "the persisted usage is still the phase-1 snapshot");

    // ---- Phase 3: a CHANGED snapshot updates the persisted running job ----
    fs.writeFileSync(path.join(cwd, "chunks.go"), "1");
    await waitForFile(path.join(cwd, "phase3.done"));
    const changed = await waitForJob(root, job.id, (j) => j.usage.tokensIn === 1800);
    assert.equal(changed.status, "running", "the changed usage must be visible before exit");
    assert.equal(changed.usage.tokensOut, 360, "additive metrics accumulate");
    assert.equal(changed.usage.contextUsed, 2400, "the context gauge is the LATEST observation");
    assert.equal(changed.usage.contextWindow, 200000);
    assert.equal(changed.usage.credits, 0.5, "an unchanged additive metric keeps its accumulated value");

    // ---- Terminal: the final write is authoritative and canonical ----
    fs.writeFileSync(path.join(cwd, "phase3.go"), "1");
    const result = await worker;
    worker = null;
    assert.equal(result.status, "done");
    const final = loadJob(root, job.id)!;
    assert.equal(final.status, "done");
    assert.equal(final.result?.ok, true);
    // The terminal usage equals the canonical final snapshot derived from the
    // RAW stream by the production parser/normalizer.
    const adapter = createCommandCodeAdapter();
    const state = adapter.createStreamState();
    let at = 1_000_000;
    for (const line of fs.readFileSync(logPath(root, job.id), "utf8").split("\n").filter(Boolean)) {
      adapter.parseStreamLine(line, state, at);
      at += 10;
    }
    const canonical = adapter.normalizeUsage(state);
    assert.deepEqual(final.usage, { ...emptyUsage(), ...canonical });
    // Existing attempt aggregation semantics are unchanged: the job total is
    // the canonical total over attempts (a single attempt contributes once).
    assert.deepEqual(final.usage, totalUsage(final.attempts));
    assert.equal(final.attempts.length, 1);
    assert.deepEqual(final.attempts[0]?.usage, final.usage);
    // Exact canonical values of the controlled stream.
    assert.equal(final.usage.tokensIn, 1800);
    assert.equal(final.usage.tokensOut, 360);
    assert.equal(final.usage.contextUsed, 2400);
    assert.equal(final.usage.contextWindow, 200000);
    assert.equal(final.usage.credits, 0.5);
    for (const unavailable of ["toolCalls", "cacheRead", "cacheMiss", "cacheCreation", "totalCostUsd", "decodeTokens", "decodeSeconds"]) {
      assert.equal((final.usage as unknown as Record<string, unknown>)[unavailable], null, `${unavailable} must stay unavailable, never a fabricated 0`);
    }
  } finally {
    // Release every phase so a failed assertion can never leak the child.
    for (const release of ["phase1.go", "chunks.go", "phase3.go"]) {
      try {
        fs.writeFileSync(path.join(cwd, release), "1");
      } catch {
        /* best effort */
      }
    }
    if (worker) await worker.catch(() => undefined);
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
