// tools.ts — the CrewDispatch MCP tool handlers, independent of the MCP SDK so they
// can be unit-tested directly. The SDK wiring lives in server.ts.
//
// Every handler:
//   * validates its inputs and returns a STABLE error code (never a raw stack);
//   * passes the caller's `task` to the official CLI UNCHANGED — no prompt is
//     assembled, prefixed or guessed here (the product appends no boilerplate);
//   * returns only the bounded, whitelisted views from view.ts.
import path from "node:path";
import fs from "node:fs";
import {
  JobServiceError,
  getStatus,
  requestCancel
} from "../jobs/service";
import { continueJobViaDaemon, JobDaemonError, startJobViaDaemon } from "../daemon/client";
import { reconcileAll } from "../jobs/reconcile";
import { JobStoreError, listJobs, readNotificationResult, resolveDataRoot, withMergedNotifications, writeTerminalReadReceipt } from "../jobs/store";
import { isTerminalStatus, type JobRecord } from "../jobs/types";
import { ConfigError, configPatchFromSnake, configView, updateConfig } from "../config/schema";
import { readSettings } from "../config/settings";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { DeliveryDeps } from "./notify";
import { NotifyInputError, deliverTerminalNotification, resolveNotifyTarget } from "./notify";
import { compactJob, compactResult, compactSummary, isDowngraded, MCP_MAX_LIST } from "./view";
import { claimDashboardFirstUseHint } from "../onboarding/dashboard-hint";

/** MCP-shaped tool result — the official SDK's own result type. */
export type ToolResult = CallToolResult;

export function toolJson(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function toolError(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, message }, null, 2) }], isError: true };
}

export interface ToolDeps {
  /** Explicit data root; defaults to `JOBQUAY_DATA_ROOT` / the product default. */
  root?: string | null;
  env?: NodeJS.ProcessEnv;
  /** TEST-ONLY controlled executable (never exposed through the tool schema). */
  fixturePath?: string | null;
  cliPath?: string | null;
  workerScript?: string;
  /** Delivery seams (tests inject a spawn/HTTP stub). */
  notify?: DeliveryDeps;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Hard cap for a blocking `run` wait; the job keeps running past it. */
export const MAX_RUN_WAIT_SECONDS = 120;

/**
 * A terminal wake is delivered by the worker before its generation-scoped
 * delivery result file is written. A woken Codex client can therefore call
 * `jobquay_result` in the few milliseconds between those two events. Keep that
 * ONE result call local and briefly wait for the already-in-flight diagnostic to
 * settle instead of forcing the cloud caller to poll/retry.
 */
export const RESULT_NOTIFY_SETTLE_MS = 1500;
const RESULT_NOTIFY_SETTLE_STEP_MS = 25;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function optString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The optional per-job reasoning effort, preserving the caller's intent:
 * an ABSENT key returns `undefined` so the resolved primary keeps the
 * configured effort that belongs to its source; an explicit null/blank returns
 * `null` (the provider/model default). The distinction is what lets a caller
 * ask for "the model default" without also changing the saved settings.
 */
function optEffort(args: Record<string, unknown>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, "effort")) return undefined;
  const v = args["effort"];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function requireString(args: Record<string, unknown>, key: string, code: string): string | ToolResult {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) return toolError(code, `Missing required field ${key}.`);
  return v;
}

/** Validate a cwd the same way the runner will: it must exist and be a directory. */
function validateCwd(cwd: string): string | null {
  try {
    return fs.statSync(cwd).isDirectory() ? null : `The working directory does not exist or is not a directory: ${cwd}`;
  } catch {
    return `The working directory does not exist or is not a directory: ${cwd}`;
  }
}

function notifyFromArgs(args: Record<string, unknown>, deps: ToolDeps): ReturnType<typeof resolveNotifyTarget> | ToolResult {
  try {
    return resolveNotifyTarget({
      callbackUrl: args.callback_url,
      codexThreadId: args.codex_thread_id,
      claudeSessionId: args.claude_session_id,
      claudeBindingId: args.claude_binding_id,
      env: deps.env
    });
  } catch (e) {
    if (e instanceof NotifyInputError) return toolError(e.code, e.message);
    throw e;
  }
}

function isToolResult(v: unknown): v is ToolResult {
  return typeof v === "object" && v !== null && Array.isArray((v as ToolResult).content);
}

function root(deps: ToolDeps): string {
  return resolveDataRoot(deps.root, deps.env ?? process.env);
}

/**
 * Perform the one generation-scoped terminal wake for a job that this MCP entry
 * observed reaching a terminal state (a reconciliation of a stale dead-owner job,
 * or a recovery read of a terminal generation whose worker never woke).
 *
 * It is safe to call on any job: a non-terminal job is a no-op, an already
 * attempted generation is a no-op (at-most-once claim), and a delivery failure
 * is RECORDED without ever changing the job's terminal outcome. No daemon runs
 * here — a dead-owner job that is NEVER read through an MCP entry is not woken
 * automatically (a documented product boundary).
 */
async function wakeIfTerminal(rootDir: string, job: JobRecord, deps: ToolDeps): Promise<void> {
  if (!isTerminalStatus(job.status)) return;
  try {
    await deliverTerminalNotification(rootDir, job.id, deps.notify ?? {}, { by: "mcp" });
  } catch {
    /* recorded internally; never changes the terminal outcome */
  }
}

/**
 * After a terminal wake, allow its result side-car to become visible before the
 * one-shot result response is rendered. This is a bounded LOCAL filesystem wait
 * inside the existing MCP call — never a repeated MCP/cloud status poll.
 *
 * If this MCP process itself owns delivery, `wakeIfTerminal` already waited for
 * the delivery and wrote the side-car, so this returns immediately. The wait is
 * only relevant when another process (normally the detached worker) holds the
 * generation claim and is between external delivery and its atomic result write.
 */
async function settleTerminalWakeResult(rootDir: string, job: JobRecord, deps: ToolDeps): Promise<void> {
  if (!isTerminalStatus(job.status)) return;
  if (readNotificationResult(rootDir, job.id, job.generation)) return;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = Math.ceil(RESULT_NOTIFY_SETTLE_MS / RESULT_NOTIFY_SETTLE_STEP_MS);
  for (let i = 0; i < attempts; i += 1) {
    await sleep(RESULT_NOTIFY_SETTLE_STEP_MS);
    if (readNotificationResult(rootDir, job.id, job.generation)) return;
  }
}

/**
 * Durably record that the REAL terminal result entry served this exact
 * `(job, generation)` — the per-generation terminal RESULT-READ receipt.
 *
 * It is written at the result entry ONLY (never by a status/list/Hub view), and
 * it means "result collected / request served": NEVER "accepted", and never
 * proof that the caller rendered the payload. The bounded recovery path uses it
 * to suppress a recovered wake for an already-collected generation.
 *
 * A write FAILURE is returned EXPLICITLY (stable code + bounded message) so the
 * caller can see that the dedup guarantee was not established; the result
 * itself is still returned — manual result access always keeps working.
 */
function recordTerminalReadReceipt(rootDir: string, job: JobRecord, by: string): Record<string, unknown> | null {
  if (!isTerminalStatus(job.status)) return null;
  try {
    writeTerminalReadReceipt(rootDir, job.id, job.generation, by, undefined);
    return null;
  } catch (e) {
    const code = e instanceof JobStoreError ? e.code : "receipt_write_failed";
    return { recorded: false, code, message: String((e as Error)?.message || e).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  result: ToolResult;
  jobId: string | null;
  dashboardHint: string | null;
}

/** Shared dispatch body: validate, persist the job, launch it through the independent local daemon. */
async function spawnInternal(args: unknown, deps: ToolDeps): Promise<SpawnOutcome> {
  const a = asRecord(args);
  const task = requireString(a, "task", "empty_task");
  if (isToolResult(task)) return { result: task, jobId: null, dashboardHint: null };
  const cwdRaw = requireString(a, "cwd", "missing_cwd");
  if (isToolResult(cwdRaw)) return { result: cwdRaw, jobId: null, dashboardHint: null };
  const cwd = path.resolve(cwdRaw);
  const cwdError = validateCwd(cwd);
  if (cwdError) return { result: toolError("invalid_cwd", cwdError), jobId: null, dashboardHint: null };
  const target = notifyFromArgs(a, deps);
  if (isToolResult(target)) return { result: target, jobId: null, dashboardHint: null };

  // Optional provider. Omission means Command Code; WorkBuddy AI is selected
  // explicitly. Unknown providers are rejected by the MCP schema and again by
  // the job service before any record is persisted.
  const providerRaw = optString(a, "provider");
  const provider = providerRaw && providerRaw.trim() ? providerRaw.trim() : null;

  try {
    const rootDir = root(deps);
    const result = await startJobViaDaemon(rootDir, {
      task,
      cwd,
      model: optString(a, "model"),
      permissionMode: optString(a, "permission_mode"),
      effort: optEffort(a),
      provider: provider ?? undefined,
      // A controlled fixture replaces the production runner only in tests.
      runner: deps.fixturePath ? "fixture" : undefined,
      fixturePath: deps.fixturePath,
      cliPath: deps.cliPath,
      workerScript: deps.workerScript,
      env: deps.env,
      notifyTarget: target
    });
    const dashboardHint = claimDashboardFirstUseHint(rootDir);
    return {
      result: toolJson({
        ok: true,
        accepted: true,
        job_id: result.job.id,
        provider: result.job.provider,
        status: result.job.status,
        generation: result.job.generation,
        notify: { kind: target.kind, source: target.source },
        ...(dashboardHint ? { dashboard_hint: dashboardHint } : {})
      }),
      jobId: result.job.id,
      dashboardHint
    };
  } catch (e) {
    // A stable service error (e.g. `config_invalid`) is surfaced with its own code
    // instead of being flattened into a generic spawn failure.
    if (e instanceof JobServiceError || e instanceof JobDaemonError) {
      return { result: toolError(e.code, e.message), jobId: null, dashboardHint: null };
    }
    return { result: toolError("spawn_failed", String((e as Error)?.message || e)), jobId: null, dashboardHint: null };
  }
}

/** Async dispatch: persist the job, launch a detached worker, return the id fast. */
export async function spawnJob(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  return (await spawnInternal(args, deps)).result;
}

/** One-shot status of one job, or a bounded list of all jobs. */
export async function jobStatus(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const a = asRecord(args);
  const id = optString(a, "id");
  const r = root(deps);
  if (id) {
    const job = getStatus(r, id);
    if (!job) return toolError("not_found", `Job not found: ${id}.`);
    // A read can be the moment a stale dead-owner job is reconciled terminal; the
    // entry that wrote that terminal state owns the one generation-scoped wake.
    await wakeIfTerminal(r, job, deps);
    return toolJson({ ok: true, job: compactJob(withMergedNotifications(r, job)) });
  }
  const swept = reconcileAll(r);
  for (const job of swept.changed) await wakeIfTerminal(r, job, deps);
  const { jobs, unreadable } = listJobs(r);
  const capped = jobs.slice(-MCP_MAX_LIST);
  return toolJson({
    ok: true,
    count: jobs.length,
    truncated: jobs.length > capped.length,
    unreadable: unreadable.slice(0, MCP_MAX_LIST),
    jobs: capped.map(compactSummary)
  });
}

/**
 * The short, stable ADVISORY attached to a TERMINAL result view — and only
 * there. It names the ACTUAL current job id and states the product default:
 * when acceptance finds defects in the SAME objective, continue the existing
 * job with `crewdispatch_follow_up` and a precise repair packet, while
 * `crewdispatch_spawn` is for an independent new objective. The exception is an
 * external controller that owns acceptance: only its explicit repair
 * instruction permits a follow-up.
 *
 * It is guidance only: the advisory adds no automatic dispatch, continuation
 * or retry. (`jobResult` still performs its EXISTING one-shot terminal-wake
 * recovery — `wakeIfTerminal` + `settleTerminalWakeResult`, before the payload
 * is built — which may deliver a missing generation-scoped wake; that path is
 * unchanged.) A cancelled/interrupted job is not an acceptance outcome and is
 * never presented as automatically resumable — resuming it requires authorized
 * remaining work. A non-terminal job carries no terminal acceptance guidance at
 * all (null).
 */
export function continuationHint(job: Pick<JobRecord, "id" | "status">): string | null {
  if (!isTerminalStatus(job.status)) return null;
  const external = "When an external controller owns acceptance, only its explicit repair instruction permits a follow-up.";
  if (job.status === "cancelled" || job.status === "interrupted") {
    return (
      `Job ${job.id} ended ${job.status}; this is not an acceptance outcome and it is not resumed automatically. ` +
      `crewdispatch_follow_up on this same job requires authorized remaining work; crewdispatch_spawn is for an independent new objective. ${external}`
    );
  }
  return (
    `If acceptance of job ${job.id} finds defects in the SAME objective, default to crewdispatch_follow_up on this same job with a precise repair packet; ` +
    `crewdispatch_spawn is for an independent new objective. ${external}`
  );
}

/** One-shot compact result: terminal result when settled, otherwise the status. */
export async function jobResult(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const a = asRecord(args);
  const id = requireString(a, "id", "missing_id");
  if (isToolResult(id)) return id;
  const r = root(deps);
  const job = getStatus(r, id);
  if (!job) return toolError("not_found", `Job not found: ${id}.`);
  await wakeIfTerminal(r, job, deps);
  await settleTerminalWakeResult(r, job, deps);
  const view = compactJob(withMergedNotifications(r, job));
  const hint = continuationHint(job);
  // The terminal result was CONSTRUCTED and settled above; the durable
  // per-generation read receipt is recorded immediately before the payload is
  // returned. A receipt failure is reported explicitly and never blocks the
  // result itself.
  const receipt = recordTerminalReadReceipt(r, job, "mcp-result");
  return toolJson({
    ok: true,
    job_id: job.id,
    provider: job.provider,
    status: job.status,
    terminal: isTerminalStatus(job.status),
    generation: job.generation,
    // The model that produced this outcome, the resolved candidate chain and
    // whether the model was DOWNGRADED (so a caller can see a rate-limit
    // fallback happened without reading the raw record).
    model: job.model,
    model_source: job.modelSource,
    model_chain: [...job.modelChain],
    downgraded: isDowngraded(job),
    // The bounded in-flight boundary-switch audit (no task/session/credential).
    switch: view.switch,
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    result: compactResult(job),
    usage: job.usage,
    error: view.error,
    notify: view.notify,
    // Advisory only, terminal results only: the same-objective repair default
    // and the external-controller exception (see `continuationHint`).
    ...(hint ? { continuation_hint: hint } : {}),
    ...(receipt ? { result_read_receipt: receipt } : {})
  });
}

/** Follow-up on the SAME logical job/session (a new generation, `--resume`). */
export async function followUpJob(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const a = asRecord(args);
  const id = requireString(a, "id", "missing_id");
  if (isToolResult(id)) return id;
  const message = requireString(a, "message", "missing_message");
  if (isToolResult(message)) return message;

  // A follow-up stays on the SAME logical job/wake target: only an EXPLICIT new
  // callback_url/codex_thread_id/claude_session_id/claude_binding_id replaces
  // the persisted target. When none is given the job keeps the target it was
  // dispatched with (never silently reset).
  const explicitTarget =
    a.callback_url != null || a.codex_thread_id != null || a.claude_session_id != null || a.claude_binding_id != null;
  let target: ReturnType<typeof resolveNotifyTarget> | null = null;
  if (explicitTarget) {
    const resolved = notifyFromArgs(a, deps);
    if (isToolResult(resolved)) return resolved;
    target = resolved;
  }

  try {
    const result = await continueJobViaDaemon(root(deps), {
      jobId: id,
      task: message,
      fixturePath: deps.fixturePath,
      cliPath: deps.cliPath,
      workerScript: deps.workerScript,
      env: deps.env,
      ...(target ? { notifyTarget: target } : {})
    });
    return toolJson({
      ok: true,
      accepted: true,
      job_id: result.job.id,
      status: result.job.status,
      generation: result.job.generation,
      notify: { kind: result.job.notifyTarget.kind, source: result.job.notifyTarget.source }
    });
  } catch (e) {
    if (e instanceof JobDaemonError || e instanceof JobServiceError) return toolError(e.code, e.message);
    return toolError("continuation_failed", String((e as Error)?.message || e));
  }
}

/** Explicit cancel; the only path that may terminate a running job early. */
export async function cancelJob(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const a = asRecord(args);
  const id = requireString(a, "id", "missing_id");
  if (isToolResult(id)) return id;
  const waitRaw = a.wait_seconds;
  let waitMs = 5000;
  if (waitRaw != null) {
    const n = Number(waitRaw);
    if (!Number.isFinite(n) || n < 0 || n > 60) return toolError("invalid_wait_seconds", "wait_seconds must be a number between 0 and 60.");
    waitMs = Math.round(n * 1000);
  }
  const r = root(deps);
  const result = await requestCancel(r, id, {
    by: "mcp",
    waitMs,
    notify: deps.notify
  });
  if (!result.job) return toolError("not_found", `Job not found: ${id}.`);
  const job: JobRecord = result.job;
  // A cancel can finalise a stale dead-owner job by reconciliation; wake that
  // terminal generation once (idempotent with the worker's own wake).
  await wakeIfTerminal(r, job, deps);
  return toolJson({
    ok: true,
    job_id: job.id,
    status: job.status,
    cancelled: job.status === "cancelled",
    kill: { scope: result.kill.scope, confirmed: result.kill.confirmed, pid: result.kill.pid },
    finalized_by: result.finalizedBy,
    // Evidence of the provider-owned turn cancellation (JQ-20261006-58): null
    // when the provider owns no out-of-tree work for this job.
    provider_cancel: result.providerCancel
      ? {
          state: result.providerCancel.state,
          route: result.providerCancel.route,
          session_id: result.providerCancel.sessionId,
          surviving_pids: result.providerCancel.survivingPids,
          detail: result.providerCancel.detail
        }
      : null
  });
}

// ---------------------------------------------------------------------------
// Settings (config read/write)
// ---------------------------------------------------------------------------

/**
 * Read the CrewDispatch configuration: the stored values, the official CLI status and
 * how it was found, the model catalog source/refresh time, the model effective
 * right now, and any stale configured model id.
 *
 * `rate_limit_fallback` remains ACTIVE. Time-of-day schedules and in-flight
 * clock-boundary switching are currently disabled for every provider; legacy
 * persisted schedule fields are ignored by runtime selection.
 */
export async function settingsGet(_args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const result = await readSettings(root(deps), { env: deps.env, now: deps.now });
  if (!result.ok) {
    const where = result.field ? ` (field: ${result.field})` : "";
    return toolError(result.code, `${result.message}${where}`);
  }
  return toolJson(result.view);
}

/**
 * Update the current CrewDispatch Command Code configuration. Time-of-day schedules
 * and in-flight clock-boundary switching are disabled product features and are
 * rejected here even though legacy config files may still contain those fields.
 * Invalid values leave the stored file untouched.
 */
export function settingsUpdate(args: unknown, deps: ToolDeps = {}): ToolResult {
  try {
    const input = asRecord(args);
    if (Object.prototype.hasOwnProperty.call(input, "time_slots") || Object.prototype.hasOwnProperty.call(input, "in_flight_switch")) {
      return toolError("feature_disabled", "Time-of-day model schedules and in-flight clock-boundary switching are currently disabled for every provider.");
    }
    const patch = configPatchFromSnake(input);
    const result = updateConfig(root(deps), patch);
    return toolJson({ ok: true, config: configView(result.config) });
  } catch (e) {
    if (e instanceof ConfigError) return toolError(e.code, e.message);
    return toolError("config_write_failed", String((e as Error)?.message || e));
  }
}

/**
 * Blocking run for SHORT tasks: dispatch then wait locally up to `wait_seconds`.
 *
 * It never cancels the accepted job: on timeout (or if the caller disconnects) it
 * returns the current non-terminal status and the detached worker keeps running
 * to its real terminal state.
 */
export async function runJob(args: unknown, deps: ToolDeps = {}): Promise<ToolResult> {
  const a = asRecord(args);
  const waitRaw = a.wait_seconds;
  let waitMs = 30000;
  if (waitRaw != null) {
    const n = Number(waitRaw);
    if (!Number.isFinite(n) || n < 0 || n > MAX_RUN_WAIT_SECONDS) {
      return toolError("invalid_wait_seconds", `wait_seconds must be a number between 0 and ${MAX_RUN_WAIT_SECONDS}.`);
    }
    waitMs = Math.round(n * 1000);
  }
  const spawned = await spawnInternal(args, deps);
  if (!spawned.jobId) return spawned.result;
  const id = spawned.jobId;
  const r = root(deps);
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const job = getStatus(r, id);
    if (!job) return toolError("not_found", `Job not found: ${id}.`);
    if (isTerminalStatus(job.status)) {
      await wakeIfTerminal(r, job, deps);
      // This is a REAL terminal result entry too (a blocking run that reached
      // the terminal state), so it records the same per-generation receipt.
      const receipt = recordTerminalReadReceipt(r, job, "mcp-run");
      return toolJson({
        ok: true,
        job_id: id,
        provider: job.provider,
        status: job.status,
        terminal: true,
        timed_out: false,
        result: compactResult(job),
        usage: job.usage,
        notify: compactJob(withMergedNotifications(r, job)).notify,
        ...(spawned.dashboardHint ? { dashboard_hint: spawned.dashboardHint } : {}),
        ...(receipt ? { result_read_receipt: receipt } : {})
      });
    }
    if (Date.now() >= deadline) {
      return toolJson({
        ok: true,
        job_id: id,
        provider: job.provider,
        status: job.status,
        terminal: false,
        timed_out: true,
        result: null,
        usage: job.usage,
        notify: compactJob(withMergedNotifications(r, job)).notify,
        ...(spawned.dashboardHint ? { dashboard_hint: spawned.dashboardHint } : {})
      });
    }
    await sleep(200);
  }
}
