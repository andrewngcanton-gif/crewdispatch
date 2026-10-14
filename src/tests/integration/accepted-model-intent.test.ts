// accepted-model-intent.test.ts — the FROZEN dispatch-time model/effort INTENT
// (v11), exercised end to end through the REAL production runner and a
// CONTROLLED official-CLI fixture that speaks the installed Command Code ACP
// protocol (a real separate child process — see tests/helpers/cc-acp-fixture.ts).
//
// The production `command-code` entry launches the CrewDispatch ACP bridge,
// which spawns the resolved CLI as `cmdc acp` and configures model/effort/mode
// over JSON-RPC before prompting. The fixture records the EXACT effective
// model, effort, mode, session and prompt text of every attempt, so the intent
// can be asserted at the real protocol boundary rather than on print-mode argv.
//
// The defect this locks: `startJob` resolved the primary effort from the
// dispatch-time settings while the worker resolved the model chain from whatever
// the settings said when it STARTED, so a Settings edit made while the job was
// queued could pair a LATER model with an EARLIER effort. The minimal accepted
// intent is now frozen before the queued record is exposed, and the worker only
// VALIDATES it against the installed CLI's own catalog.
//
// The dispatch→launch boundary is driven in-process (`startJob` with a no-op
// spawn, then `runWorker`) so the Settings edit lands deterministically BETWEEN
// acceptance and the first worker launch. Everything else is real: the
// production adapter, the catalog probe, the ACP bridge, the child CLI process,
// the persisted record and the launched protocol configuration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { spawn } from "node:child_process";
import { prepareContinuation, runWorker, startJob } from "../../jobs/service";
import { loadJob } from "../../jobs/store";
import { defaultConfig, saveConfig } from "../../config/schema";
import { createCommandCodeAdapter } from "../../providers/command-code";
import { enumerateProcesses } from "../../runtime/process";
import { promptEventsFor, readCcAcpLog, writeCcAcpCmdcFixture } from "../helpers/cc-acp-fixture";

const SESSION = "fake-session-intent";

interface Workspace {
  dir: string;
  root: string;
  fakeCli: string;
  workerScript: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-intent-${name}-`));
  const root = path.join(dir, "root");
  fs.mkdirSync(root, { recursive: true });
  const cliDir = path.join(dir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  // A controlled ACP CLI: it publishes a 4-model catalog and, on a run, drives
  // the installed CLI's own ACP session protocol. The model named by
  // FAKE_SUCCESS_MODEL succeeds and every other model answers the structured
  // RATE_LIMITED error (exit 5), which advances the accepted chain.
  const { shim } = writeCcAcpCmdcFixture(cliDir, {
    models: ["fake/model-a", "fake/model-b", "fake/model-x", "fake/model-y"],
    defaultModel: "fake/model-a",
    sessionId: SESSION
  });
  // `spawnWorker` requires the worker entry to exist; the no-op spawn below never
  // actually runs it, so a placeholder file is enough.
  const workerScript = path.join(dir, "worker.js");
  fs.writeFileSync(workerScript, "// placeholder worker entry (never executed)\n", "utf8");
  const log = path.join(dir, "fake-invocations.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CLI_LOG: log };
  return { dir, root, fakeCli: shim, workerScript, log, env };
}

/** A spawn stand-in that records nothing and starts no process. */
const noopSpawn = (() => ({ pid: 999999, unref() {} })) as unknown as typeof spawn;

interface Attempt {
  model: string | null;
  effort: string | null;
  prompt: string | null;
}

function attempts(log: string, project: string): Attempt[] {
  return promptEventsFor(log, project).map((entry) => ({
    model: entry.model ?? null,
    effort: entry.effortValue ?? null,
    prompt: entry.text ?? null
  }));
}

function pair(attempt: Attempt): [string | null, string | null] {
  return [attempt.model, attempt.effort];
}

test("settings edited after acceptance but BEFORE the first worker launch cannot change the accepted model/effort pairs", { timeout: 120000 }, async () => {
  const ws = newWorkspace("frozen");
  ws.env.FAKE_SUCCESS_MODEL = "fake/model-b";
  const project = path.join(ws.dir, "project");
  fs.mkdirSync(project, { recursive: true });
  const scans: Awaited<ReturnType<typeof enumerateProcesses>>[] = [];
  const enumerateFn = async (): Promise<Awaited<ReturnType<typeof enumerateProcesses>>> => {
    const scan = await enumerateProcesses();
    scans.push(scan);
    return scan;
  };
  try {
    const capabilities = await createCommandCodeAdapter().probeCapabilities({ cliPath: ws.fakeCli, env: ws.env });
    assert.equal(capabilities.supportsEffort, true, JSON.stringify(capabilities));
    // S1 — the ACCEPTED settings (main = model-a/high, fallback = model-b/low).
    saveConfig(ws.root, {
      ...defaultConfig(),
      cliPath: ws.fakeCli,
      defaultModel: "fake/model-a",
      defaultEffort: "high",
      rateLimitFallbackModel: "fake/model-b",
      rateLimitFallbackEffort: "low",
      permissionMode: "accept-edits"
    });

    const spawned = startJob({
      root: ws.root,
      task: "FROZEN_TASK",
      cwd: project,
      cliPath: ws.fakeCli,
      workerScript: ws.workerScript,
      env: ws.env,
      spawnWorkerFn: noopSpawn
    });

    // The queued record is durable and already carries the frozen intent — BEFORE
    // any worker exists.
    const queued = loadJob(ws.root, spawned.job.id)!;
    assert.equal(queued.status, "queued");
    assert.deepEqual(queued.acceptedIntent, {
      primaryModel: "fake/model-a",
      primarySource: "config-default",
      primaryEffort: "high",
      fallbacks: [{ model: "fake/model-b", source: "rate-limit-fallback", effort: "low" }]
    });

    // S2 — BOTH the main and the fallback settings change while the job is queued.
    saveConfig(ws.root, {
      ...defaultConfig(),
      cliPath: ws.fakeCli,
      defaultModel: "fake/model-x",
      defaultEffort: "minimal",
      rateLimitFallbackModel: "fake/model-y",
      rateLimitFallbackEffort: "max",
      permissionMode: "accept-edits"
    });

    // The worker starts NOW: it must launch the ACCEPTED pairs, never S2's.
    const result = await runWorker({ root: ws.root, jobId: spawned.job.id, cliPath: ws.fakeCli, env: ws.env, enumerateFn });
    assert.equal(result.status, "done", JSON.stringify({ result, record: loadJob(ws.root, spawned.job.id), scans }));

    const att = attempts(ws.log, project);
    assert.equal(att.length, 2, "the accepted chain advanced exactly once (a → b)");
    assert.deepEqual(att.map(pair), [
      ["fake/model-a", "high"],
      ["fake/model-b", "low"]
    ]);

    const rec = loadJob(ws.root, spawned.job.id)!;
    assert.deepEqual(rec.modelChainPlan, [
      { model: "fake/model-a", source: "config-default", effort: "high" },
      { model: "fake/model-b", source: "rate-limit-fallback", effort: "low" }
    ]);
    assert.equal(rec.model, "fake/model-b");
    assert.equal(rec.modelSource, "rate-limit-fallback");
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});

test("a restarted continuation resumes the accepted fallback candidate+effort instead of resetting to the primary", { timeout: 120000 }, async () => {
  const ws = newWorkspace("resume");
  ws.env.FAKE_SUCCESS_MODEL = "fake/model-b";
  const project = path.join(ws.dir, "project");
  fs.mkdirSync(project, { recursive: true });
  try {
    const acceptedConfig = {
      ...defaultConfig(),
      cliPath: ws.fakeCli,
      defaultModel: "fake/model-a",
      defaultEffort: "high",
      rateLimitFallbackModel: "fake/model-b",
      rateLimitFallbackEffort: "low",
      permissionMode: "accept-edits"
    };
    saveConfig(ws.root, acceptedConfig);

    const spawned = startJob({
      root: ws.root,
      task: "RESUME_TASK",
      cwd: project,
      cliPath: ws.fakeCli,
      workerScript: ws.workerScript,
      env: ws.env,
      spawnWorkerFn: noopSpawn
    });
    const first = await runWorker({ root: ws.root, jobId: spawned.job.id, cliPath: ws.fakeCli, env: ws.env });
    assert.equal(first.status, "done", JSON.stringify({ result: first, record: loadJob(ws.root, spawned.job.id) }));
    const ended = loadJob(ws.root, spawned.job.id)!;
    assert.equal(ended.model, "fake/model-b");
    assert.equal(ended.modelSource, "rate-limit-fallback");
    assert.equal(ended.sessionId, SESSION);
    const before = attempts(ws.log, project).length;
    assert.equal(before, 2);

    // A follow-up arrives. BOTH settings are edited to DIFFERENT models/efforts
    // first — the continuation must still resume the accepted fallback pair.
    saveConfig(ws.root, {
      ...defaultConfig(),
      cliPath: ws.fakeCli,
      defaultModel: "fake/model-x",
      defaultEffort: "minimal",
      rateLimitFallbackModel: "fake/model-y",
      rateLimitFallbackEffort: "max",
      permissionMode: "accept-edits"
    });

    const cont = await prepareContinuation({
      root: ws.root,
      jobId: spawned.job.id,
      task: "FOLLOW_UP_MARKER",
      cliPath: ws.fakeCli,
      workerScript: ws.workerScript,
      env: ws.env,
      spawnWorkerFn: noopSpawn
    });
    assert.equal(cont.ok, true);

    const second = await runWorker({ root: ws.root, jobId: spawned.job.id, cliPath: ws.fakeCli, env: ws.env });
    assert.equal(second.status, "done");

    const att = attempts(ws.log, project).slice(before);
    assert.equal(att.length, 1, "the continuation resumes the accepted fallback — it does NOT retry the primary");
    assert.deepEqual(pair(att[0]!), ["fake/model-b", "low"]);
    assert.equal(att[0]!.prompt, "FOLLOW_UP_MARKER", "the continuation carries the new user message");

    // The continuation attached the SAME provider session over ACP (resume), not
    // a fresh one: the resumed session id must appear in the protocol log.
    const resumes = readCcAcpLog(ws.log).filter((entry) => entry.kind === "resume");
    assert.equal(resumes[resumes.length - 1]?.sessionId, SESSION, "the SAME session is resumed over ACP");

    const final = loadJob(ws.root, spawned.job.id)!;
    assert.equal(final.model, "fake/model-b");
    assert.equal(final.modelSource, "rate-limit-fallback");
  } finally {
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
});
