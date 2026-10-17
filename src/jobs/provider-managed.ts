// provider-managed.ts — the ONE definition of "a process CrewDispatch must never
// treat as its own disposable tree".
//
// A provider may own a durable, shared process that a job's disposable process
// tree did NOT create and must never stop: today the WorkBuddy AI Desktop
// SIDECAR, which hosts the ACP runtime that actually executes a WorkBuddy turn
// (JQ-20261006-58). CrewDispatch reads that daemon's PID from provider-owned
// metadata and excludes it (and its subtree) from every descendant scan and every
// tree kill — it never signals the daemon itself.
//
// This module exists so both the job service and the provider-cancel lifecycle
// use the SAME rule without importing each other.
import { WORKBUDDY_AI_PROVIDER, workBuddyAiProfileEnv } from "../providers/workbuddy-ai/index";
import { workBuddyDesktopConfigDir, workBuddyDesktopSidecarPid, workBuddyRecoveryOwnerPid } from "../providers/workbuddy-ai/desktop-bridge";
import type { JobRecord } from "./types";

/**
 * Provider-managed daemon roots that are intentionally OUTSIDE a job's
 * disposable CLI tree.
 *
 * Empty unless the provider declares such a daemon and its exact PID can be read
 * from provider-owned metadata: an unknown PID is never guessed from a name, a
 * path or a cwd.
 */
export function providerManagedIgnoredPids(
  job: JobRecord,
  env: NodeJS.ProcessEnv = process.env,
  dataRoot: string | null = null
): ReadonlySet<number> {
  const ignored = new Set<number>();
  if (job.provider !== WORKBUDDY_AI_PROVIDER) return ignored;
  const profileEnv = workBuddyAiProfileEnv(env);
  const pid = workBuddyDesktopSidecarPid(workBuddyDesktopConfigDir(profileEnv));
  if (pid != null) {
    ignored.add(pid);
    // A macOS post-reopen recovery helper is intentionally app-lifetime owned,
    // not disposable job work. During the ONE bridge that spawned it, Darwin
    // still reports that detached helper as a descendant until the bridge exits.
    // Ignore it only from CrewDispatch's exact persisted PID+birth receipt and
    // only while it still owns the provider's CURRENT sidecar PID.
    if (dataRoot) {
      const ownerPid = workBuddyRecoveryOwnerPid(dataRoot, pid);
      if (ownerPid != null) ignored.add(ownerPid);
    }
  }
  return ignored;
}
