// wb-cancel-route.test.ts — protocol and normalization tests for the
// provider-owned cancellation route (JQ-20261006-58).
//
// These are NOT cross-process evidence (the real separate-process regression is
// `src/tests/integration/wb-cancel-owned-tool.test.ts`). They pin BOTH halves of
// the live-bridge control protocol (`cancel-channel.ts`), the provider route's
// normalization (`cancelWorkBuddyTurn`) and the GENERIC lifecycle's decision
// rules (`requestProviderTurnCancel` / `resolveProviderOwnedTool`) with injected
// seams, so the exact-identity rule, the shared-slot rule and the
// unresolved-evidence rule can never silently drift.
//
// The bridge half under test here is the PRODUCTION `TurnCancelChannel`; the
// worker half is the PRODUCTION `requestBridgeTurnCancel` (through
// `cancelWorkBuddyTurn`). The two halves talk over the real file protocol in a
// disposable temp root, so the request/acknowledgment contract is exercised
// end to end without a second process.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cancelWorkBuddyTurn,
  workBuddyCliPermissionMode,
  workBuddyHostRuntimeId,
  workBuddyTurnSlotKey,
  WORKBUDDY_TURN_CANCEL_ROUTE
} from "../../providers/workbuddy-ai/turn-cancel";
import {
  TurnCancelChannel,
  readTurnCancelAck,
  readTurnCancelRequest,
  turnCancelAckPath,
  turnCancelDir,
  turnCancelRequestPath,
  writeTurnCancelAck,
  writeTurnCancelRequest,
  type TurnCancelAck,
  type TurnCancelIdentity,
  type TurnCancelRequest
} from "../../providers/workbuddy-ai/cancel-channel";
import {
  providerCancelAllowsCancellation,
  requestProviderTurnCancel,
  resolveProviderOwnedTool,
  type ProviderCancelRequest
} from "../../jobs/provider-cancel";
import { createJobRecord } from "../../jobs/service";
import { WORKBUDDY_AI_PROVIDER } from "../../providers/workbuddy-ai/index";
import type { JobRecord } from "../../jobs/types";
import type { ProviderAdapter, ProviderCancelDeps, ProviderTurnCancelInput } from "../../providers/provider";
import type { ProcessEntry } from "../../runtime/process";

function cancelInput(overrides: Partial<ProviderTurnCancelInput> = {}): ProviderTurnCancelInput {
  return {
    provider: WORKBUDDY_AI_PROVIDER,
    jobId: "job-1",
    generation: 0,
    sessionId: "acp-1",
    cwd: "C:/work",
    model: "claude-sonnet-4-5",
    permissionMode: "plan",
    effort: null,
    cliPath: "C:/wb/cli",
    childPid: null,
    attemptStartedAtMs: 1000,
    dataRoot: "C:/root",
    ...overrides
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const base = createJobRecord(
    { task: "t", cwd: "C:/work", provider: WORKBUDDY_AI_PROVIDER, permissionMode: "plan", model: "claude-sonnet-4-5" },
    () => new Date("2026-10-06T00:00:00.000Z")
  );
  return { ...base, status: "running", sessionId: "acp-1", childGeneration: 0, ...overrides };
}

/** A fake sidecar control transport (the route's injectable `transport`). */
class FakeSidecar {
  readonly calls: { method: string; params: unknown }[] = [];
  constructor(private readonly sessions: unknown[]) {}
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    return method === "session.list" ? this.sessions : {};
  }
  close(): void {}
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wbcancel-unit-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(produce: () => T | null | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** A bridge half running the PRODUCTION watcher over the disposable root. */
function startBridge(
  identity: TurnCancelIdentity,
  deliver?: (sessionId: string) => Promise<void>
): { delivered: string[]; stop: () => void } {
  const delivered: string[] = [];
  const channel = new TurnCancelChannel(identity, { pollMs: 20 });
  const stop = channel.watch(async (sessionId) => {
    delivered.push(sessionId);
    await deliver?.(sessionId);
  });
  return { delivered, stop };
}

function bridgeIdentity(root: string, overrides: Partial<TurnCancelIdentity> = {}): TurnCancelIdentity {
  return {
    provider: WORKBUDDY_AI_PROVIDER,
    jobId: "job-1",
    generation: 0,
    sessionId: "acp-1",
    dataRoot: root,
    ...overrides
  };
}

function makeRequest(overrides: Partial<TurnCancelRequest> = {}): TurnCancelRequest {
  return {
    version: 1,
    kind: "turn_cancel",
    provider: WORKBUDDY_AI_PROVIDER,
    jobId: "job-1",
    generation: 0,
    sessionId: "acp-1",
    requestId: "0123456789abcdef",
    requestedAt: "2026-10-06T00:00:00.000Z",
    ...overrides
  };
}

function makeAck(overrides: Partial<TurnCancelAck> = {}): TurnCancelAck {
  return {
    version: 1,
    kind: "turn_cancel_ack",
    provider: WORKBUDDY_AI_PROVIDER,
    jobId: "job-1",
    generation: 0,
    sessionId: "acp-1",
    requestId: "stale0123456789a",
    bridgePid: process.pid,
    deliveredAt: "2026-10-06T00:00:00.000Z",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Provider route: permission/effort/cwd -> deterministic runtime identity
// ---------------------------------------------------------------------------

test("the WorkBuddy permission vocabulary and runtime id are deterministic and never guessed", () => {
  assert.equal(workBuddyCliPermissionMode("plan"), "plan");
  assert.equal(workBuddyCliPermissionMode("accept-edits"), "acceptEdits");
  assert.equal(workBuddyCliPermissionMode("yolo"), "bypassPermissions");
  assert.equal(workBuddyCliPermissionMode("totally-unknown"), null);

  const a = workBuddyHostRuntimeId({ cliPath: "C:/wb/cli", permissionMode: "plan", effort: null, cwd: "C:/work" });
  const b = workBuddyHostRuntimeId({ cliPath: "C:/wb/cli", permissionMode: "plan", effort: null, cwd: "C:/work" });
  assert.ok(a && a.startsWith("jobquay-host-v2-"), "a deterministic runtime id is derived");
  assert.equal(a, b, "the same combination resolves the same runtime id");
  assert.equal(workBuddyTurnSlotKey({ cliPath: "C:/wb/cli", permissionMode: "plan", effort: null, cwd: "C:/work" }), a);
  assert.equal(workBuddyHostRuntimeId({ cliPath: null, permissionMode: "plan", effort: null, cwd: "C:/work" }), null);
  assert.equal(workBuddyHostRuntimeId({ cliPath: "C:/wb/cli", permissionMode: "nope", effort: null, cwd: "C:/work" }), null);
});

// ---------------------------------------------------------------------------
// Bridge half: the live-bridge watcher (production `TurnCancelChannel`)
// ---------------------------------------------------------------------------

test("the live bridge delivers the EXACT request once and acknowledges it with its own process identity", async () => {
  const root = tempRoot();
  try {
    const bridge = startBridge(bridgeIdentity(root));
    try {
      const request = makeRequest();
      writeTurnCancelRequest(root, request);
      const ack = await waitFor(() => readTurnCancelAck(root, "job-1", 0), 3000, "acknowledgment");
      // Several more poll ticks must not deliver (or acknowledge) it again.
      await sleep(200);
      assert.deepEqual(bridge.delivered, ["acp-1"], "exactly one delivery of the exact session");
      assert.equal(ack.requestId, request.requestId, "the acknowledgment answers THIS request token");
      assert.equal(ack.sessionId, "acp-1");
      assert.equal(ack.bridgePid, process.pid, "the acknowledgment names the bridge process that delivered it");
      assert.ok(Number.isFinite(Date.parse(ack.deliveredAt)));
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bridge never delivers a request bound to another session, job or generation", async () => {
  const root = tempRoot();
  try {
    const otherSession = startBridge(bridgeIdentity(root, { sessionId: "acp-other" }));
    const otherJob = startBridge(bridgeIdentity(root, { jobId: "job-other" }));
    const otherGeneration = startBridge(bridgeIdentity(root, { generation: 1 }));
    try {
      writeTurnCancelRequest(root, makeRequest());
      await sleep(250);
      assert.deepEqual(otherSession.delivered, [], "a request for another session is ignored");
      assert.deepEqual(otherJob.delivered, [], "a request for another job is ignored");
      assert.deepEqual(otherGeneration.delivered, [], "a request for another generation is ignored");
      assert.equal(readTurnCancelAck(root, "job-1", 0), null, "an ignored request is never acknowledged");
    } finally {
      otherSession.stop();
      otherJob.stop();
      otherGeneration.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed request file is never delivered", async () => {
  const root = tempRoot();
  try {
    const bridge = startBridge(bridgeIdentity(root));
    try {
      fs.mkdirSync(turnCancelDir(root), { recursive: true });
      fs.writeFileSync(turnCancelRequestPath(root, "job-1", 0), "{ not json", "utf8");
      await sleep(250);
      assert.deepEqual(bridge.delivered, []);
      assert.equal(readTurnCancelAck(root, "job-1", 0), null);
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a FAILED delivery is retried on a later tick and only acknowledged after it succeeds", async () => {
  const root = tempRoot();
  try {
    let attempts = 0;
    let allowDelivery = false;
    const bridge = startBridge(bridgeIdentity(root), async () => {
      attempts += 1;
      if (!allowDelivery) throw new Error("transient delivery failure");
    });
    try {
      writeTurnCancelRequest(root, makeRequest());
      await sleep(150);
      assert.equal(readTurnCancelAck(root, "job-1", 0), null, "a failed delivery is never acknowledged");
      assert.ok(attempts >= 1, "the delivery was attempted while it kept failing");
      allowDelivery = true;
      const ack = await waitFor(() => readTurnCancelAck(root, "job-1", 0), 3000, "retry acknowledgment");
      assert.ok(attempts >= 2, "the delivery was retried on a later tick");
      assert.equal(ack.requestId, "0123456789abcdef");
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopping the watcher ends every delivery and acknowledgment", async () => {
  const root = tempRoot();
  try {
    const bridge = startBridge(bridgeIdentity(root));
    bridge.stop();
    writeTurnCancelRequest(root, makeRequest());
    await sleep(250);
    assert.deepEqual(bridge.delivered, []);
    assert.equal(readTurnCancelAck(root, "job-1", 0), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Worker half + provider route: delivery, binding and truthful no-route
// ---------------------------------------------------------------------------

test("the worker's request reaches the live bridge, the acknowledged cancel is reported delivered, and the files are retired", async () => {
  const root = tempRoot();
  try {
    const cwd = "C:/work";
    const cliPath = "C:/wb/cli";
    const slotKey = workBuddyHostRuntimeId({ cliPath, permissionMode: "plan", effort: null, cwd });
    assert.ok(slotKey);
    const sidecar = new FakeSidecar([{ sessionId: slotKey, acpEndpoint: "http://127.0.0.1:5555/api/v1/acp", pid: 4242 }]);
    const bridge = startBridge(bridgeIdentity(root));
    try {
      const result = await cancelWorkBuddyTurn(
        cancelInput({ cliPath, cwd, dataRoot: root, childPid: process.pid }),
        { transport: sidecar, cancelAckWaitMs: 3000 }
      );
      assert.equal(result.route, WORKBUDDY_TURN_CANCEL_ROUTE);
      assert.equal(result.requested, true, "the in-protocol delivery was acknowledged by the live bridge");
      assert.equal(result.sessionId, "acp-1");
      assert.deepEqual(bridge.delivered, ["acp-1"], "the bridge delivered exactly the requested session");
      assert.deepEqual(result.ownedRoots, [4242], "only the runtime process is a provider-owned root");
      assert.equal(result.slotKey, slotKey);
      assert.equal(result.detail, null);
      // The bounded handshake retires its own files.
      assert.equal(fs.existsSync(turnCancelRequestPath(root, "job-1", 0)), false, "the request file is retired");
      assert.equal(fs.existsSync(turnCancelAckPath(root, "job-1", 0)), false, "the acknowledgment file is retired");
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("with no live bridge the cancel is a truthful bounded no-route and nothing is attributed", async () => {
  const root = tempRoot();
  try {
    const sidecar = new FakeSidecar([{ sessionId: "whatever", acpEndpoint: "http://127.0.0.1:1/api/v1/acp", pid: 1 }]);
    const started = Date.now();
    const result = await cancelWorkBuddyTurn(
      cancelInput({ dataRoot: root, childPid: process.pid }),
      { transport: sidecar, cancelAckWaitMs: 500 }
    );
    const elapsed = Date.now() - started;
    assert.equal(result.requested, false, "a missing bridge is never a delivered cancel");
    assert.equal(result.detail, "bridge_unreachable", "the finite diagnostic names the missing acknowledgment");
    assert.deepEqual(result.ownedRoots, []);
    assert.equal(result.ownershipUnknown, undefined, "no delivery, no ownership claim at all");
    assert.equal(sidecar.calls.length, 0, "attribution is not attempted for a cancel that was never delivered");
    assert.ok(elapsed < 3000, `the wait is bounded (took ${elapsed}ms)`);
    assert.equal(fs.existsSync(turnCancelRequestPath(root, "job-1", 0)), false, "the abandoned request is retired");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stale acknowledgment for another request token never answers a new request", async () => {
  const root = tempRoot();
  try {
    writeTurnCancelAck(root, makeAck({ requestId: "stale0123456789a" }));
    const sidecar = new FakeSidecar([]);
    const result = await cancelWorkBuddyTurn(
      cancelInput({ dataRoot: root }),
      { transport: sidecar, cancelAckWaitMs: 500 }
    );
    assert.equal(result.requested, false);
    assert.equal(result.detail, "bridge_unreachable", "only the matching request token can acknowledge THIS cancel");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an acknowledgment from a DIFFERENT bridge process is refused", async () => {
  const root = tempRoot();
  try {
    // A stand-in bridge that acknowledges with a foreign process identity.
    const timer = setInterval(() => {
      const request = readTurnCancelRequest(root, "job-1", 0);
      if (!request) return;
      writeTurnCancelAck(root, makeAck({ requestId: request.requestId, bridgePid: 999_999 }));
    }, 20);
    timer.unref?.();
    try {
      const sidecar = new FakeSidecar([]);
      const result = await cancelWorkBuddyTurn(
        cancelInput({ dataRoot: root, childPid: 123_456 }),
        { transport: sidecar, cancelAckWaitMs: 500 }
      );
      assert.equal(result.requested, false, "the handshake binds the exact bridge incarnation");
      assert.equal(result.detail, "bridge_unreachable");
    } finally {
      clearInterval(timer);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the request file carries the exact provider+job+generation+session identity", async () => {
  const root = tempRoot();
  try {
    const sidecar = new FakeSidecar([]);
    const pending = cancelWorkBuddyTurn(
      cancelInput({ jobId: "job-x", generation: 2, sessionId: "acp-x", dataRoot: root }),
      { transport: sidecar, cancelAckWaitMs: 600 }
    );
    const request = await waitFor(() => readTurnCancelRequest(root, "job-x", 2), 1000, "request file");
    assert.equal(request.kind, "turn_cancel");
    assert.equal(request.provider, WORKBUDDY_AI_PROVIDER);
    assert.equal(request.jobId, "job-x");
    assert.equal(request.generation, 2);
    assert.equal(request.sessionId, "acp-x");
    assert.match(request.requestId, /^[a-f0-9]{16}$/);
    assert.ok(Number.isFinite(Date.parse(request.requestedAt)));
    const result = await pending;
    assert.equal(result.requested, false, "nobody acknowledged it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable cancel channel is a truthful finite failure, never a guessed delivery", async () => {
  const root = tempRoot();
  try {
    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf8");
    const sidecar = new FakeSidecar([]);
    const result = await cancelWorkBuddyTurn(
      cancelInput({ dataRoot: blocker }),
      { transport: sidecar, cancelAckWaitMs: 300 }
    );
    assert.equal(result.requested, false);
    assert.equal(result.detail, "bridge_channel_unavailable");
    assert.equal(sidecar.calls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a delivered cancel with an unreachable sidecar is UNKNOWN attribution, never 'no work'", async () => {
  const root = tempRoot();
  try {
    const cwd = "C:/work";
    const cliPath = "C:/wb/cli";
    const bridge = startBridge(bridgeIdentity(root));
    try {
      const configDir = path.join(root, "empty-config");
      fs.mkdirSync(configDir, { recursive: true });
      const result = await cancelWorkBuddyTurn(
        cancelInput({ cliPath, cwd, dataRoot: root, childPid: process.pid }),
        { configDir, tmpDir: path.join(root, "tmp"), cancelAckWaitMs: 3000 }
      );
      assert.equal(result.requested, true, "the exact cancel was still DELIVERED through the bridge");
      assert.deepEqual(result.ownedRoots, []);
      assert.equal(result.ownershipUnknown, true, "the hosting root could not be named: UNKNOWN, not none");
      assert.equal(result.detail, "sidecar_unavailable");
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a delivered cancel whose runtime is not listed is UNKNOWN attribution, never 'no work'", async () => {
  const root = tempRoot();
  try {
    const cwd = "C:/work";
    const cliPath = "C:/wb/cli";
    const sidecar = new FakeSidecar([]);
    const bridge = startBridge(bridgeIdentity(root));
    try {
      const result = await cancelWorkBuddyTurn(
        cancelInput({ cliPath, cwd, dataRoot: root, childPid: process.pid }),
        { transport: sidecar, cancelAckWaitMs: 3000 }
      );
      assert.equal(result.requested, true);
      assert.deepEqual(result.ownedRoots, []);
      assert.equal(result.ownershipUnknown, true);
      assert.equal(result.detail, "runtime_not_found");
      assert.equal(sidecar.calls.length, 1);
      assert.equal(sidecar.calls[0]!.method, "session.list");
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancelWorkBuddyTurn reports an honest bounded diagnostic instead of a guessed cancel", async () => {
  const sidecar = new FakeSidecar([]);
  const cliPath = "C:/wb/cli";
  const cwd = "C:/work";

  // No session at all -> the provider owns nothing to cancel.
  assert.equal((await cancelWorkBuddyTurn(cancelInput({ sessionId: null }), { transport: sidecar })).detail, "no_provider_session");
  // No resolvable CLI -> no runtime identity, so no route.
  assert.equal((await cancelWorkBuddyTurn(cancelInput({ cliPath: null }), { transport: sidecar })).detail, "cli_unavailable");
  // Unsupported permission mode -> no runtime identity.
  assert.equal((await cancelWorkBuddyTurn(cancelInput({ permissionMode: "bogus" }), { transport: sidecar })).detail, "permission_mode_unsupported");
  assert.equal(sidecar.calls.length, 0, "none of these early no-route cases touched the sidecar");
});

// ---------------------------------------------------------------------------
// Generic lifecycle: the shared-slot rule is decided BEFORE any provider action
// ---------------------------------------------------------------------------

test("a shared execution slot is never touched: no provider cancel is even delivered", async () => {
  const job = makeJob({ id: "job-a", cwd: "C:/w", permissionMode: "plan" });
  const other = makeJob({ id: "job-b", cwd: "C:/w", permissionMode: "plan" });
  let cancelCalls = 0;
  const adapter = {
    id: WORKBUDDY_AI_PROVIDER,
    turnSlotKey: () => "slot-A",
    cancelTurn: async () => {
      cancelCalls += 1;
      return { route: "r", requested: true, sessionId: "acp-1", ownedRoots: [7], slotKey: "slot-A", detail: null };
    }
  } as unknown as ProviderAdapter;

  const request = await requestProviderTurnCancel("C:/root", job, { adapter, listJobsFn: () => [job, other] });
  assert.equal(cancelCalls, 0, "the shared slot's provider must not be asked to cancel anything");
  assert.equal(request.state, "unresolved");
  assert.equal(request.requested, false);
  assert.equal(request.detail, "shared_slot");
  assert.deepEqual(request.ownedRoots, []);
});

test("an exclusive slot requests the exact provider cancel and is marked exclusive", async () => {
  const job = makeJob({ id: "job-a", cwd: "C:/w", permissionMode: "plan" });
  const adapter = {
    id: WORKBUDDY_AI_PROVIDER,
    turnSlotKey: () => "slot-A",
    cancelTurn: async () => ({ route: "r", requested: true, sessionId: "acp-1", ownedRoots: [7], slotKey: "slot-A", detail: null })
  } as unknown as ProviderAdapter;

  const request = await requestProviderTurnCancel("C:/root", job, { adapter, listJobsFn: () => [job] });
  assert.equal(request.state, "requested");
  assert.equal(request.requested, true);
  assert.equal(request.exclusive, true);
  assert.deepEqual(request.ownedRoots, [7]);
});

// ---------------------------------------------------------------------------
// Generic lifecycle: resolving the provider-owned tool cleanup
// ---------------------------------------------------------------------------

function baseRequest(overrides: Partial<ProviderCancelRequest> = {}): ProviderCancelRequest {
  return {
    provider: WORKBUDDY_AI_PROVIDER,
    route: "r",
    state: "requested",
    requested: true,
    sessionId: "acp-1",
    survivingPids: [],
    detail: null,
    ownedRoots: [500],
    ownershipUnknown: false,
    exclusive: true,
    sinceMs: 1000,
    ...overrides
  };
}

test("resolveProviderOwnedTool distinguishes observed-then-gone, still-alive, none and unknown", async () => {
  const job = makeJob();
  const child: ProcessEntry = { pid: 700, ppid: 500, createdAtMs: 1500 };

  // Observed alive once, then gone -> the strongest evidence.
  let aliveOnce = true;
  const stopped = await resolveProviderOwnedTool(baseRequest(), job, {
    enumerateFn: async () => ({ ok: true, processes: [child] }),
    isAliveFn: () => {
      const value = aliveOnce;
      aliveOnce = false;
      return value;
    },
    delayFn: async () => {},
    waitMs: 5000,
    pollMs: 1
  });
  assert.equal(stopped.state, "owned_tool_stopped");

  // Still alive at the deadline -> unresolved, with the surviving pid as evidence.
  const alive = await resolveProviderOwnedTool(baseRequest(), job, {
    enumerateFn: async () => ({ ok: true, processes: [child] }),
    isAliveFn: () => true,
    delayFn: async () => {},
    waitMs: 0
  });
  assert.equal(alive.state, "unresolved");
  assert.equal(alive.detail, "owned_tool_alive");
  assert.deepEqual(alive.survivingPids, [700]);

  // Nothing scoped was ever visible -> a bounded negative snapshot.
  const none = await resolveProviderOwnedTool(baseRequest(), job, {
    enumerateFn: async () => ({ ok: true, processes: [] }),
    isAliveFn: () => true,
    delayFn: async () => {},
    waitMs: 1000
  });
  assert.equal(none.state, "no_owned_work");

  // A candidate whose creation time is unreported makes the scan unknown.
  const unknown = await resolveProviderOwnedTool(baseRequest(), job, {
    enumerateFn: async () => ({ ok: true, processes: [{ pid: 700, ppid: 500, createdAtMs: null }] }),
    isAliveFn: () => true,
    delayFn: async () => {},
    waitMs: 1000
  });
  assert.equal(unknown.state, "unresolved");
  assert.equal(unknown.detail, "owned_scan_unknown");
});

test("resolveProviderOwnedTool honours shared/no-root/no-start preconditions without scanning", async () => {
  const job = makeJob();
  let scanned = 0;
  const enumerateFn = async () => {
    scanned += 1;
    return { ok: true, processes: [] as ProcessEntry[] };
  };

  const shared = await resolveProviderOwnedTool(baseRequest({ exclusive: false }), job, { enumerateFn, waitMs: 0 });
  assert.equal(shared.state, "unresolved");
  assert.equal(shared.detail, "shared_slot");

  const noRoot = await resolveProviderOwnedTool(baseRequest({ ownedRoots: [] }), job, { enumerateFn, waitMs: 0 });
  assert.equal(noRoot.state, "no_owned_work");

  const noStart = await resolveProviderOwnedTool(baseRequest({ sinceMs: null }), job, { enumerateFn, waitMs: 0 });
  assert.equal(noStart.state, "unresolved");
  assert.equal(noStart.detail, "no_attempt_start");

  assert.equal(scanned, 0, "none of these preconditions required a process scan");
});

test("a matched runtime with no usable PID is UNKNOWN attribution, never 'no owned work'", async () => {
  const root = tempRoot();
  try {
    const cwd = "C:/work";
    const cliPath = "C:/wb/cli";
    const slotKey = workBuddyHostRuntimeId({ cliPath, permissionMode: "plan", effort: null, cwd });
    assert.ok(slotKey);
    // The runtime IS listed, but it published NO PID.
    const sidecar = new FakeSidecar([{ sessionId: slotKey, acpEndpoint: "http://127.0.0.1:5555/api/v1/acp" }]);
    const bridge = startBridge(bridgeIdentity(root, { jobId: "job-nopid" }));
    try {
      const raw = await cancelWorkBuddyTurn(
        cancelInput({ jobId: "job-nopid", cliPath, cwd, dataRoot: root, childPid: process.pid }),
        { transport: sidecar, cancelAckWaitMs: 3000 }
      );
      assert.equal(raw.requested, true, "the exact cancel was still delivered");
      assert.deepEqual(raw.ownedRoots, []);
      assert.equal(raw.ownershipUnknown, true);
      assert.equal(raw.detail, "runtime_pid_unavailable");

      const job = makeJob({ id: "job-nopid", cwd, permissionMode: "plan", sessionId: "acp-1", childPid: process.pid });
      const adapter = {
        id: WORKBUDDY_AI_PROVIDER,
        turnSlotKey: () => "slot-any",
        cancelTurn: (input: ProviderTurnCancelInput, deps: ProviderCancelDeps) =>
          cancelWorkBuddyTurn(input, { ...deps, transport: sidecar })
      } as unknown as ProviderAdapter;
      const request = await requestProviderTurnCancel(root, job, {
        adapter,
        listJobsFn: () => [job],
        env: { JOBQUAY_WORKBUDDY_AI_CLI_PATH: cliPath },
        cancelAckWaitMs: 3000
      });
      assert.equal(request.requested, true);
      assert.deepEqual(request.ownedRoots, []);
      assert.equal(request.ownershipUnknown, true);

      const resolved = await resolveProviderOwnedTool(request, job, {
        enumerateFn: async () => ({ ok: true, processes: [] }),
        isAliveFn: () => false,
        waitMs: 0
      });
      assert.equal(resolved.state, "unresolved", "an empty root list without PID proof must not read as 'no work'");
      assert.equal(providerCancelAllowsCancellation(resolved), false);
    } finally {
      bridge.stop();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicitly known empty owned-root list is still an honest 'no owned work'", async () => {
  const job = makeJob();
  const resolved = await resolveProviderOwnedTool(baseRequest({ ownedRoots: [], ownershipUnknown: false }), job, {
    enumerateFn: async () => ({ ok: true, processes: [] }),
    isAliveFn: () => false,
    waitMs: 0
  });
  assert.equal(resolved.state, "no_owned_work");
  assert.equal(providerCancelAllowsCancellation(resolved), true);
});

test("a throwing slot/config seam is reported no_route, never not_owned", async () => {
  const job = makeJob({ id: "job-throw", cwd: "C:/work", permissionMode: "plan" });
  const adapter = {
    id: WORKBUDDY_AI_PROVIDER,
    turnSlotKey: () => {
      throw new Error("seam boom");
    },
    cancelTurn: async () => ({ route: "r", requested: true, sessionId: "acp-1", ownedRoots: [7], slotKey: "s", detail: null })
  } as unknown as ProviderAdapter;
  const request = await requestProviderTurnCancel("C:/root", job, {
    adapter,
    listJobsFn: () => [job],
    env: { JOBQUAY_WORKBUDDY_AI_CLI_PATH: "C:/wb/cli" }
  });
  assert.equal(request.state, "no_route", "an unexpected failure is never `not_owned`");
  assert.equal(request.requested, false);
  assert.equal(providerCancelAllowsCancellation(request), false);
});

test("only a resolved cleanup backs a claimed cancellation", () => {
  const states = ["not_owned", "no_route", "requested", "owned_tool_stopped", "no_owned_work", "unresolved"] as const;
  const allowed = states.filter((state) =>
    providerCancelAllowsCancellation({ provider: WORKBUDDY_AI_PROVIDER, route: "r", state, requested: true, sessionId: "s", survivingPids: [], detail: null })
  );
  assert.deepEqual(allowed, ["not_owned", "owned_tool_stopped", "no_owned_work"]);
});
