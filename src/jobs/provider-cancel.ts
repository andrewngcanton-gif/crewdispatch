// provider-cancel.ts — the GENERIC lifecycle half of provider-owned turn
// cancellation (JQ-20261006-58).
//
// WHY THIS EXISTS
//
// Some providers run a turn OUTSIDE the process tree CrewDispatch spawned. The
// disposable tree kill stops CrewDispatch's own child (and its OS-tracked tree)
// but never reaches that work, so a cancel that only kills the tree can report
// `cancelled` while the provider's tool keeps running.
//
// OWNERSHIP (kept deliberately split):
//   * the PROVIDER owns its protocol — see `ProviderAdapter.cancelTurn` and
//     `src/providers/workbuddy-ai/turn-cancel.ts`: it cancels the EXACT
//     session/turn and names the provider-owned process roots that host it;
//   * THIS module owns the lifecycle: when to ask, what must be proven before
//     CrewDispatch may claim `cancelled`, and what to retain when it cannot be
//     proven. It contains no provider protocol and never signals a process it
//     cannot attribute.
//
// SAFETY RULES (all enforced here, never downstream):
//   * the provider-owned roots are ONLY ever observed; this module kills
//     nothing at all. Cleanup is the provider's cancellation plus the ordinary,
//     already-scoped managed-tree kill;
//   * a shared execution slot is never touched while another live CrewDispatch
//     job occupies the same slot (`exclusive`);
//   * when the owned cleanup cannot be proven, the answer is `unresolved` with
//     evidence — never a claimed cancellation.
//
// Every wait here is bounded and only ever runs on the cancellation path. This
// module adds NO deadline to a running turn.
import { listJobs } from "./store";
import { attemptStartedAtMs } from "./reconcile";
import { isTerminalStatus, type JobRecord } from "./types";
import { providerManagedIgnoredPids } from "./provider-managed";
import {
  DESCENDANT_CLOCK_TOLERANCE_MS,
  enumerateProcesses,
  findDescendants,
  isPidAlive,
  type EnumerateProcesses
} from "../runtime/process";
import type {
  ProviderAdapter,
  ProviderCancelDeps,
  ProviderTurnCancelInput,
  ProviderTurnCancelResult
} from "../providers/provider";
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { COMMAND_CODE_PROVIDER } from "./runner";
import { createWorkBuddyAiAdapter, WORKBUDDY_AI_PROVIDER, workBuddyAiProfileEnv } from "../providers/workbuddy-ai/index";
import { loadConfigResult } from "../config/schema";
import { loadWorkBuddyAiConfigResult, workBuddyAiRuntimeConfig } from "../config/workbuddy-ai";

/**
 * What CrewDispatch proved about one provider-owned turn cancellation.
 *
 * `requested` is the intermediate state of the request phase: the EXACT
 * cancellation was delivered and the owned cleanup has not been resolved yet.
 * Only a resolved state may back a claimed `cancelled`.
 */
export type ProviderCancelState =
  | "not_owned"
  | "no_route"
  | "requested"
  | "owned_tool_stopped"
  | "no_owned_work"
  | "unresolved";

/** Bounded, durable evidence of one provider-owned cancellation attempt. */
export interface ProviderCancelEvidence {
  provider: string;
  /** Stable route token, or null when the provider has no such route. */
  route: string | null;
  state: ProviderCancelState;
  /** True only when the EXACT session/turn cancellation was delivered. */
  requested: boolean;
  /** The exact provider session the cancellation targeted, when known. */
  sessionId: string | null;
  /** Provider-owned PIDs that were still alive when cleanup could not be proven. */
  survivingPids: number[];
  /** Stable diagnostic code, or null. */
  detail: string | null;
}

/** The request phase plus everything the resolution phase needs. */
export interface ProviderCancelRequest extends ProviderCancelEvidence {
  /** Provider-owned process roots that host this turn's work (never the daemon). */
  ownedRoots: number[];
  /**
   * True when the provider DELIVERED the exact cancellation but could not prove
   * which provider-owned process root hosts the turn (for example a matched
   * runtime that published no usable PID). An empty `ownedRoots` then means
   * UNKNOWN attribution — NEVER "no owned work" — so the resolver must not
   * report `no_owned_work`/allow `cancelled`.
   */
  ownershipUnknown: boolean;
  /** True only when no OTHER live CrewDispatch job shares this provider slot. */
  exclusive: boolean;
  /** Epoch ms scoping owned processes (this generation's attempt start). */
  sinceMs: number | null;
}

export interface ProviderCancelOptions {
  env?: NodeJS.ProcessEnv;
  /** Provider adapter override (tests). */
  adapter?: ProviderAdapter | null;
  /** Provider cancellation override (tests). */
  cancelTurnFn?: (input: ProviderTurnCancelInput, deps: ProviderCancelDeps) => Promise<ProviderTurnCancelResult>;
  /** Slot-key override (tests). */
  turnSlotKeyFn?: (input: Parameters<NonNullable<ProviderAdapter["turnSlotKey"]>>[0]) => string | null;
  /** Active records considered for slot exclusivity (defaults to the data root). */
  listJobsFn?: () => JobRecord[];
  /** Injected provider config dir / tmp root (tests). */
  configDir?: string;
  tmpDir?: string;
  /** Transport injected straight into the provider route (tests). */
  transport?: unknown;
  /** Bounded override of the provider control-channel acknowledgment wait (tests). */
  cancelAckWaitMs?: number;
}

/** Bounded resolution options for the owned-tool cleanup. */
export interface OwnedToolResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the owned work to stop. Default 8000. */
  waitMs?: number;
  /** Poll interval. Default 150. */
  pollMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  enumerateFn?: EnumerateProcesses;
  delayFn?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_MS = 8_000;
const DEFAULT_POLL_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The provider adapter that owns a provider id, or null when unsupported. */
export function adapterFor(provider: string): ProviderAdapter | null {
  if (provider === WORKBUDDY_AI_PROVIDER) return createWorkBuddyAiAdapter();
  if (provider === COMMAND_CODE_PROVIDER) return createCommandCodeAdapter();
  return null;
}

/**
 * The CLI path this provider would run for a job: the provider's OWN discovery
 * rules over the configured override CrewDispatch already persists. Used only to
 * name the execution slot a turn occupies — never to launch anything.
 */
function resolveProviderCliPath(provider: string, root: string, env: NodeJS.ProcessEnv): string | null {
  const adapter = adapterFor(provider);
  if (!adapter) return null;
  if (provider === WORKBUDDY_AI_PROVIDER) {
    const wb = loadWorkBuddyAiConfigResult(root);
    const configured = wb.ok ? workBuddyAiRuntimeConfig(wb.config).cliPath : null;
    return adapter.resolveCli({ env: workBuddyAiProfileEnv(env), configPath: configured ?? undefined }).path;
  }
  const loaded = loadConfigResult(root);
  const configured = loaded.ok ? loaded.config.cliPath : null;
  return adapter.resolveCli({ env, configPath: configured ?? undefined }).path;
}

/**
 * True only when no OTHER live CrewDispatch job occupies the same provider slot.
 *
 * Two jobs that share a slot share provider-owned processes, so stopping
 * anything in that slot could kill another job's work. Sharing is decided by the
 * provider's own slot key, never by a path/exe/hash invented here.
 */
function slotIsExclusive(
  slotKey: string | null,
  job: JobRecord,
  root: string,
  env: NodeJS.ProcessEnv,
  turnSlotKeyFn: NonNullable<ProviderAdapter["turnSlotKey"]>,
  listJobsFn: () => JobRecord[]
): boolean {
  if (!slotKey) return false;
  for (const other of listJobsFn()) {
    if (other.id === job.id || other.provider !== job.provider) continue;
    if (isTerminalStatus(other.status)) continue;
    const otherCli = resolveProviderCliPath(other.provider, root, env);
    const otherKey = turnSlotKeyFn({
      jobId: other.id, generation: other.childGeneration ?? other.generation, dataRoot: root,
      cliPath: otherCli,
      permissionMode: other.permissionMode,
      effort: other.effort,
      cwd: other.cwd,
      env,
      platform: process.platform
    });
    if (otherKey && otherKey === slotKey) return false;
  }
  return true;
}

function evidence(
  provider: string,
  state: ProviderCancelState,
  result: Pick<ProviderTurnCancelResult, "route" | "requested" | "sessionId" | "detail">,
  survivingPids: number[] = []
): ProviderCancelEvidence {
  return {
    provider,
    route: result.route,
    state,
    requested: result.requested,
    sessionId: result.sessionId,
    survivingPids,
    detail: result.detail ?? null
  };
}

/** Build one request-phase record, defaulting the resolution-phase fields. */
function requestOf(
  provider: string,
  state: ProviderCancelState,
  result: Pick<ProviderTurnCancelResult, "route" | "requested" | "sessionId" | "detail">,
  extra: { ownedRoots?: number[]; ownershipUnknown?: boolean; exclusive?: boolean; sinceMs?: number | null } = {}
): ProviderCancelRequest {
  return {
    ...evidence(provider, state, result),
    ownedRoots: extra.ownedRoots ?? [],
    ownershipUnknown: extra.ownershipUnknown ?? false,
    exclusive: extra.exclusive ?? false,
    sinceMs: extra.sinceMs ?? null
  };
}

/**
 * Ask the provider to cancel the EXACT session/turn this job owns.
 *
 * Cheap and bounded: one control handshake. It does not wait for the provider's
 * work to stop (`resolveProviderOwnedTool` does that, on the finalisation path).
 */
export async function requestProviderTurnCancel(
  root: string,
  job: JobRecord,
  opts: ProviderCancelOptions = {}
): Promise<ProviderCancelRequest> {
  const env = opts.env ?? process.env;
  // `null`/`undefined` both mean "no override": the provider's own adapter is
  // used. (The job service projects an absent seam to `null`, so treating only
  // `undefined` as "default" silently disabled the whole provider route.)
  const adapter = opts.adapter ?? adapterFor(job.provider);
  const cancelTurn = opts.cancelTurnFn ?? adapter?.cancelTurn;
  const turnSlotKey = opts.turnSlotKeyFn ?? adapter?.turnSlotKey;
  if (!adapter || !cancelTurn) {
    // KNOWN no route (the provider runs everything inside the spawned tree), so
    // the ordinary tree kill is the whole cancellation story.
    return requestOf(job.provider, "not_owned", { route: null, requested: false, sessionId: null, detail: "no_provider_route" });
  }
  const sessionId = typeof job.sessionId === "string" && job.sessionId.trim() ? job.sessionId.trim() : null;
  if (!sessionId) {
    // KNOWN no route: no provider turn was ever established (a queued/
    // never-spawned job), so the provider owns nothing to cancel.
    return requestOf(job.provider, "not_owned", { route: null, requested: false, sessionId: null, detail: "no_provider_session" });
  }
  // Everything below can fail for reasons that are NOT proof of "no provider
  // work" (config/discovery reads, slot enumeration, the provider handshake).
  // Any such failure is reported `no_route`/`unresolved` so a caller can never
  // read it as `not_owned` and cancel without evidence.
  try {
    const generation = job.childGeneration ?? job.generation;
    const input: ProviderTurnCancelInput = {
      provider: job.provider,
      jobId: job.id,
      generation,
      sessionId,
      cwd: job.cwd,
      model: job.model,
      permissionMode: job.permissionMode,
      effort: job.effort,
      cliPath: resolveProviderCliPath(job.provider, root, env),
      // The exact disposable child of this generation, when the record still
      // retains it: a provider that relays its cancel through the live child
      // binds the handshake to this incarnation.
      childPid: typeof job.childPid === "number" && Number.isInteger(job.childPid) && job.childPid > 0 ? job.childPid : null,
      attemptStartedAtMs: attemptStartedAtMs(job, generation),
      dataRoot: root
    };
    const listJobsFn = opts.listJobsFn ?? (() => listJobs(root).jobs);
    // Decide slot exclusivity BEFORE any provider action. A slot shared with
    // another LIVE CrewDispatch job hosts that job's work too, so it must not be
    // touched at all — not even a scoped session cancel (the runtime could abort
    // other work on the same slot). This stays a bounded, read-only observation.
    if (turnSlotKey) {
      const preSlotKey = turnSlotKey({
        jobId: input.jobId, generation: input.generation, dataRoot: root,
        cliPath: input.cliPath,
        permissionMode: input.permissionMode,
        effort: input.effort,
        cwd: input.cwd,
        env,
        platform: process.platform
      });
      if (preSlotKey && !slotIsExclusive(preSlotKey, job, root, env, turnSlotKey, listJobsFn)) {
        return requestOf(job.provider, "unresolved", { route: null, requested: false, sessionId, detail: "shared_slot" }, { sinceMs: input.attemptStartedAtMs });
      }
    }
    let result: ProviderTurnCancelResult;
    try {
      result = await cancelTurn(input, {
        env,
        configDir: opts.configDir,
        tmpDir: opts.tmpDir,
        transport: opts.transport,
        cancelAckWaitMs: opts.cancelAckWaitMs
      });
    } catch {
      result = { route: null, requested: false, sessionId, ownedRoots: [], slotKey: null, detail: "provider_cancel_failed" };
    }
    if (!result.requested) {
      // The provider owns the turn but the exact route could not be reached.
      // `no_route` never permits a claimed cancellation.
      return requestOf(job.provider, "no_route", result, { ownershipUnknown: true, sinceMs: input.attemptStartedAtMs });
    }
    // A provider with no shared-slot concept owns its whole turn: treat it as
    // exclusive so the resolver never fabricates a `shared_slot` verdict. (Here
    // this is reached only after the pre-check above already proved exclusivity.)
    const exclusive = turnSlotKey ? slotIsExclusive(result.slotKey, job, root, env, turnSlotKey, listJobsFn) : true;
    return requestOf(job.provider, "requested", result, {
      ownedRoots: result.ownedRoots.filter((pid) => Number.isInteger(pid) && pid > 0),
      ownershipUnknown: result.ownershipUnknown === true,
      exclusive,
      sinceMs: input.attemptStartedAtMs
    });
  } catch {
    // An UNKNOWN failure (never proof of no provider work): `no_route` so the
    // resolver retains unresolved evidence instead of allowing `cancelled`.
    return requestOf(
      job.provider,
      "no_route",
      { route: null, requested: false, sessionId, detail: "provider_cancel_failed" },
      { ownershipUnknown: true }
    );
  }
}

/** Live descendants of the provider-owned roots, scoped to this generation. */
async function scopedOwnedPids(
  roots: readonly number[],
  sinceMs: number,
  job: JobRecord,
  env: NodeJS.ProcessEnv,
  opts: OwnedToolResolveOptions
): Promise<{ pids: number[]; unknown: boolean }> {
  const enumerateFn = opts.enumerateFn ?? enumerateProcesses;
  const alive = opts.isAliveFn ?? isPidAlive;
  const scan = await enumerateFn();
  if (!scan.ok) return { pids: [], unknown: true };
  const ignored = providerManagedIgnoredPids(job, env);
  const pids: number[] = [];
  let unknown = false;
  for (const root of roots) {
    const found = findDescendants(scan.processes, root, sinceMs - DESCENDANT_CLOCK_TOLERANCE_MS, ignored);
    if (found.unknown) unknown = true;
    for (const pid of found.pids) {
      if (alive(pid) !== false) pids.push(pid);
    }
  }
  return { pids: [...new Set(pids)], unknown };
}

/**
 * Resolve whether the provider-owned work this job's turn started has stopped.
 *
 * It never signals anything: the stop is the provider's own cancellation (plus
 * the managed tree kill). This only OBSERVES the provider-owned roots, scoped to
 * this generation, and reports exactly what it saw:
 *   * a scoped process was seen alive and is now gone        -> `owned_tool_stopped`
 *   * nothing scoped was ever visible                        -> `no_owned_work`
 *     (a bounded negative snapshot, never a whole-tree guarantee)
 *   * a scoped process is still alive, or the scan is unknown, or the slot is
 *     shared with another live job                           -> `unresolved`
 */
export async function resolveProviderOwnedTool(
  request: ProviderCancelRequest,
  job: JobRecord,
  opts: OwnedToolResolveOptions = {}
): Promise<ProviderCancelEvidence> {
  if (request.state !== "requested") return evidence(request.provider, request.state, request, request.survivingPids);
  if (request.ownedRoots.length === 0) {
    if (request.ownershipUnknown) {
      // The cancellation was delivered but the provider could not name the
      // process root that hosts the turn: an empty root list is UNKNOWN
      // attribution, never "no owned work".
      return evidence(request.provider, "unresolved", { ...request, detail: request.detail ?? "ownership_unattributed" }, request.survivingPids);
    }
    return evidence(request.provider, "no_owned_work", { ...request, detail: request.detail ?? "no_owned_root" });
  }
  if (!request.exclusive) {
    // Another live CrewDispatch job shares this provider slot: the owned roots
    // host its work too, so nothing here may be attributed or stopped.
    return evidence(request.provider, "unresolved", { ...request, detail: "shared_slot" }, request.ownedRoots);
  }
  if (request.sinceMs == null) {
    return evidence(request.provider, "unresolved", { ...request, detail: "no_attempt_start" }, request.ownedRoots);
  }
  const env = opts.env ?? process.env;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sleep = opts.delayFn ?? delay;
  const deadline = Date.now() + Math.max(waitMs, 0);
  let observed = false;
  for (;;) {
    const seen = await scopedOwnedPids(request.ownedRoots, request.sinceMs, job, env, opts);
    if (seen.unknown) {
      return evidence(request.provider, "unresolved", { ...request, detail: "owned_scan_unknown" }, request.ownedRoots);
    }
    if (seen.pids.length === 0) {
      if (observed) {
        // A process scoped to THIS generation was alive and is now gone — the
        // strongest process-level evidence this product can honestly claim.
        return evidence(request.provider, "owned_tool_stopped", request);
      }
      // Nothing was visible yet. Re-check once so a tool that is about to spawn
      // (or a just-exited one) is not mistaken for "there was no work".
      if (Date.now() >= deadline) {
        return evidence(request.provider, "no_owned_work", { ...request, detail: request.detail ?? null });
      }
      await sleep(pollMs);
      const again = await scopedOwnedPids(request.ownedRoots, request.sinceMs, job, env, opts);
      if (again.unknown) {
        return evidence(request.provider, "unresolved", { ...request, detail: "owned_scan_unknown" }, request.ownedRoots);
      }
      if (again.pids.length === 0) {
        return evidence(request.provider, "no_owned_work", { ...request, detail: request.detail ?? null });
      }
      observed = true;
      continue;
    }
    observed = true;
    if (Date.now() >= deadline) {
      return evidence(request.provider, "unresolved", { ...request, detail: "owned_tool_alive" }, seen.pids);
    }
    await sleep(pollMs);
  }
}

/** True when a resolved state may back a claimed `cancelled`. */
export function providerCancelAllowsCancellation(evidenceValue: ProviderCancelEvidence): boolean {
  return evidenceValue.state === "not_owned" || evidenceValue.state === "owned_tool_stopped" || evidenceValue.state === "no_owned_work";
}
