// command-code-acp-client.test.ts — the transport contract of ONE ACP
// connection (`CcAcpConnection`).
//
// The defect these lock: a stdout EOF while the child process remained alive
// left `request(session/prompt, ..., null)` pending FOREVER, because only the
// child's `error`/`exit` events were observed and stdin errors were swallowed.
// A dead transport must reject pending work promptly; a QUIET transport must
// keep waiting (no total or idle prompt deadline). The real-subprocess case
// spawns an actual Node child that closes its own fd 1 and keeps running —
// the same shape the parent reproduction used.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { spawn as spawnType } from "node:child_process";
import { CcAcpConnection, CcAcpError } from "../../providers/command-code/acp-client";
import { isPidAlive } from "../../runtime/process";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = 424242;
  kill(): boolean {
    return true;
  }
}

function startFake(child: FakeChild): CcAcpConnection {
  const started = CcAcpConnection.start({
    cliPath: "/fake/bin/cmdc",
    cwd: process.cwd(),
    env: {},
    platform: "linux",
    spawnFn: (() => child) as unknown as typeof spawnType,
    killTreeFn: async () => true,
    controlTimeoutMs: 1000
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error("unreachable");
  return started.connection;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Real subprocess boundary
//
// Platform fact (measured on this Windows host, Node 22 and 24): a Node child
// that calls `fs.closeSync(1)` (or destroys process.stdout) does NOT make the
// PARENT-visible pipe reach EOF while the child lives — the OS keeps the write
// end open until process exit. The parent acceptance reproduction recorded
// `sawEof:true` only because it read that flag AFTER `close()` had already
// killed the child; its pre-close snapshot was still "pending". The
// deterministic alive-EOF semantics are covered by the stream-event tests
// above; the probe below proves the REAL pipe EOF path plus process cleanup.
// ---------------------------------------------------------------------------

test("a real subprocess whose stdout pipe reaches REAL EOF rejects the pending prompt and is cleaned up", { timeout: 40000 }, async () => {
  const spawned: ChildProcess[] = [];
  const started = CcAcpConnection.start({
    cliPath: process.execPath,
    cwd: process.cwd(),
    env: process.env,
    platform: process.platform,
    controlTimeoutMs: 1000,
    spawnFn: ((_file: string, _args: readonly string[]) => {
      // The child signals readiness on stderr while stdout is still OPEN. POSIX
      // can then close fd 1 while the process remains alive. Node's Windows
      // stdio wrapper does not reliably publish pipe EOF for closeSync/end while
      // the process stays alive, so Windows exits after the same quiet-open
      // phase; the parent still observes a REAL pipe EOF. The separate fake-child
      // test below proves stdout end/close itself rejects work before process exit.
      const eofScript = process.platform === "win32"
        ? 'process.stderr.write("READY\\n");setTimeout(()=>process.exit(0),1000);'
        : 'process.stderr.write("READY\\n");setTimeout(()=>require("node:fs").closeSync(1),1000);setInterval(()=>{},1000);';
      const disposable = spawn(
        process.execPath,
        ["-e", eofScript],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
      spawned.push(disposable);
      return disposable;
    }) as unknown as typeof spawnType
  });
  assert.equal(started.ok, true);
  const disposable = spawned[0];
  if (!started.ok || !disposable || disposable.pid == null) throw new Error("the disposable child did not start");
  const childPid = disposable.pid;
  const connection = started.connection;
  try {
    // Wait until the fixture is running while fd 1 is still open.
    await new Promise<void>((resolve) => {
      let buf = "";
      disposable.stderr?.setEncoding("utf8");
      disposable.stderr?.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.includes("READY")) resolve();
      });
      setTimeout(resolve, 5000).unref?.();
    });

    let state = "pending";
    const prompt = connection
      .request("session/prompt", { sessionId: "eof-probe", prompt: [] }, null)
      .then(() => (state = "resolved"), () => (state = "rejected"));

    // While the child is alive, the transport is quiet-but-open on this
    // platform: no failure may be invented from silence.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(connection.transportFailure(), null, "quiet must never be treated as EOF");
    assert.equal(state, "pending", "a quiet-but-open prompt keeps waiting");

    // The fixture now closes fd 1 while staying alive: the REAL EOF.
    let sawRealEof = false;
    disposable.stdout?.once("end", () => (sawRealEof = true));
    for (let i = 0; i < 200 && (!sawRealEof || state === "pending"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sawRealEof, true, "the real stdout pipe must emit EOF");
    assert.equal(state, "rejected", "the pending prompt must be rejected once the stream is dead");
    assert.ok(connection.transportFailure(), "the dead stream is a transport failure");
    await prompt;
    disposable.kill();

    const closed = await connection.close({ graceMs: 50, closeSession: false });
    assert.equal(closed.exited, true, "close() must prove the owned child exited");
    assert.notEqual(isPidAlive(childPid), true, "the owned child must be gone after close()");
  } finally {
    void connection.close({ graceMs: 50, closeSession: false }).catch(() => undefined);
  }
});

test("stdout end/close/error are transport failures: pending work is rejected and new work fails immediately", async () => {
  for (const kind of ["end", "close", "error"] as const) {
    const child = new FakeChild();
    const connection = startFake(child);
    let rejected: Error | null = null;
    const pending = connection.request("session/prompt", {}, null).catch((error: Error) => (rejected = error));
    await settle();
    if (kind === "error") child.stdout.emit("error", new Error("stream exploded"));
    else if (kind === "end") child.stdout.end();
    else child.stdout.destroy();
    await settle();
    await pending;
    assert.ok(rejected, `stdout ${kind} must reject the pending request`);
    assert.match((rejected as Error).message, /stdout/);
    await assert.rejects(
      connection.request("session/prompt", {}, null),
      /stdout/,
      `a request after stdout ${kind} must fail immediately`
    );
  }
});

test("a stdin error and a broken write are transport failures", async () => {
  const child = new FakeChild();
  const connection = startFake(child);
  let rejected: Error | null = null;
  const pending = connection.request("session/prompt", {}, null).catch((error: Error) => (rejected = error));
  await settle();
  child.stdin.emit("error", new Error("EPIPE"));
  await settle();
  await pending;
  assert.ok(rejected);
  assert.match((rejected as Error).message, /stdin failed/);

  const second = new FakeChild();
  const secondConnection = startFake(second);
  let writeRejected: Error | null = null;
  second.stdin.write = ((_chunk: string, callback?: (error?: Error | null) => void) => {
    callback?.(new Error("write EPIPE"));
    return false;
  }) as unknown as typeof second.stdin.write;
  const secondPending = secondConnection.request("session/prompt", {}, null).catch((error: Error) => (writeRejected = error));
  await settle();
  await secondPending;
  assert.ok(writeRejected);
  assert.match((writeRejected as Error).message, /could not be written/);

  // A destroyed stdin is the same class of failure.
  const third = new FakeChild();
  const thirdConnection = startFake(third);
  third.stdin.destroy();
  await assert.rejects(thirdConnection.request("session/prompt", {}, null), /not writable/);
});

test("a quiet-but-open prompt is NOT failed by any amount of elapsed time (mocked clock)", { timeout: 30000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const child = new FakeChild();
    const connection = startFake(child);
    let state = "pending";
    const prompt = connection.request("session/prompt", {}, null).then(
      (value) => {
        state = "resolved";
        return value;
      },
      () => {
        state = "rejected";
      }
    );
    await settle();
    mock.timers.tick(61 * 60_000);
    await settle();
    assert.equal(state, "pending", "no total or idle deadline may fail a quiet prompt");
    // The stream is alive: a late reply resolves the request.
    const id = 1;
    child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }) + "\n");
    await prompt;
    assert.equal(state, "resolved");
    assert.equal(connection.transportFailure(), null);
  } finally {
    mock.timers.reset();
  }
});

test("finite control/setup requests DO time out on the mocked clock", { timeout: 30000 }, async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const child = new FakeChild();
    const connection = startFake(child);
    let rejected: Error | null = null;
    const pending = connection.request("initialize", {}, 500).catch((error: Error) => (rejected = error));
    await settle();
    mock.timers.tick(500);
    await settle();
    await pending;
    assert.ok(rejected);
    assert.match((rejected as Error).message, /timed out after 500 ms/);
    // The connection itself is still usable: a control timeout is not a
    // transport failure.
    assert.equal(connection.transportFailure(), null);
  } finally {
    mock.timers.reset();
  }
});
