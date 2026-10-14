// durable-launch.ts — platform launch boundary for long-lived CrewDispatch
// processes.
//
// Windows needs a special escape from caller-owned kill-on-close Job Objects.
// POSIX does not: MAC-01 proved that a shell-free Node spawn with detached:true
// creates a session/process-group that survives the disposable caller. Keep both
// mechanisms here so daemon/worker/Hub launch policy does not fork by caller.
//
// The Windows WMI details below remain exactly the accepted path from
// JQ-INC-2026-09-30-WIN-HOST-RESTART-001 / JQ-20261005-55. The portable
// detached spawn is intentionally just process creation; Darwin exact process
// identity is captured by the runtime/process boundary after launch.
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type StdioOptions
} from "node:child_process";
import path from "node:path";

/**
 * TEST-ONLY: functional cross-process suites may opt out of repeatedly exercising
 * the expensive Windows WMI boundary. Dedicated durable-launch acceptance still
 * calls the real WMI helper directly. Production must never set this variable.
 */
export const TEST_DIRECT_DURABLE_LAUNCH_ENV = "JOBQUAY_TEST_DIRECT_DURABLE_LAUNCH";

export function useDirectTestDurableLaunch(env: NodeJS.ProcessEnv): boolean {
  return env[TEST_DIRECT_DURABLE_LAUNCH_ENV] === "1";
}

/** Default bound on the WMI/PowerShell creation call itself. */
export const DURABLE_LAUNCH_TIMEOUT_MS = 15_000;
export interface DurableLaunchRequest {
  /** Absolute executable path (e.g. process.execPath). */
  file: string;
  /** Arguments passed to the executable. */
  args: readonly string[];
  /**
   * Optional bound on the CREATION call (not on the created process's
   * lifetime). A caller with its own end-to-end budget passes what remains of
   * it; omitting it preserves the default. Never disables the bound: a
   * nonpositive or non-finite value is clamped (Node treats `timeout: 0` as
   * "no timeout", which is exactly what a budget must never do).
   */
  timeoutMs?: number | null;
}

export interface DetachedSpawnRequest {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  /** Test seam; production uses node:child_process.spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Shell-free detached process creation shared by POSIX daemon/worker/Hub paths
 * (and by the Windows worker, whose durable owner is already the broker).
 *
 * The created child is unref'd here because every caller uses this boundary for
 * a process whose lifetime is intentionally independent of the immediate
 * launcher. Readiness/identity are proved separately by each subsystem.
 */
export function spawnDetachedProcess(request: DetachedSpawnRequest): ChildProcess {
  const spawnFn = request.spawnFn ?? spawn;
  const options: SpawnOptions = {
    detached: true,
    stdio: request.stdio ?? "ignore",
    windowsHide: true,
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    ...(request.env !== undefined ? { env: request.env } : {})
  };
  const child = spawnFn(request.file, [...request.args], options);
  child.unref();
  return child;
}

/**
 * The timeout actually handed to `spawnSync` for one creation call.
 *
 * `undefined`/`null`/non-finite → the default; anything else → at least 1ms, so
 * the call is always bounded and never silently unbounded.
 */
export function durableLaunchTimeoutMs(requested?: number | null): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DURABLE_LAUNCH_TIMEOUT_MS;
  return Math.max(1, Math.floor(requested));
}

/** True when this platform has the verified outside-Job-Object launch path. */
export function supportsDurableLaunch(): boolean {
  return process.platform === "win32";
}

/** Quote one argv token for Windows CreateProcess/CommandLineToArgvW. */
function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  out += "\\".repeat(slashes * 2) + '"';
  return out;
}

function psSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function windowsPowershell(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Create `request` through the WMI provider host and return the created PID.
 *
 * Windows only. Throws with a bounded diagnostic when PowerShell, WMI or the
 * Create call fails — the caller decides how to surface it. Never throws on
 * non-Windows: the caller must gate on `supportsDurableLaunch()`.
 */
export function launchWindowsOutsideCallerJob(request: DurableLaunchRequest): number {
  const powershell = windowsPowershell();
  const commandLine = [request.file, ...request.args].map(quoteWindowsArg).join(" ");
  const command = [
    // The client-only startup instance carries ONLY the verified ShowWindow
    // property (see the module comment): dynamic assignment is unreliable and
    // CreateFlags is rejected by Win32_Process.Create on the verified host.
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psSingleQuote(commandLine)}; ProcessStartupInformation = $startup }`,
    "if ($null -eq $r -or [int]$r.ReturnValue -ne 0) {",
    "  if ($null -ne $r) { Write-Error ('Win32_Process.Create failed: ' + $r.ReturnValue) }",
    "  exit 7",
    "}",
    "Write-Output $r.ProcessId"
  ].join("; ");
  const out = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    // A caller's remaining budget bounds the creation call; the default is
    // preserved for every caller that does not pass one.
    timeout: durableLaunchTimeoutMs(request.timeoutMs),
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (out.error || out.status !== 0) {
    throw new Error(
      `Win32_Process.Create outside the caller's Job Object failed: ${String(out.error?.message || out.stderr || `exit ${out.status}`).trim()}`
    );
  }
  const pid = Number(String(out.stdout).trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Win32_Process.Create returned an unusable pid: ${JSON.stringify(String(out.stdout).trim())}`);
  }
  return pid;
}
