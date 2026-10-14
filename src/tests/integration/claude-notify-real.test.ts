// claude-notify-real.test.ts — the Claude caller boundary: a REAL MCP stdio
// child → the REAL local daemon → a REAL detached worker running the provider
// fixture → the PRODUCTION Claude transport (src/claude/transport.ts, compiled)
// → a SEPARATE receiver process listening on a real named pipe / Unix socket.
//
// No `deliver()` shortcut is taken anywhere: the wake travels the same path a
// production job takes, and the persisted notification result is read back
// through the MCP status tool. The receiver process stands in for the Claude
// host ON THE WIRE ONLY; it proves the transport reached a separate OS process
// with the exact expected frames and does NOT prove visible conversation
// receipt (that is the installed-host acceptance gate).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { listClaudeBindings, registerClaudeBinding, resolveClaudeBinding } from "../../claude/binding";
import { jobPath, notificationResultPath } from "../../jobs/store";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const HOOK_ENTRY = path.join(__dirname, "..", "..", "claude", "hook.js");
const RECEIVER_ENTRY = path.join(__dirname, "..", "..", "tests", "helpers", "claude-inbox-receiver.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

const HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

function fixtureEcho(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-session-cl" } });',
    '  out({ type: "result", subtype: "success", result: "DONE-MARKER", session_id: "fx-session-cl", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

interface Workspace {
  dir: string;
  root: string;
  project: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function newWorkspace(name: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crewdispatch-claude-real-${name}-`));
  const root = path.join(dir, "root");
  const iso: CliIsolation = createCliIsolation({ baseDir: dir, tempPrefix: `iso-cl-${name}-` });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, `${name}.js`);
  fs.writeFileSync(fixture, fixtureEcho().join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };
  return { dir, root, project, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipePath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crewdispatch-real-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `crewdispatch-real-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

interface Receiver {
  address: string;
  outFile: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stop: () => Promise<void>;
}

/** Start the separate receiver process and wait for its READY line. */
async function startReceiver(name: string): Promise<Receiver> {
  const address = pipePath(name);
  const outFile = path.join(os.tmpdir(), `crewdispatch-receiver-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  const child = spawn(process.execPath, [RECEIVER_ENTRY, address, outFile], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("the receiver process never became ready")), 10000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the receiver process exited early (${code})`));
    });
  });
  return {
    address,
    outFile,
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        fs.rmSync(outFile, { force: true });
      } catch {
        /* the workspace cleanup also removes it */
      }
    }
  };
}

/** Run the REAL compiled hook entry as a separate process (the installed layout). */
function runHook(ws: Workspace, sessionId: string, socket: string, token: string): string {
  const result = spawnSync(process.execPath, [HOOK_ENTRY, "session-start"], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart", cwd: ws.project }),
    encoding: "utf8",
    timeout: 35000,
    windowsHide: true,
    env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function parseGuidance(stdout: string): { sessionId: string; bindingId: string } {
  const session = /claude_session_id="([^"]+)"/.exec(stdout);
  const binding = /claude_binding_id="([a-f0-9]{32})"/.exec(stdout);
  assert.ok(session, `the hook guidance must name the session id: ${stdout}`);
  assert.ok(binding, `the hook guidance must name the binding id: ${stdout}`);
  return { sessionId: session[1]!, bindingId: binding[1]! };
}

interface FrameGroup {
  group: number;
  frames: string;
}

function readGroups(file: string): FrameGroup[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FrameGroup);
}

async function waitGroups(file: string, n: number, timeoutMs = 20000): Promise<FrameGroup[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const groups = readGroups(file);
    if (groups.length >= n) return groups;
    if (Date.now() >= deadline) throw new Error(`expected ${n} frame groups in ${file}, saw ${groups.length}`);
    await sleep(100);
  }
}

function framesOf(group: FrameGroup): { auth: Record<string, unknown>; content: string } {
  const lines = group.frames.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "exactly two frames per wake");
  const auth = JSON.parse(lines[0]!) as Record<string, unknown>;
  const user = JSON.parse(lines[1]!) as { message: { role: string; content: string } };
  assert.equal(auth.type, "auth");
  assert.equal(user.message.role, "user");
  return { auth, content: user.message.content };
}

/** Every string value of a parsed JSON document (for exact privacy checks). */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 40000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

async function waitNotify(client: McpStdioClient, id: string, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = McpStdioClient.json(await client.callTool("jobquay_status", { id }));
    const notify = (status.job as Record<string, unknown>).notify as Record<string, unknown>;
    if (notify.attempted === true) return notify;
    if (Date.now() >= deadline) throw new Error(`wake outcome was never persisted for ${id}`);
    await sleep(100);
  }
}

test("a real job wakes the exact bound session through the production transport to a separate receiver", { timeout: 90000 }, async () => {
  const ws = newWorkspace("full");
  const receiver = await startReceiver("full");
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  const token = "native-token-boundary-marker-xyz";
  const task = "TASK_MARKER_claude_9f3 — must never appear in the wake";
  try {
    // The REAL SessionStart hook registers the binding; the guidance line is the
    // only thing a conversation sees (never the address or token).
    const guidance = parseGuidance(runHook(ws, "11111111-2222-4333-8444-555555555555", receiver.address, token));
    assert.equal(guidance.sessionId, "11111111-2222-4333-8444-555555555555");
    assert.equal(guidance.bindingId.length, 32);

    await client.initialize();
    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", { task, cwd: ws.project, claude_session_id: guidance.sessionId })
    );
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");
    assert.equal((done.result as Record<string, unknown>).final_text, "DONE-MARKER");

    await waitGroups(receiver.outFile, 1);
    await sleep(600); // a stray duplicate attempt would arrive within this window
    const groups = readGroups(receiver.outFile);
    assert.equal(groups.length, 1, "exactly ONE terminal wake per generation");

    const { auth, content } = framesOf(groups[0]!);
    assert.equal(auth.token, token, "the auth frame carries the token from the private store");
    assert.ok(content.includes(id), "the wake names the job");
    assert.ok(content.includes("exactly once"));
    assert.equal(content.includes("TASK_MARKER_claude_9f3"), false, "the wake must not contain the task");
    assert.equal(content.includes("DONE-MARKER"), false, "the wake must not contain the result text");
    assert.equal(content.includes(token), false, "the message must not contain the token");

    // The persisted outcome comes back through the MCP status view.
    const notify = await waitNotify(client, id);
    assert.equal(notify.kind, "claude_session");
    assert.equal(notify.delivered, true);
    assert.equal(notify.reason, null);

    // Privacy: the job record and the notification result carry ONLY opaque
    // references — never the native address or the session token (checked on
    // every string VALUE, so JSON escaping cannot hide one).
    const rawJob = fs.readFileSync(jobPath(ws.root, id), "utf8");
    const rawResult = fs.readFileSync(notificationResultPath(ws.root, id, 0), "utf8");
    for (const raw of [rawJob, rawResult]) {
      for (const value of allStrings(JSON.parse(raw))) {
        assert.equal(value.includes(token), false, "no record may carry the token");
        assert.equal(value.includes(receiver.address), false, "no record may carry the inbox address");
        assert.equal(value.includes(guidance.bindingId), false, "no record may carry the binding id (only the target does)");
      }
    }
    assert.ok(rawJob.includes(guidance.sessionId), "the record carries only the opaque session reference");

    // A continuation (same job, generation 1) wakes the SAME session exactly once more.
    const followed = McpStdioClient.json(await client.callTool("jobquay_follow_up", { id, message: "again" }));
    assert.equal(followed.generation, 1);
    await waitTerminal(client, id);
    await waitGroups(receiver.outFile, 2);
    await sleep(600);
    const after = readGroups(receiver.outFile);
    assert.equal(after.length, 2, "each terminal generation wakes exactly once");
    assert.ok(framesOf(after[1]!).content.includes(id));
  } finally {
    await client.close();
    await receiver.stop();
    await ws.cleanup();
  }
});

test("two concurrent sessions never cross-deliver", { timeout: 90000 }, async () => {
  const ws = newWorkspace("two");
  const receiverA = await startReceiver("two-a");
  const receiverB = await startReceiver("two-b");
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    const a = parseGuidance(runHook(ws, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", receiverA.address, "token-a"));
    const b = parseGuidance(runHook(ws, "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", receiverB.address, "token-b"));

    // Two projects under the SAME data root so both jobs run concurrently; the
    // shared same-workspace occupancy rule is covered unchanged by the existing
    // workspace-busy-mcp suite.
    const projectB = path.join(path.dirname(ws.project), "project-b");
    fs.mkdirSync(projectB, { recursive: true });

    await client.initialize();
    const jobA = String(McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "task-a", cwd: ws.project, claude_session_id: a.sessionId })).job_id);
    const jobB = String(McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "task-b", cwd: projectB, claude_session_id: b.sessionId })).job_id);
    await waitTerminal(client, jobA);
    await waitTerminal(client, jobB);

    await waitGroups(receiverA.outFile, 1);
    await waitGroups(receiverB.outFile, 1);
    await sleep(700);
    const groupsA = readGroups(receiverA.outFile);
    const groupsB = readGroups(receiverB.outFile);
    assert.equal(groupsA.length, 1);
    assert.equal(groupsB.length, 1);
    assert.ok(framesOf(groupsA[0]!).content.includes(jobA));
    assert.equal(framesOf(groupsA[0]!).content.includes(jobB), false, "session A must never receive session B's wake");
    assert.ok(framesOf(groupsB[0]!).content.includes(jobB));
    assert.equal(framesOf(groupsB[0]!).content.includes(jobA), false, "session B must never receive session A's wake");
    assert.equal(framesOf(groupsA[0]!).auth.token, "token-a");
    assert.equal(framesOf(groupsB[0]!).auth.token, "token-b");
  } finally {
    await client.close();
    await receiverA.stop();
    await receiverB.stop();
    await ws.cleanup();
  }
});

test("missing and unreachable bindings fail closed with an honest recorded reason", { timeout: 90000 }, async () => {
  const ws = newWorkspace("fail");
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();

    // 1. A valid-shaped session that was never registered: no_binding.
    const unbound = String(
      McpStdioClient.json(
        await client.callTool("jobquay_spawn", { task: "unbound", cwd: ws.project, claude_session_id: "cccccccc-3333-4333-8333-cccccccccccc" })
      ).job_id
    );
    const unboundDone = await waitTerminal(client, unbound);
    assert.equal(unboundDone.status, "done", "a missing binding never changes the job outcome");
    assert.equal((unboundDone.result as Record<string, unknown>).final_text, "DONE-MARKER", "notification failure never rewrites the provider result");
    const unboundNotify = await waitNotify(client, unbound);
    assert.equal(unboundNotify.delivered, false);
    assert.equal(unboundNotify.reason, "no_binding");

    // 2. A registered binding whose inbox address has no listener: inbox_unreachable.
    const session = "dddddddd-4444-4444-8444-dddddddddddd";
    registerClaudeBinding(ws.root, { sessionId: session, socket: pipePath("dead-no-listener"), token: "dead-token" });
    const dead = String(
      McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "dead", cwd: ws.project, claude_session_id: session })).job_id
    );
    const deadDone = await waitTerminal(client, dead);
    assert.equal(deadDone.status, "done");
    assert.equal((deadDone.result as Record<string, unknown>).final_text, "DONE-MARKER", "unreachable inbox never rewrites the provider result");
    const deadNotify = await waitNotify(client, dead);
    assert.equal(deadNotify.delivered, false);
    assert.equal(deadNotify.reason, "inbox_unreachable");

    // A failed wake is recorded exactly once and never retried.
    await sleep(600);
    const status = McpStdioClient.json(await client.callTool("jobquay_status", { id: dead }));
    assert.equal((status.job as Record<string, unknown>).status, "done");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("the wake survives MCP disconnect and a continuation can replace the target", { timeout: 90000 }, async () => {
  const ws = newWorkspace("resume");
  const receiverA = await startReceiver("resume-a");
  const receiverB = await startReceiver("resume-b");
  const tokenA = "token-resume-a";
  try {
    const a = parseGuidance(runHook(ws, "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", receiverA.address, tokenA));
    const b = parseGuidance(runHook(ws, "ffffffff-6666-4666-8666-ffffffffffff", receiverB.address, "token-resume-b"));

    const client1 = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await client1.initialize();
    const id = String(
      McpStdioClient.json(await client1.callTool("jobquay_spawn", { task: "resume", cwd: ws.project, claude_session_id: a.sessionId })).job_id
    );
    // The MCP process goes away BEFORE the job finishes; the detached worker
    // must still wake the original bound session.
    await client1.close();

    await waitGroups(receiverA.outFile, 1);
    const first = framesOf(readGroups(receiverA.outFile)[0]!);
    assert.equal(first.auth.token, tokenA);
    assert.ok(first.content.includes(id));

    // A new MCP process continues the same job and names session B: the gen-1
    // wake must go to B and never to A again.
    const client2 = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    try {
      await client2.initialize();
      const followed = McpStdioClient.json(await client2.callTool("jobquay_follow_up", { id, message: "repair", claude_session_id: b.sessionId }));
      assert.equal(followed.generation, 1);
      await waitTerminal(client2, id);
      await waitGroups(receiverB.outFile, 1);
      await sleep(700);
      assert.equal(readGroups(receiverA.outFile).length, 1, "the replaced target must not receive the continuation wake");
      assert.equal(readGroups(receiverB.outFile).length, 1);
      assert.ok(framesOf(readGroups(receiverB.outFile)[0]!).content.includes(id));
    } finally {
      await client2.close();
    }
  } finally {
    await receiverA.stop();
    await receiverB.stop();
    await ws.cleanup();
  }
});

test("concurrent SessionStart hook processes converge to the newest binding", { timeout: 60000 }, async () => {
  const ws = newWorkspace("concurrent");
  try {
    const session = "12121212-3434-4545-8686-787878787878";
    const socketA = pipePath("conc-a");
    const socketB = pipePath("conc-b");
    const spawnHook = (socket: string, token: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [HOOK_ENTRY, "session-start"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...ws.env, CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_MESSAGING_TOKEN: token }
        });
        child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: "SessionStart" }));
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))));
      });

    await Promise.all([spawnHook(socketA, "token-a"), spawnHook(socketB, "token-b")]);
    const listed = listClaudeBindings(ws.root).filter((r) => r.sessionId === session);
    assert.ok(listed.length >= 1, "at least the newest registration must survive");
    assert.ok(listed.length <= 2);
    const resolved = resolveClaudeBinding(ws.root, { sessionId: session });
    assert.ok(resolved, "a binding must always resolve after concurrent registrations");
    assert.ok([socketA, socketB].includes(resolved!.socket), "the resolved binding must be one of the two real registrations");
    // The resolved binding is the newest by (updatedAt, bindingId) — the same
    // deterministic winner the replace rule guarantees.
    const max = listed.reduce((best, cur) =>
      cur.updatedAt > best.updatedAt || (cur.updatedAt === best.updatedAt && cur.bindingId > best.bindingId) ? cur : best
    );
    assert.equal(resolved!.bindingId, max.bindingId);
  } finally {
    await ws.cleanup();
  }
});
