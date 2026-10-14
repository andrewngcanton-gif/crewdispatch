// daemon-fixture-cleanup.ts — TEST-ONLY cleanup for a disposable data root whose
// OWNED daemon broker was launched as a REAL separate process (Windows WMI).
//
// WHY this exists. The cold-start deadline test
// (`src/tests/integration/daemon-startup-deadline.test.ts`, "the recovery budget
// still cold-starts a STOPPED broker inside itself") tore down its root like
// this:
//
//   await shutdownJobDaemon(root, {});
//   if (meta && isPidAlive(meta.pid) === true) process.kill(meta.pid);
//   fs.rmSync(root, { recursive: true, force: true });
//
// `shutdownJobDaemon` resolves as soon as the broker WRITES its shutdown
// response; the broker only begins its native exit afterwards (the server
// responds, then `setImmediate(close)`; a SIGTERM handler closes and sets the
// exit code). So the `rmSync` ran while the ORIGINAL broker process was still
// alive and still mutating files under `root` (heartbeat meta writes every 2s,
// the meta unlink during close). On Windows, deleting a directory tree that a
// live process still holds (as its working directory, or mid-mutation) can fail
// with EBUSY/EPERM. Bounded repro (work/daemon-deadline-cleanup-20261007): in
// every one of ~145 trials the broker was still alive at the `rmSync` — the
// live-process missing wait is REPRODUCED — and a live child whose cwd is the
// root makes the delete fail deterministically (EBUSY). The exact original EPERM
// errno was NOT reproduced and its precise cause remains UNCONFIRMED; it is not
// restated as the same race.
//
// THE RULE: await the confirmed exit of the ORIGINAL process INSTANCE before
// deleting its exact root. "Original instance" is proven by PID **and EXACT
// birth equality** (both observations come from the same OS timestamp
// representation), so a REUSED pid — even one born 1 ms later — is never mistaken
// for the broker; an unknown or unverifiable identity is left alone (never
// signalled, never assumed stopped). A pid merely read from `daemon.json` is NOT
// ownership: it is awaited conservatively and never signalled. Only AFTER every
// owned instance is confirmed gone is the root removed, with a standard bounded
// fs retry for residual OS handle-release lag.
//
// Everything here is test-only. It reads/writes only the disposable root the
// caller names; it never touches a real user data root, the global Hub or an
// unrelated process.
import fs from "node:fs";
import path from "node:path";
import {
  DESCENDANT_CLOCK_TOLERANCE_MS,
  enumerateDescendantProcesses,
  enumerateProcessByPid,
  enumerateProcesses,
  findDescendants,
  isPidAlive,
  type ProcessEntry,
  type ProcessScan
} from "../../runtime/process";
import { shutdownJobDaemon } from "../../daemon/client";

/**
 * A recorded process instance: the PID plus the birth instant that identifies
 * the EXACT incarnation. A pid alone is not an identity. Windows supplies epoch
 * milliseconds; Darwin additionally supplies exact epoch microseconds, which must
 * be preferred so two incarnations in the same millisecond are never conflated.
 */
export interface ProcessIdentity {
  pid: number;
  /** OS process creation time (epoch ms), or null when the OS did not report one. */
  birthMs: number | null;
  /** Exact Darwin process birth in epoch microseconds when persisted/proven. */
  birthUs?: number | null;
}

/** Exactly what was proven about a recorded process instance. */
export type InstanceExitOutcome =
  /** The pid is gone, or a DIFFERENT birth now holds it: the original exited. */
  | "exited"
  /** A different incarnation holds the pid (pid reuse): the original exited. */
  | "reused"
  /** The ORIGINAL instance is still alive when the bounded wait expired. */
  | "timeout"
  /** Liveness or birth could not be determined: never presented as stopped. */
  | "unknown";

/**
 * Is `entry` the SAME process instance as the recorded birth?
 *
 * EXACT finite equality, never a tolerance: the recorded birth and the observed
 * creation time come from the SAME OS timestamp representation (Windows CIM
 * `CreationDate` → epoch ms), so the SAME process reports the identical value.
 * A tolerance would let a REUSED pid born shortly after the original be accepted
 * as the original and be signalled — the exact safety gap this must not have.
 */
function isOriginal(entry: ProcessEntry | null, birthMs: number | null, birthUs: number | null | undefined): boolean {
  if (entry == null) return false;
  if (Number.isFinite(birthUs as number)) {
    return Number.isFinite(entry.createdAtUs as number) && entry.createdAtUs === birthUs;
  }
  return Number.isFinite(entry.createdAtMs as number) && Number.isFinite(birthMs as number) && entry.createdAtMs === birthMs;
}

/** A pid present with a KNOWN birth different from the recorded one is a reuse. */
function isReused(entry: ProcessEntry | null, birthMs: number | null, birthUs: number | null | undefined): boolean {
  if (entry == null) return false;
  if (Number.isFinite(birthUs as number)) {
    return Number.isFinite(entry.createdAtUs as number) && entry.createdAtUs !== birthUs;
  }
  return Number.isFinite(entry.createdAtMs as number) && Number.isFinite(birthMs as number) && entry.createdAtMs !== birthMs;
}

const DEFAULT_EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entryFor(scan: ProcessScan, pid: number): ProcessEntry | null {
  if (!scan.ok) return null;
  return scan.processes.find((p) => p.pid === pid) ?? null;
}

export interface CaptureIdentityOptions {
  /** Injectable enumeration seam (tests). */
  enumerateFn?: () => Promise<ProcessScan>;
}

/**
 * Record the PID + birth of a live process from ONE OS observation. Call this
 * while the process is known alive so a later cleanup can prove the SAME
 * incarnation exited. A missing/unreported creation time is recorded as null —
 * honestly unknown, never guessed.
 */
export async function captureProcessIdentity(
  pid: number,
  opts: CaptureIdentityOptions = {}
): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) return { pid, birthMs: null, birthUs: null };
  const enumerateFn = opts.enumerateFn ?? enumerateProcesses;
  try {
    const entry = entryFor(await enumerateFn(), pid);
    return { pid, birthMs: entry?.createdAtMs ?? null, birthUs: entry?.createdAtUs ?? null };
  } catch {
    return { pid, birthMs: null, birthUs: null };
  }
}

export interface AwaitInstanceExitOptions {
  /** Bound on the whole wait. Default 10000ms. */
  timeoutMs?: number;
  /** Poll interval. Default 100ms. */
  pollMs?: number;
  /**
   * After this many ms, terminate the instance — but ONLY once its birth proves
   * it is the ORIGINAL. 0 (default) never signals anything.
   */
  terminateAfterMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  enumerateFn?: () => Promise<ProcessScan>;
  delayFn?: (ms: number) => Promise<void>;
  killFn?: (pid: number) => void;
}

/**
 * Await the confirmed exit of the ORIGINAL process instance.
 *
 * A reused pid (a KNOWN birth different from the recorded one) resolves as
 * `"reused"` immediately and is never signalled. Termination only ever happens
 * for an EXACT-birth-proven ORIGINAL and only after `terminateAfterMs`. An
 * identity that cannot be verified (no birth evidence, or an enumeration that
 * fails) is NEVER signalled and never reported as stopped: the wait ends
 * `"unknown"`/`"timeout"` honestly.
 */
export async function awaitProcessInstanceExit(
  identity: ProcessIdentity,
  opts: AwaitInstanceExitOptions = {}
): Promise<InstanceExitOutcome> {
  const { pid, birthMs, birthUs } = identity;
  if (!Number.isInteger(pid) || pid <= 0) return "exited";

  const isAlive = opts.isAliveFn ?? isPidAlive;
  const enumerateFn = opts.enumerateFn ?? enumerateProcesses;
  const sleep = opts.delayFn ?? defaultDelay;
  const kill = opts.killFn ?? ((p: number): void => void process.kill(p));
  const timeoutMs = Math.max(0, opts.timeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const terminateAfterMs = opts.terminateAfterMs ?? 0;

  const start = Date.now();
  const deadline = start + timeoutMs;
  let terminated = false;
  let lastProvenOriginal = false;

  for (;;) {
    const alive = isAlive(pid);
    if (alive === false) return "exited";

    lastProvenOriginal = false;
    if (alive === true && (birthUs != null || birthMs != null)) {
      // Enumeration is only needed to distinguish the ORIGINAL from a REUSED pid,
      // so it is skipped entirely when there is no recorded birth to compare.
      let entry: ProcessEntry | null = null;
      try {
        entry = entryFor(await enumerateFn(), pid);
      } catch {
        entry = null;
      }
      // A pid present with a DIFFERENT birth is a reused pid: the original is gone.
      if (isReused(entry, birthMs, birthUs)) return "reused";
      lastProvenOriginal = isOriginal(entry, birthMs, birthUs);
      if (!terminated && terminateAfterMs > 0 && Date.now() - start >= terminateAfterMs && lastProvenOriginal) {
        terminated = true;
        try {
          kill(pid);
        } catch {
          /* best effort; the await below decides the outcome */
        }
      }
    }

    if (Date.now() >= deadline) {
      if (isAlive(pid) === false) return "exited";
      // On Windows `process.kill(pid, 0)` can occasionally be UNKNOWN around a
      // just-exited process. For an unproven metadata pid, one targeted CIM lookup
      // may still prove ABSENCE without turning a reused/live pid into ownership.
      // A present row remains unknown and is never signalled.
      if (birthMs == null && birthUs == null && process.platform === "win32" && !opts.enumerateFn) {
        try {
          const targeted = await enumerateProcessByPid(pid, { timeoutMs: 3000 });
          if (targeted.ok && targeted.processes.length === 0) return "exited";
        } catch {
          /* remain unknown */
        }
      }
      // Only a birth-proven ORIGINAL is a "timeout"; anything we could not verify
      // is "unknown" and is NEVER presented as stopped.
      return alive === true && lastProvenOriginal ? "timeout" : "unknown";
    }
    await sleep(pollMs);
  }
}

export interface RemoveBoundedOptions {
  /** Total attempts. Default 40 (~8s including delays). */
  attempts?: number;
  /** Delay between attempts. Default 200ms. */
  delayMs?: number;
  delayFn?: (ms: number) => Promise<void>;
}

const TRANSIENT_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Remove the exact root with a standard bounded retry. Used ONLY after every
 * owned process instance is confirmed stopped, so a retryable failure here is
 * residual Windows handle-release lag rather than a live process holding the
 * tree. Non-transient filesystem failures are surfaced immediately.
 */
export async function removeFixtureRootBounded(root: string, opts: RemoveBoundedOptions = {}): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? 40);
  const delayMs = opts.delayMs ?? 200;
  const sleep = opts.delayFn ?? defaultDelay;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_REMOVE_CODES.has(code) || attempt >= attempts - 1) break;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Read the broker pid this disposable root published, if any. */
export function discoverDaemonPid(root: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "daemon", "daemon.json"), "utf8")) as { pid?: unknown };
    return Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null;
  } catch {
    return null;
  }
}

export interface FixtureJobProcessRoot {
  pid: number;
  /** Earliest plausible birth of this generation's descendants. */
  sinceMs: number;
  /** Exact Darwin birth persisted for this owner/child PID when available. */
  birthUs: number | null;
}

/**
 * Read process roots retained by disposable job records. These PIDs are NOT
 * ownership evidence: they are conservative liveness/ancestry fences only.
 */
export function discoverFixtureJobProcessRoots(root: string): FixtureJobProcessRoot[] {
  const jobsDir = path.join(root, "jobs");
  const roots = new Map<number, { sinceMs: number; birthUs: number | null }>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(jobsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(jobsDir, entry.name), "utf8")) as Record<string, unknown>;
      const generation = Number.isInteger(parsed.childGeneration)
        ? Number(parsed.childGeneration)
        : Number.isInteger(parsed.generation) ? Number(parsed.generation) : null;
      const attempts = Array.isArray(parsed.attempts) ? parsed.attempts as Array<Record<string, unknown>> : [];
      const attempt = generation == null
        ? attempts[attempts.length - 1]
        : [...attempts].reverse().find((a) => Number(a.generation) === generation) ?? attempts[attempts.length - 1];
      const started = typeof attempt?.startedAt === "string" ? Date.parse(attempt.startedAt) : Number.NaN;
      const created = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : Number.NaN;
      const base = Number.isFinite(started) ? started : Number.isFinite(created) ? created : 0;
      const sinceMs = Math.max(0, base - DESCENDANT_CLOCK_TOLERANCE_MS);
      for (const key of ["ownerPid", "childPid"] as const) {
        const value = parsed[key];
        if (!Number.isSafeInteger(value) || Number(value) <= 0) continue;
        const pid = Number(value);
        const birthKey = key === "ownerPid" ? "ownerStartedAtUs" : "childStartedAtUs";
        const rawBirth = parsed[birthKey];
        const birthUs = Number.isSafeInteger(rawBirth) && Number(rawBirth) > 0 ? Number(rawBirth) : null;
        const previous = roots.get(pid);
        if (previous == null) {
          roots.set(pid, { sinceMs, birthUs });
        } else {
          const mergedBirth = previous.birthUs == null
            ? birthUs
            : birthUs == null || previous.birthUs === birthUs
              ? previous.birthUs
              : null;
          roots.set(pid, { sinceMs: Math.min(previous.sinceMs, sinceMs), birthUs: mergedBirth });
        }
      }
    } catch {
      // A corrupt/transient record cannot prove a process identity; ignore it.
    }
  }
  return [...roots].map(([pid, evidence]) => ({ pid, ...evidence }));
}

export function discoverFixtureJobPids(root: string): number[] {
  return discoverFixtureJobProcessRoots(root).map((item) => item.pid);
}

export interface RemoveFixtureWorkspaceOptions extends RemoveBoundedOptions {
  exitTimeoutMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  enumerateFn?: () => Promise<ProcessScan>;
  platform?: NodeJS.Platform;
}

/**
 * Remove the disposable parent workspace. If the first recursive delete hits a
 * transient Windows handle error, use the job roots captured BEFORE the data
 * root was removed to find still-live descendants. They are awaited only — never
 * signalled — then the ordinary bounded filesystem retry resumes.
 */
export async function removeFixtureWorkspaceBounded(
  dir: string,
  processRoots: readonly FixtureJobProcessRoot[],
  opts: RemoveFixtureWorkspaceOptions = {}
): Promise<void> {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (!code || !TRANSIENT_REMOVE_CODES.has(code)) throw e;
  }

  const platform = opts.platform ?? process.platform;
  if ((platform === "win32" || opts.enumerateFn) && processRoots.length > 0) {
    const descendants = new Set<number>();
    if (opts.enumerateFn) {
      let scan: ProcessScan | null = null;
      try {
        scan = await opts.enumerateFn();
      } catch {
        scan = null;
      }
      if (scan?.ok) {
        for (const rootInfo of processRoots) {
          const found = findDescendants(scan.processes, rootInfo.pid, rootInfo.sinceMs);
          for (const pid of found.pids) descendants.add(pid);
        }
      }
    } else if (platform === "win32" && process.platform === "win32") {
      // The parent workspace failure itself tells us an owned process may still
      // hold a handle. Avoid another whole-machine CIM projection under hosted
      // Windows load: query each cached job root's PPID subtree directly.
      for (const rootInfo of processRoots) {
        try {
          const scan = await enumerateDescendantProcesses(rootInfo.pid, { timeoutMs: 4000 });
          if (!scan.ok) continue;
          const found = findDescendants(scan.processes, rootInfo.pid, rootInfo.sinceMs);
          for (const pid of found.pids) descendants.add(pid);
        } catch {
          // The bounded filesystem retry below remains the final authority.
        }
      }
    }
    const waits = [...descendants].map((pid) =>
      awaitProcessInstanceExit(
        { pid, birthMs: null },
        {
          timeoutMs: opts.exitTimeoutMs ?? 10_000,
          terminateAfterMs: 0,
          isAliveFn: opts.isAliveFn,
          enumerateFn: opts.enumerateFn,
          delayFn: opts.delayFn
        }
      )
    );
    await Promise.all(waits);
  }

  await removeFixtureRootBounded(dir, opts);
}
export interface DaemonFixtureCleanupOptions {
  /** The disposable root this fixture created; the only path removed. */
  root: string;
  /** Recorded ORIGINAL broker identities for every process this fixture launched. */
  identities?: readonly ProcessIdentity[];
  /** Bound on awaiting each original instance's exit. Default 10000ms. */
  exitTimeoutMs?: number;
  /** Terminate a birth-proven original after this long; 0 disables. Default 2000ms. */
  terminateAfterMs?: number;
  /** Graceful shutdown before awaiting exit. Defaults to the production client. */
  shutdownFn?: (root: string) => Promise<void>;
  /** Discover a broker pid from the root when no identity was captured. */
  discoverPidFn?: (root: string) => number | null;
  removeAttempts?: number;
  removeDelayMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  enumerateFn?: () => Promise<ProcessScan>;
  delayFn?: (ms: number) => Promise<void>;
  killFn?: (pid: number) => void;
}

export interface DaemonFixtureCleanupReport {
  outcomes: Array<{ pid: number; outcome: InstanceExitOutcome }>;
  /** The daemon pid discovered from the root when no explicit identity was supplied. */
  discoveredPid: number | null;
  removed: boolean;
}

/**
 * Gracefully stop the fixture's broker, await the confirmed exit of every OWNED
 * original instance, then remove the root. If any owned instance is not
 * confirmed stopped, the root is LEFT IN PLACE and an honest error is thrown —
 * deleting it would be exactly the race this helper exists to remove.
 *
 * OWNERSHIP. A caller-supplied identity carries a birth observed while the
 * process was known to be the fixture's own (pid + birth). A pid merely
 * DISCOVERED from `<root>/daemon/daemon.json` proves NOTHING about ownership: a
 * stale metadata file can name a pid that the OS has since REUSED for an
 * unrelated process, and reading that process's current birth would turn a reuse
 * into false ownership. A discovered pid is therefore awaited CONSERVATIVELY as
 * an unproven identity (`birthMs: null`): it is never signalled, a dead pid lets
 * the root be removed safely, and an alive/unproven pid leaves the root in place
 * and is reported unresolved.
 */
export async function cleanupDaemonFixture(opts: DaemonFixtureCleanupOptions): Promise<DaemonFixtureCleanupReport> {
  const identities: ProcessIdentity[] = [];
  for (const id of opts.identities ?? []) {
    if (Number.isInteger(id.pid) && id.pid > 0) identities.push(id);
  }
  let discoveredPid: number | null = null;
  if (identities.length === 0) {
    const pid = (opts.discoverPidFn ?? discoverDaemonPid)(opts.root);
    if (pid != null && Number.isInteger(pid) && pid > 0) {
      discoveredPid = pid;
      // Deliberately NO birth capture: metadata alone cannot prove ownership.
      identities.push({ pid, birthMs: null });
    }
  }

  // A terminal job record may be visible before its detached worker/provider has
  // actually exited. A bare retained PID is treated like stale daemon metadata and
  // is only awaited. Modern Darwin job records additionally persist the exact
  // owner/child birth instant; that is real launch-time ownership evidence, so the
  // test fixture may terminate only that exact incarnation if it outlives teardown.
  for (const processRoot of discoverFixtureJobProcessRoots(opts.root)) {
    if (!identities.some((identity) => identity.pid === processRoot.pid)) {
      identities.push({
        pid: processRoot.pid,
        birthMs: processRoot.birthUs == null ? null : Math.floor(processRoot.birthUs / 1000),
        birthUs: processRoot.birthUs
      });
    }
  }

  const shutdown = opts.shutdownFn ?? ((r: string): Promise<void> => shutdownJobDaemon(r, {}));
  await shutdown(opts.root).catch(() => undefined);

  const outcomes: DaemonFixtureCleanupReport["outcomes"] = [];
  for (const identity of identities) {
    // Only a birth-proven identity may ever be terminated; an unproven one is
    // awaited for liveness only and can never be signalled.
    const terminateAfterMs = identity.birthUs != null || identity.birthMs != null ? opts.terminateAfterMs ?? 2000 : 0;
    const outcome = await awaitProcessInstanceExit(identity, {
      timeoutMs: opts.exitTimeoutMs,
      terminateAfterMs,
      isAliveFn: opts.isAliveFn,
      enumerateFn: opts.enumerateFn,
      delayFn: opts.delayFn,
      killFn: opts.killFn
    });
    outcomes.push({ pid: identity.pid, outcome });
  }

  const unresolved = outcomes.filter((o) => o.outcome === "timeout" || o.outcome === "unknown");
  if (unresolved.length > 0) {
    throw new Error(
      `daemon fixture cleanup: ${unresolved.length} fixture-related process instance(s) not confirmed stopped before removal ` +
        `(${unresolved.map((o) => `pid ${o.pid}: ${o.outcome}`).join(", ")}); root left in place at ${opts.root}`
    );
  }

  await removeFixtureRootBounded(opts.root, { attempts: opts.removeAttempts, delayMs: opts.removeDelayMs, delayFn: opts.delayFn });
  return { outcomes, discoveredPid, removed: true };
}
