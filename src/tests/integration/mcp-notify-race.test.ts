// mcp-notify-race.test.ts — REAL verification of the batch-3 notification race
// fix, using a controllable BLOCKING loopback HTTP listener and (for the first
// case) the BUILT MCP server as a separate process.
//
// It proves the two windows that the old implementation got wrong:
//   (A) a gen-0 terminal wake is IN FLIGHT (the listener holds the POST) while
//       `jobquay_follow_up` advances the SAME job to generation 1 — after the
//       held response is released the job must NOT regress (id/generation/task/
//       status), and each terminal generation must have its OWN single wake;
//   (B) a follow-up that lands BEFORE the old worker even sends its POST — the
//       old terminal generation is still discovered from its immutable snapshot
//       and woken exactly once, without rewriting the newer record.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { createFixtureRunner } from "../../cli/fixture-runner";
import { createJobRecord, prepareContinuation, runWorker } from "../../jobs/service";
import { claimNotificationAttempt, ensureRoot, loadJob, readNotificationResults, saveJob, writeNotificationResult } from "../../jobs/store";
import type { NotifyTarget } from "../../jobs/types";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

/** Every attempt succeeds and reports a stable session id (supports --resume). */
function fixtureEcho(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-race" } });',
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: "fx-session-race", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  fixture: string;
  cleanup: () => void;
}

function newWorkspace(name: string, fixtureLines: string[]): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-notify-race-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, `${name}.js`);
  fs.writeFileSync(fixture, fixtureLines.join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    // Case A intentionally holds a real callback request while the SAME job is
    // advanced to the next generation. Keep the test transport in-flight for
    // the whole 90s test budget instead of racing the product 8s default under
    // a heavily loaded full suite. The worker honors this only with --fixture.
    JOBQUAY_TEST_NOTIFY_TIMEOUT_MS: "60000"
  };
  return { dir, root, project, env, fixture, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

interface Listener {
  url: string;
  bodies: string[];
  /** Release the FIRST held request (see `holdFirst`). */
  releaseFirst: () => void;
  close: () => Promise<void>;
}

/** A real listener that HOLDS the first request until `releaseFirst()` is called. */
function startBlockingListener(holdFirst = true): Promise<Listener> {
  const bodies: string[] = [];
  let held: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(b);
      if (holdFirst && bodies.length === 1) {
        held = res; // keep the first wake in flight
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/wake`,
        bodies,
        releaseFirst: () => {
          if (held) {
            held.writeHead(200);
            held.end("ok");
            held = null;
          }
        },
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function waitTerminal(root: string, id: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // This test deliberately holds the worker's terminal callback in flight.
    // Read the durable record directly: jobquay_status is itself a legitimate
    // notification-recovery owner and could claim the held callback with the
    // production 8s timeout before the fixture worker's 60s test seam does.
    const job = readRecord(root, id);
    if (TERMINAL.has(String(job?.status))) return job;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}
function readRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

test("(A) a held gen-0 wake + a follow-up to gen1 never regresses the job, and each generation wakes once", { timeout: 90000 }, async () => {
  const ws = newWorkspace("inflight", fixtureEcho());
  const listener = await startBlockingListener(true);
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const gen0Task = "GEN0_TASK_MARKER";
  const gen1Task = "GEN1_TASK_MARKER";
  try {
    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", { task: gen0Task, cwd: ws.project, callback_url: listener.url })
    );
    const id = String(spawned.job_id);

    // gen-0 reaches terminal and its wake is now HELD in flight by the listener.
    await waitTerminal(ws.root, id);
    await waitFor(() => listener.bodies.length >= 1, 20000, "the gen-0 wake to arrive (in flight)");

    // Advance the SAME job to generation 1 while gen-0's POST is still in flight.
    // Do not keep the callback hostage until the whole follow-up RPC returns: on
    // a loaded hosted runner the daemon may spend additional time after the
    // durable generation bump launching its worker. The race we need to prove is
    // exactly "gen-1 became durable before gen-0 delivery settled", so observe
    // that authoritative fact directly, release the held response immediately,
    // and only then await the caller response.
    const followedPending = client.callTool("jobquay_follow_up", { id, message: gen1Task });
    await waitFor(
      () => {
        const current = readRecord(ws.root, id);
        return Number(current.generation) === 1 ? true : false;
      },
      20000,
      "generation 1 to become durable while the gen-0 wake is held"
    );
    listener.releaseFirst();
    const followed = McpStdioClient.json(await followedPending);
    assert.equal(followed.ok, true);
    assert.equal(followed.job_id, id, "the follow-up must keep the SAME job id");
    assert.equal(followed.generation, 1);

    // Gen-1 runs and wakes on its own.
    await waitTerminal(ws.root, id);
    await waitFor(() => listener.bodies.length >= 2, 30000, "the gen-1 wake to arrive");
    await sleep(600); // give a stray duplicate a chance to arrive

    assert.equal(listener.bodies.length, 2, "each terminal generation wakes exactly once (no duplicate, no miss)");

    // The live record must NOT have regressed to generation 0.
    const record = readRecord(ws.root, id);
    assert.equal(record.id, id, "job id must be unchanged");
    assert.equal(record.generation, 1, "the generation must not regress");
    assert.equal(record.status, "done");
    assert.equal(record.task, gen1Task, "the task must be the follow-up message, not the old one");

    // Each terminal generation has its OWN recorded wake result; the record
    // itself carries none (results live in generation-scoped files).
    const results = readNotificationResults(ws.root, id);
    assert.deepEqual(results.map((r) => r.generation), [0, 1]);
    for (const r of results) {
      assert.equal(r.delivered, true, `generation ${r.generation} must be delivered: ${JSON.stringify(r)}`);
      assert.equal(r.by, "worker", `the fixture worker must own the held wake claim: ${JSON.stringify(r)}`);
    }
    assert.equal((record.notifications as unknown[]).length, 0, "wake results must not be written into the record");

    // Both bodies are the short {job_id,status} shape and carry no task text.
    for (const body of listener.bodies) {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed).sort(), ["job_id", "status"]);
      assert.equal(parsed.job_id, id);
      assert.equal(body.includes("GEN0_TASK_MARKER") || body.includes("GEN1_TASK_MARKER"), false);
    }
  } finally {
    await client.close();
    await listener.close();
    await ws.cleanup();
  }
});

test("(C) one-shot jobquay_result waits locally for an already-delivered wake diagnostic to settle", { timeout: 30000 }, async () => {
  const ws = newWorkspace("result-settle", fixtureEcho());
  const target: NotifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:9/wake", codexThreadId: null, source: "callback_url" };
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  let timer: NodeJS.Timeout | null = null;
  try {
    ensureRoot(ws.root);
    const job = createJobRecord({ task: "RESULT_SETTLE_MARKER", cwd: ws.project, runner: "fixture", notifyTarget: target });
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.result = {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      finalText: "RESULT-SETTLE-OK",
      fallbackEligible: false
    };
    saveJob(ws.root, job);

    // Simulate the worker having already claimed this generation and delivered
    // the external wake, while its atomic delivery-result write is still a few
    // milliseconds behind. The MCP read must not steal/repeat the wake.
    assert.equal(claimNotificationAttempt(ws.root, job.id, 0), true);
    await client.initialize();
    timer = setTimeout(() => {
      writeNotificationResult(ws.root, job.id, 0, {
        generation: 0,
        kind: "callback",
        attemptedAt: new Date().toISOString(),
        delivered: true,
        reason: null,
        by: null
      });
    }, 80);

    const started = Date.now();
    const result = McpStdioClient.json(await client.callTool("jobquay_result", { id: job.id }));
    const elapsed = Date.now() - started;
    assert.equal(result.status, "done");
    assert.equal((result.result as Record<string, unknown>).final_text, "RESULT-SETTLE-OK");
    assert.deepEqual(result.notify, {
      kind: "callback",
      source: "callback_url",
      attempted: true,
      delivered: true,
      reason: null,
      // The HTTP callback transport cannot prove a transport phase: UNKNOWN.
      phase: null
    });
    assert.ok(elapsed >= 40, `one-shot result should wait for the in-flight diagnostic (elapsed=${elapsed}ms)`);
    assert.ok(elapsed < 1500, `settled diagnostic should return promptly (elapsed=${elapsed}ms)`);
  } finally {
    if (timer) clearTimeout(timer);
    await client.close();
    await ws.cleanup();
  }
});

test("(B) a follow-up that lands BEFORE the old worker's POST still wakes the old generation exactly once", { timeout: 90000 }, async () => {
  const ws = newWorkspace("beforenotify", fixtureEcho());
  const listener = await startBlockingListener(false);
  const root = ws.root;
  const gen0Task = "GEN0_TASK_MARKER";
  const gen1Task = "GEN1_TASK_MARKER";
  try {
    ensureRoot(root);
    const target: NotifyTarget = { kind: "callback", callbackUrl: listener.url, codexThreadId: null, source: "callback_url" };
    const job = createJobRecord({ task: gen0Task, cwd: ws.project, runner: "fixture", notifyTarget: target });
    saveJob(root, job);

    // Run the REAL worker for gen-0 in-process. `beforeNotify` runs AFTER the
    // gen-0 terminal state is durable and BEFORE the worker attempts its wake, so
    // the follow-up deterministically wins the race to the old wake. The wake
    // itself is then a REAL POST (the default delivery) to the loopback listener.
    let followedGeneration: number | null = null;
    const rec = await runWorker({
      root,
      jobId: job.id,
      createRunner: (ctx) => Promise.resolve(createFixtureRunner(ws.fixture, ctx.env)),
      beforeNotify: async () => {
        const next = await prepareContinuation({
          root,
          jobId: job.id,
          task: gen1Task,
          fixturePath: ws.fixture,
          env: ws.env
        });
        assert.equal(next.ok, true, "the follow-up must be accepted");
        if (next.ok) followedGeneration = next.job.generation;
      }
    });
    assert.equal(rec.status, "done");
    assert.equal(followedGeneration, 1, "the follow-up advanced to generation 1 before the old wake");

    // The record is now generation 1; wait for the gen-1 worker to finish.
    await waitFor(() => {
      const j = loadJob(root, job.id);
      return j != null && j.generation === 1 && TERMINAL.has(j.status);
    }, 30000, "generation 1 to reach a terminal state");
    await waitFor(() => listener.bodies.length >= 2, 20000, "both wakes to arrive");
    await sleep(600);

    const record = loadJob(root, job.id)!;
    assert.equal(record.generation, 1, "the follow-up generation must not be clobbered by the old wake");
    assert.equal(record.status, "done");
    assert.equal(record.task, gen1Task);
    assert.equal(listener.bodies.length, 2, "one wake per terminal generation, no duplicate and no miss");

    const results = readNotificationResults(root, job.id);
    assert.deepEqual(results.map((r) => r.generation), [0, 1]);
    for (const r of results) assert.equal(r.delivered, true);
    assert.equal(record.notifications.length, 0, "wake results stay in generation-scoped files");
  } finally {
    await listener.close();
    await ws.cleanup();
  }
});
