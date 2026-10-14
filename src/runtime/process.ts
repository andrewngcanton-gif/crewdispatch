// process.ts — the ONLY place that kills a job's OS process TREE and confirms
// that it really exited.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/jobs.mjs` killProcessTree / killJobProcess / childIsDead /
// isPidAlive. Windows-first.
//
// WHY a tree kill: CrewDispatch spawns the official CLI through `%ComSpec%` for a
// `.cmd`/`.bat` shim (see the batch-1 spawn plan). Killing only the direct child
// (cmd.exe) leaves the real CLI (node) running — the exact defect the reference
// project fixed. `taskkill /T /F` terminates the whole tree.
//
// WHY "confirm": a kill request is not an exit. `cancel` must not report success
// until the OS says the process TREE is gone, otherwise a new generation could
// start while the old tree is still alive. `confirmPidExit` polls `isPidAlive`
// until the PID is gone or the grace window elapses.
//
// IMPORTANT — a root PID exiting does NOT prove the whole tree is gone, and NO
// pure TypeScript result may claim that an arbitrary detached descendant behind
// an exited intermediate is gone. A result
// therefore carries a `scope`, not a boolean:
//   * `taskkill /pid <p> /T /F` terminates the tree; if it SUCCEEDS and the root
//     PID is then gone, the OS-tracked tree is gone (`scope: "os_tree_exited"`).
//   * a PID that is already dead (`already_dead`) proves only that the ROOT is
//     gone — descendants may have been reparented and survive — so it is
//     `scope: "root_exited"`, NEVER a tree guarantee.
//   * if taskkill FAILS, the only fallback is a direct `process.kill` of the root
//     PID — that proves the ROOT died at best, never its descendants. Such a kill
//     reports `scope: "root_exited"` (root gone) or `"unconfirmed"` (root not even
//     proven gone), with reason `tree_unconfirmed`, so the caller refuses to claim
//     `cancelled` and keeps the child PID.
// The reference project's tree kill is reused, but this module never upgrades a
// root-only kill (or an already-dead root) into a tree guarantee.
//
// A DEAD root PID is never a tree guarantee, so this module can also ENUMERATE
// live processes (public OS surface: PowerShell CIM on Windows) to find the
// descendants of a recorded root. Descendants are scoped to `root PID + this
// generation's start time` so a REUSED pid's unrelated children are never
// mistaken for ours and never signalled. When enumeration is unavailable or a
// candidate's identity is unknown, the scan is reported `unknown` and the caller
// must refuse to start a new generation rather than assume the tree stopped.
//
// This module never touches another product's data; it only signals OS
// processes the caller already owns.
import { execFile } from "node:child_process";
import { enumerateDarwinProcesses, readDarwinBootTime, readDarwinProcessSync } from "./process-darwin";

/**
 * Exactly WHAT a kill attempt proved about a recorded process tree.
 *
 * This replaces the former boolean `treeConfirmed`, which conflated "the root
 * PID is gone" with "the whole tree is provably gone" and was read as an
 * absolute guarantee. Pure TypeScript PID/PPID observation can NEVER prove that
 * an arbitrary detached descendant behind an exited intermediate is gone, so NO
 * scope makes that claim:
 *   - `none`                          no kill was attempted / no PID was recorded.
 *   - `root_exited`                   only the ROOT PID is confirmed gone; its
 *                                     descendants are NOT proven (a dead root is
 *                                     never tree evidence).
 *   - `os_tree_exited`                the OS tree kill (Windows `taskkill /T /F`,
 *                                     POSIX process group) succeeded and the root
 *                                     is gone: the OS-tracked tree is gone.
 *   - `identified_descendants_stopped` the scoped descendants CrewDispatch could
 *                                     IDENTIFY were stopped and confirmed gone —
 *                                     a bounded cleanup, NOT proof of arbitrary
 *                                     detached descendants.
 *   - `recovery_confirmed`            a validated, generation-bound persisted
 *                                     PASSIVE recovery proof (see
 *                                     `TreeRecoveryEvidence` in jobs/store.ts)
 *                                     already showed this exact tree stopped;
 *                                     no kill was attempted or needed, and a
 *                                     current process holding the old PID is a
 *                                     different incarnation (PID reuse).
 *   - `unconfirmed`                   not even the root could be confirmed gone.
 */
export type KillTreeScope =
  | "none"
  | "root_exited"
  | "os_tree_exited"
  | "identified_descendants_stopped"
  | "recovery_confirmed"
  | "unconfirmed";

/** Result of one process-tree kill attempt. */
export interface KillTreeResult {
  /** A kill signal was issued (false when there was nothing alive to kill). */
  killed: boolean;
  /** The root PID is gone (or provably never existed). NOT a tree guarantee. */
  confirmed: boolean;
  /** Exactly what was proven about the tree (see KillTreeScope). */
  scope: KillTreeScope;
  pid: number | null;
  /** "taskkill" | "taskkill+kill" | "process.kill" | "none". */
  method: string;
  /** "no_pid" | "already_dead" | "unconfirmed" | "tree_unconfirmed" — absent on a clean kill. */
  reason?: string;
}

export interface KillTreeOptions {
  /** How long to wait for the OS to confirm exit before giving up. Default 4000. */
  graceMs?: number;
  /** Poll interval while confirming. Default 100. */
  pollMs?: number;
  /** Injectable process liveness probe (tests). */
  isAliveFn?: (pid: number) => boolean | null;
  /** Injectable tree-kill executor (tests). */
  execFileFn?: typeof execFile;
  /** Injectable sleep (tests). */
  delayFn?: (ms: number) => Promise<void>;
  /** Exact Darwin birth instant required before a persisted PID may be signalled. */
  expectedCreatedAtUs?: number | null;
}

const DEFAULT_GRACE_MS = 4000;
const DEFAULT_POLL_MS = 100;

/** Internal child/worker rendezvous used only to hold a Darwin terminal root until containment is snapshotted. */
export const DARWIN_TERMINAL_ACK_ENV = "JOBQUAY_INTERNAL_DARWIN_TERMINAL_ACK";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is a PID alive right now?
 *
 * `process.kill(pid, 0)` sends no signal and only probes. EPERM means the
 * process exists but we may not signal it → alive. ESRCH means no such process →
 * dead. Anything else is honestly `null` (unknown), never guessed.
 */
export function isPidAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return null;
  }
}

/** Is any process still present in this POSIX process group? */
export function isProcessGroupAlive(pgid: number): boolean | null {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return null;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return null;
  }
}

async function confirmProcessGroupExit(
  pgid: number,
  timeoutMs: number,
  opts: { pollMs?: number; delayFn?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const sleep = opts.delayFn ?? delay;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  for (;;) {
    if (isProcessGroupAlive(pgid) === false) return true;
    if (Date.now() >= deadline) return isProcessGroupAlive(pgid) === false;
    await sleep(pollMs);
  }
}

/** Capture the exact incarnation of one currently-live process where supported. */
export function captureProcessIdentity(pid: number): ProcessEntry | null {
  if (process.platform === "darwin") return readDarwinProcessSync(pid);
  return null;
}

// ---------------------------------------------------------------------------
// Process enumeration (descendant discovery for a DEAD root)
// ---------------------------------------------------------------------------

/** One OS process as enumerated: its PID, parent PID and (best-effort) start time. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** Process creation time as epoch ms, or null when the OS did not report one. */
  createdAtMs: number | null;
  /** Exact process birth instant in epoch microseconds when the OS can prove it. */
  createdAtUs?: number | null;
  /** OS process-group id when reported. */
  pgid?: number | null;
  /** OS session id when reported. */
  sid?: number | null;
  /** Whether the OS reports this process as the session leader. */
  sessionLeader?: boolean;
  /**
   * Best-effort image/executable name (e.g. `claude.exe`) when the OS reported
   * one. OPTIONAL and additive: existing consumers that never read it are
   * unchanged, and a line without a name simply omits the key. It is used only
   * as an ancestry HINT (which ancestor is the Claude owner) — never as liveness
   * proof, which always comes from PID + creation time.
   */
  imageName?: string | null;
}

/** Result of one process enumeration. `ok:false` means the scan is UNKNOWN. */
export interface ProcessScan {
  ok: boolean;
  processes: ProcessEntry[];
  reason?: string;
}

/** Injectable enumeration seam (tests). */
export type EnumerateProcesses = () => Promise<ProcessScan>;

// The generation's CLI root is created by `spawn()` just BEFORE the worker
// records the generation start time, so a legitimate descendant can appear a few
// ms earlier than that stamp. A small tolerance keeps our own tree in scope while
// still excluding a process that predates the generation (a reused pid's child).
export const DESCENDANT_CLOCK_TOLERANCE_MS = 2000;

// Enumerate only the Win32_Process fields CrewDispatch actually consumes.
// Get-CimInstance Win32_Process without -Property materializes the class's
// full property set; on hosted Windows that broad projection can dominate this
// safety probe and hit the existing 20s bound. Keeping the same PUBLIC CIM
// surface but projecting four fields preserves the evidence semantics while
// reducing provider work. CreationDate remains a real timestamp; 0 means "not
// reported" and is treated as unknown rather than as the epoch.
const POWERSHELL_PROCESS_LIST = [
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object {",
  "$t=0;",
  "if ($_.CreationDate) { $t=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() };",
  'Write-Output ("$($_.ProcessId) $($_.ParentProcessId) $t $($_.Name)")',
  "}"
].join(" ");

/**
 * Parse the `pid ppid epochMs [name…]` lines produced by POWERSHELL_PROCESS_LIST.
 * A line without a name omits the optional `imageName` key entirely, so the
 * historical 3-column shape is byte-identical for existing consumers.
 */
export function parseProcessList(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const ms = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const entry: ProcessEntry = {
      pid,
      ppid: Number.isInteger(ppid) ? ppid : -1,
      createdAtMs: Number.isFinite(ms) && ms > 0 ? ms : null
    };
    const name = parts.length > 3 ? parts.slice(3).join(" ").trim() : "";
    if (name) entry.imageName = name;
    out.push(entry);
  }
  return out;
}

/**
 * Enumerate the OS process table.
 *
 * Windows uses the public CIM surface. Apple Silicon macOS uses the bundled
 * Darwin sysctl helper selected by MAC-02. Other platforms, unsupported Mac
 * architectures, or any failure are reported `ok:false` with a reason — never
 * a guessed or partial list — so the caller conservatively refuses to start a
 * new generation.
 */
export async function enumerateProcesses(opts: { execFileFn?: typeof execFile; timeoutMs?: number } = {}): Promise<ProcessScan> {
  if (process.platform === "darwin") {
    return enumerateDarwinProcesses(opts);
  }
  if (process.platform !== "win32") {
    return { ok: false, processes: [], reason: "unsupported_platform" };
  }
  const execFileFn = opts.execFileFn ?? execFile;
  const timeoutMs = opts.timeoutMs ?? 20000;
  return new Promise<ProcessScan>((resolve) => {
    try {
      execFileFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PROCESS_LIST],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, processes: [], reason: `enumeration_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          const processes = parseProcessList(typeof stdout === "string" ? stdout : String(stdout ?? ""));
          resolve(processes.length > 0 ? { ok: true, processes } : { ok: false, processes: [], reason: "empty_process_list" });
        }
      );
    } catch (e) {
      resolve({ ok: false, processes: [], reason: `enumeration_failed: ${String((e as Error)?.message || e)}` });
    }
  });
}

/**
 * Enumerate the currently-visible DIRECT child roots of one recorded Windows PID.
 *
 * Dead-root recovery does not need a breadth-first CIM walk. A visible direct
 * child is already enough to block passive recovery, and explicit cancel hands
 * that child to `taskkill /T`, which owns termination of its live subtree. If a
 * direct child has already exited and a deeper process was reparented, repeated
 * PPID walking could not reconstruct that missing link anyway. One filtered CIM
 * query therefore preserves the same fail-closed boundary while avoiding a
 * second (or later) provider query on cold/loaded hosted Windows.
 *
 * The returned rows keep the same public evidence (pid, ppid, creation time,
 * name). An empty successful result is only a bounded negative snapshot: no
 * currently-visible direct child of this recorded root exists at this instant.
 */
export async function enumerateDescendantProcesses(
  rootPid: number,
  opts: { execFileFn?: typeof execFile; timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<ProcessScan> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ok: false, processes: [], reason: "unsupported_platform" };
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return { ok: false, processes: [], reason: "invalid_root_pid" };
  const execFileFn = opts.execFileFn ?? execFile;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const root = Math.trunc(rootPid);
  const command = [
    "$ErrorActionPreference='Stop';",
    `$children=Get-CimInstance Win32_Process -Filter (\"ParentProcessId=${root}\") -Property ProcessId,ParentProcessId,CreationDate,Name;`,
    "foreach($p in $children){",
    "$t=0; if($p.CreationDate){$t=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()};",
    "Write-Output (\"$($p.ProcessId) $($p.ParentProcessId) $t $($p.Name)\");",
    "}"
  ].join(" ");
  return new Promise<ProcessScan>((resolve) => {
    try {
      execFileFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, processes: [], reason: `descendant_enumeration_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, processes: parseProcessList(typeof stdout === "string" ? stdout : String(stdout ?? "")) });
        }
      );
    } catch (e) {
      resolve({ ok: false, processes: [], reason: `descendant_enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
}
const EXITED_ROOT_PRESENT_MARKER = "__JOBQUAY_ROOT_PID_PRESENT__";

const WINDOWS_TOOLHELP_SNAPSHOT_CSHARP = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CrewDispatchToolhelpSnapshot {
  const uint TH32CS_SNAPPROCESS = 0x00000002;
  static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr hObject);

  public static string[] Snapshot(uint rootPid) {
    var rows = new List<string>();
    IntPtr h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (h == INVALID_HANDLE_VALUE) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      var pe = new PROCESSENTRY32();
      pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
      if (!Process32FirstW(h, ref pe)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      do {
        if (pe.th32ProcessID == rootPid) return new [] { "${EXITED_ROOT_PRESENT_MARKER}" };
        if (pe.th32ParentProcessID == rootPid) {
          long created = 0;
          try {
            using (var p = Process.GetProcessById((int)pe.th32ProcessID)) {
              created = new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds();
            }
          } catch { created = 0; }
          rows.Add(String.Format("{0} {1} {2} {3}", pe.th32ProcessID, pe.th32ParentProcessID, created, pe.szExeFile ?? ""));
        }
      } while (Process32NextW(h, ref pe));
      return rows.ToArray();
    } finally { CloseHandle(h); }
  }
}
`;

function parseCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      fields.push(field);
      field = "";
    } else field += ch;
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/** Parse WMI's DMTF datetime (`yyyymmddHHMMSS.mmmmmm+UUU`) to epoch ms. */
function parseWmicCreationDate(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(value.trim());
  if (!m) return null;
  const base = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]!.slice(0, 3))
  );
  const offsetMinutes = Number(m[9]) * (m[8] === "+" ? 1 : -1);
  const result = base - offsetMinutes * 60_000;
  return Number.isFinite(result) ? result : null;
}

function parseWmicProcessCsv(text: string): ProcessScan {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, "").trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => {
    const fields = parseCsvLine(line);
    return !!fields && fields.includes("ProcessId") && fields.includes("ParentProcessId") && fields.includes("CreationDate");
  });
  if (headerIndex < 0) {
    // WMIC's successful empty-set CSV is literally `Node,` on stdout (with the
    // localized "no instances" notice on stderr). Treat only that exact structural
    // shape as empty; every other unparseable success fails closed.
    if (lines.length > 0 && lines.every((line) => /^Node,\s*$/i.test(line))) return { ok: true, processes: [] };
    return { ok: false, processes: [], reason: "wmic_unparseable_output" };
  }
  const headers = parseCsvLine(lines[headerIndex]!)!;
  const pidIndex = headers.indexOf("ProcessId");
  const ppidIndex = headers.indexOf("ParentProcessId");
  const creationIndex = headers.indexOf("CreationDate");
  const nameIndex = headers.indexOf("Name");
  const processes: ProcessEntry[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const fields = parseCsvLine(lines[i]!);
    if (!fields || fields.length !== headers.length) return { ok: false, processes: [], reason: "wmic_unparseable_row" };
    const pid = Number(fields[pidIndex]);
    const ppid = Number(fields[ppidIndex]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) {
      return { ok: false, processes: [], reason: "wmic_unparseable_identity" };
    }
    const entry: ProcessEntry = {
      pid,
      ppid,
      createdAtMs: parseWmicCreationDate(fields[creationIndex] ?? "")
    };
    const name = nameIndex >= 0 ? String(fields[nameIndex] ?? "").trim() : "";
    if (name) entry.imageName = name;
    processes.push(entry);
  }
  return { ok: true, processes };
}

/**
 * Enumerate direct descendants of a Windows root that the caller already observed
 * as exited without depending on the slow PowerShell CIM path.
 *
 * When the optional legacy `wmic.exe` compatibility feature is present, use it as
 * a fast native front-end to Win32_Process. Fresh Windows 2022 evidence measured a
 * real preserved-PPID query at ~0.28s from Node. Newer Windows may omit WMIC, so a
 * missing/failed WMIC call falls back inside the SAME original time budget to the
 * public Toolhelp32 process snapshot helper. The fallback never weakens evidence:
 * both paths verify that the recorded root PID has not reappeared and carry the
 * child's creation time for generation scoping.
 *
 * If the recorded root PID is visible again, the PID may have been reused; fail
 * closed before attributing or signalling any child. An unreadable child start
 * time remains null and therefore becomes `unknown` in `findDescendants`.
 */
export async function enumerateExitedRootDescendants(
  rootPid: number,
  opts: { execFileFn?: typeof execFile; timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<ProcessScan> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ok: false, processes: [], reason: "unsupported_platform" };
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return { ok: false, processes: [], reason: "invalid_root_pid" };
  const execFileFn = opts.execFileFn ?? execFile;
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 8000);
  const root = Math.trunc(rootPid);
  const startedAt = Date.now();

  const wmicTimeoutMs = Math.max(1, Math.min(2000, timeoutMs));
  const wmic = await new Promise<ProcessScan>((resolve) => {
    try {
      execFileFn(
        "wmic.exe",
        [
          "path",
          "win32_process",
          "where",
          `ProcessId=${root} OR ParentProcessId=${root}`,
          "get",
          "ProcessId,ParentProcessId,CreationDate,Name",
          "/format:csv"
        ],
        { windowsHide: true, timeout: wmicTimeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, processes: [], reason: `wmic_descendant_enumeration_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          const parsed = parseWmicProcessCsv(typeof stdout === "string" ? stdout : String(stdout ?? ""));
          if (!parsed.ok) {
            resolve(parsed);
            return;
          }
          if (parsed.processes.some((p) => p.pid === root)) {
            resolve({ ok: false, processes: [], reason: "root_pid_present" });
            return;
          }
          resolve({ ok: true, processes: parsed.processes.filter((p) => p.ppid === root) });
        }
      );
    } catch (e) {
      resolve({ ok: false, processes: [], reason: `wmic_descendant_enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
  if (wmic.ok || wmic.reason === "root_pid_present") return wmic;

  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return wmic;
  const command = [
    "$ErrorActionPreference='Stop'",
    "$source=@'",
    WINDOWS_TOOLHELP_SNAPSHOT_CSHARP,
    "'@",
    "Add-Type -TypeDefinition $source -Language CSharp",
    `[CrewDispatchToolhelpSnapshot]::Snapshot([uint32]${root})`
  ].join("\n");
  return new Promise<ProcessScan>((resolve) => {
    try {
      execFileFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: Math.max(1, remainingMs), maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, processes: [], reason: `toolhelp_descendant_enumeration_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
          if (text.split(/\r?\n/).some((line) => line.trim() === EXITED_ROOT_PRESENT_MARKER)) {
            resolve({ ok: false, processes: [], reason: "root_pid_present" });
            return;
          }
          resolve({ ok: true, processes: parseProcessList(text) });
        }
      );
    } catch (e) {
      resolve({ ok: false, processes: [], reason: `toolhelp_descendant_enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
}

/**
 * Query one Windows PID through the same public CIM surface used by the process
 * enumerators. This is primarily useful when a plain liveness probe is UNKNOWN:
 * an empty successful result proves the pid is absent without ever signalling it,
 * while a present row carries the same creation-time evidence as the full scan.
 */
export async function enumerateProcessByPid(
  pid: number,
  opts: { execFileFn?: typeof execFile; timeoutMs?: number; platform?: NodeJS.Platform } = {}
): Promise<ProcessScan> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ok: false, processes: [], reason: "unsupported_platform" };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, processes: [], reason: "invalid_pid" };
  const execFileFn = opts.execFileFn ?? execFile;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const target = Math.trunc(pid);
  const command = [
    "$ErrorActionPreference='Stop';",
    `$p=Get-CimInstance Win32_Process -Filter (\"ProcessId=${target}\") -Property ProcessId,ParentProcessId,CreationDate,Name;`,
    "if($null -ne $p){",
    "$t=0; if($p.CreationDate){$t=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()};",
    "Write-Output (\"$($p.ProcessId) $($p.ParentProcessId) $t $($p.Name)\");",
    "}"
  ].join(" ");
  return new Promise<ProcessScan>((resolve) => {
    try {
      execFileFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, processes: [], reason: `pid_enumeration_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, processes: parseProcessList(typeof stdout === "string" ? stdout : String(stdout ?? "")) });
        }
      );
    } catch (e) {
      resolve({ ok: false, processes: [], reason: `pid_enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
}

// ---------------------------------------------------------------------------
// OS boot time (a REBOOT is stronger evidence than any live-process snapshot)
// ---------------------------------------------------------------------------

/**
 * The current OS boot instant, as epoch ms, or an honest failure.
 *
 * A process cannot survive an OS reboot, so a boot instant that provably
 * postdates a recorded generation proves that generation's whole process tree
 * is gone — regardless of PID reuse or a failed/partial process enumeration.
 * The reading is only ever used as EVIDENCE about a recorded generation; this
 * module still never signals a process from a recorded PID.
 *
 * Windows reads the public CIM `Win32_OperatingSystem.LastBootUpTime` (the same
 * surface used for descendant enumeration). Apple Silicon macOS reads the
 * bundled Darwin helper's `kern.boottime`. Other platforms, a failed probe, an
 * unreadable value or a value in the future are reported `ok:false` with a
 * reason — never a guessed boot time — so the caller conservatively refuses to
 * treat the tree as stopped.
 */
export interface BootTimeReading {
  ok: boolean;
  /** Epoch ms of the current boot, only when the OS reported a usable value. */
  bootTimeMs: number | null;
  /** Exact boot instant in epoch microseconds when the OS can prove it. */
  bootTimeUs?: number | null;
  reason: string | null;
}

const POWERSHELL_BOOT_TIME = [
  "$b=(Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime).LastBootUpTime;",
  "if ($b) { Write-Output ([DateTimeOffset]$b).ToUnixTimeMilliseconds() }"
].join(" ");

export async function readBootTime(opts: { execFileFn?: typeof execFile } = {}): Promise<BootTimeReading> {
  if (process.platform === "darwin") {
    return readDarwinBootTime(opts);
  }
  if (process.platform !== "win32") {
    return { ok: false, bootTimeMs: null, reason: "unsupported_platform" };
  }
  const execFileFn = opts.execFileFn ?? execFile;
  return new Promise<BootTimeReading>((resolve) => {
    try {
      execFileFn(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_BOOT_TIME],
        { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, bootTimeMs: null, reason: `boot_time_probe_failed: ${String((error as Error)?.message || error).slice(0, 200)}` });
            return;
          }
          const text = (typeof stdout === "string" ? stdout : String(stdout ?? "")).trim();
          const ms = Number(text);
          if (!Number.isFinite(ms) || ms <= 0) {
            resolve({ ok: false, bootTimeMs: null, reason: "unreadable_boot_time" });
            return;
          }
          // A boot instant in the future cannot be evidence about a past
          // generation; treat it as an unusable reading (fail closed).
          if (ms > Date.now() + 60_000) {
            resolve({ ok: false, bootTimeMs: null, reason: "boot_time_in_future" });
            return;
          }
          resolve({ ok: true, bootTimeMs: Math.trunc(ms), reason: null });
        }
      );
    } catch (e) {
      resolve({ ok: false, bootTimeMs: null, reason: `boot_time_probe_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
}

/** Outcome of a descendant scan. `unknown` means a candidate could not be identified. */
export interface DescendantScan {
  /** Live descendants of the root, scoped to the generation start time. */
  pids: number[];
  /** True when a candidate's creation time was unreported, so the tree is unknown. */
  unknown: boolean;
}

/**
 * Bounded containment classification for a POSIX managed root.
 *
 * A process-group kill covers only descendants that still belong to the root's
 * owned session/group. A descendant that moved to another PGID/SID is an
 * observed escape; missing group/session facts are UNKNOWN. Neither may be
 * upgraded to a whole managed-tree confirmation.
 */
export interface ProcessGroupContainment {
  descendantPids: number[];
  outsidePids: number[];
  unknown: boolean;
}

export function classifyProcessGroupContainment(
  processes: readonly ProcessEntry[],
  rootPid: number,
  sinceMs: number,
  ignoredPids: ReadonlySet<number> = new Set()
): ProcessGroupContainment {
  const found = findDescendants(processes, rootPid, sinceMs, ignoredPids);
  const byPid = new Map(processes.map((entry) => [entry.pid, entry] as const));
  const outsidePids: number[] = [];
  let unknown = found.unknown;
  for (const pid of found.pids) {
    const entry = byPid.get(pid);
    if (!entry || entry.pgid == null || entry.sid == null) {
      unknown = true;
      continue;
    }
    if (entry.pgid !== rootPid || entry.sid !== rootPid) outsidePids.push(pid);
  }
  return { descendantPids: [...found.pids], outsidePids, unknown };
}

/**
 * Find the descendants of `rootPid` in an enumerated process table.
 *
 * Scoping: a candidate is only accepted when its creation time is KNOWN and is
 * not before `sinceMs` (the generation start time minus a small tolerance). A
 * process created before the generation cannot be ours — that is exactly the
 * pid-reuse case — so it is excluded and never signalled. A candidate whose
 * creation time is unreported makes the whole scan `unknown` (conservative).
 *
 * The walk follows the PPID chain, so it finds a descendant even when the root
 * itself is already gone (Windows does NOT reparent orphans; the PPID is
 * preserved). A gap in the chain — a dead intermediate whose own PID is absent
 * from the table — is a documented limit: descendants below such a gap are not
 * discoverable from the root alone.
 */
export function findDescendants(
  processes: readonly ProcessEntry[],
  rootPid: number,
  sinceMs: number,
  ignoredPids: ReadonlySet<number> = new Set()
): DescendantScan {
  const byPpid = new Map<number, ProcessEntry[]>();
  for (const p of processes) {
    const list = byPpid.get(p.ppid);
    if (list) list.push(p);
    else byPpid.set(p.ppid, [p]);
  }
  const pids: number[] = [];
  let unknown = false;
  const seen = new Set<number>([rootPid]);
  const frontier: number[] = [rootPid];
  while (frontier.length > 0) {
    const parent = frontier.shift() as number;
    for (const child of byPpid.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      // Provider-managed daemons (for example the persistent WorkBuddy sidecar)
      // may have been spawned by a job process but are intentionally outside the
      // job's disposable CLI tree. Ignore the daemon root and its subtree only
      // when the caller supplied the exact PID from provider-owned metadata.
      if (ignoredPids.has(child.pid)) continue;
      if (child.createdAtMs == null) {
        unknown = true;
        continue;
      }
      if (child.createdAtMs < sinceMs) continue; // created before this generation → not ours
      pids.push(child.pid);
      frontier.push(child.pid);
    }
  }
  return { pids, unknown };
}

/** Poll until the PID is provably gone, or the window elapses. */
export async function confirmPidExit(
  pid: number,
  timeoutMs: number,
  opts: { pollMs?: number; isAliveFn?: (pid: number) => boolean | null; delayFn?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const alive = opts.isAliveFn ?? isPidAlive;
  const sleep = opts.delayFn ?? delay;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  for (;;) {
    if (alive(pid) === false) return true;
    if (Date.now() >= deadline) return alive(pid) === false;
    await sleep(pollMs);
  }
}

function runTaskkill(pid: number, execFileFn: typeof execFile): Promise<{ ok: boolean; error: string | null }> {
  return new Promise((resolve) => {
    try {
      execFileFn(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 20000 },
        (error, _stdout, stderr) => {
          // taskkill exits non-zero when the PID is already gone; that is not a
          // failure of intent, so only report the raw error text.
          const text = typeof stderr === "string" && stderr.trim() ? stderr.trim().slice(0, 400) : null;
          resolve({ ok: !error, error: error ? text || String((error as Error).message || error) : null });
        }
      );
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message || e) });
    }
  });
}

/**
 * Kill the process TREE rooted at `pid` and report EXACTLY what was proven.
 *
 * - `pid == null` → `confirmed: true`, `scope: "none"` (there is no tree).
 * - PID already dead → `confirmed: true`, `scope: "root_exited"` (a dead ROOT
 *   never proves its descendants stopped — see matrix E).
 * - win32 → `taskkill /pid <pid> /T /F`. Only a SUCCESSFUL taskkill (plus a gone
 *   root PID) yields `scope: "os_tree_exited"`. A direct `SIGKILL` fallback only
 *   proves the root died at best, so it returns `scope: "root_exited"` (root
 *   gone) or `"unconfirmed"` (root not proven gone), reason `tree_unconfirmed`.
 * - POSIX → signal the process group (`kill(-pid)`), then the PID itself, then
 *   confirm; a confirmed process-group kill is `scope: "os_tree_exited"`.
 *
 * No scope claims that an arbitrary detached descendant behind an exited
 * intermediate is gone. The caller must refuse to start a new generation and
 * refuse to report a terminal `cancelled` unless the scope proves the managed
 * tree stopped.
 */
export async function killProcessTree(pid: number | null | undefined, opts: KillTreeOptions = {}): Promise<KillTreeResult> {
  const alive = opts.isAliveFn ?? isPidAlive;
  const sleep = opts.delayFn ?? delay;
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return { killed: false, confirmed: true, scope: "none", pid: null, method: "none", reason: "no_pid" };
  }
  if (alive(pid) === false) {
    // The root is gone, but its descendants may still be alive. This is NOT a
    // tree guarantee; callers must not settle a terminal state from it alone.
    return { killed: false, confirmed: true, scope: "root_exited", pid, method: "none", reason: "already_dead" };
  }

  if (process.platform === "win32") {
    const execFileFn = opts.execFileFn ?? execFile;
    const taskkill = await runTaskkill(pid, execFileFn);
    if (taskkill.ok && (await confirmPidExit(pid, graceMs, { pollMs: opts.pollMs, isAliveFn: alive, delayFn: sleep }))) {
      // taskkill /T /F terminated the whole OS-tracked tree and the root PID is gone.
      return { killed: true, confirmed: true, scope: "os_tree_exited", pid, method: "taskkill" };
    }
    // taskkill failed (or the root survived it). A direct root kill cannot prove
    // the descendants stopped, so this is NEVER reported as a confirmed tree kill.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* best effort fallback */
    }
    const rootGone = await confirmPidExit(pid, graceMs, { pollMs: opts.pollMs, isAliveFn: alive, delayFn: sleep });
    return {
      killed: true,
      confirmed: rootGone,
      scope: rootGone ? "root_exited" : "unconfirmed",
      pid,
      method: "taskkill+kill",
      reason: "tree_unconfirmed"
    };
  }

  // Supported POSIX providers are launched as their own session/process-group
  // leaders. Never signal a persisted Darwin PID until its exact microsecond
  // birth still matches; a reused PID must not authorize a kill.
  if (process.platform === "darwin") {
    const current = readDarwinProcessSync(pid);
    if (!current) {
      return alive(pid) === false
        ? { killed: false, confirmed: true, scope: "root_exited", pid, method: "none", reason: "already_dead" }
        : { killed: false, confirmed: false, scope: "unconfirmed", pid, method: "none", reason: "identity_unknown" };
    }
    if (opts.expectedCreatedAtUs === null) {
      return {
        killed: false,
        confirmed: false,
        scope: "unconfirmed",
        pid,
        method: "none",
        reason: "identity_unpinned"
      };
    }
    if (
      typeof opts.expectedCreatedAtUs === "number" &&
      current.createdAtUs !== opts.expectedCreatedAtUs
    ) {
      return { killed: false, confirmed: true, scope: "root_exited", pid, method: "none", reason: "pid_reused" };
    }
    const groupOwned = current.pgid === pid && current.sid === pid && current.sessionLeader === true;
    if (!groupOwned && opts.expectedCreatedAtUs !== undefined) {
      // A persisted production PID is only group-signallable when the exact
      // recorded incarnation is also the group/session leader. Never downgrade
      // a stale persisted PID to an unsafe direct signal.
      return {
        killed: false,
        confirmed: false,
        scope: "unconfirmed",
        pid,
        method: "none",
        reason: "process_group_unproven"
      };
    }
    if (!groupOwned) {
      // Fresh/local callers that did NOT supply persisted identity evidence may
      // still need to stop the exact PID they just created (notably bounded test
      // cleanup). Signal only that PID and report root-only proof; never signal
      // its inherited process group and never upgrade this to a tree guarantee.
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best effort */
      }
      const rootGone = await confirmPidExit(pid, graceMs, {
        pollMs: opts.pollMs,
        isAliveFn: alive,
        delayFn: sleep
      });
      return {
        killed: true,
        confirmed: rootGone,
        scope: rootGone ? "root_exited" : "unconfirmed",
        pid,
        method: "process.kill",
        reason: "tree_unconfirmed"
      };
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group may already be gone; direct-root kill below is still bounded */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* best effort */
  }
  const [rootGone, groupGone] = await Promise.all([
    confirmPidExit(pid, graceMs, { pollMs: opts.pollMs, isAliveFn: alive, delayFn: sleep }),
    confirmProcessGroupExit(pid, graceMs, { pollMs: opts.pollMs, delayFn: sleep })
  ]);
  const confirmed = rootGone && groupGone;
  return {
    killed: true,
    confirmed,
    scope: confirmed ? "os_tree_exited" : rootGone ? "root_exited" : "unconfirmed",
    pid,
    method: "process.kill",
    ...(confirmed ? {} : { reason: groupGone ? "unconfirmed" : "tree_unconfirmed" })
  };
}
