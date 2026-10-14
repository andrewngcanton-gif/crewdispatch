// lifecycle.ts — bounded, best-effort cleanup of Claude caller bindings whose
// stable owner process has PROVABLY exited.
//
// Why this exists: on a tested Claude Desktop host, a real SessionEnd
// hook entered, read its input and completed, but BOTH
// `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` were absent.
// The exact-incarnation SessionEnd cleanup (binding.ts
// `removeClaudeBindingForIncarnation`) therefore correctly did nothing and the
// binding stayed behind. This module adds an ADDITIVE, local fallback that does
// NOT weaken that guard:
//
//   * at a real SessionStart the async CLI path captures ONE best-effort,
//     VERIFIED caller-owner lifetime identity — an actual OS ancestor process
//     (the stable native Claude host), resolved from a single coherent OS
//     process snapshot with a positive creation instant and a coherent
//     ancestry/order. A missing/failed/permission-denied/unsupported scan yields
//     no owner and changes nothing.
//   * the owner metadata is stored in the SAME private binding record.
//   * the daemon's existing shared notification-maintenance cycle (one generic
//     call, no new service/timer) asks this module to remove ONLY a binding whose
//     recorded owner incarnation is PROVEN gone: its pid is absent from a
//     successful, complete OS snapshot, or the same pid now has a positively
//     different creation instant (pid reuse). An unknown/absent scan, an alive
//     owner, a missing owner, or a concurrent newer registration always
//     preserves the binding.
//
// Hard rules (mirroring the packet): never delete by TTL, age, session id alone,
// socket reuse, a process NAME, a guessed pid, a missing export, a timeout or a
// failed inbox connection; never kill or wait for the owner; at most one OS scan
// per non-empty maintenance pass; and re-verify the exact binding id +
// session/address/token + owner metadata immediately before unlinking.
import {
  enumerateProcesses,
  type ProcessEntry,
  type ProcessScan
} from "../runtime/process";
import type {
  NotificationMaintenanceAdapter,
  NotificationMaintenanceResult
} from "../jobs/notifications";
import {
  isValidClaudeOwnerRef,
  listClaudeBindings,
  removeClaudeBindingForOwnerExit,
  type ClaudeOwnerRef
} from "./binding";

/** Small finite budget for the best-effort owner capture at SessionStart. */
export const OWNER_CAPTURE_BUDGET_MS = 2000;
/** Capture-proof schema version recorded in every owner ref. */
export const OWNER_PROOF_VERSION = 1;
/** Windows CIM clock tolerance when comparing recorded/live owner birth. */
export const OWNER_BIRTH_TOLERANCE_MS = 2000;
/** Bound on how many owner-bearing bindings one maintenance pass inspects. */
export const MAX_MAINTENANCE_CANDIDATES = 32;
/** Bound on how many bindings one maintenance pass may remove. */
export const MAX_MAINTENANCE_REMOVALS = 8;
/** The shared-registry key of this maintenance adapter. */
export const CLAUDE_BINDING_MAINTENANCE_KIND = "claude_session_binding";

/** Stable native Claude host basename on Windows/macOS; name is only an ancestry hint. */
const OWNER_IMAGE_RE = /^claude(\.exe)?$/i;

/** Injectable process enumeration seam (tests). */
export type EnumerateFn = (opts?: { timeoutMs?: number }) => Promise<ProcessScan>;

function defaultEnumerate(opts?: { timeoutMs?: number }): Promise<ProcessScan> {
  return enumerateProcesses(opts ?? {});
}

export interface CaptureOwnerOptions {
  /** Platform to capture on (defaults to process.platform; win32 + Darwin arm64). */
  platform?: NodeJS.Platform;
  /** Architecture override for deterministic platform tests. */
  arch?: string;
  /** The process whose ancestors are walked (defaults to this process). */
  pid?: number;
  /** Injected enumeration seam (tests). */
  enumerateFn?: EnumerateFn;
  /** Finite budget for the enumeration (defaults to OWNER_CAPTURE_BUDGET_MS). */
  budgetMs?: number;
}

/**
 * PURE ancestry resolution over one process snapshot: walk the contiguous PPID
 * chain above `startPid` and return the HIGHEST native Claude ancestor as the
 * stable owner, or null when there is no usable evidence.
 *
 * Requirements for a usable owner:
 *   * the start process and every ancestor on the chain report a creation time
 *     (a missing birth is UNKNOWN, never guessed);
 *   * the chain is coherent in time — a parent may not be born after its child
 *     (ambiguous clock/order evidence conservatively disables capture);
 *   * at least one ancestor's image name is a native Claude host (`claude` /
 *     `claude.exe`); the highest such ancestor wins, because the lower Claude
 *     children and the shell/Node hook children are transient.
 *
 * The image name is only an ancestry HINT; liveness is decided later from pid +
 * creation time, never from the name.
 */
export function findOwnerAncestor(
  processes: readonly ProcessEntry[],
  startPid: number,
  platform: string
): ClaudeOwnerRef | null {
  const byPid = new Map<number, ProcessEntry>();
  for (const p of processes) byPid.set(p.pid, p);
  const start = byPid.get(startPid);
  if (!start || start.createdAtMs == null) return null;

  const chain: ProcessEntry[] = [];
  const seen = new Set<number>([startPid]);
  let cur = start;
  for (;;) {
    const parent = cur.ppid > 0 ? byPid.get(cur.ppid) : undefined;
    if (!parent) break;
    if (seen.has(parent.pid)) return null; // Cyclic ancestry is not ownership proof.
    seen.add(parent.pid);
    chain.push(parent);
    cur = parent;
  }

  // Coherent order: every parent must be born no later than its child.
  // Darwin has exact microseconds, so do not throw that precision away.
  const exactDarwin = platform === "darwin";
  if (exactDarwin && start.createdAtUs == null) return null;
  let childAt = start.createdAtMs;
  let childAtUs = start.createdAtUs ?? null;
  for (const anc of chain) {
    if (anc.createdAtMs == null) return null;
    if (exactDarwin) {
      if (anc.createdAtUs == null || childAtUs == null) return null;
      if (anc.createdAtUs > childAtUs) return null; // Reused parent PID is not this child's ancestor.
      childAtUs = anc.createdAtUs;
    } else if (anc.createdAtMs > childAt) {
      return null;
    }
    childAt = anc.createdAtMs;
  }

  let owner: ProcessEntry | null = null;
  for (const anc of chain) {
    if (anc.imageName && OWNER_IMAGE_RE.test(anc.imageName)) owner = anc;
  }
  if (!owner || owner.createdAtMs == null || !owner.imageName) return null;
  if (exactDarwin && owner.createdAtUs == null) return null;
  return {
    platform,
    pid: owner.pid,
    createdAtMs: owner.createdAtMs,
    ...(owner.createdAtUs != null ? { createdAtUs: owner.createdAtUs } : {}),
    imageName: owner.imageName,
    proof: OWNER_PROOF_VERSION
  };
}

/**
 * Best-effort capture of the stable caller owner from a real process snapshot.
 * Returns null on any unsupported platform/architecture, failed/unknown scan, ambiguous
 * ancestry or missing birth evidence. It NEVER throws and NEVER blocks beyond
 * the finite budget, so it can never fail or stall a session.
 */
export async function captureCallerOwner(opts: CaptureOwnerOptions = {}): Promise<ClaudeOwnerRef | null> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform !== "win32" && !(platform === "darwin" && (arch === "arm64" || arch === "x64"))) return null;
  const pid = opts.pid ?? process.pid;
  const enumerateFn = opts.enumerateFn ?? defaultEnumerate;
  const budgetMs = opts.budgetMs ?? OWNER_CAPTURE_BUDGET_MS;
  let scan: ProcessScan;
  try {
    scan = await enumerateFn({ timeoutMs: budgetMs });
  } catch {
    return null;
  }
  if (!scan.ok) return null;
  try {
    return findOwnerAncestor(scan.processes, pid, platform);
  } catch {
    return null;
  }
}

export interface MaintainOptions {
  platform?: NodeJS.Platform;
  /** Injected enumeration seam (tests). */
  enumerateFn?: EnumerateFn;
  /** Finite budget for the one OS scan (defaults to 15000ms). */
  timeoutMs?: number;
}

/**
 * One bounded maintenance pass over the private Claude binding store.
 *
 * If no binding carries owner evidence, NO OS scan is performed (the pass is
 * empty). Otherwise exactly ONE OS scan is taken and each owner-bearing binding
 * is classified against it. A binding is removed ONLY when its recorded owner
 * incarnation is proven gone, and the removal re-verifies the exact binding on a
 * fresh read. Unknown scans and alive owners preserve everything.
 */
export async function maintainClaudeCallerBindings(
  root: string,
  opts: MaintainOptions = {}
): Promise<NotificationMaintenanceResult> {
  const platform = opts.platform ?? process.platform;
  const candidates = listClaudeBindings(root).filter((b) => isValidClaudeOwnerRef(b.owner));
  if (candidates.length === 0) {
    return { kind: CLAUDE_BINDING_MAINTENANCE_KIND, scanned: false, checked: 0, removed: 0, reason: null };
  }
  if (platform !== "win32" && platform !== "darwin") {
    return { kind: CLAUDE_BINDING_MAINTENANCE_KIND, scanned: false, checked: candidates.length, removed: 0, reason: "unsupported_platform" };
  }
  const enumerateFn = opts.enumerateFn ?? defaultEnumerate;
  let scan: ProcessScan;
  try {
    scan = await enumerateFn({ timeoutMs: opts.timeoutMs ?? 15000 });
  } catch (e) {
    return {
      kind: CLAUDE_BINDING_MAINTENANCE_KIND,
      scanned: false,
      checked: candidates.length,
      removed: 0,
      reason: `scan_failed:${String((e as Error)?.message || e).slice(0, 120)}`
    };
  }
  if (!scan.ok) {
    return { kind: CLAUDE_BINDING_MAINTENANCE_KIND, scanned: false, checked: candidates.length, removed: 0, reason: `scan_unknown:${scan.reason ?? "unknown"}` };
  }

  const byPid = new Map<number, ProcessEntry>();
  for (const p of scan.processes) byPid.set(p.pid, p);

  let checked = 0;
  let removed = 0;
  for (const binding of candidates.slice(0, MAX_MAINTENANCE_CANDIDATES)) {
    checked += 1;
    if (removed >= MAX_MAINTENANCE_REMOVALS) break;
    const owner = binding.owner as ClaudeOwnerRef;
    // A binding copied from another OS is not evidence about a process on this OS.
    if (owner.platform !== platform) continue;
    const live = byPid.get(owner.pid);
    let exited: boolean;
    if (!live) {
      // PID absent from a successful, complete snapshot → the owner is gone.
      exited = true;
    } else if (platform === "darwin") {
      // Darwin owner cleanup requires exact microsecond birth on BOTH sides.
      // Legacy/incomplete Darwin evidence is UNKNOWN and must be preserved.
      if (owner.createdAtUs == null || live.createdAtUs == null) exited = false;
      else exited = live.createdAtUs !== owner.createdAtUs;
    } else if (live.createdAtMs == null) {
      // A live pid whose birth is unreported is UNKNOWN → preserve.
      exited = false;
    } else {
      // Windows CIM birth has lower precision; retain the existing tolerance.
      exited = Math.abs(live.createdAtMs - owner.createdAtMs) > OWNER_BIRTH_TOLERANCE_MS;
    }
    if (!exited) continue;
    const ok = removeClaudeBindingForOwnerExit(root, binding.bindingId, {
      sessionId: binding.sessionId,
      socket: binding.socket,
      token: binding.token,
      owner
    });
    if (ok) removed += 1;
  }
  return { kind: CLAUDE_BINDING_MAINTENANCE_KIND, scanned: true, checked, removed, reason: null };
}

/**
 * The adapter registered into the shared notification-maintenance registry
 * (beside the Claude notification transport). The generic orchestration lives in
 * jobs/notifications.ts; the Claude ancestry/binding decision lives here.
 */
export const claudeCallerBindingMaintenance: NotificationMaintenanceAdapter = {
  kind: CLAUDE_BINDING_MAINTENANCE_KIND,
  async maintain(root: string): Promise<NotificationMaintenanceResult> {
    return await maintainClaudeCallerBindings(root);
  }
};
