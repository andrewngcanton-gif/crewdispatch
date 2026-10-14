// provider-turn.ts — the GENERIC rule "does this job own a provider turn that
// runs OUTSIDE the spawned tree, and is that turn's cleanup resolved for the
// CURRENT generation?" (JQ-20261006-58).
//
// It exists so the reconciliation boundary (`reconcile.ts`) and the cancel path
// can agree on ONE provider-neutral predicate without either importing provider
// protocol: capability comes only from the shared `ProviderAdapter` contract
// (`cancelTurn`), and the proof comes only from the durable, generation-scoped
// `cancelCleanup` evidence. No WorkBuddy-specific field or token appears here.
import type { ProviderAdapter } from "../providers/provider";
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { createWorkBuddyAiAdapter, WORKBUDDY_AI_PROVIDER } from "../providers/workbuddy-ai/index";
import { COMMAND_CODE_PROVIDER } from "./runner";
import type { JobRecord } from "./types";

function adapterFor(provider: string): ProviderAdapter | null {
  if (provider === WORKBUDDY_AI_PROVIDER) return createWorkBuddyAiAdapter();
  if (provider === COMMAND_CODE_PROVIDER) return createCommandCodeAdapter();
  return null;
}

/** True when this provider can run a turn OUTSIDE the spawned process tree. */
export function providerOwnsOutOfTreeTurn(provider: string): boolean {
  return typeof adapterFor(provider)?.cancelTurn === "function";
}

/** Provider-owned cleanup states that PROVE the turn's work is resolved. */
const RESOLVED_CLEANUP_STATES: ReadonlySet<string> = new Set(["owned_tool_stopped", "no_owned_work", "not_owned"]);

/** The generation that owns a job's provider turn (its current child generation). */
export function providerTurnGeneration(job: JobRecord): number {
  return job.childGeneration ?? job.generation;
}

/**
 * True when this job has an ESTABLISHED provider turn that runs outside the
 * spawned tree and whose provider-owned cleanup is NOT resolved for the CURRENT
 * generation. Managed-tree proof alone must never settle such a job as
 * `interrupted`/`cancelled`; only an explicit cancellation that reaches the
 * provider route may resolve it (or leave it honestly non-terminal).
 *
 * A provider with no out-of-tree turn (Command Code, WorkBuddy on a platform
 * whose runner is in-tree), a never-started session (null `sessionId`, e.g. a
 * queued job), or a cleanup proven for THIS generation in a resolved state
 * returns false — so existing managed-tree-only behavior is preserved.
 */
export function providerTurnUnresolved(job: JobRecord): boolean {
  if (!providerOwnsOutOfTreeTurn(job.provider)) return false;
  if (typeof job.sessionId !== "string" || !job.sessionId.trim()) return false;
  const generation = providerTurnGeneration(job);
  const cleanup = job.cancelCleanup;
  if (cleanup && cleanup.generation === generation && RESOLVED_CLEANUP_STATES.has(cleanup.state)) return false;
  return true;
}
