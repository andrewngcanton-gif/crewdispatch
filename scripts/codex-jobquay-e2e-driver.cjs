#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function usage() {
  process.stdout.write([
    "External Codex -> CrewDispatch E2E driver",
    "",
    "This driver talks ONLY to Codex (codex queue) and reads Codex's rollout.",
    "Codex itself must call CrewDispatch. The driver never calls CrewDispatch MCP tools.",
    "",
    "Usage:",
    "  node scripts/codex-jobquay-e2e-driver.cjs run --thread <uuid> [--provider command-code|workbuddy-ai] [--model <id>] [--cwd <abs>] [--timeout-seconds <n>] [--codex <exe>]",
    "  node scripts/codex-jobquay-e2e-driver.cjs inspect --thread <uuid> --run-id <id> [--codex-home <abs>]",
    "",
    "run queues one uniquely-marked instruction into an EXISTING Codex session, then",
    "observes only that session rollout. Codex must already be able to process queued",
    "messages (for example the Codex Desktop session is open/active).",
    "",
    "Default run intentionally omits model so CrewDispatch must use its configured default."
  ].join("\n") + "\n");
}

function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) throw new Error("missing value for --" + key);
    values.set(key, next);
    i += 1;
  }
  return { positional, values };
}

function required(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error("missing --" + key);
  return value.trim();
}

function numberOption(values, key, fallback) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid --" + key + ": " + raw);
  return value;
}

function assertThreadId(thread) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)) {
    throw new Error("--thread must be a Codex session UUID");
  }
}

function resolveCodexHome(values) {
  const explicit = values.get("codex-home");
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("--codex-home must be absolute");
    return path.resolve(explicit);
  }
  if (process.env.CODEX_HOME && path.isAbsolute(process.env.CODEX_HOME)) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), ".codex");
}

function findNewestCodexExe(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(root, entry.name, "codex.exe");
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { return null; }
      return { full, mtime };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.full ?? null;
}

function resolveCodexExe(values, codexHome) {
  const explicit = values.get("codex");
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error("--codex does not exist: " + resolved);
    return resolved;
  }
  if (process.env.CODEX_CLI_PATH) {
    const resolved = path.resolve(process.env.CODEX_CLI_PATH);
    if (fs.existsSync(resolved)) return resolved;
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const found = findNewestCodexExe(path.join(local, "OpenAI", "Codex", "bin"));
      if (found) return found;
    }
    const sandbox = path.join(codexHome, ".sandbox-bin", "codex.exe");
    if (fs.existsSync(sandbox)) return sandbox;
  }
  return "codex";
}

function walkForRollout(dir, suffix, found) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForRollout(full, suffix, found);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      found.push(full);
    }
  }
}

function findRollout(codexHome, thread) {
  const found = [];
  walkForRollout(path.join(codexHome, "sessions"), thread + ".jsonl", found);
  walkForRollout(path.join(codexHome, "archived_sessions"), thread + ".jsonl", found);
  if (!found.length) return null;
  found.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return found[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseResultText(item) {
  const blocks = item?.result?.content;
  if (!Array.isArray(blocks)) return null;
  const textBlock = blocks.find((block) => block && block.type === "text" && typeof block.text === "string");
  if (!textBlock) return null;
  try { return JSON.parse(textBlock.text); } catch { return null; }
}

function textParts(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => part && (part.text ?? part.input_text ?? part.output_text))
    .filter((value) => typeof value === "string");
}

function newEvidence(runId, thread, rollout) {
  return {
    ok: false,
    run_id: runId,
    thread_id: thread,
    rollout,
    initial_prompt_seen: false,
    spawn_calls: 0,
    status_calls: 0,
    result_calls: 0,
    spawn_job_id: null,
    spawn_provider: null,
    spawn_cwd: null,
    spawn_codex_thread_id: null,
    spawn_model_supplied: null,
    spawn_model: null,
    spawn_notify_kind: null,
    spawn_notify_source: null,
    wake_count: 0,
    wake_job_id: null,
    wake_status: null,
    result_job_id: null,
    result_status: null,
    result_model: null,
    result_model_source: null,
    result_notify_kind: null,
    result_notify_attempted: null,
    result_notify_delivered: null,
    result_notify_reason: null,
    worker_final_text: null,
    final_marker_seen: false,
    failures: []
  };
}

function applyLine(evidence, obj, runId, workerMarker, finalMarker) {
  const payload = obj?.payload;
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "message") {
    const joined = textParts(payload).join("\n");
    if (payload.role === "user" && joined.includes(runId)) evidence.initial_prompt_seen = true;
    if (payload.role === "user") {
      const wake = joined.match(/(?:CrewDispatch|JobQuay) job (job-[A-Za-z0-9_-]+) finished with status ([A-Za-z0-9_-]+)/);
      if (wake) {
        evidence.wake_count += 1;
        evidence.wake_job_id = wake[1];
        evidence.wake_status = wake[2];
      }
    }
    if (payload.role === "assistant" && joined.includes(finalMarker)) evidence.final_marker_seen = true;
  }

  if (payload.type === "item_completed") {
    const item = payload.item;
    if (item?.type === "UserMessage") {
      const joined = Array.isArray(item.content) ? item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n") : "";
      if (joined.includes(runId)) evidence.initial_prompt_seen = true;
      const wake = joined.match(/(?:CrewDispatch|JobQuay) job (job-[A-Za-z0-9_-]+) finished with status ([A-Za-z0-9_-]+)/);
      if (wake) {
        // The same logical user message is also emitted as response_item. Count it only once.
        evidence.wake_job_id = wake[1];
        evidence.wake_status = wake[2];
      }
    }
    if (item?.type === "AgentMessage") {
      const joined = Array.isArray(item.content) ? item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n") : "";
      if (joined.includes(finalMarker)) evidence.final_marker_seen = true;
    }
    if (item?.type === "McpToolCall" && ["crewdispatch", "jobquay"].includes(item.server)) {
      if ((item.tool === "crewdispatch_spawn" || item.tool === "jobquay_spawn")) {
        evidence.spawn_calls += 1;
        evidence.spawn_provider = item.arguments?.provider ?? null;
        evidence.spawn_cwd = item.arguments?.cwd ?? null;
        evidence.spawn_codex_thread_id = item.arguments?.codex_thread_id ?? null;
        evidence.spawn_model_supplied = Object.prototype.hasOwnProperty.call(item.arguments || {}, "model");
        evidence.spawn_model = item.arguments?.model ?? null;
        const body = parseResultText(item);
        if (body?.job_id) evidence.spawn_job_id = body.job_id;
        evidence.spawn_notify_kind = body?.notify?.kind ?? null;
        evidence.spawn_notify_source = body?.notify?.source ?? null;
      } else if ((item.tool === "crewdispatch_status" || item.tool === "jobquay_status")) {
        evidence.status_calls += 1;
      } else if ((item.tool === "crewdispatch_result" || item.tool === "jobquay_result")) {
        evidence.result_calls += 1;
        evidence.result_job_id = item.arguments?.id ?? null;
        const body = parseResultText(item);
        if (body) {
          evidence.result_status = body.status ?? null;
          evidence.result_model = body.model ?? null;
          evidence.result_model_source = body.model_source ?? null;
          evidence.result_notify_kind = body.notify?.kind ?? null;
          evidence.result_notify_attempted = body.notify?.attempted ?? null;
          evidence.result_notify_delivered = body.notify?.delivered ?? null;
          evidence.result_notify_reason = body.notify?.reason ?? null;
          evidence.worker_final_text = body.result?.final_text ?? null;
        }
      }
    }
  }
}

function readEvidence(rollout, startOffset, runId, thread, workerMarker, finalMarker) {
  const evidence = newEvidence(runId, thread, rollout);
  const fd = fs.openSync(rollout, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.max(0, stat.size - startOffset);
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(fd, buffer, 0, length, startOffset);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      applyLine(evidence, obj, runId, workerMarker, finalMarker);
    }
  } finally {
    fs.closeSync(fd);
  }
  return evidence;
}

function validateEvidence(evidence, opts) {
  const failures = [];
  if (!evidence.initial_prompt_seen) failures.push("queued prompt was not observed in the Codex rollout");
  if (evidence.spawn_calls !== 1) failures.push("expected exactly one crewdispatch_spawn call, saw " + evidence.spawn_calls);
  if (evidence.status_calls !== 0) failures.push("expected zero crewdispatch_status polling calls, saw " + evidence.status_calls);
  if (evidence.wake_count !== 1) failures.push("expected exactly one CrewDispatch wake user message, saw " + evidence.wake_count);
  if (evidence.result_calls !== 1) failures.push("expected exactly one crewdispatch_result call, saw " + evidence.result_calls);
  if (!evidence.spawn_job_id) failures.push("crewdispatch_spawn did not yield a job id in rollout evidence");
  if (evidence.spawn_job_id && evidence.wake_job_id && evidence.spawn_job_id !== evidence.wake_job_id) {
    failures.push("wake job id did not match spawned job id");
  }
  if (evidence.spawn_job_id && evidence.result_job_id && evidence.spawn_job_id !== evidence.result_job_id) {
    failures.push("result job id did not match spawned job id");
  }
  if (evidence.spawn_provider !== opts.provider) {
    failures.push("spawn provider mismatch: expected " + opts.provider + ", saw " + String(evidence.spawn_provider));
  }
  if (evidence.spawn_cwd == null || path.resolve(evidence.spawn_cwd) !== path.resolve(opts.cwd)) {
    failures.push("spawn cwd mismatch: expected " + opts.cwd + ", saw " + String(evidence.spawn_cwd));
  }
  if (evidence.spawn_codex_thread_id !== opts.thread) {
    failures.push("Codex did not pass its exact thread id to CrewDispatch");
  }
  if (evidence.spawn_notify_kind !== "codex_thread" || evidence.spawn_notify_source !== "codex_thread_id") {
    failures.push("spawn did not persist the explicit Codex thread as the wake target");
  }
  if (opts.model == null) {
    if (evidence.spawn_model_supplied !== false) failures.push("Codex supplied a model even though this run must test CrewDispatch's configured default");
    if (evidence.result_model_source !== "config-default") failures.push("CrewDispatch did not report config-default model source: " + String(evidence.result_model_source));
  } else {
    if (evidence.spawn_model !== opts.model) failures.push("explicit model mismatch: expected " + opts.model + ", saw " + String(evidence.spawn_model));
    if (evidence.result_model !== opts.model) failures.push("result model mismatch: expected " + opts.model + ", saw " + String(evidence.result_model));
    if (evidence.result_model_source !== "explicit") failures.push("explicit model was not reported with model_source=explicit");
  }
  if (evidence.result_notify_kind !== "codex_thread" || evidence.result_notify_attempted !== true || evidence.result_notify_delivered !== true || evidence.result_notify_reason != null) {
    failures.push("CrewDispatch did not report one successful Codex-thread terminal wake");
  }
  if (evidence.worker_final_text !== opts.workerMarker) {
    failures.push("worker final text mismatch: " + String(evidence.worker_final_text));
  }
  if (evidence.result_status !== "done") failures.push("crewdispatch_result status was not done: " + String(evidence.result_status));
  if (!evidence.final_marker_seen) failures.push("Codex final marker was not observed");
  evidence.failures = failures;
  evidence.ok = failures.length === 0;
  return evidence;
}

function buildPrompt({ runId, cwd, provider, model, workerMarker, finalMarker }) {
  const modelInstruction = model
    ? "Explicitly pass model " + JSON.stringify(model) + " to crewdispatch_spawn."
    : "Do NOT pass a model argument to crewdispatch_spawn; this run must exercise CrewDispatch's configured default model.";
  return [
    "JOBQUAY EXTERNAL E2E RUN " + runId + ".",
    "This instruction was queued by an external WebCodex test driver. The driver will not call CrewDispatch for you.",
    "Use the installed CrewDispatch skill/MCP yourself and follow its async flow exactly.",
    "Read CODEX_THREAD_ID once in a local shell and pass it explicitly as codex_thread_id.",
    "Call crewdispatch_spawn exactly once with provider " + JSON.stringify(provider) + " and cwd " + JSON.stringify(cwd) + ".",
    modelInstruction,
    "The worker task must be exactly: " + JSON.stringify("Reply with exactly " + workerMarker + " and nothing else."),
    "After crewdispatch_spawn returns, do not call crewdispatch_status and do not call crewdispatch_result yet. End the turn and wait for CrewDispatch's terminal wake.",
    "When the CrewDispatch wake arrives in this same Codex session, call crewdispatch_result exactly once for that job id.",
    "If and only if the result status is done and result.final_text is exactly " + JSON.stringify(workerMarker) + ", reply with exactly " + finalMarker + " and nothing else.",
    "Otherwise report the mismatch instead of emitting the success marker."
  ].join(" ");
}

async function runCommand(values) {
  const thread = required(values, "thread");
  assertThreadId(thread);
  const cwd = values.get("cwd") ? path.resolve(values.get("cwd")) : process.cwd();
  const provider = values.get("provider") || "command-code";
  if (!["command-code", "workbuddy-ai"].includes(provider)) throw new Error("unsupported --provider: " + provider);
  const model = values.has("model") ? required(values, "model") : null;
  const timeoutSeconds = numberOption(values, "timeout-seconds", 180);
  const codexHome = resolveCodexHome(values);
  const codexExe = resolveCodexExe(values, codexHome);
  const rollout = findRollout(codexHome, thread);
  if (!rollout) throw new Error("could not find rollout for thread " + thread + " under " + codexHome);
  const startOffset = fs.statSync(rollout).size;

  const runId = "JQE2E-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex");
  const workerMarker = runId + "-WORKER-OK";
  const finalMarker = runId + "-CODEX-OK";
  const prompt = buildPrompt({ runId, cwd, provider, model, workerMarker, finalMarker });

  const queued = spawnSync(codexExe, ["queue", "--thread", thread, "--message", prompt], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
  if (queued.error) throw queued.error;
  if (queued.status !== 0) {
    throw new Error("codex queue failed (" + queued.status + "): " + String(queued.stderr || queued.stdout || "").trim());
  }

  process.stdout.write(JSON.stringify({
    phase: "queued",
    run_id: runId,
    thread_id: thread,
    worker_marker: workerMarker,
    final_marker: finalMarker,
    rollout,
    codex_queue: String(queued.stdout || "").trim()
  }) + "\n");

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastEvidence = newEvidence(runId, thread, rollout);
  while (Date.now() < deadline) {
    lastEvidence = readEvidence(rollout, startOffset, runId, thread, workerMarker, finalMarker);
    if (lastEvidence.final_marker_seen || lastEvidence.result_calls > 1 || lastEvidence.status_calls > 0 || lastEvidence.spawn_calls > 1 || lastEvidence.wake_count > 1) break;
    await sleep(1000);
  }
  if (lastEvidence.final_marker_seen) {
    // Allow a short settle window so a duplicate wake/result cannot hide immediately
    // behind the success answer.
    await sleep(1500);
    lastEvidence = readEvidence(rollout, startOffset, runId, thread, workerMarker, finalMarker);
  }
  const finalEvidence = validateEvidence(lastEvidence, { provider, model, workerMarker, finalMarker, cwd, thread });
  process.stdout.write(JSON.stringify({
    phase: finalEvidence.ok ? "passed" : "failed",
    ...finalEvidence,
    worker_marker: workerMarker,
    final_marker: finalMarker
  }, null, 2) + "\n");
  if (!finalEvidence.ok) process.exitCode = 2;
}

function inspectCommand(values) {
  const thread = required(values, "thread");
  assertThreadId(thread);
  const runId = required(values, "run-id");
  const codexHome = resolveCodexHome(values);
  const rollout = findRollout(codexHome, thread);
  if (!rollout) throw new Error("could not find rollout for thread " + thread);
  const workerMarker = runId + "-WORKER-OK";
  const finalMarker = runId + "-CODEX-OK";
  // inspect is intentionally broad: the unique run id prevents earlier history from
  // satisfying the prompt/final-marker assertions, while tool evidence is reported
  // for human diagnosis rather than certified as a fresh run without an offset.
  const evidence = readEvidence(rollout, 0, runId, thread, workerMarker, finalMarker);
  process.stdout.write(JSON.stringify({ phase: "inspection", ...evidence, worker_marker: workerMarker, final_marker: finalMarker }, null, 2) + "\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (!command || command === "help") {
    usage();
    return;
  }
  if (command === "run") {
    await runCommand(parsed.values);
    return;
  }
  if (command === "inspect") {
    inspectCommand(parsed.values);
    return;
  }
  throw new Error("unknown command: " + command);
}

main().catch((error) => {
  process.stderr.write((error?.stack || String(error)) + "\n");
  process.exitCode = 1;
});
