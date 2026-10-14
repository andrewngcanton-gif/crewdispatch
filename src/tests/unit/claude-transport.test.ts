// claude-transport.test.ts — unit coverage of the Claude native-inbox transport
// and its two bounded wake messages. The wire is exercised against REAL local
// sockets (a named pipe on Windows, a Unix socket elsewhere); no Claude host,
// no model and no network are involved.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { listClaudeBindings, registerClaudeBinding, removeClaudeBindingForIncarnation } from "../../claude/binding";
import {
  buildClaudeApprovalWakeMessage,
  buildClaudeRecoveryWakeMessage,
  buildClaudeWakeMessage,
  CLAUDE_APPROVAL_WAKE_MESSAGE_CAP,
  CLAUDE_RECOVERY_WAKE_MESSAGE_CAP,
  CLAUDE_WAKE_MESSAGE_CAP
} from "../../claude/messages";
import {
  buildClaudeInboxFrames,
  CLAUDE_INBOX_TIMEOUT_MS,
  claudeNotificationTransport,
  sendClaudeInboxMessage
} from "../../claude/transport";
import type { DeliveryDeps } from "../../jobs/notifications";
import type { NotifyTarget } from "../../jobs/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "99999999-8888-4777-8666-555555555555";
const TOKEN = "native-token-marker-abcdef0123456789";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-transport-"));
}

function pipePath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\crewdispatch-test-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `crewdispatch-test-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

interface Inbox {
  address: string;
  frames: string[];
  close: () => Promise<void>;
}

/** A real local inbox endpoint that records the raw newline-delimited frames. */
function startInbox(name = "accept"): Promise<Inbox> {
  const address = pipePath(name);
  const frames: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = "";
    socket.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
    });
    socket.on("end", () => {
      frames.push(buf);
      socket.end();
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      resolve({
        address,
        frames,
        close: () =>
          new Promise<void>((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          })
      });
    });
  });
}

function startPrivateUnixInbox(name = "private"): Promise<Inbox & { dir: string }> {
  if (process.platform === "win32") throw new Error("private Unix inbox is POSIX-only");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crewdispatch-claude-private-${name}-`));
  fs.chmodSync(dir, 0o700);
  const address = path.join(dir, "inbox.sock");
  const frames: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = "";
    socket.on("data", (d: Buffer) => { buf += d.toString("utf8"); });
    socket.on("end", () => { frames.push(buf); socket.end(); });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      fs.chmodSync(address, 0o600);
      resolve({
        dir,
        address,
        frames,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => {
            fs.rmSync(dir, { recursive: true, force: true });
            done();
          });
        })
      });
    });
  });
}

function target(sessionId: string | null): NotifyTarget {
  return {
    kind: "claude_session",
    callbackUrl: null,
    codexThreadId: null,
    claudeSessionId: sessionId,
    claudeBindingId: null,
    source: sessionId ? "claude_session_id" : null
  };
}

const TERMINAL_EVENT = { event: "terminal", jobId: "job-claude-1", generation: 0, status: "done" } as const;

test("buildClaudeInboxFrames emits the auth frame first, then one user frame", () => {
  const raw = buildClaudeInboxFrames(TOKEN, "hello \"world\"");
  const lines = raw.split("\n");
  assert.equal(lines.length, 3, "exactly two newline-terminated frames");
  assert.equal(lines[2], "");
  assert.deepEqual(JSON.parse(lines[0]!), { type: "auth", token: TOKEN });
  assert.deepEqual(JSON.parse(lines[1]!), { type: "user", message: { role: "user", content: 'hello "world"' } });
});

test("the terminal wake message is bounded, one-shot and never carries task/result text", () => {
  const msg = buildClaudeWakeMessage("job-abc-123", "done");
  assert.ok(msg.includes("job-abc-123"));
  assert.ok(msg.includes("done"));
  assert.ok(msg.includes("exactly once"));
  assert.ok(msg.length <= CLAUDE_WAKE_MESSAGE_CAP);
  assert.equal(msg.includes("TASK_MARKER"), false);

  const long = buildClaudeWakeMessage(`job-${"x".repeat(400)}`, "done");
  assert.ok(long.length <= CLAUDE_WAKE_MESSAGE_CAP, "an absurd id must still fit the cap");

  // A hostile status is sanitized to one line instead of breaking the frame.
  const hostile = buildClaudeWakeMessage("job-1", "done\n{\"type\":\"user\"}");
  assert.equal(hostile.includes("\n"), false);
});

test("the approval wake message says NOT finished, forbids auto-approval and keeps the full link", () => {
  const event = {
    event: "approval_required" as const,
    jobId: "job-approve-1",
    generation: 2,
    requestId: "req-1",
    provider: "command-code",
    toolName: "shell",
    operation: "npm test -- --runInBand",
    cwd: "C:\\proj",
    hubUrl: "http://127.0.0.1:1234/ui?job=job-approve-1&generation=2&request=req-1",
    expiresAt: "2026-10-01T01:00:00.000Z"
  };
  const msg = buildClaudeApprovalWakeMessage(event);
  assert.ok(msg.includes("job-approve-1"));
  assert.ok(msg.includes("run 3"), "the human run number is generation + 1");
  assert.ok(msg.includes("not finished"));
  assert.ok(msg.includes("Do not call crewdispatch_result"));
  assert.ok(msg.includes("do not approve automatically"));
  assert.ok(msg.includes(event.hubUrl), "the complete Dashboard link must be present");
  assert.equal(msg.includes('Call crewdispatch_result(id='), false, "an approval is never a result-collection instruction");
  assert.ok(msg.includes("Operation: npm test -- --runInBand"));
  assert.ok(msg.length <= CLAUDE_APPROVAL_WAKE_MESSAGE_CAP);

  // An oversized operation is clipped with an explicit mark; the link survives.
  const big = buildClaudeApprovalWakeMessage({ ...event, operation: "x".repeat(4000) });
  assert.ok(big.includes("[truncated]"));
  assert.ok(big.includes(event.hubUrl));
  assert.ok(big.length <= CLAUDE_APPROVAL_WAKE_MESSAGE_CAP);

  // An absent operation is stated as absent — never implied by budget pressure.
  const absent = buildClaudeApprovalWakeMessage({ ...event, operation: null });
  assert.ok(absent.includes("Operation: not provided by the provider."));

  // Provider text is data: newlines cannot break the single-line frame.
  const hostile = buildClaudeApprovalWakeMessage({ ...event, operation: "a\nb\u0000c" });
  assert.equal(hostile.includes("\n"), false);
});

test("the recovered terminal wake is identifiable, names job+run and asks CONDITIONALLY", () => {
  const msg = buildClaudeRecoveryWakeMessage("job-recover-7", 0, "done", false);
  assert.ok(msg.includes("recovery"), "the text is identifiable as a recovery");
  assert.ok(msg.includes("job-recover-7"));
  assert.ok(msg.includes("run 1"), "the human run number is generation + 1");
  assert.ok(msg.includes("was not delivered"));
  assert.ok(msg.includes("has not already been collected"), "the collection request is conditional");
  assert.ok(msg.includes('crewdispatch_result(id="job-recover-7")'));
  assert.equal(msg.includes("exactly once"), false, "the unconditional one-shot wording is never repeated");
  assert.equal(msg.includes("\n"), false, "it stays a single line");
  assert.ok(msg.length <= CLAUDE_RECOVERY_WAKE_MESSAGE_CAP);

  // A generation that was already collected asks for NOTHING.
  const collected = buildClaudeRecoveryWakeMessage("job-recover-7", 3, "done", true);
  assert.ok(collected.includes("run 4"));
  assert.ok(collected.includes("already collected"));
  assert.equal(collected.includes('crewdispatch_result(id='), false, "no result call is requested for a collected generation");
  assert.ok(collected.length <= CLAUDE_RECOVERY_WAKE_MESSAGE_CAP);

  // An absurd id still fits the cap and a hostile status cannot break the frame.
  assert.ok(buildClaudeRecoveryWakeMessage(`job-${"x".repeat(400)}`, 0, "done", false).length <= CLAUDE_RECOVERY_WAKE_MESSAGE_CAP);
  assert.equal(buildClaudeRecoveryWakeMessage("job-1", 0, "done\n{\"type\":\"user\"}", false).includes("\n"), false);
});

test("a real inbox endpoint receives the auth+user frames and the send reports delivered", async () => {
  const inbox = await startInbox("accept");
  try {
    const outcome = await sendClaudeInboxMessage({ socket: inbox.address, token: TOKEN, message: "wake text", timeoutMs: 3000 });
    // A clean close after the frames were flushed is a `handoff` — the only
    // successful phase, and never a recovery candidate.
    assert.deepEqual(outcome, { delivered: true, reason: null, phase: "handoff" });
    assert.equal(inbox.frames.length, 1);
    const lines = inbox.frames[0]!.split("\n").filter(Boolean);
    assert.deepEqual(JSON.parse(lines[0]!), { type: "auth", token: TOKEN });
    assert.deepEqual(JSON.parse(lines[1]!), { type: "user", message: { role: "user", content: "wake text" } });
  } finally {
    await inbox.close();
  }
});

test("POSIX inbox handoff works through a private 0700 parent and 0600 Unix socket", { skip: process.platform === "win32" }, async () => {
  const inbox = await startPrivateUnixInbox();
  try {
    assert.equal(fs.statSync(inbox.dir).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(inbox.address).mode & 0o777, 0o600);
    const outcome = await sendClaudeInboxMessage({ socket: inbox.address, token: TOKEN, message: "private wake", timeoutMs: 3000 });
    assert.deepEqual(outcome, { delivered: true, reason: null, phase: "handoff" });
    assert.equal(inbox.frames.length, 1);
    assert.equal(fs.statSync(inbox.dir).mode & 0o777, 0o700, "transport never widens the parent mode");
    assert.equal(fs.lstatSync(inbox.address).mode & 0o777, 0o600, "transport never widens the socket mode");
  } finally {
    await inbox.close();
  }
});

test(
  "POSIX real Unix sockets classify missing, permission-denied, held and partial-close failures honestly",
  { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) },
  async () => {
    interface RealUnixEndpoint {
      dir: string;
      address: string;
      server: net.Server;
      sockets: Set<net.Socket>;
    }

    const socketRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();

    const startUnixEndpoint = async (
      name: string,
      onConnection: (socket: net.Socket) => void
    ): Promise<RealUnixEndpoint> => {
      // Darwin's AF_UNIX path cap is short; keep the native failure fixtures
      // under /tmp instead of the longer per-user /var/folders temp root.
      const dir = fs.mkdtempSync(path.join(socketRoot, `cdf-${name}-`));
      fs.chmodSync(dir, 0o700);
      const address = path.join(dir, "inbox.sock");
      const sockets = new Set<net.Socket>();
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        onConnection(socket);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, resolve);
      });
      return { dir, address, server, sockets };
    };

    const closeUnixEndpoint = async (endpoint: RealUnixEndpoint): Promise<void> => {
      try {
        fs.chmodSync(endpoint.dir, 0o700);
      } catch {
        /* best effort: permission-denied case intentionally changes this mode */
      }
      for (const socket of endpoint.sockets) socket.destroy();
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      fs.rmSync(endpoint.dir, { recursive: true, force: true });
    };

    // No socket exists, so no write call can begin.
    const missing = await sendClaudeInboxMessage({
      socket: path.join(socketRoot, `cdf-missing-${process.pid}-${Date.now()}.sock`),
      token: TOKEN,
      message: "missing",
      timeoutMs: 500
    });
    assert.deepEqual(missing, { delivered: false, reason: "inbox_unreachable", phase: "not_written" });

    // A real listening socket exists, but parent traversal is denied by the OS.
    const deniedEndpoint = await startUnixEndpoint("permission", (socket) => socket.resume());
    try {
      fs.chmodSync(deniedEndpoint.dir, 0o000);
      const denied = await sendClaudeInboxMessage({
        socket: deniedEndpoint.address,
        token: TOKEN,
        message: "permission",
        timeoutMs: 500
      });
      assert.deepEqual(denied, { delivered: false, reason: "inbox_permission_denied", phase: "not_written" });
    } finally {
      await closeUnixEndpoint(deniedEndpoint);
    }

    // The peer reads the half-closed request but deliberately keeps its half open.
    const heldEndpoint = await startUnixEndpoint("held", (socket) => {
      socket.resume();
      socket.on("end", () => undefined);
    });
    try {
      const held = await sendClaudeInboxMessage({
        socket: heldEndpoint.address,
        token: TOKEN,
        message: "held",
        timeoutMs: 300
      });
      assert.deepEqual(held, { delivered: false, reason: "inbox_held", phase: "writing_started" });
    } finally {
      await closeUnixEndpoint(heldEndpoint);
    }

    // Force a real post-connect write failure before a large payload can flush.
    // The intentionally large payload is only a deterministic transport-phase
    // probe; production wake messages remain bounded by the message builders.
    const partialEndpoint = await startUnixEndpoint("partial", (socket) => socket.destroy());
    try {
      const partial = await sendClaudeInboxMessage({
        socket: partialEndpoint.address,
        token: TOKEN,
        message: "x".repeat(16 * 1024 * 1024),
        timeoutMs: 1500
      });
      assert.equal(partial.delivered, false);
      assert.equal(partial.phase, "writing_started");
      assert.match(String(partial.reason), /^(inbox_error:|inbox_closed_early|inbox_rejected)/);
    } finally {
      await closeUnixEndpoint(partialEndpoint);
    }
  }
);

/**
 * A socket double for the bounded-timeout and early-close paths. On Windows a
 * real named pipe fully closes when the sender half-closes (so a real "held"
 * endpoint cannot be simulated there, and a server-side destroy races the
 * sender's own flush); the double makes each path deterministic on every OS.
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  constructor(private readonly flushOnEnd = true) {
    super();
  }
  setTimeout(_ms: number): this {
    return this;
  }
  end(_data: string, cb?: () => void): this {
    if (cb && this.flushOnEnd) cb();
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

test("a held endpoint and a stalled connect are bounded honest failures, never a fake delivery", async () => {
  // The delivery timer is deliberately unref'd (a wake must never hold a
  // process open); keep the loop alive while the bounded attempt runs.
  const keepAlive = setTimeout(() => undefined, 5000);
  try {
    // Frames flushed, but the endpoint never closes → inbox_held (no receipt proof).
    const held = new FakeSocket();
    const heldOutcome = await sendClaudeInboxMessage({
      socket: "held",
      token: TOKEN,
      message: "held",
      timeoutMs: 200,
      connectFn: () => {
        setImmediate(() => held.emit("connect"));
        return held as unknown as net.Socket;
      }
    });
    assert.equal(heldOutcome.delivered, false);
    assert.equal(heldOutcome.reason, "inbox_held");
    assert.equal(heldOutcome.phase, "writing_started", "a held endpoint is WRITING-STARTED/uncertain, never eligible");
    assert.equal(held.destroyed, true, "the bounded attempt destroys its socket");

    // The connection never establishes at all → timeout (the bound covers connect).
    const stalled = new FakeSocket();
    const stalledOutcome = await sendClaudeInboxMessage({
      socket: "stalled",
      token: TOKEN,
      message: "x",
      timeoutMs: 200,
      connectFn: () => stalled as unknown as net.Socket
    });
    assert.equal(stalledOutcome.delivered, false);
    assert.equal(stalledOutcome.reason, "timeout");
    assert.equal(stalledOutcome.phase, "not_written", "a stalled connect never issued the write call");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("a dead address, a refused write and an errored close are honest failures", async () => {
  const dead = pipePath("dead");
  const refused = await sendClaudeInboxMessage({ socket: dead, token: TOKEN, message: "x", timeoutMs: 300 });
  assert.equal(refused.delivered, false);
  assert.equal(refused.reason, "inbox_unreachable");
  assert.equal(refused.phase, "not_written", "a missing/refused connection is the ONE eligible phase");
  assert.equal(String(refused.reason).includes(TOKEN), false, "a failure reason never carries the token");

  const throwing = await sendClaudeInboxMessage({
    socket: "ignored",
    token: TOKEN,
    message: "x",
    timeoutMs: 300,
    connectFn: () => {
      throw new Error("connect exploded");
    }
  });
  assert.equal(throwing.delivered, false);
  assert.match(String(throwing.reason), /^inbox_error:/);
  assert.equal(throwing.phase, "not_written", "a socket that never existed provably never wrote");

  // A close BEFORE the frames were flushed is a partial write, never delivered.
  const keepAlive = setTimeout(() => undefined, 5000);
  try {
    const early = new FakeSocket(false);
    const earlyOutcome = await sendClaudeInboxMessage({
      socket: "early",
      token: TOKEN,
      message: "x",
      timeoutMs: 2000,
      connectFn: () => {
        setImmediate(() => {
          early.emit("connect");
          setImmediate(() => early.emit("close", false));
        });
        return early as unknown as net.Socket;
      }
    });
    assert.equal(earlyOutcome.delivered, false);
    assert.equal(earlyOutcome.reason, "inbox_closed_early");
    assert.equal(earlyOutcome.phase, "writing_started", "the write call was already issued");

    // Inbound bytes then a close without a flush: the endpoint rejected the send.
    const rejected = new FakeSocket(false);
    const rejectedOutcome = await sendClaudeInboxMessage({
      socket: "rejected",
      token: TOKEN,
      message: "x",
      timeoutMs: 2000,
      connectFn: () => {
        setImmediate(() => {
          rejected.emit("connect");
          setImmediate(() => {
            rejected.emit("data", Buffer.from("no"));
            setImmediate(() => rejected.emit("close", false));
          });
        });
        return rejected as unknown as net.Socket;
      }
    });
    assert.equal(rejectedOutcome.delivered, false);
    assert.equal(rejectedOutcome.reason, "inbox_rejected");
    assert.equal(rejectedOutcome.phase, "writing_started");

    // A close WITH an error is an error, never a delivery.
    const errored = new FakeSocket();
    const erroredOutcome = await sendClaudeInboxMessage({
      socket: "errored",
      token: TOKEN,
      message: "x",
      timeoutMs: 2000,
      connectFn: () => {
        setImmediate(() => {
          errored.emit("connect");
          setImmediate(() => errored.emit("close", true));
        });
        return errored as unknown as net.Socket;
      }
    });
    assert.equal(erroredOutcome.delivered, false);
    assert.equal(erroredOutcome.reason, "inbox_error:closed");
    assert.equal(erroredOutcome.phase, "writing_started");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("the transport fails closed with no data root or no matching binding", async () => {
  const root = tmpRoot();
  try {
    const noRoot = await claudeNotificationTransport.deliver(TERMINAL_EVENT, target(SESSION), {});
    assert.deepEqual(noRoot, { delivered: false, reason: "no_data_root" });

    // No binding of this session exists, so there is no inbox to write to: the
    // write provably never began. That is a `not_written` outcome, not an
    // unknown one — otherwise a job that finished while the conversation was
    // closed could never be recovered on reopen.
    const noBinding = await claudeNotificationTransport.deliver(TERMINAL_EVENT, target(SESSION), { root });
    assert.deepEqual(noBinding, { delivered: false, reason: "no_binding", phase: "not_written" });

    // A binding for ANOTHER session must never be used for this target.
    const other = registerClaudeBinding(root, {
      sessionId: "99999999-8888-4777-8666-555555555555",
      socket: pipePath("other"),
      token: TOKEN
    });
    assert.ok(other);
    const wrong = await claudeNotificationTransport.deliver(TERMINAL_EVENT, target(SESSION), { root });
    assert.deepEqual(wrong, { delivered: false, reason: "no_binding", phase: "not_written" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a binding removed by the real SessionEnd cleanup makes the terminal wake a proven not-written absence", async () => {
  const root = tmpRoot();
  try {
    const socket = pipePath("sessionend");
    const token = `${TOKEN}-sessionend`;
    const binding = registerClaudeBinding(root, { sessionId: SESSION, socket, token });
    assert.ok(binding);

    // The PRODUCTION cleanup the SessionEnd hook performs: exact incarnation
    // match (session + address + this hook's own token).
    const removed = removeClaudeBindingForIncarnation(root, { sessionId: SESSION, socket, token });
    assert.equal(removed.removed, true, "the normal SessionEnd removed the binding");
    assert.equal(listClaudeBindings(root).length, 0);

    // The conversation is closed: a terminal event now has no inbox at all.
    const outcome = await claudeNotificationTransport.deliver(TERMINAL_EVENT, target(SESSION), { root });
    assert.deepEqual(outcome, { delivered: false, reason: "no_binding", phase: "not_written" });
    assert.equal(outcome.delivered, false, "an absent binding is still a failure, never a success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted target carrying BOTH references resolves only a matching pair and never crosses sessions", async () => {
  const root = tmpRoot();
  const inboxA = await startInbox("both-a");
  const inboxB = await startInbox("both-b");
  try {
    const a = registerClaudeBinding(root, { sessionId: SESSION, socket: inboxA.address, token: TOKEN });
    const b = registerClaudeBinding(root, { sessionId: SESSION_B, socket: inboxB.address, token: "token-b" });
    // The exact shape the persisted-target normalizer produces when a record
    // (or a future caller) carries both references.
    const both = (bindingId: string | null, sessionId: string | null): NotifyTarget => ({
      kind: "claude_session",
      callbackUrl: null,
      codexThreadId: null,
      claudeSessionId: sessionId,
      claudeBindingId: bindingId,
      source: sessionId ? "claude_session_id" : bindingId ? "claude_binding_id" : null
    });

    // A matching pair delivers to A's inbox only.
    const ok = await claudeNotificationTransport.deliver(TERMINAL_EVENT, both(a.bindingId, SESSION), { root, timeoutMs: 3000 });
    assert.deepEqual(ok, { delivered: true, reason: null, phase: "handoff" });
    assert.equal(inboxA.frames.length, 1);
    assert.equal(inboxB.frames.length, 0, "the other session must never receive the wake");

    // A's binding id + B's session id: fail closed with NO send anywhere and no
    // silent fallback to B's registration.
    // Conflicting/absent references resolve to NO binding, so no write could
    // have begun: still a proven `not_written` failure, never a delivery.
    const conflict = await claudeNotificationTransport.deliver(TERMINAL_EVENT, both(a.bindingId, SESSION_B), { root, timeoutMs: 3000 });
    assert.deepEqual(conflict, { delivered: false, reason: "no_binding", phase: "not_written" });
    assert.equal(inboxA.frames.length, 1);
    assert.equal(inboxB.frames.length, 0, "a conflicting pair must not fall back to another session");

    // The reverse pairing is refused identically.
    const conflict2 = await claudeNotificationTransport.deliver(TERMINAL_EVENT, both(b.bindingId, SESSION), { root, timeoutMs: 3000 });
    assert.deepEqual(conflict2, { delivered: false, reason: "no_binding", phase: "not_written" });
    assert.equal(inboxA.frames.length, 1);
    assert.equal(inboxB.frames.length, 0);

    // B's matching pair still delivers to B only.
    const okB = await claudeNotificationTransport.deliver(TERMINAL_EVENT, both(b.bindingId, SESSION_B), { root, timeoutMs: 3000 });
    assert.deepEqual(okB, { delivered: true, reason: null, phase: "handoff" });
    assert.equal(inboxB.frames.length, 1);
    assert.equal(inboxA.frames.length, 1);
  } finally {
    await inboxA.close();
    await inboxB.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the transport resolves the PRIVATE binding and sends the bounded terminal text", async () => {
  const root = tmpRoot();
  const inbox = await startInbox("accept");
  try {
    registerClaudeBinding(root, { sessionId: SESSION, socket: inbox.address, token: TOKEN });
    const deps: DeliveryDeps = { root, timeoutMs: 3000 };
    const outcome = await claudeNotificationTransport.deliver(TERMINAL_EVENT, target(SESSION), deps);
    assert.deepEqual(outcome, { delivered: true, reason: null, phase: "handoff" });
    assert.equal(inbox.frames.length, 1);
    const lines = inbox.frames[0]!.split("\n").filter(Boolean);
    assert.equal(JSON.parse(lines[0]!).token, TOKEN, "the auth frame carries the token from the private store");
    const content = JSON.parse(lines[1]!).message.content as string;
    assert.ok(content.includes("job-claude-1"));
    assert.ok(content.length <= CLAUDE_WAKE_MESSAGE_CAP);
    assert.equal(content.includes(TOKEN), false, "the message itself never carries the token");

    // The approval event goes through the same bound with its own text.
    const approval = await claudeNotificationTransport.deliver(
      {
        event: "approval_required",
        jobId: "job-claude-1",
        generation: 0,
        requestId: "req-9",
        provider: "command-code",
        toolName: "shell",
        operation: "rm -rf /tmp/x",
        cwd: null,
        hubUrl: "http://127.0.0.1:1/ui?job=job-claude-1&generation=0&request=req-9",
        expiresAt: "2026-10-01T01:00:00.000Z"
      },
      target(SESSION),
      deps
    );
    assert.equal(approval.delivered, true);
    assert.equal(inbox.frames.length, 2);
    const approvalContent = JSON.parse(inbox.frames[1]!.split("\n").filter(Boolean)[1]!).message.content as string;
    assert.ok(approvalContent.includes("not finished"));
    assert.equal(approvalContent.includes('Call crewdispatch_result(id='), false);

    // The RECOVERED terminal event goes through the same adapter with its own
    // identifiable, conditional text.
    const recovered = await claudeNotificationTransport.deliver(
      { event: "terminal_recovered", jobId: "job-claude-1", generation: 2, status: "done", collected: false },
      target(SESSION),
      deps
    );
    assert.equal(recovered.delivered, true);
    assert.equal(recovered.phase, "handoff");
    assert.equal(inbox.frames.length, 3);
    const recoveredContent = JSON.parse(inbox.frames[2]!.split("\n").filter(Boolean)[1]!).message.content as string;
    assert.ok(recoveredContent.includes("recovery"));
    assert.ok(recoveredContent.includes("run 3"));
    assert.ok(recoveredContent.includes("has not already been collected"));
    assert.ok(recoveredContent.length <= CLAUDE_RECOVERY_WAKE_MESSAGE_CAP);
  } finally {
    await inbox.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the default inbox timeout is a short bounded connection budget, not a task timeout", () => {
  assert.equal(CLAUDE_INBOX_TIMEOUT_MS, 5000);
});
