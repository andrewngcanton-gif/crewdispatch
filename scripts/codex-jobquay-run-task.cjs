#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_VERSION = 1;
const RECENT_DISCOVERY_MS = 24 * 60 * 60 * 1000;

function usage() {
  process.stdout.write([
    "WebCodex -> Codex protocol bridge -> CrewDispatch run-task driver",
    "",
    "Commands:",
    "  resolve --cwd <abs> [--thread <uuid>] [--marker <text>] [--codex-home <abs>] [--state <abs>]",
    "  bind    --cwd <abs> [--thread <uuid>] [--marker <text>] [--codex-home <abs>] [--state <abs>]",
    "  unbind  --cwd <abs> [--state <abs>]",
    "  run       --brief <json-file> [--cwd <abs>] [--provider command-code|workbuddy-ai] [--model <id>]",
    "            [--thread <uuid>] [--marker <text>] [--codex-home <abs>] [--codex <exe>]",
    "            [--timeout-seconds <n>] [--max-followups <n>] [--queue-observe-seconds <n>] [--state <abs>]",
    "  follow-up --run-id <id> (--message <text> | --message-file <file>)",
    "            [--codex-home <abs>] [--codex <exe>] [--timeout-seconds <n>] [--queue-observe-seconds <n>] [--state <abs>]",
    "  inspect   --run-id <id> [--state <abs>]",
    "",
    "The brief JSON requires objective, worker_task, and review_contract.",
    "context and external_acceptance are optional. cwd/provider/model may also be supplied in the brief.",
    "",
    "`codex queue` exiting 0 only proves the durable Codex queue accepted the message. The driver",
    "then waits up to --queue-observe-seconds (default 60) for that exact round prompt to appear",
    "in the target rollout; if it never does, the run returns phase queue_not_observed and nothing",
    "is requeued or redispatched automatically.",
    "",
    "Normal use does not require a thread UUID. The driver reuses a persisted project binding,",
    "or auto-binds when exactly one recent Codex Desktop session has the same cwd.",
    "If discovery is ambiguous it refuses to guess and returns a one-time marker that can be",
    "typed into the intended Codex session, then supplied with --marker."
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

function numberOption(values, key, fallback, min = 0) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error("invalid --" + key + ": " + raw);
  return value;
}

function assertThreadId(thread) {
  if (!UUID_RE.test(thread)) throw new Error("invalid Codex thread UUID");
}

function normalizePathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(root, entry.name, "codex.exe");
      try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full ?? null;
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

function resolveDataRoot() {
  if (process.env.CREWDISPATCH_DATA_ROOT?.trim()) {
    return path.resolve(process.env.CREWDISPATCH_DATA_ROOT.trim());
  }
  if (process.env.JOBQUAY_DATA_ROOT && path.isAbsolute(process.env.JOBQUAY_DATA_ROOT)) {
    return path.resolve(process.env.JOBQUAY_DATA_ROOT);
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "JobQuay");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "jobquay");
}

function resolveStatePath(values) {
  const explicit = values.get("state");
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("--state must be absolute");
    return path.resolve(explicit);
  }
  if (process.env.JOBQUAY_EXTERNAL_DRIVER_STATE && path.isAbsolute(process.env.JOBQUAY_EXTERNAL_DRIVER_STATE)) {
    return path.resolve(process.env.JOBQUAY_EXTERNAL_DRIVER_STATE);
  }
  return path.join(resolveDataRoot(), "external-driver", "codex-bindings-v1.json");
}

function emptyState() {
  return { version: STATE_VERSION, projects: {} };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== STATE_VERSION || !parsed.projects || typeof parsed.projects !== "object") return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}

function bindProject(statePath, cwd, session, method) {
  const state = loadState(statePath);
  const key = normalizePathKey(cwd);
  const now = new Date().toISOString();
  state.projects[key] = {
    cwd: path.resolve(cwd),
    thread_id: session.thread,
    rollout: session.rollout,
    reviewer_cwd: session.cwd,
    bound_at: state.projects[key]?.bound_at || now,
    last_used_at: now,
    method
  };
  saveState(statePath, state);
  return state.projects[key];
}

function unbindProject(statePath, cwd) {
  const state = loadState(statePath);
  const key = normalizePathKey(cwd);
  const existed = Object.prototype.hasOwnProperty.call(state.projects, key);
  if (existed) {
    delete state.projects[key];
    saveState(statePath, state);
  }
  return existed;
}

function readFirstLine(file, maxBytes = 2 * 1024 * 1024) {
  const fd = fs.openSync(file, "r");
  try {
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total < maxBytes) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - total), null);
      if (!count) break;
      const chunk = Buffer.from(buffer.subarray(0, count));
      const newline = chunk.indexOf(10);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }
      chunks.push(chunk);
      total += count;
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
  } finally {
    fs.closeSync(fd);
  }
}

function walkJsonl(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

function sessionMeta(file) {
  try {
    const first = JSON.parse(readFirstLine(file));
    if (first?.type !== "session_meta" || !first.payload || typeof first.payload !== "object") return null;
    const payload = first.payload;
    const thread = typeof payload.id === "string" ? payload.id : typeof payload.session_id === "string" ? payload.session_id : null;
    if (!thread || !UUID_RE.test(thread)) return null;
    const stat = fs.statSync(file);
    return {
      thread,
      rollout: file,
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
      originator: typeof payload.originator === "string" ? payload.originator : null,
      source: typeof payload.source === "string" ? payload.source : null,
      thread_source: typeof payload.thread_source === "string" ? payload.thread_source : null,
      mtime_ms: stat.mtimeMs,
      mtime: stat.mtime.toISOString()
    };
  } catch {
    return null;
  }
}

function isDesktopSession(meta) {
  return !!meta && meta.originator === "Codex Desktop" && meta.thread_source !== "exec";
}

function listDesktopSessions(codexHome, includeArchived = false) {
  const files = [];
  walkJsonl(path.join(codexHome, "sessions"), files);
  if (includeArchived) walkJsonl(path.join(codexHome, "archived_sessions"), files);
  return files
    .map(sessionMeta)
    .filter(isDesktopSession)
    .sort((a, b) => b.mtime_ms - a.mtime_ms);
}

function findRollout(codexHome, thread) {
  const sessions = listDesktopSessions(codexHome, true);
  return sessions.find((item) => item.thread === thread) || null;
}

function fileContains(file, marker) {
  try {
    return fs.readFileSync(file, "utf8").includes(marker);
  } catch {
    return false;
  }
}

function bindingMarker() {
  return "JOBQUAY-BIND-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function resolutionFailure(code, cwd, candidates = []) {
  const marker = bindingMarker();
  return {
    ok: false,
    code,
    cwd: path.resolve(cwd),
    marker,
    candidate_count: candidates.length,
    candidates: candidates.slice(0, 8).map((item) => ({
      reviewer_cwd: item.cwd,
      last_modified: item.mtime
    })),
    action: "Type exactly " + marker + " as a user message in the intended Codex Desktop session, then rerun with --marker " + marker + ". No thread UUID is needed."
  };
}

function resolveReviewer(values, cwd) {
  const codexHome = resolveCodexHome(values);
  const statePath = resolveStatePath(values);
  const explicit = values.get("thread");
  if (explicit) {
    assertThreadId(explicit);
    const session = findRollout(codexHome, explicit);
    if (!session) return { ...resolutionFailure("codex_thread_not_found", cwd), codex_home: codexHome, state_path: statePath };
    const binding = bindProject(statePath, cwd, session, "explicit-thread");
    return { ok: true, method: "explicit-thread", session, binding, codexHome, statePath };
  }

  const marker = values.get("marker");
  if (marker) {
    const matches = listDesktopSessions(codexHome, false).filter((item) => fileContains(item.rollout, marker));
    if (matches.length !== 1) {
      return { ...resolutionFailure(matches.length ? "codex_marker_ambiguous" : "codex_marker_not_found", cwd, matches), codex_home: codexHome, state_path: statePath };
    }
    const binding = bindProject(statePath, cwd, matches[0], "marker");
    return { ok: true, method: "marker", session: matches[0], binding, codexHome, statePath };
  }

  const state = loadState(statePath);
  const key = normalizePathKey(cwd);
  const saved = state.projects[key];
  if (saved && typeof saved.thread_id === "string" && UUID_RE.test(saved.thread_id)) {
    const session = findRollout(codexHome, saved.thread_id);
    if (session) {
      const binding = bindProject(statePath, cwd, session, "binding");
      return { ok: true, method: "binding", session, binding, codexHome, statePath };
    }
  }

  const matches = listDesktopSessions(codexHome, false)
    .filter((item) => item.cwd && normalizePathKey(item.cwd) === normalizePathKey(cwd));
  const recent = matches.filter((item) => Date.now() - item.mtime_ms <= RECENT_DISCOVERY_MS);
  const pool = recent.length ? recent : matches;
  if (pool.length !== 1) {
    return { ...resolutionFailure(pool.length ? "codex_thread_ambiguous" : "codex_thread_not_found", cwd, pool), codex_home: codexHome, state_path: statePath };
  }
  const binding = bindProject(statePath, cwd, pool[0], "auto-cwd");
  return { ok: true, method: "auto-cwd", session: pool[0], binding, codexHome, statePath };
}

function asText(value, field, requiredField = false) {
  if (typeof value === "string") {
    const text = value.trim();
    if (text || !requiredField) return text;
  }
  if (Array.isArray(value)) {
    const text = value.filter((item) => typeof item === "string" && item.trim()).map((item) => "- " + item.trim()).join("\n");
    if (text || !requiredField) return text;
  }
  if (requiredField) throw new Error("brief." + field + " must be a non-empty string or string array");
  return "";
}

function readBrief(file) {
  if (!path.isAbsolute(file)) file = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("brief must be a JSON object");
  return {
    path: file,
    objective: asText(raw.objective, "objective", true),
    context: asText(raw.context, "context", false),
    workerTask: asText(raw.worker_task, "worker_task", true),
    reviewContract: asText(raw.review_contract, "review_contract", true),
    externalAcceptance: asText(raw.external_acceptance, "external_acceptance", false),
    cwd: typeof raw.cwd === "string" && raw.cwd.trim() ? path.resolve(raw.cwd) : null,
    provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null
  };
}

function buildRunPrompt({ runId, cwd, provider, model, brief, readyMarker, attentionMarker }) {
  const modelInstruction = model
    ? "Pass model " + JSON.stringify(model) + " to the initial crewdispatch_spawn."
    : "Do not pass a model argument to the initial crewdispatch_spawn; CrewDispatch must choose the configured provider default.";
  return [
    "JOBQUAY WEBCODEX RUN " + runId,
    "You are the protocol bridge between an external WebCodex controller and CrewDispatch. You are NOT the quality reviewer.",
    "Use the installed CrewDispatch skill/MCP. If CrewDispatch tools are unavailable, emit " + attentionMarker + " and explain only the bridge/protocol failure.",
    "Read CODEX_THREAD_ID once in a local no-LLM shell and pass it explicitly as codex_thread_id.",
    "Call crewdispatch_spawn exactly once with provider " + JSON.stringify(provider) + " and cwd " + JSON.stringify(cwd) + ". " + modelInstruction,
    "CLIENT_RUN_ID=" + JSON.stringify(runId),
    "Pass the decoded CLIENT_RUN_ID string to crewdispatch_spawn as client_run_id exactly. It is THIS run's correlation id: never omit it, never invent one, and never reuse another run's id, even when other runs share this Codex thread.",
    "WORKER_TASK_JSON=" + JSON.stringify(brief.workerTask),
    "Pass the decoded WORKER_TASK_JSON string to crewdispatch_spawn as task exactly, with no prefix/suffix.",
    "After crewdispatch_spawn returns, end the turn. Do not call crewdispatch_status and do not call crewdispatch_result until a CrewDispatch terminal wake arrives.",
    "On the terminal wake, call crewdispatch_result exactly once for that same job id.",
    "Do NOT inspect the workspace/diff, run acceptance tests, evaluate review_contract, decide pass/fail, or call crewdispatch_follow_up on your own. WebCodex owns all quality acceptance and decides whether repair is needed.",
    "Never start a second CrewDispatch job for this run. Never cancel the job in the normal bridge flow.",
    "READY_MARKER=" + readyMarker,
    "ATTENTION_MARKER=" + attentionMarker,
    "After crewdispatch_result returns a terminal result, your final response must contain a line with exactly the READY_MARKER, followed only by a concise transport report containing job id, generation, terminal status, and any provider/result error. Do not claim the implementation passed review.",
    "Only use the ATTENTION_MARKER when the bridge itself cannot obey this protocol, for example CrewDispatch MCP is unavailable or the expected job identity cannot be recovered."
  ].join("\n");
}

function readFollowUpMessage(values) {
  const direct = values.get("message");
  const file = values.get("message-file");
  if (direct && file) throw new Error("use exactly one of --message or --message-file");
  if (direct != null) {
    if (!direct.trim()) throw new Error("--message must be non-empty");
    return direct;
  }
  if (file != null) {
    const resolved = path.resolve(file);
    const text = fs.readFileSync(resolved, "utf8");
    if (!text.trim()) throw new Error("--message-file must contain a non-empty message");
    return text;
  }
  throw new Error("missing --message or --message-file");
}

function buildFollowUpPrompt({ runId, jobId, message, readyMarker, attentionMarker }) {
  return [
    "JOBQUAY WEBCODEX FOLLOW-UP " + runId,
    "You are the protocol bridge between WebCodex and the existing CrewDispatch job. You are NOT the quality reviewer.",
    "Use the installed CrewDispatch skill/MCP. Do not spawn a new job, do not call crewdispatch_status, and do not cancel the existing job.",
    "JOB_ID_JSON=" + JSON.stringify(jobId),
    "FOLLOW_UP_MESSAGE_JSON=" + JSON.stringify(message),
    "Call crewdispatch_follow_up exactly once with id equal to decoded JOB_ID_JSON and message equal to decoded FOLLOW_UP_MESSAGE_JSON, with no added prefix/suffix.",
    "After crewdispatch_follow_up returns, end the turn and wait for the terminal wake. Do not poll.",
    "On the terminal wake, call crewdispatch_result exactly once for that same job id.",
    "Do NOT inspect the workspace/diff, run acceptance tests, decide pass/fail, or issue another follow-up. WebCodex performs the next acceptance pass.",
    "READY_MARKER=" + readyMarker,
    "ATTENTION_MARKER=" + attentionMarker,
    "After the terminal crewdispatch_result, your final response must contain a line with exactly the READY_MARKER followed only by a concise transport report. Use ATTENTION_MARKER only for a bridge/protocol failure."
  ].join("\n");
}

function queueCodex(codexExe, thread, prompt, cwd) {
  let file = codexExe;
  let args = ["queue", "--thread", thread, "--message", prompt];
  if (/\.(?:c|m)?js$/i.test(codexExe)) {
    file = process.execPath;
    args = [codexExe, ...args];
  }
  return spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000
  });
}

function textParts(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => part && (part.text ?? part.input_text ?? part.output_text))
    .filter((value) => typeof value === "string");
}

function parseResultText(item) {
  const blocks = item?.result?.content;
  if (!Array.isArray(blocks)) return null;
  const textBlock = blocks.find((block) => block && block.type === "text" && typeof block.text === "string");
  if (!textBlock) return null;
  try { return JSON.parse(textBlock.text); } catch { return null; }
}

// The text of a user-side rollout message (queued run/follow-up prompt), or
// null when the line is not one. Mirrors the two prompt shapes handled below.
function userMessageText(obj) {
  const payload = obj?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "message" && payload.role === "user") return textParts(payload).join("\n");
  if (payload.type === "item_completed" && payload.item?.type === "UserMessage") {
    return Array.isArray(payload.item.content)
      ? payload.item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n")
      : "";
  }
  return null;
}

// The text of a bridge announcement (assistant message / AgentMessage), or null
// when the line is not one. These are the only lines allowed to carry a round's
// READY/ATTENTION marker, so they also define the legacy completion boundary.
function assistantAnnouncementText(obj) {
  const payload = obj?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (payload.type === "message" && payload.role === "assistant") return textParts(payload).join("\n");
  if (payload.type === "item_completed" && payload.item?.type === "AgentMessage") {
    return Array.isArray(payload.item.content)
      ? payload.item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n")
      : "";
  }
  return null;
}

function applyAnnouncement(evidence, text, readyMarker, attentionMarker) {
  if (typeof readyMarker === "string" && readyMarker && text.includes(readyMarker)) {
    evidence.final_outcome = "ready";
    evidence.final_message = text;
  } else if (typeof attentionMarker === "string" && attentionMarker && text.includes(attentionMarker)) {
    evidence.final_outcome = "needs_attention";
    evidence.final_message = text;
  }
}

function newRunEvidence(runId, thread, rollout) {
  return {
    run_id: runId,
    thread_id: thread,
    rollout,
    correlation_id: null,
    attribution: null,
    legacy_limit: null,
    legacy_spawn_candidates: 0,
    initial_prompt_seen: false,
    round_prompt_seen: false,
    round_prompt_markers: [],
    spawn_calls: 0,
    status_calls: 0,
    result_calls: 0,
    follow_up_calls: 0,
    follow_up_accepted: 0,
    cancel_calls: 0,
    wake_count: 0,
    spawn_job_id: null,
    spawn_provider: null,
    spawn_cwd: null,
    spawn_codex_thread_id: null,
    spawn_model_supplied: null,
    spawn_model: null,
    spawn_task: null,
    spawn_notify_kind: null,
    spawn_notify_source: null,
    result_job_ids: [],
    result_generations: [],
    result_statuses: [],
    result_final_texts: [],
    follow_up_job_ids: [],
    follow_up_codes: [],
    follow_up_generations: [],
    final_outcome: null,
    final_message: null,
    foreign_events_ignored: { spawn: 0, status: 0, result: 0, follow_up: 0, cancel: 0, wake: 0 },
    protocol_failures: []
  };
}

// A bridge prompt (initial run or follow-up) always carries its round's exact
// ready marker as a READY_MARKER=<marker> line. `codex queue` exiting 0 only
// proves the durable Codex queue accepted the message; the queued turn is only
// provably delivered when that exact line appears in a user-side rollout
// message. This distinguishes enqueue acceptance from actual delivery.
function roundMarkersInPromptText(text) {
  const markers = [];
  const re = /(?:^|\n)READY_MARKER=([^\s\r\n]+)/g;
  let match;
  while ((match = re.exec(text)) !== null) markers.push(match[1]);
  return markers;
}

function noteQueuedPromptText(evidence, text, runId, readyMarker) {
  if (text.includes(runId)) evidence.initial_prompt_seen = true;
  for (const marker of roundMarkersInPromptText(text)) {
    if (!evidence.round_prompt_markers.includes(marker)) evidence.round_prompt_markers.push(marker);
    if (typeof readyMarker === "string" && readyMarker && marker === readyMarker) evidence.round_prompt_seen = true;
  }
}

function applyRunLine(evidence, obj, runId, readyMarker, attentionMarker, correlationId, workerTask) {
  const payload = obj?.payload;
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "message") {
    const joined = textParts(payload).join("\n");
    if (payload.role === "user") {
      noteQueuedPromptText(evidence, joined, runId, readyMarker);
      const wake = /(?:CrewDispatch|JobQuay) job (job-[A-Za-z0-9_-]+) finished with status ([A-Za-z0-9_-]+)/.exec(joined);
      if (wake) {
        // Only the terminal wake for THIS run's own job counts; wakes for
        // another run's job on the same thread are ignored.
        if (evidence.spawn_job_id != null && wake[1] === evidence.spawn_job_id) {
          evidence.wake_count += 1;
        } else {
          evidence.foreign_events_ignored.wake += 1;
        }
      }
    }
    if (payload.role === "assistant") applyAnnouncement(evidence, joined, readyMarker, attentionMarker);
  }

  if (payload.type !== "item_completed") return;
  const item = payload.item;
  if (item?.type === "UserMessage") {
    const joined = Array.isArray(item.content) ? item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n") : "";
    noteQueuedPromptText(evidence, joined, runId, readyMarker);
  }
  if (item?.type === "AgentMessage") {
    const joined = Array.isArray(item.content) ? item.content.map((part) => part?.text).filter((x) => typeof x === "string").join("\n") : "";
    applyAnnouncement(evidence, joined, readyMarker, attentionMarker);
  }
  if (item?.type !== "McpToolCall" || !["crewdispatch", "jobquay"].includes(item.server)) return;
  const args = item.arguments || {};

  if ((item.tool === "crewdispatch_spawn" || item.tool === "jobquay_spawn")) {
    // Deterministic run attribution: a correlated run only counts the spawn
    // whose client_run_id is exactly this run's id. Another run's spawn on the
    // same Codex thread is ignored instead of being counted or mined for fields.
    if (correlationId != null && args.client_run_id !== correlationId) {
      evidence.foreign_events_ignored.spawn += 1;
      return;
    }
    // Legacy (schema-v2) runs have no correlation id. Only a spawn whose task
    // is exactly this run's durable worker_task (and which carries no foreign
    // correlation id) can be proven to be this run's own; everything else is
    // ignored. Two exact-task matches are ambiguous and cannot be attributed.
    if (correlationId == null) {
      const foreignCorrelation = args.client_run_id != null && args.client_run_id !== runId;
      if (args.task !== workerTask || foreignCorrelation) {
        evidence.foreign_events_ignored.spawn += 1;
        return;
      }
      evidence.legacy_spawn_candidates += 1;
      if (evidence.legacy_spawn_candidates > 1) {
        // Keep the first candidate's fields for display; legacy_limit turns
        // this into an explicit legacy_limited result after the scan.
        evidence.spawn_calls += 1;
        return;
      }
    }
    evidence.spawn_calls += 1;
    evidence.spawn_provider = args.provider ?? null;
    evidence.spawn_cwd = args.cwd ?? null;
    evidence.spawn_codex_thread_id = args.codex_thread_id ?? null;
    evidence.spawn_model_supplied = Object.prototype.hasOwnProperty.call(args, "model");
    evidence.spawn_model = args.model ?? null;
    evidence.spawn_task = args.task ?? null;
    const body = parseResultText(item);
    if (body?.job_id) evidence.spawn_job_id = body.job_id;
    evidence.spawn_notify_kind = body?.notify?.kind ?? null;
    evidence.spawn_notify_source = body?.notify?.source ?? null;
  } else if ((item.tool === "crewdispatch_status" || item.tool === "jobquay_status")) {
    // Status is not part of the run correlation contract. An id-tagged poll
    // provably aimed at another job is ignored; an id-less list call stays
    // counted for this run so the zero-polling check keeps its single-run
    // behavior (it cannot be attributed to any specific run).
    if (evidence.spawn_job_id != null && typeof args.id === "string" && args.id !== evidence.spawn_job_id) {
      evidence.foreign_events_ignored.status += 1;
      return;
    }
    evidence.status_calls += 1;
  } else if ((item.tool === "crewdispatch_result" || item.tool === "jobquay_result")) {
    if (!ownJobCall(evidence, args)) {
      evidence.foreign_events_ignored.result += 1;
      return;
    }
    evidence.result_calls += 1;
    evidence.result_job_ids.push(args.id ?? null);
    const body = parseResultText(item);
    evidence.result_generations.push(body?.generation ?? null);
    evidence.result_statuses.push(body?.status ?? null);
    evidence.result_final_texts.push(body?.result?.final_text ?? null);
  } else if ((item.tool === "crewdispatch_follow_up" || item.tool === "jobquay_follow_up")) {
    if (!ownJobCall(evidence, args)) {
      evidence.foreign_events_ignored.follow_up += 1;
      return;
    }
    evidence.follow_up_calls += 1;
    evidence.follow_up_job_ids.push(args.id ?? null);
    const body = parseResultText(item);
    evidence.follow_up_codes.push(body?.code ?? null);
    evidence.follow_up_generations.push(body?.generation ?? null);
    if (body?.ok === true && Number.isInteger(body?.generation)) evidence.follow_up_accepted += 1;
  } else if ((item.tool === "crewdispatch_cancel" || item.tool === "jobquay_cancel")) {
    if (!ownJobCall(evidence, args)) {
      evidence.foreign_events_ignored.cancel += 1;
      return;
    }
    evidence.cancel_calls += 1;
  }
}

/**
 * A run only counts a job-scoped tool call whose `id` is exactly the job id
 * proven by its own spawn. For correlated (schema-v3) runs the proof is the
 * client_run_id; for legacy runs it is the exact worker_task plus the job id
 * the spawn yielded. Until that id is known (spawn not yet observed in rollout
 * order), job-scoped calls are unattributable and ignored instead of being
 * counted against this run.
 */
function ownJobCall(evidence, args) {
  return evidence.spawn_job_id != null && args.id === evidence.spawn_job_id;
}

function readRunEvidence(rollout, startOffset, meta) {
  const evidence = newRunEvidence(meta.run_id, meta.thread_id, rollout);
  // Schema v3 metas carry an explicit run-specific correlation id; v2 metas
  // predate the correlation protocol and need exact legacy attribution plus a
  // durable completion boundary.
  const correlationId = meta.version >= 3 && typeof meta.correlation_id === "string" && meta.correlation_id ? meta.correlation_id : null;
  const legacy = correlationId == null;
  evidence.correlation_id = correlationId;
  const readyMarker = meta.ready_marker ?? meta.approved_marker;
  const attentionMarker = meta.attention_marker;
  const fd = fs.openSync(rollout, "r");
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.max(0, stat.size - startOffset);
    const buffer = Buffer.alloc(length);
    if (length) fs.readSync(fd, buffer, 0, length, startOffset);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    let startIndex = 0;
    let endIndex = lines.length;
    if (legacy) {
      // No legacy event can precede the run's own queued prompt, so the scan
      // starts there. This keeps an earlier same-task run's events out of the
      // window and is the only positional anchor used for ownership.
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(meta.run_id)) continue;
        let obj;
        try { obj = JSON.parse(lines[i]); } catch { continue; }
        const promptText = userMessageText(obj);
        if (promptText != null && promptText.includes(meta.run_id)) { startIndex = i; break; }
      }
      // Durable completion boundary: after the bridge announced this round's
      // READY/ATTENTION marker, nothing later in the rollout can belong to the
      // round. Freezing the scan there keeps later unrelated same-thread runs
      // from ever changing this run's inspect result.
      let boundaryIndex = -1;
      for (let i = startIndex; i < lines.length; i += 1) {
        const line = lines[i];
        const mentionsReady = typeof readyMarker === "string" && readyMarker && line.includes(readyMarker);
        const mentionsAttention = typeof attentionMarker === "string" && attentionMarker && line.includes(attentionMarker);
        if (!mentionsReady && !mentionsAttention) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const announcement = assistantAnnouncementText(obj);
        if (announcement == null) continue;
        if ((typeof readyMarker === "string" && readyMarker && announcement.includes(readyMarker)) ||
            (typeof attentionMarker === "string" && attentionMarker && announcement.includes(attentionMarker))) {
          boundaryIndex = i;
        }
      }
      if (boundaryIndex >= startIndex) endIndex = boundaryIndex + 1;
    }
    for (let i = startIndex; i < endIndex; i += 1) {
      if (!lines[i].trim()) continue;
      try {
        applyRunLine(evidence, JSON.parse(lines[i]), meta.run_id, readyMarker, attentionMarker, correlationId, meta.worker_task);
      } catch {
        // Ignore incomplete/non-JSON rollout lines while the app is appending.
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  if (legacy) {
    if (evidence.legacy_spawn_candidates > 1) {
      evidence.legacy_limit = "multiple crewdispatch_spawn calls (" + evidence.legacy_spawn_candidates + ") match this run's exact worker_task, so the original job id cannot be proven";
    } else if (evidence.legacy_spawn_candidates === 0 && evidence.spawn_calls === 0 && evidence.foreign_events_ignored.spawn > 0 && evidence.initial_prompt_seen) {
      evidence.legacy_limit = "no crewdispatch_spawn call matched this run's exact worker_task, so the original job id cannot be proven";
    }
  }
  evidence.attribution = correlationId != null ? "correlation" : evidence.legacy_limit ? "legacy_limited" : "legacy";
  return evidence;
}

function validateRunEvidence(evidence, meta) {
  // Legacy ownership that cannot be reconstructed is an explicit limited state,
  // never a verdict assembled from events the run cannot own.
  if (evidence.legacy_limit) {
    evidence.protocol_failures = [];
    return evidence;
  }
  const failures = [];
  if (!evidence.initial_prompt_seen) failures.push("queued WebCodex run prompt was not observed in the Codex rollout");
  if (evidence.spawn_calls !== 1) failures.push("expected exactly one crewdispatch_spawn call, saw " + evidence.spawn_calls);
  if (evidence.correlation_id && evidence.spawn_calls === 0 && evidence.foreign_events_ignored.spawn > 0) {
    failures.push("no crewdispatch_spawn call carried this run's client_run_id correlation id");
  }
  if (evidence.status_calls !== 0) failures.push("expected zero crewdispatch_status polling calls, saw " + evidence.status_calls);
  if (!evidence.spawn_job_id) failures.push("crewdispatch_spawn did not yield a job id");
  if (evidence.spawn_provider !== meta.provider) failures.push("spawn provider mismatch");
  if (evidence.spawn_cwd == null || normalizePathKey(evidence.spawn_cwd) !== normalizePathKey(meta.cwd)) failures.push("spawn cwd mismatch");
  if (evidence.spawn_codex_thread_id !== meta.thread_id) failures.push("Codex did not pass its exact thread id");
  if (evidence.spawn_task !== meta.worker_task) failures.push("Codex did not pass worker_task verbatim");
  if (meta.model == null) {
    if (evidence.spawn_model_supplied !== false) failures.push("Codex supplied a model even though configured provider default was requested");
  } else if (evidence.spawn_model !== meta.model) {
    failures.push("spawn model mismatch");
  }
  if (evidence.spawn_notify_kind !== "codex_thread" || evidence.spawn_notify_source !== "codex_thread_id") {
    failures.push("spawn did not persist explicit Codex-thread wake target");
  }
  if (evidence.result_calls < 1 && evidence.final_outcome === "ready") failures.push("Codex bridge reported ready without collecting any CrewDispatch result");
  if (evidence.follow_up_accepted > meta.max_followups) failures.push("Codex exceeded allowed accepted follow-up generation count");
  if (evidence.cancel_calls > 0) failures.push("Codex cancelled the job during normal review flow");
  for (const id of evidence.result_job_ids) {
    if (id !== evidence.spawn_job_id) failures.push("crewdispatch_result used a different job id");
  }
  for (const id of evidence.follow_up_job_ids) {
    if (id !== evidence.spawn_job_id) failures.push("crewdispatch_follow_up used a different job id");
  }
  if (evidence.wake_count !== evidence.result_calls) {
    failures.push("terminal wake/result count mismatch: wakes=" + evidence.wake_count + " results=" + evidence.result_calls);
  }
  if (!evidence.final_outcome) failures.push("Codex did not emit a ready/bridge-attention marker");
  if (evidence.final_outcome === "ready" && evidence.result_calls !== evidence.follow_up_accepted + 1) {
    failures.push("ready bridge result count must equal initial result plus accepted follow-up generation count");
  }
  if (evidence.final_outcome === "ready") {
    const terminal = new Set(["done", "error", "cancelled", "interrupted"]);
    const latestStatus = evidence.result_statuses[evidence.result_statuses.length - 1];
    if (!terminal.has(latestStatus)) failures.push("Codex bridge reported ready although the latest CrewDispatch result was not terminal");
  }
  evidence.protocol_failures = [...new Set(failures)];
  return evidence;
}

const PENDING_MARKER_FAILURE = "Codex did not emit a ready/bridge-attention marker";

/**
 * A run whose spawn yielded an exact job id but whose round has no terminal
 * marker yet is PENDING, not failed: the Codex bridge still owns
 * crewdispatch_result collection and may still be waiting on the inner job. This
 * returns { job_id } only when every observed protocol gap is a
 * not-yet-terminal artifact (the missing marker, and a delivered wake whose
 * result has not been collected yet). Any other gap keeps the hard
 * classification, so real protocol violations stay protocol_failed.
 */
function pendingBridgeState(evidence) {
  if (evidence.legacy_limit || evidence.final_outcome || !evidence.spawn_job_id) return null;
  const awaitingResult = evidence.wake_count > evidence.result_calls;
  for (const failure of evidence.protocol_failures) {
    if (failure === PENDING_MARKER_FAILURE) continue;
    if (awaitingResult && failure.startsWith("terminal wake/result count mismatch")) continue;
    return null;
  }
  return { job_id: evidence.spawn_job_id };
}

/**
 * `codex queue` exiting 0 only proves the durable Codex queue accepted the
 * message; a closed or inactive target session can leave it undelivered
 * indefinitely. When the exact round prompt is not observed in the target
 * rollout within the bounded queue-observation window, the run is classified as
 * queue_not_observed and nothing is requeued: the accepted message may still be
 * delivered later, so a blind retry could create a duplicate turn and duplicate
 * CrewDispatch work.
 */
function recordQueueNotObserved(meta, info) {
  const stat = fs.statSync(info.rollout);
  meta.last_phase = "queue_not_observed";
  meta.last_queue_observation = {
    round: info.round,
    marker: meta.ready_marker ?? null,
    recorded_at: new Date().toISOString(),
    window_seconds: info.windowSeconds,
    thread_id: info.thread,
    binding_method: info.bindingMethod ?? null,
    job_id: info.jobId ?? null,
    rollout_bytes_at_start: info.startOffset,
    rollout_bytes_now: stat.size,
    rollout_unchanged_since_start: stat.size === info.startOffset,
    rollout_last_modified: stat.mtime.toISOString()
  };
  return meta;
}

function queueNotObservedMessage(runId, observation, kind) {
  const unchanged = observation.rollout_unchanged_since_start
    ? " and the target rollout has not grown at all since the run started"
    : "";
  const subject = kind === "follow-up" ? "the round-" + observation.round + " follow-up prompt" : "the exact run prompt";
  const dispatch = kind === "follow-up" ? "No follow-up call was observed." : "No CrewDispatch spawn was observed.";
  const retry = kind === "follow-up"
    ? "do not queue another repair for this round"
    : "do not start a replacement job for the same work";
  return "codex queue accepted the message (process exit 0), but " + subject + " was not observed in the target rollout within " +
    observation.window_seconds + "s" + unchanged + ". " + dispatch +
    " Redispatch is NOT performed automatically: the queued turn may still be delivered if this Codex session becomes active later, so " +
    retry + ". Use inspect --run-id " + runId + " to re-check the same run; if the target thread is inactive, confirm or repair the binding with resolve --cwd <project> before deliberately starting a new run.";
}

/**
 * While the last queued round's exact prompt marker has still never been
 * observed, another queued turn (a follow-up) must not be sent: the accepted
 * message is still sitting in Codex's durable queue and could be delivered
 * together with the new one.
 */
function unobservedQueueState(meta, evidence) {
  const observation = meta.last_queue_observation;
  if (meta.last_phase !== "queue_not_observed" || !observation) return null;
  if (typeof observation.marker !== "string" || !observation.marker) return null;
  if (evidence.round_prompt_markers.includes(observation.marker)) return null;
  return { round: Number(observation.round) || 0, marker: observation.marker };
}

function runsDir(statePath) {
  return path.join(path.dirname(statePath), "runs");
}

function runMetaPath(statePath, runId) {
  return path.join(runsDir(statePath), runId + ".json");
}

function saveRunMeta(statePath, meta) {
  const dir = runsDir(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const file = runMetaPath(statePath, meta.run_id);
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(meta, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
  return file;
}

function loadRunMeta(statePath, runId) {
  const file = runMetaPath(statePath, runId);
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, meta };
}

function outputResolution(resolution) {
  if (!resolution.ok) {
    process.stdout.write(JSON.stringify(resolution, null, 2) + "\n");
    process.exitCode = 2;
    return false;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    method: resolution.method,
    project_cwd: resolution.binding.cwd,
    reviewer_cwd: resolution.session.cwd,
    thread_id: resolution.session.thread,
    rollout: resolution.session.rollout,
    state_path: resolution.statePath
  }, null, 2) + "\n");
  return true;
}

function resolveCommand(values) {
  const cwd = path.resolve(required(values, "cwd"));
  return outputResolution(resolveReviewer(values, cwd));
}

function bindCommand(values) {
  const cwd = path.resolve(required(values, "cwd"));
  return outputResolution(resolveReviewer(values, cwd));
}

function unbindCommand(values) {
  const cwd = path.resolve(required(values, "cwd"));
  const statePath = resolveStatePath(values);
  const removed = unbindProject(statePath, cwd);
  process.stdout.write(JSON.stringify({ ok: true, cwd, removed, state_path: statePath }, null, 2) + "\n");
}

async function runCommand(values) {
  const brief = readBrief(required(values, "brief"));
  const cwd = path.resolve(values.get("cwd") || brief.cwd || process.cwd());
  const provider = values.get("provider") || brief.provider || "command-code";
  if (!["command-code", "workbuddy-ai"].includes(provider)) throw new Error("unsupported provider: " + provider);
  const model = values.has("model") ? required(values, "model") : brief.model;
  const timeoutSeconds = numberOption(values, "timeout-seconds", 1800, 1);
  const maxFollowups = Math.floor(numberOption(values, "max-followups", 2, 0));
  if (maxFollowups > 5) throw new Error("--max-followups must be <= 5");
  const queueObserveSeconds = numberOption(values, "queue-observe-seconds", 60, 1);

  const resolution = resolveReviewer(values, cwd);
  if (!resolution.ok) {
    process.stdout.write(JSON.stringify(resolution, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }
  const thread = resolution.session.thread;
  const rollout = resolution.session.rollout;
  const codexExe = resolveCodexExe(values, resolution.codexHome);
  const statePath = resolution.statePath;
  const startOffset = fs.statSync(rollout).size;
  const runId = "JQRUN-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomBytes(4).toString("hex");
  const readyMarker = runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R0";
  const attentionMarker = runId + "-CODEX-BRIDGE-NEEDS-ATTENTION-R0";
  const prompt = buildRunPrompt({ runId, cwd, provider, model, brief, readyMarker, attentionMarker });
  const meta = {
    version: 3,
    run_id: runId,
    correlation_id: runId,
    created_at: new Date().toISOString(),
    thread_id: thread,
    rollout,
    start_offset: startOffset,
    binding_method: resolution.method,
    cwd,
    provider,
    model: model ?? null,
    worker_task: brief.workerTask,
    objective: brief.objective,
    max_followups: maxFollowups,
    bridge_round: 0,
    ready_marker: readyMarker,
    attention_marker: attentionMarker,
    review_contract: brief.reviewContract,
    external_acceptance: brief.externalAcceptance,
    codex_home: resolution.codexHome,
    brief_path: brief.path
  };
  const metaFile = saveRunMeta(statePath, meta);

  const queued = queueCodex(codexExe, thread, prompt, cwd);
  if (queued.error || queued.status !== 0) {
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "queue_failed",
      run_id: runId,
      thread_id: thread,
      binding_method: resolution.method,
      error: queued.error ? String(queued.error.message || queued.error) : String(queued.stderr || queued.stdout || "").trim(),
      run_meta: metaFile
    }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phase: "queued",
    run_id: runId,
    thread_id: thread,
    binding_method: resolution.method,
    provider,
    cwd,
    model: model ?? null,
    run_meta: metaFile,
    codex_queue: String(queued.stdout || "").trim()
  }) + "\n");

  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeDeadline = Math.min(deadline, Date.now() + queueObserveSeconds * 1000);
  let evidence = newRunEvidence(runId, thread, rollout);
  // A successful `codex queue` process is only enqueue acceptance. Wait a
  // bounded time for the exact round prompt to appear in the target rollout
  // before treating the dispatch as progressing; a closed or inactive target
  // session would otherwise burn the entire inner-job deadline in silence.
  while (Date.now() < observeDeadline) {
    evidence = readRunEvidence(rollout, startOffset, meta);
    if (evidence.round_prompt_seen || evidence.final_outcome || evidence.spawn_calls > 0 || evidence.status_calls > 0 || evidence.follow_up_calls > maxFollowups) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!evidence.round_prompt_seen && !evidence.initial_prompt_seen && !evidence.final_outcome && evidence.spawn_calls === 0 && evidence.status_calls === 0 && evidence.follow_up_calls === 0) {
    const observedMetaFile = saveRunMeta(statePath, recordQueueNotObserved(meta, {
      round: 0,
      thread,
      bindingMethod: resolution.method,
      startOffset,
      rollout,
      windowSeconds: queueObserveSeconds
    }));
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "queue_not_observed",
      resumable: true,
      run_id: runId,
      thread_id: thread,
      binding_method: resolution.method,
      round: 0,
      run_meta: observedMetaFile,
      queue_observation: meta.last_queue_observation,
      message: queueNotObservedMessage(runId, meta.last_queue_observation, "run"),
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  while (Date.now() < deadline) {
    evidence = readRunEvidence(rollout, startOffset, meta);
    if (evidence.final_outcome || evidence.spawn_calls > 1 || evidence.status_calls > 0 || evidence.follow_up_calls > maxFollowups) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (evidence.final_outcome) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    evidence = readRunEvidence(rollout, startOffset, meta);
  }
  validateRunEvidence(evidence, meta);

  if (!evidence.final_outcome) {
    const pending = pendingBridgeState(evidence);
    if (pending) {
      meta.last_phase = "pending_inner_job";
      meta.last_pending = {
        job_id: pending.job_id,
        recorded_at: new Date().toISOString(),
        wait_deadline: new Date(deadline).toISOString(),
        wakes: evidence.wake_count,
        results_collected: evidence.result_calls
      };
      const pendingMetaFile = saveRunMeta(statePath, meta);
      process.stdout.write(JSON.stringify({
        ok: false,
        phase: "pending_inner_job",
        resumable: true,
        run_id: runId,
        thread_id: thread,
        job_id: pending.job_id,
        run_meta: pendingMetaFile,
        message: "The outer wait ended while the exact inner CrewDispatch job " + pending.job_id +
          " had no terminal bridge marker yet. The Codex bridge still owns crewdispatch_result collection; do not redispatch." +
          " Resume with inspect --run-id " + runId + ".",
        evidence
      }, null, 2) + "\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "timeout",
      run_id: runId,
      thread_id: thread,
      run_meta: metaFile,
      message: "Timed out waiting for the Codex bridge to collect the terminal CrewDispatch result. The CrewDispatch job may still be running; use inspect --run-id " + runId + ".",
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  if (evidence.protocol_failures.length) {
    process.stdout.write(JSON.stringify({ ok: false, phase: "protocol_failed", run_id: runId, run_meta: metaFile, evidence }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phase: evidence.final_outcome === "ready" ? "ready_for_external_acceptance" : "codex_bridge_needs_attention",
    run_id: runId,
    thread_id: thread,
    job_id: evidence.spawn_job_id,
    generation: evidence.result_generations[evidence.result_generations.length - 1] ?? null,
    status: evidence.result_statuses[evidence.result_statuses.length - 1] ?? null,
    follow_ups: evidence.follow_up_accepted,
    follow_up_attempts: evidence.follow_up_calls,
    results_collected: evidence.result_calls,
    worker_result: evidence.result_final_texts[evidence.result_final_texts.length - 1] ?? null,
    codex_bridge: evidence.final_message,
    run_meta: metaFile,
    review_contract: brief.reviewContract,
    external_acceptance: brief.externalAcceptance
  }, null, 2) + "\n");
}

async function followUpCommand(values) {
  const runId = required(values, "run-id");
  const message = readFollowUpMessage(values);
  const queueObserveSeconds = numberOption(values, "queue-observe-seconds", 60, 1);
  const statePath = resolveStatePath(values);
  const loaded = loadRunMeta(statePath, runId);
  const meta = loaded.meta;
  let evidence = readRunEvidence(meta.rollout, meta.start_offset, meta);
  validateRunEvidence(evidence, meta);
  if (evidence.legacy_limit) {
    emitLegacyLimited(runId, loaded.file, evidence, "A follow-up is only valid after the original job id is proven; nothing was queued.");
    return;
  }
  // An earlier queued turn whose exact prompt was never observed is still in
  // Codex's durable queue. Queueing another follow-up could deliver both and
  // create an unrequested duplicate generation, so refuse until the accepted
  // turn is either observed or the target thread is explicitly repaired.
  const unobserved = unobservedQueueState(meta, evidence);
  if (unobserved) {
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "queue_not_observed",
      resumable: true,
      run_id: runId,
      thread_id: meta.thread_id,
      job_id: meta.last_queue_observation.job_id ?? null,
      bridge_round: meta.bridge_round,
      run_meta: loaded.file,
      queue_observation: meta.last_queue_observation,
      message: queueNotObservedMessage(runId, meta.last_queue_observation, unobserved.round === 0 ? "run" : "follow-up") + " Nothing was queued.",
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  const pending = pendingBridgeState(evidence);
  if (pending) {
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "pending_inner_job",
      resumable: true,
      run_id: runId,
      job_id: pending.job_id,
      run_meta: loaded.file,
      message: "Run " + runId + " is still pending on job " + pending.job_id +
        ": the Codex bridge has not reported a terminal result for the current round yet." +
        " A follow-up is only valid after ready_for_external_acceptance; nothing was queued. Use inspect --run-id " + runId + ".",
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  if (evidence.protocol_failures.length) {
    process.stdout.write(JSON.stringify({ ok: false, phase: "protocol_failed", run_id: runId, run_meta: loaded.file, evidence }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }
  if (!evidence.spawn_job_id) throw new Error("cannot follow up before the initial CrewDispatch job id is known");
  if (evidence.follow_up_accepted >= meta.max_followups) throw new Error("maximum accepted follow-up generation count already reached for " + runId);

  const round = Math.max(Number(meta.bridge_round) || 0, evidence.follow_up_calls) + 1;
  meta.bridge_round = round;
  meta.ready_marker = runId + "-READY-FOR-WEBCODEX-ACCEPTANCE-R" + round;
  meta.attention_marker = runId + "-CODEX-BRIDGE-NEEDS-ATTENTION-R" + round;
  const metaFile = saveRunMeta(statePath, meta);
  const prompt = buildFollowUpPrompt({
    runId,
    jobId: evidence.spawn_job_id,
    message,
    readyMarker: meta.ready_marker,
    attentionMarker: meta.attention_marker
  });
  const codexHome = values.has("codex-home") ? resolveCodexHome(values) : (meta.codex_home || resolveCodexHome(values));
  const codexExe = resolveCodexExe(values, codexHome);
  const queued = queueCodex(codexExe, meta.thread_id, prompt, meta.cwd);
  if (queued.error || queued.status !== 0) {
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "queue_failed",
      run_id: runId,
      thread_id: meta.thread_id,
      error: queued.error ? String(queued.error.message || queued.error) : String(queued.stderr || queued.stdout || "").trim(),
      run_meta: metaFile
    }, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phase: "follow_up_queued",
    run_id: runId,
    job_id: evidence.spawn_job_id,
    bridge_round: round,
    run_meta: metaFile
  }) + "\n");

  const timeoutSeconds = numberOption(values, "timeout-seconds", 1800, 1);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const observeDeadline = Math.min(deadline, Date.now() + queueObserveSeconds * 1000);
  // Same enqueue-acceptance rule as `run`: wait a bounded time for this round's
  // exact follow-up prompt before treating the turn as progressing. Earlier
  // rounds' prompts and calls are already in the scan window, so the only
  // round-scoped signals are this round's ready marker and a newly attempted
  // follow-up call (the round number equals the total attempt count).
  while (Date.now() < observeDeadline) {
    evidence = readRunEvidence(meta.rollout, meta.start_offset, meta);
    if (evidence.round_prompt_seen || evidence.final_outcome || evidence.status_calls > 0 || evidence.follow_up_calls >= round) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!evidence.round_prompt_seen && !evidence.final_outcome && evidence.status_calls === 0 && evidence.follow_up_calls < round) {
    const observedMetaFile = saveRunMeta(statePath, recordQueueNotObserved(meta, {
      round,
      thread: meta.thread_id,
      bindingMethod: meta.binding_method,
      startOffset: meta.start_offset,
      rollout: meta.rollout,
      windowSeconds: queueObserveSeconds,
      jobId: evidence.spawn_job_id
    }));
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "queue_not_observed",
      resumable: true,
      run_id: runId,
      thread_id: meta.thread_id,
      job_id: evidence.spawn_job_id,
      bridge_round: round,
      run_meta: observedMetaFile,
      queue_observation: meta.last_queue_observation,
      message: queueNotObservedMessage(runId, meta.last_queue_observation, "follow-up"),
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  while (Date.now() < deadline) {
    evidence = readRunEvidence(meta.rollout, meta.start_offset, meta);
    if (evidence.final_outcome || evidence.follow_up_accepted > meta.max_followups) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (evidence.final_outcome) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    evidence = readRunEvidence(meta.rollout, meta.start_offset, meta);
  }
  validateRunEvidence(evidence, meta);
  if (evidence.legacy_limit) {
    emitLegacyLimited(runId, metaFile, evidence, "The queued follow-up turn cannot be verified; do not redispatch against a guessed job id.");
    return;
  }

  if (!evidence.final_outcome) {
    const pending = pendingBridgeState(evidence);
    if (pending) {
      meta.last_phase = "pending_inner_job";
      meta.last_pending = {
        job_id: pending.job_id,
        recorded_at: new Date().toISOString(),
        wait_deadline: new Date(deadline).toISOString(),
        bridge_round: round,
        wakes: evidence.wake_count,
        results_collected: evidence.result_calls
      };
      const pendingMetaFile = saveRunMeta(statePath, meta);
      process.stdout.write(JSON.stringify({
        ok: false,
        phase: "pending_inner_job",
        resumable: true,
        run_id: runId,
        job_id: pending.job_id,
        bridge_round: round,
        run_meta: pendingMetaFile,
        message: "The follow-up outer wait ended while the exact inner CrewDispatch job " + pending.job_id +
          " had no terminal bridge marker yet. The Codex bridge still owns crewdispatch_result collection; do not redispatch." +
          " Resume with inspect --run-id " + runId + ".",
        evidence
      }, null, 2) + "\n");
      process.exitCode = 3;
      return;
    }
    process.stdout.write(JSON.stringify({
      ok: false,
      phase: "timeout",
      run_id: runId,
      job_id: evidence.spawn_job_id,
      run_meta: metaFile,
      message: "Timed out waiting for the follow-up terminal result; use inspect --run-id " + runId + ".",
      evidence
    }, null, 2) + "\n");
    process.exitCode = 3;
    return;
  }
  if (evidence.protocol_failures.length) {
    process.stdout.write(JSON.stringify({ ok: false, phase: "protocol_failed", run_id: runId, run_meta: metaFile, evidence }, null, 2) + "\n");
    process.exitCode = 2;
    return;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phase: evidence.final_outcome === "ready" ? "ready_for_external_acceptance" : "codex_bridge_needs_attention",
    run_id: runId,
    thread_id: meta.thread_id,
    job_id: evidence.spawn_job_id,
    generation: evidence.result_generations[evidence.result_generations.length - 1] ?? null,
    status: evidence.result_statuses[evidence.result_statuses.length - 1] ?? null,
    follow_ups: evidence.follow_up_accepted,
    follow_up_attempts: evidence.follow_up_calls,
    results_collected: evidence.result_calls,
    worker_result: evidence.result_final_texts[evidence.result_final_texts.length - 1] ?? null,
    codex_bridge: evidence.final_message,
    run_meta: metaFile,
    review_contract: meta.review_contract ?? "",
    external_acceptance: meta.external_acceptance ?? ""
  }, null, 2) + "\n");
}

function legacyLimitedMessage(runId, evidence) {
  return "Legacy schema-v2 run " + runId + " has no per-run correlation id: " + evidence.legacy_limit +
    ". Later same-thread events cannot be attributed to this run, so no protocol verdict is reported and no follow-up will be queued against a guessed job id.";
}

function emitLegacyLimited(runId, metaFile, evidence, note) {
  process.stdout.write(JSON.stringify({
    ok: false,
    phase: "legacy_limited",
    run_id: runId,
    run_meta: metaFile,
    message: legacyLimitedMessage(runId, evidence) + " " + note,
    evidence
  }, null, 2) + "\n");
  process.exitCode = 2;
}

function inspectCommand(values) {
  const runId = required(values, "run-id");
  const statePath = resolveStatePath(values);
  const { file, meta } = loadRunMeta(statePath, runId);
  const evidence = readRunEvidence(meta.rollout, meta.start_offset, meta);
  validateRunEvidence(evidence, meta);
  const legacyLimited = evidence.legacy_limit != null;
  const unobserved = legacyLimited ? null : unobservedQueueState(meta, evidence);
  const pending = legacyLimited || unobserved ? null : pendingBridgeState(evidence);
  process.stdout.write(JSON.stringify({
    ok: !legacyLimited && !unobserved && evidence.final_outcome != null && evidence.protocol_failures.length === 0,
    phase: legacyLimited
      ? "legacy_limited"
      : unobserved
        ? "queue_not_observed"
        : evidence.final_outcome
          ? evidence.protocol_failures.length
            ? "protocol_failed"
            : evidence.final_outcome === "ready"
              ? "ready_for_external_acceptance"
              : "codex_bridge_needs_attention"
          : pending
            ? "pending_inner_job"
            : "pending",
    resumable: pending != null || unobserved != null,
    run_meta: file,
    job_id: legacyLimited ? null : evidence.spawn_job_id,
    message: legacyLimited
      ? legacyLimitedMessage(runId, evidence)
      : unobserved
        ? queueNotObservedMessage(runId, meta.last_queue_observation, unobserved.round === 0 ? "run" : "follow-up")
        : undefined,
    queue_observation: unobserved ? meta.last_queue_observation : undefined,
    generation: legacyLimited ? null : evidence.result_generations[evidence.result_generations.length - 1] ?? null,
    status: legacyLimited ? null : evidence.result_statuses[evidence.result_statuses.length - 1] ?? null,
    follow_ups: evidence.follow_up_accepted,
    follow_up_attempts: evidence.follow_up_calls,
    results_collected: evidence.result_calls,
    worker_result: legacyLimited ? null : evidence.result_final_texts[evidence.result_final_texts.length - 1] ?? null,
    review_contract: meta.review_contract ?? "",
    external_acceptance: meta.external_acceptance ?? "",
    evidence
  }, null, 2) + "\n");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (!command || command === "help") {
    usage();
    return;
  }
  if (command === "resolve") return resolveCommand(parsed.values);
  if (command === "bind") return bindCommand(parsed.values);
  if (command === "unbind") return unbindCommand(parsed.values);
  if (command === "run") return runCommand(parsed.values);
  if (command === "follow-up") return followUpCommand(parsed.values);
  if (command === "inspect") return inspectCommand(parsed.values);
  throw new Error("unknown command: " + command);
}

main().catch((error) => {
  process.stderr.write((error?.stack || String(error)) + "\n");
  process.exitCode = 1;
});
