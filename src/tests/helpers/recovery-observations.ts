// recovery-observations.ts — TEST-ONLY scoped observation of the REAL recovery
// decisions and OS probes used by the in-process daemon.
//
// The workspace-busy-daemon recovery test failed once WITHOUT retaining the
// actual `recoverTerminalHolders` report or the actual enumeration/liveness
// results, so the refusal reason was lost. This helper wraps the CommonJS
// exports the daemon resolves at call time (`reconcile.js`, `process.js`) so the
// ACTUAL in-process values are recorded.
//
// Hard rules:
//   - each wrapper calls the ORIGINAL exactly once and returns its value /
//     rethrows its exception unchanged;
//   - the wrappers NEVER initiate recovery, a boot read, an enumeration or a
//     kill; they only observe a call the production code already made;
//   - stored observations are bounded; only the process entries relevant to the
//     recorded child are kept, never the whole process table;
//   - every wrapped export is restored in `restore()` (call it in `finally`).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;

export interface RecoveryObserverOptions {
  /** The retained child PID(s) whose process-table entries are relevant. */
  focusPids?: () => number[];
  /** Per-category bound on stored observations. */
  max?: number;
}

export interface RecoveryObservationSet {
  installedAt: string;
  restoredAt: string | null;
  dropped: number;
  recoverCalls: unknown[];
  enumerations: unknown[];
  liveness: unknown[];
  bootReads: unknown[];
  descendantScans: unknown[];
  wrappedExports: string[];
  notes: string[];
}

export interface RecoveryObserver {
  snapshot(): RecoveryObservationSet;
  restore(): void;
}

function msg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function at(): string {
  return new Date().toISOString();
}

function outcomeSummary(o: unknown): Record<string, unknown> {
  const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return { jobId: x.jobId ?? null, generation: x.generation ?? null, childPid: x.childPid ?? null, outcome: x.outcome ?? null, method: x.method ?? null, reason: x.reason ?? null };
}

function summarizeRecoveryReport(r: unknown): Record<string, unknown> {
  const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, 16).map(outcomeSummary) : []);
  return { candidates: typeof x.candidates === "number" ? x.candidates : null, released: list(x.released), blocked: list(x.blocked), skipped: list(x.skipped) };
}

/**
 * Install the observation wrappers. Returns an observer whose `restore()` MUST
 * be called in a `finally`. Re-installing over an already-wrapped export is a
 * no-op (idempotent).
 */
export function installRecoveryObservations(opts: RecoveryObserverOptions = {}): RecoveryObserver {
  const max = opts.max ?? 64;
  const focus = (): number[] => {
    try {
      const pids = opts.focusPids ? opts.focusPids() : [];
      return pids.filter((p) => Number.isInteger(p) && p > 0);
    } catch {
      return [];
    }
  };
  const set: RecoveryObservationSet = {
    installedAt: at(),
    restoredAt: null,
    dropped: 0,
    recoverCalls: [],
    enumerations: [],
    liveness: [],
    bootReads: [],
    descendantScans: [],
    wrappedExports: [],
    notes: [
      "Observations are of the ACTUAL in-process calls the production daemon made; no extra recovery/proof was initiated.",
      "Process observations retain only entries relevant to the focused child PID, never the whole process table."
    ]
  };
  const restorers: Array<() => void> = [];

  const push = (list: unknown[], entry: unknown): void => {
    list.push(entry);
    if (list.length > max) {
      list.shift();
      set.dropped += 1;
    }
  };

  const install = (mod: Record<string, unknown>, key: string, wrap: (original: AnyFn) => AnyFn): void => {
    const orig = mod[key];
    if (typeof orig !== "function") return;
    if ((orig as { __jobquayEvidenceWrapped?: boolean }).__jobquayEvidenceWrapped) return;
    const original = orig as AnyFn;
    const wrapped = wrap(original);
    (wrapped as { __jobquayEvidenceWrapped?: boolean }).__jobquayEvidenceWrapped = true;
    mod[key] = wrapped;
    restorers.push(() => {
      mod[key] = original;
    });
    set.wrappedExports.push(key);
  };

  // Resolved relative to THIS compiled helper, so it is the SAME module instance
  // the daemon's own require(".../jobs/reconcile") / require(".../runtime/process")
  // resolves to in this process.
  const reconcileModule = require("../../jobs/reconcile") as Record<string, unknown>;
  const processModule = require("../../runtime/process") as Record<string, unknown>;

  install(reconcileModule, "recoverTerminalHolders", (original) => {
    return async function wrappedRecover(this: unknown, ...args: unknown[]): Promise<unknown> {
      const t0 = Date.now();
      try {
        const r = await original.apply(this, args);
        push(set.recoverCalls, { ok: true, at: at(), ms: Date.now() - t0, report: summarizeRecoveryReport(r) });
        return r;
      } catch (e) {
        push(set.recoverCalls, { ok: false, at: at(), ms: Date.now() - t0, error: msg(e) });
        throw e;
      }
    };
  });

  install(processModule, "enumerateProcesses", (original) => {
    return async function wrappedEnumerate(this: unknown, ...args: unknown[]): Promise<unknown> {
      const t0 = Date.now();
      try {
        const r = await original.apply(this, args);
        const scan = (r && typeof r === "object" ? r : {}) as { ok?: unknown; reason?: unknown; processes?: unknown };
        const processes = Array.isArray(scan.processes) ? (scan.processes as Array<{ pid: number; ppid: number; createdAtMs: number | null }>) : [];
        const f = focus();
        const relevant = processes
          .filter((p) => f.includes(p.pid) || f.includes(p.ppid))
          .slice(0, 16)
          .map((p) => ({ pid: p.pid, ppid: p.ppid, createdAtMs: p.createdAtMs }));
        push(set.enumerations, {
          ok: scan.ok === true,
          reason: typeof scan.reason === "string" ? scan.reason : null,
          at: at(),
          ms: Date.now() - t0,
          count: processes.length,
          relevant
        });
        return r;
      } catch (e) {
        push(set.enumerations, { ok: false, reason: `threw: ${msg(e)}`, at: at(), ms: Date.now() - t0, count: null, relevant: [] });
        throw e;
      }
    };
  });

  install(processModule, "isPidAlive", (original) => {
    return function wrappedIsPidAlive(this: unknown, pid: number): unknown {
      const r = original.call(this, pid);
      if (focus().includes(pid)) push(set.liveness, { pid, alive: r ?? null, at: at() });
      return r;
    };
  });

  install(processModule, "readBootTime", (original) => {
    return async function wrappedReadBootTime(this: unknown, ...args: unknown[]): Promise<unknown> {
      const t0 = Date.now();
      try {
        const r = await original.apply(this, args);
        const b = (r && typeof r === "object" ? r : {}) as { ok?: unknown; bootTimeMs?: unknown; reason?: unknown };
        push(set.bootReads, { ok: b.ok === true, bootTimeMs: typeof b.bootTimeMs === "number" ? b.bootTimeMs : null, reason: typeof b.reason === "string" ? b.reason : null, at: at(), ms: Date.now() - t0 });
        return r;
      } catch (e) {
        push(set.bootReads, { ok: false, bootTimeMs: null, reason: `threw: ${msg(e)}`, at: at(), ms: Date.now() - t0 });
        throw e;
      }
    };
  });

  install(processModule, "findDescendants", (original) => {
    return function wrappedFindDescendants(this: unknown, processes: unknown, rootPid: number, sinceMs: number, ignoredPids?: unknown): unknown {
      const r = original.call(this, processes, rootPid, sinceMs, ignoredPids);
      const d = (r && typeof r === "object" ? r : {}) as { pids?: unknown; unknown?: unknown };
      push(set.descendantScans, {
        rootPid,
        sinceMs,
        pids: Array.isArray(d.pids) ? (d.pids as number[]).slice(0, 32) : [],
        unknown: d.unknown === true,
        at: at()
      });
      return r;
    };
  });

  return {
    snapshot(): RecoveryObservationSet {
      return JSON.parse(JSON.stringify(set)) as RecoveryObservationSet;
    },
    restore(): void {
      for (const restore of restorers.splice(0)) {
        try {
          restore();
        } catch {
          /* best effort */
        }
      }
      set.restoredAt = at();
    }
  };
}
