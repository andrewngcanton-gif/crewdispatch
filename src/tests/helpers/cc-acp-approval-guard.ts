// cc-acp-approval-guard.ts — the PURE identity/scope guard the opt-in installed
// Command Code ACP acceptance uses before it auto-answers ANY provider approval.
//
// This test answers a provider permission request only when it is provably the
// ONE operation the run asked for: a file edit of this run's own disposable
// PROBE_FILE inside this run's project directory, bound to this exact
// job + generation + provider + request id, offered with the provider's own
// allow option. Everything else — a different file, an inside-tree but
// unexpected target, a shell/execute action, a title-only filename mention, a
// pathless request, an outside path, a conflicting cwd, or an approval that
// does not offer the expected native option — is REJECTED so the caller fails
// the test WITHOUT sending a provider decision.
//
// It is deliberately a standalone pure module (no product imports, no side
// effects) so offline unit tests can pin every case without loading the opt-in
// E2E entry or spending model entitlement.
import path from "node:path";

/** The subset of a persisted pending approval the guard needs to inspect. */
export interface CcAcpPendingApprovalLike {
  jobId?: unknown;
  generation?: unknown;
  provider?: unknown;
  requestId?: unknown;
  toolName?: unknown;
  detail?: unknown;
  options?: unknown;
}

/** What THIS run's one allowed approval must look like. */
export interface CcAcpApprovalExpectation {
  /** The exact job this run dispatched. */
  jobId: string;
  /** The exact generation the request must belong to. */
  generation: number;
  /** The expected provider id (e.g. "command-code"). */
  provider: string;
  /** The expected provider operation kind (e.g. "edit"). */
  toolKind: string;
  /** The ABSOLUTE path of this run's disposable probe file. */
  probePath: string;
  /** The ABSOLUTE project directory the job runs in (the provider's cwd). */
  projectDir: string;
  /** The provider's own native allow option id this run may send. */
  optionId: string;
  /** Comparison platform (tests inject it; defaults to the host). */
  platform?: NodeJS.Platform;
}

export type CcAcpApprovalVerdict = { ok: true; reason: string } | { ok: false; reason: string };

function reject(reason: string): CcAcpApprovalVerdict {
  return { ok: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Decide whether one pending approval is exactly this run's own probe edit.
 *
 * Ordering matters: identity first, then the provider operation kind, then the
 * provider's own option ids, then the EXACT normalized target path, then the
 * cwd. A title/description/command that merely mentions the file is never
 * binding — only an explicit `detail.path` is.
 */
export function approvalIsThisRunsProbe(
  pending: CcAcpPendingApprovalLike,
  expected: CcAcpApprovalExpectation
): CcAcpApprovalVerdict {
  const platform = expected.platform ?? process.platform;

  // 1. Exact identity: this job, this generation, this provider, a real request.
  if (pending.jobId !== expected.jobId) return reject(`jobId=${String(pending.jobId)} is not this job`);
  if (Number(pending.generation) !== expected.generation) {
    return reject(`generation=${String(pending.generation)} is not generation ${expected.generation}`);
  }
  if (pending.provider !== expected.provider) return reject(`provider=${String(pending.provider)} is not ${expected.provider}`);
  const requestId = typeof pending.requestId === "string" ? pending.requestId.trim() : "";
  if (!requestId) return reject("no request id");

  // 2. The provider operation kind must be the expected edit — never a
  //    shell/execute (or any other) action.
  const toolName = typeof pending.toolName === "string" ? pending.toolName.trim() : "";
  if (toolName !== expected.toolKind) {
    return reject(`operation kind ${JSON.stringify(toolName)} is not ${JSON.stringify(expected.toolKind)}`);
  }

  // 3. The provider's own native option id this run may send must be offered.
  const options = Array.isArray(pending.options) ? pending.options : [];
  const hasOption = options.some((option) => {
    const record = asRecord(option);
    return (typeof record.id === "string" ? record.id : record.optionId) === expected.optionId;
  });
  if (!hasOption) return reject(`the provider did not offer its native option ${JSON.stringify(expected.optionId)}`);

  // 4. The EXACT normalized target path: an explicit path that equals this run's
  //    probe file under the project directory. A missing path, a title-only
  //    filename mention, another inside-tree file or an outside path all fail.
  const detail = asRecord(pending.detail);
  const rawPath = typeof detail.path === "string" ? detail.path.trim() : "";
  if (!rawPath) return reject("no explicit target path");
  const resolved = path.resolve(expected.projectDir, rawPath);
  if (!samePath(resolved, expected.probePath, platform)) {
    return reject(`target path ${JSON.stringify(rawPath)} is not this run's probe file`);
  }

  // 5. A command-shaped action is never the expected file edit.
  const command = typeof detail.command === "string" ? detail.command.trim() : "";
  if (command) return reject("the request carries a command, not a plain file edit");

  // 6. A conflicting cwd (present but not the project directory) is rejected.
  const rawCwd = typeof detail.cwd === "string" ? detail.cwd.trim() : "";
  if (rawCwd && !samePath(rawCwd, expected.projectDir, platform)) {
    return reject(`cwd ${JSON.stringify(rawCwd)} conflicts with this run's project directory`);
  }

  return { ok: true, reason: "this run's own disposable probe edit, bound to this job+generation+request" };
}
