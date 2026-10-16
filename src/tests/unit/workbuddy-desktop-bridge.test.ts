import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  AcpClient,
  classifyBridgeError,
  readAcpRpcErrorEvidence,
  ensureWorkBuddyDesktopSidecarReady,
  hostRuntimeId,
  workBuddyDesktopAppCommandPresent,
  workBuddyDesktopMainPid,
  workBuddyDesktopMacRuntimeEnv,
  workBuddyDesktopSidecarEntryPath,
  workBuddyDesktopSidecarSpawnEnv,
  waitForDarwinTerminalAck
} from "../../providers/workbuddy-ai/desktop-bridge";
import { workBuddyCliEnvBuilder, workBuddyOwnerIdentityMatches, workBuddyRecoverySidecarSpawnOptions } from "../../providers/workbuddy-ai/desktop-runtime-helper";
import {
  ACP_FAILURE_CANCELLED,
  ACP_FAILURE_MODEL_ERROR,
  ACP_FAILURE_PERMISSION_REQUIRED,
  acpTerminalResultRecord,
  acpToolApprovalEvidence
} from "../../providers/workbuddy-ai/acp-normalizer";
import {
  WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS,
  WORKBUDDY_QUOTA_ACP_PROMPT_RESULT,
  WORKBUDDY_QUOTA_ERROR_DETAIL,
  WORKBUDDY_TERMINAL_FIXTURE_MODEL,
  WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID
} from "../fixtures/workbuddy-terminal-records";

test("WorkBuddy Darwin terminal rendezvous waits for the worker ACK and is a no-op elsewhere", async () => {
  let checks = 0;
  await waitForDarwinTerminalAck({
    platform: "darwin",
    env: { JOBQUAY_INTERNAL_DARWIN_TERMINAL_ACK: "/tmp/workbuddy-test-terminal-ack" },
    timeoutMs: 100,
    existsFn: () => ++checks >= 3,
    sleepFn: async () => undefined
  });
  assert.equal(checks, 3, "the bridge stays alive until the worker's ACK becomes visible");

  checks = 0;
  await waitForDarwinTerminalAck({
    platform: "linux",
    env: { JOBQUAY_INTERNAL_DARWIN_TERMINAL_ACK: "/tmp/workbuddy-test-terminal-ack" },
    existsFn: () => { checks += 1; return false; }
  });
  assert.equal(checks, 0, "non-Darwin runs never wait on the internal rendezvous");
});

test("sidecar recovery env pins the WorkBuddy AI profile and official Node-mode defaults", () => {
  const env = workBuddyDesktopSidecarSpawnEnv("C:\\Users\\Test\\.workbuddy-ai", {
    PATH: "X",
    CUSTOM_SENTINEL: "keep"
  });
  assert.equal(env.CUSTOM_SENTINEL, "keep");
  assert.equal(env.CODEBUDDY_CONFIG_DIR, "C:\\Users\\Test\\.workbuddy-ai");
  assert.equal(env.WORKBUDDY_CONFIG_DIR, "C:\\Users\\Test\\.workbuddy-ai");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1024");
  assert.equal(env.DISABLE_TELEMETRY, "0");
  assert.equal(env.WORKBUDDY_AT_REST_ENCRYPTION, "fields");
});

test("macOS Desktop runtime env keeps shell essentials but never forwards unrelated provider secrets", () => {
  const env = workBuddyDesktopMacRuntimeEnv("/Users/Test/.workbuddy-ai", {
    HOME: "/Users/Test",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
    SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
    OPENAI_API_KEY: "must-not-leak",
    JOBQUAY_DAEMON_BEARER: "must-not-leak",
    CUSTOM_SECRET: "must-not-leak"
  });
  assert.equal(env.HOME, "/Users/Test");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.SHELL, "/bin/zsh");
  assert.equal(env.SSH_AUTH_SOCK, "/private/tmp/ssh.sock");
  assert.equal(env.CODEBUDDY_CONFIG_DIR, "/Users/Test/.workbuddy-ai");
  assert.equal(env.WORKBUDDY_CONFIG_DIR, "/Users/Test/.workbuddy-ai");
  assert.equal(env.CODEBUDDY_FORCE_HEADLESS_BUNDLE, "1");
  assert.equal(env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, "1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.JOBQUAY_DAEMON_BEARER, undefined);
  assert.equal(env.CUSTOM_SECRET, undefined);
});

test("Desktop host runtime identity lowercases paths only on Windows", () => {
  assert.equal(
    hostRuntimeId("/tmp/WorkBuddyCLI", "plan", null, "/tmp/Workspace", "win32"),
    hostRuntimeId("/tmp/workbuddycli", "plan", null, "/tmp/workspace", "win32")
  );
  assert.notEqual(
    hostRuntimeId("/tmp/WorkBuddyCLI", "plan", null, "/tmp/Workspace", "darwin"),
    hostRuntimeId("/tmp/workbuddycli", "plan", null, "/tmp/workspace", "darwin")
  );
});

test("sidecar recovery derives the packaged sidecar entry from the discovered bundled CLI", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-sidecar-path-"));
  try {
    fs.writeFileSync(path.join(root, "WorkBuddyAI.exe"), "");
    const cli = path.join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "");
    assert.equal(
      workBuddyDesktopSidecarEntryPath(cli),
      path.join(root, "resources", "app.asar", "main", "sidecar-entry.js")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Desktop path derivation stays inside the same WorkBuddy AI app bundle", { skip: process.platform !== "darwin" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-mac-app-"));
  try {
    const contents = path.join(root, "WorkBuddy AI.app", "Contents");
    const appExe = path.join(contents, "MacOS", "Electron");
    const cli = path.join(contents, "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
    fs.mkdirSync(path.dirname(appExe), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(appExe, "");
    fs.writeFileSync(cli, "");
    assert.equal(
      workBuddyDesktopSidecarEntryPath(cli),
      path.join(contents, "Resources", "app.asar", "main", "sidecar-entry.js")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Desktop main-process detection never mistakes a sidecar/helper Electron for the app", () => {
  const appExe = path.resolve("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron");
  const sidecar = path.resolve("/Applications/WorkBuddy AI.app/Contents/Resources/app.asar/main/sidecar-entry.js");
  const other = path.resolve("/Applications/Other.app/Contents/MacOS/Electron");
  assert.equal(workBuddyDesktopAppCommandPresent(appExe, `${appExe}\n`), true);
  assert.equal(workBuddyDesktopAppCommandPresent(appExe, `${appExe} ${sidecar} --token redacted\n`), false);
  assert.equal(workBuddyDesktopAppCommandPresent(appExe, `${other}\n`), false);
});
test("macOS Desktop main-process PID parsing requires exactly one exact command", () => {
  const appExe = path.resolve("/Applications/WorkBuddy AI.app/Contents/MacOS/Electron");
  assert.equal(workBuddyDesktopMainPid(appExe, `  42 ${appExe}\n  43 ${appExe} --helper\n`), 42);
  assert.equal(workBuddyDesktopMainPid(appExe, `  42 ${appExe}\n  44 ${appExe}\n`), null);
  assert.equal(workBuddyDesktopMainPid(appExe, `  43 ${appExe} --helper\n`), null);
});
test("macOS owner identity helper matches only the exact current process incarnation", { skip: process.platform !== "darwin" }, () => {
  const current = require("../../runtime/process").captureProcessIdentity(process.pid);
  assert.ok(current?.createdAtUs);
  assert.equal(workBuddyOwnerIdentityMatches(process.pid, current.createdAtUs), true);
  assert.equal(workBuddyOwnerIdentityMatches(process.pid, current.createdAtUs + 1), false);
});

test("post-reopen helper detaches only the exact WorkBuddy sidecar stdio", () => {
  const entry = "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar/main/sidecar-entry.js";
  const original = { detached: true, stdio: ["ignore", "ignore", "pipe"] };
  assert.deepEqual(
    workBuddyRecoverySidecarSpawnOptions(entry, [entry, "--token", "redacted"], original),
    { detached: true, stdio: ["ignore", "ignore", "ignore"] }
  );
  assert.equal(
    workBuddyRecoverySidecarSpawnOptions(entry, ["/Applications/Other.app/sidecar-entry.js"], original),
    original,
    "unrelated spawns keep their original stdio contract"
  );
});


test("packaged WorkBuddy CLI env builder resolves a uniquely named minified export", () => {
  function buildWorkbuddyCliEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, WORKBUDDY_TEST_ENV: "ok" };
  }
  const resolved = workBuddyCliEnvBuilder({ c: buildWorkbuddyCliEnv });
  assert.equal(resolved, buildWorkbuddyCliEnv);
  assert.deepEqual(resolved({ ELECTRON_RUN_AS_NODE: "1" }), {
    ELECTRON_RUN_AS_NODE: "1",
    WORKBUDDY_TEST_ENV: "ok"
  });
});

test("packaged WorkBuddy CLI env builder fails closed on ambiguous or renamed exports", () => {
  function buildWorkbuddyCliEnv(): NodeJS.ProcessEnv { return {}; }
  const duplicate = Object.defineProperty(() => ({}), "name", { value: "buildWorkbuddyCliEnv" });
  assert.throws(
    () => workBuddyCliEnvBuilder({ a: buildWorkbuddyCliEnv, b: duplicate }),
    /packaged helper API is incompatible: buildWorkbuddyCliEnv/i
  );
  assert.throws(
    () => workBuddyCliEnvBuilder({ c: function otherName() { return {}; } }),
    /packaged helper API is incompatible: buildWorkbuddyCliEnv/i
  );
});

test("macOS missing-sidecar recovery refuses when the WorkBuddy Desktop app is not running", { skip: process.platform !== "darwin" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-missing-sidecar-"));
  try {
    const contents = path.join(root, "WorkBuddy AI.app", "Contents");
    const appExe = path.join(contents, "MacOS", "Electron");
    const cli = path.join(contents, "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
    const configDir = path.join(root, "config");
    fs.mkdirSync(path.dirname(appExe), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(appExe, "");
    fs.writeFileSync(cli, "");
    await assert.rejects(
      ensureWorkBuddyDesktopSidecarReady(cli, configDir),
      /Desktop app is not running/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("ACP prompt preserves the runtime's bounded finishReason beside the stop reason (JQ-20261001-23)", async () => {
  // The installed runtime (cli/dist/codebuddy-headless.js, WorkBuddy Desktop
  // 5.6.2) answers `session/prompt` with `stopReason` plus the model's own
  // finish_reason under `_meta["codebuddy.ai/finishReason"]`, and its own
  // refusal/exception paths publish `_meta["codebuddy.ai/errorMessage"]` (a
  // plain diagnostic or the JSON-encoded classified error response). These are
  // the EXACT scripted transport results, including the shapes that must NOT be
  // accepted (an arbitrary payload, a code frame, and top-level keys the
  // runtime never writes).
  const scriptedResults: unknown[] = [
    { stopReason: "refusal", _meta: { "codebuddy.ai/finishReason": "content_filter" } },
    { stopReason: "refusal", _meta: { "codebuddy.ai/finishReason": "refusal" } },
    { stopReason: "refusal", _meta: { "codebuddy.ai/finishReason": "content_filter<script>".repeat(5) } },
    { stopReason: "refusal", finishReason: "content_filter" },
    { stopReason: "end_turn", _meta: { "codebuddy.ai/finishReason": "stop" } },
    {
      stopReason: "refusal",
      _meta: {
        "codebuddy.ai/finishReason": "content_filter",
        "codebuddy.ai/errorMessage": JSON.stringify({
          code: -32004,
          message: "Model service error: upstream content policy",
          data: { category: "model_service", statusCode: 500, bizCode: "internal-must-not-leak" }
        })
      }
    },
    { stopReason: "refusal", _meta: { "codebuddy.ai/errorMessage": "Blocked by the provider's sensitive-input policy." } },
    { stopReason: "refusal", _meta: { "codebuddy.ai/errorMessage": "    at read (C:\\work\\x.js:1:2)" } },
    { stopReason: "refusal", _meta: { "codebuddy.ai/errorMessage": '{"code":-32004,"message":' } },
    WORKBUDDY_QUOTA_ACP_PROMPT_RESULT
  ];
  let nextResult = 0;
  const openStreams: import("node:http").ServerResponse[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      openStreams.push(res);
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        const result = message.method === "session/prompt" ? scriptedResults[nextResult++] ?? {} : {};
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const client = new AcpClient(`http://127.0.0.1:${address.port}/api/v1/acp`, "test-model");
  try {
    await client.connect();
    assert.deepEqual(
      await client.prompt("s-1", "one"),
      { stopReason: "refusal", finishReason: "content_filter", errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "the content_filter token reaches the bridge intact"
    );
    assert.deepEqual(
      await client.prompt("s-1", "two"),
      { stopReason: "refusal", finishReason: "refusal", errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "an explicit refusal token reaches the bridge intact"
    );
    assert.deepEqual(
      await client.prompt("s-1", "three"),
      { stopReason: "refusal", finishReason: null, errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "an unsafe/over-long finish reason is omitted, never carried"
    );
    assert.deepEqual(
      await client.prompt("s-1", "four"),
      { stopReason: "refusal", finishReason: null, errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "a top-level finishReason is not the installed transport shape and is never invented"
    );
    assert.deepEqual(
      await client.prompt("s-1", "five"),
      { stopReason: "end_turn", finishReason: "stop", errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "a normal end_turn keeps its raw stop reason and publishes its own finish reason"
    );
    assert.deepEqual(
      await client.prompt("s-1", "six"),
      { stopReason: "refusal", finishReason: "content_filter", errorDetail: "Model service error: upstream content policy", finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "the classified error message is extracted; its internal data payload is not carried"
    );
    assert.deepEqual(
      await client.prompt("s-1", "seven"),
      { stopReason: "refusal", finishReason: null, errorDetail: "Blocked by the provider's sensitive-input policy.", finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "the runtime's plain safeMessage is carried as the bounded detail"
    );
    assert.deepEqual(
      await client.prompt("s-1", "eight"),
      { stopReason: "refusal", finishReason: null, errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "a code frame is never carried as a diagnostic"
    );
    assert.deepEqual(
      await client.prompt("s-1", "nine"),
      { stopReason: "refusal", finishReason: null, errorDetail: null, finalText: "", approval: null, approvalOutcome: null, gateOutcome: null },
      "malformed JSON is dropped entirely"
    );
    assert.deepEqual(
      await client.prompt("s-1", "ten"),
      {
        stopReason: "refusal",
        finishReason: "tool_calls",
        errorDetail: WORKBUDDY_QUOTA_ERROR_DETAIL,
        finalText: "",
        approval: null,
        approvalOutcome: null,
        gateOutcome: null
      },
      "the provider's quota-shaped _meta fields reach normalization without being inferred from assistant text"
    );
  } finally {
    await client.close();
    for (const stream of openStreams) stream.end();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// JQ-20261001-24: the installed runtime rejects session/prompt as a JSON-RPC
// error when the model stream ends with finish_reason=error. Its RequestError
// serializes as `{code,message,data}` (read locally from
// cli/dist/codebuddy-headless.js: the model error is code -32004 with
// `data:{category:"model_service",finishReason:"error",reason:"provider_finish_reason_error"}`;
// the runtime's own `isProviderFinishReasonError` matches exactly that reason).
test("a rejected session/prompt preserves the runtime's bounded model-error evidence (JQ-20261001-24)", async () => {
  const scriptedErrors: unknown[] = [
    {
      code: -32004,
      message: "Model service ended the response with an error",
      data: {
        category: "model_service",
        details: "The model stream ended with finish_reason=error.",
        finishReason: "error",
        reason: "provider_finish_reason_error"
      }
    },
    {
      // The message-based precedence must stay intact: a rate-limit message is
      // classified as a rate limit even when model-error evidence is present.
      code: -32004,
      message: "429 Too Many Requests",
      data: { category: "model_service", finishReason: "error", reason: "provider_finish_reason_error" }
    },
    {
      // Unsafe tokens are refused by the boundary: no model-error evidence
      // remains, so the historical generic bridge classification applies.
      code: -32004,
      message: "Model service ended the response with an error",
      data: { category: "model_service", finishReason: "error<script>", reason: "provider_finish_reason_error<script>" }
    }
  ];
  let nextError = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        res.setHeader("content-type", "application/json");
        if (message.method === "session/prompt") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: scriptedErrors[nextError++] ?? {} }));
        } else {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        }
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const client = new AcpClient(`http://127.0.0.1:${address.port}/api/v1/acp`, "test-model");
  try {
    await client.connect();

    const modelError = await client.prompt("s-2", "one").then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(modelError, "the model-service rejection reaches the bridge as an error");
    assert.deepEqual(
      readAcpRpcErrorEvidence(modelError),
      { code: -32004, category: "model_service", finishReason: "error", reason: "provider_finish_reason_error" },
      "only the bounded safe tokens of error.data are retained"
    );
    const classified = classifyBridgeError(modelError);
    assert.equal(classified.exitCode, 16);
    assert.equal(classified.code, ACP_FAILURE_MODEL_ERROR, "the model-service error is not reduced to bridge_error");
    assert.equal(classified.finishReason, "error", "the proven finish reason is carried to the terminal record");
    assert.match(classified.message, /model service ended the response with an error/i);

    // Rate limit precedence is unchanged even beside model-error evidence.
    const rateLimited = await client.prompt("s-2", "two").then(
      () => null,
      (error: unknown) => error
    );
    assert.equal(classifyBridgeError(rateLimited).code, "rate_limit");
    assert.equal(classifyBridgeError(rateLimited).exitCode, 5);
    assert.equal(classifyBridgeError(rateLimited).finishReason, null);

    // An unsafe evidence payload proves nothing: the historical classification stays.
    const unsafe = await client.prompt("s-2", "three").then(
      () => null,
      (error: unknown) => error
    );
    const unsafeEvidence = readAcpRpcErrorEvidence(unsafe);
    assert.equal(unsafeEvidence?.finishReason, null, "an unsafe finish reason token is refused");
    assert.equal(unsafeEvidence?.reason, null, "an unsafe reason token is refused");
    assert.equal(classifyBridgeError(unsafe).code, "bridge_error");
    assert.equal(classifyBridgeError(unsafe).exitCode, 1);
    assert.equal(classifyBridgeError(unsafe).finishReason, null);
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// JQ-20261001-25: the exact live high-risk approval shape (job
// job-mupil5r4-pd51wy) arrives as a `session/request_permission`; CrewDispatch, being
// non-interactive, declines it, and the prompt then completes
// `stopReason=cancelled, finishReason=tool_calls`. That turn must be proven as
// `provider_permission_required`, and the proof must stay inside its own prompt
// turn (a later prompt's plain cancellation keeps provider_cancelled).
test("a declined WorkBuddy tool approval is proven per prompt turn and cannot contaminate the next one (JQ-20261001-25)", async () => {
  const PERMISSION_REQUEST_ID = 9001;
  const replies: unknown[] = [];
  const openPromptStreams = new Map<number, import("node:http").ServerResponse>();
  let promptCount = 0;

  const writePromptResult = (id: number, stream: import("node:http").ServerResponse): void => {
    stream.write(
      "data: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { stopReason: "cancelled", _meta: { "codebuddy.ai/finishReason": "tool_calls" } }
        }) +
        "\n\n"
    );
    stream.end();
  };

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string; result?: unknown };
        if (message.method === "session/prompt") {
          promptCount += 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          const promptId = message.id as number;
          if (promptCount === 1) {
            openPromptStreams.set(promptId, res);
            // The complete wire shape of the live high-risk case: options +
            // toolCall (rawInput command) + `codebuddy.ai/toolName`. The
            // runtime's own decision reason never travels here.
            res.write(
              "data: " +
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: PERMISSION_REQUEST_ID,
                  method: "session/request_permission",
                  params: WORKBUDDY_PERMISSION_LIVE_REQUEST_PARAMS
                }) +
                "\n\n"
            );
            return;
          }
          writePromptResult(promptId, res);
          return;
        }
        if (message.id === PERMISSION_REQUEST_ID && "result" in message) {
          // The client's decline of the approval: capture it, then deliver the
          // terminal prompt result the installed runtime sends afterwards.
          replies.push(message.result);
          for (const [promptId, stream] of openPromptStreams) {
            openPromptStreams.delete(promptId);
            writePromptResult(promptId, stream);
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const client = new AcpClient(`http://127.0.0.1:${address.port}/api/v1/acp`, WORKBUDDY_TERMINAL_FIXTURE_MODEL);
  try {
    await client.connect();

    const first = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "run the high-risk command");
    assert.deepEqual(
      replies,
      [{ outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } }],
      "CrewDispatch declines the approval exactly as before; no automatic approval path is introduced"
    );
    assert.equal(first.approval?.kind, "tool_approval", "the declined gate is remembered");
    assert.equal(first.approval?.toolName, "Bash", "with its bounded tool name");
    assert.match(
      String(first.approval?.detail?.command),
      /jq-asar-extract\.cjs/,
      "and with the provider's OWN operation detail, so a human could decide"
    );
    assert.equal(first.stopReason, "cancelled");
    assert.equal(first.finishReason, "tool_calls");
    assert.equal(
      first.approvalOutcome,
      "no_route",
      "the gate could not be offered interactively: the missing route is the turn's proven cause, never a human decision"
    );
    const firstTerminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: first.stopReason,
      finalText: first.finalText,
      finishReason: first.finishReason,
      approval: first.approval,
      approvalOutcome: first.approvalOutcome
    });
    assert.equal(firstTerminal.exitCode, 17);
    assert.deepEqual(firstTerminal.record.error, {
      code: ACP_FAILURE_PERMISSION_REQUIRED,
      message:
        "WorkBuddy AI required an interactive approval for a tool action, and CrewDispatch is non-interactive, so the run stopped " +
        "(stop_reason=cancelled, finish_reason=tool_calls); the task did not complete."
    });
    assert.equal(
      firstTerminal.record.approval_outcome,
      "no_route",
      "the proven sub-cause is carried beside the unchanged declined-gate classification"
    );
    assert.equal(JSON.stringify(firstTerminal.record).includes("rm -rf"), false, "no tool input reaches the terminal record");

    const second = await client.prompt(WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID, "just talk");
    assert.equal(second.approval, null, "the first prompt's evidence cannot leak into the next prompt");
    assert.equal(second.approvalOutcome, null, "the first prompt's proven outcome cannot leak into the next prompt");
    const secondTerminal = acpTerminalResultRecord({
      sessionId: WORKBUDDY_TERMINAL_FIXTURE_SESSION_ID,
      model: WORKBUDDY_TERMINAL_FIXTURE_MODEL,
      stopReason: second.stopReason,
      finalText: second.finalText,
      finishReason: second.finishReason,
      approval: second.approval,
      approvalOutcome: second.approvalOutcome
    });
    assert.equal(secondTerminal.exitCode, 14);
    assert.equal(
      (secondTerminal.record.error as { code?: unknown }).code,
      ACP_FAILURE_CANCELLED,
      "a plain cancelled turn without a proven gate keeps the unchanged provider_cancelled semantics"
    );
  } finally {
    await client.close();
    for (const stream of openPromptStreams.values()) stream.end();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("ACP auxiliary GET is one-shot/best-effort: a 403 cannot poison a healthy POST/SSE prompt", async () => {
  let connects = 0;
  let getStreams = 0;
  let getSessionToken: string | undefined;
  let postSessionToken: string | undefined;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/acp/connect") {
      connects += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ connectionId: "conn-1", sessionToken: "token-1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/acp") {
      getStreams += 1;
      assert.equal(req.headers["acp-connection-id"], "conn-1");
      getSessionToken = req.headers["acp-session-token"] as string | undefined;
      // WorkBuddy Desktop 5.7.6 may reject this OPTIONAL channel while the POST
      // transport remains healthy. Its own bundled client treats that as benign.
      res.statusCode = 403;
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/acp") {
      postSessionToken = req.headers["acp-session-token"] as string | undefined;
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id?: number; method?: string };
        if (message.method === "session/prompt") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            "data: " + JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { stopReason: "end_turn", _meta: { "codebuddy.ai/finishReason": "stop" } }
            }) + "\n\n"
          );
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      });
      return;
    }
    if (req.method === "DELETE" && req.url === "/api/v1/acp") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  const client = new AcpClient(`http://127.0.0.1:${address.port}/api/v1/acp`, "test-model");
  try {
    await client.connect();
    const prompt = await client.prompt("s-1", "hello");
    assert.equal(prompt.stopReason, "end_turn", "POST/SSE stays authoritative after the optional GET is rejected");
    assert.equal(prompt.finishReason, "stop");
    await waitFor(() => getStreams >= 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(connects, 1);
    assert.equal(getStreams, 1, "the auxiliary GET is never reconnected after a rejection/EOF");
    assert.equal(getSessionToken, undefined, "the installed client does not send the per-session token on auxiliary GET");
    assert.equal(postSessionToken, "token-1", "POST requests keep the per-session token");
  } finally {
    await client.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});