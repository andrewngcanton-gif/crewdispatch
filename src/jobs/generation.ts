// generation.ts — generation-scoped child registry and the pure guards that
// keep an OLD generation from touching a NEWER run.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/jobs.mjs` registerChild / unregisterChild / hasLiveChild /
// currentGeneration / isCurrentGeneration.
//
// A "generation" is one CLI attempt of a logical job. Resuming at the CLI's
// internal segment boundary (`max_turns`) or continuing a finished job bumps the
// generation. The invariant is simple and load-bearing:
//
//   * `unregister(jobId, generation)` removes the handle ONLY if the registered
//     handle is that same generation — a late old attempt can never drop a newer
//     child's handle;
//   * only the current generation of a non-terminal job may write a terminal
//     state (see service.finalizeJob).
import type { ChildProcess } from "node:child_process";
import { isTerminalStatus, type JobRecord } from "./types";

interface RegistryEntry {
  generation: number;
  child: ChildProcess;
}

export interface GenerationRegistry {
  register(jobId: string, generation: number, child: ChildProcess): void;
  unregister(jobId: string, generation: number): void;
  get(jobId: string): RegistryEntry | null;
  /** Authoritative "is a child still running for this job" test. */
  hasLiveChild(jobId: string, generation?: number | null): boolean;
  currentGeneration(jobId: string): number | null;
  clear(): void;
}

export function createGenerationRegistry(): GenerationRegistry {
  const children = new Map<string, RegistryEntry>();
  return {
    register(jobId, generation, child) {
      children.set(jobId, { generation, child });
    },
    unregister(jobId, generation) {
      const entry = children.get(jobId);
      if (entry && entry.generation === generation) children.delete(jobId);
    },
    get(jobId) {
      return children.get(jobId) ?? null;
    },
    hasLiveChild(jobId, generation) {
      const entry = children.get(jobId);
      if (!entry) return false;
      if (generation != null && entry.generation !== generation) return false;
      return entry.child.exitCode === null && entry.child.signalCode === null;
    },
    currentGeneration(jobId) {
      return children.get(jobId)?.generation ?? null;
    },
    clear() {
      children.clear();
    }
  };
}

/** A generation is current when the record carries no generation or it matches. */
export function isCurrentGeneration(job: Pick<JobRecord, "generation">, generation: number | null | undefined): boolean {
  if (generation == null) return true;
  return job.generation === generation;
}

/**
 * May this generation write a terminal state? Only when it is the current
 * generation AND the job has not already reached a terminal state. This is the
 * single terminal-uniqueness predicate used by the service.
 */
export function canFinalize(job: Pick<JobRecord, "generation" | "status">, generation: number | null | undefined): boolean {
  if (isTerminalStatus(job.status)) return false;
  return isCurrentGeneration(job, generation);
}

/** Parse an owner id "jobquay-<pid>-<ts36>" back to its PID (null when absent). */
export function ownerPidOf(owner: string | null | undefined): number | null {
  if (typeof owner !== "string") return null;
  const m = /^jobquay-(\d+)-/.exec(owner.trim());
  if (!m || !m[1]) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Build a fresh owner id for the current process. */
export function makeOwnerId(pid: number = process.pid, now: number = Date.now()): string {
  return `jobquay-${pid}-${now.toString(36)}`;
}
