import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { startJob, prepareContinuation, JobServiceError, providerManagedIgnoredPids } from "../jobs/service";
import { maintainProviderResources } from "../jobs/provider-maintenance";
import { recoverOrphanedAfterBoot, recoverTerminalHolders, reconcileAll } from "../jobs/reconcile";
import { ensureRoot, resolveDataRoot } from "../jobs/store";
import { isTerminalStatus, type JobRecord } from "../jobs/types";
import { evaluateWorkspace, workspaceJobFilter } from "../jobs/workspace";
import { captureProcessIdentity, readBootTime, type BootTimeReading } from "../runtime/process";
import { deliverTerminalNotification } from "../mcp/notify";
import { runNotificationMaintenance } from "../jobs/notifications";
import { resolveClaudeBinding } from "../claude/binding";
import { isValidClaudeBindingId, isValidClaudeSessionId } from "../claude/ids";
import { CLAUDE_SESSION_START_ORIGIN, runRecoveryPass } from "../jobs/recovery";
import {
  ensureDashboardOnDispatch,
  type DispatchDashboardRecord,
  type DispatchDashboardTrigger
} from "./dashboard-ensure";
import {
  DAEMON_META_VERSION,
  DAEMON_PROTOCOL_VERSION,
  type DaemonMeta,
  type DaemonRequest,
  type DaemonResponse
} from "./protocol";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 2000;
const RECONCILE_MS = 5000;
// TEST-ONLY: the controlled hosted fixtures can explicitly prove that their
// provider/worker processes never create descendants. Reuse the same marker the
// compiled worker harness already honors so the durable daemon's passive sweep
// does not start a real Windows CIM scan for those childless fixtures. Product
// config/tool schemas never emit this variable; real descendant acceptance tests
// explicitly set it to "0" and therefore still exercise the OS boundary.
const TEST_CHILDLESS_FIXTURE_SCAN_ENV = "JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN";

function args(argv: readonly string[]): { root: string } {
  let root: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = argv[i + 1]!;
      i += 1;
    }
  }
  if (!root) throw new Error("CrewDispatch daemon requires --root.");
  return { root };
}

function paths(root: string): { dir: string; meta: string } {
  const dir = path.join(root, "daemon");
  return { dir, meta: path.join(dir, "daemon.json") };
}

function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function wire(res: DaemonResponse): string {
  return JSON.stringify(res) + "\n";
}

export interface DaemonHandle {
  server: net.Server;
  root: string;
  meta: DaemonMeta;
  close: () => Promise<void>;
}

/**
 * The on-demand Dashboard ensure (see dashboard-ensure.ts). Swappable
 * so daemon-level tests can observe trigger timing without starting
 * a real Hub; production uses the shared orchestration directly.
 */
export type DaemonDashboardEnsure = (
  trigger: DispatchDashboardTrigger,
  context: {
    root: string;
    env: NodeJS.ProcessEnv;
    requestEnv: NodeJS.ProcessEnv | null | undefined;
    fixture: boolean;
  }
) => Promise<DispatchDashboardRecord>;

export interface StartDaemonOptions {
  /** Test seam: replaces the on-demand Dashboard ensure. */
  dashboardEnsure?: DaemonDashboardEnsure;
  /** Test seam for deterministic boot-session recovery evidence. */
  readBootTimeFn?: () => Promise<BootTimeReading>;
}

export async function startDaemon(rootInput: string, opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const root = resolveDataRoot(rootInput, process.env);
  ensureRoot(root);
  const p = paths(root);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  const selfIdentity = process.platform === "darwin" ? captureProcessIdentity(process.pid) : null;
  const meta: DaemonMeta = {
    version: DAEMON_META_VERSION,
    pid: process.pid,
    startedAtUs: selfIdentity?.createdAtUs ?? null,
    pgid: selfIdentity?.pgid ?? null,
    sid: selfIdentity?.sid ?? null,
    port: 0,
    token,
    startedAt,
    heartbeatAt: startedAt,
    serverPath: __filename
  };

  // The OS boot instant is stable for this daemon's lifetime (the process dies
  // at reboot), so one successful read is reused; a failed read is retried on
  // the next recovery call instead of being cached as a permanent failure.
  let bootReading: Promise<BootTimeReading> | null = null;
  const cachedBootTime = (): Promise<BootTimeReading> => {
    if (!bootReading) {
      bootReading = (opts.readBootTimeFn ?? readBootTime)().then((r) => {
        if (!r.ok) bootReading = null;
        return r;
      });
    }
    return bootReading;
  };

  /**
   * Bounded passive recovery for terminal workspace holders: it can only
   * PERSIST generation-bound evidence after independently proving a retained
   * tree stopped; it never kills, never rewrites a job record and never wakes a
   * terminal generation. Failures leave the holder in place (fail closed).
   */
  const recoverTerminalWorkspaces = async (input: {
    by: string;
    env?: NodeJS.ProcessEnv;
    includeJob?: (job: JobRecord) => boolean;
  }): Promise<void> => {
    try {
      const fixtureEnv = input.env ?? process.env;
      const childlessFixture = fixtureEnv[TEST_CHILDLESS_FIXTURE_SCAN_ENV] === "1";
      const enumerateFn = childlessFixture
        ? async () => ({ ok: true as const, processes: [] })
        : undefined;
      // The childless fixture seam is already stronger than a boot probe for
      // these controlled tests: their managed process is contractually known not
      // to create descendants. Avoid launching a separate Windows CIM boot query
      // merely to reach the empty descendant proof below. Product paths never set
      // this marker and continue to use the real boot evidence.
      const readBootTimeFn = childlessFixture
        ? async () => ({ ok: false as const, bootTimeMs: null, reason: "test_childless_fixture" })
        : cachedBootTime;
      await recoverTerminalHolders(root, {
        by: input.by,
        includeJob: input.includeJob,
        ignoredPidsFor: (job) => providerManagedIgnoredPids(job, fixtureEnv, root),
        readBootTimeFn,
        enumerateFn
      });
    } catch {
      // Recovery is best-effort; the authoritative admission/guard checks still run.
    }
  };
  /**
   * Darwin reboot recovery for an ACTIVE/non-terminal orphan. A previous sweep
   * (or the workspace evaluation immediately before admission) first converts a
   * provably dead owner into the shared orphaned state. Only an OS boot strictly
   * after that generation may then settle the retained managed tree.
   */
  const recoverOrphanedWorkspaces = async (input: {
    by: string;
    includeJob?: (job: JobRecord) => boolean;
  }): Promise<void> => {
    if (process.platform !== "darwin") return;
    try {
      const report = await recoverOrphanedAfterBoot(root, {
        by: input.by,
        includeJob: input.includeJob,
        readBootTimeFn: cachedBootTime
      });
      for (const job of report.changed) {
        void deliverTerminalNotification(root, job.id, {}, {
          generation: job.generation,
          by: "daemon-reboot-reconcile"
        }).catch(() => undefined);
      }
    } catch {
      // Unknown boot/identity facts leave the orphan in place (fail closed).
    }
  };

  let closing = false;
  // -------------------------------------------------------------------------
  // On-demand Dashboard (ordinary dispatch)
  // -------------------------------------------------------------------------
  // The ONE shared integration point: after a job has been AUTHORITATIVELY
  // admitted (start or continue), the daemon quietly ensures the shared Hub
  // for this data root. The response above is already sent, so the ensure
  // never extends the request deadline; it is fire-and-forget and deduplicated
  // (one in-flight attempt per broker), and any Hub failure is recorded as a
  // bounded local diagnostic — it can never fail, cancel, duplicate or wait
  // on the accepted dispatch. The broker owns the attempt, so it survives a
  // caller disconnect, and a later accepted dispatch can ensure again if the
  // Hub was stopped.
  const dashboardEnsure: DaemonDashboardEnsure = opts.dashboardEnsure ?? ensureDashboardOnDispatch;
  const triggerDispatchDashboard = (
    trigger: DispatchDashboardTrigger,
    requestEnv: NodeJS.ProcessEnv | null | undefined,
    fixture: boolean
  ): void => {
    // The ENTIRE optional startup invocation — including a synchronous
    // throw from the ensure helper (for example an invalid configured
    // HUB_PORT) — is deferred into a resolved promise, so the .catch
    // below is a true last line of defense: the on-demand Dashboard
    // can never break admission, duplicate a response, or take the
    // daemon down. The helper itself also never throws, but the daemon
    // does not depend on that contract alone.
    void Promise.resolve()
      .then(() => dashboardEnsure(trigger, { root, env: process.env, requestEnv, fixture }))
      .catch(() => {
        // Best-effort by contract: the on-demand Dashboard must never take
        // the broker down with it.
      });
  };
  // -------------------------------------------------------------------------
  // Bounded local notification recovery (verified SessionStart registrations)
  // -------------------------------------------------------------------------
  // At most ONE recovery pass per session runs at a time; an overlapping
  // request for the SAME session coalesces into ONE queued rerun carrying the
  // NEWEST binding id. The map is in-process only and disappears with the
  // daemon: the durable exclusive claims — not this map — are the cross-process
  // authority, so a coalesced-away or interrupted request can never double-send
  // or lose an allowance.
  const recoveryPasses = new Map<string, { running: boolean; queued: boolean; bindingId: string }>();
  const runRecoveryPassFor = async (sessionId: string, bindingId: string): Promise<void> => {
    const state = recoveryPasses.get(sessionId) ?? { running: false, queued: false, bindingId };
    state.bindingId = bindingId;
    if (state.running) {
      state.queued = true;
      recoveryPasses.set(sessionId, state);
      return;
    }
    state.running = true;
    state.queued = false;
    recoveryPasses.set(sessionId, state);
    try {
      do {
        state.queued = false;
        try {
          await runRecoveryPass(root, { sessionId, bindingId: state.bindingId, by: CLAUDE_SESSION_START_ORIGIN });
        } catch {
          // A pass is best-effort by contract: the durable claims and the next
          // verified registration remain authoritative.
        }
      } while (state.queued);
    } finally {
      recoveryPasses.delete(sessionId);
    }
  };

  // The caller half-closes its socket as soon as the request line is written
  // (`socket.end(...)` in the client). With the default `allowHalfOpen: false`
  // the broker socket would AUTO-END its writable side on that FIN and drop the
  // response of any handler that awaits real I/O before answering — which the
  // admission recovery now does. Keep the writable side open until `respond()`
  // explicitly ends it; every handler path answers exactly once.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let bytes = 0;
    let buf = "";
    let handled = false;
    const respond = (response: DaemonResponse): void => {
      try { socket.end(wire(response)); } catch { socket.destroy(); }
    };
    socket.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST_BYTES) {
        handled = true;
        respond({ version: 1, id: "", ok: false, op: "unknown", code: "request_too_large", message: "Daemon request exceeded the local safety limit." });
        return;
      }
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      void (async () => {
        let req: DaemonRequest;
        try {
          req = JSON.parse(buf.slice(0, nl)) as DaemonRequest;
        } catch {
          respond({ version: 1, id: "", ok: false, op: "unknown", code: "bad_request", message: "Invalid JSON request." });
          return;
        }
        if (req.version !== DAEMON_PROTOCOL_VERSION || req.token !== token || typeof req.id !== "string") {
          respond({ version: 1, id: typeof req.id === "string" ? req.id : "", ok: false, op: req.op ?? "unknown", code: "unauthorized", message: "Daemon request authentication/version failed." });
          return;
        }
        try {
          if (req.op === "ping") {
            respond({ version: 1, id: req.id, ok: true, op: "ping", result: { pong: true, pid: process.pid } });
            return;
          }
          if (req.op === "shutdown") {
            respond({ version: 1, id: req.id, ok: true, op: "shutdown", result: { stopped: true } });
            setImmediate(() => { void close(); });
            return;
          }
          if (req.op === "start") {
            const input = req.payload;
            // PASSIVE RECOVERY at the admission seam: before the authoritative
            // synchronous workspace check runs, revalidate any TERMINAL holder
            // of THIS exact directory. A finished task whose retained managed
            // tree has since been independently proven stopped releases its
            // workspace here, so an independent new dispatch is not blocked by
            // historical evidence forever. Nothing is killed or rewritten; a
            // live/unknown tree leaves the holder in place and the dispatch is
            // refused with `workspace_busy` exactly as before.
            await recoverTerminalWorkspaces({
              by: "daemon-admission",
              env: input.env,
              includeJob: workspaceJobFilter(input.cwd)
            });
            // Reconcile the exact workspace once so a stale pre-reboot running
            // record becomes the shared orphaned state before the boot proof is
            // considered. A live owner remains untouched.
            evaluateWorkspace(root, input.cwd);
            await recoverOrphanedWorkspaces({
              by: "daemon-admission-reboot",
              includeJob: workspaceJobFilter(input.cwd)
            });
            const result = startJob({
              root,
              task: input.task,
              cwd: input.cwd,
              model: input.model,
              permissionMode: input.permissionMode,
              effort: input.effort,
              provider: input.provider,
              runner: input.runner,
              fixturePath: input.fixturePath,
              cliPath: input.cliPath,
              workerScript: input.workerScript,
              env: input.env,
              notifyTarget: input.notifyTarget
            });
            respond({ version: 1, id: req.id, ok: true, op: "start", result: { job: result.job, workerPid: result.workerPid } });
            // The job is authoritatively accepted: quietly ensure the
            // shared Hub (off the response path — see the trigger helper).
            triggerDispatchDashboard(
              "start",
              input.env,
              input.runner === "fixture" || input.fixturePath != null
            );
            return;
          }
          if (req.op === "continue") {
            const input = req.payload;
            const result = await prepareContinuation({
              root,
              jobId: input.jobId,
              task: input.task,
              fixturePath: input.fixturePath,
              cliPath: input.cliPath,
              workerScript: input.workerScript,
              env: input.env,
              notifyTarget: input.notifyTarget,
              messageSource: input.messageSource
            });
            if (!result.ok) {
              respond({ version: 1, id: req.id, ok: false, op: "continue", code: result.code, message: result.error });
              return;
            }
            respond({ version: 1, id: req.id, ok: true, op: "continue", result: { job: result.job, workerPid: result.workerPid } });
            // Same shared integration for continuation: the accepted
            // follow-up also ensures the Hub (idempotent reuse when healthy).
            triggerDispatchDashboard("continue", input.env, input.fixturePath != null);
            return;
          }
          if (req.op === "recover") {
            const input = req.payload;
            const sessionId = input?.sessionId;
            const bindingId = input?.bindingId;
            if (!isValidClaudeSessionId(sessionId) || !isValidClaudeBindingId(bindingId)) {
              respond({
                version: 1,
                id: req.id,
                ok: false,
                op: "recover",
                code: "invalid_reference",
                message: "A recovery request must carry the opaque session id and binding id of a local caller registration."
              });
              return;
            }
            // VALIDATED ADMISSION: the named binding must still be the CURRENT
            // registration of that exact session. A stale request can therefore
            // never claim or send on behalf of a newer binding's budget.
            const current = resolveClaudeBinding(root, { bindingId, sessionId });
            if (!current || current.bindingId !== bindingId || current.sessionId !== sessionId) {
              respond({
                version: 1,
                id: req.id,
                ok: false,
                op: "recover",
                code: "stale_binding",
                message: "The named binding is not the current registration of that session; no recovery pass was started."
              });
              return;
            }
            // Acknowledge the validated admission PROMPTLY, then run the finite
            // pass off the request path: the requesting hook never waits for it.
            respond({ version: 1, id: req.id, ok: true, op: "recover", result: { accepted: true } });
            setImmediate(() => { void runRecoveryPassFor(sessionId, bindingId); });
            return;
          }
          const unknown = req as unknown as { id?: unknown };
          respond({
            version: 1,
            id: typeof unknown.id === "string" ? unknown.id : "",
            ok: false,
            op: "unknown",
            code: "unknown_operation",
            message: "Unknown CrewDispatch daemon operation."
          });
        } catch (e) {
          const code = e instanceof JobServiceError ? e.code : "daemon_operation_failed";
          respond({
            version: 1,
            id: req.id,
            ok: false,
            op: req.op,
            code,
            message: String((e as Error)?.message || e)
          });
        }
      })();
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CrewDispatch daemon could not obtain its loopback port.");
  meta.port = address.port;

  const writeHeartbeat = (): void => {
    // Test/temp roots and uninstalled artifacts can disappear underneath a
    // long-lived broker. Never recreate a deleted data root just to keep a
    // stale daemon alive: shut down cleanly instead.
    if (!fs.existsSync(root) || !fs.existsSync(p.dir)) {
      setImmediate(() => { void close(); });
      return;
    }
    meta.heartbeatAt = new Date().toISOString();
    try { atomicJson(p.meta, meta); } catch {}
  };
  writeHeartbeat();
  const heart = setInterval(writeHeartbeat, HEARTBEAT_MS);
  heart.unref();
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling || closing) return;
    reconciling = true;
    try {
      const swept = reconcileAll(root);
      for (const job of swept.changed) {
        if (!isTerminalStatus(job.status)) continue;
        try {
          await deliverTerminalNotification(root, job.id, {}, { generation: job.generation, by: "daemon-reconcile" });
        } catch {
          // Delivery records its own failure and never changes the terminal job.
        }
      }
      // A stale running record from a previous boot is now orphaned. Darwin's
      // boot identity can safely settle that old managed tree without signalling
      // any current process that may have reused the old PID.
      await recoverOrphanedWorkspaces({ by: "daemon-reboot-sweep" });
      // PASSIVE RECOVERY during the sweep: terminal records that still retain
      // unresolved child evidence are revalidated with at most one boot read
      // and one process-table enumeration, so a workspace whose retained tree
      // has genuinely exited frees itself even without a new dispatch.
      await recoverTerminalWorkspaces({ by: "daemon-sweep" });
      await maintainProviderResources(root);
      // ONE generic shared maintenance pass (bounded, best-effort, local). The
      // registered adapters decide what to reap; the daemon holds no
      // caller-specific deletion logic. A failure is caught by the shared entry
      // and can never block reconciliation.
      await runNotificationMaintenance(root, {});
    } catch {
      // Reconciliation is best-effort; request handling must remain available.
    } finally {
      reconciling = false;
    }
  };
  const reconcileTimer = setInterval(() => { void reconcile(); }, RECONCILE_MS);
  reconcileTimer.unref();

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(heart);
    clearInterval(reconcileTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      const current = JSON.parse(fs.readFileSync(p.meta, "utf8")) as { pid?: unknown };
      if (current.pid === process.pid) fs.unlinkSync(p.meta);
    } catch {}
  };

  process.once("SIGTERM", () => { void close().finally(() => { process.exitCode = 0; }); });
  process.once("SIGINT", () => { void close().finally(() => { process.exitCode = 0; }); });

  return { server, root, meta, close };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<DaemonHandle> {
  return await startDaemon(args(argv).root);
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(`[jobquay-daemon] ${String((e as Error)?.stack || (e as Error)?.message || e)}`);
    process.exitCode = 1;
  });
}
