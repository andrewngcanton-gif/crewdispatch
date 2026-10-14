// process-darwin.ts — Darwin-only process fact adapter.
//
// The native helper uses BSD sysctl exported process structures + getsid and
// kern.boottime. This module only READS facts; it never signals processes.
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import type { BootTimeReading, ProcessEntry, ProcessScan } from "./process";

interface HelperProcess {
  pid: unknown;
  ppid: unknown;
  pgid: unknown;
  sid: unknown;
  uid: unknown;
  start_sec: unknown;
  start_usec: unknown;
  session_leader: unknown;
  comm: unknown;
}

interface SnapshotReply {
  ok?: unknown;
  op?: unknown;
  processes?: unknown;
  errno?: unknown;
  error?: unknown;
}

interface BootReply {
  ok?: unknown;
  op?: unknown;
  sec?: unknown;
  usec?: unknown;
  errno?: unknown;
  error?: unknown;
}

function helperPath(): string {
  return path.resolve(__dirname, "..", "native", "macos-process-info");
}

function supportedDarwinArchitecture(): boolean {
  return process.arch === "arm64" || process.arch === "x64";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function birthUs(secValue: unknown, usecValue: unknown): number | null {
  const sec = integer(secValue);
  const usec = integer(usecValue);
  if (sec == null || sec <= 0 || usec == null || usec < 0 || usec >= 1_000_000) return null;
  const total = sec * 1_000_000 + usec;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function parseJson(text: string): unknown {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error("empty_helper_output");
  return JSON.parse(trimmed);
}

export function parseDarwinProcessReply(text: string): ProcessEntry | null {
  let decoded: unknown;
  try {
    decoded = parseJson(text);
  } catch {
    return null;
  }
  const raw = decoded as HelperProcess & { ok?: unknown; op?: unknown };
  if (raw?.ok !== true || raw.op !== "process") return null;
  const pid = integer(raw.pid);
  const ppid = integer(raw.ppid);
  const createdAtUs = birthUs(raw.start_sec, raw.start_usec);
  if (pid == null || pid <= 0 || ppid == null || ppid < 0 || createdAtUs == null) return null;
  const pgidValue = integer(raw.pgid);
  const sidValue = integer(raw.sid);
  const entry: ProcessEntry = {
    pid,
    ppid,
    createdAtMs: Math.floor(createdAtUs / 1000),
    createdAtUs,
    pgid: pgidValue != null && pgidValue > 0 ? pgidValue : null,
    sid: sidValue != null && sidValue > 0 ? sidValue : null,
    sessionLeader: raw.session_leader === true
  };
  if (typeof raw.comm === "string" && raw.comm.trim()) entry.imageName = raw.comm.trim();
  return entry;
}

export function readDarwinProcessSync(pid: number): ProcessEntry | null {
  if (process.platform !== "darwin" || !supportedDarwinArchitecture() || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stdout = execFileSync(
      helperPath(),
      ["process", String(pid)],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }
    );
    return parseDarwinProcessReply(stdout);
  } catch {
    return null;
  }
}

export function parseDarwinProcessSnapshot(text: string): ProcessScan {
  let decoded: unknown;
  try {
    decoded = parseJson(text);
  } catch (e) {
    return { ok: false, processes: [], reason: `darwin_helper_invalid_json: ${String((e as Error)?.message || e).slice(0, 160)}` };
  }
  const reply = decoded as SnapshotReply;
  if (reply?.ok !== true || reply.op !== "snapshot" || !Array.isArray(reply.processes)) {
    const reason = typeof reply?.error === "string" && reply.error ? reply.error.slice(0, 160) : "invalid_snapshot_reply";
    return { ok: false, processes: [], reason: `darwin_helper_failed: ${reason}` };
  }

  const processes: ProcessEntry[] = [];
  for (const raw of reply.processes as HelperProcess[]) {
    const pid = integer(raw?.pid);
    const ppid = integer(raw?.ppid);
    const createdAtUs = birthUs(raw?.start_sec, raw?.start_usec);
    if (pid == null || pid <= 0 || ppid == null || ppid < 0 || createdAtUs == null) {
      // A partial/unidentifiable row makes the entire observation unsafe. Do
      // not silently return a partial process table.
      return { ok: false, processes: [], reason: "darwin_helper_unidentifiable_process" };
    }
    const pgidValue = integer(raw?.pgid);
    const sidValue = integer(raw?.sid);
    const entry: ProcessEntry = {
      pid,
      ppid,
      createdAtMs: Math.floor(createdAtUs / 1000),
      createdAtUs,
      // A process-table row can remain useful for exact incarnation + ancestry
      // even when getsid() is denied for that ONE system process. Keep these
      // target-specific facts nullable; callers that intend to signal/group a
      // process must require them for that target rather than invalidating the
      // entire OS snapshot.
      pgid: pgidValue != null && pgidValue > 0 ? pgidValue : null,
      sid: sidValue != null && sidValue > 0 ? sidValue : null,
      sessionLeader: raw?.session_leader === true
    };
    if (typeof raw?.comm === "string" && raw.comm.trim()) entry.imageName = raw.comm.trim();
    processes.push(entry);
  }
  return processes.length > 0
    ? { ok: true, processes }
    : { ok: false, processes: [], reason: "empty_process_list" };
}

export function parseDarwinBootTime(text: string, nowMs: number = Date.now()): BootTimeReading {
  let decoded: unknown;
  try {
    decoded = parseJson(text);
  } catch (e) {
    return {
      ok: false,
      bootTimeMs: null,
      bootTimeUs: null,
      reason: `darwin_boot_invalid_json: ${String((e as Error)?.message || e).slice(0, 160)}`
    };
  }
  const reply = decoded as BootReply;
  const bootTimeUs = reply?.ok === true && reply.op === "boot" ? birthUs(reply.sec, reply.usec) : null;
  if (bootTimeUs == null) {
    const reason = typeof reply?.error === "string" && reply.error ? reply.error.slice(0, 160) : "unreadable_boot_time";
    return { ok: false, bootTimeMs: null, bootTimeUs: null, reason: `darwin_boot_failed: ${reason}` };
  }
  const bootTimeMs = Math.floor(bootTimeUs / 1000);
  if (bootTimeMs > nowMs + 60_000) {
    return { ok: false, bootTimeMs: null, bootTimeUs: null, reason: "boot_time_in_future" };
  }
  return { ok: true, bootTimeMs, bootTimeUs, reason: null };
}

function runHelper(
  args: string[],
  opts: { execFileFn?: typeof execFile; timeoutMs?: number; maxBuffer?: number } = {}
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  const execFileFn = opts.execFileFn ?? execFile;
  return new Promise((resolve) => {
    try {
      execFileFn(
        helperPath(),
        args,
        {
          windowsHide: true,
          timeout: opts.timeoutMs ?? 10_000,
          maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = typeof stderr === "string" && stderr.trim()
              ? stderr.trim()
              : String((error as Error)?.message || error);
            resolve({ ok: false, reason: `darwin_helper_exec_failed: ${detail.slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, stdout: typeof stdout === "string" ? stdout : String(stdout ?? "") });
        }
      );
    } catch (e) {
      resolve({ ok: false, reason: `darwin_helper_exec_failed: ${String((e as Error)?.message || e).slice(0, 200)}` });
    }
  });
}

export async function enumerateDarwinProcesses(
  opts: { execFileFn?: typeof execFile; timeoutMs?: number } = {}
): Promise<ProcessScan> {
  if (process.platform !== "darwin" || !supportedDarwinArchitecture()) {
    return { ok: false, processes: [], reason: "unsupported_platform" };
  }
  const result = await runHelper(["snapshot"], opts);
  return result.ok ? parseDarwinProcessSnapshot(result.stdout) : { ok: false, processes: [], reason: result.reason };
}

export async function readDarwinBootTime(
  opts: { execFileFn?: typeof execFile; timeoutMs?: number; nowMs?: number } = {}
): Promise<BootTimeReading> {
  if (process.platform !== "darwin" || !supportedDarwinArchitecture()) {
    return { ok: false, bootTimeMs: null, bootTimeUs: null, reason: "unsupported_platform" };
  }
  const result = await runHelper(["boot"], { execFileFn: opts.execFileFn, timeoutMs: opts.timeoutMs });
  return result.ok
    ? parseDarwinBootTime(result.stdout, opts.nowMs ?? Date.now())
    : { ok: false, bootTimeMs: null, bootTimeUs: null, reason: result.reason };
}
