// wb-cancel-desktop.cjs — a FAKE WorkBuddy Desktop for the cancellation
// regressions (JQ-20261006-58).
//
// It replaces ONLY the installed WorkBuddy Desktop app: a real CONTROL-PIPE
// sidecar process that owns real ACP RUNTIME child processes, which in turn own
// real TOOL child processes. Everything else in these tests is the production
// chain: the provider's own sidecar protocol, the bridge's own ACP connection
// and `session/cancel` delivery, the job service cancel path, the OS process
// table and the real Windows tree kill.
//
// Modes:
//   sidecar  --pid-file <f> --pipe <name> --uuid <8hex> --runtimes-file <f>
//   runtime  --endpoint-file <f> --sessions-file <f> --cancel-log <f> [--sse-reply]
//   tool     --pid-file <f>
//
// The runtime is STRICT about the working bridge's connection contract: a
// request without the issued connection id AND the advertised session token is
// refused, `initialize` must be accepted before the connection may send
// anything else, and it models the INSTALLED connection-scoped cancellation
// semantics (read locally from `codebuddy-headless.js`): `session/prompt` is
// held open as the connection's in-flight prompt, and `session/cancel` aborts
// that prompt — and ONLY that prompt — when it arrives on the SAME connection.
// A cancel from any OTHER connection (a fresh auxiliary one) is a logged no-op
// that never touches the tool, exactly like the installed runtime's
// "No matching in-flight prompts to cancel".
//
// The fixture never touches a real WorkBuddy installation, never reads or writes
// a user configuration, and never signals a process it did not spawn.
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

const MODE = process.argv[2];

// How long a runtime's tool keeps running after `session/cancel` before the
// runtime aborts it — models real asynchronous abort propagation. Generous
// enough that the product's cancellation path (which polls up to
// `providerCancelWaitMs`) reliably OBSERVES the tool alive first even when the
// full suite runs many heavy files concurrently, and then observes it gone.
const CANCEL_ABORT_MS = 6000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(require("node:path").dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(file).isFile()) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------------------
// tool — one long-running process that stands in for a provider tool call
// ---------------------------------------------------------------------------
if (MODE === "tool") {
  writeJson(arg("--pid-file"), { pid: process.pid });
  const timer = setInterval(() => undefined, 1000);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
}

// ---------------------------------------------------------------------------
// runtime — one sidecar-owned ACP runtime hosting one or more ACP sessions
// ---------------------------------------------------------------------------
if (MODE === "runtime") {
  const endpointFile = arg("--endpoint-file");
  const sessions = readJson(arg("--sessions-file"));
  const cancelLog = arg("--cancel-log");
  const sseReply = process.argv.includes("--sse-reply");
  // The runtime advertises a session token on /connect and REQUIRES it (plus the
  // issued connection id) on every later request — exactly the strict shape the
  // installed runtime uses and the working bridge AcpClient satisfies.
  const SESSION_TOKEN = "tok-fixture";
  const tools = new Map(); // acpSessionId -> { child, ignoreCancel }
  const sessionOrder = [];
  const issuedConnections = new Set();
  const initializedConnections = new Set();
  /** acpSessionId -> the in-flight prompt held open on its OWNER connection. */
  const promptState = new Map();
  let connectionSeq = 0;

  for (const session of sessions) {
    // Detached so the tool has NO console (and therefore no `conhost.exe`
    // child). The real WorkBuddy runtime is an Electron/GUI-subsystem process
    // without a console, so this is the faithful shape; it also keeps the
    // runtime's descendant scan free of OS console-host noise. PPID is
    // preserved, so ownership is unchanged.
    const child = spawn(process.execPath, [__filename, "tool", "--pid-file", session.toolPidFile], {
      stdio: "ignore",
      windowsHide: true,
      detached: true
    });
    tools.set(session.acpSessionId, { child, ignoreCancel: session.ignoreCancel === true });
    sessionOrder.push(session.acpSessionId);
  }

  const log = (entry) => fs.appendFileSync(cancelLog, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = String(req.url || "");
      const cid = String(req.headers["acp-connection-id"] || "");
      if (req.method === "GET") {
        // The working bridge's event stream: held open for the life of the
        // process. (The bridge would reconnect if it dropped, but a healthy
        // stream is the shape every real turn has.)
        log({ method: "stream", connectionId: cid });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": connected\n\n");
        return;
      }
      if (req.method === "POST" && url.endsWith("/connect")) {
        connectionSeq += 1;
        const connectionId = `conn-fixture-${connectionSeq}`;
        issuedConnections.add(connectionId);
        log({ method: "connect", connectionId });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ connectionId, sessionToken: SESSION_TOKEN }));
        return;
      }
      if (req.method === "DELETE") {
        issuedConnections.delete(cid);
        initializedConnections.delete(cid);
        log({ method: "close", connectionPresent: !!cid, connectionId: cid });
        res.setHeader("content-type", "application/json");
        res.end("{}");
        return;
      }
      if (req.method === "POST") {
        let message = null;
        try {
          message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          message = null;
        }
        const method = message && message.method ? message.method : null;
        const sessionId = message && message.params ? (message.params.sessionId ?? null) : null;
        const token = String(req.headers["acp-session-token"] || "");
        const authorized = !!cid && issuedConnections.has(cid) && token === SESSION_TOKEN;
        if (!method) {
          res.statusCode = 400;
          res.end("{}");
          return;
        }
        if (!authorized) {
          // STRICT: an anonymous / late / wrong-token request is refused and the
          // tool is NEVER touched. The raw token is never logged.
          log({ method, sessionId, rejected: "unauthorized" });
          res.statusCode = 401;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, error: { code: -32001, message: "unauthorized" } }));
          return;
        }
        if (method === "initialize") {
          log({ method, sessionId, tokenOk: true });
          initializedConnections.add(cid);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, result: null }));
          return;
        }
        if (!initializedConnections.has(cid)) {
          // STRICT ORDERING: the working bridge initializes before it sends any
          // request or notification. Anything else is refused and the tool is
          // NEVER touched.
          log({ method, sessionId, rejected: "not_initialized" });
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, error: { code: -32002, message: "connection not initialized" } }));
          return;
        }
        if (method === "session/new") {
          // One ACP session per fixture runtime; the harness declares it.
          const sid = sessionOrder[0];
          log({ method, sessionId: sid, tokenOk: true, connectionId: cid });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, result: { sessionId: sid } }));
          return;
        }
        if (method === "session/prompt") {
          // The prompt becomes this connection's IN-FLIGHT prompt and its HTTP
          // response is HELD OPEN until the OWNER connection cancels it (the
          // installed runtime answers the prompt request when the turn ends).
          log({ method, sessionId, tokenOk: true, connectionId: cid, owner: true, inflight: true });
          promptState.set(sessionId, { cid, id: message.id ? message.id : null, res, answered: false });
          return;
        }
        if (method === "session/cancel") {
          const state = promptState.get(sessionId);
          const entry = tools.get(sessionId);
          const owner = !!state && state.cid === cid && !state.answered;
          if (owner && entry) {
            // The EXACT in-flight prompt of THIS connection: answer it and let
            // the runtime abort the tool asynchronously (unless the fixture is
            // told to model a runtime that ends the turn but leaves the tool).
            log({ method, sessionId, tokenOk: true, connectionId: cid, owner: true });
            state.answered = true;
            state.res.setHeader("content-type", "application/json");
            state.res.end(JSON.stringify({ jsonrpc: "2.0", id: state.id, result: { stopReason: "cancelled" } }));
            if (!entry.ignoreCancel) {
              setTimeout(() => {
                try {
                  process.kill(entry.child.pid, "SIGTERM");
                } catch {}
              }, CANCEL_ABORT_MS).unref();
            }
          } else {
            // The installed connection-scoped semantics: a cancel on a
            // connection with NO matching in-flight prompt is a silent no-op.
            // It is still HTTP-accepted (the bridge's notification POST), but
            // the prompt and the tool are untouched.
            log({ method, sessionId, tokenOk: true, connectionId: cid, owner: false, noop: true });
          }
          if (sseReply) {
            // A reply that streams (SSE) and then ends: the bridge must consume
            // the notification's reply without hanging.
            res.setHeader("content-type", "text/event-stream");
            res.write('data: {"jsonrpc":"2.0","result":null}\n\n');
            res.end();
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, result: null }));
          return;
        }
        // Any other request on an INITIALIZED connection is accepted.
        log({ method, sessionId, tokenOk: true, connectionId: cid });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id ? message.id : null, result: null }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });

  server.listen(0, "127.0.0.1", () => {
    writeJson(endpointFile, { port: server.address().port, pid: process.pid, sessions: sessionOrder });
  });
}

// ---------------------------------------------------------------------------
// sidecar — the durable, shared control process (never to be killed by a cancel)
// ---------------------------------------------------------------------------
if (MODE === "sidecar") {
  const pidFile = arg("--pid-file");
  const pipe = arg("--pipe");
  const uuid = arg("--uuid");
  const runtimesFile = arg("--runtimes-file");
  const runtimes = readJson(runtimesFile);
  const children = [];

  (async () => {
    for (const runtime of runtimes) {
      // Detached for the same reason as the tool: the real sidecar-owned ACP
      // runtime has no console, so the fixture must not introduce a
      // `conhost.exe` descendant that would pollute the runtime's scan.
      const child = spawn(
        process.execPath,
        [
          __filename,
          "runtime",
          "--endpoint-file", runtime.endpointFile,
          "--sessions-file", runtime.sessionsFile,
          "--cancel-log", runtime.cancelLog,
          ...(runtime.sseReply ? ["--sse-reply"] : [])
        ],
        { stdio: "ignore", windowsHide: true, detached: true }
      );
      children.push(child);
      writeJson(runtime.runtimePidFile, { pid: child.pid });
    }
    // A real sidecar publishes its metadata only once its runtimes can serve.
    for (const runtime of runtimes) {
      await waitForFile(runtime.endpointFile, 20000);
    }
    writeJson(pidFile, { pid: process.pid, version: 6, controlPipeUuid: uuid });

    const entries = () =>
      runtimes.map((runtime, index) => {
        const endpoint = readJson(runtime.endpointFile);
        const runtimePid = readJson(runtime.runtimePidFile);
        return {
          sessionId: runtime.runtimeSessionId,
          acpEndpoint: `http://127.0.0.1:${endpoint.port}/api/v1/acp`,
          pid: runtimePid.pid,
          cols: 80,
          rows: 24,
          index
        };
      });

    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let request = null;
          try {
            request = JSON.parse(line);
          } catch {
            continue;
          }
          const answer = (result) => socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
          const fail = (message) => socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }) + "\n");
          if (request.method === "sidecar.ping") {
            answer({ pid: process.pid, uptime: 1, version: 6, token: "fixture" });
          } else if (request.method === "session.list") {
            answer(entries());
          } else if (request.method === "session.kill") {
            // The fixture records it: the product must NEVER call this.
            fs.appendFileSync(runtimeKillLog(runtimesFile), JSON.stringify({ at: new Date().toISOString(), params: request.params }) + "\n", "utf8");
            fail("fixture: session.kill is forbidden");
          } else {
            fail(`fixture: unsupported method ${String(request.method)}`);
          }
        }
      });
      socket.on("error", () => undefined);
    });
    server.listen(pipe);
  })();
}

function runtimeKillLog(runtimesFile) {
  return runtimesFile.replace(/runtimes\.json$/, "session-kill.log");
}
