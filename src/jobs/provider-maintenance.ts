// Shared lifecycle chooses eligible terminal attempts; adapters own native disposal.
import { listJobs } from "./store";
import { isTerminalStatus } from "./types";
import { providerTurnUnresolved } from "./provider-turn";
import { adapterFor } from "./provider-cancel";
import type { ProviderAdapter } from "../providers/provider";

export async function maintainProviderResources(root: string, adapters?: readonly ProviderAdapter[]): Promise<void> {
  const jobs = listJobs(root);
  if (jobs.unreadable.length) return; // Unknown durable users prohibit reclamation.
  const registered = adapters ?? [...new Set(jobs.jobs.map(job => job.provider))].map(adapterFor).filter((a): a is ProviderAdapter => a !== null);
  for (const adapter of registered) {
    if (!adapter.maintainResources) continue;
    const safe = jobs.jobs.filter(job => job.provider === adapter.id && isTerminalStatus(job.status) &&
      job.childPid == null);
    const terminalAttempts = safe.flatMap(job => [...new Set([job.generation, ...job.attempts.map(a => a.generation)])]
      .map(generation => ({ jobId: job.id, generation, turnResolved: generation === job.generation && !providerTurnUnresolved(job) })));
    if (!terminalAttempts.length) continue;
    try { await adapter.maintainResources({ dataRoot: root, terminalAttempts }); } catch { /* Does not change a job, wake or result. */ }
  }
}
