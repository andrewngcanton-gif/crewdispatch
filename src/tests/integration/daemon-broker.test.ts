import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../daemon/server";
import { createJobRecord } from "../../jobs/service";
import { daemonPaths, ensureJobDaemon, shutdownJobDaemon, startJobViaDaemon } from "../../daemon/client";
import { DAEMON_META_VERSION } from "../../daemon/protocol";
import { captureProcessIdentity, isPidAlive } from "../../runtime/process";
import { loadJob, saveJob } from "../../jobs/store";
import { emptyUsage } from "../../jobs/types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTerminal(root: string, id: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = loadJob(root, id);
    if (job && ["done", "error", "cancelled", "interrupted"].includes(job.status)) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${id} terminal`);
    await sleep(50);
  }
}

async function removeDaemonTestRoot(dir: string): Promise<void> {
  let lastCleanupError: unknown = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      lastCleanupError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw e;
      await sleep(100);
    }
  }
  assert.fail(`temporary daemon test root can be cleaned after handles settle; last error=${String((lastCleanupError as Error)?.message || lastCleanupError || "none")}`);
}

test("daemon client reuses one broker and the broker owns the spawned worker", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-daemon-broker-"));
  const root = path.join(dir, "root");
  const cwd = path.join(dir, "cwd");
  const fixture = path.join(dir, "fixture.cjs");
  fs.mkdirSync(cwd, { recursive: true });

  fs.writeFileSync(
    fixture,
    [
      'const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
      'process.stdin.resume();',
      'process.stdin.on("end",()=>{',
      ' out({type:"event",event:{type:"run_start",sessionId:"daemon-fixture-session"}});',
      ' out({type:"result",subtype:"success",result:"DAEMON_OK",session_id:"daemon-fixture-session",stop_reason:"end_turn"});',
      ' process.exit(0);',
      '});'
    ].join("\n"),
    "utf8"
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_FIXTURE: fixture,
    JOBQUAY_CLI_AUTODISCOVER: "false"
  };

  const daemon = await startDaemon(root);
  try {
    const first = await ensureJobDaemon(root, env);
    const second = await ensureJobDaemon(root, env);
    assert.equal(first.pid, process.pid, "in-process daemon metadata identifies its owner");
    assert.equal(second.pid, first.pid, "ensure reuses the healthy broker instead of creating a duplicate");
    assert.equal(second.port, first.port);
    if (process.platform === "darwin") {
      const self = captureProcessIdentity(process.pid);
      assert.ok(self?.createdAtUs != null, "Darwin in-process daemon has exact birth evidence");
      assert.equal(first.startedAtUs, self!.createdAtUs);
      assert.equal(first.pgid, self!.pgid);
      assert.equal(first.sid, self!.sid);
    }

    const launched = await startJobViaDaemon(root, {
      task: "DAEMON_PROTOCOL_START",
      cwd,
      runner: "fixture",
      fixturePath: fixture,
      env
    });
    assert.ok(launched.workerPid && launched.workerPid !== process.pid, "worker is a child owned by the broker");
    await waitForTerminal(root, launched.job.id);
    const final = loadJob(root, launched.job.id);
    assert.ok(final);
    assert.equal(final.status, "done");
    assert.equal(final.result?.finalText, "DAEMON_OK");
    if (process.platform === "darwin") {
      assert.ok(final.ownerStartedAtUs != null, "worker owner birth is persisted for Darwin reconciliation");
    }
  } finally {
    await daemon.close();
    // A just-exited worker/log close or the daemon's final metadata unlink can
    // briefly race recursive deletion on both Windows and Darwin. Cleanup is not
    // evidence about broker ownership, so retry only the documented transient
    // filesystem errors without weakening any lifecycle assertion.
    await removeDaemonTestRoot(dir);
  }
});

test(
  "Darwin daemon admission settles a pre-boot orphan before accepting a new job in the same workspace",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch), timeout: 30_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-daemon-boot-recovery-"));
    const root = path.join(dir, "root");
    const cwd = path.join(dir, "cwd");
    const fixture = path.join(dir, "fixture.cjs");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      fixture,
      [
        'const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");',
        'process.stdin.resume();',
        'process.stdin.on("end",()=>{',
        ' out({type:"event",event:{type:"run_start",sessionId:"daemon-boot-session"}});',
        ' out({type:"result",subtype:"success",result:"BOOT_RECOVERY_OK",session_id:"daemon-boot-session",stop_reason:"end_turn"});',
        ' process.exit(0);',
        '});'
      ].join("\n"),
      "utf8"
    );

    const startedAtMs = Date.now() - 120_000;
    const bootAtMs = Date.now() - 60_000;
    const old = createJobRecord({ task: "PRE_BOOT_ORPHAN", cwd });
    old.status = "orphaned";
    old.stopReason = "owner_lost_child_unconfirmed";
    old.failureKind = "owner_lost_child_unconfirmed";
    old.error = "old tree was unconfirmed before reboot";
    old.childPid = process.pid;
    old.childGeneration = 0;
    old.attempts = [{
      generation: 0,
      startedAt: new Date(startedAtMs).toISOString(),
      endedAt: null,
      exitCode: null,
      kind: null,
      failureKind: null,
      segment: false,
      resumedFrom: null,
      model: null,
      modelSource: null,
      effort: null,
      rateLimited: false,
      switched: false,
      switchToModel: null,
      usage: emptyUsage()
    }];
    saveJob(root, old);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JOBQUAY_DATA_ROOT: root,
      JOBQUAY_TEST_FIXTURE: fixture,
      JOBQUAY_CLI_AUTODISCOVER: "false"
    };
    const daemon = await startDaemon(root, {
      readBootTimeFn: async () => ({ ok: true, bootTimeMs: bootAtMs, reason: null })
    });
    try {
      const launched = await startJobViaDaemon(root, {
        task: "AFTER_REBOOT_DISPATCH",
        cwd,
        runner: "fixture",
        fixturePath: fixture,
        env
      });
      assert.notEqual(launched.job.id, old.id);

      const recovered = loadJob(root, old.id)!;
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.childPid, null);
      assert.equal(isPidAlive(process.pid), true, "the current reused PID is never signalled by reboot recovery");

      await waitForTerminal(root, launched.job.id);
      assert.equal(loadJob(root, launched.job.id)?.result?.finalText, "BOOT_RECOVERY_OK");
    } finally {
      await daemon.close();
      await removeDaemonTestRoot(dir);
    }
  }
);

test(
  "Darwin daemon startup treats a live reused metadata PID as stale instead of live-unhealthy",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch), timeout: 30_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-daemon-reused-"));
    const root = path.join(dir, "root");
    const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: root };
    const paths = daemonPaths(root, env);
    fs.mkdirSync(paths.dir, { recursive: true });

    const self = captureProcessIdentity(process.pid);
    assert.ok(self?.createdAtUs != null, "test host has exact Darwin birth evidence");
    fs.writeFileSync(
      paths.meta,
      JSON.stringify({
        version: DAEMON_META_VERSION,
        protocolVersion: 1,
        pid: process.pid,
        startedAtUs: self!.createdAtUs! + 1,
        pgid: self!.pgid,
        sid: self!.sid,
        port: 65534,
        token: "x".repeat(64),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        serverPath: "/stale/daemon/server.js"
      }),
      { encoding: "utf8", mode: 0o600 }
    );

    try {
      const meta = await ensureJobDaemon(root, env);
      assert.notEqual(meta.pid, process.pid, "wrong-birth live PID metadata is discarded and a new broker starts");
      assert.ok(meta.startedAtUs != null, "replacement broker publishes exact Darwin birth");
      const actual = captureProcessIdentity(meta.pid);
      assert.equal(actual?.createdAtUs, meta.startedAtUs, "published birth matches the live replacement broker");
    } finally {
      await shutdownJobDaemon(root, env).catch(() => undefined);
      await removeDaemonTestRoot(dir);
    }
  }
);
