#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const MCP_ENTRY = path.resolve(__dirname, "..", "dist", "mcp", "server.js");

function usage() {
  process.stdout.write([
    "WebCodex -> CrewDispatch MCP test console",
    "",
    "Usage:",
    "  node scripts/webcodex-mcp-console.cjs dispatch --task <text> --cwd <abs> [--provider command-code|workbuddy-ai] [--model <id>]",
    "  node scripts/webcodex-mcp-console.cjs follow-up --id <job-id> --message <text>",
    "  node scripts/webcodex-mcp-console.cjs status [--id <job-id>]",
    "  node scripts/webcodex-mcp-console.cjs result --id <job-id>",
    "  node scripts/webcodex-mcp-console.cjs cancel --id <job-id> [--wait-seconds <0..60>]",
    "  node scripts/webcodex-mcp-console.cjs tools",
    "",
    "Common test-only options:",
    "  --data-root <abs>       Override JOBQUAY_DATA_ROOT.",
    "  --fixture <abs>         Set JOBQUAY_TEST_FIXTURE for controlled tests.",
    "  --cli-path <abs>        Set JOBQUAY_CLI_PATH.",
    "  --timeout-seconds <n>   Push-wake wait for dispatch/follow-up (default 180).",
    "",
    "dispatch/follow-up starts a temporary loopback callback receiver, passes its",
    "callback_url through the real MCP tool, waits for ONE terminal wake, then calls",
    "crewdispatch_result exactly once. It does not poll crewdispatch_status."
  ].join("\n") + "\n");
}

function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    values.set(key, next);
    i += 1;
  }
  return { positional, values, flags };
}

function required(values, key) {
  const value = values.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error("missing --" + key);
  return value;
}

function numberOption(values, key, fallback) {
  const raw = values.get(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid --" + key + ": " + raw);
  return value;
}

function absoluteOption(values, key) {
  const raw = values.get(key);
  if (raw == null) return null;
  if (!path.isAbsolute(raw)) throw new Error("--" + key + " must be an absolute path");
  return path.resolve(raw);
}

class McpClient {
  constructor(entry, env, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.exited = false;
    this.child = spawn(process.execPath, [entry], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
    this.child.on("exit", () => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("MCP server exited before responding"));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  request(method, params, timeoutMs) {
    if (this.exited) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    const timeout = timeoutMs == null ? 30000 : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error("MCP request timed out: " + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jobquay-webcodex-test-console", version: "1" }
    });
    this.child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }) + "\n");
    return result;
  }

  async callTool(name, args, timeoutMs) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const blocks = Array.isArray(result && result.content) ? result.content : [];
    const block = blocks.find((item) => item && item.type === "text");
    if (!block || typeof block.text !== "string") {
      throw new Error("tool " + name + " returned no text JSON block");
    }
    let body;
    try { body = JSON.parse(block.text); } catch {
      throw new Error("tool " + name + " returned non-JSON text: " + block.text);
    }
    if (result.isError) {
      const error = new Error("tool " + name + " failed: " + block.text);
      error.toolBody = body;
      throw error;
    }
    return body;
  }

  async close() {
    try { this.child.stdin.end(); } catch {}
    if (this.exited) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { this.child.kill(); } catch {}
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function createWakeReceiver(timeoutSeconds) {
  const token = crypto.randomBytes(16).toString("hex");
  let settled = false;
  let resolveWake;
  let rejectWake;
  const wake = new Promise((resolve, reject) => {
    resolveWake = resolve;
    rejectWake = reject;
  });
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/wake/" + token) {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 4096) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      res.statusCode = 204;
      res.end();
      if (!settled) {
        settled = true;
        resolveWake(parsed);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind callback receiver");
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectWake(new Error("timed out waiting for CrewDispatch terminal wake"));
  }, timeoutSeconds * 1000);
  return {
    callbackUrl: "http://127.0.0.1:" + address.port + "/wake/" + token,
    wake,
    async close() {
      clearTimeout(timer);
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function waitForMatchingWake(receiver, expectedJobId) {
  const payload = await receiver.wake;
  if (!payload || payload.job_id !== expectedJobId) {
    throw new Error("received terminal wake for unexpected job: " + JSON.stringify(payload));
  }
  if (typeof payload.status !== "string") {
    throw new Error("terminal wake omitted status: " + JSON.stringify(payload));
  }
  return payload;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (!command || parsed.flags.has("help")) {
    usage();
    return;
  }
  if (!fs.existsSync(MCP_ENTRY)) {
    throw new Error("built MCP entry not found: " + MCP_ENTRY + "; run npm.cmd run build first");
  }

  const env = { ...process.env };
  const dataRoot = absoluteOption(parsed.values, "data-root");
  const fixture = absoluteOption(parsed.values, "fixture");
  const cliPath = absoluteOption(parsed.values, "cli-path");
  if (dataRoot) env.JOBQUAY_DATA_ROOT = dataRoot;
  if (fixture) env.JOBQUAY_TEST_FIXTURE = fixture;
  if (cliPath) env.JOBQUAY_CLI_PATH = cliPath;

  const client = new McpClient(MCP_ENTRY, env, path.resolve(__dirname, ".."));
  try {
    await client.initialize();
    let output;

    if (command === "tools") {
      const listed = await client.request("tools/list", {});
      output = { ok: true, tools: (listed.tools || []).map((tool) => tool.name) };
    } else if (command === "dispatch") {
      const provider = parsed.values.get("provider") || "command-code";
      const args = {
        task: required(parsed.values, "task"),
        cwd: path.resolve(required(parsed.values, "cwd")),
        provider
      };
      if (parsed.values.has("model")) args.model = parsed.values.get("model");
      if (parsed.values.has("permission-mode")) args.permission_mode = parsed.values.get("permission-mode");
      if (parsed.values.has("effort")) args.effort = parsed.values.get("effort");

      const timeoutSeconds = numberOption(parsed.values, "timeout-seconds", 180);
      const receiver = await createWakeReceiver(timeoutSeconds);
      try {
        args.callback_url = receiver.callbackUrl;
        const spawned = await client.callTool("crewdispatch_spawn", args);
        if (!spawned.ok || !spawned.job_id) {
          output = { phase: "spawn", spawn: spawned };
        } else {
          const wake = await waitForMatchingWake(receiver, String(spawned.job_id));
          const result = await client.callTool("crewdispatch_result", { id: String(spawned.job_id) });
          output = { phase: "terminal", spawn: spawned, wake, result };
        }
      } finally {
        await receiver.close();
      }
    } else if (command === "follow-up") {
      const id = required(parsed.values, "id");
      const timeoutSeconds = numberOption(parsed.values, "timeout-seconds", 180);
      const receiver = await createWakeReceiver(timeoutSeconds);
      try {
        const accepted = await client.callTool("crewdispatch_follow_up", {
          id,
          message: required(parsed.values, "message"),
          callback_url: receiver.callbackUrl
        });
        if (!accepted.ok) {
          output = { phase: "follow-up", follow_up: accepted };
        } else {
          const wake = await waitForMatchingWake(receiver, id);
          const result = await client.callTool("crewdispatch_result", { id });
          output = { phase: "terminal", follow_up: accepted, wake, result };
        }
      } finally {
        await receiver.close();
      }
    } else if (command === "status") {
      output = await client.callTool(
        "crewdispatch_status",
        parsed.values.has("id") ? { id: parsed.values.get("id") } : {}
      );
    } else if (command === "result") {
      output = await client.callTool("crewdispatch_result", { id: required(parsed.values, "id") });
    } else if (command === "cancel") {
      output = await client.callTool("crewdispatch_cancel", {
        id: required(parsed.values, "id"),
        wait_seconds: numberOption(parsed.values, "wait-seconds", 5)
      }, 70000);
    } else {
      throw new Error("unknown command: " + command);
    }

    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 1;
});
