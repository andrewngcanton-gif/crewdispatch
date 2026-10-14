#!/usr/bin/env node
"use strict";
// probe-command-code-acp.cjs
//
// Independent, opt-in compatibility probe for the INSTALLED official Command Code
// ACP endpoint (`cmdc acp`). This is EVIDENCE COLLECTION, not a provider
// implementation: it does not import or modify CrewDispatch source, does not
// touch global settings, credentials, the installed CLI or user history.
//
// It speaks the Agent Client Protocol (ACP) over NDJSON stdio to a freshly
// spawned `node <command-code>/dist/index.mjs acp` process, records the exact
// wire shapes, and runs a bounded set of micro-tests.
//
// Safety:
//   - spawn with shell:false via node.exe + the CLI's own .mjs entry (no cmd.exe
//     re-parse), windowsHide:true, every stage is bounded by an explicit timeout;
//   - only test-owned disposable directories/files are written or approved;
//   - model prompts are OFF unless --with-prompts is given, and are capped;
//   - raw logs are sanitized (no credentials, no env dumps) before being written.
//
// Usage:
//   node scripts/probe-command-code-acp.cjs --introspect
//   node scripts/probe-command-code-acp.cjs --with-prompts --print-session
//
// Exit code 0 = probe ran to completion (findings may include "unsupported"),
// 1 = harness/protocol failure, 2 = bad invocation.

const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_ARTIFACTS = path.join(REPO_ROOT, "artifacts", "command-code-acp-compatibility");
const PROTOCOL_VERSION = 1;
const MAX_PROMPTS = 6;

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readIfExists(file) {
  try {
    return { exists: true, content: fs.readFileSync(file, "utf8") };
  } catch {
    return { exists: false, content: null };
  }
}

function rmTestDir(dir) {
  try {
    const resolved = path.resolve(dir);
    if (!resolved.includes("cc-acp-probe-")) return; // never delete unrelated paths
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// Catalog shrink: the real model picker returns 85 rows in two places, which is
// not evidence the migration consumer needs. Keep the shape, drop the bulk.
function shrinkCatalogs(v) {
  if (Array.isArray(v)) return v.map(shrinkCatalogs);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "availableModels" && Array.isArray(val)) {
        out[k] = { count: val.length, sample: val.slice(0, 2) };
        continue;
      }
      if (k === "options" && Array.isArray(val) && typeof v.id === "string" && v.id === "model") {
        out[k] = { count: val.length, sample: val.slice(0, 2).map((o) => o.value) };
        continue;
      }
      out[k] = shrinkCatalogs(val);
    }
    return out;
  }
  return v;
}

// Credential-shaped keys only. Deliberately NOT a bare /token/ — usage token
// COUNTS (inputTokens, outputTokens, cachedReadTokens, …) are the telemetry
// evidence this probe exists to capture, and must never be redacted.
const REDACT_KEY = /(secret|api[_-]?key|apikey|authorization|password|passwd|credential|bearer|cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)/i;

function sanitize(value, depth = 0, maxStr = 1500) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > maxStr ? value.slice(0, maxStr) + `…[+${value.length - maxStr}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 60).map((v) => sanitize(v, depth + 1, maxStr));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = sanitize(v, depth + 1, maxStr);
    }
    return out;
  }
  return String(value);
}

/** Sanitize for evidence AND drop the bulky model catalogs. */
function compact(value) {
  return sanitize(shrinkCatalogs(value));
}

// ---------------------------------------------------------------------------
// Permission boundary (shared by the live probe AND the offline self-test).
//
// The probe must NEVER auto-approve anything except its OWN edit request for
// exactly the one named disposable file, on the active session, inside this
// probe's temp root. Everything else fails closed. Option selection is by the
// provider-published option KIND, never by a hard-coded id.
// ---------------------------------------------------------------------------

const PERMISSION_METHOD = "session/request_permission";
// ACP tool kinds this probe is willing to auto-approve. The recorded native
// shape for the CLI's write_file/edit_file tools is kind "edit".
const EDIT_TOOL_KINDS = new Set(["edit"]);

/** Canonical, Windows-aware path form; null when not a usable string. */
function canonicalPath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  let s = p.trim();
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  try {
    s = path.resolve(s);
  } catch {
    return null;
  }
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** True only when `target` resolves STRICTLY inside `root`. */
function isStrictlyInside(root, target) {
  const r = canonicalPath(root);
  const t = canonicalPath(target);
  if (!r || !t) return false;
  const rel = path.relative(r, t);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Select the provider option whose published KIND matches, returning its optionId. */
function pickOptionByKind(options, kind) {
  if (!Array.isArray(options)) return null;
  const found = options.find((o) => o && o.kind === kind && typeof o.optionId === "string" && o.optionId);
  return found ? found.optionId : null;
}

/** Every file path a permission request claims to touch (rawInput keys + locations). */
function permissionTargetCandidates(toolCall) {
  const out = [];
  const raw = toolCall && toolCall.rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["file_path", "path"]) {
      if (typeof raw[key] === "string" && raw[key].trim()) out.push(raw[key]);
    }
  }
  if (toolCall && Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) {
      if (loc && typeof loc.path === "string" && loc.path.trim()) out.push(loc.path);
    }
  }
  return out;
}

/**
 * The ONE permission decision the probe makes. Pure and total.
 * Returns { action, optionId, reason } where action ∈
 *   "allow"  → select optionId (the allow_once kind)
 *   "reject" → select optionId (the reject_once kind)
 *   "cancel" → send session/cancel, answer "cancelled"
 *   "deny"   → fail closed (answer "cancelled", no session cancel; optionId null)
 *   "unhandled" → not a permission request
 */
function decidePermissionRequest({ request, activeSessionId, policy, watchFile, probeRoot }) {
  if (!request || request.method !== PERMISSION_METHOD) {
    return { action: "unhandled", reason: "not-a-permission-request", optionId: null };
  }
  const params = request.params || {};
  if (typeof params.sessionId !== "string" || params.sessionId !== activeSessionId) {
    return { action: "deny", reason: "session-mismatch", optionId: null };
  }
  if (policy === "cancel") {
    return { action: "cancel", reason: "policy-cancel", optionId: null };
  }
  const toolCall = params.toolCall || {};
  const options = params.options;

  if (policy === "reject_once") {
    const rejectId = pickOptionByKind(options, "reject_once");
    if (!rejectId) return { action: "deny", reason: "reject-option-absent", optionId: null };
    return { action: "reject", reason: "policy-reject", optionId: rejectId };
  }
  if (policy !== "allow_once") {
    // A text-only prompt (policy null) or any unexpected policy must never allow.
    return { action: "deny", reason: "no-allow-policy", optionId: null };
  }
  if (typeof watchFile !== "string" || !watchFile.trim()) {
    return { action: "deny", reason: "no-watched-file", optionId: null };
  }
  const kind = typeof toolCall.kind === "string" ? toolCall.kind : null;
  if (!EDIT_TOOL_KINDS.has(kind)) {
    return { action: "deny", reason: "unexpected-tool-kind", detail: kind, optionId: null };
  }
  const candidates = permissionTargetCandidates(toolCall);
  if (candidates.length === 0) {
    return { action: "deny", reason: "no-target-path", optionId: null };
  }
  const target = canonicalPath(watchFile);
  const distinct = new Set();
  for (const c of candidates) {
    const cc = canonicalPath(c);
    if (cc == null || cc !== target) {
      return { action: "deny", reason: "target-mismatch", detail: c, optionId: null };
    }
    distinct.add(cc);
  }
  if (distinct.size !== 1) {
    return { action: "deny", reason: "ambiguous-target", optionId: null };
  }
  if (!isStrictlyInside(probeRoot, watchFile)) {
    return { action: "deny", reason: "watch-file-outside-root", optionId: null };
  }
  const allowId = pickOptionByKind(options, "allow_once");
  if (!allowId) {
    return { action: "deny", reason: "allow-option-absent", optionId: null };
  }
  return { action: "allow", reason: "matched-disposable-target", optionId: allowId };
}

// ---------------------------------------------------------------------------
// CLI resolution + safe spawn
// ---------------------------------------------------------------------------

function findShim(opts) {
  if (opts.cli) return path.resolve(opts.cli);
  if (process.env.CC_ACP_CLI) return path.resolve(process.env.CC_ACP_CLI);
  const appData = process.env.APPDATA;
  if (appData) {
    const candidate = path.join(appData, "npm", "cmdc.cmd");
    if (fs.existsSync(candidate)) return candidate;
  }
  const where = spawnSync("where.exe", ["cmdc.cmd"], { encoding: "utf8", windowsHide: true });
  const first = String(where.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  if (first) return first;
  throw new Error("could not locate the installed Command Code CLI (cmdc.cmd); pass --cli <path>");
}

/** Resolve the CLI's own `.mjs` entry so we can spawn it with node.exe (no cmd shim). */
function resolveCliScript(opts) {
  const shim = findShim(opts);
  if (/\.m?js$|\.cjs$/i.test(shim)) {
    if (!fs.existsSync(shim)) throw new Error("CLI script not found: " + shim);
    return { shim, script: shim, viaNode: true };
  }
  if (!fs.existsSync(shim)) throw new Error("CLI shim not found: " + shim);
  if (/\.exe$/i.test(shim)) return { shim, script: shim, viaNode: false };
  const txt = fs.readFileSync(shim, "utf8");
  const dp0 = path.dirname(shim);
  const candidates = [];
  const re = /"([^"]+\.m?js)"/gi;
  let m;
  while ((m = re.exec(txt)) !== null) {
    let p = m[1].replace("%dp0%", dp0).replace("%~dp0%", dp0 + path.sep);
    p = path.normalize(p);
    if (fs.existsSync(p)) candidates.push(p);
  }
  const script = candidates.find((p) => /dist[\\/](index|cli)\.mjs$/i.test(p)) || candidates[0];
  if (!script) {
    throw new Error("could not extract the CLI .mjs entry from the shim; pass --cli <path-to-index.mjs>");
  }
  return { shim, script, viaNode: true };
}

function cliVersion(resolved) {
  const args = resolved.viaNode ? [resolved.script, "--version"] : ["--version"];
  const file = resolved.viaNode ? process.execPath : resolved.script;
  const r = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return { status: r.status, stdout: String(r.stdout || "").trim(), stderr: String(r.stderr || "").trim() };
}

// ---------------------------------------------------------------------------
// ACP client over NDJSON stdio
// ---------------------------------------------------------------------------

class AcpClient {
  constructor({ label, resolved, cwd, extraEnv, transcript }) {
    this.label = label;
    this.resolved = resolved;
    this.cwd = cwd;
    this.extraEnv = extraEnv || {};
    this.transcript = transcript;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.stderrTail = "";
    this.closed = false;
    this.exited = null;
    this.notifications = [];
    this.serverRequests = [];
    this.onServerRequest = null;
    this.onNotification = null;
  }

  start() {
    const file = this.resolved.viaNode ? process.execPath : this.resolved.script;
    const args = this.resolved.viaNode ? [this.resolved.script, "acp"] : ["acp"];
    this.proc = spawn(file, args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.extraEnv }
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.proc.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.proc.on("error", (err) => this._failAll(err));
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        this._failAll(new Error("process exited"));
        resolve({ code, signal });
      });
    });
    return this;
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.transcript.push({ ts: nowIso(), label: this.label, dir: "s2c", malformed: compact(line) });
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    const isResponse = !("method" in msg) && ("result" in msg || "error" in msg);
    const isRequest = "method" in msg && "id" in msg;
    const isNotification = "method" in msg && !("id" in msg);

    if (isResponse) {
      this.transcript.push({ ts: nowIso(), label: this.label, dir: "s2c", response: compact(msg) });
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }
    if (isRequest) {
      this.transcript.push({ ts: nowIso(), label: this.label, dir: "s2c", request: compact(msg) });
      this.serverRequests.push(msg);
      Promise.resolve()
        .then(() => (this.onServerRequest ? this.onServerRequest(msg) : { __unhandled: true }))
        .then((result) => this._respond(msg.id, result))
        .catch((err) => this._respondError(msg.id, err));
      return;
    }
    if (isNotification) {
      this.notifications.push(msg);
      this.transcript.push({ ts: nowIso(), label: this.label, dir: "s2c", notification: compact(msg) });
      if (this.onNotification) this.onNotification(msg);
    }
  }

  _write(obj) {
    if (this.closed) throw new Error("client closed");
    this.transcript.push({ ts: nowIso(), label: this.label, dir: "c2s", ...compact(obj) });
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method} (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _respond(id, result) {
    this._write({ jsonrpc: "2.0", id, result });
  }

  _respondError(id, err) {
    this._write({ jsonrpc: "2.0", id, error: { code: err?.code ?? -32603, message: String(err?.message || err) } });
  }

  _failAll(err) {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  async stop(graceMs = 8000) {
    if (this.closed) return this.exitInfo ?? null;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    const raced = await Promise.race([
      this.exited.catch(() => null),
      sleep(graceMs).then(() => "timeout")
    ]);
    if (raced === "timeout") {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      await Promise.race([this.exited.catch(() => null), sleep(3000)]);
      this.exitInfo = this.exitInfo ?? { killed: true };
    }
    return this.exitInfo ?? null;
  }
}

// ---------------------------------------------------------------------------
// prompt bookkeeping
// ---------------------------------------------------------------------------

class Probe {
  constructor(opts) {
    this.opts = opts;
    this.runId = opts.runId;
    this.root = opts.testRoot;
    this.artifactsDir = opts.artifactsDir;
    this.transcript = [];
    this.clients = [];
    this.promptCount = 0;
    this.results = {
      meta: {
        run_id: opts.runId,
        started_at: nowIso(),
        platform: process.platform,
        node: process.version,
        cli_shim: null,
        cli_script: null,
        cli_version: null,
        model: opts.model,
        effort: opts.effort,
        with_prompts: opts.withPrompts,
        print_session: opts.printSession
      },
      introspect: {},
      prompts: [],
      cleanup: {},
      findings: [],
      sessions: []
    };
  }

  note(findings) {
    this.results.findings.push({ ts: nowIso(), ...findings });
  }

  dir(name) {
    const d = path.join(this.root, name);
    ensureDir(d);
    return d;
  }

  track(client) {
    this.clients.push(client);
    return client;
  }

  async stopAll() {
    for (const c of this.clients) {
      const info = await c.stop();
      this.results.cleanup[c.label + "_exit"] = info;
    }
  }

  registerSession(cfg) {
    this.results.sessions.push({ ...cfg, created_at: nowIso() });
  }

  /** Ask the ACP server to run one prompt; drives the permission flow. */
  async runPrompt(client, { sessionId, text, policy, watchFile, expectedContent, label }) {
    if (this.promptCount >= MAX_PROMPTS) throw new Error("prompt budget exceeded (" + MAX_PROMPTS + ")");
    this.promptCount += 1;
    const promptNumber = this.promptCount;
    const record = {
      n: promptNumber,
      label,
      sessionId,
      process_label: client.label,
      cwd: client.cwd,
      started_at: nowIso(),
      text,
      policy,
      approvals: [],
      notifications_before_result: [],
      result: null,
      error: null,
      file: null,
      stop_reason: null,
      usage: null,
      per_turn_usage: null
    };
    this.results.prompts.push(record);

    const seenNotifications = [];
    const onNotification = (msg) => seenNotifications.push(msg);

    client.onNotification = onNotification;
    client.onServerRequest = async (msg) => {
      if (msg.method !== PERMISSION_METHOD) {
        return { __unhandled: true };
      }
      // The single decision path — the same function the offline self-test drives.
      const policyName = typeof policy === "function" ? policy(record.approvals.length) : policy;
      const decision = decidePermissionRequest({
        request: msg,
        activeSessionId: sessionId,
        policy: policyName,
        watchFile: watchFile ?? null,
        probeRoot: this.root
      });
      const approval = {
        at: nowIso(),
        request_id: msg.id,
        decision,
        toolCall: sanitize(msg.params?.toolCall),
        options: sanitize(msg.params?.options),
        meta: sanitize(msg.params?._meta)
      };
      if (watchFile) {
        approval.file_state_while_pending = readIfExists(watchFile);
      }
      record.approvals.push(approval);

      if (decision.action === "cancel") {
        // Cancel the whole session while the approval is pending (do not answer it).
        client.notify("session/cancel", { sessionId });
        return { outcome: { outcome: "cancelled" } };
      }
      if (decision.optionId) {
        return { outcome: { outcome: "selected", optionId: decision.optionId } };
      }
      // "deny" / fail-closed: refuse this approval without cancelling the session.
      return { outcome: { outcome: "cancelled" } };
    };

    let timeoutHandle;
    try {
      const resultPromise = client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }]
      }, this.opts.promptTimeoutMs);
      const result = await resultPromise;
      record.result = sanitize(result);
      if (result?.error) {
        record.error = sanitize(result.error);
      } else {
        record.stop_reason = result?.result?.stopReason ?? null;
        record.usage = sanitize(result?.result?.usage ?? null);
        record.per_turn_usage = sanitize(result?.result?._meta?.usage ?? null);
      }
    } catch (err) {
      record.error = String(err?.message || err);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      client.onNotification = null;
      client.onServerRequest = null;
    }

    record.notifications_before_result = seenNotifications.map((m) => ({
      update: m.params?.update?.sessionUpdate ?? null,
      keys: m.params?.update ? Object.keys(m.params.update) : []
    }));
    if (watchFile) {
      record.file = { path: watchFile, ...readIfExists(watchFile) };
      if (expectedContent != null) {
        const got = record.file.content ?? "";
        record.file.matches_expected = got.replace(/\r?\n$/, "") === expectedContent.replace(/\r?\n$/, "");
      }
    }
    record.finished_at = nowIso();
    return record;
  }
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

function unwrap(resp) {
  return resp?.error ? { ok: false, error: resp.error } : { ok: true, result: resp.result };
}

async function initialize(client) {
  const resp = await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "cc-acp-compat-probe", version: "0.1.0" }
  }, 20000);
  return resp;
}

async function introspectSessionsAndConfig(probe, p1, d1, otherCwd) {
  const out = probe.results.introspect;

  // initialize
  const initResp = await initialize(p1);
  out.initialize = compact(initResp);
  probe.note({
    area: "initialize",
    observed: unwrap(initResp).ok ? "protocol answered" : "error",
    protocolVersion: initResp?.result?.protocolVersion ?? null,
    loadSession: initResp?.result?.agentCapabilities?.loadSession ?? null,
    sessionCapabilities: initResp?.result?.agentCapabilities?.sessionCapabilities ?? null,
    agentInfo: initResp?.result?.agentInfo ?? null,
    authMethods: initResp?.result?.authMethods ?? null
  });

  // session/new
  const newResp = await p1.request("session/new", { cwd: d1, mcpServers: [] }, 30000);
  out.session_new = compact(newResp);
  const s1 = newResp?.result?.sessionId ?? null;
  out.session_id = s1;
  if (s1) probe.registerSession({ label: "S1", session_id: s1, cwd: d1, process: p1.label, kind: "acp-session/new" });
  probe.note({
    area: "session/new",
    observed: s1 ? "created" : "failed",
    session_id: s1,
    modes: newResp?.result?.modes ?? null,
    model: newResp?.result?.models?.currentModelId ?? null,
    effort: newResp?.result?.configOptions?.find?.((o) => o.id === "effort")?.currentValue ?? null
  });

  // brief settle for the available_commands_update notification
  await sleep(400);

  // modes round-trip
  const modeIds = (newResp?.result?.modes?.availableModes ?? []).map((m) => m.id);
  out.modes = { available: newResp?.result?.modes?.availableModes ?? null, current: newResp?.result?.modes?.currentModeId ?? null, set_results: {} };
  for (const id of ["default", "auto-accept", "plan", "dont-ask", "bypass"]) {
    try {
      const r = await p1.request("session/set_mode", { sessionId: s1, modeId: id }, 15000);
      out.modes.set_results[id] = unwrap(r).ok ? { ok: true, result: sanitize(r.result) } : { ok: false, error: sanitize(r.error) };
    } catch (err) {
      out.modes.set_results[id] = { ok: false, transport: String(err.message || err) };
    }
    await sleep(120);
  }
  const badMode = await p1.request("session/set_mode", { sessionId: s1, modeId: "definitely-not-a-mode" }, 15000);
  out.modes.set_invalid = unwrap(badMode).ok ? { ok: true } : { ok: false, error: sanitize(badMode.error) };
  // return to the documented Standard mode for the edit micro-tests
  await p1.request("session/set_mode", { sessionId: s1, modeId: "default" }, 15000);
  await sleep(200);

  // config option / model / effort (all non-prompt)
  const effortOf = (optsList) => {
    const e = (optsList || []).find((o) => o.id === "effort") || null;
    return { current: e?.currentValue ?? null, options: e?.options?.map((o) => o.value) ?? null };
  };
  const modelOf = (optsList) => (optsList || []).find((o) => o.id === "model")?.currentValue ?? null;
  const cfg = out.config = { initial: compact(newResp?.result?.configOptions ?? null) };
  const initialEffort = effortOf(newResp?.result?.configOptions);
  cfg.effort_current_initial = initialEffort.current;
  cfg.effort_available_initial = initialEffort.options;
  cfg.model_initial = modelOf(newResp?.result?.configOptions);
  cfg.available_model_count = ((newResp?.result?.configOptions ?? []).find((o) => o.id === "model")?.options ?? []).length;

  const setEffortHigh = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: probe.opts.effort }, 20000);
  cfg.set_effort_high = unwrap(setEffortHigh).ok ? { ok: true, effort: effortOf(setEffortHigh.result?.configOptions) } : { ok: false, error: compact(setEffortHigh.error) };

  // Can the provider default be restored after an explicit effort?
  const setEffortDefault = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: "default" }, 20000);
  cfg.set_effort_default_after_explicit = unwrap(setEffortDefault).ok ? { ok: true, effort: effortOf(setEffortDefault.result?.configOptions) } : { ok: false, error: compact(setEffortDefault.error) };

  // Switch model; observe whether explicit effort carries over or resets to default.
  const switch1 = await p1.request("session/set_config_option", { sessionId: s1, configId: "model", value: probe.opts.otherModel }, 30000);
  cfg.switch_to_other_model = unwrap(switch1).ok ? { ok: true, model: modelOf(switch1.result?.configOptions), effort: effortOf(switch1.result?.configOptions) } : { ok: false, error: compact(switch1.error) };
  if (unwrap(switch1).ok) {
    const setDefaultOnFresh = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: "default" }, 20000);
    cfg.set_effort_default_on_fresh_model = unwrap(setDefaultOnFresh).ok ? { ok: true, effort: effortOf(setDefaultOnFresh.result?.configOptions) } : { ok: false, error: compact(setDefaultOnFresh.error) };
    const setHighOnOther = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: "high" }, 20000);
    cfg.set_effort_high_on_other_model = unwrap(setHighOnOther).ok ? { ok: true, effort: effortOf(setHighOnOther.result?.configOptions) } : { ok: false, error: compact(setHighOnOther.error) };
    const setDefaultAgain = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: "default" }, 20000);
    cfg.set_effort_default_again_other_model = unwrap(setDefaultAgain).ok ? { ok: true, effort: effortOf(setDefaultAgain.result?.configOptions) } : { ok: false, error: compact(setDefaultAgain.error) };
  }
  await sleep(800); // allow a model switch to settle
  const switchBack = await p1.request("session/set_config_option", { sessionId: s1, configId: "model", value: probe.opts.model }, 30000);
  cfg.switch_back = unwrap(switchBack).ok ? { ok: true, model: modelOf(switchBack.result?.configOptions), effort: effortOf(switchBack.result?.configOptions) } : { ok: false, error: compact(switchBack.error) };
  const reapplyEffort = await p1.request("session/set_config_option", { sessionId: s1, configId: "effort", value: probe.opts.effort }, 20000);
  cfg.reapply_effort = unwrap(reapplyEffort).ok ? { ok: true, effort: effortOf(reapplyEffort.result?.configOptions) } : { ok: false, error: compact(reapplyEffort.error) };

  const setModelDirect = await p1.request("session/set_model", { sessionId: s1, modelId: probe.opts.model }, 20000);
  cfg.set_model_method = unwrap(setModelDirect).ok ? { ok: true, result: compact(setModelDirect.result) } : { ok: false, error: compact(setModelDirect.error) };

  const badConfig = await p1.request("session/set_config_option", { sessionId: s1, configId: "bogus", value: "x" }, 15000);
  cfg.set_config_invalid = unwrap(badConfig).ok ? { ok: true } : { ok: false, error: compact(badConfig.error) };

  const badModel = await p1.request("session/set_config_option", { sessionId: s1, configId: "model", value: "no-such-provider/no-such-model" }, 15000);
  cfg.set_model_invalid = unwrap(badModel).ok ? { ok: true } : { ok: false, error: compact(badModel.error) };

  // structured error shapes
  out.errors = {};
  const unknownMethod = await p1.request("session/definitely-not-a-method", { sessionId: s1 }, 15000);
  out.errors.unknown_method = compact(unknownMethod.error);
  const unknownSession = await p1.request("session/prompt", { sessionId: "00000000-0000-0000-0000-000000000000", prompt: [{ type: "text", text: "noop" }] }, 15000);
  out.errors.unknown_session = compact(unknownSession.error);
  const missingParam = await p1.request("session/set_mode", { sessionId: s1 }, 15000);
  out.errors.set_mode_missing_modeId = compact(missingParam.error);

  // session/list — observed shape is { sessions: [...] }
  const listResp = await p1.request("session/list", { cwd: d1 }, 20000);
  const listArr = Array.isArray(listResp?.result) ? listResp.result : (listResp?.result?.sessions ?? []);
  out.session_list = unwrap(listResp).ok
    ? { ok: true, shape: Array.isArray(listResp.result) ? "array" : Object.keys(listResp.result || {}), count: listArr.length, contains_s1: listArr.some((s) => s.sessionId === s1), sample: compact(listArr.slice(0, 3)) }
    : { ok: false, error: compact(listResp.error) };

  // replay / resume (non-prompt)
  p1.notifications.length = 0;
  const loadResp = await p1.request("session/load", { sessionId: s1, cwd: d1, mcpServers: [] }, 25000);
  out.session_load = unwrap(loadResp).ok ? { ok: true, result: compact(loadResp.result), replay_updates: p1.notifications.length } : { ok: false, error: compact(loadResp.error) };
  p1.notifications.length = 0;
  const resumeResp = await p1.request("session/resume", { sessionId: s1, cwd: d1, mcpServers: [] }, 25000);
  out.session_resume = unwrap(resumeResp).ok ? { ok: true, result: compact(resumeResp.result), replay_updates: p1.notifications.length } : { ok: false, error: compact(resumeResp.error) };

  // one-process-one-cwd lease
  const leaseResp = await p1.request("session/new", { cwd: otherCwd, mcpServers: [] }, 15000);
  out.cwd_lease = unwrap(leaseResp).ok ? { ok: true } : { ok: false, error: compact(leaseResp.error) };

  return s1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    withPrompts: false,
    printSession: false,
    introspect: false,
    keepTemp: false,
    model: "deepseek/deepseek-v4.1-flash",
    otherModel: "deepseek/deepseek-v4-pro",
    effort: "high",
    opTimeoutMs: 30000,
    promptTimeoutMs: 150000,
    artifactsDir: DEFAULT_ARTIFACTS,
    runId: null,
    cli: null,
    refreshExample: null,
    selfTest: false,
    evidenceRun: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null || v.startsWith("--")) throw new Error("missing value for " + a);
      i += 1;
      return v;
    };
    switch (a) {
      case "--with-prompts": opts.withPrompts = true; break;
      case "--no-prompts": opts.withPrompts = false; break;
      case "--print-session": opts.printSession = true; break;
      case "--introspect": opts.introspect = true; break;
      case "--keep-temp": opts.keepTemp = true; break;
      case "--model": opts.model = next(); break;
      case "--other-model": opts.otherModel = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--op-timeout-seconds": opts.opTimeoutMs = Number(next()) * 1000; break;
      case "--prompt-timeout-seconds": opts.promptTimeoutMs = Number(next()) * 1000; break;
      case "--artifacts": opts.artifactsDir = path.resolve(next()); break;
      case "--run-id": opts.runId = next(); break;
      case "--cli": opts.cli = next(); break;
      case "--refresh-example": opts.refreshExample = next(); break;
      case "--self-test": opts.selfTest = true; break;
      case "--evidence-run": opts.evidenceRun = next(); break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error("unknown argument: " + a);
    }
  }
  return opts;
}

function usage() {
  process.stdout.write([
    "Independent probe for the installed Command Code ACP endpoint (cmdc acp).",
    "",
    "Usage: node scripts/probe-command-code-acp.cjs [options]",
    "",
    "  --introspect                 only protocol introspection (no model prompts)",
    "  --with-prompts               run the bounded model micro-tests (<= 6 prompts)",
    "  --print-session              also create a print-mode session and load it over ACP",
    "  --model <id>                 model under test (default deepseek/deepseek-v4.1-flash)",
    "  --other-model <id>           model used for the switch test (default deepseek/deepseek-v4-pro)",
    "  --effort <level>             explicit reasoning effort (default high)",
    "  --prompt-timeout-seconds <n> per-prompt bound (default 150)",
    "  --keep-temp                  keep the disposable test directories",
    "  --artifacts <dir>            evidence output root",
    "  --cli <path>                 cmdc.cmd shim or CLI index.mjs",
    "  --refresh-example <runDir>   rebuild native-example.json from an existing run (no model calls)",
    "  --self-test                  offline boundary check of the permission decision (no CLI, no model calls)",
    "  --evidence-run <runDir>      runDir whose recorded native approval shape the self-test uses",
    ""
  ].join("\n") + "\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(String(err.message || err) + "\n");
    usage();
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    usage();
    return;
  }
  if (opts.refreshExample) {
    refreshExample(opts.refreshExample);
    return;
  }
  if (opts.selfTest) {
    process.exitCode = selfTest(opts);
    return;
  }
  if (!opts.withPrompts && !opts.introspect) {
    // default stance: introspection only; prompts are strictly opt-in
    opts.introspect = true;
  }

  const runId = opts.runId || "ccacp-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
  const artifactsDir = path.join(opts.artifactsDir, runId);
  ensureDir(artifactsDir);
  const testRoot = path.join(os.tmpdir(), "cc-acp-probe-" + runId);
  ensureDir(testRoot);
  opts.runId = runId;
  opts.testRoot = testRoot;
  opts.artifactsDir = artifactsDir;

  const probe = new Probe(opts);
  const resolved = resolveCliScript(opts);
  probe.results.meta.cli_shim = resolved.shim;
  probe.results.meta.cli_script = resolved.script;
  probe.results.meta.cli_version = cliVersion(resolved);

  process.stdout.write(`[probe] run ${runId}\n`);
  process.stdout.write(`[probe] cli ${resolved.script} (v${probe.results.meta.cli_version.stdout || "?"})\n`);
  process.stdout.write(`[probe] artifacts ${artifactsDir}\n`);

  const d1 = probe.dir("d1");
  const d2 = probe.dir("d2");
  const d3 = probe.dir("d3");

  const mkClient = (label, cwd) =>
    probe.track(
      new AcpClient({ label, resolved, cwd, transcript: probe.transcript }).start()
    );

  const p1 = mkClient("P1", d1);
  const p2 = mkClient("P2", d2);
  let p3 = null;

  try {
    const s1 = await introspectSessionsAndConfig(probe, p1, d1, d2);

    // P2 session for the overlapping pair
    await initialize(p2);
    const new2 = await p2.request("session/new", { cwd: d2, mcpServers: [] }, 30000);
    const s2 = new2?.result?.sessionId ?? null;
    probe.results.introspect.session_new_p2 = sanitize(new2);
    if (s2) probe.registerSession({ label: "S2", session_id: s2, cwd: d2, process: p2.label, kind: "acp-session/new" });

    if (opts.withPrompts) {
      await runPromptPhase(probe, { p1, s1, d1, p2, s2, d2 });
    }

    if (opts.printSession) {
      await printSessionPhase(probe, resolved, d3, mkClient);
    }

    // close sessions cleanly
    if (s1) {
      probe.results.introspect.session_close = await safeRequest(p1, "session/close", { sessionId: s1 }, 15000);
    }
    if (s2) {
      probe.results.introspect.session_close_p2 = await safeRequest(p2, "session/close", { sessionId: s2 }, 15000);
    }
  } catch (err) {
    probe.results.fatal = String(err?.stack || err);
    process.stderr.write("[probe] fatal: " + String(err?.message || err) + "\n");
    process.exitCode = 1;
  } finally {
    await probe.stopAll();
    writeArtifacts(probe);
    if (!opts.keepTemp) {
      rmTestDir(d1);
      rmTestDir(d2);
      rmTestDir(d3);
      rmTestDir(testRoot);
    }
  }

  // concise console summary
  process.stdout.write("\n[probe] summary\n");
  for (const f of probe.results.findings) {
    process.stdout.write(`  - ${f.area}: ${f.observed ?? ""}${f.error ? " (" + (f.error.message || JSON.stringify(f.error)) + ")" : ""}\n`);
  }
  process.stdout.write(`[probe] prompts used: ${probe.promptCount}/${MAX_PROMPTS}\n`);
  process.stdout.write(`[probe] evidence: ${artifactsDir}\n`);
}

async function safeRequest(client, method, params, timeoutMs) {
  try {
    const r = await client.request(method, params, timeoutMs);
    return unwrap(r).ok ? { ok: true, result: compact(r.result) } : { ok: false, error: compact(r.error) };
  } catch (err) {
    return { ok: false, transport: String(err.message || err) };
  }
}

async function runPromptPhase(probe, ctx) {
  const { p1, s1, d1, p2, s2, d2 } = ctx;
  const mk = probe.runId;

  // --- overlapping pair: A in P1/S1 (edit allow_once) and B in P2/S2 (tiny text) ---
  const fA = path.join(d1, `probe-${mk}-allow.txt`);
  const markA = `CCACP-ALLOW-${mk}`;
  const textA =
    `Create a new file named "${path.basename(fA)}" in the current working directory. ` +
    `Its content must be exactly this single line: ${markA} ` +
    `Then reply with exactly: DONE. Do not ask questions.`;

  const markB = `CCACP-PONG-${mk}`;
  const textB = `Reply with exactly ${markB} and nothing else.`;

  const promptA = probe.runPrompt(p1, {
    sessionId: s1,
    text: textA,
    policy: "allow_once",
    watchFile: fA,
    expectedContent: markA,
    label: "A-edit-allow-overlap"
  });
  const promptB = probe.runPrompt(p2, {
    sessionId: s2,
    text: textB,
    policy: null,
    watchFile: null,
    label: "B-tiny-text-overlap"
  });

  const [recA, recB] = await Promise.all([promptA, promptB]);
  probe.note({
    area: "overlap",
    observed: "A(edit) and B(text) ran on two processes concurrently",
    a_started: recA.started_at,
    b_started: recB.started_at,
    a_approvals: recA.approvals.length,
    a_file_changed: recA.file?.content != null ? recA.file.matches_expected === true : false,
    b_stop_reason: recB.stop_reason
  });

  // --- C: reject_once must leave the file untouched ---
  const fC = path.join(d1, `probe-${mk}-reject.txt`);
  const markC = `CCACP-REJECT-${mk}`;
  const textC =
    `Create a new file named "${path.basename(fC)}" in the current working directory containing exactly: ${markC} ` +
    `Then reply with exactly: DONE.`;
  await probe.runPrompt(p1, {
    sessionId: s1,
    text: textC,
    policy: "reject_once",
    watchFile: fC,
    expectedContent: markC,
    label: "C-edit-reject"
  });

  // --- D: cancel while a permission request is pending ---
  const fD = path.join(d1, `probe-${mk}-cancel.txt`);
  const markD = `CCACP-CANCEL-${mk}`;
  const textD =
    `Create a new file named "${path.basename(fD)}" in the current working directory containing exactly: ${markD} ` +
    `Then reply with exactly: DONE.`;
  await probe.runPrompt(p1, {
    sessionId: s1,
    text: textD,
    policy: "cancel",
    watchFile: fD,
    expectedContent: markD,
    label: "D-edit-cancel-during-approval"
  });

  // prove no stale approval leaks into the next run: a fresh tiny prompt must
  // complete without any permission request at all.
  p1.serverRequests.length = 0;
  await probe.runPrompt(p1, {
    sessionId: s1,
    text: `Reply with exactly CCACP-AFTER-CANCEL-${mk} and nothing else.`,
    policy: null,
    watchFile: null,
    label: "E-after-cancel-clean"
  });
  probe.results.after_cancel_server_requests = p1.serverRequests.length;
  probe.note({
    area: "cancel-cleanup",
    observed: "post-cancel prompt produced no permission request",
    server_requests_during_post_cancel_prompt: p1.serverRequests.length
  });

  // session/list after real content exists (a fresh session/new alone did not appear)
  const listAfter = await safeRequest(p1, "session/list", { cwd: d1 }, 20000);
  const arrAfter = listAfter.ok ? (Array.isArray(listAfter.result) ? listAfter.result : (listAfter.result?.sessions ?? [])) : [];
  probe.results.session_list_after_prompts = {
    ok: listAfter.ok,
    count: arrAfter.length,
    contains_s1: arrAfter.some((s) => s.sessionId === s1),
    sample: compact(arrAfter.slice(0, 3))
  };

  const sampleWithUsage = probe.results.prompts.find((p) => p.usage);
  const usageUpdates = probe.transcript.filter((e) => e.dir === "s2c" && e.notification?.params?.update?.sessionUpdate === "usage_update");
  probe.note({
    area: "usage",
    observed: "ACP prompt-result usage + usage_update fields",
    prompt_result_usage_fields: sampleWithUsage?.usage ? Object.keys(sampleWithUsage.usage) : [],
    per_turn_usage_fields: sampleWithUsage?.per_turn_usage ? Object.keys(sampleWithUsage.per_turn_usage) : [],
    first_usage_update: usageUpdates[0]?.notification?.params?.update ?? null
  });
}

async function printSessionPhase(probe, resolved, d3, mkClient) {
  // Create a real print-mode session, then load it over ACP from a process
  // bound to the same directory, to test transcript replay/continuity.
  const entry = resolved.viaNode ? resolved.script : resolved.shim;
  const file = resolved.viaNode ? process.execPath : resolved.script;
  const marker = `CCACP-PRINT-${probe.runId}`;
  const args = resolved.viaNode
    ? [entry, "-p", "--output-format", "json", "--model", probe.opts.model, "--effort", probe.opts.effort, "--skip-onboarding"]
    : ["-p", "--output-format", "json", "--model", probe.opts.model, "--effort", probe.opts.effort, "--skip-onboarding"];

  const child = spawn(file, args, { cwd: d3, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
  child.stdin.write(`Reply with exactly ${marker} and nothing else.\n`);
  child.stdin.end();

  const done = await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve("timeout");
    }, probe.opts.promptTimeoutMs);
    child.on("exit", () => {
      clearTimeout(t);
      resolve("exit");
    });
  });
  probe.promptCount += 1;

  let printSessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const stack = [obj, obj?.event, obj?.session, obj?.conversation, obj?.message];
    for (const s of stack) {
      if (!s || typeof s !== "object") continue;
      for (const k of ["session_id", "sessionId", "thread_id", "threadId", "id"]) {
        if (typeof s[k] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s[k])) {
          printSessionId = printSessionId || s[k];
        }
      }
    }
  }
  probe.results.print_session = {
    exit: done,
    marker,
    session_id: printSessionId,
    stdout_tail: sanitize(stdout.slice(-2500)),
    stderr_tail: sanitize(stderr)
  };
  if (printSessionId) {
    probe.registerSession({ label: "S3", session_id: printSessionId, cwd: d3, process: "print-mode", kind: "print -p --output-format json" });
  }

  if (!printSessionId) return;

  const p3 = mkClient("P3", d3);
  await initialize(p3);
  const new3 = await p3.request("session/new", { cwd: d3, mcpServers: [] }, 30000);
  probe.results.print_session.acp_new = sanitize(new3);
  const s3b = new3?.result?.sessionId ?? null;
  if (s3b) probe.registerSession({ label: "S3b", session_id: s3b, cwd: d3, process: p3.label, kind: "acp-session/new" });

  p3.notifications.length = 0;
  const load3 = await p3.request("session/load", { sessionId: printSessionId, cwd: d3, mcpServers: [] }, 30000);
  probe.results.print_session.acp_load = {
    ok: !load3?.error,
    error: sanitize(load3?.error ?? null),
    result_keys: load3?.result ? Object.keys(load3.result) : null,
    replay_update_count: p3.notifications.length,
    replay_update_kinds: p3.notifications.map((n) => n.params?.update?.sessionUpdate ?? null).slice(0, 40)
  };
  const listAfter = await p3.request("session/list", { cwd: d3 }, 20000);
  const listArr2 = Array.isArray(listAfter?.result) ? listAfter.result : (listAfter?.result?.sessions ?? []);
  probe.results.print_session.acp_list_contains = listArr2.some((s) => s.sessionId === printSessionId);
  await safeRequest(p3, "session/close", { sessionId: s3b }, 15000);
  await p3.stop();
}

// ---------------------------------------------------------------------------
// evidence emission
// ---------------------------------------------------------------------------

function writeArtifacts(probe) {
  const dir = probe.artifactsDir;
  ensureDir(dir);
  const sanitizeAll = (v) => compact(v);

  fs.writeFileSync(path.join(dir, "transcript.jsonl"), probe.transcript.map((e) => JSON.stringify(e)).join("\n") + "\n");

  probe.results.meta.finished_at = nowIso();
  probe.results.meta.prompt_count = probe.promptCount;
  probe.results.meta.prompt_budget = MAX_PROMPTS;
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(sanitizeAll(probe.results), null, 2) + "\n");

  // compact native example for the migration consumer: one example per distinct
  // session/update kind, plus one permission request and one prompt result.
  fs.writeFileSync(path.join(dir, "native-example.json"), JSON.stringify(sanitizeAll(buildNativeExample(probe.transcript, probe.results)), null, 2) + "\n");
}

/** Build the compact native-shape example from persisted evidence (see refreshExample). */
function buildNativeExample(transcript, results) {
  const byKind = new Map();
  for (const e of transcript) {
    if (e.dir === "s2c" && e.notification?.params?.update?.sessionUpdate) {
      const kind = e.notification.params.update.sessionUpdate;
      if (!byKind.has(kind)) byKind.set(kind, e.notification.params);
    }
  }
  return {
    note: "Sanitized, compact native ACP shapes observed from the installed Command Code 1.74.0 `cmdc acp` endpoint.",
    initialize: results.introspect?.initialize?.result ?? null,
    session_new: results.introspect?.session_new?.result ?? null,
    session_update_examples: [...byKind.entries()].map(([kind, params]) => ({ kind, params })),
    permission_request_examples: transcript
      .filter((e) => e.dir === "s2c" && e.request && e.request.method === "session/request_permission")
      .map((e) => e.request.params)
      .slice(0, 2),
    prompt_result_examples: (results.prompts || [])
      .filter((p) => p.result && !p.result.error)
      .map((p) => p.result.result)
      .slice(0, 3),
    error_examples: {
      unknown_method: results.introspect?.errors?.unknown_method ?? null,
      unknown_session: results.introspect?.errors?.unknown_session ?? null,
      set_mode_invalid: results.introspect?.modes?.set_invalid ?? null
    }
  };
}

/** Rebuild native-example.json from an existing run's persisted evidence (no model calls). */
function refreshExample(runDir) {
  const dir = path.resolve(runDir);
  const transcript = fs.readFileSync(path.join(dir, "transcript.jsonl"), "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const results = JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8"));
  const out = path.join(dir, "native-example.json");
  fs.writeFileSync(out, JSON.stringify(compact(buildNativeExample(transcript, results)), null, 2) + "\n");
  process.stdout.write("[probe] refreshed " + out + "\n");
}

// ---------------------------------------------------------------------------
// Offline self-test of the permission boundary (no CLI, no model calls).
// It drives decidePermissionRequest() — the SAME function the live handler uses.
// ---------------------------------------------------------------------------

function mut(obj, fn) {
  fn(obj);
  return obj;
}

/** The probe's temp root that contains `p` (the ancestor named cc-acp-probe-*). */
function findProbeRoot(p) {
  const abs = path.resolve(p);
  const parts = abs.split(/[\\/]/);
  const idx = parts.findIndex((s) => s.startsWith("cc-acp-probe-"));
  return idx >= 0 ? parts.slice(0, idx + 1).join(path.sep) : path.dirname(abs);
}

function findLatestRunWithExample(root) {
  if (!fs.existsSync(root)) return null;
  const runs = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(root, e.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(dir, "native-example.json")).mtimeMs;
      } catch {
        return null;
      }
      return { dir, mtime };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return runs[0] ? runs[0].dir : null;
}

function selfTest(opts) {
  const say = (s) => process.stdout.write(s + "\n");
  const artifactsRoot = opts.artifactsDir;
  const runDir = opts.evidenceRun ? path.resolve(opts.evidenceRun) : findLatestRunWithExample(artifactsRoot);
  if (!runDir) {
    say("[self-test] FAIL: no run with native-example.json under " + artifactsRoot);
    return 1;
  }
  let example;
  try {
    example = JSON.parse(fs.readFileSync(path.join(runDir, "native-example.json"), "utf8"));
  } catch (err) {
    say("[self-test] FAIL: cannot read native-example.json: " + err.message);
    return 1;
  }
  const recorded = (example.permission_request_examples || [])[0];
  if (!recorded || !recorded.toolCall || !recorded.toolCall.rawInput) {
    say("[self-test] FAIL: recorded permission_request_examples[0] lacks toolCall/rawInput");
    return 1;
  }
  const sessionId = recorded.sessionId;
  const target = recorded.toolCall.rawInput.file_path;
  const probeRoot = findProbeRoot(target);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const validRequest = () => ({ jsonrpc: "2.0", id: 99, method: PERMISSION_METHOD, params: clone(recorded) });
  const recordedAllowId = pickOptionByKind(recorded.options, "allow_once");
  const recordedRejectId = pickOptionByKind(recorded.options, "reject_once");
  const sibling = path.join(path.dirname(target), "cc-acp-self-test-sibling.txt");
  const outside = path.join(os.tmpdir(), "cc-acp-self-test-outside.txt");

  const cases = [
    { name: "recorded-valid-edit-allow", request: validRequest(), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "allow", optionId: recordedAllowId } },
    { name: "wrong-session", request: mut(validRequest(), (r) => { r.params.sessionId = "00000000-0000-0000-0000-000000000000"; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "wrong-target", request: mut(validRequest(), (r) => { r.params.toolCall.rawInput.file_path = sibling; r.params.toolCall.locations = [{ path: sibling }]; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "out-of-root-target", request: mut(validRequest(), (r) => { r.params.toolCall.rawInput.file_path = outside; r.params.toolCall.locations = [{ path: outside }]; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "extra-conflicting-location", request: mut(validRequest(), (r) => { r.params.toolCall.locations = [{ path: target }, { path: sibling }]; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "non-edit-operation", request: mut(validRequest(), (r) => { r.params.toolCall.kind = "execute"; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "no-watched-file", request: validRequest(), policy: "allow_once", watchFile: null, root: probeRoot, expect: { action: "deny" } },
    { name: "unknown-option", request: mut(validRequest(), (r) => { r.params.options = [{ optionId: "zzz", name: "Z", kind: "other" }]; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "option-id-differs-from-kind", request: mut(validRequest(), (r) => { r.params.options = [{ optionId: "ALLOW_ME_1", name: "Allow", kind: "allow_once" }, { optionId: "STOP_2", name: "Reject", kind: "reject_once" }]; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "allow", optionId: "ALLOW_ME_1" } },
    { name: "text-only-prompt", request: validRequest(), policy: null, watchFile: null, root: probeRoot, expect: { action: "deny" } },
    { name: "wrong-method", request: mut(validRequest(), (r) => { r.method = "session/other"; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "unhandled" } },
    { name: "recorded-reject-preserved", request: validRequest(), policy: "reject_once", watchFile: target, root: probeRoot, expect: { action: "reject", optionId: recordedRejectId } },
    { name: "recorded-cancel-preserved", request: validRequest(), policy: "cancel", watchFile: target, root: probeRoot, expect: { action: "cancel" } },
    { name: "cancel-wrong-session", request: mut(validRequest(), (r) => { r.params.sessionId = "11111111-1111-1111-1111-111111111111"; }), policy: "cancel", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "rawinput-path-conflict", request: mut(validRequest(), (r) => { r.params.toolCall.rawInput.path = sibling; }), policy: "allow_once", watchFile: target, root: probeRoot, expect: { action: "deny" } },
    { name: "watch-file-outside-root", request: mut(validRequest(), (r) => { r.params.toolCall.rawInput.file_path = outside; r.params.toolCall.locations = [{ path: outside }]; }), policy: "allow_once", watchFile: outside, root: probeRoot, expect: { action: "deny" } }
  ];

  say("[self-test] evidence run: " + runDir);
  say("[self-test] recorded target: " + target);
  say("[self-test] probe root: " + probeRoot);
  say("[self-test] recorded allow/reject option ids: " + recordedAllowId + " / " + recordedRejectId);

  let failures = 0;
  let unexpectedAllows = 0;
  for (const c of cases) {
    const got = decidePermissionRequest({ request: c.request, activeSessionId: sessionId, policy: c.policy, watchFile: c.watchFile, probeRoot: c.root });
    const actionOk = got.action === c.expect.action;
    const optOk = c.expect.optionId === undefined ? true : got.optionId === c.expect.optionId;
    const allowOk = c.expect.action === "allow" || got.action !== "allow";
    const pass = actionOk && optOk && allowOk;
    if (!pass) failures += 1;
    if (c.expect.action !== "allow" && got.action === "allow") unexpectedAllows += 1;
    say(`[self-test] ${pass ? "PASS" : "FAIL"} ${c.name}: got=${got.action}${got.optionId ? "(" + got.optionId + ")" : ""} expect=${c.expect.action}${c.expect.optionId ? "(" + c.expect.optionId + ")" : ""} reason=${got.reason}`);
  }
  const ok = failures === 0 && unexpectedAllows === 0;
  say(`[self-test] ${ok ? "OK" : "FAILED"}: ${cases.length - failures}/${cases.length} cases; unexpected allows: ${unexpectedAllows}`);
  return ok ? 0 : 1;
}

// The permission boundary is exported so external checks can drive the very same function.
module.exports = { decidePermissionRequest, canonicalPath, isStrictlyInside, pickOptionByKind, permissionTargetCandidates };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write("[probe] unhandled: " + String(err?.stack || err) + "\n");
    process.exitCode = 1;
  });
}
