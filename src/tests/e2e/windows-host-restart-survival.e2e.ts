// windows-host-restart-survival.e2e.ts
//
// Opt-in release acceptance for JQ-INC-2026-09-30-WIN-HOST-RESTART-001 and the
// Dashboard-Hub lifetime layer of JQ-20261005-55.
//
// This test intentionally models the Windows process-ownership condition that
// Codex Desktop exposed: a host process lives inside a kill-on-close Windows Job
// Object and submits a CrewDispatch job through the production daemon client.
// Closing the host Job Object simulates a Codex/Claude/MCP host restart. The
// daemon and worker must remain alive because ownership belongs to the
// independent broker, never to the disposable MCP host.
//
// The third test applies the same boundary to the OFFICIAL Dashboard launcher
// (`ensureHub`): a Hub it starts from inside the host Job Object must outlive
// the closed host, keep its instance identity, serve the UI, and be removable
// through the official shutdown route.
//
// This is Windows-specific release acceptance (real Job Object semantics), so it
// stays opt-in on other platforms. Enable with
// JOBQUAY_ACCEPT_WINDOWS_HOST_RESTART=1.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createJobRecord } from "../../jobs/service";
import { saveJob } from "../../jobs/store";
import { readHubEndpoint } from "../../hub/endpoint";
import { startHub, type HubHandle } from "../../hub/server";
import { confirmPidExit, isPidAlive, killProcessTree } from "../../runtime/process";
import { shutdownJobDaemon } from "../../daemon/client";

const ENABLED = process.platform === "win32" && process.env.JOBQUAY_ACCEPT_WINDOWS_HOST_RESTART === "1";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_CLIENT_JS =
  process.env.JOBQUAY_ACCEPT_DAEMON_CLIENT_JS?.trim() || path.join(REPO_ROOT, "dist", "daemon", "client.js");
const DASHBOARD_LAUNCHER_JS =
  process.env.JOBQUAY_ACCEPT_LAUNCHER_JS?.trim() || path.join(REPO_ROOT, "dist", "dashboard", "launcher.js");
const POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An ephemeral loopback port for the disposable Hub. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The live CrewDispatch ping body, or null when the port does not answer as one. */
async function pingHub(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return body?.ok === true && body?.service === "jobquay" ? body : null;
  } catch {
    return null;
  }
}

/**
 * A bounded environment for the PowerShell Job Object helper. The full caller
 * environment can exceed the 64 KiB Windows limit Add-Type applies when it
 * spawns its compiler child, so only the keys the harness needs are forwarded.
 */
function minimalWindowsEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot", "WINDIR", "ComSpec", "PATH", "Path", "TEMP", "TMP", "USERPROFILE", "USERNAME",
    "PATHEXT", "NUMBER_OF_PROCESSORS", "OS", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

async function waitForLine(child: ChildProcess, prefix: string, timeoutMs: number): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("harness stdout is unavailable");
  stdout.setEncoding("utf8");
  let buffer = "";
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${prefix}; output=${JSON.stringify(buffer)}`));
    }, timeoutMs);
    const onData = (chunk: string): void => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith(prefix)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("error", onError);
    };
    stdout.on("data", onData);
    child.once("error", onError);
  });
}

const KILL_JOB_HELPER = String.raw`param([string]$NodeExe,[string]$HostScript,[string]$Cwd)
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KillJobHarness {
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  static IntPtr job=IntPtr.Zero;
  public static int Start(string exe,string script,string cwd){
    job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Exception("CreateJobObject "+Marshal.GetLastWin32Error());
    var info=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); info.BasicLimitInformation.LimitFlags=0x2000;
    int len=Marshal.SizeOf(info); IntPtr p=Marshal.AllocHGlobal(len); Marshal.StructureToPtr(info,p,false);
    try { if(!SetInformationJobObject(job,9,p,(uint)len)) throw new Exception("SetInformationJobObject "+Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(p); }
    var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); PROCESS_INFORMATION pi;
    string cmd="\""+exe+"\" \""+script+"\"";
    if(!CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,false,0x00000004,IntPtr.Zero,cwd,ref si,out pi)) throw new Exception("CreateProcess "+Marshal.GetLastWin32Error());
    if(!AssignProcessToJobObject(job,pi.hProcess)){ int e=Marshal.GetLastWin32Error(); TerminateProcess(pi.hProcess,1); throw new Exception("AssignProcessToJobObject "+e); }
    ResumeThread(pi.hThread); CloseHandle(pi.hThread); CloseHandle(pi.hProcess); return pi.dwProcessId;
  }
  public static void CloseJob(){ if(job!=IntPtr.Zero){ CloseHandle(job); job=IntPtr.Zero; } }
}
"@
$hostPid=[KillJobHarness]::Start($NodeExe,$HostScript,$Cwd)
Write-Output ("HOST_PID="+$hostPid)
[Console]::Out.Flush()
[Console]::ReadLine() | Out-Null
[KillJobHarness]::CloseJob()
`;

test(
  "Windows kill-on-close host restart does not terminate the CrewDispatch-owned worker",
  { skip: !ENABLED, timeout: 120_000 },
  async () => {
    assert.equal(process.platform, "win32");
    assert.equal(fs.existsSync(DAEMON_CLIENT_JS), true, "build the candidate before this acceptance");
    assert.equal(fs.existsSync(POWERSHELL), true, "Windows PowerShell is required for the Job Object harness");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-host-restart-"));
    const root = path.join(dir, "root");
    const helperFile = path.join(dir, "kill-job-helper.ps1");
    const hostFile = path.join(dir, "host.cjs");
    const workerFile = path.join(dir, "heartbeat-worker.cjs");
    const pidFile = path.join(dir, "worker.pid");
    const heartbeatFile = path.join(dir, "heartbeat.txt");
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(helperFile, KILL_JOB_HELPER, "utf8");
    fs.writeFileSync(
      workerFile,
      [
        "const fs = require('node:fs');",
        "const file = process.env.JOBQUAY_TEST_HEARTBEAT;",
        "const beat = () => { try { fs.writeFileSync(file, String(Date.now())); } catch {} };",
        "beat();",
        "setInterval(beat, 100);"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      hostFile,
      [
        "const fs = require('node:fs');",
        "const { startJobViaDaemon } = require(process.env.JOBQUAY_TEST_DAEMON_CLIENT_JS);",
        "(async () => {",
        "  const launched = await startJobViaDaemon(process.env.JOBQUAY_TEST_ROOT, {",
        "    task: 'HOST_RESTART_DAEMON_OWNERSHIP',",
        "    cwd: process.env.JOBQUAY_TEST_CWD,",
        "    runner: 'fixture',",
        "    workerScript: process.env.JOBQUAY_TEST_WORKER_SCRIPT,",
        "    env: process.env",
        "  });",
        "  fs.writeFileSync(process.env.JOBQUAY_TEST_PID_FILE, String(launched.workerPid));",
        "  setInterval(() => {}, 1000);",
        "})().catch((e) => { console.error(e && e.stack || e); process.exit(2); });"
      ].join("\n"),
      "utf8"
    );

    let helper: ChildProcess | null = null;
    let workerPid: number | null = null;
    try {
      helper = spawn(
        POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperFile, process.execPath, hostFile, dir],
        {
          env: minimalWindowsEnv({
            JOBQUAY_TEST_DAEMON_CLIENT_JS: DAEMON_CLIENT_JS,
            JOBQUAY_TEST_ROOT: root,
            JOBQUAY_TEST_CWD: dir,
            JOBQUAY_TEST_WORKER_SCRIPT: workerFile,
            JOBQUAY_TEST_PID_FILE: pidFile,
            JOBQUAY_TEST_HEARTBEAT: heartbeatFile
          }),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );

      const hostLine = await waitForLine(helper, "HOST_PID=", 30_000);
      const hostPid = Number(hostLine.slice("HOST_PID=".length));
      assert.ok(Number.isInteger(hostPid) && hostPid > 0, hostLine);
      await waitFor(() => fs.existsSync(pidFile), 30_000, "CrewDispatch worker PID file");
      workerPid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(workerPid) && workerPid > 0, "daemon published its independently owned worker PID");
      await waitFor(() => fs.existsSync(heartbeatFile), 30_000, "worker heartbeat");
      const firstBeat = Number(fs.readFileSync(heartbeatFile, "utf8"));
      await waitFor(() => Number(fs.readFileSync(heartbeatFile, "utf8")) > firstBeat, 10_000, "advancing worker heartbeat");

      helper.stdin?.write("close\n");
      await Promise.race([
        once(helper, "exit"),
        sleep(15_000).then(() => { throw new Error("Job Object helper did not exit"); })
      ]);
      await waitFor(() => isPidAlive(hostPid) === false, 10_000, "host process exit");

      const before = Number(fs.readFileSync(heartbeatFile, "utf8"));
      await sleep(1000);
      const after = Number(fs.readFileSync(heartbeatFile, "utf8"));
      assert.equal(
        isPidAlive(workerPid),
        true,
        "the CrewDispatch-owned worker died with the disposable host Job Object; detached:true is not durable ownership"
      );
      assert.ok(after > before, "the independently owned worker heartbeat must continue after host restart");
    } finally {
      if (helper && helper.exitCode == null) {
        try { helper.stdin?.write("close\n"); } catch {}
        try { helper.kill("SIGKILL"); } catch {}
      }
      await shutdownJobDaemon(root).catch(() => undefined);
      if (workerPid && isPidAlive(workerPid) !== false) {
        await killProcessTree(workerPid, { graceMs: 3000 }).catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "Hub refresh reconciles a stale dead-owner job instead of leaving it running",
  { skip: !ENABLED, timeout: 60_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-host-restart-hub-"));
    const root = path.join(dir, "root");
    const cwd = path.join(dir, "cwd");
    fs.mkdirSync(cwd, { recursive: true });

    const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const deadOwnerPid = deadOwner.pid;
    assert.ok(deadOwnerPid);
    await once(deadOwner, "exit");

    const job = createJobRecord({ task: "HOST_RESTART_RECONCILE", cwd });
    job.status = "running";
    job.startedAt = new Date(Date.now() - 60_000).toISOString();
    job.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
    job.owner = `jobquay-${deadOwnerPid}-host-restart`;
    job.ownerPid = deadOwnerPid!;
    job.childPid = null;
    saveJob(root, job);

    let hub: HubHandle | null = null;
    try {
      hub = startHub({ root, host: "127.0.0.1", port: 0 });
      await once(hub.server, "listening");
      const url = `http://127.0.0.1:${hub.port}`;

      const listResponse = await fetch(`${url}/api/jobs?limit=50&offset=0`);
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json() as { jobs: Array<{ job_id: string; status: string }> };
      const row = list.jobs.find((item) => item.job_id === job.id);
      assert.ok(row);
      assert.equal(
        row.status,
        "interrupted",
        "Hub refresh must reconcile a stale dead owner instead of preserving a false running/Tool running state"
      );

      const detailResponse = await fetch(`${url}/api/jobs/${encodeURIComponent(job.id)}`);
      assert.equal(detailResponse.status, 200);
      const detail = await detailResponse.json() as { status: string };
      assert.equal(
        detail.status,
        "interrupted",
        "Hub detail must also expose the reconciled terminal status so the UI cannot remain stuck on the last Tool running activity"
      );
    } finally {
      if (hub) {
        hub.server.closeAllConnections?.();
        await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "the official Dashboard launcher creates a Hub that survives the caller's kill-on-close Job Object",
  { skip: !ENABLED, timeout: 120_000 },
  async () => {
    assert.equal(process.platform, "win32");
    assert.equal(fs.existsSync(DASHBOARD_LAUNCHER_JS), true, "build the candidate before this acceptance");
    assert.equal(fs.existsSync(POWERSHELL), true, "Windows PowerShell is required for the Job Object harness");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-hub-job-"));
    const root = path.join(dir, "root");
    const helperFile = path.join(dir, "kill-job-helper.ps1");
    const hostFile = path.join(dir, "host.cjs");
    const resultFile = path.join(dir, "host-result.json");
    fs.mkdirSync(root, { recursive: true });

    fs.writeFileSync(helperFile, KILL_JOB_HELPER, "utf8");
    fs.writeFileSync(
      hostFile,
      [
        "const fs = require('node:fs');",
        "const { ensureHub } = require(process.env.JOBQUAY_TEST_LAUNCHER_JS);",
        "(async () => {",
        "  const result = await ensureHub({",
        "    port: Number(process.env.JOBQUAY_TEST_PORT),",
        "    env: { ...process.env, JOBQUAY_DATA_ROOT: process.env.JOBQUAY_TEST_ROOT }",
        "  });",
        "  fs.writeFileSync(process.env.JOBQUAY_TEST_RESULT_FILE, JSON.stringify(result));",
        "  setInterval(() => {}, 1000);",
        "})().catch((e) => { console.error(e && e.stack || e); process.exit(2); });"
      ].join("\n"),
      "utf8"
    );

    const port = await freePort();
    let helper: ChildProcess | null = null;
    let hubPid: number | null = null;
    try {
      helper = spawn(
        POWERSHELL,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperFile, process.execPath, hostFile, dir],
        {
          env: minimalWindowsEnv({
            JOBQUAY_TEST_LAUNCHER_JS: DASHBOARD_LAUNCHER_JS,
            JOBQUAY_TEST_PORT: String(port),
            JOBQUAY_TEST_ROOT: root,
            JOBQUAY_TEST_RESULT_FILE: resultFile
          }),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        }
      );

      const hostLine = await waitForLine(helper, "HOST_PID=", 30_000);
      const hostPid = Number(hostLine.slice("HOST_PID=".length));
      assert.ok(Number.isInteger(hostPid) && hostPid > 0, hostLine);

      await waitFor(() => fs.existsSync(resultFile), 30_000, "the launcher result inside the Job Object");
      const ensured = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { hub_pid: number | null; action: string };
      assert.ok(Number.isInteger(ensured.hub_pid) && (ensured.hub_pid as number) > 0, "the launcher must report the Hub it created");
      const createdPid = ensured.hub_pid as number;
      hubPid = createdPid;
      // The WMI-created Hub does not inherit this host's environment, so the
      // fixture root must have arrived through argv.
      const endpoint = readHubEndpoint(root);
      assert.ok(endpoint, "the durable-launched Hub must claim the fixture data root passed as argv");
      assert.equal(endpoint.pid, createdPid, "the endpoint names the process the launcher created");
      const before = await pingHub(port);
      assert.ok(before, "the Hub must serve /api/ping before the caller host closes");

      // Close the caller host's kill-on-close Job Object.
      helper.stdin?.write("close\n");
      await Promise.race([
        once(helper, "exit"),
        sleep(15_000).then(() => { throw new Error("Job Object helper did not exit"); })
      ]);
      await waitFor(() => isPidAlive(hostPid) === false, 10_000, "host process exit");
      await sleep(1000);

      assert.equal(
        isPidAlive(createdPid),
        true,
        "the Hub died with the caller's Job Object; the Dashboard launcher must create it outside that ownership"
      );
      const after = await pingHub(port);
      assert.ok(after, "the Hub must still answer /api/ping after the caller host Job Object closed");
      assert.equal(after.instance_id, before.instance_id, "the surviving Hub is the same process identity");
      assert.equal(after.pid, createdPid, "the surviving Hub is the process the launcher created");
      const ui = await fetch(`http://127.0.0.1:${port}/ui`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      assert.equal(ui.status, 200, "the surviving Hub must serve the Dashboard UI");
    } finally {
      if (helper && helper.exitCode == null) {
        try { helper.stdin?.write("close\n"); } catch {}
        try { helper.kill("SIGKILL"); } catch {}
      }
      // Official, test-owned shutdown of the Hub this fixture started.
      try {
        await fetch(`http://127.0.0.1:${port}/api/hub/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
      } catch {
        /* the Hub may already be gone */
      }
      if (hubPid) {
        await confirmPidExit(hubPid, 5000).catch(() => false);
        if (isPidAlive(hubPid) !== false) {
          await killProcessTree(hubPid, { graceMs: 3000 }).catch(() => undefined);
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
