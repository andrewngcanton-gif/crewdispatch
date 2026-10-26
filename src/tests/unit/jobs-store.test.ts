// jobs-store.test.ts — durable, atomic, defensive persistence of the job record.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../jobs/service";
import {
  appendLog,
  atomicWriteFile,
  assertInside,
  clearTreeConfirmation,
  isTreeConfirmed,
  jobPath,
  listJobs,
  loadJob,
  readLog,
  readTreeConfirmation,
  inspectDataRootResolution,
  resolveDataRoot,
  safeId,
  saveJob,
  writeTreeConfirmation,
  JobStoreError,
  normalizeJob
} from "../../jobs/store";
import { JOB_SCHEMA_VERSION, emptyUsage, totalUsage, usageReported } from "../../jobs/types";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-store-"));
}

test("a saved job reloads field-for-field from disk", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "hello", cwd: root, model: "m/x", permissionMode: "plan" });
  saveJob(root, job);
  const loaded = loadJob(root, job.id);
  assert.ok(loaded);
  assert.equal(loaded.schemaVersion, JOB_SCHEMA_VERSION);
  assert.equal(loaded.id, job.id);
  assert.equal(loaded.task, "hello");
  assert.equal(loaded.status, "queued");
  assert.equal(loaded.generation, 0);
  assert.equal(loaded.model, "m/x");
  assert.equal(loaded.permissionMode, "plan");
  assert.equal(loaded.ownerStartedAtUs, null);
  assert.equal(loaded.workspaceIdentity, job.workspaceIdentity, "current schema round-trips filesystem identity");
  assert.equal(loaded.logPath, path.join("logs", `${job.id}.ndjson`));
  assert.deepEqual(loaded.usage, emptyUsage());
  fs.rmSync(root, { recursive: true, force: true });
});

test("unreported usage stays null (never a fabricated 0)", () => {
  const job = createJobRecord({ task: "t", cwd: process.cwd() });
  assert.deepEqual(job.usage, emptyUsage());
  assert.equal(usageReported(job.usage), false);
  assert.equal(job.usage.tokensIn, null);
});

test("the write is atomic: no .tmp residue and the target is always valid JSON", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "atomic", cwd: root });
  for (let i = 0; i < 5; i += 1) {
    job.task = `atomic-${i}`;
    saveJob(root, job);
    const raw = fs.readFileSync(jobPath(root, job.id), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  }
  const leftovers = fs.readdirSync(path.join(root, "jobs")).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.equal(loadJob(root, job.id)?.task, "atomic-4");
  fs.rmSync(root, { recursive: true, force: true });
});

test("atomic job writes survive more than the former 120ms Windows rename retry window", { skip: process.platform !== "win32" }, () => {
  const root = tmpRoot();
  const target = path.join(root, "record.json");
  fs.writeFileSync(target, JSON.stringify({ version: "old" }), "utf8");
  const mutableFs = fs as unknown as { renameSync: (...args: unknown[]) => void };
  const originalRenameSync = fs.renameSync;
  let transientFailures = 0;
  mutableFs.renameSync = ((from: unknown, to: unknown) => {
    if (to === target && transientFailures < 8) {
      transientFailures += 1;
      throw Object.assign(new Error("simulated Windows file lock"), { code: "EPERM" });
    }
    (originalRenameSync as unknown as (...args: unknown[]) => void)(from, to);
  }) as (...args: unknown[]) => void;
  try {
    atomicWriteFile(target, JSON.stringify({ version: "new" }));
    assert.equal(transientFailures, 8);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { version: "new" });
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    mutableFs.renameSync = originalRenameSync as unknown as (...args: unknown[]) => void;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listJobs ignores temp files and reports unreadable records", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "listed", cwd: root });
  saveJob(root, job);
  fs.writeFileSync(path.join(root, "jobs", ".partial.tmp"), "{not json", "utf8");
  fs.writeFileSync(path.join(root, "jobs", "broken.json"), "{not json", "utf8");
  const { jobs, unreadable } = listJobs(root);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, job.id);
  assert.deepEqual(unreadable, ["broken.json"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the model source + explicit model persist, and a batch-2/3 record reads with null defaults", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "t", cwd: root, model: "m/explicit" });
  assert.equal(job.explicitModel, "m/explicit");
  assert.equal(job.modelSource, "explicit");
  job.model = "m/slot";
  job.modelSource = "slot";
  saveJob(root, job);
  const loaded = loadJob(root, job.id);
  assert.equal(loaded?.model, "m/slot");
  assert.equal(loaded?.modelSource, "slot");
  assert.equal(loaded?.explicitModel, "m/explicit");

  // A v2 record (no modelSource/explicitModel) reads with null defaults, never a guess.
  const v2 = normalizeJob({
    schemaVersion: 2,
    id: "job-v2-1",
    provider: "command-code",
    status: "done",
    cwd: root,
    task: "old",
    model: "m/whatever"
  });
  assert.equal(v2.modelSource, null);
  assert.equal(v2.explicitModel, null);
  assert.equal(v2.workspaceIdentity, null, "a pre-v15 record has no guessed filesystem identity");
  assert.deepEqual(v2.modelChain, [], "a pre-chain record has no chain (never a guessed one)");
  assert.equal(v2.promptKind, "task", "a pre-prompt-kind record reads as the task prompt");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a v3 record (no downgrade audit) reads with safe defaults and never guesses a source", () => {
  // v3 knew modelSource/explicitModel but had no chain, no promptKind and no
  // per-attempt model/usage. The new fields must read safely, and an UNKNOWN
  // model source / prompt kind must fall back to null / "task" (never a guess).
  const v3 = normalizeJob({
    schemaVersion: 3,
    id: "job-v3-1",
    provider: "command-code",
    status: "done",
    cwd: process.cwd(),
    task: "old",
    model: "m/whatever",
    modelSource: "slot",
    explicitModel: null,
    attempts: [
      {
        generation: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        exitCode: 0,
        kind: "success",
        failureKind: null,
        segment: false,
        resumedFrom: null
      }
    ]
  });
  assert.equal(v3.modelSource, "slot", "a v3 model source is preserved");
  assert.deepEqual(v3.modelChain, []);
  assert.equal(v3.promptKind, "task");
  assert.equal(v3.attempts.length, 1);
  assert.equal(v3.attempts[0]?.model, null, "a pre-audit attempt never back-fills a model");
  assert.equal(v3.attempts[0]?.modelSource, null);
  assert.equal(v3.attempts[0]?.rateLimited, false);
  assert.deepEqual(v3.attempts[0]?.usage, emptyUsage());

  // An unknown source / prompt kind is not guessed.
  const bogus = normalizeJob({
    schemaVersion: 3,
    id: "job-v3-2",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    modelSource: "made-up-source",
    promptKind: "made-up-kind"
  });
  assert.equal(bogus.modelSource, null);
  assert.equal(bogus.promptKind, "task");
  // The new `rate-limit-fallback` source IS recognized.
  const fb = normalizeJob({
    schemaVersion: 4,
    id: "job-v4-1",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    modelSource: "rate-limit-fallback"
  });
  assert.equal(fb.modelSource, "rate-limit-fallback");
});

test("a record written before the finish reason existed loads as null and is never back-filled (JQ-20261001-23)", () => {
  // The exact historical refusal shape: a durable record with stop_reason
  // refusal and NO finish reason (it was never captured). It must keep the
  // honest generic refusal state — no value may be synthesized.
  const legacy = normalizeJob({
    id: "job-legacy-refusal",
    provider: "workbuddy-ai",
    status: "error",
    cwd: process.cwd(),
    task: "old refusal",
    stopReason: "refusal",
    failureKind: "provider_refusal",
    result: {
      ok: false,
      subtype: "error",
      kind: "provider_refusal",
      exitCode: 11,
      stopReason: "refusal",
      finalText: null,
      fallbackEligible: false
    }
  });
  assert.equal(legacy.finishReason, null, "an absent finish reason reads as null, never back-filled");
  assert.equal(legacy.result?.finishReason ?? null, null, "the historical result keeps no finish reason either");

  // A current record's finish reason round-trips exactly, on the job AND result.
  const current = normalizeJob({
    id: "job-current-content-filter",
    provider: "workbuddy-ai",
    status: "error",
    cwd: process.cwd(),
    task: "filtered refusal",
    stopReason: "refusal",
    finishReason: "content_filter",
    failureKind: "provider_refusal",
    result: {
      ok: false,
      subtype: "error",
      kind: "provider_refusal",
      exitCode: 11,
      stopReason: "refusal",
      finishReason: "content_filter",
      finalText: null,
      fallbackEligible: false
    }
  });
  assert.equal(current.finishReason, "content_filter");
  assert.equal(current.result?.finishReason, "content_filter");

  // A non-string persisted value is normalized to null, never carried.
  const corrupt = normalizeJob({
    id: "job-corrupt-finish",
    status: "error",
    cwd: process.cwd(),
    task: "t",
    finishReason: 42
  });
  assert.equal(corrupt.finishReason, null);
});

test("the approval outcome round-trips as a bounded token and is never fabricated for a legacy record", () => {
  // A record written before the approval outcome existed has none: it reads as
  // null (never back-filled from finishReason, failureKind or any other
  // evidence).
  const legacy = normalizeJob({
    id: "job-legacy-approval",
    provider: "workbuddy-ai",
    status: "error",
    cwd: process.cwd(),
    task: "old denial",
    stopReason: "cancelled",
    failureKind: "provider_permission_required",
    result: {
      ok: false,
      subtype: "error",
      kind: "provider_permission_required",
      exitCode: 17,
      stopReason: "cancelled",
      finalText: null,
      fallbackEligible: false
    }
  });
  assert.equal(legacy.approvalOutcome, null, "an absent token reads as null, never back-filled");

  // A proven token round-trips exactly on the job AND stays on the result.
  const current = normalizeJob({
    id: "job-current-approval",
    provider: "command-code",
    status: "done",
    cwd: process.cwd(),
    task: "denied edit",
    stopReason: "end_turn",
    finishReason: "permission_denied",
    approvalOutcome: "rejected",
    result: {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      finishReason: "permission_denied",
      approvalOutcome: "rejected",
      finalText: "The edit was not applied.",
      fallbackEligible: false
    }
  });
  assert.equal(current.approvalOutcome, "rejected");
  assert.equal(current.result?.approvalOutcome, "rejected");

  // An arbitrary persisted string is dropped, never presented as a proven cause.
  const corrupt = normalizeJob({
    id: "job-corrupt-approval",
    status: "error",
    cwd: process.cwd(),
    task: "t",
    approvalOutcome: "the user said no"
  });
  assert.equal(corrupt.approvalOutcome, null);
});

test("totalUsage sums each attempt exactly once and never fabricates a 0 for an unreported metric", () => {
  const a = { ...emptyUsage(), tokensIn: 10, tokensOut: 1 };
  const b = { ...emptyUsage(), tokensIn: 5, tokensOut: 2, credits: 3 };
  const total = totalUsage([
    { generation: 0, startedAt: null, endedAt: null, exitCode: 5, kind: "rate_limit", failureKind: null, segment: false, resumedFrom: null, model: "m/a", modelSource: "slot", effort: null, rateLimited: true, switched: false, switchToModel: null, usage: a },
    { generation: 1, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null, segment: false, resumedFrom: "s", model: "m/b", modelSource: "config-default", effort: "high", rateLimited: false, switched: false, switchToModel: null, usage: b }
  ]);
  assert.equal(total.tokensIn, 15);
  assert.equal(total.tokensOut, 3);
  assert.equal(total.credits, 3);
  // A metric NO attempt reported stays null (never a fabricated 0).
  assert.equal(total.cacheRead, null);
  assert.equal(total.toolCalls, null);
  // No attempts → every metric is still null.
  assert.deepEqual(totalUsage([]), emptyUsage());
});

test("totalUsage preserves weighted cache evidence across attempts instead of averaging response percentages", () => {
  const attempt = (generation: number, cacheRead: number, cacheMiss: number) => ({
    generation, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null,
    segment: false, resumedFrom: null, model: "m/a", modelSource: "slot" as const, effort: null, rateLimited: false,
    switched: false, switchToModel: null, usage: { ...emptyUsage(), cacheRead, cacheMiss }
  });
  // 90% for the first attempt and 0% for the second. The canonical aggregate
  // keeps token counts (90 read / 20 miss => 81.8%), never an arithmetic
  // average of the two percentages (45%).
  const total = totalUsage([attempt(0, 90, 10), attempt(1, 0, 10)]);
  assert.equal(total.cacheRead, 90);
  assert.equal(total.cacheMiss, 20);
});
test("totalUsage takes the LAST reported value for the context GAUGES, never a sum", () => {
  const attempt = (generation: number, usage: ReturnType<typeof emptyUsage>) => ({
    generation, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null,
    segment: false, resumedFrom: null, model: "m/a", modelSource: "slot" as const, effort: null, rateLimited: false,
    switched: false, switchToModel: null, usage
  });
  const total = totalUsage([
    attempt(0, { ...emptyUsage(), contextUsed: 1200, contextWindow: 200000, tokensIn: 10 }),
    attempt(1, { ...emptyUsage(), contextUsed: 4000, contextWindow: 200000, tokensIn: 7 }),
    // A later generation that measured no context must NOT erase the last
    // real observation and must NOT contribute a fabricated 0.
    attempt(2, { ...emptyUsage(), tokensIn: 3 })
  ]);
  assert.equal(total.contextUsed, 4000, "the most recent context observation wins");
  assert.equal(total.contextWindow, 200000, "the window is never summed across generations");
  assert.equal(total.tokensIn, 20, "additive metrics still sum every attempt exactly once");

  // Gauges never reported by ANY attempt stay null.
  const none = totalUsage([attempt(0, { ...emptyUsage(), tokensIn: 1 })]);
  assert.equal(none.contextUsed, null);
  assert.equal(none.contextWindow, null);
});

test("a v5 record (written before the context gauges and the paired decode contract) reads with gauges and decode null", () => {
  const job = normalizeJob({
    schemaVersion: 5,
    id: "job-v5-1",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { tokensIn: 10, tokensOut: 2, toolCalls: 1, credits: null, decodeSeconds: 1.5 }
  });
  assert.equal(job.usage.tokensIn, 10);
  // Pre-v7 `decodeSeconds` measured active output time but never described the
  // same completed responses as any token numerator, so it is dropped to null
  // instead of being presented as a paired rate (no persisted record can prove
  // the pairing retroactively).
  assert.equal(job.usage.decodeSeconds, null);
  assert.equal(job.usage.decodeTokens, null);
  assert.equal(job.usage.contextUsed, null);
  assert.equal(job.usage.contextWindow, null);
});

test("a current-schema record round-trips the paired decode fields", () => {
  const job = normalizeJob({
    schemaVersion: JOB_SCHEMA_VERSION,
    id: "job-v7-1",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { tokensIn: 10, tokensOut: 2, decodeTokens: 320, decodeSeconds: 2.5 }
  });
  assert.equal(job.usage.decodeTokens, 320);
  assert.equal(job.usage.decodeSeconds, 2.5);
});

test("a pre-v8 WorkBuddy decode pair is dropped: the custom synthetic-boundary value is not the dsh-exact fold", () => {
  // The durable pre-v8 record holds only the aggregate pair — never the
  // per-response first-token/assembled-message instants — so the corrected
  // value cannot be recomputed deterministically and the pair is loaded as
  // unavailable rather than silently reinterpreted.
  const attempt = {
    generation: 0, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null,
    segment: false, resumedFrom: null, model: "deepseek-v4.1-flash", modelSource: "config-default",
    rateLimited: false, switched: false, switchToModel: null,
    usage: { tokensIn: 100, tokensOut: 60, decodeTokens: 77_434, decodeSeconds: 203.09 }
  };
  const wb = normalizeJob({
    schemaVersion: 7,
    id: "job-wb-v7-1",
    provider: "workbuddy-ai",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { tokensIn: 100, tokensOut: 60, decodeTokens: 77_434, decodeSeconds: 203.09 },
    attempts: [attempt]
  });
  assert.equal(wb.schemaVersion, 7, "the record keeps its own schema version");
  assert.equal(wb.usage.decodeTokens, null, "the pre-v8 WorkBuddy numerator is dropped");
  assert.equal(wb.usage.decodeSeconds, null, "the pre-v8 WorkBuddy denominator is dropped");
  assert.equal(wb.attempts[0]?.usage.decodeTokens, null, "attempts are gated the same way");
  assert.equal(wb.attempts[0]?.usage.decodeSeconds, null);
  assert.equal(wb.usage.tokensOut, 60, "every other metric is untouched");

  // Command Code's native request-scope pairing is unchanged, so its pre-v8
  // values stay valid.
  const cc = normalizeJob({
    schemaVersion: 7,
    id: "job-cc-v7-1",
    provider: "command-code",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { decodeTokens: 320, decodeSeconds: 2.5 }
  });
  assert.equal(cc.usage.decodeTokens, 320);
  assert.equal(cc.usage.decodeSeconds, 2.5);

  // A current-schema WorkBuddy record keeps its pair: the fields can only be
  // populated from exact completed-response evidence.
  const current = normalizeJob({
    schemaVersion: JOB_SCHEMA_VERSION,
    id: "job-wb-v8-1",
    provider: "workbuddy-ai",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { decodeTokens: 320, decodeSeconds: 2.5 }
  });
  assert.equal(current.usage.decodeTokens, 320);
  assert.equal(current.usage.decodeSeconds, 2.5);
});

test("v8..v11 WorkBuddy decode pairs survive the v12 bump; pre-v8 invalid pairs stay omitted", () => {
  // The decode gate is the schema version that INTRODUCED the dsh-exact fold
  // (v8), not the current version. Every v8..v11 record was written with the
  // same paired semantics as v12, so the bump must not drop its measurement.
  const attempt = {
    generation: 0, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null,
    segment: false, resumedFrom: null, model: "deepseek-v4.1-flash", modelSource: "config-default",
    rateLimited: false, switched: false, switchToModel: null,
    usage: { tokensIn: 100, tokensOut: 60, decodeTokens: 77_434, decodeSeconds: 203.09 }
  };
  for (const version of [8, 9, 10, 11]) {
    const job = normalizeJob({
      schemaVersion: version,
      id: `job-wb-v${version}-keep`,
      provider: "workbuddy-ai",
      status: "done",
      cwd: process.cwd(),
      task: "t",
      usage: { tokensIn: 100, tokensOut: 60, decodeTokens: 77_434, decodeSeconds: 203.09 },
      attempts: [attempt]
    });
    assert.equal(job.schemaVersion, version, "the record keeps its own schema version");
    assert.equal(job.usage.decodeTokens, 77_434, `a v${version} WorkBuddy decode pair must be retained`);
    assert.equal(job.usage.decodeSeconds, 203.09, `a v${version} WorkBuddy decode denominator must be retained`);
    assert.equal(job.attempts[0]?.usage.decodeTokens, 77_434, `v${version} attempts are gated the same way`);
    assert.equal(job.attempts[0]?.usage.decodeSeconds, 203.09);
    assert.equal(job.usage.tokensOut, 60, "every other metric is untouched");
  }

  // A pre-v8 WorkBuddy pair is omitted even when it is malformed (half a pair
  // or non-numeric sides): the legacy branch nulls both fields unconditionally.
  const half = normalizeJob({
    schemaVersion: 7,
    id: "job-wb-v7-half",
    provider: "workbuddy-ai",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { decodeTokens: 500, decodeSeconds: null }
  });
  assert.equal(half.usage.decodeTokens, null);
  assert.equal(half.usage.decodeSeconds, null);
  const junk = normalizeJob({
    schemaVersion: 7,
    id: "job-wb-v7-junk",
    provider: "workbuddy-ai",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { decodeTokens: "many", decodeSeconds: "long" }
  });
  assert.equal(junk.usage.decodeTokens, null);
  assert.equal(junk.usage.decodeSeconds, null);

  // A malformed pair is honest at any version: a non-numeric side reads null.
  const currentJunk = normalizeJob({
    schemaVersion: JOB_SCHEMA_VERSION,
    id: "job-wb-v12-junk",
    provider: "workbuddy-ai",
    status: "done",
    cwd: process.cwd(),
    task: "t",
    usage: { decodeTokens: "many", decodeSeconds: 2 }
  });
  assert.equal(currentJunk.usage.decodeTokens, null);
  assert.equal(currentJunk.usage.decodeSeconds, 2);
});

test("totalUsage sums the paired decode numerator and denominator across attempts exactly once", () => {
  const attempt = (generation: number, usage: ReturnType<typeof emptyUsage>) => ({
    generation, startedAt: null, endedAt: null, exitCode: 0, kind: "success", failureKind: null,
    segment: false, resumedFrom: null, model: "m/a", modelSource: "slot" as const, effort: null, rateLimited: false,
    switched: false, switchToModel: null, usage
  });
  const total = totalUsage([
    attempt(0, { ...emptyUsage(), decodeTokens: 100, decodeSeconds: 2 }),
    // A fallback generation's own completed responses aggregate on top.
    attempt(1, { ...emptyUsage(), decodeTokens: 50, decodeSeconds: 3 }),
    // An attempt with no completed pair contributes neither field (never 0).
    attempt(2, { ...emptyUsage(), tokensIn: 7 })
  ]);
  assert.equal(total.decodeTokens, 150);
  assert.equal(total.decodeSeconds, 5);
  assert.equal(total.tokensIn, 7);
});

test("a newer schemaVersion is refused honestly", () => {
  const raw = {
    schemaVersion: JOB_SCHEMA_VERSION + 1,
    id: "job-future-1",
    status: "running"
  };
  assert.throws(() => normalizeJob(raw), (e: unknown) => e instanceof JobStoreError && e.code === "schema_too_new");
});

test("safeId and assertInside refuse traversal / escape attempts", () => {
  assert.throws(() => safeId("../evil"), (e: unknown) => e instanceof JobStoreError && e.code === "bad_id");
  assert.throws(() => safeId("a/b"), (e: unknown) => e instanceof JobStoreError && e.code === "bad_id");
  assert.throws(() => safeId(".."), (e: unknown) => e instanceof JobStoreError && e.code === "bad_id");
  assert.equal(safeId("job-abc_1.x"), "job-abc_1.x");
  const root = path.join(os.tmpdir(), "jobquay-root-x");
  assert.throws(() => assertInside(root, path.join(root, "..", "other", "f.json")), (e: unknown) => e instanceof JobStoreError && e.code === "outside_root");
  assert.doesNotThrow(() => assertInside(root, path.join(root, "jobs", "a.json")));
});

test("appendLog / readLog round-trip the raw transcript", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "log", cwd: root });
  appendLog(root, job.id, '{"type":"a"}');
  appendLog(root, job.id, '{"type":"b"}');
  const text = readLog(root, job.id);
  assert.equal(text, '{"type":"a"}\n{"type":"b"}\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolveDataRoot prefers the explicit root, then the product env var", () => {
  assert.equal(resolveDataRoot("D:/x/y", {}), path.resolve("D:/x/y"));
  assert.equal(resolveDataRoot(null, { JOBQUAY_DATA_ROOT: "D:/env/root" }), path.resolve("D:/env/root"));
});

test("macOS data-root resolution is fresh/legacy/ambiguous without moving data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-macos-data-root-"));
  const preferred = path.join(home, "Library", "Application Support", "JobQuay");
  const legacy = path.join(home, "JobQuay");
  try {
    const options = { platform: "darwin" as const, homedir: home };

    const fresh = inspectDataRootResolution(null, {}, options);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.source, "macos_application_support");
    assert.equal(fresh.path, preferred);
    assert.equal(fs.existsSync(preferred), false, "resolution never creates the fresh root");

    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sentinel.txt"), "legacy\n", "utf8");
    const legacyOnly = inspectDataRootResolution(null, {}, options);
    assert.equal(legacyOnly.ok, true);
    assert.equal(legacyOnly.source, "macos_legacy");
    assert.equal(legacyOnly.path, legacy);
    assert.equal(fs.readFileSync(path.join(legacy, "sentinel.txt"), "utf8"), "legacy\n");
    assert.equal(fs.existsSync(preferred), false, "legacy continuation never auto-moves data");

    fs.mkdirSync(preferred, { recursive: true });
    fs.writeFileSync(path.join(preferred, "fresh.txt"), "fresh\n", "utf8");
    const both = inspectDataRootResolution(null, {}, options);
    assert.equal(both.ok, false);
    assert.equal(both.source, "ambiguous");
    assert.equal(both.path, null);
    assert.match(String(both.error), /Both macOS data roots exist/);
    assert.throws(
      () => resolveDataRoot(null, {}, options),
      (error: unknown) => error instanceof JobStoreError && error.code === "data_root_ambiguous"
    );
    assert.equal(fs.readFileSync(path.join(legacy, "sentinel.txt"), "utf8"), "legacy\n");
    assert.equal(fs.readFileSync(path.join(preferred, "fresh.txt"), "utf8"), "fresh\n");

    const explicit = path.join(home, "chosen");
    assert.equal(
      resolveDataRoot(explicit, { CREWDISPATCH_DATA_ROOT: "ignored-new", JOBQUAY_DATA_ROOT: "ignored-old" }, options),
      explicit
    );
    assert.equal(
      inspectDataRootResolution(null, { CREWDISPATCH_DATA_ROOT: explicit, JOBQUAY_DATA_ROOT: "ignored-old" }, options).source,
      "crewdispatch_env"
    );
    assert.equal(
      inspectDataRootResolution(null, { JOBQUAY_DATA_ROOT: explicit }, options).source,
      "jobquay_env"
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("a tree confirmation is scoped to job id + generation + child PID", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "t", cwd: root });
  job.childPid = 4321;
  job.childGeneration = 2;
  job.generation = 2;
  saveJob(root, job);

  // No record → not confirmed.
  assert.equal(isTreeConfirmed(root, job), false);

  writeTreeConfirmation(root, job.id, 2, 4321, "os_tree_exited", "test");
  assert.equal(isTreeConfirmed(root, job), true);
  const rec = readTreeConfirmation(root, job.id);
  assert.ok(rec);
  assert.equal(rec!.childPid, 4321);
  assert.equal(rec!.generation, 2);
  assert.equal(rec!.scope, "os_tree_exited", "the confirmation records WHAT was proven");

  // A different PID never matches.
  assert.equal(isTreeConfirmed(root, { ...job, childPid: 9999 }), false);
  // A stale generation never approves a newer run.
  assert.equal(isTreeConfirmed(root, { ...job, generation: 3, childGeneration: 3 }), false);
  // A null child PID is never "confirmed".
  assert.equal(isTreeConfirmed(root, { ...job, childPid: null }), false);

  clearTreeConfirmation(root, job.id);
  assert.equal(readTreeConfirmation(root, job.id), null);
  assert.equal(isTreeConfirmed(root, job), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a tree confirmation is written atomically and is independent of the cancel intent", () => {
  const root = tmpRoot();
  const job = createJobRecord({ task: "t", cwd: root });
  writeTreeConfirmation(root, job.id, 0, 111, "identified_descendants_stopped", "test");
  const files = fs.readdirSync(path.join(root, "tree"));
  assert.deepEqual(files.filter((n) => n.includes(".tmp")), []);
  assert.equal(files.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("renaming preserves the default root and defines new/legacy override precedence", () => {
  const base = path.resolve("brand-compat-base");
  assert.equal(resolveDataRoot(null, { LOCALAPPDATA: base }, { platform: "win32" }), path.join(base, "JobQuay"));
  const env = { CREWDISPATCH_DATA_ROOT: "new-root", JOBQUAY_DATA_ROOT: "old-root" };
  assert.equal(resolveDataRoot(null, env), path.resolve("new-root"));
  assert.equal(resolveDataRoot("explicit-root", env), path.resolve("explicit-root"));
  assert.equal(resolveDataRoot(null, { ...env, CREWDISPATCH_DATA_ROOT: "  " }), path.resolve("old-root"));
});
