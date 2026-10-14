// macos-lifecycle-probe.e2e.ts
//
// MAC-01 evidence probe. This is deliberately test-only: it exercises the real
// built daemon -> worker and Dashboard Hub entries on native supported macOS before any
// macOS process-enumeration or launch implementation is promoted into production.
//
// Enable explicitly with JOBQUAY_ACCEPT_MACOS_LIFECYCLE=1. The test prints one
// redaction-safe MACOS_LIFECYCLE_RECEIPT JSON line for the validation record.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { ensureJobDaemon, shutdownJobDaemon } from "../../daemon/client";
import { confirmPidExit, isPidAlive } from "../../runtime/process";

const ENABLED =
  process.platform === "darwin" &&
  ["arm64", "x64"].includes(process.arch) &&
  process.env.JOBQUAY_ACCEPT_MACOS_LIFECYCLE === "1";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_CLIENT_JS =
  process.env.JOBQUAY_ACCEPT_DAEMON_CLIENT_JS?.trim() ||
  path.join(REPO_ROOT, "dist", "daemon", "client.js");
const DASHBOARD_LAUNCHER_JS =
  process.env.JOBQUAY_ACCEPT_LAUNCHER_JS?.trim() ||
  path.join(REPO_ROOT, "dist", "dashboard", "launcher.js");

interface MacProcessFacts {
  pid: number;
  ppid: number;
  pgid: number;
  /** Raw BSD ps session marker. It is diagnostic only, not an identity proof. */
  sessionRaw: string;
  /** BSD ps lstart text, retained verbatim for the receipt. */
  startText: string;
  /** lstart only has one-second precision; never use this as production birth identity. */
  startEpochMs: number | null;
  command: string;
}

interface BootFacts {
  raw: string;
  bootTimeMs: number;
}

interface HostResult {
  hostPid: number;
  workerPid: number | null;
  jobId: string;
  hub: {
    hub_pid: number | null;
    port: number;
    url: string;
    ping_url: string;
    service: string;
    build_id: string | null;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(port > 0, "an ephemeral loopback port was allocated");
  return port;
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

function processFacts(pid: number): MacProcessFacts | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = execFileSync(
      "/bin/ps",
      ["-o", "pid=,ppid=,pgid=,sess=,lstart=,comm=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }
    ).trim();
    if (!text) return null;
    const parts = text.split(/\s+/);
    if (parts.length < 10) return null;
    const parsedPid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (![parsedPid, ppid, pgid].every(Number.isInteger) || parsedPid !== pid) return null;
    const startText = parts.slice(4, 9).join(" ");
    const parsedStart = Date.parse(startText);
    return {
      pid,
      ppid,
      pgid,
      sessionRaw: parts[3] ?? "",
      startText,
      startEpochMs: Number.isFinite(parsedStart) ? parsedStart : null,
      command: parts.slice(9).join(" ")
    };
  } catch {
    return null;
  }
}

function bootFacts(): BootFacts {
  const raw = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true
  }).trim();
  const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(raw);
  if (!match) throw new Error(`unreadable kern.boottime: ${JSON.stringify(raw)}`);
  const seconds = Number(match[1]);
  const micros = Number(match[2]);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(micros) || micros < 0) {
    throw new Error(`invalid kern.boottime: ${JSON.stringify(raw)}`);
  }
  return { raw, bootTimeMs: seconds * 1000 + Math.floor(micros / 1000) };
}

async function pingHub(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return body.ok === true && body.service === "jobquay" ? body : null;
  } catch {
    return null;
  }
}

async function requestHubShutdown(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/hub/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // The server may close while the response is in flight; the PID check below
    // is authoritative for cleanup.
  }
}

async function waitForExit(pid: number | null, timeoutMs: number): Promise<boolean> {
  if (pid == null) return true;
  return await confirmPidExit(pid, timeoutMs, { pollMs: 50 });
}

function bestEffortKillFreshGroup(pid: number | null): void {
  if (pid == null || isPidAlive(pid) !== true) return;
  // Test-only last resort. The PID is a fresh value captured from this exact run,
  // never stale metadata. Production code must still require exact incarnation
  // evidence before it signals anything.
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

test(
  "MAC-01 real daemon/worker/Hub survive their launching host on native supported macOS",
  { skip: !ENABLED, timeout: 120_000 },
  async () => {
    assert.equal(process.platform, "darwin");
    assert.ok(["arm64", "x64"].includes(process.arch));
    assert.equal(fs.existsSync(DAEMON_CLIENT_JS), true, "build the daemon client before this acceptance");
    assert.equal(fs.existsSync(DASHBOARD_LAUNCHER_JS), true, "build the Dashboard launcher before this acceptance");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-macos-lifecycle-"));
    const root = path.join(dir, "data");
    const cwd = path.join(dir, "workspace");
    const hostFile = path.join(dir, "host.cjs");
    const workerFile = path.join(dir, "heartbeat-worker.cjs");
    const heartbeatFile = path.join(dir, "heartbeat.txt");
    const stopFile = path.join(dir, "stop-worker");
    const releaseFile = path.join(dir, "release-host");
    const resultFile = path.join(dir, "host-result.json");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    fs.writeFileSync(
      workerFile,
      [
        "const fs = require('node:fs');",
        "const heartbeat = process.env.JOBQUAY_TEST_HEARTBEAT;",
        "const stop = process.env.JOBQUAY_TEST_STOP;",
        "const beat = () => { try { fs.writeFileSync(heartbeat, String(Date.now())); } catch {} };",
        "beat();",
        "const timer = setInterval(() => {",
        "  if (fs.existsSync(stop)) { clearInterval(timer); process.exit(0); }",
        "  beat();",
        "}, 100);"
      ].join("\n"),
      "utf8"
    );

    fs.writeFileSync(
      hostFile,
      [
        "const fs = require('node:fs');",
        "const { startJobViaDaemon } = require(process.env.JOBQUAY_TEST_DAEMON_CLIENT_JS);",
        "const { ensureHub } = require(process.env.JOBQUAY_TEST_LAUNCHER_JS);",
        "(async () => {",
        "  const launched = await startJobViaDaemon(process.env.JOBQUAY_TEST_ROOT, {",
        "    task: 'MACOS_LIFECYCLE_PROBE',",
        "    cwd: process.env.JOBQUAY_TEST_CWD,",
        "    runner: 'fixture',",
        "    workerScript: process.env.JOBQUAY_TEST_WORKER_SCRIPT,",
        "    env: process.env",
        "  });",
        "  const hub = await ensureHub({",
        "    port: Number(process.env.JOBQUAY_TEST_PORT),",
        "    env: { ...process.env, JOBQUAY_DATA_ROOT: process.env.JOBQUAY_TEST_ROOT }",
        "  });",
        "  fs.writeFileSync(process.env.JOBQUAY_TEST_RESULT_FILE, JSON.stringify({",
        "    hostPid: process.pid,",
        "    workerPid: launched.workerPid,",
        "    jobId: launched.job.id,",
        "    hub",
        "  }));",
        "  while (!fs.existsSync(process.env.JOBQUAY_TEST_RELEASE)) {",
        "    await new Promise((resolve) => setTimeout(resolve, 25));",
        "  }",
        "})().catch((e) => { console.error(e && e.stack || e); process.exit(2); });"
      ].join("\n"),
      "utf8"
    );

    const port = await freePort();
    let host: ChildProcess | null = null;
    let hostPid: number | null = null;
    let daemonPid: number | null = null;
    let workerPid: number | null = null;
    let hubPid: number | null = null;
    let stderr = "";

    try {
      host = spawn(process.execPath, [hostFile], {
        cwd: dir,
        env: {
          ...process.env,
          JOBQUAY_TEST_DAEMON_CLIENT_JS: DAEMON_CLIENT_JS,
          JOBQUAY_TEST_LAUNCHER_JS: DASHBOARD_LAUNCHER_JS,
          JOBQUAY_TEST_ROOT: root,
          JOBQUAY_TEST_CWD: cwd,
          JOBQUAY_TEST_WORKER_SCRIPT: workerFile,
          JOBQUAY_TEST_HEARTBEAT: heartbeatFile,
          JOBQUAY_TEST_STOP: stopFile,
          JOBQUAY_TEST_RELEASE: releaseFile,
          JOBQUAY_TEST_RESULT_FILE: resultFile,
          JOBQUAY_TEST_PORT: String(port)
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      });
      hostPid = host.pid ?? null;
      assert.ok(hostPid != null && hostPid > 0, "the disposable launching host started");
      host.stderr?.setEncoding("utf8");
      host.stderr?.on("data", (chunk: string) => { stderr += chunk; });

      await waitFor(
        () => fs.existsSync(resultFile) || host?.exitCode != null,
        30_000,
        "host lifecycle result"
      );
      if (!fs.existsSync(resultFile)) {
        throw new Error(`launching host exited before publishing results: ${stderr.trim() || `exit ${host?.exitCode}`}`);
      }

      const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as HostResult;
      assert.equal(result.hostPid, hostPid, "the host reported its real PID");
      workerPid = result.workerPid;
      hubPid = result.hub.hub_pid;
      assert.ok(workerPid != null && workerPid > 0, "the daemon returned a worker PID");
      assert.ok(hubPid != null && hubPid > 0, "the Dashboard launcher returned a Hub PID");

      await waitFor(() => fs.existsSync(heartbeatFile), 10_000, "worker heartbeat");
      await waitFor(() => fs.existsSync(path.join(root, "daemon", "daemon.json")), 10_000, "daemon metadata");
      const daemonMeta = JSON.parse(fs.readFileSync(path.join(root, "daemon", "daemon.json"), "utf8")) as { pid?: unknown };
      daemonPid = Number(daemonMeta.pid);
      assert.ok(Number.isInteger(daemonPid) && (daemonPid as number) > 0, "daemon metadata contains its live PID");

      const boot = bootFacts();
      assert.ok(boot.bootTimeMs > 0 && boot.bootTimeMs < Date.now(), "kern.boottime is a usable past instant");

      const before = {
        host: processFacts(hostPid),
        daemon: processFacts(daemonPid as number),
        worker: processFacts(workerPid as number),
        hub: processFacts(hubPid as number)
      };
      assert.ok(before.host, "host process facts are observable");
      assert.ok(before.daemon, "daemon process facts are observable");
      assert.ok(before.worker, "worker process facts are observable");
      assert.ok(before.hub, "Hub process facts are observable");

      // Node detached:true on POSIX is expected to make each independently
      // launched service a process-group leader. MAC-01 proves the observation;
      // MAC-02 decides which facts are safe enough for production identity.
      assert.equal(before.daemon!.pgid, daemonPid, "daemon is its own process-group leader");
      assert.equal(before.worker!.pgid, workerPid, "worker is its own process-group leader");
      assert.equal(before.hub!.pgid, hubPid, "Hub is its own process-group leader");
      assert.equal(before.daemon!.ppid, hostPid, "daemon is initially parented to the launching host");
      assert.equal(before.hub!.ppid, hostPid, "Hub is initially parented to the launching host");
      assert.equal(before.worker!.ppid, daemonPid, "worker is initially parented to the daemon");

      const heartbeatBeforeHostExit = Number(fs.readFileSync(heartbeatFile, "utf8"));
      fs.writeFileSync(releaseFile, "release\n", "utf8");
      await Promise.race([
        once(host, "exit"),
        sleep(10_000).then(() => { throw new Error("launching host did not exit"); })
      ]);
      assert.equal(host.exitCode, 0, `launching host failed: ${stderr.trim()}`);
      assert.equal(isPidAlive(hostPid), false, "launching host exited");

      await sleep(500);
      const after = {
        daemon: processFacts(daemonPid as number),
        worker: processFacts(workerPid as number),
        hub: processFacts(hubPid as number)
      };
      assert.ok(after.daemon, "daemon survived launching-host exit");
      assert.ok(after.worker, "worker survived launching-host exit");
      assert.ok(after.hub, "Hub survived launching-host exit");
      assert.equal(after.daemon!.pgid, before.daemon!.pgid, "daemon process group stayed stable");
      assert.equal(after.worker!.pgid, before.worker!.pgid, "worker process group stayed stable");
      assert.equal(after.hub!.pgid, before.hub!.pgid, "Hub process group stayed stable");
      assert.equal(after.daemon!.startText, before.daemon!.startText, "daemon start fact stayed stable");
      assert.equal(after.worker!.startText, before.worker!.startText, "worker start fact stayed stable");
      assert.equal(after.hub!.startText, before.hub!.startText, "Hub start fact stayed stable");
      assert.notEqual(after.daemon!.ppid, hostPid, "daemon was reparented after launching-host exit");
      assert.notEqual(after.hub!.ppid, hostPid, "Hub was reparented after launching-host exit");
      assert.equal(after.worker!.ppid, daemonPid, "worker remains parented to the surviving daemon");

      const daemonAfter = await ensureJobDaemon(root, process.env);
      assert.equal(daemonAfter.pid, daemonPid, "production daemon client reuses the same surviving daemon");

      const heartbeatAfterHostExit = Number(fs.readFileSync(heartbeatFile, "utf8"));
      assert.ok(
        heartbeatAfterHostExit > heartbeatBeforeHostExit,
        "worker heartbeat continues after launching-host exit"
      );

      const hubPing = await pingHub(port);
      assert.ok(hubPing, "surviving Hub still answers the live identity endpoint");
      assert.equal(hubPing!.service, "jobquay");

      const receipt = {
        kind: "macos-lifecycle-probe-v1",
        platform: process.platform,
        arch: process.arch,
        macos_release: os.release(),
        node: process.version,
        boot,
        job_id: result.jobId,
        host: { before: before.host, after: null },
        daemon: { before: before.daemon, after: after.daemon },
        worker: { before: before.worker, after: after.worker, heartbeat_advanced: true },
        hub: { before: before.hub, after: after.hub, ping: hubPing },
        limitations: [
          "BSD ps lstart has one-second precision and is diagnostic only",
          "BSD ps sess is retained as a raw marker and is not production session identity",
          "MAC-02 must select exact birth/session/boot sources before production signaling uses them"
        ]
      };
      process.stdout.write(`MACOS_LIFECYCLE_RECEIPT=${JSON.stringify(receipt)}\n`);
    } finally {
      try { fs.writeFileSync(releaseFile, "release\n", "utf8"); } catch {}
      if (host && host.exitCode == null) {
        try { host.kill("SIGKILL"); } catch {}
      }

      try { fs.writeFileSync(stopFile, "stop\n", "utf8"); } catch {}
      if (workerPid != null && !(await waitForExit(workerPid, 5000))) bestEffortKillFreshGroup(workerPid);

      await shutdownJobDaemon(root).catch(() => undefined);
      if (daemonPid != null && !(await waitForExit(daemonPid, 5000))) bestEffortKillFreshGroup(daemonPid);

      await requestHubShutdown(port);
      if (hubPid != null && !(await waitForExit(hubPid, 5000))) bestEffortKillFreshGroup(hubPid);

      if (workerPid != null) await waitForExit(workerPid, 3000).catch(() => false);
      if (daemonPid != null) await waitForExit(daemonPid, 3000).catch(() => false);
      if (hubPid != null) await waitForExit(hubPid, 3000).catch(() => false);

      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
);
