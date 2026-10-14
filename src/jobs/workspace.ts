// workspace.ts — the shared EXACT-workspace occupancy guard (JQ-20261002-44).
//
// Product rule (first release): at most ONE accepted ACTIVE CrewDispatch job may
// target a given canonical working directory at a time — regardless of which
// caller (MCP entry, Dashboard/Hub, internal harness), which caller process, or
// which provider submitted it. A new dispatch into a held directory is REFUSED
// visibly with the stable code `workspace_busy`; it is never silently queued and
// never cancels the current holder.
//
// Design:
//
//   * the DECISION is derived from the DURABLE job records under the shared data
//     root. `queued`, `running` and `orphaned` are ACTIVE (a holder). A terminal
//     record (done/error/cancelled/interrupted) normally releases the workspace,
//     EXCEPT when it RETAINS an unresolved managed child tree: a terminal write
//     whose tree could not be proven stopped keeps `childPid` as evidence (see
//     `finalize` in jobs/service.ts), and that record keeps holding the
//     directory until a generation-scoped proof resolves it: the EXISTING
//     continuation old-tree check, or the shared PASSIVE recovery
//     (`recoverTerminalHolders` in jobs/reconcile.ts, reached by daemon
//     admission and the daemon sweep) that persists separate, validated,
//     generation-bound evidence after independently proving the retained tree
//     stopped — without killing anything or rewriting the record. The release
//     decision reuses the shared generation-scoped `isTreeConfirmed` +
//     PID-liveness semantics, so a dead root alone never releases it. There is
//     no lease to expire and no explicit "release" call a late completion could
//     misdirect: a record stops being a holder when its OWN status becomes
//     terminal WITHOUT retained child evidence, or when a valid confirmation /
//     validated recovery evidence proves its tree stopped — so an old
//     completion can never release a newer holder, and a daemon restart needs
//     no reconstruction step — the guard re-derives the same holders from the
//     same records;
//
//   * the check + reservation is serialized by an exact exclusive lock file
//     (`<root>/jobs/workspace-<hash>.lock`, the same proven pattern as
//     `acquireJobTransitionLock`), so two PROCESSES cannot both pass the check
//     and both persist a queued record. The lock is a short mutex around
//     "scan → persist the accepted record"; the durable record is the actual
//     reservation, so the mutex is released as soon as the record is written.
//     A stale lock is reclaimed only when its owner PID is provably gone (or an
//     unreadable marker is older than one minute);
//
//   * a matching holder is passed through the SAME liveness rules used
//     everywhere else (`reconcileJob`): only a stale heartbeat AND a provably
//     dead owner PID AND a resolved-stopped child tree settle it terminal. Age
//     alone, a late heartbeat, a daemon restart or a missing heartbeat NEVER
//     free a workspace while the recorded worker may still be alive; an
//     `orphaned` holder (dead owner, unconfirmed child tree) keeps the
//     workspace until an explicit cancel resolves it;
//
//   * existing Darwin directories use filesystem identity (realpath + device/inode)
//     as the primary same-workspace fact. The canonical real path remains the
//     display/fallback identity and Windows keeps its accepted case-folded path
//     semantics. A symlink/Unicode/case alias of the SAME existing APFS object
//     therefore conflicts, while distinct objects on case-sensitive APFS remain
//     distinct. Pre-v15 records and pre-MAC-14 reservation locks retain the old
//     canonical-path hash as an explicit compatibility path;//
//   * there is deliberately NO read-only bypass and no inferred exception: the
//     task prose is never inspected, and an explicit exclusion mode would need
//     its own reviewed contract, so none is invented here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "../runtime/process";
import { reconcileJobAndSave, type ReconcileOptions } from "./reconcile";
import { assertInside, isTreeConfirmed, isTreeRecoveryConfirmed, jobsDir, listJobs } from "./store";
import { isTerminalStatus, type JobRecord, type JobStatus, type RunnerKind } from "./types";

/** Stable refusal code surfaced to every caller for an occupied workspace. */
export const WORKSPACE_BUSY = "workspace_busy";

/** The active job currently holding a canonical workspace. */
export interface WorkspaceHolder {
  jobId: string;
  provider: string;
  runner: RunnerKind;
  status: JobStatus;
  generation: number;
  ownerPid: number | null;
  /** The canonical workspace directory (never the raw caller spelling). */
  cwd: string;
  /**
   * The retained managed child PID of a TERMINAL holder whose recorded process
   * tree is not proven stopped (alive, unknown liveness, or a dead root without
   * a valid generation-scoped confirmation). Null for a non-terminal holder and
   * for a terminal record with no retained child evidence.
   */
  retainedChildPid: number | null;
}

interface HolderMatch {
  job: JobRecord;
  holder: WorkspaceHolder;
}

/** Strip the Win32 `\\?\` / `\\.\` namespace prefixes an OS real path may carry. */
function stripWindowsNamespace(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.startsWith("\\\\?\\UNC\\")) return `\\\\${p.slice("\\\\?\\UNC\\".length)}`;
  if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
  return p;
}

/**
 * The canonical EXACT workspace directory for a caller-supplied cwd.
 *
 * `path.resolve` makes it absolute and normalized. Existing directories are
 * replaced by the OS real path, resolving symlinks/junctions and filesystem
 * spelling. This string is still user-visible and is the legacy comparison key;
 * Darwin's primary identity for an existing directory is device+inode below.
 */
export function canonicalWorkspacePath(cwd: string): string {
  const trimmed = typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
  const resolved = path.resolve(trimmed);
  try {
    return path.resolve(stripWindowsNamespace(fs.realpathSync.native(resolved)));
  } catch {
    return resolved;
  }
}

/**
 * Historical canonical-path hash. KEEP this stable: pre-MAC-14 processes use it
 * for reservation mutexes and pre-v15 records have no filesystem identity.
 */
export function workspaceKey(canonicalCwd: string): string {
  const folded = process.platform === "win32" ? canonicalCwd.toLowerCase() : canonicalCwd;
  return crypto.createHash("sha256").update(folded, "utf8").digest("hex").slice(0, 40);
}

export interface WorkspaceIdentity {
  canonicalCwd: string;
  /** Darwin real filesystem object identity; null when unavailable/not applicable. */
  persistentIdentity: string | null;
  /** Primary reservation key for this build. */
  primaryKey: string;
  /** Stable pre-MAC-14 canonical-path key. */
  legacyKey: string;
  source: "filesystem" | "path_fallback";
}

function identityKey(persistentIdentity: string): string {
  return crypto.createHash("sha256").update(`workspace\0${persistentIdentity}`, "utf8").digest("hex").slice(0, 40);
}

/**
 * Resolve the workspace identity without mutating the filesystem.
 *
 * Existing Darwin directories use realpath + stat(device,inode). If either fact
 * cannot be read, the function honestly falls back to the historical canonical
 * path key. No global case-folding is ever applied on Darwin.
 */
export function resolveWorkspaceIdentity(cwd: string): WorkspaceIdentity {
  const canonicalCwd = canonicalWorkspacePath(cwd);
  const legacyKey = workspaceKey(canonicalCwd);
  if (process.platform === "darwin") {
    try {
      const stat = fs.statSync(canonicalCwd, { bigint: true });
      if (stat.isDirectory()) {
        const persistentIdentity = `darwin-fs:${stat.dev.toString()}:${stat.ino.toString()}`;
        return {
          canonicalCwd,
          persistentIdentity,
          primaryKey: identityKey(persistentIdentity),
          legacyKey,
          source: "filesystem"
        };
      }
    } catch {
      // Missing/unreadable paths retain the historical exact-path behavior.
    }
  }
  return { canonicalCwd, persistentIdentity: null, primaryKey: legacyKey, legacyKey, source: "path_fallback" };
}

function matchesWorkspace(job: JobRecord, target: WorkspaceIdentity): boolean {
  try {
    // v15+ records keep the accepted Darwin object identity. When both sides
    // have exact identity it is authoritative even if the directory was renamed.
    if (target.persistentIdentity != null && job.workspaceIdentity != null) {
      return target.persistentIdentity === job.workspaceIdentity;
    }
    // Pre-v15 records (or an unreadable target) retain the historical canonical
    // path behavior. This is intentionally conservative compatibility, not a
    // guessed filesystem identity.
    return workspaceKey(canonicalWorkspacePath(job.cwd)) === target.legacyKey;
  } catch {
    return false;
  }
}

/** Select durable records targeting the same exact workspace as `cwd`. */
export function workspaceJobFilter(cwd: string): (job: JobRecord) => boolean {
  const target = resolveWorkspaceIdentity(cwd);
  return (job) => matchesWorkspace(job, target);
}
function holderOf(job: JobRecord, canonicalCwd: string, retainedChildPid: number | null = null): WorkspaceHolder {
  return {
    jobId: job.id,
    provider: job.provider,
    runner: job.runner,
    status: job.status,
    generation: job.generation,
    ownerPid: job.ownerPid,
    cwd: canonicalCwd,
    retainedChildPid
  };
}

/**
 * Does a TERMINAL record still hold its workspace through a retained managed
 * child tree? A terminal record with no child evidence releases.
 *
 * A valid PASSIVE recovery evidence record for the SAME generation/child PID
 * releases first: it is persisted only after an independent proof (a boot that
 * postdates the generation's LATEST recorded attempt start — the spawn the
 * retained child belongs to — or a bounded descendant snapshot with a provably
 * dead root and no live scoped descendant), and it also covers pid reuse — a
 * current process holding the old number is a different incarnation and is
 * never attributed to this record.
 *
 * Otherwise a retained child that is alive OR of unknown liveness blocks; a
 * dead root blocks unless the SAME generation/child PID has a persisted,
 * generation-scoped tree confirmation — the exact `reconcileJob` release rule,
 * never a weaker age/root-dead-only proof. This only READS evidence: it never
 * kills a process, clears the record, writes evidence or resumes work.
 */
function terminalChildBlocks(root: string, job: JobRecord, opts: WorkspaceCheckOptions): boolean {
  if (job.childPid == null) return false;
  if (isTreeRecoveryConfirmed(root, job)) return false;
  const isChildAlive = opts.reconcile?.isChildAliveFn ?? isPidAlive;
  if (isChildAlive(job.childPid) !== false) return true;
  const confirmed = opts.reconcile?.isTreeConfirmedFn ?? ((j: JobRecord) => isTreeConfirmed(root, j));
  return !confirmed(job);
}

/** Deterministic first holder match in the durable store order. */
function findHolderMatch(
  root: string,
  target: WorkspaceIdentity,
  excludeJobId: string | null | undefined,
  opts: WorkspaceCheckOptions
): HolderMatch | null {
  const canonicalCwd = target.canonicalCwd;
  const { jobs } = listJobs(root);
  for (const job of jobs) {
    if (excludeJobId != null && job.id === excludeJobId) continue;
    if (!matchesWorkspace(job, target)) continue;
    if (isTerminalStatus(job.status)) {
      // A terminal record whose retained managed child tree is alive, unknown
      // or unconfirmed still holds the directory (the same evidence
      // `prepareContinuation` must resolve before it may start a new
      // generation, and the same condition the shared passive recovery
      // revalidates). Only a terminal record WITHOUT such evidence — or with a
      // valid generation-scoped stopped confirmation / validated recovery
      // evidence — releases.
      if (!terminalChildBlocks(root, job, opts)) continue;
      return { job, holder: holderOf(job, canonicalCwd, job.childPid) };
    }
    return { job, holder: holderOf(job, canonicalCwd) };
  }
  return null;
}

/**
 * Pure read: the active holder of `canonicalCwd`, if any (never reconciles).
 * `excludeJobId` is the job a continuation belongs to: the same logical job may
 * hold its own workspace across generations, so it is not "another" holder.
 * A TERMINAL record with a retained, unresolved managed child tree is a holder
 * too (see `terminalChildBlocks`); liveness/confirmation seams come from
 * `opts.reconcile` and default to the production probes.
 */
export function findWorkspaceHolder(
  root: string,
  canonicalCwd: string,
  excludeJobId?: string | null,
  opts: WorkspaceCheckOptions = {}
): WorkspaceHolder | null {
  return findHolderMatch(root, resolveWorkspaceIdentity(canonicalCwd), excludeJobId, opts)?.holder ?? null;
}

export interface WorkspaceCheckOptions {
  /** A job allowed to hold this workspace (its own continuation). */
  excludeJobId?: string | null;
  /** Liveness/tree seams forwarded to the shared reconcile decision (tests). */
  reconcile?: ReconcileOptions;
  now?: () => Date;
}

export interface WorkspaceEvaluation {
  canonicalCwd: string;
  holder: WorkspaceHolder | null;
}

/**
 * Evaluate occupancy WITHOUT the reservation mutex: find the active holder and,
 * when one exists, give the shared liveness rules a chance to settle a provably
 * dead owner (stale heartbeat + dead owner PID + resolved-stopped tree) before
 * reporting the workspace busy. Age, a daemon restart or a late heartbeat alone
 * never free it.
 *
 * Callers use this for an early, side-effect-free refusal; the authoritative
 * decision is taken again under `acquireWorkspace`.
 */
export function evaluateWorkspace(root: string, cwd: string, opts: WorkspaceCheckOptions = {}): WorkspaceEvaluation {
  const identity = resolveWorkspaceIdentity(cwd);
  const canonicalCwd = identity.canonicalCwd;
  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  for (;;) {
    const match = findHolderMatch(root, identity, opts.excludeJobId, opts);
    if (!match) return { canonicalCwd, holder: null };
    // A settle either makes the holder terminal (it stops matching) or leaves it
    // `orphaned` (still a holder, no longer reconcilable), so this loop always
    // terminates. A TERMINAL holder with retained child evidence is never
    // rewritten by reconcile, so it is reported as-is unless it already carries
    // a valid confirmation or validated passive recovery evidence (see
    // `terminalChildBlocks`); otherwise the shared recovery path may resolve it.
    const settled = reconcileJobAndSave(root, match.job, nowMs, opts.reconcile ?? {});
    if (!settled) return { canonicalCwd, holder: match.holder };
  }
}

// ---------------------------------------------------------------------------
// Reservation mutex (short, cross-process, exact lock file)
// ---------------------------------------------------------------------------

function lockFileForKey(root: string, key: string): string {
  return path.join(jobsDir(root), `workspace-${key}.lock`);
}

function workspaceLockPaths(root: string, identity: WorkspaceIdentity): string[] {
  const primary = lockFileForKey(root, identity.primaryKey);
  const legacy = lockFileForKey(root, identity.legacyKey);
  return primary === legacy ? [primary] : [primary, legacy];
}
/**
 * Reclaim an abandoned lock ONLY when its owner PID is provably gone (or an
 * unreadable marker is older than one minute). Identical policy to the job
 * transition lock; a live owner — even one that has not updated the marker — is
 * never overridden.
 */
function reclaimStaleWorkspaceLock(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    let ownerPid: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0) ownerPid = parsed.pid as number;
    } catch {
      // An empty/corrupt marker may be from a process that crashed while
      // creating it. Wait before reclaiming so a just-created marker wins.
    }
    if (ownerPid != null) {
      try {
        process.kill(ownerPid, 0);
        return false;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ESRCH") return false;
      }
    } else if (Date.now() - stat.mtimeMs < 60_000) {
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

function tryCreateWorkspaceLock(file: string): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
        try {
          fs.fsyncSync(fd);
        } catch {
          /* a durable marker is best-effort; exclusive creation is the guard */
        }
      } catch (e) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try { fs.unlinkSync(file); } catch { /* best effort */ }
        throw e;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try { fs.unlinkSync(file); } catch { /* best effort */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST" && reclaimStaleWorkspaceLock(file)) continue;
      return null;
    }
  }
  return null;
}

/** A bounded synchronous wait; never used while an ownership decision is pending. */

function tryCreateWorkspaceLocks(files: readonly string[]): (() => void) | null {
  const releases: Array<() => void> = [];
  for (const file of files) {
    const release = tryCreateWorkspaceLock(file);
    if (!release) {
      for (const undo of releases.reverse()) undo();
      return null;
    }
    releases.push(release);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.reverse()) release();
  };
}

function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* Atomics.wait may be unavailable; the bounded retry continues immediately */
  }
}

export interface AcquireWorkspaceOptions extends WorkspaceCheckOptions {
  root: string;
  cwd: string;
  /**
   * Bounded cross-process contention window. The critical section is a scan plus
   * two atomic writes; the default (30 x 10ms) only ever matters when a SECOND
   * process (e.g. the internal harness) reserves the same directory concurrently.
   */
  lockAttempts?: number;
  lockStepMs?: number;
}

export type AcquireWorkspaceResult =
  | { ok: true; canonicalCwd: string; workspaceIdentity: string | null; release: () => void }
  | { ok: false; canonicalCwd: string; holder: WorkspaceHolder | null };

/**
 * Atomically check the workspace and reserve it for the caller's accepted job.
 *
 * On `ok:true` the caller MUST persist the accepted record (the durable
 * reservation) and then call `release()` — releasing earlier is never allowed,
 * and releasing later only widens the mutex window. `release()` is idempotent
 * and safe to call in a `finally`.
 *
 * On `ok:false` nothing was written: `holder` is the active job occupying the
 * directory, or null when a concurrent dispatch held the reservation mutex for
 * longer than the bounded window (fail closed: the caller may retry).
 */
export function acquireWorkspace(opts: AcquireWorkspaceOptions): AcquireWorkspaceResult {
  const identity = resolveWorkspaceIdentity(opts.cwd);
  const canonicalCwd = identity.canonicalCwd;
  const files = workspaceLockPaths(opts.root, identity);
  for (const file of files) assertInside(opts.root, file);
  fs.mkdirSync(path.dirname(files[0]!), { recursive: true });

  const attempts = Number.isSafeInteger(opts.lockAttempts) && (opts.lockAttempts as number) > 0
    ? (opts.lockAttempts as number)
    : 30;
  const stepMs = Number.isFinite(opts.lockStepMs) && (opts.lockStepMs as number) >= 0
    ? (opts.lockStepMs as number)
    : 10;

  let release: (() => void) | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    release = tryCreateWorkspaceLocks(files);
    if (release) break;
    sleepSync(stepMs);
  }
  if (!release) {
    // Contention is never an ownership decision: report the currently visible
    // holder when there is one and fail closed otherwise.
    return { ok: false, canonicalCwd, holder: findWorkspaceHolder(opts.root, canonicalCwd, opts.excludeJobId, opts) };
  }

  try {
    const evaluation = evaluateWorkspace(opts.root, canonicalCwd, opts);
    if (evaluation.holder) {
      release();
      return { ok: false, canonicalCwd: evaluation.canonicalCwd, holder: evaluation.holder };
    }
    return {
      ok: true,
      canonicalCwd: evaluation.canonicalCwd,
      workspaceIdentity: identity.persistentIdentity,
      release
    };
  } catch (e) {
    release();
    throw e;
  }
}

/**
 * The user-visible refusal text. It always names the canonical directory and,
 * when one is known, the exact holder: job id, provider, runner, status, run
 * (generation) and owner PID. A TERMINAL holder with a retained child tree is
 * explained as a finished task whose managed process tree is not confirmed
 * stopped. Recovery guidance is platform-correct: Darwin never promises that a
 * later dead-root scan or a same-job continuation can reconstruct reparented
 * descendants after exact containment proof was lost. Never contains a task,
 * session or credential.
 */
export function workspaceBusyMessage(holder: WorkspaceHolder | null, canonicalCwd: string, platform: NodeJS.Platform = process.platform): string {
  if (!holder) {
    return (
      `The working directory ${canonicalCwd} is being reserved by another CrewDispatch dispatch right now ` +
      "(a concurrent start/continuation is between its check and its accepted record); retry shortly. " +
      "CrewDispatch allows only one active task per working directory."
    );
  }
  if (holder.retainedChildPid != null) {
    const recoveryGuidance =
      platform === "darwin"
        ? "On macOS, later negative process scans cannot safely prove a dead-root tree stopped because detached descendants may have been reparented. " +
          "Automatic revalidation releases the directory only when exact generation-scoped stopped evidence already exists or a later OS boot proves the old tree cannot still exist; otherwise the holder remains fail-closed. " +
          "A same-job continuation is not guaranteed to recover a dead-root case after that proof was lost."
        : "CrewDispatch automatically revalidates a finished task's retained tree (on daemon admission and during its periodic sweep) " +
          "and releases the directory once that tree is independently proven stopped; a live or unproven tree keeps holding it. " +
          "Continuing this finished task can resolve its own retained tree while enough ownership evidence remains.";
    return (
      `The working directory ${canonicalCwd} is held by finished task ${holder.jobId} ` +
      `(provider ${holder.provider}, runner ${holder.runner}, status ${holder.status}, run ${holder.generation}` +
      `${holder.ownerPid != null ? `, owner pid ${holder.ownerPid}` : ""}): its managed child process tree ` +
      `(PID ${holder.retainedChildPid}) could not be confirmed stopped, so the directory cannot be reused yet. ` +
      recoveryGuidance
    );
  }
  return (
    `The working directory ${canonicalCwd} is already in use by active task ${holder.jobId} ` +
    `(provider ${holder.provider}, runner ${holder.runner}, status ${holder.status}, run ${holder.generation}` +
    `${holder.ownerPid != null ? `, owner pid ${holder.ownerPid}` : ""}). ` +
    "CrewDispatch allows only one active task per working directory; wait for that task to finish or cancel it before dispatching another one."
  );
}

/** Exposed for tests: the current primary lock path for this workspace. */
export function workspaceLockFile(root: string, cwd: string): string {
  return workspaceLockPaths(root, resolveWorkspaceIdentity(cwd))[0]!;
}

/** Exposed for compatibility tests: the pre-MAC-14 canonical-path lock. */
export function legacyWorkspaceLockFile(root: string, cwd: string): string {
  const identity = resolveWorkspaceIdentity(cwd);
  return lockFileForKey(root, identity.legacyKey);
}