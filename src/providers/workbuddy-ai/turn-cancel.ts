// turn-cancel.ts — the WorkBuddy AI provider's OWN cancellation route (JQ-20261006-58).
//
// WHY THIS EXISTS
//
// A WorkBuddy AI run does NOT happen inside the process tree CrewDispatch
// spawned. The disposable bridge (`desktop-bridge.ts`) only opens a control
// connection to the WorkBuddy Desktop SIDECAR and then drives a turn that the
// sidecar-hosted ACP RUNTIME executes. The turn's tool processes are children of
// that runtime, so killing CrewDispatch's child tree stops the bridge — and
// nothing else. On Windows the tree kill is `taskkill /T /F`, which terminates a
// process without ever delivering CTRL+C/SIGINT/SIGTERM, so the bridge's own
// signal handler (its only `session/cancel`) never ran: the job reached
// `cancelled` while the runtime's tool kept running.
//
// HOW THE CANCEL REACHES THE RUNTIME (generation-2 repair, confirmed locally
// from the installed `codebuddy-headless.js`): the installed runtime routes
// `session/cancel` BY CONNECTION — `cancelAllInFlightPrompts(connectionId,
// sessionId)` sweeps only the in-flight prompts of the connection that sent the
// cancel. A freshly opened auxiliary connection has nothing to cancel, so its
// cancel is a silent no-op (exactly what the installed-host retest observed).
// The ONLY connection that can cancel this turn is the ORIGINAL bridge
// connection, so this route asks the LIVE bridge to relay the cancel over that
// connection (`cancel-channel.ts`) and treats a missing/dead bridge as a
// truthful no-route — never a guessed delivery.
//
// WHAT IT NEVER DOES
//
//   * never `session.kill` — runtime disposal belongs to the resource lifecycle;
//     legacy slots may still host other turns;
//   * never signals the sidecar itself (a durable, user-owned app process) or
//     `sidecar.shutdown`;
//   * never cancels "every session" or guesses a runtime: the runtime is found by
//     the SAME deterministic id the bridge used (`hostRuntimeId`), and the
//     cancel is bound to the exact job + generation + session + bridge PID.
//
// All waits here are bounded CONTROL handshakes. Nothing in this module limits
// how long a real turn may run.
import os from "node:os";
import { jobRuntimeId, ownsJobRuntime, registeredJobRuntime } from "./runtime-lifecycle";
import {
  hostRuntimeId,
  parseSidecarSessions,
  SidecarClient,
  workBuddyDesktopConfigDir,
  workBuddyDesktopControlEndpoint,
  workBuddyDesktopSidecarMeta,
  type SidecarSession
} from "./desktop-bridge";
import { requestBridgeTurnCancel } from "./cancel-channel";
import type {
  ProviderCancelDeps,
  ProviderTurnCancelInput,
  ProviderTurnCancelResult,
  ProviderTurnSlotInput
} from "../provider";

/** Stable evidence token of this provider's cancellation route. */
export const WORKBUDDY_TURN_CANCEL_ROUTE = "workbuddy-acp-session-cancel";

/**
 * Bounded control handshake budget. It covers ONLY the sidecar control calls and
 * the one cancellation delivery — never a turn.
 */
const CONTROL_TIMEOUT_MS = 5_000;

/** The CrewDispatch permission mode -> WorkBuddy CLI mode vocabulary (protocol-owned). */
const CLI_PERMISSION_MODES: Readonly<Record<string, string>> = {
  default: "default",
  plan: "plan",
  "accept-edits": "acceptEdits",
  yolo: "bypassPermissions",
  "dont-ask": "dontAsk",
  auto: "auto",
  "full-access": "fullAccess"
};

/** The WorkBuddy CLI permission mode for a CrewDispatch permission mode, or null. */
export function workBuddyCliPermissionMode(mode: string): string | null {
  return CLI_PERMISSION_MODES[String(mode).trim().toLowerCase()] ?? null;
}

/**
 * The private job-generation runtime identity, when registered, otherwise the
 * legacy shared configuration slot. Both are derived by the same bridge rules.
 */
export function workBuddyHostRuntimeId(input: ProviderTurnSlotInput): string | null {
  const permission = workBuddyCliPermissionMode(input.permissionMode);
  if (!permission || !input.cliPath) return null;
  return input.jobId != null && input.generation != null && input.dataRoot != null && ownsJobRuntime(input.dataRoot, input.jobId, input.generation)
    ? jobRuntimeId(input.dataRoot, input.jobId, input.generation, input.platform ?? process.platform)
    : hostRuntimeId(input.cliPath, permission, input.effort, input.cwd, input.platform ?? process.platform);
}

/** The provider-scoped shared slot of a turn: its runtime id (null when unknown). */
export function workBuddyTurnSlotKey(input: ProviderTurnSlotInput): string | null {
  return workBuddyHostRuntimeId(input);
}

/** The minimal sidecar transport this route needs (the real client satisfies it). */
export interface WorkBuddySidecarTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/** Connect to the ALREADY-RUNNING Desktop sidecar's control pipe. Never spawns one. */
export async function connectSidecar(
  configDir: string,
  deps: { platform?: NodeJS.Platform; tmpDir?: string }
): Promise<SidecarClient> {
  const platform = deps.platform ?? process.platform;
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const meta = workBuddyDesktopSidecarMeta(configDir, platform, tmpDir);
  if (!meta) throw new Error("sidecar_unavailable");
  const endpoint = workBuddyDesktopControlEndpoint(configDir, meta.controlPipeUuid, platform, tmpDir);
  const sidecar = new SidecarClient(endpoint);
  try {
    await sidecar.connect(CONTROL_TIMEOUT_MS);
    const ping = await sidecar.request("sidecar.ping", {}, CONTROL_TIMEOUT_MS);
    const obj = ping && typeof ping === "object" ? ping as Record<string, unknown> : null;
    // Identity proof: the sidecar that answers must be the one the pid file named.
    if (!obj || Number(obj.pid) !== meta.pid) throw new Error("sidecar_identity_mismatch");
    return sidecar;
  } catch (error) {
    sidecar.close();
    throw error;
  }
}

function emptyResult(detail: string): ProviderTurnCancelResult {
  return { route: WORKBUDDY_TURN_CANCEL_ROUTE, requested: false, sessionId: null, ownedRoots: [], slotKey: null, detail };
}

/**
 * Cancel the EXACT WorkBuddy session/turn and name the provider-owned roots that
 * host it.
 *
 * Two bounded phases, in this order:
 *
 *   1. DELIVERY through the LIVE bridge's original ACP connection — the only
 *      connection the installed runtime can cancel this turn on. The request is
 *      bound to the exact provider + job + child generation + session (+ the
 *      bridge process, when the caller knows it), and a missing/dead bridge or
 *      a wrong-identity request simply never acknowledges: the result is a
 *      truthful bounded no-route and NOTHING is claimed as delivered.
 *   2. ATTRIBUTION of the sidecar-hosted runtime (the same deterministic id the
 *      bridge used) so the generic lifecycle can OBSERVE this turn's
 *      descendants. Private identity is snapshotted from its durable receipt before delivery,
 *      so immediate disposal cannot erase attribution. Legacy attribution only
 *      reads the sidecar; an unreachable or unlisted legacy runtime is UNKNOWN
 *      (never "no owned work") even though the cancel was delivered.
 *
 * The result is EVIDENCE, never a promise that the work stopped: `requested`
 * means the runtime was asked to cancel this exact session over the bridge's own
 * connection, and `ownedRoots` names the process roots the generic lifecycle may
 * then verify. This module never signals those roots itself.
 */
export async function cancelWorkBuddyTurn(
  input: ProviderTurnCancelInput,
  deps: ProviderCancelDeps = {}
): Promise<ProviderTurnCancelResult> {
  const env = deps.env ?? process.env;
  if (!input.sessionId) return emptyResult("no_provider_session");

  // The CLI path is resolved by the provider's OWN discovery rules through the
  // shared `resolveCli` contract and handed in by the caller; this route never
  // re-invents discovery and never guesses a runtime from an unresolved path.
  const cliPath = input.cliPath?.trim() ? input.cliPath.trim() : null;
  if (!cliPath) return emptyResult("cli_unavailable");

  const slotKey = workBuddyHostRuntimeId({
    jobId: input.jobId, generation: input.generation, dataRoot: input.dataRoot,
    cliPath,
    permissionMode: input.permissionMode,
    effort: input.effort,
    cwd: input.cwd,
    env,
    platform: deps.platform
  });
  if (!slotKey) return emptyResult("permission_mode_unsupported");

  // A private runtime's exact identity is durable before its prompt starts.
  // Snapshot it before delivery; cancellation may dispose the native server
  // before acknowledgment. Unroutable requests still make NO sidecar calls.
  let owned: SidecarSession | null = null;
  const registered = registeredJobRuntime(input.dataRoot, input.jobId, input.generation);
  if (registered) owned = { ...registered, acpEndpoint: "" };
  const delivered = await requestBridgeTurnCancel(
    { provider: input.provider, jobId: input.jobId, generation: input.generation, sessionId: input.sessionId, dataRoot: input.dataRoot },
    { waitMs: deps.cancelAckWaitMs, expectBridgePid: input.childPid }
  );
  if (!delivered.delivered) {
    return { route: WORKBUDDY_TURN_CANCEL_ROUTE, requested: false, sessionId: input.sessionId, ownedRoots: [], slotKey, detail: delivered.detail };
  }
  if (!owned) {
    const configDir = deps.configDir ?? workBuddyDesktopConfigDir(env);
    const transport = deps.transport as WorkBuddySidecarTransport | undefined;
    let ownSidecar: SidecarClient | null = null;
    let sessions: SidecarSession[] | null = null;
    try {
      const sidecar = transport ?? (ownSidecar = await connectSidecar(configDir, deps));
      const listed = await sidecar.request("session.list", {}, CONTROL_TIMEOUT_MS);
      if (Array.isArray(listed)) sessions = parseSidecarSessions(listed);
    } catch { /* Legacy attribution remains unknown. */ }
    finally { ownSidecar?.close(); }
    owned = sessions?.find(item => item.sessionId === slotKey) ?? null;
    if (!owned) {
      return { route: WORKBUDDY_TURN_CANCEL_ROUTE, requested: true, sessionId: input.sessionId, ownedRoots: [], ownershipUnknown: true, slotKey, detail: sessions == null ? "sidecar_unavailable" : "runtime_not_found" };
    }
  }

  // The runtime process itself, never the sidecar: the sidecar's own PID is
  // excluded by the caller's provider-managed ignore set as well. A matched
  // runtime that published NO usable PID cannot be attributed: the cancel was
  // still DELIVERED (requested:true) but the ownership is UNKNOWN, so the
  // generic lifecycle must never read the empty root list as "no owned work".
  const runtimePid = typeof owned.pid === "number" && Number.isInteger(owned.pid) && owned.pid > 0 ? owned.pid : null;
  return {
    route: WORKBUDDY_TURN_CANCEL_ROUTE,
    requested: true,
    sessionId: input.sessionId,
    ownedRoots: runtimePid != null ? [runtimePid] : [],
    ownershipUnknown: runtimePid == null,
    slotKey,
    detail: runtimePid == null ? "runtime_pid_unavailable" : null
  };
}
