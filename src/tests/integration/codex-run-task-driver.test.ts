import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DRIVER = path.join(REPO_ROOT, "scripts", "codex-jobquay-run-task.cjs");

function tempRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function writeSession(codexHome: string, thread: string, cwd: string, suffix: string): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "29");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-29T10-00-0${suffix}-${thread}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    timestamp: "2026-09-29T02:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: thread,
      id: thread,
      timestamp: "2026-09-29T02:00:00.000Z",
      cwd,
      originator: "Codex Desktop",
      source: "vscode",
      thread_source: "user"
    }
  }) + "\n", "utf8");
  return file;
}

function runDriver(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [DRIVER, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "")
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file: string, timeoutMs = 20000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    sleepSync(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

interface DriverRun {
  child: ReturnType<typeof spawn>;
  done: Promise<{ status: number | null; stdout: string; stderr: string }>;
}

function spawnDriver(args: string[], env: NodeJS.ProcessEnv): DriverRun {
  const child = spawn(process.execPath, [DRIVER, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

function queuedRunId(stdout: string): string {
  const queuedLine = stdout.split(/\r?\n/).find((line) => line.includes('"phase":"queued"'));
  assert.ok(queuedLine, `queued line missing:\n${stdout}`);
  return JSON.parse(queuedLine).run_id as string;
}

function finalJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    const start = stdout.indexOf("\n{");
    assert.ok(start >= 0, `final JSON object missing:\n${stdout}`);
    return JSON.parse(stdout.slice(start + 1)) as Record<string, unknown>;
  }
}

function appendRolloutLine(rollout: string, obj: unknown): void {
  fs.appendFileSync(rollout, JSON.stringify(obj) + "\n", "utf8");
}

function appendSpawnLine(rollout: string, opts: { task: string; cwd: string; thread: string; jobId: string; clientRunId?: string }): void {
  appendRolloutLine(rollout, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        server: "crewdispatch",
        tool: "jobquay_spawn",
        arguments: {
          task: opts.task,
          cwd: opts.cwd,
          codex_thread_id: opts.thread,
          provider: "command-code",
          ...(opts.clientRunId ? { client_run_id: opts.clientRunId } : {})
        },
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              accepted: true,
              job_id: opts.jobId,
              status: "queued",
              notify: { kind: "codex_thread", source: "codex_thread_id" }
            })
          }]
        }
      }
    }
  });
}

function appendWakeLine(rollout: string, jobId: string): void {
  appendRolloutLine(rollout, {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `CrewDispatch job ${jobId} finished with status done. Call jobquay_result(id="${jobId}") exactly once to collect the result.` }]
    }
  });
}

function appendResultAndMarker(rollout: string, readyMarker: string, jobId: string, generation: number, finalText: string): void {
  appendRolloutLine(rollout, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        server: "jobquay",
        tool: "jobquay_result",
        arguments: { id: jobId },
        result: {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, job_id: jobId, status: "done", generation, result: { final_text: finalText } })
          }]
        }
      }
    }
  });
  appendRolloutLine(rollout, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "AgentMessage", content: [{ type: "text", text: `${readyMarker}\nJob ${jobId} generation ${generation} terminal done.` }] }
    }
  });
}

function appendLateTerminalSequence(rollout: string, readyMarker: string, jobId: string, generation: number, finalText: string): void {
  appendWakeLine(rollout, jobId);
  appendResultAndMarker(rollout, readyMarker, jobId, generation, finalText);
}

function appendPromptLine(rollout: string, runId: string): void {
  appendRolloutLine(rollout, {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "JOBQUAY WEBCODEX RUN " + runId + "\nlegacy bridge prompt" }]
    }
  });
}

// A delivered bridge prompt (initial run or follow-up): the queued text with
// the round's own READY_MARKER= line, exactly what a live Codex session appends
// to the rollout when it drains the durable queue.
function appendBridgePromptLine(rollout: string, runId: string, meta: Record<string, unknown>, kind: "RUN" | "FOLLOW-UP" = "RUN"): void {
  appendRolloutLine(rollout, {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "JOBQUAY WEBCODEX " + kind + " " + runId +
          "\nREADY_MARKER=" + meta.ready_marker +
          "\nATTENTION_MARKER=" + meta.attention_marker
      }]
    }
  });
}

function appendFollowUpCallLine(rollout: string, jobId: string, generation: number): void {
  appendRolloutLine(rollout, {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "McpToolCall",
        server: "jobquay",
        tool: "jobquay_follow_up",
        arguments: { id: jobId, message: "repair request" },
        result: { content: [{ type: "text", text: JSON.stringify({ ok: true, job_id: jobId, generation, status: "queued" }) }] }
      }
    }
  });
}

interface LegacyRunMetaInput {
  runId: string;
  rollout: string;
  project: string;
  thread: string;
  workerTask: string;
  provider?: string;
}

function writeLegacyRunMeta(runsDir: string, input: LegacyRunMetaInput): string {
  const file = path.join(runsDir, input.runId + ".json");
  fs.writeFileSync(file, JSON.stringify({
    version: 2,
    run_id: input.runId,
    created_at: "2026-10-01T00:00:00.000Z",
    thread_id: input.thread,
    rollout: input.rollout,
    start_offset: 0,
    binding_method: "binding",
    cwd: input.project,
    provider: input.provider ?? "command-code",
    model: null,
    worker_task: input.workerTask,
    objective: "legacy fixture",
    max_followups: 2,
    bridge_round: 0,
    ready_marker: input.runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0",
    attention_marker: input.runId + "-CODEX-BRIDGE-NEEDS-ATTENTION-R0"
  }, null, 2) + "\n", "utf8");
  return file;
}

// A complete unrelated same-thread run appended after the fixture run: its own
// prompt, spawn (schema-v2 shape: no client_run_id), wake, result and marker.
function appendUnrelatedFutureRun(
  rollout: string,
  opts: { runId: string; jobId: string; project: string; thread: string; task: string }
): void {
  appendPromptLine(rollout, opts.runId);
  appendSpawnLine(rollout, { task: opts.task, cwd: opts.project, thread: opts.thread, jobId: opts.jobId });
  appendWakeLine(rollout, opts.jobId);
  appendResultAndMarker(rollout, opts.runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", opts.jobId, 0, "future run done");
}

test("resolve auto-binds one matching Codex Desktop cwd and then reuses the project binding", () => {
  const root = tempRoot("jobquay-run-task-resolve-");
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453540";
    writeSession(codexHome, thread, project, "1");

    const first = runDriver(["resolve", "--cwd", project, "--codex-home", codexHome, "--state", state]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstBody = JSON.parse(first.stdout);
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.method, "auto-cwd");
    assert.equal(firstBody.thread_id, thread);

    const secondThread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453541";
    writeSession(codexHome, secondThread, project, "2");
    const second = runDriver(["resolve", "--cwd", project, "--codex-home", codexHome, "--state", state]);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(secondBody.method, "binding");
    assert.equal(secondBody.thread_id, thread);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous cwd discovery refuses to guess and marker binding needs no UUID", () => {
  const root = tempRoot("jobquay-run-task-marker-");
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const a = "01a0e0ca-c6d7-75e3-83c7-f73d3a453542";
    const b = "01a0e0ca-c6d7-75e3-83c7-f73d3a453543";
    const fileA = writeSession(codexHome, a, project, "3");
    const fileB = writeSession(codexHome, b, project, "4");
    const now = new Date();
    fs.utimesSync(fileA, now, now);
    fs.utimesSync(fileB, now, now);

    const unresolved = runDriver(["resolve", "--cwd", project, "--codex-home", codexHome, "--state", state]);
    assert.equal(unresolved.status, 2);
    const unresolvedBody = JSON.parse(unresolved.stdout);
    assert.equal(unresolvedBody.code, "codex_thread_ambiguous");
    assert.match(unresolvedBody.marker, /^JOBQUAY-BIND-[A-F0-9]+$/);

    fs.appendFileSync(fileB, JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: unresolvedBody.marker }] }
    }) + "\n", "utf8");

    const bound = runDriver([
      "bind", "--cwd", project, "--marker", unresolvedBody.marker,
      "--codex-home", codexHome, "--state", state
    ]);
    assert.equal(bound.status, 0, bound.stderr || bound.stdout);
    const boundBody = JSON.parse(bound.stdout);
    assert.equal(boundBody.method, "marker");
    assert.equal(boundBody.thread_id, b);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run keeps Codex as a protocol bridge and returns the worker result for WebCodex acceptance", () => {
  const root = tempRoot("jobquay-run-task-flow-");
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453544";
    const rollout = writeSession(codexHome, thread, project, "5");
    const brief = path.join(root, "brief.json");
    fs.writeFileSync(brief, JSON.stringify({
      objective: "Fix the example behavior without touching unrelated work.",
      context: "Existing unrelated changes may coexist.",
      worker_task: "Change src/example.ts safely.\nRun the focused test and report evidence.",
      review_contract: ["Inspect the actual diff.", "Run the focused test yourself."],
      external_acceptance: ["WebCodex checks the final diff.", "WebCodex runs repository acceptance."]
    }), "utf8");
    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");

    const run = runDriver([
      "run", "--brief", brief, "--cwd", project,
      "--codex-home", codexHome, "--codex", fakeCodex,
      "--state", state, "--timeout-seconds", "5"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /"phase":"queued"/);
    assert.match(run.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(run.stdout, /"job_id": "job-fake-review-1"/);
    assert.match(run.stdout, /"generation": 0/);
    assert.match(run.stdout, /"worker_result": "worker says done"/);
    assert.doesNotMatch(run.stdout, /Reviewed actual diff/);
    assert.match(run.stdout, /Inspect the actual diff/);
    assert.match(run.stdout, /WebCodex checks the final diff/);

    const queuedLine = run.stdout.split(/\r?\n/).find((line) => line.includes('"phase":"queued"'));
    assert.ok(queuedLine);
    const runId = JSON.parse(queuedLine).run_id as string;
    const repair = "Acceptance found one concrete defect. Fix only that defect and rerun the focused test.";
    const follow = runDriver([
      "follow-up", "--run-id", runId, "--message", repair,
      "--codex-home", codexHome, "--codex", fakeCodex,
      "--state", state, "--timeout-seconds", "5"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project
    });
    assert.equal(follow.status, 0, follow.stderr || follow.stdout);
    assert.match(follow.stdout, /"phase":"follow_up_queued"/);
    assert.match(follow.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(follow.stdout, /"generation": 1/);
    assert.match(follow.stdout, /"follow_ups": 1/);
    assert.match(follow.stdout, /"results_collected": 2/);
    assert.match(follow.stdout, /"worker_result": "worker repair done"/);

    const inspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout);
    assert.equal(inspected.phase, "ready_for_external_acceptance");
    assert.equal(inspected.job_id, "job-fake-review-1");
    assert.equal(inspected.generation, 1);
    assert.equal(inspected.follow_ups, 1);
    assert.equal(inspected.results_collected, 2);
    assert.equal(inspected.evidence.follow_up_job_ids[0], "job-fake-review-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two interleaved runs on one Codex thread count only their own spawn/result/wake/marker", async () => {
  const root = tempRoot("jobquay-run-task-interleaved-");
  const coord = path.join(root, "coord");
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(coord, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453546";
    const rollout = writeSession(codexHome, thread, project, "6");
    const briefA = path.join(root, "brief-a.json");
    const briefB = path.join(root, "brief-b.json");
    fs.writeFileSync(briefA, JSON.stringify({
      objective: "Interleaved run A.",
      worker_task: "Task A: touch only src/a.ts.",
      review_contract: ["A review contract."],
      external_acceptance: ["A external acceptance."]
    }), "utf8");
    fs.writeFileSync(briefB, JSON.stringify({
      objective: "Interleaved run B.",
      worker_task: "Task B: touch only src/b.ts.",
      review_contract: ["B review contract."],
      external_acceptance: ["B external acceptance."]
    }), "utf8");
    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");
    const gate = (name: string) => path.join(coord, name);
    const commonArgs = ["--cwd", project, "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--timeout-seconds", "20"];

    // Start run A, let it append its prompt, then start run B: B's scan window
    // begins between A's prompt and A's spawn, so B sees A's spawn too.
    const runA = spawnDriver(["run", "--brief", briefA, ...commonArgs], {
      FAKE_ROLLOUT: rollout, FAKE_PROJECT: project, FAKE_SCENARIO: "interleaved",
      FAKE_ROLE: "A", FAKE_COORD_DIR: coord, FAKE_JOB_ID: "job-interleaved-a"
    });
    children.push(runA.child);
    waitForFile(gate("A-prompted"));
    const runB = spawnDriver(["run", "--brief", briefB, ...commonArgs], {
      FAKE_ROLLOUT: rollout, FAKE_PROJECT: project, FAKE_SCENARIO: "interleaved",
      FAKE_ROLE: "B", FAKE_COORD_DIR: coord, FAKE_JOB_ID: "job-interleaved-b"
    });
    children.push(runB.child);
    waitForFile(gate("B-prompted"));
    fs.writeFileSync(gate("A-spawn-go"), "");
    waitForFile(gate("A-spawned"));
    fs.writeFileSync(gate("B-spawn-go"), "");
    waitForFile(gate("B-spawned"));
    // B has spawned while run A is still mid-flight; only now may A finish.
    fs.writeFileSync(gate("A-finish-go"), "");

    const a = await runA.done;
    assert.equal(a.status, 0, a.stderr || a.stdout);
    assert.match(a.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(a.stdout, /"job_id": "job-interleaved-a"/);
    assert.match(a.stdout, /"results_collected": 1/);
    const runIdA = queuedRunId(a.stdout);

    fs.writeFileSync(gate("B-finish-go"), "");
    const b = await runB.done;
    assert.equal(b.status, 0, b.stderr || b.stdout);
    assert.match(b.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(b.stdout, /"job_id": "job-interleaved-b"/);
    assert.match(b.stdout, /"results_collected": 1/);
    const runIdB = queuedRunId(b.stdout);
    assert.notEqual(runIdA, runIdB);

    // The rollout really interleaves: B's spawn precedes A's terminal wake, and
    // both runs' round markers are present in the one rollout.
    const lines = fs.readFileSync(rollout, "utf8").split(/\r?\n/).filter((line) => line.trim());
    const bSpawnAt = lines.findIndex((line) => line.includes("jobquay_spawn") && line.includes("job-interleaved-b"));
    const aWakeAt = lines.findIndex((line) => /(?:CrewDispatch|JobQuay) job job-interleaved-a finished/.test(line));
    assert.ok(bSpawnAt >= 0 && aWakeAt >= 0 && bSpawnAt < aWakeAt, "expected B to spawn before A finished");
    assert.ok(lines.some((line) => line.includes(runIdA + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0")));
    assert.ok(lines.some((line) => line.includes(runIdB + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0")));

    const inspectA = runDriver(["inspect", "--run-id", runIdA, "--state", state]);
    assert.equal(inspectA.status, 0, inspectA.stderr || inspectA.stdout);
    const evidenceA = JSON.parse(inspectA.stdout).evidence;
    assert.equal(evidenceA.correlation_id, runIdA);
    assert.equal(evidenceA.spawn_calls, 1);
    assert.equal(evidenceA.spawn_job_id, "job-interleaved-a");
    assert.equal(evidenceA.spawn_task, "Task A: touch only src/a.ts.");
    assert.deepEqual(evidenceA.result_job_ids, ["job-interleaved-a"]);
    assert.equal(evidenceA.wake_count, 1);
    assert.equal(evidenceA.result_calls, 1);
    assert.equal(evidenceA.status_calls, 0);
    assert.equal(evidenceA.follow_up_calls, 0);
    assert.equal(evidenceA.cancel_calls, 0);
    assert.equal(evidenceA.final_outcome, "ready");
    assert.match(evidenceA.final_message, new RegExp(runIdA + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0"));
    assert.doesNotMatch(evidenceA.final_message, new RegExp(runIdB));
    assert.deepEqual(evidenceA.protocol_failures, []);
    assert.deepEqual(evidenceA.foreign_events_ignored, { spawn: 1, status: 0, result: 1, follow_up: 0, cancel: 0, wake: 1 });

    const inspectB = runDriver(["inspect", "--run-id", runIdB, "--state", state]);
    assert.equal(inspectB.status, 0, inspectB.stderr || inspectB.stdout);
    const evidenceB = JSON.parse(inspectB.stdout).evidence;
    assert.equal(evidenceB.correlation_id, runIdB);
    assert.equal(evidenceB.spawn_calls, 1);
    assert.equal(evidenceB.spawn_job_id, "job-interleaved-b");
    assert.equal(evidenceB.spawn_task, "Task B: touch only src/b.ts.");
    assert.deepEqual(evidenceB.result_job_ids, ["job-interleaved-b"]);
    assert.equal(evidenceB.wake_count, 1);
    assert.equal(evidenceB.result_calls, 1);
    assert.equal(evidenceB.final_outcome, "ready");
    assert.match(evidenceB.final_message, new RegExp(runIdB + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0"));
    assert.doesNotMatch(evidenceB.final_message, new RegExp(runIdA));
    assert.deepEqual(evidenceB.protocol_failures, []);
    // B's window starts before A's spawn, so it saw and ignored A's events too.
    assert.deepEqual(evidenceB.foreign_events_ignored, { spawn: 1, status: 0, result: 1, follow_up: 0, cancel: 0, wake: 1 });

    // A WebCodex repair follow-up on run A still validates while B's evidence
    // sits in the same rollout window.
    const follow = runDriver([
      "follow-up", "--run-id", runIdA, "--message", "Repair A only.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--timeout-seconds", "10"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project
    });
    assert.equal(follow.status, 0, follow.stderr || follow.stdout);
    assert.match(follow.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(follow.stdout, /"generation": 1/);
    assert.match(follow.stdout, /"follow_ups": 1/);
    assert.match(follow.stdout, /"results_collected": 2/);
    assert.match(follow.stdout, /"worker_result": "worker repair done"/);

    const inspectAFinal = runDriver(["inspect", "--run-id", runIdA, "--state", state]);
    assert.equal(inspectAFinal.status, 0, inspectAFinal.stderr || inspectAFinal.stdout);
    const evidenceAFinal = JSON.parse(inspectAFinal.stdout).evidence;
    assert.deepEqual(evidenceAFinal.follow_up_job_ids, ["job-interleaved-a"]);
    assert.deepEqual(evidenceAFinal.result_job_ids, ["job-interleaved-a", "job-interleaved-a"]);
    assert.equal(evidenceAFinal.wake_count, 2);
    assert.equal(evidenceAFinal.final_outcome, "ready");
    assert.match(evidenceAFinal.final_message, new RegExp(runIdA + "-READY-FOR-WEBCODEX-ACCEPTANCE-R1"));
    assert.doesNotMatch(evidenceAFinal.final_message, new RegExp(runIdB));
    assert.deepEqual(evidenceAFinal.protocol_failures, []);
  } finally {
    // On a failed assertion, unblock any fake still waiting on a gate, let the
    // drivers drain, then clean up so the real assertion is not masked by EBUSY.
    for (const name of ["A-spawn-go", "B-spawn-go", "A-finish-go", "B-finish-go"]) {
      try { fs.writeFileSync(path.join(coord, name), ""); } catch { /* best effort */ }
    }
    const drainDeadline = Date.now() + 5000;
    while (children.some((child) => child.exitCode === null) && Date.now() < drainDeadline) sleepSync(50);
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a deadline with the exact inner job known returns resumable pending_inner_job and inspect resolves it without a second dispatch", () => {
  const root = tempRoot("jobquay-run-task-pending-");
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453547";
    const rollout = writeSession(codexHome, thread, project, "7");
    const brief = path.join(root, "brief.json");
    fs.writeFileSync(brief, JSON.stringify({
      objective: "Keep the inner job running past the outer wait.",
      worker_task: "PENDING-SCENARIO: the worker finishes after the outer wait ends.",
      review_contract: ["Inspect the actual diff."],
      external_acceptance: ["WebCodex checks the final diff."]
    }), "utf8");
    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");
    const jobId = "job-pending-1";

    const run = runDriver([
      "run", "--brief", brief, "--cwd", project,
      "--codex-home", codexHome, "--codex", fakeCodex,
      "--state", state, "--timeout-seconds", "2"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "pending",
      FAKE_JOB_ID: jobId
    });
    assert.equal(run.status, 3, run.stderr || run.stdout);
    const runId = queuedRunId(run.stdout);
    const pending = finalJson(run.stdout);
    assert.equal(pending.phase, "pending_inner_job");
    assert.equal(pending.resumable, true);
    assert.equal(pending.job_id, jobId);

    // The pending state is durable, not just printed.
    const metaFile = path.join(root, "runs", runId + ".json");
    assert.equal(pending.run_meta, metaFile);
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    assert.equal(meta.last_phase, "pending_inner_job");
    assert.equal(meta.last_pending.job_id, jobId);
    assert.match(String(meta.last_pending.wait_deadline), /^\d{4}-\d{2}-\d{2}T/);

    // inspect is deterministic while the exact job is still pending.
    const inspectPending = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(inspectPending.status, 0, inspectPending.stderr || inspectPending.stdout);
    const inspectedPending = JSON.parse(inspectPending.stdout);
    assert.equal(inspectedPending.phase, "pending_inner_job");
    assert.equal(inspectedPending.resumable, true);
    assert.equal(inspectedPending.job_id, jobId);
    assert.equal(inspectedPending.ok, false);
    assert.equal(inspectedPending.evidence.final_outcome, null);

    // A follow-up while pending refuses deterministically and queues no turn.
    const followPending = runDriver([
      "follow-up", "--run-id", runId, "--message", "This must not be queued while pending.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--timeout-seconds", "2"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_JOB_ID: jobId
    });
    assert.equal(followPending.status, 3, followPending.stderr || followPending.stdout);
    const refused = finalJson(followPending.stdout);
    assert.equal(refused.phase, "pending_inner_job");
    assert.equal(refused.resumable, true);
    assert.equal(refused.job_id, jobId);
    const rolloutAfterRefusal = fs.readFileSync(rollout, "utf8");
    assert.ok(!rolloutAfterRefusal.includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId), "a pending follow-up must not queue a bridge turn");
    assert.equal(rolloutAfterRefusal.split('"jobquay_spawn"').length - 1, 1, "exactly one spawn must exist");

    // The wake can arrive before Codex collects the result (observed transiently
    // in the real runs). That is still pending, never ready and never failure.
    appendWakeLine(rollout, jobId);
    const inspectWoken = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(inspectWoken.status, 0, inspectWoken.stderr || inspectWoken.stdout);
    const woken = JSON.parse(inspectWoken.stdout);
    assert.equal(woken.phase, "pending_inner_job");
    assert.equal(woken.resumable, true);
    assert.equal(woken.evidence.wake_count, 1);
    assert.equal(woken.evidence.result_calls, 0);

    // Only the real Codex bridge completes the round: result + marker.
    appendResultAndMarker(rollout, runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", jobId, 0, "worker late done");
    const lateInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(lateInspect.status, 0, lateInspect.stderr || lateInspect.stdout);
    const late = JSON.parse(lateInspect.stdout);
    assert.equal(late.phase, "ready_for_external_acceptance");
    assert.equal(late.resumable, false);
    assert.equal(late.job_id, jobId);
    assert.equal(late.results_collected, 1);
    assert.deepEqual((late.evidence as Record<string, unknown>).protocol_failures, []);
    assert.equal(fs.readFileSync(rollout, "utf8").split('"jobquay_spawn"').length - 1, 1, "recovery must not dispatch a second job");

    // A repair follow-up is valid again only after the bridge reported ready.
    const follow = runDriver([
      "follow-up", "--run-id", runId, "--message", "Repair the one concrete defect.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--timeout-seconds", "5"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_JOB_ID: jobId
    });
    assert.equal(follow.status, 0, follow.stderr || follow.stdout);
    assert.match(follow.stdout, /"phase": "ready_for_external_acceptance"/);
    assert.match(follow.stdout, /"generation": 1/);
    assert.match(follow.stdout, /"follow_ups": 1/);
    assert.match(follow.stdout, /"results_collected": 2/);
    assert.match(follow.stdout, /"worker_result": "worker repair done"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 run metadata resolves the same pending_inner_job phase and later completion", () => {
  const root = tempRoot("jobquay-run-task-legacy-pending-");
  try {
    const state = path.join(root, "state.json");
    const runsDir = path.join(root, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453548";
    const runId = "JQRUN-20261001000000-legacy1";
    const jobId = "job-legacy-pending-1";
    const workerTask = "LEGACY-PENDING: keep the exact same task string.";
    const rollout = path.join(root, "rollout.jsonl");
    fs.writeFileSync(rollout, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "JOBQUAY WEBCODEX RUN " + runId + "\nlegacy v2 bridge prompt" }]
      }
    }) + "\n", "utf8");
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId });
    fs.writeFileSync(path.join(runsDir, runId + ".json"), JSON.stringify({
      version: 2,
      run_id: runId,
      created_at: "2026-10-01T00:00:00.000Z",
      thread_id: thread,
      rollout,
      start_offset: 0,
      binding_method: "binding",
      cwd: project,
      provider: "command-code",
      model: null,
      worker_task: workerTask,
      objective: "legacy pending",
      max_followups: 2,
      bridge_round: 0,
      ready_marker: runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0",
      attention_marker: runId + "-CODEX-BRIDGE-NEEDS-ATTENTION-R0"
    }, null, 2) + "\n", "utf8");

    const pendingInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(pendingInspect.status, 0, pendingInspect.stderr || pendingInspect.stdout);
    const pending = JSON.parse(pendingInspect.stdout);
    assert.equal(pending.phase, "pending_inner_job");
    assert.equal(pending.resumable, true);
    assert.equal(pending.job_id, jobId);

    appendLateTerminalSequence(rollout, runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", jobId, 0, "legacy worker done");
    const readyInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(readyInspect.status, 0, readyInspect.stderr || readyInspect.stdout);
    const ready = JSON.parse(readyInspect.stdout);
    assert.equal(ready.phase, "ready_for_external_acceptance");
    assert.equal(ready.job_id, jobId);
    assert.equal(ready.results_collected, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 completed run stays stable when unrelated future runs are appended", () => {
  const root = tempRoot("jobquay-run-task-legacy-stable-");
  try {
    const state = path.join(root, "state.json");
    const runsDir = path.join(root, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453550";
    const runId = "JQRUN-20261001000000-legacyA";
    const jobId = "job-legacy-a-1";
    const workerTask = "LEGACY A: keep the exact same task string.";
    const rollout = path.join(root, "rollout.jsonl");
    appendPromptLine(rollout, runId);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId });
    appendWakeLine(rollout, jobId);
    appendResultAndMarker(rollout, runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", jobId, 0, "legacy a done");
    writeLegacyRunMeta(runsDir, { runId, rollout, project, thread, workerTask });

    const baselineInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(baselineInspect.status, 0, baselineInspect.stderr || baselineInspect.stdout);
    const baseline = JSON.parse(baselineInspect.stdout);
    assert.equal(baseline.phase, "ready_for_external_acceptance");
    assert.equal(baseline.job_id, jobId);
    assert.equal(baseline.results_collected, 1);
    assert.equal(baseline.status, "done");
    assert.equal(baseline.evidence.spawn_calls, 1);
    assert.equal(baseline.evidence.wake_count, 1);
    assert.deepEqual(baseline.evidence.result_job_ids, [jobId]);
    assert.deepEqual(baseline.evidence.protocol_failures, []);
    assert.deepEqual(baseline.evidence.foreign_events_ignored, { spawn: 0, status: 0, result: 0, follow_up: 0, cancel: 0, wake: 0 });

    for (const suffix of ["B", "C"]) {
      appendUnrelatedFutureRun(rollout, {
        runId: "JQRUN-20261001000000-legacy" + suffix,
        jobId: "job-legacy-" + suffix.toLowerCase() + "-1",
        project,
        thread,
        task: "LEGACY " + suffix + ": unrelated future work."
      });
    }

    const afterInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(afterInspect.status, 0, afterInspect.stderr || afterInspect.stdout);
    const after = JSON.parse(afterInspect.stdout);
    assert.equal(after.phase, "ready_for_external_acceptance");
    assert.equal(after.ok, true);
    assert.equal(after.job_id, jobId);
    assert.equal(after.results_collected, 1);
    assert.equal(after.evidence.spawn_calls, 1);
    assert.equal(after.evidence.wake_count, 1);
    assert.deepEqual(after.evidence.result_job_ids, [jobId]);
    assert.deepEqual(after.evidence.protocol_failures, []);
    assert.deepEqual(after.evidence.foreign_events_ignored, { spawn: 0, status: 0, result: 0, follow_up: 0, cancel: 0, wake: 0 });

    appendUnrelatedFutureRun(rollout, {
      runId: "JQRUN-20261001000000-legacyD",
      jobId: "job-legacy-d-1",
      project,
      thread,
      task: "LEGACY D: more unrelated future work."
    });
    const repeatInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(repeatInspect.status, 0, repeatInspect.stderr || repeatInspect.stdout);
    const repeated = JSON.parse(repeatInspect.stdout);
    assert.equal(repeated.phase, "ready_for_external_acceptance");
    assert.equal(repeated.job_id, jobId);
    assert.equal(repeated.results_collected, 1);
    assert.equal(repeated.evidence.spawn_calls, 1);
    assert.deepEqual(repeated.evidence.foreign_events_ignored, { spawn: 0, status: 0, result: 0, follow_up: 0, cancel: 0, wake: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 follow-up queues the original exact job id with later runs present", () => {
  const root = tempRoot("jobquay-run-task-legacy-followup-");
  try {
    const state = path.join(root, "state.json");
    const runsDir = path.join(root, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453551";
    const runId = "JQRUN-20261001000000-legacyF";
    const jobId = "job-legacy-f-1";
    const workerTask = "LEGACY F: keep the exact same task string.";
    const rollout = path.join(root, "rollout.jsonl");
    appendPromptLine(rollout, runId);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId });
    appendWakeLine(rollout, jobId);
    appendResultAndMarker(rollout, runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", jobId, 0, "legacy f done");
    appendUnrelatedFutureRun(rollout, {
      runId: "JQRUN-20261001000000-legacyG",
      jobId: "job-legacy-g-1",
      project,
      thread,
      task: "LEGACY G: a later unrelated run."
    });
    writeLegacyRunMeta(runsDir, { runId, rollout, project, thread, workerTask });

    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");
    const follow = runDriver([
      "follow-up", "--run-id", runId, "--message", "Repair only the legacy defect.",
      "--codex", fakeCodex, "--state", state, "--timeout-seconds", "5"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project
    });
    assert.equal(follow.status, 0, follow.stderr || follow.stdout);
    const followed = finalJson(follow.stdout);
    assert.equal(followed.phase, "ready_for_external_acceptance");
    assert.equal(followed.job_id, jobId);
    assert.equal(followed.generation, 1);
    assert.equal(followed.follow_ups, 1);
    assert.equal(followed.results_collected, 2);

    const lines = fs.readFileSync(rollout, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const followPrompt = lines.find((line) =>
      line?.payload?.type === "message" && line.payload.role === "user" &&
      String(line.payload.content?.[0]?.text ?? "").includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId));
    assert.ok(followPrompt, "the follow-up bridge prompt must be queued on the same thread");
    const promptText = String(followPrompt.payload.content[0].text);
    const idLine = promptText.split(/\r?\n/).find((line) => line.startsWith("JOB_ID_JSON="));
    assert.ok(idLine, "follow-up prompt must carry JOB_ID_JSON");
    assert.equal(JSON.parse(idLine.slice("JOB_ID_JSON=".length)), jobId);
    const followCall = lines.find((line) => line?.payload?.item?.tool === "jobquay_follow_up");
    assert.ok(followCall, "the bridge must call jobquay_follow_up");
    assert.equal(followCall.payload.item.arguments.id, jobId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 incomplete run stays honestly pending under later unrelated activity", () => {
  const root = tempRoot("jobquay-run-task-legacy-incomplete-");
  try {
    const state = path.join(root, "state.json");
    const runsDir = path.join(root, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453552";
    const runId = "JQRUN-20261001000000-legacyP";
    const jobId = "job-legacy-p-1";
    const workerTask = "LEGACY P: this run has not finished yet.";
    const rollout = path.join(root, "rollout.jsonl");
    appendPromptLine(rollout, runId);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId });
    appendUnrelatedFutureRun(rollout, {
      runId: "JQRUN-20261001000000-legacyQ",
      jobId: "job-legacy-q-1",
      project,
      thread,
      task: "LEGACY Q: a later unrelated run that did finish."
    });
    writeLegacyRunMeta(runsDir, { runId, rollout, project, thread, workerTask });

    const firstInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(firstInspect.status, 0, firstInspect.stderr || firstInspect.stdout);
    const first = JSON.parse(firstInspect.stdout);
    assert.equal(first.phase, "pending_inner_job");
    assert.equal(first.ok, false);
    assert.equal(first.resumable, true);
    assert.equal(first.job_id, jobId);
    assert.equal(first.evidence.final_outcome, null);
    assert.equal(first.evidence.spawn_calls, 1);
    assert.deepEqual(first.evidence.result_job_ids, []);

    appendUnrelatedFutureRun(rollout, {
      runId: "JQRUN-20261001000000-legacyR",
      jobId: "job-legacy-r-1",
      project,
      thread,
      task: "LEGACY R: even more unrelated activity."
    });
    const secondInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(secondInspect.status, 0, secondInspect.stderr || secondInspect.stdout);
    const second = JSON.parse(secondInspect.stdout);
    assert.equal(second.phase, "pending_inner_job");
    assert.equal(second.job_id, jobId);
    assert.equal(second.evidence.final_outcome, null);
    assert.equal(second.evidence.spawn_calls, 1);
    assert.deepEqual(second.evidence.result_job_ids, []);

    const follow = runDriver([
      "follow-up", "--run-id", runId, "--message", "This must not be queued while pending.",
      "--codex", path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs"),
      "--state", state, "--timeout-seconds", "2"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_JOB_ID: jobId
    });
    assert.equal(follow.status, 3, follow.stderr || follow.stdout);
    const refused = finalJson(follow.stdout);
    assert.equal(refused.phase, "pending_inner_job");
    assert.equal(refused.job_id, jobId);
    assert.ok(!fs.readFileSync(rollout, "utf8").includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId), "a pending legacy follow-up must not queue a bridge turn");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy v2 ambiguous duplicate worker_task reports legacy_limited and never guesses", () => {
  const root = tempRoot("jobquay-run-task-legacy-ambiguous-");
  try {
    const state = path.join(root, "state.json");
    const runsDir = path.join(root, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453553";
    const runId = "JQRUN-20261001000000-legacyX";
    const workerTask = "LEGACY X: a replayed task string with two matching spawns.";
    const rollout = path.join(root, "rollout.jsonl");
    appendPromptLine(rollout, runId);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId: "job-legacy-x-1" });
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId: "job-legacy-x-2" });
    writeLegacyRunMeta(runsDir, { runId, rollout, project, thread, workerTask });

    const inspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout);
    assert.equal(inspected.phase, "legacy_limited");
    assert.equal(inspected.ok, false);
    assert.equal(inspected.resumable, false);
    assert.equal(inspected.job_id, null);
    assert.match(String(inspected.message), /legacy_limited|correlation/i);
    assert.equal(inspected.evidence.attribution, "legacy_limited");
    assert.match(String(inspected.evidence.legacy_limit), /worker_task/);
    assert.deepEqual(inspected.evidence.protocol_failures, []);

    const follow = runDriver([
      "follow-up", "--run-id", runId, "--message", "This must never target a guessed job.",
      "--codex", path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs"),
      "--state", state, "--timeout-seconds", "2"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project
    });
    assert.equal(follow.status, 2, follow.stderr || follow.stdout);
    const refused = finalJson(follow.stdout);
    assert.equal(refused.phase, "legacy_limited");
    assert.ok(!fs.readFileSync(rollout, "utf8").includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId), "an unreconstructible legacy follow-up must queue nothing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a queue exit 0 with no observed prompt returns bounded queue_not_observed and never dispatches", () => {
  const root = tempRoot("jobquay-run-task-queue-silent-");
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453554";
    const rollout = writeSession(codexHome, thread, project, "8");
    const brief = path.join(root, "brief.json");
    const workerTask = "QUEUE-SILENT: this worker task is never passed to a spawn.";
    fs.writeFileSync(brief, JSON.stringify({
      objective: "Prove an accepted queue turn that never reaches the rollout is classified honestly.",
      worker_task: workerTask,
      review_contract: ["Inspect the actual diff."],
      external_acceptance: ["WebCodex checks the final diff."]
    }), "utf8");
    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");

    const started = Date.now();
    const run = runDriver([
      "run", "--brief", brief, "--cwd", project,
      "--codex-home", codexHome, "--codex", fakeCodex,
      "--state", state, "--timeout-seconds", "60", "--queue-observe-seconds", "1"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "silent"
    });
    const elapsed = Date.now() - started;
    assert.equal(run.status, 3, run.stderr || run.stdout);
    const body = finalJson(run.stdout);
    assert.equal(body.phase, "queue_not_observed");
    assert.equal(body.ok, false);
    assert.equal(body.resumable, true);
    assert.equal(body.round, 0);
    assert.ok(elapsed < 20000, `queue_not_observed must be bounded well below the 60s inner-job deadline (took ${elapsed}ms)`);
    const queueEvidence = body.evidence as Record<string, unknown>;
    assert.equal(queueEvidence.round_prompt_seen, false);
    assert.equal(queueEvidence.spawn_calls, 0);
    assert.equal(queueEvidence.result_calls, 0);
    const queueObservation = body.queue_observation as Record<string, unknown>;
    assert.equal(queueObservation.rollout_unchanged_since_start, true);

    const runId = queuedRunId(run.stdout);
    const metaFile = path.join(root, "runs", runId + ".json");
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    assert.equal(meta.last_phase, "queue_not_observed");
    assert.equal(meta.last_queue_observation.marker, meta.ready_marker);
    assert.equal(meta.last_queue_observation.rollout_unchanged_since_start, true);

    const rolloutText = fs.readFileSync(rollout, "utf8");
    assert.ok(!rolloutText.includes("jobquay_spawn"), "an unobserved queue turn must dispatch no CrewDispatch spawn");
    assert.ok(!rolloutText.includes("JOBQUAY WEBCODEX RUN"), "the silent queue fixture must append no prompt");

    // Durable inspect classification while the exact prompt is still unobserved.
    const inspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const inspected = JSON.parse(inspect.stdout);
    assert.equal(inspected.phase, "queue_not_observed");
    assert.equal(inspected.ok, false);
    assert.equal(inspected.resumable, true);
    assert.equal(inspected.job_id, null);

    // A follow-up must refuse to queue anything while the accepted turn is
    // still undelivered (it remains in Codex's durable queue).
    const followRefused = runDriver([
      "follow-up", "--run-id", runId, "--message", "This repair must not be queued.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--queue-observe-seconds", "1"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "silent"
    });
    assert.equal(followRefused.status, 3, followRefused.stderr || followRefused.stdout);
    const refused = finalJson(followRefused.stdout);
    assert.equal(refused.phase, "queue_not_observed");
    assert.match(String(refused.message), /Nothing was queued/);
    assert.ok(!fs.readFileSync(rollout, "utf8").includes("JOBQUAY WEBCODEX FOLLOW-UP"), "a refused follow-up must queue no bridge turn");

    // Late delivery of the SAME accepted turn resolves the same run with no new
    // dispatch and no replacement CrewDispatch job.
    const jobId = "job-queue-late-1";
    appendBridgePromptLine(rollout, runId, meta);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId, clientRunId: runId });
    appendWakeLine(rollout, jobId);
    appendResultAndMarker(rollout, runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0", jobId, 0, "late worker done");

    const lateInspect = runDriver(["inspect", "--run-id", runId, "--state", state]);
    assert.equal(lateInspect.status, 0, lateInspect.stderr || lateInspect.stdout);
    const late = JSON.parse(lateInspect.stdout);
    assert.equal(late.phase, "ready_for_external_acceptance");
    assert.equal(late.ok, true);
    assert.equal(late.job_id, jobId);
    assert.equal(late.results_collected, 1);
    assert.equal(late.queue_observation, undefined);
    assert.equal(fs.readFileSync(rollout, "utf8").split('"jobquay_spawn"').length - 1, 1, "late delivery must not create a second dispatch");

    // A repair round is valid again, but its own silent queue turn must be
    // reported for that round and must not be retried into a duplicate.
    const followSilent = runDriver([
      "follow-up", "--run-id", runId, "--message", "Repair the one concrete defect.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--queue-observe-seconds", "1"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "silent"
    });
    assert.equal(followSilent.status, 3, followSilent.stderr || followSilent.stdout);
    const followBody = finalJson(followSilent.stdout);
    assert.equal(followBody.phase, "queue_not_observed");
    assert.equal(followBody.bridge_round, 1);
    assert.equal(followBody.job_id, jobId);
    assert.match(String(followBody.message), /round-1 follow-up prompt/);
    assert.ok(!fs.readFileSync(rollout, "utf8").includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId), "the silent fixture appended no follow-up prompt");

    // The latest queued round is the unobserved one, so inspect reports that
    // round rather than the earlier ready state.
    const inspectRound1 = JSON.parse(runDriver(["inspect", "--run-id", runId, "--state", state]).stdout);
    assert.equal(inspectRound1.phase, "queue_not_observed");
    assert.equal(inspectRound1.job_id, jobId);

    const followAgain = runDriver([
      "follow-up", "--run-id", runId, "--message", "A duplicate repair attempt.",
      "--codex-home", codexHome, "--codex", fakeCodex, "--state", state, "--queue-observe-seconds", "1"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "silent"
    });
    assert.equal(followAgain.status, 3, followAgain.stderr || followAgain.stdout);
    const again = finalJson(followAgain.stdout);
    assert.equal(again.phase, "queue_not_observed");
    assert.match(String(again.message), /Nothing was queued/);
    assert.ok(!fs.readFileSync(rollout, "utf8").includes("JOBQUAY WEBCODEX FOLLOW-UP " + runId));

    // Late round-1 delivery still completes on the SAME job without a spawn.
    const followMeta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    appendBridgePromptLine(rollout, runId, followMeta, "FOLLOW-UP");
    appendFollowUpCallLine(rollout, jobId, 1);
    appendWakeLine(rollout, jobId);
    appendResultAndMarker(rollout, followMeta.ready_marker, jobId, 1, "round one repair done");

    const finalInspect = JSON.parse(runDriver(["inspect", "--run-id", runId, "--state", state]).stdout);
    assert.equal(finalInspect.phase, "ready_for_external_acceptance");
    assert.equal(finalInspect.job_id, jobId);
    assert.equal(finalInspect.generation, 1);
    assert.equal(finalInspect.follow_ups, 1);
    assert.equal(finalInspect.results_collected, 2);
    assert.equal(fs.readFileSync(rollout, "utf8").split('"jobquay_spawn"').length - 1, 1, "the repair round must not spawn a second job");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a prompt delivered inside the queue-observation window proceeds normally", async () => {
  const root = tempRoot("jobquay-run-task-queue-delayed-");
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const codexHome = path.join(root, "codex");
    const state = path.join(root, "state.json");
    const project = path.join(root, "project");
    fs.mkdirSync(project, { recursive: true });
    const thread = "01a0e0ca-c6d7-75e3-83c7-f73d3a453555";
    const rollout = writeSession(codexHome, thread, project, "9");
    const brief = path.join(root, "brief.json");
    const workerTask = "QUEUE-DELAYED: deliver this inside the observation window.";
    fs.writeFileSync(brief, JSON.stringify({
      objective: "Prove a delayed delivery inside the window is still accepted.",
      worker_task: workerTask,
      review_contract: ["Inspect the actual diff."],
      external_acceptance: ["WebCodex checks the final diff."]
    }), "utf8");
    const fakeCodex = path.join(REPO_ROOT, "src", "tests", "fixtures", "fake-codex-reviewer.cjs");

    const run = spawnDriver([
      "run", "--brief", brief, "--cwd", project,
      "--codex-home", codexHome, "--codex", fakeCodex,
      "--state", state, "--timeout-seconds", "30", "--queue-observe-seconds", "15"
    ], {
      FAKE_ROLLOUT: rollout,
      FAKE_PROJECT: project,
      FAKE_SCENARIO: "silent"
    });
    child = run.child;

    const runsDir = path.join(root, "runs");
    const metaDeadline = Date.now() + 20000;
    let metaFile: string | null = null;
    while (Date.now() < metaDeadline) {
      const files = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((name) => name.endsWith(".json")) : [];
      const first = files[0];
      if (first) { metaFile = path.join(runsDir, first); break; }
      sleepSync(50);
    }
    assert.ok(metaFile, "the run meta must appear before the queue call returns");
    const meta = JSON.parse(fs.readFileSync(metaFile as string, "utf8"));

    // Let the queue call return and the driver enter its observation loop, then
    // deliver the exact prompt well inside the 15s window.
    sleepSync(750);
    const jobId = "job-queue-delayed-1";
    appendBridgePromptLine(rollout, meta.run_id, meta);
    appendSpawnLine(rollout, { task: workerTask, cwd: project, thread, jobId, clientRunId: meta.run_id });
    appendWakeLine(rollout, jobId);
    appendResultAndMarker(rollout, meta.ready_marker, jobId, 0, "delayed worker done");

    const done = await run.done;
    assert.equal(done.status, 0, done.stderr || done.stdout);
    const body = finalJson(done.stdout);
    assert.equal(body.phase, "ready_for_external_acceptance");
    assert.equal(body.job_id, jobId);
    assert.equal(body.results_collected, 1);
    const finalMeta = JSON.parse(fs.readFileSync(metaFile as string, "utf8"));
    assert.equal(finalMeta.last_queue_observation, undefined, "an observed prompt must not persist a queue_not_observed state");
  } finally {
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
