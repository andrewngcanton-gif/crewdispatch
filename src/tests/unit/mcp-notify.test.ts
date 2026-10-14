// mcp-notify.test.ts — unit coverage of the terminal-wake resolution, message
// bounds, safe argv and at-most-once delivery. Delivery is exercised with
// injected HTTP/spawn seams (no real network, no real Codex queue).
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCodexQueueSpawn,
  buildCodexWakeArgs,
  buildWakeMessage,
  deliverTerminalNotification,
  findInstalledMacCodex,
  findInstalledWindowsCodex,
  isValidCodexThreadId,
  NotifyInputError,
  resolveCodexCli,
  resolveNotifyTarget,
  sanitizeOneLineText,
  STDERR_DIAGNOSTIC_CAP,
  WAKE_MESSAGE_HARD_CAP,
  type DeliveryDeps
} from "../../mcp/notify";
import { createJobRecord } from "../../jobs/service";
import {
  claimNotificationAttempt,
  ensureRoot,
  loadJob,
  normalizeJob,
  notificationResultPath,
  readNotificationResults,
  readTerminalSnapshot,
  readTerminalSnapshots,
  saveJob,
  withMergedNotifications,
  writeTerminalSnapshot
} from "../../jobs/store";
import { isTerminalStatus, type JobRecord, type NotifyTarget } from "../../jobs/types";

const UUID = "12345678-1234-1234-1234-123456789abc";

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-notify-"));
  return dir;
}

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnCall {
  file: string;
  args: readonly string[];
  options: { shell?: boolean; windowsHide?: boolean; windowsVerbatimArguments?: boolean; stdio?: unknown };
}

/** A spawn seam that records the plan and reports immediate success. */
function recordingSpawn(calls: SpawnCall[]): NonNullable<DeliveryDeps["spawnFn"]> {
  return ((file: string, args: readonly string[], options: SpawnCall["options"]) => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    setImmediate(() => child.emit("close", 0));
    return child;
  }) as unknown as NonNullable<DeliveryDeps["spawnFn"]>;
}

/**
 * A spawn seam whose fake child emits `stderr` on its stderr pipe and then
 * closes with `code` — the real shape of a rejected `codex queue`.
 */
function stderrSpawn(calls: SpawnCall[], stderr: string, code: number | null): NonNullable<DeliveryDeps["spawnFn"]> {
  return ((file: string, args: readonly string[], options: SpawnCall["options"]) => {
    calls.push({ file, args, options });
    const child = new FakeChild() as FakeChild & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      child.emit("close", code);
    });
    return child;
  }) as unknown as NonNullable<DeliveryDeps["spawnFn"]>;
}

/**
 * A faux installed Codex Desktop layout: `%LOCALAPPDATA%\OpenAI\Codex\bin` maps
 * to `<binRoot>` and each version directory holds its own `codex.exe`.
 */
function makeInstalledCodex(binRoot: string, version: string, mtime: Date): string {
  const exe = path.join(binRoot, version, "codex.exe");
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "fake-codex-exe");
  fs.utimesSync(exe, mtime, mtime);
  return exe;
}

function makeMergedMacChatGptCodex(home: string): string {
  const exe = path.join(
    home,
    "Applications",
    "ChatGPT.app",
    "Contents",
    "Resources",
    "codex-cli",
    "CodexCLI.app",
    "Contents",
    "MacOS",
    "codex"
  );
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, "fake-macos-codex");
  fs.chmodSync(exe, 0o755);
  return exe;
}

function terminalJob(root: string, target: NotifyTarget, status: JobRecord["status"] = "done"): JobRecord {
  ensureRoot(root);
  const job = createJobRecord({ task: "notify-task-marker", cwd: process.cwd(), notifyTarget: target });
  job.status = status;
  job.finishedAt = new Date().toISOString();
  const saved = saveJob(root, job);
  if (isTerminalStatus(saved.status)) {
    writeTerminalSnapshot(root, saved.id, saved.generation, saved.status, saved.notifyTarget, "test");
  }
  return saved;
}

test("codex thread id validation accepts UUIDs/session names and rejects the rest", () => {
  assert.equal(isValidCodexThreadId(UUID), true);
  assert.equal(isValidCodexThreadId("my-session_1.2"), true);
  assert.equal(isValidCodexThreadId("abc"), true);
  assert.equal(isValidCodexThreadId(""), false);
  assert.equal(isValidCodexThreadId(" x"), false);
  assert.equal(isValidCodexThreadId("x "), false);
  assert.equal(isValidCodexThreadId("a b"), false);
  assert.equal(isValidCodexThreadId('a"b'), false);
  assert.equal(isValidCodexThreadId("a%b"), false);
  assert.equal(isValidCodexThreadId("a;b"), false);
  assert.equal(isValidCodexThreadId("a\nb"), false);
  assert.equal(isValidCodexThreadId("a".repeat(200)), false);
  assert.equal(isValidCodexThreadId(123), false);
});

test("wake target priority is callback_url > explicit thread id > env fallback", () => {
  const env = { CODEX_THREAD_ID: "env-thread" } as NodeJS.ProcessEnv;
  const both = resolveNotifyTarget({ callbackUrl: "http://127.0.0.1:9/w", codexThreadId: UUID, env });
  assert.equal(both.kind, "callback");
  assert.equal(both.source, "callback_url");
  assert.equal(both.codexThreadId, null);

  const explicit = resolveNotifyTarget({ codexThreadId: UUID, env });
  assert.equal(explicit.kind, "codex_thread");
  assert.equal(explicit.source, "codex_thread_id");
  assert.equal(explicit.codexThreadId, UUID);

  const fallback = resolveNotifyTarget({ env });
  assert.equal(fallback.kind, "codex_thread");
  assert.equal(fallback.source, "env");
  assert.equal(fallback.codexThreadId, "env-thread");

  const none = resolveNotifyTarget({ env: {} as NodeJS.ProcessEnv });
  assert.equal(none.kind, "none");
  assert.equal(none.source, null);
});

test("an invalid explicit wake target is rejected with a stable code", () => {
  assert.throws(
    () => resolveNotifyTarget({ callbackUrl: "ftp://nope" }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "invalid_callback_url"
  );
  assert.throws(
    () => resolveNotifyTarget({ codexThreadId: "bad id!" }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "invalid_codex_thread_id"
  );
});

test("the wake message is bounded, short, and never carries the task", () => {
  const msg = buildWakeMessage("job-abc-123", "done");
  assert.ok(msg.includes("job-abc-123"));
  assert.ok(msg.includes("done"));
  assert.ok(msg.length <= WAKE_MESSAGE_HARD_CAP);
  assert.equal(msg.includes("notify-task-marker"), false);

  const long = buildWakeMessage(`job-${"x".repeat(400)}`, "done");
  assert.ok(long.length <= WAKE_MESSAGE_HARD_CAP, "an absurd id must still fit the hard cap");
});

test("sanitizeOneLineText strips ANSI CSI/SGR sequences but keeps the text", () => {
  // A color-wrapped diagnostic keeps its text and loses the whole sequence.
  // Merely turning the ESC byte into whitespace would leave `[31m` residue.
  assert.equal(sanitizeOneLineText("\u001b[31mError\u001b[0m", "fb"), "Error");
  assert.equal(sanitizeOneLineText("a \u001b[1;31mB\u001b[0m c", "fb"), "a B c");
  assert.equal(sanitizeOneLineText("\u001b[?25lhidden\u001b[?25h", "fb"), "hidden");
  // ANSI-only input normalizes to nothing useful and takes the fallback.
  assert.equal(sanitizeOneLineText("\u001b[31m\u001b[0m", "fb"), "fb");
  // Ordinary bracketed text WITHOUT an escape introducer is not over-stripped.
  assert.equal(sanitizeOneLineText("literal [31m and [0m stay", "fb"), "literal [31m and [0m stay");
  // The existing control-character / one-line normalization is unchanged.
  assert.equal(sanitizeOneLineText("a\r\n\tb\u0000c", "fb"), "a b c");
  assert.equal(sanitizeOneLineText(null, "fb"), "fb");
  assert.equal(sanitizeOneLineText("   ", "fb"), "fb");
});

test("buildCodexWakeArgs is shell-free and rejects an invalid thread id", () => {
  const args = buildCodexWakeArgs(UUID, "job-1", "done");
  assert.ok(args);
  assert.deepEqual(args!.slice(0, 3), ["queue", "--thread", UUID]);
  assert.equal(args![3], "--message");
  assert.ok(args![4]!.includes("job-1"));
  assert.equal(buildCodexWakeArgs("bad id!", "job-1", "done"), null);
});

test("buildCodexQueueSpawn is shell-free for a native exe and shim-safe for a .cmd", () => {
  const native = buildCodexQueueSpawn("C:\\tools\\codex.exe", ["queue", "--thread", UUID, "--message", "hi"], { platform: "win32" });
  assert.equal(native.file, "C:\\tools\\codex.exe");
  assert.equal(native.windowsVerbatimArguments, false);
  assert.deepEqual(native.args, ["queue", "--thread", UUID, "--message", "hi"]);

  const shim = buildCodexQueueSpawn("C:\\tools\\codex.cmd", ["queue", "--thread", UUID, "--message", "hi"], { platform: "win32" });
  assert.match(shim.file, /cmd\.exe$/i);
  assert.equal(shim.windowsVerbatimArguments, true);
  assert.equal(shim.args[0], "/d");

  assert.throws(
    () => buildCodexQueueSpawn("C:\\tools\\codex.cmd", ["queue", "--message", 'a"b'], { platform: "win32" }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "unsafe_shim_argv"
  );
});

test("Windows Codex resolution uses the run-task driver's installed locations when PATH has no codex", () => {
  const root = tmpRoot();
  try {
    const binRoot = path.join(root, "OpenAI", "Codex", "bin");
    const older = makeInstalledCodex(binRoot, "aaaa1111", new Date(Date.now() - 60_000));
    // A version directory WITHOUT codex.exe (the real layout has rg.exe-only
    // helper directories) must be skipped, not guessed at.
    fs.mkdirSync(path.join(binRoot, "bbbb2222"), { recursive: true });
    fs.writeFileSync(path.join(binRoot, "bbbb2222", "rg.exe"), "fake-rg");
    const newer = makeInstalledCodex(binRoot, "cccc3333", new Date());
    const env = {
      LOCALAPPDATA: root,
      CODEX_HOME: path.join(root, "no-codex-home"),
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    } as NodeJS.ProcessEnv;

    assert.equal(resolveCodexCli({ env, platform: "win32" }), newer);
    assert.notEqual(newer, older);

    // The resolved exe is planned directly: no shim, each token its own argv element.
    const plan = buildCodexQueueSpawn(resolveCodexCli({ env, platform: "win32" }), ["queue", "--thread", UUID, "--message", "hi"], { platform: "win32", env });
    assert.equal(plan.file, newer);
    assert.equal(plan.shellShim, null);
    assert.equal(plan.windowsVerbatimArguments, false);

    // Non-Windows behavior stays PATH-based: the installed layout is not consulted.
    assert.equal(resolveCodexCli({ env, platform: "linux" }), "codex");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Codex resolution discovers the CLI bundled inside merged ChatGPT.app", () => {
  const root = tmpRoot();
  try {
    const bundled = makeMergedMacChatGptCodex(root);
    const env = { HOME: root, PATH: "" } as NodeJS.ProcessEnv;
    assert.equal(
      findInstalledMacCodex(env, { systemApplicationsRoot: path.join(root, "no-system") }),
      bundled
    );

    // The production resolver uses the verified /Applications and ~/Applications
    // roots. On a host with a real system ChatGPT.app that path intentionally
    // wins; the helper seam above keeps the user-app branch deterministic.
    const resolved = resolveCodexCli({ env: process.env, platform: "darwin" });
    if (process.platform === "darwin" && fs.existsSync("/Applications/ChatGPT.app")) {
      assert.match(resolved, /ChatGPT\.app[\/]Contents[\/]Resources[\/]codex-cli/);
    }

    const plan = buildCodexQueueSpawn(bundled, ["queue", "--thread", UUID, "--message", "hi"], { platform: "darwin", env });
    assert.equal(plan.file, bundled);
    assert.deepEqual(plan.args, ["queue", "--thread", UUID, "--message", "hi"]);
    assert.equal(plan.windowsVerbatimArguments, false);
    assert.equal(plan.shellShim, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Codex resolution falls back to the CODEX_HOME sandbox copy in the driver's order", () => {
  const root = tmpRoot();
  try {
    const codexHome = path.join(root, "codex-home");
    const sandbox = path.join(codexHome, ".sandbox-bin", "codex.exe");
    fs.mkdirSync(path.dirname(sandbox), { recursive: true });
    fs.writeFileSync(sandbox, "fake-codex-exe");
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: codexHome, PATH: "" } as NodeJS.ProcessEnv;
    assert.equal(resolveCodexCli({ env, platform: "win32" }), sandbox);

    // When both locations exist, the %LOCALAPPDATA% install wins (driver order).
    const installed = makeInstalledCodex(path.join(root, "local", "OpenAI", "Codex", "bin"), "dddd4444", new Date());
    const both = { ...env, LOCALAPPDATA: path.join(root, "local") } as NodeJS.ProcessEnv;
    assert.equal(findInstalledWindowsCodex(both, "win32"), installed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit codexCliPath and CODEX_CLI_PATH keep precedence over Windows discovery", () => {
  const root = tmpRoot();
  try {
    const installed = makeInstalledCodex(path.join(root, "OpenAI", "Codex", "bin"), "eeee5555", new Date());
    const explicit = path.join(root, "custom", "my-codex.exe");
    fs.mkdirSync(path.dirname(explicit), { recursive: true });
    fs.writeFileSync(explicit, "fake");
    const env = { LOCALAPPDATA: root, CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;

    assert.notEqual(installed, explicit);
    assert.equal(resolveCodexCli({ codexCliPath: explicit, env, platform: "win32" }), explicit);
    assert.equal(resolveCodexCli({ codexCliPath: "my-codex", env, platform: "win32" }), "my-codex");
    assert.equal(resolveCodexCli({ env: { ...env, CODEX_CLI_PATH: explicit }, platform: "win32" }), explicit);
    // An unprovable explicit override is never silently replaced by a discovered install.
    assert.equal(resolveCodexCli({ codexCliPath: path.join(root, "custom", "missing.exe"), env, platform: "win32" }), "codex");

    // Shim safety is unchanged: an explicit .cmd still goes through cmd.exe with per-token quoting.
    const shim = path.join(root, "custom", "codex.cmd");
    fs.writeFileSync(shim, "@echo off");
    const shimPlan = buildCodexQueueSpawn(resolveCodexCli({ codexCliPath: shim, env, platform: "win32" }), ["queue", "--thread", UUID, "--message", "hi"], { platform: "win32", env });
    assert.match(shimPlan.file, /cmd\.exe$/i);
    assert.equal(shimPlan.windowsVerbatimArguments, true);
    assert.equal(shimPlan.shellShim, shim);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the notification claim is at-most-once per generation", () => {
  const root = tmpRoot();
  try {
    ensureRoot(root);
    assert.equal(claimNotificationAttempt(root, "job-1", 0), true);
    assert.equal(claimNotificationAttempt(root, "job-1", 0), false, "a second claim for the same generation must fail");
    assert.equal(claimNotificationAttempt(root, "job-1", 1), true, "a new generation gets its own claim");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal wake is delivered once, persisted in a generation-scoped file, and never repeats", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" });
    let posts = 0;
    const deps = {
      httpPostFn: async () => {
        posts += 1;
        return { delivered: true, reason: null };
      }
    };
    const rec = await deliverTerminalNotification(root, job.id, deps);
    assert.ok(rec);
    assert.equal(rec!.delivered, true);
    assert.equal(posts, 1);

    const again = await deliverTerminalNotification(root, job.id, deps);
    assert.equal(again, null, "a second attempt for the same generation must be a no-op");
    assert.equal(posts, 1);

    // The result is a FILE, not a rewrite of the job record.
    const results = readNotificationResults(root, job.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.generation, 0);
    assert.equal(results[0]!.delivered, true);
    assert.equal(loadJob(root, job.id)!.notifications.length, 0, "the record itself must not carry the wake result");
    assert.equal(loadJob(root, job.id)!.status, "done");
    assert.equal(loadJob(root, job.id)!.notifyTarget.kind, "callback");

    // The read view merges the file result in.
    const merged = withMergedNotifications(root, loadJob(root, job.id)!);
    assert.equal(merged.notifications.length, 1);
    assert.equal(merged.notifications[0]!.delivered, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a delivery failure is recorded but never changes the terminal result", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" });
    const rec = await deliverTerminalNotification(root, job.id, {
      httpPostFn: async () => ({ delivered: false, reason: "http_status_500" })
    });
    assert.equal(rec!.delivered, false);
    assert.equal(rec!.reason, "http_status_500");
    const stored = loadJob(root, job.id)!;
    assert.equal(stored.status, "done", "the job outcome must be untouched by a failed wake");
    assert.equal(readNotificationResults(root, job.id)[0]!.delivered, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a codex-thread wake whose codex spawn fails is recorded once and never retried", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" });
    // No override and no discoverable installed executable: resolution must keep
    // the honest bare `codex` PATH attempt instead of guessing a path, and the
    // real observed failure (`spawn codex ENOENT`) must be recorded once and
    // must NOT be retried (the bridge cannot be woken twice).
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;
    assert.equal(resolveCodexCli({ env, platform: "win32" }), "codex");
    const failingSpawn = (() => {
      throw new Error("spawn codex ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    const rec = await deliverTerminalNotification(root, job.id, { spawnFn: failingSpawn, env, platform: "win32" });
    assert.equal(rec!.delivered, false);
    assert.match(String(rec!.reason), /^spawn_failed:/);
    assert.match(String(rec!.reason), /ENOENT/);
    assert.equal(loadJob(root, job.id)!.status, "done", "a failed wake must never change the job outcome");
    const again = await deliverTerminalNotification(root, job.id, { spawnFn: failingSpawn, env, platform: "win32" });
    assert.equal(again, null, "the generation-scoped claim must prevent a retry");
    assert.equal(readNotificationResults(root, job.id).length, 1, "exactly one attempt record must exist");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("historical PATH-less harness env: the installed codex.exe is found and the wake is delivered exactly once", async () => {
  // job-muntyif1-tf2yyi (2026-09-30) reached terminal with a valid codex_thread
  // target, but the finalizing harness process had no `codex` on PATH:
  // `spawn_failed:spawn codex ENOENT` was recorded and the at-most-once claim
  // (correctly) never retried. The thread id and status below are the
  // historical ones; with the installed Codex Desktop layout present, the same
  // env must resolve the real executable and deliver once.
  const root = tmpRoot();
  try {
    const exe = makeInstalledCodex(path.join(root, "OpenAI", "Codex", "bin"), "c6fe824d725f02d7", new Date());
    const env = {
      LOCALAPPDATA: root,
      CODEX_HOME: path.join(root, "no-codex-home"),
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD"
    } as NodeJS.ProcessEnv;
    const thread = "01a0eb68-c611-7232-9100-d6add6e5c807";
    const job = terminalJob(root, { kind: "codex_thread", callbackUrl: null, codexThreadId: thread, source: "codex_thread_id" }, "cancelled");

    const calls: SpawnCall[] = [];
    const deps: DeliveryDeps = { env, platform: "win32", spawnFn: recordingSpawn(calls) };
    const rec = await deliverTerminalNotification(root, job.id, deps);
    assert.equal(rec!.delivered, true);
    assert.equal(calls.length, 1, "exactly one delivery attempt");
    assert.equal(calls[0]!.file, exe, "the installed codex.exe must be spawned");
    assert.deepEqual(calls[0]!.args.slice(0, 3), ["queue", "--thread", thread]);
    assert.equal(calls[0]!.options.shell, false);
    assert.equal(calls[0]!.options.windowsHide, true);
    assert.equal(calls[0]!.options.windowsVerbatimArguments, false);

    const again = await deliverTerminalNotification(root, job.id, deps);
    assert.equal(again, null, "the generation-scoped claim still forbids a second attempt");
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("delivering an OLD terminal generation never overwrites a newer generation's record", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" });
    assert.ok(readTerminalSnapshot(root, job.id, 0), "the terminal write must snapshot generation 0");

    // Simulate a follow-up that bumps the record to generation 1 WHILE the gen-0
    // wake is still in flight (the record is now a running, gen-1 job).
    const bumped: JobRecord = {
      ...loadJob(root, job.id)!,
      generation: 1,
      status: "running",
      task: "NEW_GENERATION_TASK",
      finishedAt: null,
      result: null
    };
    saveJob(root, bumped);

    const rec = await deliverTerminalNotification(
      root,
      job.id,
      { httpPostFn: async () => ({ delivered: true, reason: null }) },
      { generation: 0 }
    );
    assert.equal(rec!.generation, 0);
    assert.equal(rec!.delivered, true);

    // The live record is STILL generation 1 / running with its own task.
    const after = loadJob(root, job.id)!;
    assert.equal(after.generation, 1, "the newer generation must not regress");
    assert.equal(after.status, "running");
    assert.equal(after.task, "NEW_GENERATION_TASK");
    // The gen-0 result is a separate file and the gen-1 generation has no wake yet.
    assert.deepEqual(readNotificationResults(root, job.id).map((r) => r.generation), [0]);
    assert.equal(after.notifications.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a no-generation delivery wakes EVERY un-attempted terminal generation exactly once", async () => {
  const root = tmpRoot();
  try {
    const target: NotifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" };
    const job = terminalJob(root, target); // generation 0
    // A later continuation reached its own terminal state: snapshot generation 1.
    writeTerminalSnapshot(root, job.id, 1, "error", target, "test");

    let posts = 0;
    const deps = { httpPostFn: async () => { posts += 1; return { delivered: true, reason: null }; } };
    await deliverTerminalNotification(root, job.id, deps);
    assert.equal(posts, 2, "both terminal generations are attempted");
    assert.deepEqual(readNotificationResults(root, job.id).map((r) => r.generation), [0, 1]);

    await deliverTerminalNotification(root, job.id, deps);
    assert.equal(posts, 2, "a repeat read must not re-deliver");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal generation with no snapshot is still discovered from the record (legacy)", async () => {
  const root = tmpRoot();
  try {
    ensureRoot(root);
    // A record written by an older build: terminal but no snapshot file.
    const job = createJobRecord({
      task: "legacy",
      cwd: process.cwd(),
      notifyTarget: { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" }
    });
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    saveJob(root, job);
    assert.equal(readTerminalSnapshots(root, job.id).length, 0);

    let posts = 0;
    const rec = await deliverTerminalNotification(root, job.id, {
      httpPostFn: async () => { posts += 1; return { delivered: true, reason: null }; }
    });
    assert.equal(rec!.delivered, true);
    assert.equal(posts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a current terminal generation is recovered even when older snapshots exist", async () => {
  const root = tmpRoot();
  try {
    const target: NotifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" };
    const previous = terminalJob(root, target); // generation 0 has a snapshot
    const current = { ...loadJob(root, previous.id)!, generation: 1, status: "done" as const };
    saveJob(root, current); // simulate a crash after the gen-1 terminal record write
    assert.equal(readTerminalSnapshot(root, previous.id, 1), null);

    let posts = 0;
    await deliverTerminalNotification(root, previous.id, {
      httpPostFn: async () => { posts += 1; return { delivered: true, reason: null }; }
    });
    assert.equal(posts, 2, "both the old snapshot and current terminal record must be woken");
    assert.deepEqual(readNotificationResults(root, previous.id).map((r) => r.generation), [0, 1]);
    assert.equal(loadJob(root, previous.id)!.generation, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no target is a recorded diagnostic, and a non-terminal job is never woken", async () => {
  const root = tmpRoot();
  try {
    const none = terminalJob(root, { kind: "none", callbackUrl: null, codexThreadId: null, source: null });
    const rec = await deliverTerminalNotification(root, none.id, {});
    assert.equal(rec!.delivered, false);
    assert.equal(rec!.reason, "no_target");

    const running = terminalJob(root, { kind: "none", callbackUrl: null, codexThreadId: null, source: null }, "running");
    assert.equal(await deliverTerminalNotification(root, running.id, {}), null, "a non-terminal job must never be woken");
    assert.equal(loadJob(root, running.id)!.notifications.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-20: the durable delivery ORIGIN
// ---------------------------------------------------------------------------

test("the delivery origin is persisted for worker/cancel/reconcile-style wakes and never invented", async () => {
  const root = tmpRoot();
  try {
    const target: NotifyTarget = { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" };
    const deps: DeliveryDeps = { httpPostFn: async () => ({ delivered: true, reason: null }) };
    for (const origin of ["worker", "cancel", "hub-reconcile", "daemon-reconcile"]) {
      const job = terminalJob(root, target);
      const rec = await deliverTerminalNotification(root, job.id, deps, { by: origin });
      assert.equal(rec!.by, origin);
      assert.equal(readNotificationResults(root, job.id)[0]!.by, origin, `the ${origin} origin must be durable`);
    }

    // No origin supplied: the record stays honestly unknown instead of guessing.
    const unlabeled = terminalJob(root, target);
    const rec = await deliverTerminalNotification(root, unlabeled.id, deps);
    assert.equal(rec!.by, null, "an unspecified origin must never be invented");
    assert.equal(readNotificationResults(root, unlabeled.id)[0]!.by, null);
    const raw = JSON.parse(fs.readFileSync(notificationResultPath(root, unlabeled.id, 0), "utf8")) as Record<string, unknown>;
    assert.equal(raw.by, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old wake result without an origin still loads and blocks redelivery", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "callback", callbackUrl: "http://127.0.0.1:1/wake", codexThreadId: null, source: "callback_url" });
    // A result file written before the origin field existed: no `by` key at all.
    const file = notificationResultPath(root, job.id, 0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ generation: 0, kind: "callback", attemptedAt: "2026-09-30T00:00:00.000Z", delivered: true, reason: null })
    );

    const results = readNotificationResults(root, job.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]!.by, null, "a missing origin is unknown, never invented");
    assert.equal(results[0]!.delivered, true);

    let posts = 0;
    const again = await deliverTerminalNotification(root, job.id, {
      httpPostFn: async () => {
        posts += 1;
        return { delivered: true, reason: null };
      }
    });
    assert.equal(again, null, "the old record still counts as this generation's attempt");
    assert.equal(posts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an inline legacy notification without an origin normalizes to null", () => {
  const job = createJobRecord({
    task: "legacy-notify",
    cwd: process.cwd(),
    notifyTarget: { kind: "none", callbackUrl: null, codexThreadId: null, source: null }
  });
  const raw = JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
  raw.notifications = [{ generation: 0, kind: "none", attemptedAt: "t", delivered: false, reason: "no_target" }];
  const normalized = normalizeJob(raw);
  assert.equal(normalized.notifications.length, 1);
  assert.equal(normalized.notifications[0]!.by, null);
  assert.equal(normalized.notifications[0]!.reason, "no_target");
});

// ---------------------------------------------------------------------------
// JQ-20261001-21: a failed codex queue wake records a bounded stderr diagnostic
// ---------------------------------------------------------------------------

test("a rejected codex wake records exit_<n> plus the bounded sanitized stderr diagnostic", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" });
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;
    const calls: SpawnCall[] = [];
    const rec = await deliverTerminalNotification(root, job.id, {
      env,
      platform: "win32",
      spawnFn: stderrSpawn(calls, "error: thread not found; queue rejected", 3)
    });
    assert.equal(rec!.delivered, false);
    assert.equal(rec!.reason, "exit_3: error: thread not found; queue rejected");
    assert.equal(readNotificationResults(root, job.id)[0]!.reason, rec!.reason, "the diagnostic must be durable");
    assert.equal(calls.length, 1);
    // stderr is PIPED (not ignored) so the rejection can be observed at all.
    assert.deepEqual(calls[0]!.options.stdio, ["ignore", "ignore", "pipe"]);
    assert.equal(loadJob(root, job.id)!.status, "done", "a failed wake must never change the job outcome");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the wake stderr diagnostic is ANSI-cleaned, bounded, and empty stderr keeps exit_<n>", async () => {
  const root = tmpRoot();
  try {
    const target: NotifyTarget = { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" };
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;

    // A color-wrapped rejection: the text survives, the SGR residue does not.
    const ansi = terminalJob(root, target);
    let rec = await deliverTerminalNotification(root, ansi.id, {
      env,
      platform: "win32",
      spawnFn: stderrSpawn([], "\u001b[31mqueue rejected\u001b[0m", 1)
    });
    assert.equal(rec!.reason, "exit_1: queue rejected");

    // Empty (or whitespace-only) stderr keeps the honest plain exit code.
    const empty = terminalJob(root, target);
    rec = await deliverTerminalNotification(root, empty.id, { env, platform: "win32", spawnFn: stderrSpawn([], "   ", 2) });
    assert.equal(rec!.reason, "exit_2");

    // An oversized rejection keeps only the bounded normalized TAIL.
    const huge = terminalJob(root, target);
    const noisy = "head-" + "x".repeat(5 * STDERR_DIAGNOSTIC_CAP) + "-tail";
    rec = await deliverTerminalNotification(root, huge.id, { env, platform: "win32", spawnFn: stderrSpawn([], noisy, 4) });
    const diagnostic = rec!.reason!.slice("exit_4: ".length);
    assert.equal(rec!.reason!.startsWith("exit_4: "), true);
    assert.equal(diagnostic.length, STDERR_DIAGNOSTIC_CAP);
    assert.equal(diagnostic.endsWith("-tail"), true, "the final stderr bytes must be kept");
    assert.equal(diagnostic.includes("head-"), false, "the dump must be bounded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a successful codex wake never records stderr", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" });
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;
    const rec = await deliverTerminalNotification(root, job.id, {
      env,
      platform: "win32",
      spawnFn: stderrSpawn([], "WARN_STDERR_MARKER", 0)
    });
    assert.equal(rec!.delivered, true);
    assert.equal(rec!.reason, null);
    const raw = fs.readFileSync(notificationResultPath(root, job.id, 0), "utf8");
    assert.equal(raw.includes("WARN_STDERR_MARKER"), false, "a successful delivery record must not carry stderr");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed wake with a stderr diagnostic is attempted exactly once and never retried", async () => {
  const root = tmpRoot();
  try {
    const job = terminalJob(root, { kind: "codex_thread", callbackUrl: null, codexThreadId: UUID, source: "codex_thread_id" });
    const env = { LOCALAPPDATA: path.join(root, "no-local"), CODEX_HOME: path.join(root, "no-home"), PATH: "" } as NodeJS.ProcessEnv;
    const calls: SpawnCall[] = [];
    const deps: DeliveryDeps = { env, platform: "win32", spawnFn: stderrSpawn(calls, "queue rejected", 5) };
    const rec = await deliverTerminalNotification(root, job.id, deps);
    assert.equal(rec!.reason, "exit_5: queue rejected");

    const again = await deliverTerminalNotification(root, job.id, deps);
    assert.equal(again, null, "the at-most-once claim must prevent any retry");
    assert.equal(calls.length, 1, "no retry after a failed delivery attempt");
    assert.equal(readNotificationResults(root, job.id).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
