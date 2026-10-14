// cancel-channel.ts — the WorkBuddy AI provider's LIVE-BRIDGE cancellation
// control channel (JQ-20261006-58, generation-2 repair).
//
// WHY THIS EXISTS
//
// The installed WorkBuddy ACP runtime routes `session/cancel` BY CONNECTION:
// its handler calls `cancelAllInFlightPrompts(connectionId, sessionId)`, which
// sweeps only the in-flight prompts OF THE CONNECTION THAT SENT THE CANCEL
// (read locally from the installed `codebuddy-headless.js`; a connection with
// no in-flight prompts logs "No matching in-flight prompts to cancel" and does
// nothing). A freshly opened auxiliary connection therefore has nothing to
// cancel — its `session/cancel` is a silent no-op. The installed-host retest
// confirmed exactly that: a valid auxiliary delivery left the in-flight tool
// alive while the job stayed non-terminal.
//
// The ONLY connection that can cancel a WorkBuddy turn is the ORIGINAL bridge
// connection that issued `session/prompt`. So an explicit cancel is routed
// through OUR still-live bridge:
//
//   worker (owns the job)                     bridge (owns the connection)
//   ---------------------                     ----------------------------
//   writes ONE request file            --->   polls while a prompt is in flight
//   polls for the acknowledgment       <---   delivers ACP `session/cancel` on
//                                             the ORIGINAL connection, then
//                                             writes the acknowledgment
//
// The acknowledgment records IN-PROTOCOL DELIVERY only — never that the tool
// stopped (the generic lifecycle observes the runtime's descendants for that).
// A missing/dead bridge, a wrong-identity request or a lost race simply never
// acknowledges: the requester reports a truthful bounded no-route and the job
// stays non-terminal with its retained evidence. Nothing here kills anything.
//
// The file protocol mirrors the interactive approval channel's conventions
// (`src/jobs/approval.ts`): ONE generation-scoped request and ONE
// acknowledgment under `<root>/cancel/`, written atomically, re-read with
// strict normalization, and retired by the requester when its bounded wait
// ends. The identity is exact — provider + job + child generation + provider
// session — and the acknowledgment additionally carries the bridge process
// that wrote it, so a stale or foreign bridge incarnation can never satisfy a
// request. Every wait here is a bounded CONTROL handshake; nothing in this
// module limits how long a real turn may run.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeApprovalToken } from "../../jobs/approval";

export const TURN_CANCEL_PROTOCOL_VERSION = 1;
/** The bridge's poll cadence while a prompt is in flight. */
export const TURN_CANCEL_POLL_MS = 150;
/** The requester's poll cadence while waiting for the acknowledgment. */
export const TURN_CANCEL_ACK_POLL_MS = 50;
/**
 * How long the requester waits for the bridge's acknowledgment. Bounded on
 * purpose: this is a control handshake on the cancellation path, and a missing
 * or dead bridge must resolve to a truthful no-route, never hang the caller.
 */
export const TURN_CANCEL_ACK_TIMEOUT_MS = 4_000;

/**
 * The exact identity of ONE cancellable turn: the canonical provider id, the
 * CrewDispatch job and CHILD generation that own it, the provider session id
 * the bridge published, and the CrewDispatch data root both processes resolve.
 */
export interface TurnCancelIdentity {
  provider: string;
  jobId: string;
  generation: number;
  sessionId: string;
  dataRoot: string;
}

/** ONE bounded cancel request written by the worker (the file payload). */
export interface TurnCancelRequest {
  version: number;
  kind: "turn_cancel";
  provider: string;
  jobId: string;
  generation: number;
  sessionId: string;
  /** A fresh token per request, so a stale acknowledgment can never answer it. */
  requestId: string;
  requestedAt: string;
}

/** ONE bridge acknowledgment: the in-protocol delivery, never a tool verdict. */
export interface TurnCancelAck {
  version: number;
  kind: "turn_cancel_ack";
  provider: string;
  jobId: string;
  generation: number;
  sessionId: string;
  requestId: string;
  /** The bridge process that delivered the cancel on its own connection. */
  bridgePid: number;
  deliveredAt: string;
}

// ---------------------------------------------------------------------------
// Bounded sanitizers / normalization
// ---------------------------------------------------------------------------

/** The provider's own ACP session id charset (the bridge's `--resume` shape). */
const CANCEL_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function safeSessionId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return CANCEL_SESSION_ID_RE.test(text) ? text : null;
}

function safeGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function safeTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function safePid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeRequest(raw: unknown): TurnCancelRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "turn_cancel") return null;
  const provider = safeApprovalToken(r.provider, 64);
  const jobId = safeApprovalToken(r.jobId, 128);
  const generation = safeGeneration(r.generation);
  const sessionId = safeSessionId(r.sessionId);
  const requestId = safeApprovalToken(r.requestId, 64);
  const requestedAt = safeTimestamp(r.requestedAt);
  if (!provider || !jobId || generation == null || !sessionId || !requestId || !requestedAt) return null;
  return { version: TURN_CANCEL_PROTOCOL_VERSION, kind: "turn_cancel", provider, jobId, generation, sessionId, requestId, requestedAt };
}

function normalizeAck(raw: unknown): TurnCancelAck | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "turn_cancel_ack") return null;
  const provider = safeApprovalToken(r.provider, 64);
  const jobId = safeApprovalToken(r.jobId, 128);
  const generation = safeGeneration(r.generation);
  const sessionId = safeSessionId(r.sessionId);
  const requestId = safeApprovalToken(r.requestId, 64);
  const bridgePid = safePid(r.bridgePid);
  const deliveredAt = safeTimestamp(r.deliveredAt);
  if (!provider || !jobId || generation == null || !sessionId || !requestId || bridgePid == null || !deliveredAt) return null;
  return { version: TURN_CANCEL_PROTOCOL_VERSION, kind: "turn_cancel_ack", provider, jobId, generation, sessionId, requestId, bridgePid, deliveredAt };
}

// ---------------------------------------------------------------------------
// Bounded file protocol (the approval channel's conventions)
// ---------------------------------------------------------------------------

function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Directory of the live-bridge cancel request/acknowledgment files. */
export function turnCancelDir(root: string): string {
  return path.join(root, "cancel");
}

function turnCancelBase(root: string, jobId: string, generation: number): string {
  const job = safeApprovalToken(jobId, 128);
  if (!job) throw new Error(`unsafe turn-cancel job id: ${JSON.stringify(jobId)}`);
  const gen = safeGeneration(generation) ?? 0;
  const file = path.join(turnCancelDir(root), `${job}.gen-${gen}.cancel`);
  if (!insideRoot(root, file)) throw new Error("turn-cancel path escapes the CrewDispatch data root");
  return file;
}

export function turnCancelRequestPath(root: string, jobId: string, generation: number): string {
  return `${turnCancelBase(root, jobId, generation)}.request.json`;
}

export function turnCancelAckPath(root: string, jobId: string, generation: number): string {
  return `${turnCancelBase(root, jobId, generation)}.ack.json`;
}

function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best-effort on some filesystems */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write the ONE cancel request for a job generation (atomic replace). */
export function writeTurnCancelRequest(root: string, request: TurnCancelRequest): TurnCancelRequest {
  const normalized = normalizeRequest(request);
  if (!normalized) throw new Error("refusing to write an invalid turn-cancel request");
  atomicWrite(turnCancelRequestPath(root, normalized.jobId, normalized.generation), JSON.stringify(normalized));
  return normalized;
}

/** Read the cancel request for the exact identity tuple, or null. */
export function readTurnCancelRequest(root: string, jobId: string, generation: number): TurnCancelRequest | null {
  const request = normalizeRequest(readJson(turnCancelRequestPath(root, jobId, generation)));
  if (!request) return null;
  return request.jobId === jobId && request.generation === (safeGeneration(generation) ?? 0) ? request : null;
}

export function clearTurnCancelRequest(root: string, jobId: string, generation: number): void {
  try {
    fs.rmSync(turnCancelRequestPath(root, jobId, generation), { force: true });
  } catch {
    /* best effort */
  }
}

/** Write the ONE acknowledgment for a job generation (atomic replace). */
export function writeTurnCancelAck(root: string, ack: TurnCancelAck): TurnCancelAck {
  const normalized = normalizeAck(ack);
  if (!normalized) throw new Error("refusing to write an invalid turn-cancel acknowledgment");
  atomicWrite(turnCancelAckPath(root, normalized.jobId, normalized.generation), JSON.stringify(normalized));
  return normalized;
}

/** Read the acknowledgment for the exact identity tuple, or null. */
export function readTurnCancelAck(root: string, jobId: string, generation: number): TurnCancelAck | null {
  const ack = normalizeAck(readJson(turnCancelAckPath(root, jobId, generation)));
  if (!ack) return null;
  return ack.jobId === jobId && ack.generation === (safeGeneration(generation) ?? 0) ? ack : null;
}

export function clearTurnCancelAck(root: string, jobId: string, generation: number): void {
  try {
    fs.rmSync(turnCancelAckPath(root, jobId, generation), { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Bridge half: watch for a cancel request while a prompt is in flight
// ---------------------------------------------------------------------------

export interface TurnCancelChannelOptions {
  pollMs?: number;
  now?: () => Date;
}

/**
 * ONE bridge-owned cancel watcher, bound to the exact
 * provider+job+generation+session identity of the turn this bridge is running.
 *
 * `watch(deliver)` polls the request file while a prompt is in flight and calls
 * `deliver(sessionId)` EXACTLY once per acknowledged request id — the delivery
 * callback must send ACP `session/cancel` on THIS bridge's own connection (the
 * only connection the runtime can cancel this turn on). The acknowledgment is
 * written only AFTER `deliver` resolves; a rejected delivery is retried on the
 * next tick (a transient POST failure must not lose the cancel) and never
 * acknowledged. A request for any other provider/job/generation/session is
 * IGNORED — never delivered, never acknowledged — so a stale or foreign
 * request can never cancel a turn it does not own.
 */
export class TurnCancelChannel {
  private stopped = false;
  private lastDeliveredRequestId: string | null = null;

  constructor(
    private readonly identity: TurnCancelIdentity,
    private readonly options: TurnCancelChannelOptions = {}
  ) {}

  watch(deliver: (sessionId: string) => Promise<void>): () => void {
    const pollMs = this.options.pollMs ?? TURN_CANCEL_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (): void => {
      void this.tick(deliver).finally(() => {
        if (this.stopped) return;
        timer = setTimeout(run, pollMs);
        timer.unref?.();
      });
    };
    run();
    return () => {
      this.stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }

  private async tick(deliver: (sessionId: string) => Promise<void>): Promise<void> {
    if (this.stopped) return;
    const request = readTurnCancelRequest(this.identity.dataRoot, this.identity.jobId, this.identity.generation);
    if (!request || request.requestId === this.lastDeliveredRequestId) return;
    if (request.provider !== this.identity.provider) return;
    if (request.sessionId !== this.identity.sessionId) return;
    try {
      await deliver(request.sessionId);
    } catch {
      // The delivery failed (a dead connection, a refused POST): do NOT
      // acknowledge. The next tick retries while the prompt is still in flight.
      return;
    }
    this.lastDeliveredRequestId = request.requestId;
    try {
      writeTurnCancelAck(this.identity.dataRoot, {
        version: TURN_CANCEL_PROTOCOL_VERSION,
        kind: "turn_cancel_ack",
        provider: this.identity.provider,
        jobId: this.identity.jobId,
        generation: this.identity.generation,
        sessionId: this.identity.sessionId,
        requestId: request.requestId,
        bridgePid: process.pid,
        deliveredAt: (this.options.now ?? (() => new Date()))().toISOString()
      });
    } catch {
      // The acknowledgment could not be written (a local filesystem failure):
      // the requester simply never sees it and reports a truthful no-route.
    }
  }
}

// ---------------------------------------------------------------------------
// Worker half: request the cancel and wait (bounded) for the acknowledgment
// ---------------------------------------------------------------------------

export interface BridgeCancelOptions {
  /** Bounded override for tests/boundaries; defaults to the shared 4 seconds. */
  waitMs?: number;
  pollMs?: number;
  now?: () => Date;
  /**
   * When the CrewDispatch-spawned bridge PID is known, an acknowledgment from
   * ANY OTHER process is refused: the binding is the exact bridge incarnation.
   */
  expectBridgePid?: number | null;
}

export interface BridgeCancelResult {
  /** True ONLY when the live bridge acknowledged the in-protocol delivery. */
  delivered: boolean;
  /** The fresh request token this attempt used (bounded evidence). */
  requestId: string;
  /** Finite diagnostic token, or null on delivery. */
  detail: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the LIVE bridge to cancel this exact turn and wait (bounded) for its
 * acknowledgment. Never throws: an unwritable channel, a missing/dead bridge or
 * a stale acknowledgment all resolve to `delivered: false` with a finite
 * diagnostic token. The request and acknowledgment files are retired when the
 * bounded wait ends, whatever its outcome.
 */
export async function requestBridgeTurnCancel(
  identity: TurnCancelIdentity,
  options: BridgeCancelOptions = {}
): Promise<BridgeCancelResult> {
  const requestId = crypto.randomBytes(8).toString("hex");
  const now = options.now ?? (() => new Date());
  try {
    writeTurnCancelRequest(identity.dataRoot, {
      version: TURN_CANCEL_PROTOCOL_VERSION,
      kind: "turn_cancel",
      provider: identity.provider,
      jobId: identity.jobId,
      generation: identity.generation,
      sessionId: identity.sessionId,
      requestId,
      requestedAt: now().toISOString()
    });
  } catch {
    // The request could not be materialized (a local protocol/filesystem
    // failure): there is no channel to the live bridge at all.
    return { delivered: false, requestId, detail: "bridge_channel_unavailable" };
  }
  const deadline = Date.now() + Math.max(options.waitMs ?? TURN_CANCEL_ACK_TIMEOUT_MS, 0);
  try {
    for (;;) {
      const ack = readTurnCancelAck(identity.dataRoot, identity.jobId, identity.generation);
      if (
        ack &&
        ack.requestId === requestId &&
        ack.provider === identity.provider &&
        ack.sessionId === identity.sessionId &&
        (options.expectBridgePid == null || ack.bridgePid === options.expectBridgePid)
      ) {
        return { delivered: true, requestId, detail: null };
      }
      if (Date.now() >= deadline) return { delivered: false, requestId, detail: "bridge_unreachable" };
      await delay(options.pollMs ?? TURN_CANCEL_ACK_POLL_MS);
    }
  } finally {
    clearTurnCancelRequest(identity.dataRoot, identity.jobId, identity.generation);
    clearTurnCancelAck(identity.dataRoot, identity.jobId, identity.generation);
  }
}
