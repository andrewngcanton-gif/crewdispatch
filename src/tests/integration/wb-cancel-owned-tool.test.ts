// wb-cancel-owned-tool.test.ts — REAL-PROCESS regression for the WorkBuddy
// cancellation orphan (JQ-20261006-58).
//
// THE DEFECT (observed on the installed host)
//   Claude called `crewdispatch_cancel` on a WorkBuddy AI job while a provider
//   tool was running. The job reached `cancelled` with `childPid: null` and the
//   disposable bridge had exited — but the TOOL process (a child of the
//   WorkBuddy Desktop sidecar's ACP runtime, NOT of CrewDispatch's tree) kept
//   running. Killing CrewDispatch's tree stopped the bridge only: on Windows the
//   tree kill is `taskkill /T /F`, which never delivers the SIGINT/SIGTERM the
//   bridge's own `session/cancel` handler waits for.
//
// THE INSTALLED CANCEL SEMANTICS (read locally from `codebuddy-headless.js`, and
// modelled by the fake runtime here): `session/cancel` is CONNECTION-scoped —
// the runtime aborts only the in-flight prompts of the connection that sent it
// (`cancelAllInFlightPrompts(connectionId, sessionId)`). A fresh auxiliary
// connection therefore cancels nothing. The ONLY connection that can cancel a
// turn is the ORIGINAL bridge connection that issued `session/prompt`.
//
// WHAT THIS FILE PROVES
//   * the explicit cancel reaches the runtime through the LIVE bridge's own ACP
//     connection (the production `AcpClient` + `TurnCancelChannel` run in the
//     disposable-bridge driver fixture), and the provider-owned tool cleanup is
//     RESOLVED before the job claims `cancelled`;
//   * a cancel on a FOREIGN connection is a no-op that leaves the owner's prompt
//     and tool untouched (the installed semantics the old fake did not model);
//   * a wrong-identity request (another session / generation) is never delivered
//     by the live bridge;
//   * with the bridge gone the route is still ATTEMPTED and fails closed: no
//     delivery, no `cancelled`, evidence retained, the tool survives;
//   * the owned tool (outside the disposable bridge tree) is really gone, while
//     an UNRELATED session's tool, the fake sidecar and its runtime survive —
//     nothing was killed broadly (no kill by node.exe, path or cwd, no
//     `session.kill` of the shared runtime);
//   * a shared provider slot (another live job in the same runtime) is never
//     touched; a repeat cancel is idempotent; a pending approval is retired.
//
// FIXTURE BOUNDARY (honest): the installed WorkBuddy DESKTOP app is replaced
// (its sidecar control pipe and its ACP runtime, including the installed
// connection-scoped cancel semantics), and the disposable bridge's MAIN WIRING
// (sidecar connect / host-runtime creation / terminal stream records) is
// replaced by the driver fixture. The bridge's ACP connection (`AcpClient`), its
// cancellation control protocol (`TurnCancelChannel`), the deterministic
// runtime id, the job service cancel path, the OS process table and the real
// Windows tree kill are the production ones. No real WorkBuddy process,
// credential, configuration or transcript is touched, and no LLM is dispatched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createJobRecord, requestCancel } from "../../jobs/service";
import { loadJob, saveJob, writeTreeConfirmation } from "../../jobs/store";
import { writePendingApproval, type PendingApproval } from "../../jobs/approval";
import { writeTurnCancelRequest } from "../../providers/workbuddy-ai/cancel-channel";
import { isPidAlive } from "../../runtime/process";
import { WORKBUDDY_AI_PROVIDER } from "../../providers/workbuddy-ai/index";
import { emptyUsage, type JobRecord } from "../../jobs/types";
import { jobResult } from "../../mcp/tools";
import {
  fakeHostRuntimeId,
  makeDisposableRoot,
  startFakeWorkBuddyDesktop,
  WB_CANCEL_BRIDGE_FIXTURE,
  type FakeDesktop
} from "../helpers/wb-cancel-desktop";

const DEAD_PID = 2 ** 31 - 1;
const ACP_SESSION = "acp-session-owned";
const OTHER_ACP_SESSION = "acp-session-unrelated";

interface Harness {
  root: string;
  cwd: string;
  cliPath: string;
  desktop: FakeDesktop;
  /** The ACP endpoint of the owned runtime (for the foreign-connection case). */
  endpoint: string;
  /** The REAL disposable-bridge driver process (production AcpClient + channel). */
  bridge: ChildProcess;
  bridgePid: number;
  /** The tool owned by THIS job's turn (outside the bridge tree). */
  toolPid: number;
  /** The unrelated session's tool (must survive every cancel). */
  sentinelPid: number;
  job: JobRecord;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

/**
 * Build one disposable, fully real scenario: a fake Desktop (sidecar + two
 * runtimes + two tools), the disposable-bridge DRIVER (a real process running
 * the production `AcpClient` and `TurnCancelChannel`), and a durable running
 * WorkBuddy AI job that owns it. The driver holds a real `session/prompt` open
 * on its own ACP connection before this resolves.
 */
async function buildHarness(opts: {
  /** Model a runtime that does NOT stop its tool after `session/cancel`. */
  ignoreCancel?: boolean;
  /** Add a second LIVE job sharing this provider slot (same cwd/permission/effort). */
  sharedSlotJob?: boolean;
  /** Seed a durable pending approval for the job's generation. */
  pendingApproval?: boolean;
  /** Model a runtime that answers `session/cancel` with an SSE reply. */
  sseReply?: boolean;
  /**
   * Seed the worker's NONTERMINAL intermediate hold (`orphaned` +
   * `provider_tool_unresolved` + a CURRENT unresolved result), the state a
   * worker leaves when the managed tree stopped but the provider-owned cleanup
   * could not yet be proven. The client's later confirmed cancellation must
   * clear that stale result (JQ-20261006-58 gen-3).
   */
  staleUnresolvedResult?: boolean;
} = {}): Promise<Harness> {
  // The turn (and therefore its tool) begins when the fake Desktop starts. The
  // attempt start is captured BEFORE that so the runtime's tool process falls
  // inside this generation's descendant scope (a tool created before the
  // generation is correctly treated as "not ours").
  const attemptStart = new Date();
  const root = makeDisposableRoot("jobquay-wbcancel-");
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd, { recursive: true });
  const cliPath = path.join(root, "WorkBuddyAI", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "", "utf8");

  const runtimeId = fakeHostRuntimeId({ cliPath, permissionMode: "plan", effort: null, cwd });
  const desktop = await startFakeWorkBuddyDesktop({
    root,
    cliPath,
    cwd,
    runtimes: [
      {
        runtimeSessionId: runtimeId,
        sessions: [{ acpSessionId: ACP_SESSION, ignoreCancel: opts.ignoreCancel === true }],
        sseReply: opts.sseReply === true
      },
      { runtimeSessionId: "unrelated-runtime-slot", sessions: [{ acpSessionId: OTHER_ACP_SESSION }] }
    ]
  });
  const ownedRuntime = desktop.runtimes[0];
  const otherRuntime = desktop.runtimes[1];
  if (!ownedRuntime || !otherRuntime) throw new Error("fixture did not report two runtimes");
  const endpointFile = JSON.parse(fs.readFileSync(ownedRuntime.endpointFile, "utf8")) as { port: number };
  const endpoint = `http://127.0.0.1:${endpointFile.port}/api/v1/acp`;

  const now = () => new Date();
  const at = now().toISOString();
  const base = createJobRecord({
    task: "run the fixture tool",
    cwd,
    provider: WORKBUDDY_AI_PROVIDER,
    permissionMode: "plan",
    model: "claude-sonnet-4-5"
  }, now);
  const job: JobRecord = {
    ...base,
    status: "running",
    startedAt: attemptStart.toISOString(),
    heartbeatAt: at,
    owner: `jobquay-${DEAD_PID}-0`,
    ownerPid: DEAD_PID,
    childPid: null,
    childGeneration: 0,
    sessionId: ACP_SESSION,
    attempts: [
      {
        generation: 0,
        startedAt: attemptStart.toISOString(),
        endedAt: null,
        exitCode: null,
        kind: null,
        failureKind: null,
        segment: false,
        resumedFrom: null,
        model: "claude-sonnet-4-5",
        modelSource: "explicit",
        effort: null,
        rateLimited: false,
        switched: false,
        switchToModel: null,
        usage: emptyUsage()
      }
    ]
  };
  if (opts.staleUnresolvedResult) {
    // The worker's intermediate NONTERMINAL hold, verbatim: the managed tree
    // stopped but the provider-owned cleanup was not yet proven, so the record
    // carries a CURRENT `provider_tool_unresolved` result. The client's later
    // confirmed cancellation must not let it survive into the terminal record.
    job.status = "orphaned";
    job.stopReason = "provider_tool_unresolved";
    job.failureKind = "provider_tool_unresolved";
    job.error =
      "Cancel was requested and the CrewDispatch-managed process tree stopped, but the provider-owned work of this turn (it runs outside that tree) cannot be confirmed stopped; " +
      "the cancellation evidence is retained and the job stays pending rather than falsely reporting cancellation.";
    job.result = { ok: false, subtype: null, kind: "provider_tool_unresolved", exitCode: 1, stopReason: "provider_tool_unresolved", finalText: null, fallbackEligible: false };
    job.approvalOutcome = "expired";
  }
  saveJob(root, job, now);

  // CrewDispatch's DISPOSABLE child: the REAL bridge driver process, whose tree
  // does NOT contain the tool (the tool belongs to the sidecar's runtime). It
  // opens the owner ACP connection and holds the turn's prompt in flight.
  const bridgeLog = path.join(root, "bridge-stdio.log");
  const bridge = spawn(
    process.execPath,
    [
      WB_CANCEL_BRIDGE_FIXTURE,
      "--endpoint-file", ownedRuntime.endpointFile,
      "--cwd", cwd,
      "--session-id", ACP_SESSION,
      "--job-id", job.id,
      "--generation", "0",
      "--data-root", root,
      "--result-file", path.join(root, "bridge-result.json")
    ],
    {
      cwd,
      stdio: ["ignore", fs.openSync(bridgeLog, "a"), fs.openSync(bridgeLog, "a")],
      windowsHide: true,
      env: desktop.env
    }
  );
  await waitFor(() => bridge.pid != null, 5000, "bridge pid");
  const bridgePid = bridge.pid as number;
  job.childPid = bridgePid;
  saveJob(root, job, now);

  // The turn is really in flight when the fake runtime holds the prompt.
  await waitFor(
    () => desktop.requestsOf(0).some((entry) => entry.method === "session/prompt" && entry.inflight === true),
    30000,
    "the bridge's prompt to be in flight"
  );

  if (opts.sharedSlotJob) {
    // A SECOND live CrewDispatch job in the same workspace with the same
    // permission/effort: it occupies the SAME provider slot (same runtime).
    const other: JobRecord = { ...job, id: `${job.id}-b`, status: "running", sessionId: OTHER_ACP_SESSION };
    saveJob(root, other, now);
  }

  if (opts.pendingApproval) {
    const approval: PendingApproval = {
      version: 1,
      kind: "tool_approval",
      provider: WORKBUDDY_AI_PROVIDER,
      jobId: job.id,
      generation: 0,
      requestId: "req-1",
      toolName: "Bash",
      summary: null,
      detail: { command: "node gate.cjs", description: null, path: null, cwd, args: [], title: null, gate: null, reason: null, truncated: false, redacted: false },
      options: [
        { id: "allow-once", kind: "allow_once", label: "Allow once" },
        { id: "reject-once", kind: "reject_once", label: "Reject" }
      ],
      createdAt: at,
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    };
    writePendingApproval(root, approval);
    job.pendingApproval = approval;
    saveJob(root, job, now);
  }

  return {
    root,
    cwd,
    cliPath,
    desktop,
    endpoint,
    bridge,
    bridgePid,
    toolPid: ownedRuntime.toolPids[0] as number,
    sentinelPid: otherRuntime.toolPids[0] as number,
    job,
    async stop(): Promise<void> {
      try {
        process.kill(bridgePid, "SIGKILL");
      } catch {}
      try {
        process.kill(ownedRuntime.runtimePid, "SIGKILL");
      } catch {}
      await desktop.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * A FOREIGN connection's cancel: a real ACP connection that did NOT send the
 * prompt (the shape the installed runtime treats as a silent no-op).
 */
async function foreignCancel(endpoint: string, sessionId: string): Promise<void> {
  const connect = await fetch(`${endpoint}/connect`, { method: "POST", headers: { "x-codebuddy-request": "1" } });
  assert.equal(connect.ok, true, "foreign /connect must succeed");
  const payload = (await connect.json()) as { connectionId: string; sessionToken: string };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-codebuddy-request": "1",
    "acp-connection-id": payload.connectionId,
    ...(payload.sessionToken ? { "acp-session-token": payload.sessionToken } : {})
  };
  const init = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  });
  assert.equal(init.ok, true, "foreign initialize must succeed");
  await init.arrayBuffer();
  const cancel = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })
  });
  assert.equal(cancel.ok, true, "the foreign cancel is HTTP-accepted (the no-op is in-protocol)");
  await cancel.arrayBuffer();
  await fetch(endpoint, { method: "DELETE", headers }).catch(() => undefined);
}

// The tool must be a process OUTSIDE the disposable bridge tree — this is the
// shape that the old tree-only cancel could never reach.
test("the owned tool is a child of the sidecar runtime, not of CrewDispatch's disposable bridge", { skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    assert.equal(isPidAlive(h.toolPid), true);
    assert.equal(isPidAlive(h.bridgePid), true);
    assert.equal(isPidAlive(h.desktop.sidecarPid), true);
    const parentOfTool = parentPidOf(h.toolPid);
    assert.equal(parentOfTool, h.desktop.runtimes[0]?.runtimePid, "the tool must be owned by the runtime");
    assert.notEqual(parentOfTool, h.bridgePid, "the tool must NOT be inside the disposable bridge tree");
  } finally {
    await h.stop();
  }
});

test("explicit cancel reaches the runtime through the ORIGINAL bridge connection and stops the owned tool", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    assert.equal(isPidAlive(h.toolPid), true, "precondition: the owned tool is running");
    assert.equal(isPidAlive(h.sentinelPid), true, "precondition: the unrelated tool is running");

    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 20000
    });

    // The exact session/turn was cancelled over the provider's own protocol...
    assert.ok(result.providerCancel, "a WorkBuddy job must report provider-owned cancel evidence");
    assert.equal(result.providerCancel?.route, "workbuddy-acp-session-cancel");
    assert.equal(result.providerCancel?.requested, true);
    assert.equal(result.providerCancel?.sessionId, ACP_SESSION);
    // ...and the owned cleanup was RESOLVED before the job claimed `cancelled`.
    assert.equal(result.providerCancel?.state, "owned_tool_stopped");
    assert.equal(result.job?.status, "cancelled");
    assert.equal(result.finalizedBy, "client");

    const seen = h.desktop.requestsOf(0);
    const cancels = seen.filter((entry) => entry.method === "session/cancel");
    assert.equal(cancels.length, 1, "exactly ONE cancel was sent");
    assert.equal(cancels[0]!.sessionId, ACP_SESSION, "the EXACT owned session was cancelled");
    assert.equal(cancels[0]!.owner, true, "the cancel travelled on the connection that owns the in-flight prompt");
    const promptIndex = seen.findIndex((entry) => entry.method === "session/prompt");
    const cancelIndex = seen.findIndex((entry) => entry.method === "session/cancel");
    assert.ok(promptIndex >= 0 && cancelIndex > promptIndex, "the prompt was in flight before the cancel");
    // Only ONE ACP connection was ever issued — the bridge's own. No auxiliary
    // connection is opened, and no anonymous request was ever refused.
    assert.equal(seen.filter((entry) => entry.method === "connect").length, 1, "no auxiliary ACP connection exists");
    assert.equal(seen.some((entry) => entry.rejected !== undefined), false, "no request was refused");
    // The runtime hosting another session was never asked for anything.
    assert.deepEqual(h.desktop.requestsOf(1), [], "another runtime's session must never be cancelled");
    // The shared runtime was never killed wholesale.
    assert.equal(fs.readFileSync(h.desktop.sessionKillLog, "utf8").trim(), "", "session.kill must never be called");

    assert.equal(isPidAlive(h.toolPid), false, "the owned tool must be stopped");
    assert.equal(isPidAlive(h.bridgePid), false, "the disposable bridge tree is still stopped");
    assert.equal(isPidAlive(h.sentinelPid), true, "the unrelated session's tool must survive");
    assert.equal(isPidAlive(h.desktop.sidecarPid), true, "the shared sidecar must survive");
    const runtime = h.desktop.runtimes[0];
    assert.ok(runtime);
    assert.equal(isPidAlive(runtime.runtimePid), true, "the shared runtime must survive");

    // Durable evidence of what was proven.
    const stored = loadJob(h.root, h.job.id);
    assert.equal(stored?.cancelCleanup?.state, "owned_tool_stopped");
    assert.equal(stored?.cancelCleanup?.sessionId, ACP_SESSION);
  } finally {
    await h.stop();
  }
});

test("a client-confirmed cancellation clears the worker's stale unresolved result (JQ-20261006-58 gen-3)", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness({ staleUnresolvedResult: true });
  try {
    // Precondition: the durable record carries the worker's intermediate hold —
    // nonterminal, with a CURRENT provider_tool_unresolved result.
    const seeded = loadJob(h.root, h.job.id);
    assert.equal(seeded?.status, "orphaned");
    assert.equal(seeded?.result?.kind, "provider_tool_unresolved");
    assert.equal(seeded?.approvalOutcome, "expired");

    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 20000
    });

    // The REAL provider cleanup was confirmed (the owned tool stopped outside
    // the bridge tree) and the client settled `cancelled`...
    assert.equal(result.providerCancel?.state, "owned_tool_stopped");
    assert.equal(result.finalizedBy, "client");
    assert.equal(result.job?.status, "cancelled");
    assert.equal(isPidAlive(h.toolPid), false, "the owned tool must be stopped");

    // ...and the terminal record carries the ESTABLISHED cancellation outcome:
    // no stale intermediate result, no per-attempt approval token.
    assert.equal(result.job?.result, null, "a proven cancellation carries NO result");
    const stored = loadJob(h.root, h.job.id);
    assert.ok(stored);
    assert.equal(stored.result, null, "the stale provider_tool_unresolved result must not survive the terminal write");
    assert.equal(stored.stopReason, "cancelled");
    assert.equal(stored.failureKind, null);
    assert.equal(stored.approvalOutcome ?? null, null);
    assert.equal(stored.cancelCleanup?.state, "owned_tool_stopped");
    assert.equal(stored.attempts.length, 1, "attempt/audit history is preserved");

    // The REAL MCP result payload serves the same durable facts.
    const served = await jobResult({ id: h.job.id }, { root: h.root, sleep: async () => undefined });
    const payload = JSON.parse((served.content[0] as { text: string }).text) as { status: string; terminal: boolean; result: unknown };
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.terminal, true);
    assert.equal(payload.result, null, "the served result payload must be consistent with the cancelled status");
  } finally {
    await h.stop();
  }
});

test("a cancel on a FOREIGN connection is a no-op: the owner's prompt and tool survive", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    assert.equal(isPidAlive(h.toolPid), true, "precondition: the owned tool is running");

    // The installed connection-scoped semantics: this connection has NO
    // in-flight prompt, so its cancel cancels nothing.
    await foreignCancel(h.endpoint, ACP_SESSION);
    await sleep(400);
    const seen = h.desktop.requestsOf(0);
    const foreign = seen.filter((entry) => entry.method === "session/cancel");
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0]!.owner, false, "the cancel came from a connection that owns no prompt");
    assert.equal(foreign[0]!.noop, true, "the runtime logged it as a no-op");
    assert.equal(isPidAlive(h.toolPid), true, "a foreign connection's cancel must NOT stop the owner's tool");
    assert.equal(isPidAlive(h.bridgePid), true, "the owner's bridge is untouched");

    // The production route — through the OWNER connection — still cancels.
    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 20000
    });
    assert.equal(result.providerCancel?.requested, true);
    assert.equal(result.providerCancel?.state, "owned_tool_stopped");
    assert.equal(result.job?.status, "cancelled");
    const after = h.desktop.requestsOf(0).filter((entry) => entry.method === "session/cancel");
    assert.equal(after.length, 2);
    assert.equal(after[1]!.owner, true, "the effective cancel is the one on the owner connection");
    assert.equal(isPidAlive(h.toolPid), false, "the owner-connection cancel stops the tool");
    assert.equal(isPidAlive(h.sentinelPid), true, "the unrelated tool must survive");
  } finally {
    await h.stop();
  }
});

test("a wrong-identity cancel request is never delivered by the live bridge", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    assert.equal(isPidAlive(h.toolPid), true, "precondition: the owned tool is running");

    // A stale/foreign request naming ANOTHER session, and one naming another
    // generation: the live bridge must ignore both (never deliver, never ack).
    writeTurnCancelRequest(h.root, {
      version: 1,
      kind: "turn_cancel",
      provider: WORKBUDDY_AI_PROVIDER,
      jobId: h.job.id,
      generation: 0,
      sessionId: "acp-session-foreign",
      requestId: "deadbeefdeadbeef",
      requestedAt: new Date().toISOString()
    });
    writeTurnCancelRequest(h.root, {
      version: 1,
      kind: "turn_cancel",
      provider: WORKBUDDY_AI_PROVIDER,
      jobId: h.job.id,
      generation: 7,
      sessionId: ACP_SESSION,
      requestId: "feedfacefeedface",
      requestedAt: new Date().toISOString()
    });
    await sleep(600);
    assert.equal(
      h.desktop.requestsOf(0).some((entry) => entry.method === "session/cancel"),
      false,
      "a wrong-identity request must never be delivered"
    );
    assert.equal(isPidAlive(h.toolPid), true, "the owned tool is untouched");
    assert.equal(isPidAlive(h.bridgePid), true, "the bridge is untouched");

    // The exact request still cancels through the SAME live bridge.
    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 20000
    });
    assert.equal(result.providerCancel?.requested, true);
    assert.equal(result.job?.status, "cancelled");
    assert.equal(isPidAlive(h.toolPid), false);
  } finally {
    await h.stop();
  }
});

test("with the bridge gone the provider route is still attempted and fails closed", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    // The disposable bridge is gone AND a managed-tree exit proof is already
    // persisted, so a tree-proof-only settle would skip the provider route. The
    // route must still run — and must fail CLOSED, because a dead bridge can no
    // longer relay a cancel over the only connection that could cancel.
    try {
      process.kill(h.bridgePid, "SIGKILL");
    } catch {}
    await waitFor(() => isPidAlive(h.bridgePid) === false, 10000, "bridge exit");
    const stored = loadJob(h.root, h.job.id);
    assert.ok(stored);
    stored!.heartbeatAt = "2000-01-01T00:00:00.000Z";
    saveJob(h.root, stored!, () => new Date());
    writeTreeConfirmation(h.root, h.job.id, 0, h.bridgePid, "os_tree_exited", "test");

    assert.equal(isPidAlive(h.toolPid), true, "precondition: the owned tool is running");

    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      thresholdMs: 0,
      env: h.desktop.env,
      providerCancelWaitMs: 3000,
      providerCancel: { cancelAckWaitMs: 700 }
    });

    assert.ok(result.providerCancel, "the provider route must be reached, not bypassed by tree proof");
    assert.equal(result.providerCancel?.requested, false, "a dead bridge cannot deliver the cancel");
    assert.equal(result.providerCancel?.state, "no_route");
    assert.equal(result.providerCancel?.detail, "bridge_unreachable", "the finite diagnostic names the missing acknowledgment");
    assert.notEqual(result.job?.status, "cancelled", "no delivery means no cancellation may be claimed");
    assert.equal(result.finalizedBy, "none");
    assert.equal(isPidAlive(h.toolPid), true, "the owned tool survives: nothing was falsely claimed");
    assert.equal(isPidAlive(h.sentinelPid), true, "the unrelated tool must survive");
    assert.equal(isPidAlive(h.desktop.sidecarPid), true, "the shared sidecar must survive");

    const after = loadJob(h.root, h.job.id);
    assert.equal(after?.cancelCleanup?.state, "no_route");
    assert.deepEqual(after?.cancelCleanup?.survivingPids, []);
  } finally {
    await h.stop();
  }
});

test("an unresolved provider-owned tool is never claimed as cancelled (evidence retained)", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  // The runtime ACCEPTS the owner cancel but does not stop its tool:
  // CrewDispatch may not then claim a complete cancellation.
  const h = await buildHarness({ ignoreCancel: true });
  try {
    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 3000
    });
    assert.equal(result.providerCancel?.requested, true, "the exact cancel was still delivered through the bridge");
    assert.equal(result.providerCancel?.state, "unresolved");
    assert.deepEqual(result.providerCancel?.survivingPids, [h.toolPid]);
    assert.notEqual(result.job?.status, "cancelled", "an unresolved owned tool must never be reported as cancelled");
    assert.equal(result.finalizedBy, "none");

    const stored = loadJob(h.root, h.job.id);
    assert.equal(stored?.cancelCleanup?.state, "unresolved");
    assert.deepEqual(stored?.cancelCleanup?.survivingPids, [h.toolPid]);
    assert.equal(stored?.cancelCleanup?.detail, "owned_tool_alive");
    // Nothing attempted a broad kill while unresolved.
    assert.equal(isPidAlive(h.sentinelPid), true);
    assert.equal(isPidAlive(h.desktop.sidecarPid), true);
  } finally {
    await h.stop();
  }
});

test("an SSE cancel reply is consumed and the owned tool still stops via the owner connection", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness({ sseReply: true });
  try {
    assert.equal(isPidAlive(h.toolPid), true, "precondition: the owned tool is running");

    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 20000
    });

    assert.equal(result.providerCancel?.requested, true);
    assert.equal(result.providerCancel?.state, "owned_tool_stopped");
    assert.equal(result.job?.status, "cancelled");
    assert.equal(isPidAlive(h.toolPid), false, "the owned tool must stop via the provider route");
    assert.equal(isPidAlive(h.sentinelPid), true);
  } finally {
    await h.stop();
  }
});

test("a provider slot shared with another live job is never touched (its tool survives)", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness({ sharedSlotJob: true });
  try {
    const result = await requestCancel(h.root, h.job.id, {
      by: "test-cancel",
      waitMs: 500,
      env: h.desktop.env,
      providerCancelWaitMs: 3000
    });
    assert.equal(result.providerCancel?.state, "unresolved");
    assert.equal(result.providerCancel?.detail, "shared_slot");
    assert.notEqual(result.job?.status, "cancelled");
    assert.equal(isPidAlive(h.toolPid), true, "a shared slot's processes must never be attributed or stopped");
    assert.equal(isPidAlive(h.desktop.sidecarPid), true);
    // No cancel was even delivered on the shared slot.
    assert.equal(h.desktop.requestsOf(0).some((entry) => entry.method === "session/cancel"), false);
  } finally {
    await h.stop();
  }
});

test("a repeat cancel is idempotent and never touches unrelated work", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness();
  try {
    const first = await requestCancel(h.root, h.job.id, { by: "test-cancel", waitMs: 500, env: h.desktop.env, providerCancelWaitMs: 20000 });
    assert.equal(first.job?.status, "cancelled");
    const second = await requestCancel(h.root, h.job.id, { by: "test-cancel", waitMs: 500, env: h.desktop.env, providerCancelWaitMs: 20000 });
    assert.equal(second.job?.status, "cancelled");
    assert.equal(second.finalizedBy, "none");
    assert.equal(second.kill.reason, "already_terminal");
    assert.equal(isPidAlive(h.sentinelPid), true, "the unrelated tool must still be alive");
    assert.equal(isPidAlive(h.desktop.sidecarPid), true);
  } finally {
    await h.stop();
  }
});

test("cancelling a pending approval retires it and still stops the owned tool", { timeout: 120000, skip: process.platform !== "win32" }, async () => {
  const h = await buildHarness({ pendingApproval: true });
  try {
    const approvalFile = path.join(h.root, "approval", `${h.job.id}.gen-0.req-1.request.json`);
    assert.equal(fs.existsSync(approvalFile), true, "precondition: a durable pending approval exists");
    const result = await requestCancel(h.root, h.job.id, { by: "test-cancel", waitMs: 500, env: h.desktop.env, providerCancelWaitMs: 20000 });
    assert.equal(result.job?.status, "cancelled");
    assert.equal(result.job?.pendingApproval, null, "a cancelled job can never still be waiting for an approval");
    assert.equal(fs.existsSync(approvalFile), false, "the durable approval request must be retired");
    assert.equal(isPidAlive(h.toolPid), false, "the owned tool must be stopped");
    assert.equal(isPidAlive(h.sentinelPid), true);
  } finally {
    await h.stop();
  }
});

/** The parent PID of one live process (Windows CIM), used to prove ownership. */
function parentPidOf(pid: number): number {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
    { encoding: "utf8", windowsHide: true, timeout: 20000 }
  );
  return Number(String(out).trim().split(/\r?\n/)[0]);
}
