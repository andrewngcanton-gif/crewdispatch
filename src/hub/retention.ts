// retention.ts — CrewDispatch diagnostics cleanup (M1 batch 7A, Command Code only).
//
// WHAT MAY BE CLEANED
// ===================
// ONLY the per-job diagnostic files CrewDispatch itself wrote under its own data
// root's `logs/` directory for a job that has reached a TERMINAL state:
//   * `<root>/logs/<id>.ndjson`         — the CLI transcript (the live-flow log)
//   * `<root>/logs/<id>.worker.log`     — the worker's own diagnostic stream
// Policy is evaluated per job group, but files are unlinked individually. A
// partial unlink is reported honestly and its remaining exact file is retryable.
//
// WHAT IS NEVER TOUCHED (the contract)
// =====================================
//   * a RUNNING / queued / `orphaned` job's logs — only done / error / cancelled
//     groups are ever removable (the conservative set; `interrupted` is kept);
//   * the job METADATA (`<root>/jobs/<id>.json`) — kept PERMANENTLY;
//   * the official CLI's database / user profile / config — a different product
//     directory, never under CrewDispatch's root;
//   * the notification / tree-confirmation / terminal-snapshot files
//     (`<root>/notify`, `<root>/tree`, `<root>/terminal`) — never touched;
//   * the config / global-settings / message-history side-cars — never touched.
//
// HOW
// ===
// The policy is resolved from the CURRENT global settings on every call
// (see src/config/global.ts): `diag_retention_days` (age) and
// `diag_max_total_bytes` (total size). `0` means "no limit" for each. Eviction
// removes the OLDEST qualifying terminal group first and only as many as needed
// to get back under the total-size cap; an age-only trigger removes every group
// older than the limit. When nothing is safely removable, the limits are simply
// exceeded (no partial / recursive directory delete).
//
// Windows recursive delete is constrained by the auto-command policy; this
// module therefore deletes ONLY the verified, exact diagnostic files (never a
// directory, never a recursive `rmdir`), so it stays within what the policy
// permits and can never escape the product root.
//
// Every run updates a persistent CLEANUP AUDIT (`<root>/cleanup-audit.json`)
// with cumulative counts and a bounded run log, so an operator can see exactly
// how many groups / bytes were reclaimed and how many active jobs were protected.
import fs from "node:fs";
import path from "node:path";
import { acquireJobTransitionLock, assertInside, loadJob, logsDir } from "../jobs/store";
import { resolveRetentionPolicy, type RetentionPolicy } from "../config/global";

/** The ONLY terminal outcomes whose diagnostics may be reclaimed. */
export const DELETABLE_STATUSES: ReadonlySet<string> = new Set(["done", "error", "cancelled"]);

const NDJSON_SUFFIX = ".ndjson";
const WORKER_SUFFIX = ".worker.log";

interface DiagnosticFile {
  name: string;
  bytes: number;
}

interface Group {
  base: string;
  files: DiagnosticFile[];
  bytes: number;
  mtime: number;
}

export interface RetentionError {
  job_id: string;
  file: string;
  code: string;
}

export interface RetentionRunResult {
  /** Number of whole job groups removed in this run. */
  removedGroups: number;
  /** Number of diagnostic files removed. */
  removedFiles: number;
  /** Total bytes reclaimed. */
  removedBytes: number;
  /** Files whose unlink failed with an error other than ENOENT. */
  failedFiles: number;
  /** Groups where at least one file was removed and another unlink failed. */
  partialGroups: number;
  /** Bounded detail for unlink failures. */
  errors: RetentionError[];
  /** Terminal groups that were kept because a limit did not trigger for them. */
  keptTerminal: number;
  /** Non-removable groups encountered (active / non-terminal / unverifiable). */
  keptActive: number;
  /** The policy that was applied. */
  policy: RetentionPolicy;
}

export interface CleanupAudit {
  totals: { removedGroups: number; removedFiles: number; removedBytes: number; failedFiles: number; partialGroups: number };
  runs: Array<{
    at: string;
    removedGroups: number;
    removedFiles: number;
    removedBytes: number;
    failedFiles: number;
    partialGroups: number;
    errors: RetentionError[];
    keptActive: number;
    policy: RetentionPolicy;
  }>;
}

function auditPath(root: string): string {
  return path.join(root, "cleanup-audit.json");
}

function readAudit(root: string): CleanupAudit {
  try {
    const raw = JSON.parse(fs.readFileSync(auditPath(root), "utf8")) as Partial<CleanupAudit>;
    if (raw && typeof raw === "object" && raw.totals && Array.isArray(raw.runs)) {
      return {
        totals: {
          removedGroups: raw.totals.removedGroups ?? 0,
          removedFiles: raw.totals.removedFiles ?? 0,
          removedBytes: raw.totals.removedBytes ?? 0,
          failedFiles: raw.totals.failedFiles ?? 0,
          partialGroups: raw.totals.partialGroups ?? 0
        },
        runs: raw.runs.map((r) => ({
          ...r,
          failedFiles: r.failedFiles ?? 0,
          partialGroups: r.partialGroups ?? 0,
          errors: Array.isArray(r.errors) ? r.errors.slice(-50) : []
        }))
      };
    }
  } catch {
    /* missing or corrupt audit → start fresh */
  }
  return { totals: { removedGroups: 0, removedFiles: 0, removedBytes: 0, failedFiles: 0, partialGroups: 0 }, runs: [] };
}

function writeAudit(root: string, audit: CleanupAudit): void {
  // Keep only the most recent runs to bound the file.
  if (audit.runs.length > 50) audit.runs = audit.runs.slice(-50);
  try {
    const file = auditPath(root);
    assertInside(root, file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(audit, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort: the cleanup itself already happened */
  }
}

/** Group the `logs/` directory by job id; only our two diagnostic extensions. */
function groupLogs(root: string): Group[] {
  const dir = logsDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const groups = new Map<string, Group>();
  for (const n of names) {
    let base: string | null = null;
    if (n.endsWith(NDJSON_SUFFIX)) base = n.slice(0, -NDJSON_SUFFIX.length);
    else if (n.endsWith(WORKER_SUFFIX)) base = n.slice(0, -WORKER_SUFFIX.length);
    else continue; // not one of our diagnostic files
    const file = path.join(dir, n);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    let g = groups.get(base);
    if (!g) {
      g = { base, files: [], bytes: 0, mtime: 0 };
      groups.set(base, g);
    }
    g.files.push({ name: n, bytes: st.size });
    g.bytes += st.size;
    g.mtime = Math.max(g.mtime, st.mtimeMs);
  }
  return [...groups.values()];
}

/**
 * Enforce the diagnostics retention policy against CrewDispatch's own `logs/`
 * directory. Returns the run result and updates the persistent cleanup audit.
 *
 * Pure with respect to the job metadata and every other product directory: it
 * only ever `unlink`s exact diagnostic files it has verified belong to a
 * terminal job group.
 */
export function enforceRetention(
  root: string,
  opts: {
    now?: number;
    policy?: RetentionPolicy;
    /** Failure/interleaving seams used only by the focused retention tests. */
    unlinkFile?: (file: string) => void;
    beforeUnlink?: (jobId: string, file: string) => void;
  } = {}
): RetentionRunResult {
  const now = opts.now ?? Date.now();
  const policy = opts.policy ?? resolveRetentionPolicy(root);
  const result: RetentionRunResult = {
    removedGroups: 0,
    removedFiles: 0,
    removedBytes: 0,
    failedFiles: 0,
    partialGroups: 0,
    errors: [],
    keptTerminal: 0,
    keptActive: 0,
    policy
  };

  if (policy.maxAgeMs <= 0 && policy.maxBytes <= 0) {
    // Every limit is unlimited — nothing to do, but still record the run.
    recordAudit(root, result);
    return result;
  }

  const groups = groupLogs(root).sort((a, b) => a.mtime - b.mtime);
  let totalBytes = groups.reduce((s, g) => s + g.bytes, 0);

  for (const g of groups) {
    const overAge = policy.maxAgeMs > 0 && now - g.mtime > policy.maxAgeMs;
    const overBytes = policy.maxBytes > 0 && totalBytes > policy.maxBytes;
    if (!overAge && !overBytes) {
      result.keptTerminal += 1;
      continue;
    }

    // Share an inter-process guard with terminal-to-running follow-ups. This
    // closes the terminal-status-check → unlink race without relying on an
    // in-memory mutex that another MCP process could bypass.
    const release = acquireJobTransitionLock(root, g.base);
    if (!release) {
      result.keptActive += 1;
      continue;
    }
    try {
      let job;
      try {
        job = loadJob(root, g.base);
      } catch {
        job = null;
      }
      if (!job || !DELETABLE_STATUSES.has(job.status)) {
        result.keptActive += 1;
        continue;
      }
      const expectedGeneration = job.generation;
      const expectedStatus = job.status;
      let removedFromGroup = 0;
      let failedInGroup = 0;
      let removedBytesFromGroup = 0;
      let stateChanged = false;

      for (const item of g.files) {
        opts.beforeUnlink?.(g.base, item.name);
        let current;
        try {
          current = loadJob(root, g.base);
        } catch {
          current = null;
        }
        if (!current || current.generation !== expectedGeneration || current.status !== expectedStatus || !DELETABLE_STATUSES.has(current.status)) {
          result.keptActive += 1;
          stateChanged = true;
          break;
        }

        const file = path.join(logsDir(root), item.name);
        try {
          assertInside(root, file);
          (opts.unlinkFile ?? fs.unlinkSync)(file);
          removedFromGroup += 1;
          result.removedFiles += 1;
          result.removedBytes += item.bytes;
          removedBytesFromGroup += item.bytes;
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          failedInGroup += 1;
          result.failedFiles += 1;
          if (result.errors.length < 50) {
            result.errors.push({
              job_id: g.base,
              file: item.name,
              code: (e as NodeJS.ErrnoException)?.code ?? "unlink_failed"
            });
          }
        }
      }

      if (removedFromGroup === g.files.length && failedInGroup === 0 && !stateChanged) {
        result.removedGroups += 1;
      } else if (removedFromGroup > 0 && failedInGroup > 0) {
        result.partialGroups += 1;
      }
      totalBytes -= removedBytesFromGroup;
    } finally {
      release();
    }
  }

  recordAudit(root, result);
  return result;
}

function recordAudit(root: string, result: RetentionRunResult): void {
  try {
    const audit = readAudit(root);
    audit.totals.removedGroups += result.removedGroups;
    audit.totals.removedFiles += result.removedFiles;
    audit.totals.removedBytes += result.removedBytes;
    audit.totals.failedFiles += result.failedFiles;
    audit.totals.partialGroups += result.partialGroups;
    audit.runs.push({
      at: new Date().toISOString(),
      removedGroups: result.removedGroups,
      removedFiles: result.removedFiles,
      removedBytes: result.removedBytes,
      failedFiles: result.failedFiles,
      partialGroups: result.partialGroups,
      errors: result.errors,
      keptActive: result.keptActive,
      policy: result.policy
    });
    writeAudit(root, audit);
  } catch {
    /* best-effort */
  }
}

/** Read the persistent cleanup audit (never throws). */
export function readCleanupAudit(root: string): CleanupAudit {
  return readAudit(root);
}
