import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkBuddyAiCli, workBuddyAiProfileEnv } from "../../providers/workbuddy-ai/index";

import { connectSidecar } from "../../providers/workbuddy-ai/turn-cancel";
import { parseSidecarSessions, workBuddyDesktopConfigDir } from "../../providers/workbuddy-ai/desktop-bridge";
import { jobRuntimeId, registeredJobRuntime, disposeOwnedRuntime } from "../../providers/workbuddy-ai/runtime-lifecycle";

const ENABLED = process.env.JOBQUAY_ACCEPT_WORKBUDDY_DESKTOP_REAL === "1";
const BRIDGE = path.resolve(__dirname, "../../providers/workbuddy-ai/desktop-bridge.js");
const MODEL = process.env.JOBQUAY_ACCEPT_WORKBUDDY_MODEL?.trim() || "deepseek-v4.1-flash";

interface BridgeRecord {
  type?: string;
  session_id?: string;
  result?: string | null;
  subtype?: string;
  [key: string]: unknown;
}

function runBridge(input: {
  cliPath: string;
  cwd: string;
  prompt: string;
  resume?: string | null;
  permission?: string;
  disposeRuntime?: boolean;
  owner?: { jobId: string; generation: number; dataRoot: string };
}): { records: BridgeRecord[]; stdout: string; stderr: string } {
  const args = [
    BRIDGE,
    "--cli", input.cliPath,
    "--model", MODEL,
    "--permission", input.permission ?? "bypassPermissions",
    ...(input.resume ? ["--resume", input.resume] : []),
    ...(input.owner ? ["--job-id", input.owner.jobId, "--generation", String(input.owner.generation), "--data-root", input.owner.dataRoot] : []),
    ...(input.disposeRuntime ? ["--dispose-runtime", "true"] : [])
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: input.cwd,
    env: workBuddyAiProfileEnv(process.env),
    input: input.prompt,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  const stdout = typeof child.stdout === "string" ? child.stdout : "";
  const stderr = typeof child.stderr === "string" ? child.stderr : "";
  assert.equal(child.error, undefined, `bridge spawn error: ${String(child.error)}`);
  assert.equal(child.status, 0, `bridge failed status=${child.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const records = stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BridgeRecord);
  return { records, stdout, stderr };
}

function record(records: BridgeRecord[], type: string): BridgeRecord {
  const found = records.find((item) => item.type === type);
  assert.ok(found, `missing ${type} record in ${JSON.stringify(records)}`);
  return found;
}

test("WorkBuddy Desktop-only bridge reuses authenticated session and has coding write access", { skip: !ENABLED, timeout: 420_000 }, () => {
  assert.equal(process.platform, "win32", "this real acceptance is currently Windows-only");
  assert.equal(fs.existsSync(BRIDGE), true, "built Desktop bridge must exist");

  const resolution = resolveWorkBuddyAiCli({ env: workBuddyAiProfileEnv(process.env), platform: "win32" });
  assert.equal(resolution.ok, true, resolution.reason ?? "bundled WorkBuddy AI CLI must resolve");
  assert.ok(resolution.path);
  const cliPath = resolution.path!;

  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-resume-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-write-"));
  try {
    const secret = "JQ-RESUME-7391";
    const first = runBridge({
      cliPath,
      cwd: memoryRoot,
      prompt: `Remember the exact secret ${secret} for the next turn. Reply with exactly FIRST-OK and nothing else.`
    });
    const firstInit = record(first.records, "init");
    const firstResult = record(first.records, "result");
    assert.equal(firstResult.subtype, "success");
    assert.match(String(firstResult.result ?? ""), /FIRST-OK/);
    const sessionId = String(firstInit.session_id ?? "");
    assert.match(sessionId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

    const second = runBridge({
      cliPath,
      cwd: memoryRoot,
      resume: sessionId,
      disposeRuntime: true,
      prompt: "What exact secret did I ask you to remember in the previous turn? Reply with only the secret and nothing else."
    });
    const secondInit = record(second.records, "init");
    const secondResult = record(second.records, "result");
    assert.equal(secondInit.session_id, sessionId, "resume must keep the exact ACP session id");
    assert.match(String(secondResult.result ?? ""), new RegExp(secret), "resumed turn must retain prior conversation context");

    const fileName = "jobquay-workbuddy-desktop-write-probe.txt";
    const exactText = "JOBQUAY-WORKBUDDY-DESKTOP-WRITE-OK\n";
    const write = runBridge({
      cliPath,
      cwd: writeRoot,
      permission: "bypassPermissions",
      disposeRuntime: true,
      prompt:
        `Create ${fileName} in the current workspace with exactly JOBQUAY-WORKBUDDY-DESKTOP-WRITE-OK followed by one newline. ` +
        "Use a file-writing/editing tool, not shell, PowerShell, Python, or Node to create it. " +
        "After writing it, run a shell command that reads the file back, then reply with exactly WRITE-OK and nothing else."
    });
    const writeResult = record(write.records, "result");
    assert.equal(writeResult.subtype, "success");
    assert.match(String(writeResult.result ?? ""), /WRITE-OK/);
    const probePath = path.join(writeRoot, fileName);
    assert.equal(fs.existsSync(probePath), true, "Desktop-authenticated bypassPermissions session must create the workspace file");
    assert.equal(fs.readFileSync(probePath, "utf8").replace(/\r\n/g, "\n"), exactText);
  } finally {
    fs.rmSync(memoryRoot, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  }
});


test("private WB runtime exits after each turn and a new native process resumes the same persisted conversation", { skip: !ENABLED, timeout: 420_000 }, async () => {
  assert.equal(process.platform, "win32");
  const env = workBuddyAiProfileEnv(process.env);
  const cli = resolveWorkBuddyAiCli({ env, platform: "win32" });
  assert.equal(cli.ok, true, cli.reason ?? "installed WB CLI must resolve");
  assert.ok(cli.path);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-wb-private-resume-"));
  const dataRoot = path.join(root, "data");
  const jobId = "job-native-resume-" + crypto.randomBytes(5).toString("hex");
  const sidecar = await connectSidecar(workBuddyDesktopConfigDir(env), {});
  const before = parseSidecarSessions(await sidecar.request("session.list", {}));
  let passed = false;
  try {
    const marker = "CD-MEMORY-" + crypto.randomBytes(6).toString("hex");
    const first = runBridge({ cliPath: cli.path!, cwd: root, permission: "default",
      owner: { jobId, generation: 0, dataRoot },
      prompt: "Remember this exact marker for the next turn: " + marker + ". Do not use any tools. Reply exactly FIRST-OK." });
    const sid = String(record(first.records, "init").session_id);
    assert.equal(record(first.records, "result").subtype, "success");
    const firstRuntime = registeredJobRuntime(dataRoot, jobId, 0);
    assert.ok(firstRuntime?.runtimeId);
    assert.equal(parseSidecarSessions(await sidecar.request("session.list", {})).some(r => r.sessionId === jobRuntimeId(dataRoot, jobId, 0)), false);
    const firstReceipt = JSON.parse(fs.readFileSync(path.join(dataRoot, "provider-runtime/workbuddy-ai/history", firstRuntime.sessionId + ".json"), "utf8"));
    assert.equal(firstReceipt.released, true, "release requires the recorded OS PID to have exited");

    const second = runBridge({ cliPath: cli.path!, cwd: root, permission: "default", resume: sid,
      owner: { jobId, generation: 1, dataRoot },
      prompt: "What exact marker did I ask you to remember? Do not use tools. Reply only with that marker." });
    assert.equal(record(second.records, "init").session_id, sid);
    assert.equal(record(second.records, "result").subtype, "success");
    assert.ok(String(record(second.records, "result").result).includes(marker));
    const secondRuntime = registeredJobRuntime(dataRoot, jobId, 1);
    assert.ok(secondRuntime?.runtimeId);
    assert.notEqual(secondRuntime.runtimeId, firstRuntime.runtimeId, "native processes must be separate instances");
    const after = parseSidecarSessions(await sidecar.request("session.list", {}));
    assert.equal(after.some(r => r.sessionId === secondRuntime.sessionId), false);
    const secondReceipt = JSON.parse(fs.readFileSync(path.join(dataRoot, "provider-runtime/workbuddy-ai/history", secondRuntime.sessionId + ".json"), "utf8"));
    assert.equal(secondReceipt.released, true);
    for (const original of before) {
      assert.equal(after.find(r => r.sessionId === original.sessionId)?.pid, original.pid, "existing desktop and worker runtimes must survive unchanged");
    }
    passed = true;
  } finally {
    // Only this named test's opaque native instances may be released. Unknown
    // liveness retains the isolated fixture rather than deleting evidence.
    let cleanupConfirmed = true;
    for (const generation of [0, 1]) {
      const own = registeredJobRuntime(dataRoot, jobId, generation);
      if (own && !(await disposeOwnedRuntime(sidecar, own).catch(() => false))) cleanupConfirmed = false;
    }
    sidecar.close();
    if (passed && cleanupConfirmed) fs.rmSync(root, { recursive: true, force: true });
    else process.stderr.write("WB native test retained isolated evidence: " + root + "\n");
    // Native WB conversation JSONL is provider-owned; never delete user history.
  }
});
