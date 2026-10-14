"use strict";
// Fake Codex Desktop bridge used by the run-task driver tests. It appends
// rollout lines exactly like the real bridge: the queued prompt as a user
// message, then the JobQuay MCP tool calls and the round-specific READY marker.
//
// Env:
//   FAKE_ROLLOUT / FAKE_PROJECT      target rollout + project cwd (required)
//   FAKE_JOB_ID                      job id this bridge "spawns" (default job-fake-review-1)
//   FAKE_SCENARIO=interleaved        coordinated two-run mode (see below)
//   FAKE_SCENARIO=pending            real "inner job still running" mode: append prompt +
//                                    spawn, then stop without wake/result/marker. The test
//                                    appends the late terminal sequence itself.
//   FAKE_ROLE=A|B + FAKE_COORD_DIR   role and gate directory for interleaved mode
//
// Interleaved mode lets a test interleave two runs on one thread
// deterministically: each role appends its prompt, then waits for
// "<role>-spawn-go" before appending its spawn, then waits for
// "<role>-finish-go" before appending its wake/result/marker. The role touches
// "<role>-prompted" / "<role>-spawned" so the test can order the two drivers.
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
if (args[0] !== "queue") {
  process.stderr.write("expected queue\n");
  process.exitCode = 4;
  return;
}
const thread = args[args.indexOf("--thread") + 1];
const prompt = args[args.indexOf("--message") + 1];
const rollout = process.env.FAKE_ROLLOUT;
const cwd = process.env.FAKE_PROJECT;
if (!rollout || !cwd) throw new Error("fake reviewer env missing");

const runMatch = /JOBQUAY WEBCODEX (?:RUN|FOLLOW-UP) (JQRUN-[^\s]+)/.exec(prompt);
if (!runMatch) throw new Error("run id missing");
const runId = runMatch[1];
const readyLine = prompt.split(/\r?\n/).find((line) => line.startsWith("READY_MARKER="));
if (!readyLine) throw new Error("ready marker missing");
const ready = readyLine.slice("READY_MARKER=".length);
if (/review the actual workspace|review contract is your acceptance checklist|Inspect relevant files\/diffs/i.test(prompt)) {
  throw new Error("bridge prompt must not ask Codex to review");
}
const job = process.env.FAKE_JOB_ID || "job-fake-review-1";

// FAKE_SCENARIO=silent: accept the queue call (exit 0) but append nothing to
// the rollout, emulating a message accepted by `codex queue` for a closed or
// inactive Codex session that never receives it.
if (process.env.FAKE_SCENARIO === "silent") {
  process.stdout.write("queued\n");
  return;
}

const line = (prefix) => prompt.split(/\r?\n/).find((item) => item.startsWith(prefix));
const append = (obj) => fs.appendFileSync(rollout, JSON.stringify(obj) + "\n", "utf8");
const mcpItem = (tool, callArgs, body) => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: {
      type: "McpToolCall",
      server: "jobquay",
      tool,
      arguments: callArgs,
      result: { content: [{ type: "text", text: JSON.stringify(body) }] }
    }
  }
});
const wakeItem = (id) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "JobQuay job " + id + " finished with status done." }] }
});
const markerItem = (text) => ({
  type: "event_msg",
  payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "text", text }] } }
});
const clientRunId = () => {
  const clientLine = line("CLIENT_RUN_ID=");
  return clientLine ? JSON.parse(clientLine.slice("CLIENT_RUN_ID=".length)) : null;
};
const spawnItem = (workerTask, correlationId) => mcpItem(
  "jobquay_spawn",
  {
    task: workerTask,
    cwd,
    codex_thread_id: thread,
    provider: "command-code",
    ...(correlationId ? { client_run_id: correlationId } : {})
  },
  { ok: true, accepted: true, job_id: job, status: "queued", notify: { kind: "codex_thread", source: "codex_thread_id" } }
);
const resultItem = (id, generation, finalText) => mcpItem(
  "jobquay_result",
  { id },
  { ok: true, job_id: id, status: "done", generation, result: { final_text: finalText } }
);

append({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } });

if (prompt.includes("JOBQUAY WEBCODEX FOLLOW-UP")) {
  const idLine = line("JOB_ID_JSON=");
  const messageLine = line("FOLLOW_UP_MESSAGE_JSON=");
  if (!idLine || !messageLine) throw new Error("follow-up payload missing");
  const id = JSON.parse(idLine.slice("JOB_ID_JSON=".length));
  const message = JSON.parse(messageLine.slice("FOLLOW_UP_MESSAGE_JSON=".length));
  append(mcpItem("jobquay_follow_up", { id, message }, { ok: true, job_id: id, generation: 1, status: "queued" }));
  append(wakeItem(id));
  append(resultItem(id, 1, "worker repair done"));
  append(markerItem(ready + "\nJob " + id + " generation 1 terminal done."));
  process.stdout.write("queued follow-up\n");
  return;
}

if (process.env.FAKE_SCENARIO === "pending") {
  const taskLine = line("WORKER_TASK_JSON=");
  if (!taskLine) throw new Error("worker task missing");
  const workerTask = JSON.parse(taskLine.slice("WORKER_TASK_JSON=".length));
  append(spawnItem(workerTask, clientRunId()));
  process.stdout.write("queued\n");
  return;
}

if (process.env.FAKE_SCENARIO === "interleaved") {
  const role = process.env.FAKE_ROLE;
  const coordDir = process.env.FAKE_COORD_DIR;
  if (!role || !coordDir) throw new Error("interleaved scenario needs FAKE_ROLE and FAKE_COORD_DIR");
  const gate = (name) => path.join(coordDir, name);
  const touch = (name) => fs.writeFileSync(gate(name), "", "utf8");
  const waitFor = (name) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (fs.existsSync(gate(name))) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    throw new Error("interleaved gate timed out: " + name);
  };
  const taskLine = line("WORKER_TASK_JSON=");
  if (!taskLine) throw new Error("worker task missing");
  const workerTask = JSON.parse(taskLine.slice("WORKER_TASK_JSON=".length));
  const correlationId = clientRunId();
  if (!correlationId) throw new Error("client run id missing");
  touch(role + "-prompted");
  waitFor(role + "-spawn-go");
  append(spawnItem(workerTask, correlationId));
  touch(role + "-spawned");
  waitFor(role + "-finish-go");
  append(wakeItem(job));
  append(resultItem(job, 0, "worker says done"));
  append(markerItem(ready + "\nJob " + job + " generation 0 terminal done."));
  process.stdout.write("queued\n");
  return;
}

const taskLine = line("WORKER_TASK_JSON=");
if (!taskLine) throw new Error("worker task missing");
const workerTask = JSON.parse(taskLine.slice("WORKER_TASK_JSON=".length));
append(spawnItem(workerTask, clientRunId()));
append(wakeItem(job));
append(resultItem(job, 0, "worker says done"));
append(markerItem(ready + "\nJob " + job + " generation 0 terminal done."));
process.stdout.write("queued\n");
