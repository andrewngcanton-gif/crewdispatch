// service.ts — CrewDispatch's durable, asynchronous local job service.
//
// Design contract:
//
//   * `startJob` persists a `queued` record and launches a DETACHED worker
//     process, then returns the stable job id immediately. In the PRODUCT path
//     this function is called by the independent local daemon/broker, NOT by the
//     disposable MCP/Hub client. That ownership boundary is what makes the job
//     survive a Codex/Claude/client restart; Node `detached:true` alone is NOT a
//     sufficient lifetime boundary under an inherited Windows Job Object.
//   * the worker owns the record for as long as it runs (single writer). It
//     streams the child's raw NDJSON to the job's log file, parses it with the
//     production parser, writes a heartbeat, and finalises exactly once.
//   * one logical job may span several GENERATION-scoped attempts: the CLI's
//     internal segment boundary (`max_turns`) is resumed via `--resume` ONLY when
//     a valid session id is known; otherwise it ends with an honest error. A
//     terminal job may receive a later continuation (also `--resume`).
//   * only the explicit cancel path (or restart reconciliation of a dead owner)
//     may terminate a running job early. A caller disconnect never does.
//   * cancel writes an out-of-band intent file, kills the Windows process TREE,
//     and CONFIRMS the CrewDispatch-managed and identified processes exited before it
//     may report `cancelled`. `cancelled` means those processes are done — it
//     does NOT claim an arbitrary detached descendant behind an exited
//     intermediate was proven gone (a pure TypeScript observation limit). An
//     unconfirmed tree kill keeps the child PID and reports nothing terminal. A
//     superseded generation can never finish or unregister a newer one.
//   * whenever a job's managed CLI process tree cannot be resolved as stopped,
//     the record keeps `childPid` as evidence, never claims `cancelled`, and is
//     held in the non-terminal `orphaned` state so it can never auto-resume into
//     a new generation; only a later explicit cancel that confirms the managed
//     tree stopped may produce a terminal `cancelled`.
//   * the PRODUCT launches the user-installed official CLI in the JOB'S requested
//     `cwd` with the owning process's runtime environment, so the user's own
//     official login/account is used. CrewDispatch reads no credential/DB itself. A
//     disposable isolated CLI profile is a TEST concern, created at the harness
//     boundary and passed in through `env`/`--cwd` — never hardcoded here.
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createLineSplitter } from "../runtime/line-splitter";
import { spawnDetachedProcess } from "../runtime/durable-launch";
import {
  DESCENDANT_CLOCK_TOLERANCE_MS,
  DARWIN_TERMINAL_ACK_ENV,
  captureProcessIdentity,
  classifyProcessGroupContainment,
  enumerateDescendantProcesses,
  enumerateExitedRootDescendants,
  enumerateProcesses,
  findDescendants,
  isPidAlive,
  isProcessGroupAlive,
  killProcessTree,
  type EnumerateProcesses,
  type KillTreeOptions,
  type KillTreeResult,
  type KillTreeScope,
  type ProcessScan
} from "../runtime/process";
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { readInstalledModelCatalog } from "../providers/command-code/local-catalog";
import { createWorkBuddyAiAdapter, WORKBUDDY_AI_PROVIDER, workBuddyAiProfileEnv } from "../providers/workbuddy-ai/index";
import { defaultConfig, loadConfigResult, type CrewDispatchConfig, type LoadConfigResult } from "../config/schema";
import {
  loadWorkBuddyAiConfigResult,
  loadWorkBuddyAiRuntimeConfigResult,
  workBuddyAiRuntimeConfig
} from "../config/workbuddy-ai";
import { effortForModelSource, MAX_MODEL_CHAIN, nextModelBoundary, selectModel, type ModelBoundary } from "../config/select";
import { canFinalize, createGenerationRegistry, isCurrentGeneration, makeOwnerId } from "./generation";
import { providerManagedIgnoredPids } from "./provider-managed";
// Re-exported: the shared rule lives in `provider-managed.ts` so the cancel
// lifecycle can use it without importing the job service.
export { providerManagedIgnoredPids };
import { providerCancelAllowsCancellation, requestProviderTurnCancel, resolveProviderOwnedTool, type ProviderCancelEvidence, type ProviderCancelRequest } from "./provider-cancel";
import { providerTurnUnresolved } from "./provider-turn";
import type { ProviderAdapter, ProviderCancelDeps, ProviderTurnCancelInput, ProviderTurnCancelResult } from "../providers/provider";
import type { CancelCleanupEvidence } from "./types";
import { attemptStartedAtMs, isOwnerAlive, reconcileJob } from "./reconcile";
import { acquireWorkspace, evaluateWorkspace, resolveWorkspaceIdentity, workspaceBusyMessage, WORKSPACE_BUSY } from "./workspace";
import { isModelDefaultEffortProven } from "./effort-provenance";
import { clearPendingApproval, pendingApprovalKey, type PendingApproval } from "./approval";
import {
  acquireJobTransitionLock,
  appendLog,
  clearCancelIntent,
  clearTreeConfirmation,
  clearTreeRecovery,
  ensureRoot,
  assertInside,
  isTreeConfirmed,
  loadJob,
  readCancelIntent,
  readTreeConfirmation,
  readTreeRecovery,
  resolveDataRoot,
  safeId,
  saveJob,
  workerLogPath,
  writeCancelIntent,
  writeTerminalSnapshot,
  writeTreeConfirmation
} from "./store";
import {
  appendAssistantMessageOrThrow,
  appendUserMessageOrThrow,
  loadUserMessagesInfo,
  removeUserMessages,
  writeUserMessagesInfo
} from "./messages";
import {
  COMMAND_CODE_PROVIDER,
  createCommandCodeRunner,
  isValidSessionIdFor,
  validateAttemptCwd,
  type AttemptContext,
  type CreateRunner,
  type JobRunner,
  type ModelCandidate,
  type RunnerBuildContext
} from "./runner";
import {
  ADDITIVE_USAGE_KEYS,
  boundResultText,
  emptyNotifyTarget,
  emptySlotSwitch,
  emptyUsage,
  GAUGE_USAGE_KEYS,
  isTerminalStatus,
  JOB_SCHEMA_VERSION,
  pushSwitchEvent,
  pushSwitchSkip,
  totalUsage,
  usageReported,
  type AcceptedModelIntent,
  type CompactResult,
  type JobAttempt,
  type JobRecord,
  type JobStatus,
  type JobUsage,
  type ModelChainPlanEntry,
  type ModelSource,
  type NotifyTarget,
  type RunnerKind,
  type SlotSwitchAudit
} from "./types";
import {
  deliverTerminalNotification,
  sanitizeOneLineText,
  STDERR_DIAGNOSTIC_CAP,
  STDERR_TAIL_CAP,
  type DeliveryDeps
} from "../mcp/notify";
import { deliverApprovalNotification } from "./notifications";
import type { ExitClassification, StreamState, UsageSnapshot } from "../providers/provider";

// STDERR_TAIL_CAP / STDERR_DIAGNOSTIC_CAP are the shared bounded-stderr bounds
// also used by a failed terminal wake (see mcp/notify.ts): the raw stream is
// bounded, and the complete output stays in the job's log file, so the durable
// error only ever carries the compact normalized tail.

/**
 * The fixed, transport-only prompt of an INTERNAL resume attempt — the CLI's own
 * segment boundary (`max_turns`) or a rate-limit downgrade.
 *
 * A resumed session already holds the original task (or a continuation's new
 * user message) plus whatever progress was made, so re-sending the full task
 * would invite duplicated work (re-running successful tool calls, re-applying
 * edits). This string is an argv value and NOTHING else: it is never written to
 * the job's task, never rendered as a user message, and never impersonates a
 * user follow-up. It is deliberately fixed (not localised/configurable) so the
 * internal-resume behaviour stays auditable.
 */
export const RECOVERY_PROMPT =
  "Continue the interrupted task from the existing conversation. The previous attempt was interrupted by a model rate limit or the CLI's own segment limit. " +
  "Preserve completed work and do not repeat successful tool calls or edits.";

/**
 * The fixed, transport-only prompt of a generation that continues the SAME
 * session on a DIFFERENT model after a configured time-slot boundary.
 *
 * Like `RECOVERY_PROMPT` it is an argv/STDIN value and NOTHING else: it is never
 * written to the job's task, never rendered as a user message and never
 * impersonates a user follow-up. The session already holds the task and every
 * completed step, so the switch must NOT re-send the task (that would invite
 * duplicated work). It is deliberately fixed — not localised, not configurable —
 * so the behaviour stays auditable.
 */
export const BOUNDARY_SWITCH_PROMPT =
  "The configured time window changed the model. Continue the unfinished task from the existing conversation. " +
  "Preserve completed work and do not repeat successful tool calls or edits.";

/**
 * The shortest local delay the in-flight boundary timer will ever be armed with.
 * There is deliberately NO product wall-clock cap on a run: this only keeps a
 * boundary that is already in the past from spinning.
 */
const BOUNDARY_MIN_DELAY_MS = 20;

/** A boundary switch asked for one specific generation (generation-fenced). */
interface PendingBoundary {
  generation: number;
  model: string;
  source: ModelSource;
  effort: string | null;
  slotIndex: number | null;
  at: string;
}

export class JobServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
  }
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function newJobId(now: number = Date.now()): string {
  return `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultWorkerScript(): string {
  // dist/jobs/service.js -> dist/cli/job-cli.js
  return path.join(__dirname, "..", "cli", "job-cli.js");
}

// ---------------------------------------------------------------------------
// Record creation
// ---------------------------------------------------------------------------

export interface NewJobInput {
  task: string;
  cwd: string;
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  provider?: string;
  runner?: RunnerKind;
  /** Terminal-wake destination, already resolved by the caller (see mcp/notify). */
  notifyTarget?: NotifyTarget;
  /**
   * The minimal model/effort INTENT frozen at dispatch (v11). Persisted on the
   * record BEFORE it is saved, so the worker validates the ACCEPTED pair rather
   * than a Settings edit made while the job was queued. Callers that build a
   * record directly (tests/fixtures) may omit it and the worker resolves from
   * the current config exactly as before.
   */
  acceptedIntent?: AcceptedModelIntent | null;
}

export function createJobRecord(input: NewJobInput, now?: () => Date): JobRecord {
  const task = typeof input.task === "string" ? input.task : "";
  if (!task.trim()) throw new JobServiceError("empty_task", "The task is empty: provide --task or supply the task text via stdin.");
  // First release supports exactly two provider routes. Unknown values are
  // refused before a record is persisted; `fixture` remains a test-only runner.
  const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : COMMAND_CODE_PROVIDER;
  if (provider !== COMMAND_CODE_PROVIDER && provider !== WORKBUDDY_AI_PROVIDER) {
    throw new JobServiceError(
      "invalid_provider",
      `Unsupported provider: ${provider}; CrewDispatch currently supports ${COMMAND_CODE_PROVIDER} and ${WORKBUDDY_AI_PROVIDER}.`
    );
  }
  const cwd = path.resolve(input.cwd && input.cwd.trim() ? input.cwd.trim() : process.cwd());
  const workspaceIdentity = resolveWorkspaceIdentity(cwd).persistentIdentity;
  const at = nowIso(now);
  const id = newJobId();
  // The EXPLICIT per-job model is the source of truth: it is persisted separately
  // so a later reader can tell an override apart from an automatic selection. The
  // effective `model` is resolved at worker startup (config + time slot + clock).
  const explicitModel = input.model && input.model.trim() ? input.model.trim() : null;

  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    id,
    provider,
    runner: input.runner === "fixture" ? "fixture" : provider === WORKBUDDY_AI_PROVIDER ? "workbuddy-ai" : "command-code",
    status: "queued",
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    generation: 0,
    cwd,
    workspaceIdentity,
    task,
    model: explicitModel,
    modelSource: explicitModel ? "explicit" : null,
    explicitModel,
    modelChain: [],
    // The accepted model/effort plan is resolved and frozen by the worker at
    // startup (a fresh job) and reused by every later generation.
    modelChainPlan: [],
    // The minimal model/effort intent is frozen by the CALLER at dispatch and
    // passed in here, before the queued record is exposed (see `NewJobInput`).
    acceptedIntent: input.acceptedIntent ?? null,
    promptKind: "task",
    // The switch audit starts empty; the worker fills it in when it first
    // evaluates a time boundary (a job with an explicit model never does).
    slotSwitch: null,
    permissionMode: input.permissionMode && input.permissionMode.trim()
      ? input.permissionMode.trim()
      : "plan",
    effort: input.effort && input.effort.trim() ? input.effort.trim() : null,
    sessionId: null,
    logPath: path.join("logs", `${id}.ndjson`),
    owner: "",
    ownerPid: null,
    ownerStartedAtUs: null,
    heartbeatAt: null,
    childPid: null,
    childStartedAtUs: null,
    childGeneration: null,
    usage: emptyUsage(),
    result: null,
    stopReason: null,
    finishReason: null,
    errorDetail: null,
    approvalOutcome: null,
    error: null,
    failureKind: null,
    cancelIntent: { requested: false, requestedAt: null, by: null },
    pendingApproval: null,
    attempts: [],
    notifyTarget: input.notifyTarget ?? emptyNotifyTarget(),
    notifications: []
  };
}

// ---------------------------------------------------------------------------
// Start / worker spawn
// ---------------------------------------------------------------------------

export interface StartJobInput extends NewJobInput {
  root: string;
  env?: NodeJS.ProcessEnv;
  cliPath?: string | null;
  fixturePath?: string | null;
  /** Override the worker entry (tests). Defaults to dist/cli/job-cli.js. */
  workerScript?: string;
  now?: () => Date;
  spawnWorkerFn?: typeof spawn;
}

export interface StartJobResult {
  job: JobRecord;
  workerPid: number | null;
  workerScript: string;
}

function workerArgs(input: {
  workerScript: string;
  root: string;
  jobId: string;
  fixturePath?: string | null;
  cliPath?: string | null;
}): string[] {
  const args = [input.workerScript, "worker", "--root", input.root, "--job", input.jobId];
  if (input.fixturePath) args.push("--fixture", input.fixturePath);
  if (input.cliPath) args.push("--cli-path", input.cliPath);
  return args;
}

/** Launch the detached worker that owns the job from here on. */
export function spawnWorker(input: {
  root: string;
  jobId: string;
  fixturePath?: string | null;
  cliPath?: string | null;
  workerScript?: string;
  env?: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
}): { pid: number | null; workerScript: string } {
  const workerScript = input.workerScript ?? defaultWorkerScript();
  if (!fs.existsSync(workerScript)) {
    throw new JobServiceError("worker_missing", `Task worker entry not found: ${workerScript} (build dist first).`);
  }
  const args = workerArgs({
    workerScript,
    root: input.root,
    jobId: input.jobId,
    fixturePath: input.fixturePath,
    cliPath: input.cliPath
  });
  const logFile = workerLogPath(input.root, input.jobId);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, "a");
  let child: ChildProcess | null = null;
  try {
    child = spawnDetachedProcess({
      file: process.execPath,
      args,
      stdio: ["ignore", fd, fd],
      cwd: input.root,
      env: input.env ?? process.env,
      spawnFn: input.spawnFn
    });
  } catch (e) {
    throw new JobServiceError("worker_spawn_failed", `Failed to start the task worker: ${String((e as Error)?.message || e)}`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the child holds its own descriptor */
    }
  }
  if (!child) throw new JobServiceError("worker_spawn_failed", "Failed to start the task worker.");
  return { pid: child.pid ?? null, workerScript };
}

/**
 * Load the persisted config, throwing a stable `config_invalid` when the file is
 * present but invalid (CrewDispatch never silently repairs or ignores a broken config).
 */
function disableModelSchedules(config: CrewDispatchConfig): CrewDispatchConfig {
  return { ...config, timeSlots: [], inFlightSwitch: false };
}

function disableModelSchedulesInLoad(result: LoadConfigResult): LoadConfigResult {
  return result.ok ? { ...result, config: disableModelSchedules(result.config) } : result;
}

export function requireConfig(root: string): CrewDispatchConfig {
  const cfg = loadConfigResult(root);
  if (!cfg.ok) {
    throw new JobServiceError(cfg.error?.code ?? "config_invalid", cfg.error?.message ?? "CrewDispatch configuration is invalid.");
  }
  return disableModelSchedules(cfg.config);
}

/**
 * The configured downgrade candidates frozen at dispatch, in chain order: the
 * configured default model (with its OWN effort), then the configured
 * rate-limit fallback model (with its OWN effort). Canonical-id deduped against
 * the primary and each other, and capped like the live chain.
 *
 * Pure and catalog-free on purpose: whether a candidate can actually be
 * dispatched is PROVEN later, at worker startup, against the installed CLI's
 * own catalog (see `selectModelChainFromIntent`). Freezing the pairs here is
 * what keeps a Settings edit made while the job is queued from changing them.
 */
function frozenFallbackIntent(config: CrewDispatchConfig, primaryModel: string | null): ModelChainPlanEntry[] {
  const out: ModelChainPlanEntry[] = [];
  const seen = new Set<string>();
  if (primaryModel) seen.add(primaryModel);
  const add = (model: string | null, source: ModelSource, effort: string | null): void => {
    const m = typeof model === "string" && model.trim() ? model.trim() : null;
    if (!m || seen.has(m)) return;
    seen.add(m);
    out.push({ model: m, source, effort: typeof effort === "string" && effort.trim() ? effort.trim() : null });
  };
  add(config.defaultModel, "config-default", config.defaultEffort);
  add(config.rateLimitFallbackModel, "rate-limit-fallback", config.rateLimitFallbackEffort);
  return out.slice(0, MAX_MODEL_CHAIN - 1);
}

/** Persist a queued job and return its id immediately (detached execution). */
export function startJob(input: StartJobInput): StartJobResult {
  const root = resolveDataRoot(input.root, input.env ?? process.env);
  ensureRoot(root);
  const requestedProvider =
    typeof input.provider === "string" && input.provider.trim()
      ? input.provider.trim()
      : COMMAND_CODE_PROVIDER;
  const isWorkBuddyAi = requestedProvider === WORKBUDDY_AI_PROVIDER;
  // Each provider reads only its own persisted settings.
  let config: CrewDispatchConfig;
  if (isWorkBuddyAi) {
    const wb = loadWorkBuddyAiConfigResult(root);
    if (!wb.ok) {
      throw new JobServiceError(
        wb.error?.code ?? "config_invalid",
        wb.error?.message ?? "WorkBuddy AI configuration is invalid."
      );
    }
    config = workBuddyAiRuntimeConfig(wb.config);
    const explicit = input.model && input.model.trim() ? input.model.trim() : null;
    if (!explicit && !config.defaultModel) {
      throw new JobServiceError(
        "model_required",
        "A WorkBuddy AI job requires an explicit model, or configure a WorkBuddy AI default model in CrewDispatch Settings first."
      );
    }
  } else {
    config = requireConfig(root);
  }
  // SHARED EXACT-WORKSPACE OCCUPANCY (JQ-20261002-44): at most ONE accepted
  // ACTIVE job may write a given canonical cwd at a time, across every caller,
  // MCP process and provider. The reservation is taken BEFORE any record or
  // message is persisted, so a refusal leaves no queued job, no history entry,
  // no provider process and no notification.
  const workspace = acquireWorkspace({ root, cwd: input.cwd });
  if (!workspace.ok) {
    throw new JobServiceError(WORKSPACE_BUSY, workspaceBusyMessage(workspace.holder, workspace.canonicalCwd));
  }
  try {
    const permissionMode = input.permissionMode && input.permissionMode.trim()
      ? input.permissionMode.trim()
      : config.permissionMode;
    // The accepted PRIMARY reasoning effort, resolved at dispatch and persisted so
    // the worker reuses exactly this pair. The primary's SOURCE (explicit / slot /
    // config-default / cli-default) does not depend on the model catalog, so it is
    // resolved here against an unavailable catalog purely to pick the right
    // effort. Rules: an explicit per-job effort wins; an explicit null/blank is an
    // honest "provider/model default"; otherwise the primary uses the configured
    // effort that belongs to its source (the default model's own effort, or the
    // provider default for a slot / the CLI default / an explicit OTHER model).
    const selectNow = input.now ?? (() => new Date());
    const primaryProbe = selectModel({
      explicitModel: input.model ?? null,
      config,
      now: selectNow(),
      catalog: { ok: false, source: "unavailable", models: [], defaultModel: null }
    });
    const explicitEffort = input.effort === undefined
      ? undefined
      : (typeof input.effort === "string" && input.effort.trim() ? input.effort.trim() : null);
    const effort = explicitEffort !== undefined
      ? explicitEffort
      : effortForModelSource(config, primaryProbe.source, primaryProbe.model);
    // Freeze the MINIMAL accepted model/effort intent BEFORE the queued record is
    // exposed: the worker validates exactly this pair against the installed CLI's
    // own catalog instead of re-reading the config, so a Settings edit made while
    // the job waits can never pair a later model with this dispatch-time effort.
    const acceptedIntent: AcceptedModelIntent = {
      primaryModel: primaryProbe.model,
      primarySource: primaryProbe.source,
      primaryEffort: effort,
      fallbacks: frozenFallbackIntent(config, primaryProbe.model)
    };
    const job = createJobRecord({ ...input, permissionMode, effort, acceptedIntent }, input.now);
    // Persist the exact filesystem identity that the reservation actually locked.
    // Do not re-read the path and risk a rename/replace race between admission and save.
    job.workspaceIdentity = workspace.workspaceIdentity;
    // The original user message must be durable before the queued record makes the
    // generation visible. If side-car persistence fails, no job is accepted.
    try {
      appendUserMessageOrThrow(root, job.id, { text: job.task, generation: 0, at: job.createdAt });
    } catch (e) {
      throw new JobServiceError("message_history_write_failed", `Failed to persist the job message history: ${String((e as Error)?.message || e)}`);
    }
    try {
      saveJob(root, job, input.now);
    } catch (e) {
      try { removeUserMessages(root, job.id); } catch { /* best-effort rollback for an unaccepted job */ }
      throw e;
    }
    // The queued record IS the durable reservation now; the short cross-process
    // mutex has done its job and is released before the worker is spawned.
    workspace.release();
    let spawned: { pid: number | null; workerScript: string };
    try {
      spawned = spawnWorker({
        root,
        jobId: job.id,
        fixturePath: input.fixturePath,
        cliPath: input.cliPath,
        workerScript: input.workerScript,
        env: input.env,
        spawnFn: input.spawnWorkerFn
      });
    } catch (e) {
      // The queued record must NEVER be left as a job that will never run: if the
      // worker could not be launched, finalize a durable failure and report it.
      const err = e instanceof JobServiceError ? e : new JobServiceError("worker_spawn_failed", `Failed to start the task worker: ${String((e as Error)?.message || e)}`);
      const at = nowIso(input.now);
      saveJob(
        root,
        {
          ...job,
          status: "error",
          stopReason: err.code,
          error: err.message,
          failureKind: err.code,
          childPid: null,
          childStartedAtUs: null,
          childGeneration: null,
          result: { ok: false, subtype: null, kind: err.code, exitCode: null, stopReason: err.code, finalText: null, fallbackEligible: false },
          finishedAt: at,
          updatedAt: at
        },
        input.now
      );
      throw err;
    }
    return { job, workerPid: spawned.pid, workerScript: spawned.workerScript };
  } finally {
    workspace.release();
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface RunWorkerOptions {
  root: string;
  jobId: string;
  env?: NodeJS.ProcessEnv;
  cliPath?: string | null;
  createRunner?: CreateRunner;
  heartbeatMs?: number;
  graceMs?: number;
  now?: () => Date;
  /**
   * The instant time slots are evaluated against. Defaults to `now`, or to the
   * TEST-ONLY `JOBQUAY_TEST_NOW` env seam when set (so a cross-process acceptance
   * can drive two simulated local times through the real worker).
   */
  selectNowFn?: () => Date;
  spawnChildFn?: typeof spawn;
  delayFn?: (ms: number) => Promise<void>;
  /** Process liveness probe used when re-checking an old tree (tests). */
  isAliveFn?: (pid: number) => boolean | null;
  /** POSIX process-group liveness probe used by native close reconciliation (tests). */
  isProcessGroupAliveFn?: (pgid: number) => boolean | null;
  /** TEST-ONLY platform seam; production defaults to the real process.platform. */
  platform?: NodeJS.Platform;
  /** Tree-kill executor used when re-checking an old tree (tests). */
  execFileFn?: KillTreeOptions["execFileFn"];
  /** Process-table enumeration used to find a dead root's descendants (tests). */
  enumerateFn?: EnumerateProcesses;
  /**
   * Terminal-wake delivery seams (tests inject a spawn/HTTP stub). The wake is
   * attempted at most once per terminal generation, only for a TERMINAL status,
   * and its failure never changes the job outcome.
   */
  notify?: DeliveryDeps;
  /**
   * TEST-ONLY: awaited AFTER the terminal state is written and BEFORE the
   * terminal wake is attempted. It lets a test deterministically interleave a
   * continuation (follow-up) into the "terminal written, wake not yet attempted"
   * window. Never set in production.
   */
  beforeNotify?: () => Promise<void> | void;
  /**
   * Bounded wait for PROVIDER-OWNED work to stop after the exact turn
   * cancellation was requested (JQ-20261006-58). Default 8000; never a turn
   * deadline — it only runs on the cancellation path.
   */
  providerCancelWaitMs?: number;
  /** Provider-owned cancellation seams (tests). */
  providerCancel?: ProviderCancelSeam;
}

/**
 * The injectable seams of the provider-owned cancellation route. Production
 * leaves this unset, so the provider's real route is used.
 */
export interface ProviderCancelSeam {
  adapter?: ProviderAdapter | null;
  cancelTurnFn?: (input: ProviderTurnCancelInput, deps: ProviderCancelDeps) => Promise<ProviderTurnCancelResult>;
  turnSlotKeyFn?: ProviderAdapter["turnSlotKey"];
  listJobsFn?: () => JobRecord[];
  configDir?: string;
  tmpDir?: string;
  transport?: unknown;
  /** Bounded override of the provider control-channel acknowledgment wait (tests). */
  cancelAckWaitMs?: number;
}

export interface RunWorkerResult {
  ok: boolean;
  jobId: string;
  status: JobStatus | null;
  generation: number;
  error: string | null;
  note?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Why a recorded child tree is (or is not) accepted as stopped.
 *
 * `no_survivors` means ONLY that the CURRENT OS observation found no live
 * descendant scoped to this job's root PID + generation start time. It is a
 * bounded negative snapshot, not proof that an arbitrary detached descendant
 * behind an exited intermediate is gone (see `KillTreeScope`).
 */
export type TreeStopState = "no_child" | "confirmed" | "no_survivors" | "survivors" | "unknown";

export interface TreeStopResult {
  /** True ONLY when the managed CLI process tree is accepted as stopped. */
  stopped: boolean;
  state: TreeStopState;
  /** PIDs identified as this generation's still-live descendants (evidence). */
  survivingPids: number[];
  reason: string | null;
  /**
   * Exactly what was proven (mirrors `KillTreeScope`). Never claims an arbitrary
   * detached descendant is gone.
   */
  scope: KillTreeScope;
}

/**
 * Resolve whether the recorded child tree is stopped, or make a bounded attempt.
 *
 * A recorded PID is treated as an UNPROVEN tree unless a generation-scoped
 * confirmation — or validated, generation-bound PASSIVE recovery evidence —
 * already proves it stopped. Both are checked BEFORE any destructive branch: a
 * live process currently holding the old PID may be an unrelated incarnation
 * (PID reuse), and it must never be signalled when the exact old identity was
 * already proven stopped. A live PID without such proof is tree-killed; only a
 * CONFIRMED OS tree kill (`scope: "os_tree_exited"`) is accepted and recorded.
 *
 * A PID whose ROOT is already dead is NEVER accepted on that alone: Windows does
 * not reparent orphans, so a detached descendant keeps the dead root's PID as its
 * PPID and survives. The tree is then resolved by ENUMERATING the OS process
 * table and scanning for descendants scoped to `root PID + generation start
 * time`:
 *   * no live descendant in the CURRENT observation → `no_survivors`
 *     (`scope: "root_exited"`): a bounded negative snapshot, not an absolute
 *     whole-tree guarantee;
 *   * live descendants → NOT stopped (`survivors`) unless `killSurvivors` is set
 *     (explicit cancel), in which case the identified descendants are killed and
 *     re-checked (`scope: "identified_descendants_stopped"`);
 *   * enumeration unavailable, or a candidate whose creation time is unknown, or
 *     no recorded generation start time → NOT stopped (`unknown`).
 *
 * The intent file is never treated as confirmation, an unknown tree is never
 * reported as stopped, and no result claims that an arbitrary detached descendant
 * behind an exited intermediate is gone.
 */
/**
 * Freeze the exact Darwin provider group long enough to take one stable
 * containment snapshot after a terminal record is observed.
 *
 * Authorization is PID + exact birth + group/session leadership. A fake,
 * legacy, reused or otherwise unproven PID is never signalled. The returned
 * release resumes only the still-existing same PGID; while SIGSTOP holds the
 * group, its members cannot escape between the snapshot and release.
 */
function diagnoseDarwinProviderGroup(pid: number, expectedCreatedAtUs: number | null): string | null {
  if (expectedCreatedAtUs == null) return "identity_unpinned";
  const identity = captureProcessIdentity(pid);
  if (!identity) return "darwin_terminal_root_identity_missing";
  if (identity.createdAtUs == null || identity.createdAtUs !== expectedCreatedAtUs) return "pid_reused";
  if (identity.pgid !== pid || identity.sid !== pid || identity.sessionLeader !== true) return "process_group_unproven";
  return null;
}

function freezeDarwinProviderGroup(pid: number, expectedCreatedAtUs: number | null): (() => void) | null {
  if (process.platform !== "darwin" || expectedCreatedAtUs == null) return null;
  const identity = captureProcessIdentity(pid);
  if (
    !identity ||
    identity.createdAtUs !== expectedCreatedAtUs ||
    identity.pgid !== pid ||
    identity.sid !== pid ||
    identity.sessionLeader !== true
  ) {
    return null;
  }
  try {
    process.kill(-pid, "SIGSTOP");
  } catch {
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (isProcessGroupAlive(pid) !== true) return;
    try {
      process.kill(-pid, "SIGCONT");
    } catch {
      /* best effort; the group may have been killed concurrently */
    }
  };
}

interface DarwinContainmentObservation {
  ok: boolean;
  reason: string | null;
  outsidePids: number[];
}

async function observeDarwinManagedContainment(input: {
  childPid: number;
  childStartedAtMs: number | null;
  childStartedAtUs: number | null;
  enumerateFn?: EnumerateProcesses;
  ignoredPids?: ReadonlySet<number>;
}): Promise<DarwinContainmentObservation> {
  if (input.childStartedAtMs == null) {
    return { ok: false, reason: "darwin_no_generation_start", outsidePids: [] };
  }
  if (input.childStartedAtUs == null) {
    return { ok: false, reason: "identity_unpinned", outsidePids: [] };
  }
  let scan: ProcessScan;
  try {
    scan = await (input.enumerateFn ?? enumerateProcesses)();
  } catch (e) {
    return {
      ok: false,
      reason: `enumeration_failed: ${String((e as Error)?.message || e).slice(0, 200)}`,
      outsidePids: []
    };
  }
  if (!scan.ok) {
    return { ok: false, reason: scan.reason ?? "darwin_containment_enumeration_failed", outsidePids: [] };
  }
  const rootEntry = scan.processes.find((entry) => entry.pid === input.childPid);
  if (!rootEntry) {
    return { ok: false, reason: "darwin_root_gone_before_containment", outsidePids: [] };
  }
  if (rootEntry.createdAtUs == null || rootEntry.createdAtUs !== input.childStartedAtUs) {
    return { ok: false, reason: "pid_reused", outsidePids: [] };
  }
  if (rootEntry.pgid !== input.childPid) {
    return { ok: false, reason: "process_group_unproven", outsidePids: [] };
  }
  if (rootEntry.sid == null) {
    // KERN_PROC_ALL may still contain the exact exiting/zombie root after
    // getsid(pid) has already started returning ESRCH. This is a natural-close
    // race, not evidence of another process group; the caller must still prove
    // the recorded PGID itself disappeared before accepting it.
    return { ok: false, reason: "darwin_root_exiting_before_containment", outsidePids: [] };
  }
  if (rootEntry.sid !== input.childPid || rootEntry.sessionLeader !== true) {
    return { ok: false, reason: "process_group_unproven", outsidePids: [] };
  }
  const containment = classifyProcessGroupContainment(
    scan.processes,
    input.childPid,
    input.childStartedAtMs - DESCENDANT_CLOCK_TOLERANCE_MS,
    input.ignoredPids
  );
  if (containment.unknown) {
    return { ok: false, reason: "darwin_descendant_identity_unknown", outsidePids: containment.outsidePids };
  }
  if (containment.outsidePids.length > 0) {
    return { ok: false, reason: "darwin_descendant_outside_group", outsidePids: containment.outsidePids };
  }
  return { ok: true, reason: null, outsidePids: [] };
}
interface ManagedTreeKillInput {
  root: string;
  jobId: string;
  generation: number;
  childPid: number | null;
  childStartedAtMs: number | null;
  childStartedAtUs: number | null;
  alive: (pid: number) => boolean | null;
  killOpts: KillTreeOptions;
  by: string;
  now?: () => Date;
  enumerateFn?: EnumerateProcesses;
  ignoredPids?: ReadonlySet<number>;
  platform?: NodeJS.Platform;
}

/**
 * Kill one recorded managed root and persist a tree confirmation ONLY when the
 * platform-specific containment evidence supports it.
 *
 * On Darwin a successful process-group kill is not enough by itself: before
 * signalling, take one bounded descendant snapshot while the ancestry still
 * exists. Any descendant outside the owned PGID/SID, missing identity facts,
 * failed scan, or missing generation start keeps the result unconfirmed.
 */
async function killManagedTreeWithContainment(
  input: ManagedTreeKillInput
): Promise<{ kill: KillTreeResult; tree: TreeStopResult }> {
  const childPid = input.childPid;
  const platform = input.platform ?? process.platform;
  if (childPid == null) {
    const kill = await killProcessTree(null, input.killOpts);
    return {
      kill,
      tree: { stopped: true, state: "no_child", survivingPids: [], reason: null, scope: "none" }
    };
  }

  let darwinContainment: DarwinContainmentObservation | null = null;
  if (platform === "darwin" && input.alive(childPid) !== false) {
    darwinContainment = await observeDarwinManagedContainment({
      childPid,
      childStartedAtMs: input.childStartedAtMs,
      childStartedAtUs: input.childStartedAtUs,
      enumerateFn: input.enumerateFn,
      ignoredPids: input.ignoredPids
    });
  }
  const kill = await killProcessTree(childPid, {
    ...input.killOpts,
    expectedCreatedAtUs: platform === "darwin" ? input.childStartedAtUs : undefined
  });

  if (kill.scope === "os_tree_exited") {
    if (darwinContainment && !darwinContainment.ok) {
      const stillAlive = darwinContainment.outsidePids.filter((pid) => input.alive(pid) !== false);
      return {
        kill,
        tree: {
          stopped: false,
          state: stillAlive.length > 0 ? "survivors" : "unknown",
          survivingPids: stillAlive,
          reason: darwinContainment.reason,
          scope: "unconfirmed"
        }
      };
    }
    writeTreeConfirmation(input.root, input.jobId, input.generation, childPid, kill.scope, input.by, input.now);
    return {
      kill,
      tree: { stopped: true, state: "confirmed", survivingPids: [], reason: null, scope: kill.scope }
    };
  }

  return {
    kill,
    tree: {
      stopped: false,
      state: "unknown",
      survivingPids: [],
      reason: kill.reason ?? "root_alive_unconfirmed",
      scope: "unconfirmed"
    }
  };
}
async function ensureTreeStopped(input: {
  root: string;
  jobId: string;
  generation: number;
  childPid: number | null;
  /** Epoch ms this generation's CLI root was spawned; null when unknown. */
  childStartedAtMs: number | null;
  /** Exact Darwin birth instant of the recorded child; null when unproven/legacy. */
  childStartedAtUs: number | null;
  alive: (pid: number) => boolean | null;
  killOpts: KillTreeOptions;
  by: string;
  now?: () => Date;
  /** Injectable enumeration seam (tests). */
  enumerateFn?: EnumerateProcesses;
  /** Explicit cancel: kill identified surviving descendants and confirm. */
  killSurvivors?: boolean;
  /** Short wait before trusting a survivor that may be a just-exited process. */
  survivorGraceMs?: number;
  /** Provider-managed daemon roots intentionally outside the disposable CLI tree. */
  ignoredPids?: ReadonlySet<number>;
  platform?: NodeJS.Platform;
  /** Pre-close Darwin containment observation for diagnostics/fail-closed reason. */
  darwinPreCloseContainment?: DarwinContainmentObservation | null;
}): Promise<TreeStopResult> {
  const { childPid } = input;
  const platform = input.platform ?? process.platform;
  if (childPid == null) return { stopped: true, state: "no_child", survivingPids: [], reason: null, scope: "none" };
  const rec = readTreeConfirmation(input.root, input.jobId);
  if (rec && rec.childPid === childPid && rec.generation === input.generation) {
    // The persisted confirmation states its own strength; never inflate it.
    return { stopped: true, state: "confirmed", survivingPids: [], reason: null, scope: rec.scope };
  }
  // Validated PASSIVE recovery evidence for THIS exact old generation/child
  // identity: an independent boot/descendant proof already showed the tree
  // stopped, so a live process currently holding the old PID is a DIFFERENT
  // incarnation (PID reuse) and must NEVER be signalled. Checked BEFORE the
  // destructive branch below; the same generation/child binding keeps a new
  // generation or a genuine live tree unaffected (no evidence exists for them).
  const recovery = readTreeRecovery(input.root, input.jobId);
  if (recovery && recovery.childPid === childPid && recovery.generation === input.generation) {
    return { stopped: true, state: "confirmed", survivingPids: [], reason: null, scope: "recovery_confirmed" };
  }
  if (input.alive(childPid) !== false) {
    const managed = await killManagedTreeWithContainment({
      root: input.root,
      jobId: input.jobId,
      generation: input.generation,
      childPid,
      childStartedAtMs: input.childStartedAtMs,
      childStartedAtUs: input.childStartedAtUs,
      alive: input.alive,
      killOpts: input.killOpts,
      by: input.by,
      now: input.now,
      enumerateFn: input.enumerateFn,
      ignoredPids: input.ignoredPids,
      platform
    });
    return managed.tree;
  }

  // Darwin reparents orphans. If the worker did not persist a group-exit
  // confirmation while it still owned this exact generation, a later dead-root
  // observation cannot reconstruct escaped descendants safely.
  if (platform === "darwin") {
    return {
      stopped: false,
      state: input.darwinPreCloseContainment?.outsidePids.length ? "survivors" : "unknown",
      survivingPids: input.darwinPreCloseContainment?.outsidePids ?? [],
      reason: input.darwinPreCloseContainment?.reason ?? "darwin_dead_root_unconfirmed",
      scope: "unconfirmed"
    };
  }

  // The root PID is gone. That proves only the ROOT exited. Without a recorded
  // generation start time the descendant scope is unknowable, so stay honest.
  if (input.childStartedAtMs == null) {
    return { stopped: false, state: "unknown", survivingPids: [], reason: "no_generation_start", scope: "unconfirmed" };
  }
  let scan: ProcessScan;
  if (input.enumerateFn) {
    scan = await input.enumerateFn();
  } else if (platform === "win32" && process.platform === "win32") {
    // Fresh hosted diagnostics proved the reliable cold boundary is ONE
    // PowerShell/CIM process that first re-checks the supposedly-dead root PID,
    // then queries its direct children. Running those as two separate PowerShell
    // processes can spend the same 8s budget initializing Win32_Process twice.
    // The combined helper also fails closed if the root PID has reappeared (PID
    // reuse), before any descendant can be attributed or signalled.
    scan = await enumerateExitedRootDescendants(childPid, { timeoutMs: 8000 });
  } else {
    scan = await enumerateProcesses();
  }
  if (!scan.ok) {
    return { stopped: false, state: "unknown", survivingPids: [], reason: scan.reason ?? "enumeration_failed", scope: "unconfirmed" };
  }
  const found = findDescendants(scan.processes, childPid, input.childStartedAtMs - DESCENDANT_CLOCK_TOLERANCE_MS, input.ignoredPids);
  if (found.unknown) {
    return { stopped: false, state: "unknown", survivingPids: found.pids, reason: "descendant_identity_unknown", scope: "unconfirmed" };
  }

  // Confirm liveness with the OS probe (an enumerated PID may have exited during
  // the scan). `null` is unknown → treat as a survivor (conservative).
  const live: number[] = [];
  for (const pid of found.pids) {
    if (input.alive(pid) !== false) live.push(pid);
  }
  if (live.length === 0) {
    // No identified survivor in the CURRENT observation. This is a bounded
    // negative snapshot: the root is gone and nothing scoped to this generation
    // is visible right now — NOT an absolute whole-tree guarantee.
    return { stopped: true, state: "no_survivors", survivingPids: [], reason: null, scope: "root_exited" };
  }

  if (!input.killSurvivors) {
    // A descendant that is merely slow to exit (e.g. a CLI shim's node child
    // unwinding) must not be reported as a permanent survivor. Re-check once
    // after a short grace before declaring the tree stopped-over.
    const grace = input.survivorGraceMs ?? 500;
    if (grace > 0) {
      await (input.killOpts.delayFn ?? delay)(grace);
      const still: number[] = [];
      for (const pid of live) {
        if (input.alive(pid) !== false) still.push(pid);
      }
      if (still.length === 0) return { stopped: true, state: "no_survivors", survivingPids: [], reason: null, scope: "root_exited" };
      return { stopped: false, state: "survivors", survivingPids: still, reason: "descendants_alive", scope: "unconfirmed" };
    }
    return { stopped: false, state: "survivors", survivingPids: live, reason: "descendants_alive", scope: "unconfirmed" };
  }

  // Explicit cancel: kill the identified descendants and confirm they are gone.
  const remaining: number[] = [];
  for (const pid of live) {
    await killProcessTree(pid, input.killOpts);
    if (input.alive(pid) !== false) remaining.push(pid);
  }
  if (remaining.length === 0) {
    writeTreeConfirmation(input.root, input.jobId, input.generation, childPid, "identified_descendants_stopped", input.by, input.now);
    return { stopped: true, state: "confirmed", survivingPids: [], reason: null, scope: "identified_descendants_stopped" };
  }
  return { stopped: false, state: "survivors", survivingPids: remaining, reason: "descendants_alive", scope: "unconfirmed" };
}

/**
 * The PRODUCTION runner: the accepted Command Code adapter driven with the
 * owning process's own runtime environment and the job's requested `cwd`.
 *
 * There is deliberately NO per-job CLI isolation here. The product runs the
 * user-installed official CLI against the user's own official login/account and
 * inside the workspace the caller asked for; CrewDispatch itself never reads or
 * copies a credential/DB. A disposable isolated profile is a TEST concern,
 * created by the test harness and delivered through `env`/`--cwd`.
 */
async function defaultCreateRunner(ctx: RunnerBuildContext): Promise<JobRunner> {
  if (ctx.job.provider === WORKBUDDY_AI_PROVIDER) {
    const adapter = createWorkBuddyAiAdapter();
    const isolatedEnv = workBuddyAiProfileEnv(ctx.env);
    const resolution = adapter.resolveCli(ctx.cliPath ? { configPath: ctx.cliPath, env: isolatedEnv } : { env: isolatedEnv });
    if (!resolution.ok || !resolution.path) throw new JobServiceError("cli_missing", resolution.reason ?? "The WorkBuddy AI CLI is unavailable.");
    const cwdCheck = validateAttemptCwd(ctx.job.cwd);
    const probeInput = { cliPath: resolution.path, env: isolatedEnv, cwd: cwdCheck.ok ? cwdCheck.cwd : undefined };
    const capabilities = await adapter.probeCapabilities(probeInput);
    const catalog = await adapter.readModelCatalog(probeInput);
    return createCommandCodeRunner({ adapter, cliPath: resolution.path, capabilities, catalog, runnerKind: "workbuddy-ai", attemptEnv: workBuddyAiProfileEnv, dataRoot: ctx.root });
  }

  const adapter = createCommandCodeAdapter();
  const resolution = adapter.resolveCli(
    ctx.cliPath ? { configPath: ctx.cliPath, env: ctx.env } : { env: ctx.env }
  );
  if (!resolution.ok || !resolution.path) {
    throw new JobServiceError("cli_missing", resolution.reason ?? "The Command Code CLI is unavailable.");
  }
  // Probe in the requested workspace when it is valid; otherwise the attempt
  // itself fails honestly with the cwd error (validateAttemptCwd) and the probe
  // must not crash first.
  const cwdCheck = validateAttemptCwd(ctx.job.cwd);
  const probeInput = { cliPath: resolution.path, env: ctx.env, cwd: cwdCheck.ok ? cwdCheck.cwd : undefined };
  const capabilities = await adapter.probeCapabilities(probeInput);
  const catalog = await adapter.readModelCatalog(probeInput);
  return createCommandCodeRunner({
    adapter,
    cliPath: resolution.path,
    capabilities,
    catalog,
    effortsByModel: installedModelEfforts(resolution.path),
    // The owning attempt identity: the Command Code ACP bridge binds its
    // interactive approval route to this exact job+generation (the same seam
    // WorkBuddy's Desktop bridge uses). Without it the bridge would always be
    // non-interactive and a standard-mode approval could never reach the Hub.
    dataRoot: ctx.root
  });
}

/**
 * The installed Command Code package's OWN published effort list per model,
 * read from the shipped models reference — the SAME bounded local file read the
 * Settings catalog phase performs. It adds no CLI process and no network call,
 * and it is used ONLY to refuse an incompatible model+effort before a process
 * starts. Any failure yields null ("no evidence"), so a run is never refused on
 * metadata that could not be read.
 */
function installedModelEfforts(cliPath: string): Record<string, string[]> | null {
  try {
    const installed = readInstalledModelCatalog(cliPath);
    return installed.ok ? installed.catalog.effortsByModel : null;
  } catch {
    return null;
  }
}

interface AttemptRun {
  exitCode: number | null;
  spawnError: string | null;
  state: StreamState;
  stderrTail: string;
}

async function captureSpawnedDarwinIdentity(
  pid: number,
  delayFn: (ms: number) => Promise<void>,
  timeoutMs = 1500
): Promise<NonNullable<ReturnType<typeof captureProcessIdentity>> | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const identity = captureProcessIdentity(pid);
    if (
      identity &&
      identity.pid === pid &&
      typeof identity.createdAtUs === "number" &&
      identity.createdAtUs > 0 &&
      identity.pgid === pid &&
      identity.sid === pid &&
      identity.sessionLeader === true
    ) {
      return identity;
    }
    if (Date.now() >= deadline) return null;
    await delayFn(20);
  }
}
function spawnAndStream(input: {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  runner: JobRunner;
  onSpawn: (child: ChildProcess) => void | Promise<void>;
  onLine: (line: string) => void;
  /**
   * Called ONCE per newly announced session id, AS THE CLI STREAM PUBLISHES IT —
   * not only after the attempt ends. The in-flight boundary switch must be able
   * to `--resume` a session that is already durably recorded while the run is
   * still in flight.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Called ONLY when the parsed stream's canonical usage actually CHANGED since
   * the previous observation (see `createUsageChangeDetector`), with the fresh
   * provider-neutral snapshot. The job service persists the running attempt's
   * usage from it, so `GET /api/jobs/:id` exposes fresh metrics while the
   * provider process is still running — never once per streamed chunk.
   */
  onUsageChange?: (snapshot: UsageSnapshot) => void;
  /**
   * Called ONLY when the parsed stream's provider-neutral PENDING APPROVAL
   * changed (a new request appeared, or the current one was resolved/expired/
   * abandoned). The worker persists exactly this bounded, display-safe object
   * as the running job's `pendingApproval` — the state never outlives the
   * provider request it describes.
   */
  onApprovalChange?: (approval: PendingApproval | null) => void;
  /**
   * Called once when a provider terminal record is parsed from a normal data
   * event while the child has not yet emitted close. Darwin uses this narrow
   * pre-close window to snapshot containment before ancestry can disappear.
   * A terminal record discovered only from the close-time splitter flush is
   * deliberately too late and does not invoke this hook.
   */
  onTerminalObserved?: () => void;
  spawnFn: typeof spawn;
}): Promise<AttemptRun> {
  const state = input.runner.createState();
  const splitter = createLineSplitter();
  let stderrTail = "";
  let announcedSession: string | null = null;
  let announcedApprovalKey: string | null = null;
  let announcedTerminal = false;
  let closeSeen = false;
  // The change detector is allocated ONLY when a consumer asked for usage
  // changes, so the parsed state is never re-projected for nothing.
  const detectUsageChange = input.onUsageChange ? createUsageChangeDetector() : null;
  // Parse one line and surface a NEWLY announced session id / a CHANGED
  // canonical usage snapshot immediately.
  const consume = (line: string): void => {
    const observedAtMs = Date.now();
    input.onLine(line);
    input.runner.parseLine(line, state, observedAtMs);
    if (state.terminal && !announcedTerminal) {
      announcedTerminal = true;
      if (!closeSeen) input.onTerminalObserved?.();
    }
    const sid = state.sessionId;
    if (sid && sid !== announcedSession) {
      announcedSession = sid;
      input.onSessionId?.(sid);
    }
    if (detectUsageChange && input.onUsageChange) {
      const snapshot = input.runner.normalizeUsage(state);
      if (detectUsageChange(snapshot)) input.onUsageChange(snapshot);
    }
    // The pending approval is persisted on the SAME observed change basis: one
    // write when a request appears, one when it stops being pending.
    const approval = state.approval;
    const approvalKey = approval ? pendingApprovalKey(approval) : null;
    if (approvalKey !== announcedApprovalKey) {
      announcedApprovalKey = approvalKey;
      input.onApprovalChange?.(approval);
    }
  };
  return new Promise<AttemptRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = input.spawnFn(input.file, input.args, {
        shell: false,
        cwd: input.cwd,
        env: input.env,
        // POSIX provider roots own their own session/process group so a cancel
        // never has to signal the long-lived worker's process group.
        detached: process.platform !== "win32",
        windowsHide: true,
        windowsVerbatimArguments: input.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (e) {
      resolve({ exitCode: null, spawnError: String((e as Error)?.message || e), state, stderrTail: "" });
      return;
    }

    let spawnError: string | null = null;
    let spawnSetup: Promise<void> = Promise.resolve();
    child.stdout?.on("data", (d: Buffer) => {
      for (const line of splitter.feed(d.toString("utf8"))) {
        consume(line);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-STDERR_TAIL_CAP);
    });
    child.on("error", (e: Error) => {
      spawnError = String(e?.message || e);
    });
    child.once("spawn", () => {
      // child.pid exists before the OS has necessarily made every Darwin
      // identity fact observable. Do not send the provider prompt until the
      // owner callback has durably pinned the exact incarnation.
      spawnSetup = Promise.resolve(input.onSpawn(child))
        .then(() => {
          try {
            child.stdin?.on("error", () => undefined);
            child.stdin?.end(input.prompt, "utf8");
          } catch {
            /* best effort */
          }
        })
        .catch((e) => {
          spawnError = String((e as Error)?.message || e);
          try { child.stdin?.destroy(); } catch {}
          try { child.kill("SIGKILL"); } catch {}
        });
    });
    child.on("close", (c: number | null) => {
      closeSeen = true;
      void spawnSetup.finally(() => {
        for (const line of splitter.flush()) {
          consume(line);
        }
        resolve({ exitCode: c, spawnError, state, stderrTail });
      });
    });
  });
}

/**
 * A bounded terminal message for an exhausted rate-limit downgrade chain: it
 * names every candidate that hit a rate limit (model + source) and the models
 * that were configured, never a raw CLI output, a task or a credential.
 */
function rateLimitExhaustedError(job: JobRecord): string {
  const tried = job.attempts
    .filter((a) => a.rateLimited)
    .map((a) => `${a.modelSource ?? "?"}:${a.model ?? "?"}`)
    .join(" → ");
  const chain = job.modelChain.length ? job.modelChain.join(" → ") : "-";
  return `Model rate limit reached and the downgrade candidates are exhausted: tried ${tried || chain} in order; no further candidates (no looping, no substitution with an unconfigured model).`;
}

function toJobUsage(u: UsageSnapshot): JobUsage {
  return {
    tokensIn: u.tokensIn ?? null,
    tokensOut: u.tokensOut ?? null,
    toolCalls: u.toolCalls ?? null,
    cacheRead: u.cacheRead ?? null,
    cacheMiss: u.cacheMiss ?? null,
    cacheCreation: u.cacheCreation ?? null,
    credits: u.credits ?? null,
    totalCostUsd: u.totalCostUsd ?? null,
    decodeTokens: u.decodeTokens ?? null,
    decodeSeconds: u.decodeSeconds ?? null,
    contextUsed: u.contextUsed ?? null,
    contextWindow: u.contextWindow ?? null
  };
}

/** Every canonical usage key: the ADDITIVE metrics plus the GAUGE metrics. */
const CANONICAL_USAGE_KEYS: readonly (keyof JobUsage)[] = [...ADDITIVE_USAGE_KEYS, ...GAUGE_USAGE_KEYS];

/** True when two canonical snapshots report the exact same metrics. */
function sameUsage(a: UsageSnapshot, b: UsageSnapshot): boolean {
  for (const key of CANONICAL_USAGE_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * The canonical usage CHANGE DETECTOR of one streamed attempt (provider-neutral).
 *
 * `runner.normalizeUsage(state)` is a pure projection of the parsed stream, so a
 * streamed text/reasoning/tool chunk that moves no canonical metric yields the
 * very same snapshot. The detector reports `true` only when a fresh snapshot
 * carries at least one reported metric AND differs from the last reported one —
 * so the in-flight persistence happens on a MEANINGFUL usage change only, never
 * once per streamed chunk and never for an all-unreported snapshot (there is
 * nothing to write; an unreported metric stays null, never a fabricated 0).
 */
export function createUsageChangeDetector(): (snapshot: UsageSnapshot) => boolean {
  let last: UsageSnapshot | null = null;
  return (snapshot: UsageSnapshot): boolean => {
    if (!usageReported(snapshot)) return false;
    if (last && sameUsage(last, snapshot)) return false;
    last = snapshot;
    return true;
  };
}

interface DecidedOutcome {
  segment: boolean;
  status: JobStatus;
  failureKind: string | null;
  stopReason: string | null;
  /** The stream's terminal `finish_reason`, or null when it carried none. */
  finishReason: string | null;
  /** The stream's bounded terminal `error_detail`, or null when it carried none. */
  errorDetail: string | null;
  /**
   * The stream's bounded terminal `approval_outcome`, or null when it carried
   * none. It explains an unresolved interactive approval interruption on THIS
   * attempt's turn (a real rejection / an expiry / a missing route / an
   * abandoned wait) and never changes the status or the failure class.
   */
  approvalOutcome: string | null;
  error: string | null;
  result: CompactResult;
}

/**
 * The compact stderr evidence of a GENERIC non-zero CLI exit.
 *
 * A structured provider error (`state.errorMsg`) and a stable fatal
 * classification always stay authoritative; this helper is consulted ONLY when
 * the outcome would otherwise collapse to the plain exit-classification
 * message. Control characters/newlines are normalized through the shared
 * safe-output cleanup and the kept slice is the BOUNDED TAIL (the final stderr
 * bytes carry the terminal failure). `null` means nothing useful remains, so
 * the caller keeps the plain fallback.
 */
function stderrDiagnosticText(stderrTail: string): string | null {
  const normalized = sanitizeOneLineText(stderrTail, "");
  if (!normalized) return null;
  return normalized.length <= STDERR_DIAGNOSTIC_CAP ? normalized : normalized.slice(-STDERR_DIAGNOSTIC_CAP);
}

/**
 * Decide one attempt's outcome.
 *
 * `exit8IsSegment` is the runner's own declaration of whether exit 8 /
 * `max_turns` is a resumable internal segment boundary for that provider.
 */
function decideOutcome(run: AttemptRun, cls: ExitClassification, exit8IsSegment: boolean): DecidedOutcome {
  const state = run.state;
  const exitCode = run.exitCode;
  const segment = (exit8IsSegment && exitCode === 8) || (exit8IsSegment && state.resultSubtype === "max_turns");
  const finalText = boundResultText(state.finalResult ?? state.lastAssistantText);
  const finishReason = state.finishReason;
  // The provider's bounded terminal detail (canonical `error_detail`): carried
  // for diagnosis only, exactly as the provider boundary sanitized it.
  const errorDetail = state.errorDetail;
  // The provider's bounded approval outcome token (canonical
  // `approval_outcome`): why an interactive approval gate on THIS attempt's
  // turn did not proceed. Evidence only — the status, the failure class and the
  // fallback policy below are decided exactly as before.
  const approvalOutcome = state.approvalOutcome;
  const base: CompactResult = {
    ok: false,
    subtype: state.resultSubtype,
    kind: cls.kind,
    exitCode,
    stopReason: state.stopReason ?? cls.stopReason,
    finishReason,
    errorDetail,
    approvalOutcome,
    finalText,
    fallbackEligible: cls.fallback
  };

  if (segment) {
    return {
      segment: true,
      status: "error",
      failureKind: null,
      stopReason: "cli_max_turns",
      finishReason,
      errorDetail,
      approvalOutcome,
      error: null,
      result: { ...base, subtype: "max_turns", stopReason: "cli_max_turns" }
    };
  }
  if (run.spawnError) {
    return { segment: false, status: "error", failureKind: "spawn_error", stopReason: "spawn_error", finishReason, errorDetail, approvalOutcome, error: run.spawnError, result: { ...base, stopReason: "spawn_error" } };
  }
  if (exitCode === null) {
    return {
      segment: false,
      status: "error",
      failureKind: "no_exit",
      stopReason: "no_exit",
      finishReason,
      errorDetail,
      approvalOutcome,
      error: "The child process exited without returning an exit code.",
      result: { ...base, stopReason: "no_exit" }
    };
  }
  if (cls.fatal) {
    // auth / permission / insufficient credits — terminal, never a fallback.
    return { segment: false, status: "error", failureKind: cls.failureKind, stopReason: cls.stopReason, finishReason, errorDetail, approvalOutcome, error: state.errorMsg ?? cls.stopReason, result: base };
  }
  if (exitCode === 0 && state.terminal && state.resultSubtype === "success" && !state.isError) {
    return { segment: false, status: "done", failureKind: null, stopReason: state.stopReason, finishReason, errorDetail, approvalOutcome, error: null, result: { ...base, ok: true } };
  }
  // A model rate limit is the ONLY class eligible for a future fallback, but this
  // batch does not implement fallback: the job still ends honestly.
  //
  // A generic non-zero exit has no structured provider error to report: surface
  // the CLI's own bounded stderr evidence when it carries text so the durable
  // error is actionable, else keep the plain exit-classification message. This
  // changes only the diagnostic TEXT — status, failureKind, stopReason and
  // fallback eligibility stay exactly as classified, and a successful result
  // never carries stderr at all.
  const stderrEvidence = exitCode !== 0 ? stderrDiagnosticText(run.stderrTail) : null;
  // JQ-20261001-15: a process exit 0 is NOT proof of a successful task — the
  // provider's own terminal record may say refusal/cancel/error. This branch is
  // reached only for a non-success outcome, so the exit classification of 0
  // (`success`) must never be named in the fallback phrase. Prefer the stream's
  // structured evidence (result subtype / provider stop reason); only when the
  // stream proved nothing does the explicit non-success label apply. The
  // classification, failureKind/stopReason, fallback eligibility and terminal
  // handling above and below are untouched.
  const exitZeroReason =
    (state.resultSubtype && state.resultSubtype !== "success" ? state.resultSubtype : null) ??
    state.stopReason ??
    "no_success_result";
  const reason = exitCode === 0 ? exitZeroReason : cls.kind;
  return {
    segment: false,
    status: "error",
    failureKind: cls.failureKind ?? state.resultSubtype ?? cls.kind,
    stopReason: state.stopReason ?? cls.stopReason ?? "cli_error",
    finishReason,
    errorDetail,
    approvalOutcome,
    error:
      state.errorMsg ??
      (stderrEvidence
        ? `Command Code exited with code ${exitCode} (${reason}): ${stderrEvidence}`
        : `Command Code exited with code ${exitCode} (${reason}).`),
    result: base
  };
}

/**
 * The worker body: owns the job until it reaches a terminal state.
 *
 * Safe to call directly (the harness `worker` subcommand does). Never reruns a
 * terminal job and never writes a terminal state for a superseded generation.
 */
export async function runWorker(opts: RunWorkerOptions): Promise<RunWorkerResult> {
  const root = resolveDataRoot(opts.root, opts.env ?? process.env);
  ensureRoot(root);
  const now = opts.now ?? (() => new Date());
  const heartbeatMs = opts.heartbeatMs ?? 2000;
  const graceMs = opts.graceMs ?? 4000;
  const sleep = opts.delayFn ?? delay;
  const spawnFn = opts.spawnChildFn ?? spawn;
  const alive = opts.isAliveFn ?? isPidAlive;
  const groupAlive = opts.isProcessGroupAliveFn ?? isProcessGroupAlive;
  const enumerateFn = opts.enumerateFn;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  // The instant slots are evaluated against: an explicit seam, else the TEST-ONLY
  // `JOBQUAY_TEST_NOW` env value, else the TEST-ONLY `JOBQUAY_TEST_NOW_SHIFT_MS`
  // offset (real clock + shift, so a boundary can be reached in seconds), else the
  // real clock. Timestamps keep using `now`.
  const testNowRaw = typeof env.JOBQUAY_TEST_NOW === "string" ? env.JOBQUAY_TEST_NOW.trim() : "";
  const testNowMs = testNowRaw ? Date.parse(testNowRaw) : Number.NaN;
  const shiftRaw = typeof env.JOBQUAY_TEST_NOW_SHIFT_MS === "string" ? env.JOBQUAY_TEST_NOW_SHIFT_MS.trim() : "";
  const shiftMs = shiftRaw ? Number(shiftRaw) : Number.NaN;
  const selectNow =
    opts.selectNowFn ??
    (Number.isFinite(testNowMs)
      ? () => new Date(testNowMs)
      : Number.isFinite(shiftMs)
        ? () => new Date(Date.now() + shiftMs)
        : now);
  let job = loadJob(root, opts.jobId);
  if (!job) return { ok: false, jobId: opts.jobId, status: null, generation: 0, error: "The job does not exist." };
  if (isTerminalStatus(job.status)) {
    return { ok: true, jobId: job.id, status: job.status, generation: job.generation, error: null, note: "already_terminal" };
  }
  if (job.provider !== COMMAND_CODE_PROVIDER && job.provider !== WORKBUDDY_AI_PROVIDER) {
    return {
      ok: false,
      jobId: job.id,
      status: job.status,
      generation: job.generation,
      error: `The job uses a provider this version does not support: ${job.provider}.`,
      note: "unsupported_provider"
    };
  }
  const configResult: LoadConfigResult = job.provider === WORKBUDDY_AI_PROVIDER
    ? loadWorkBuddyAiRuntimeConfigResult(root)
    : disableModelSchedulesInLoad(loadConfigResult(root));
  const config: CrewDispatchConfig = configResult.config;
  if (job.status === "orphaned") {
    // An orphaned job's CLI tree was never proven exited. Never start a new
    // generation for it; only an explicit cancel may resolve it.
    return {
      ok: false,
      jobId: job.id,
      status: "orphaned",
      generation: job.generation,
      error: "The job is orphaned (the CLI process tree is not confirmed exited); refusing to start a new generation.",
      note: "orphaned"
    };
  }
  const registry = createGenerationRegistry();
  const persist = (): void => {
    job.updatedAt = nowIso(now);
    saveJob(root, job, now);
  };
  const killOpts: KillTreeOptions = { graceMs, isAliveFn: alive, execFileFn: opts.execFileFn, delayFn: sleep };

  // At most one terminal wake per terminal generation. Safe to call on any path
  // (it no-ops for a non-terminal job, an already-attempted generation, or a
  // generation another process claimed); a delivery failure is recorded on the
  // job and NEVER changes the job outcome. The generation is passed EXPLICITLY
  // (the one this worker just finalised) so a continuation that bumps the record
  // in the meantime cannot hide the terminal generation.
  const notifyTerminal = async (): Promise<void> => {
    try {
      await deliverTerminalNotification(root, job.id, opts.notify ?? {}, { generation: job.generation, by: "worker" });
    } catch {
      /* recorded internally; never changes the terminal outcome */
    }
  };

  // The caller approval wake runs OFF the stream/heartbeat path: the moment a
  // pending approval is durably persisted, one at-most-once delivery is started
  // for its exact (job, generation, request) identity. Delivery writes only its
  // OWN claim/result files — never the job record — so a slow Hub probe or POST
  // can never stall stdout/heartbeat/cancel or clobber later state. The in-flight
  // promises are settled (bounded by each delivery's own timeout) before this
  // worker exits, so a finished run cannot drop an attempt mid-flight.
  const approvalDeliveries = new Set<Promise<unknown>>();
  const notifyApproval = (approval: PendingApproval): void => {
    const task = deliverApprovalNotification(
      root,
      approval.jobId,
      approval.generation,
      approval.requestId,
      opts.notify ?? {},
      { by: "worker" }
    )
      .catch(() => undefined)
      .finally(() => approvalDeliveries.delete(task));
    approvalDeliveries.add(task);
  };

  // A cancel intent recorded BEFORE any CLI child exists is safe to honour
  // directly (matrix A: a queued, never-spawned job). If the record carries a
  // child tree, fall through and PROVE/kill that tree first — the intent file
  // alone is never tree-exit evidence (matrix C/E/F).
  let cancelRequested = false;
  const startupIntent = readCancelIntent(root, job.id);
  if (startupIntent) {
    cancelRequested = true;
    job.cancelIntent = { requested: true, requestedAt: job.cancelIntent.requestedAt ?? nowIso(now), by: startupIntent.by || "cancel" };
  }
  if (cancelRequested && job.childPid == null) {
    finalize(root, job, job.generation, {
      status: "cancelled",
      stopReason: "cancelled",
      error: null,
      failureKind: null,
      result: null,
      finishedAt: nowIso(now)
    }, now);
    await notifyTerminal();
    return { ok: true, jobId: job.id, status: "cancelled", generation: job.generation, error: null, note: "cancelled_before_start" };
  }

  job.owner = makeOwnerId(process.pid, now().getTime());
  job.ownerPid = process.pid;
  const ownerIdentity = platform === "darwin" ? captureProcessIdentity(process.pid) : null;
  job.ownerStartedAtUs = ownerIdentity?.createdAtUs ?? null;
  job.status = "running";
  // The approval outcome is per-ATTEMPT evidence: a new generation starts with
  // none, so a previous generation's proven rejection/expiry can never label
  // this run (or survive until this run's own settlement).
  job.approvalOutcome = null;
  job.startedAt = job.startedAt ?? nowIso(now);
  job.heartbeatAt = nowIso(now);
  persist();

  let stopped = false;
  let killPromise: Promise<void> | null = null;
  /**
   * The ONE in-flight provider-owned cancellation request of this worker
   * (JQ-20261006-58), started when the cancel intent is first observed. Null
   * until then; never started more than once. A failed request resolves to an
   * UNRESOLVED request (never `null`), so an unknown failure is never mistaken
   * for "the provider owns no work".
   */
  let providerCancelRequest: Promise<ProviderCancelRequest> | null = null;
  const kickKill = (pid: number): void => {
    if (killPromise) return;
    killPromise = killManagedTreeWithContainment({
      root,
      jobId: job.id,
      generation: job.childGeneration ?? job.generation,
      childPid: pid,
      childStartedAtMs: attemptStartedAtMs(job, job.childGeneration ?? job.generation),
      childStartedAtUs: job.childStartedAtUs,
      alive,
      killOpts,
      by: "worker",
      now,
      enumerateFn,
      ignoredPids: providerManagedIgnoredPids(job, env),
      platform
    })
      .then(() => undefined)
      .catch(() => undefined);
  };
  const tick = (): void => {
    if (stopped) return;
    job.heartbeatAt = nowIso(now);
    persist();
    if (cancelRequested) return;
    const intent = readCancelIntent(root, job.id);
    if (!intent) return;
    cancelRequested = true;
    job.cancelIntent = { requested: true, requestedAt: nowIso(now), by: intent.by || "cancel" };
    persist();
    // PROVIDER-OWNED TURN (JQ-20261006-58): the tree kill below cannot reach a
    // turn the provider runs outside CrewDispatch's child tree (WorkBuddy AI
    // runs it in the Desktop sidecar's ACP runtime). Ask the provider to cancel
    // the EXACT session/turn first; the finalisation below resolves whether the
    // owned work actually stopped. Bounded control handshake, never a turn
    // deadline, and never awaited on the heartbeat path.
    if (providerCancelRequest === null) {
      providerCancelRequest = requestProviderTurnCancel(root, job, {
        env,
        adapter: opts.providerCancel?.adapter ?? null,
        cancelTurnFn: opts.providerCancel?.cancelTurnFn,
        turnSlotKeyFn: opts.providerCancel?.turnSlotKeyFn,
        listJobsFn: opts.providerCancel?.listJobsFn,
        configDir: opts.providerCancel?.configDir,
        tmpDir: opts.providerCancel?.tmpDir,
        transport: opts.providerCancel?.transport,
        cancelAckWaitMs: opts.providerCancel?.cancelAckWaitMs
      }).catch(() => providerCancelFailureRequest(job));
    }
    const entry = registry.get(job.id);
    const pid = entry?.child.pid ?? job.childPid;
    if (pid) {
      // A WorkBuddy AI turn is cancelled THROUGH the live bridge's own ACP
      // connection (the installed runtime routes `session/cancel` only to the
      // connection that owns the in-flight prompt), so the disposable tree must
      // survive until the bounded request phase settles: the kill is chained
      // after it. The request never rejects (an unexpected failure resolves to
      // an UNRESOLVED request), and `kickKill` runs at most once.
      const request = providerCancelRequest;
      if (request) void request.then(() => kickKill(pid), () => kickKill(pid));
      else kickKill(pid);
    }
  };
  const timer = setInterval(tick, heartbeatMs);
  timer.unref();

  /**
   * Ask the provider to cancel the EXACT turn and wait (bounded) for its owned
   * cleanup, reusing the ONE in-flight request the heartbeat tick may already
   * have started. A failed request resolves to an UNRESOLVED request (never
   * null), so an unknown failure can never read as "nothing owned".
   */
  const resolveProviderCancelBeforeCancel = async (): Promise<ProviderCancelEvidence> => {
    if (providerCancelRequest === null) {
      providerCancelRequest = requestProviderTurnCancel(root, job, {
        env,
        adapter: opts.providerCancel?.adapter ?? null,
        cancelTurnFn: opts.providerCancel?.cancelTurnFn,
        turnSlotKeyFn: opts.providerCancel?.turnSlotKeyFn,
        listJobsFn: opts.providerCancel?.listJobsFn,
        configDir: opts.providerCancel?.configDir,
        tmpDir: opts.providerCancel?.tmpDir,
        transport: opts.providerCancel?.transport,
        cancelAckWaitMs: opts.providerCancel?.cancelAckWaitMs
      }).catch(() => providerCancelFailureRequest(job));
    }
    return resolveProviderOwnedTool(await providerCancelRequest, job, {
      env,
      waitMs: opts.providerCancelWaitMs,
      pollMs: 150,
      isAliveFn: alive,
      enumerateFn,
      delayFn: sleep
    });
  };

  // Never start a generation while an old tree may still be alive. If the tree
  // cannot be PROVEN stopped, keep the PID as evidence and hold the job in the
  // non-terminal `orphaned` state (never a terminal error, which would both drop
  // the PID and permit a continuation). This runs BEFORE the runner is built so
  // an unproven old tree never causes a CLI probe or a new generation.
  if (job.childPid != null) {
    const staleChildPid = job.childPid;
    const staleChildGeneration = job.childGeneration ?? job.generation;
    const tree = await ensureTreeStopped({
      root,
      jobId: job.id,
      generation: staleChildGeneration,
      childPid: staleChildPid,
      childStartedAtMs: attemptStartedAtMs(job, staleChildGeneration),
      childStartedAtUs: job.childStartedAtUs,
      alive,
      killOpts,
      by: "worker",
      now,
      enumerateFn,
      ignoredPids: providerManagedIgnoredPids(job, env),
      platform
    });
    if (!tree.stopped) {
      finalize(root, job, job.generation, {
        status: "orphaned",
        stopReason: "old_tree_alive",
        error: `The CrewDispatch-managed process tree of the previous generation's child process (PID ${staleChildPid}), including recognizable descendants, cannot be confirmed stopped; refusing to start a new generation. The child PID is retained for explicit cancel or manual handling.`,
        failureKind: "old_tree_alive",
        result: { ok: false, subtype: null, kind: "old_tree_alive", exitCode: null, stopReason: "old_tree_alive", finalText: null, fallbackEligible: false },
        childPid: staleChildPid,
        childGeneration: staleChildGeneration,
        finishedAt: null
      }, now);
      stopped = true;
      clearInterval(timer);
      return { ok: false, jobId: job.id, status: "orphaned", generation: job.generation, error: job.error };
    }
    job.childPid = null;
    job.childStartedAtUs = null;
    job.childGeneration = null;
    persist();
  }
  if (cancelRequested) {
    // A cancel with no live managed child tree is a safe terminal ONLY when the
    // provider owns no unresolved out-of-tree turn. Otherwise the exact provider
    // route must be resolved first (never settle from tree proof alone).
    const providerCancel = providerTurnUnresolved(job) ? await resolveProviderCancelBeforeCancel() : null;
    if (providerCancel) job.cancelCleanup = cancelCleanupEvidence(providerCancel, nowIso(now), "worker", job.generation);
    if (!providerCancel || providerCancelAllowsCancellation(providerCancel)) {
      finalize(root, job, job.generation, {
        status: "cancelled",
        stopReason: "cancelled",
        error: null,
        failureKind: null,
        result: null,
        finishedAt: nowIso(now)
      }, now);
      stopped = true;
      clearInterval(timer);
      await notifyTerminal();
      return { ok: true, jobId: job.id, status: "cancelled", generation: job.generation, error: null, note: "cancelled_before_start" };
    }
    finalize(root, job, job.generation, {
      status: "orphaned",
      stopReason: "provider_tool_unresolved",
      error:
        "Cancel was requested but the provider owns a turn that runs OUTSIDE the CrewDispatch-managed tree whose cleanup cannot be confirmed stopped; the cancellation evidence is retained and the job stays non-terminal rather than falsely reporting cancellation.",
      failureKind: "provider_tool_unresolved",
      result: { ok: false, subtype: null, kind: "provider_tool_unresolved", exitCode: null, stopReason: "provider_tool_unresolved", finalText: null, fallbackEligible: false },
      finishedAt: null
    }, now);
    stopped = true;
    clearInterval(timer);
    return { ok: false, jobId: job.id, status: "orphaned", generation: job.generation, error: job.error };
  }

  // A present-but-invalid config is an honest terminal failure for a Command Code
  // job: CrewDispatch never silently repairs it or quietly substitutes defaults. (A
  // missing config is normal and yields the defaults.)
  //
  if (!configResult.ok) {
    const code = configResult.error?.code ?? "config_invalid";
    const message = configResult.error?.message ?? "CrewDispatch configuration is invalid.";
    finalize(root, job, job.generation, {
      status: "error",
      stopReason: code,
      error: message,
      failureKind: code,
      result: { ok: false, subtype: null, kind: code, exitCode: null, stopReason: code, finalText: null, fallbackEligible: false },
      finishedAt: nowIso(now)
    }, now);
    stopped = true;
    clearInterval(timer);
    await notifyTerminal();
    return { ok: false, jobId: job.id, status: "error", generation: job.generation, error: message };
  }

  let runner: JobRunner;
  try {
    runner = await (opts.createRunner ?? defaultCreateRunner)({
      job,
      root,
      env,
      // An explicit test/harness CLI path wins over the provider-local
      // configured override; otherwise normal discovery applies.
      cliPath: opts.cliPath ?? config.cliPath
    });
  } catch (e) {
    const err = e instanceof JobServiceError ? e : new JobServiceError("runner_error", String((e as Error)?.message || e));
    finalize(root, job, job.generation, {
      status: "error",
      stopReason: err.code,
      error: err.message,
      failureKind: err.code,
      result: { ok: false, subtype: null, kind: err.code, exitCode: null, stopReason: err.code, finalText: null, fallbackEligible: false },
      finishedAt: nowIso(now)
    }, now);
    stopped = true;
    clearInterval(timer);
    await notifyTerminal();
    return { ok: false, jobId: job.id, status: "error", generation: job.generation, error: err.message };
  }

  // Resolve the CANDIDATE CHAIN ONCE at startup: the primary route (explicit
  // override > enabled time slot, evaluated at `selectNow` > configured default >
  // the CLI catalog default), then the configured default, then the configured
  // final rate-limit fallback — canonical-id-deduped, at most three, and ONLY
  // ids the installed CLI's own public catalog proves. The persisted
  // `modelSource`/`explicitModel`/`modelChain` let a later downgrade tell an
  // override apart from an automatic choice.
  // The ACCEPTED model/effort PLAN. A fresh job VALIDATES the intent frozen at
  // dispatch (see `AcceptedModelIntent`) against the CLI's own catalog and
  // freezes the result on the durable record; every later generation of the same
  // job — a segment resume, a rate-limit downgrade, a follow-up continuation or
  // a worker restart — REUSES the frozen plan, so a Settings edit made after
  // dispatch can never silently change a running/continued job. A legacy record
  // with neither a plan nor an intent resolves from the current config exactly
  // as before.
  //
  // The candidate the LAST generation actually ran, read BEFORE this block
  // rewrites `job.model`: a restarted/continued job resumes exactly that
  // accepted candidate+effort instead of blindly resetting to the primary.
  const lastAcceptedModel = job.model;
  let modelChain: ModelCandidate[];
  let acceptedExplicitModel: string | null;
  if (job.modelChainPlan.length > 0) {
    modelChain = job.modelChainPlan.map((e) => ({ model: e.model, source: e.source, effort: e.effort }));
    acceptedExplicitModel = job.explicitModel;
  } else {
    const chainResolution = await runner.resolveChain({
      explicit: job.explicitModel,
      cwd: job.cwd,
      env,
      config,
      now: selectNow(),
      explicitEffort: job.effort,
      // A fresh job validates the pair frozen at dispatch; a legacy record with
      // no intent (null) resolves from the current config, unchanged.
      frozen: job.acceptedIntent
    });
    if (!chainResolution.ok || chainResolution.chain.length === 0) {
      const code = chainResolution.code ?? "model_unavailable";
      finalize(root, job, job.generation, {
        status: "error",
        stopReason: code,
        error: chainResolution.error ?? "The model could not be resolved.",
        failureKind: code,
        result: { ok: false, subtype: null, kind: code, exitCode: null, stopReason: code, finalText: null, fallbackEligible: false },
        finishedAt: nowIso(now)
      }, now);
      stopped = true;
      clearInterval(timer);
      await notifyTerminal();
      return { ok: false, jobId: job.id, status: "error", generation: job.generation, error: chainResolution.error };
    }
    modelChain = chainResolution.chain;
    acceptedExplicitModel = chainResolution.explicitModel;
    job.modelChainPlan = modelChain.map((c) => ({ model: c.model, source: c.source, effort: c.effort }));
  }
  // Resume the accepted candidate the previous generation actually ran when it
  // is still part of the validated chain: a rate-limit downgrade survives a
  // worker restart / follow-up continuation on the SAME accepted model+effort
  // instead of being reset to the primary. A fresh job (its persisted model is
  // the explicit override or null) starts at the primary.
  //
  // This does NOT change the in-run downgrade semantics: a clear exit-5 rate
  // limit still advances the chain one candidate at a time, each at its OWN
  // accepted effort, and a segment resume keeps the candidate it was running.
  // It only decides where a NEW worker run begins.
  let chainIndex = 0;
  if (lastAcceptedModel) {
    const prior = modelChain.findIndex((c) => c.model === lastAcceptedModel);
    if (prior >= 0) chainIndex = prior;
  }
  const startupCandidate = modelChain[Math.min(chainIndex, modelChain.length - 1)]!;
  job.explicitModel = acceptedExplicitModel;
  job.modelChain = modelChain.map((c) => c.model);
  // Persist the candidate this worker will actually start. A restarted
  // continuation that had already downgraded must not briefly rewrite its
  // durable model/effort back to the primary before the next process starts.
  job.model = startupCandidate.model;
  job.modelSource = startupCandidate.source;
  job.effort = startupCandidate.effort;
  job.promptKind = "task";
  persist();

  // -------------------------------------------------------------------------
  // In-flight time-slot BOUNDARY switch (M1 batch 6)
  //
  // A running generation whose model came from the clock (a slot / the config
  // default / the CLI default) must not keep burning it after its window ended.
  // There is NO cloud polling and NO product wall-clock cap: one unref'd LOCAL
  // timer is armed per generation for the instant the EFFECTIVE model really
  // changes (config/select.nextModelBoundary). At that instant the handler
  // re-reads the persisted config (so the switch flag is dynamic) and then:
  //
  //   * switch OFF / invalid config / same model / unprovable target → a bounded
  //     SKIP: no kill, no restart, no model change, no new generation, no wake;
  //     the next boundary is re-armed from the CURRENT model and the LATEST
  //     config;
  //   * no durably recorded session id → SKIP (never terminate a run that cannot
  //     be resumed on the same session);
  //   * otherwise the CURRENT CLI tree is killed and its exit CONFIRMED. Only a
  //     proven-stopped old tree may raise the generation: the next generation
  //     resumes the SAME session with `--resume` and the fixed internal switch
  //     prompt (never the task), on the SAME job id. An unproven tree keeps the
  //     PID and holds the honest non-terminal `orphaned` state — a second CLI
  //     tree is NEVER started.
  //
  // An EXPLICIT per-job model never arms a timer at all (it is pinned), while the
  // rate-limit downgrade chain stays available to it.
  // -------------------------------------------------------------------------
  let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  let boundaryRequest: PendingBoundary | null = null;
  let boundaryKill: Promise<void> | null = null;

  /** Consume the pending boundary request, but ONLY for the given generation. */
  const takeBoundaryRequest = (generation: number): PendingBoundary | null => {
    const req = boundaryRequest as PendingBoundary | null;
    boundaryRequest = null;
    return req && req.generation === generation ? req : null;
  };

  const clearBoundaryTimer = (): void => {
    if (boundaryTimer) {
      clearTimeout(boundaryTimer);
      boundaryTimer = null;
    }
  };

  const switchAudit = (): SlotSwitchAudit => {
    if (!job.slotSwitch) job.slotSwitch = emptySlotSwitch();
    return job.slotSwitch;
  };

  /** Record a bounded SKIP (the boundary arrived and nothing was restarted). */
  const recordBoundarySkip = (generation: number, reason: string, wouldSwitchTo: string | null): void => {
    job.slotSwitch = pushSwitchSkip(switchAudit(), {
      generation,
      at: nowIso(now),
      reason,
      model: job.model ?? null,
      wouldSwitchTo
    });
    persist();
  };

  /** The model effective at the CURRENT instant from a given config (never stale). */
  const resolveTargetNow = (config: CrewDispatchConfig): { model: string | null; source: ModelSource; slotIndex: number | null; effort: string | null; stale: boolean } => {
    const sel = selectModel({ explicitModel: null, config, now: selectNow(), catalog: runner.catalog });
    return {
      model: sel.ok ? sel.model : null,
      source: sel.source,
      slotIndex: sel.slotIndex,
      effort: sel.ok ? effortForModelSource(config, sel.source, sel.model) : null,
      stale: !sel.ok
    };
  };

  /**
   * Arm ONE unref'd local timer for the next effective-model boundary of
   * `generation`. Re-arming always replaces the previous timer, and the audit
   * records the boundary that was found (even when the switch is OFF, because
   * the boundary is also the config re-read point).
   */
  const scheduleBoundary = (generation: number): void => {
    clearBoundaryTimer();
    const a = switchAudit();
    a.currentGeneration = generation;
    a.currentModel = job.model ?? null;
    // Scheduling is globally disabled. Keep the audit shape stable for old job
    // records, but never arm a boundary timer or inspect legacy persisted slots.
    a.switchEnabled = false;
    a.enabled = false;
    a.armed = false;
    a.nextBoundaryAt = null;
    a.nextModel = null;
    persist();
    return;
  };

  /** The boundary instant arrived: re-read the config, then act (or skip). */
  const onBoundaryReached = (generation: number): void => {
    if (stopped) return;
    // Fencing: a timer from a superseded generation may only re-arm for the
    // CURRENT one, never terminate someone else's child.
    if (job.generation !== generation) {
      scheduleBoundary(job.generation);
      return;
    }
    const cfg = loadConfigResult(root);
    const a = switchAudit();
    a.switchEnabled = cfg.ok ? cfg.config.inFlightSwitch : null;
    if (!cfg.ok) {
      recordBoundarySkip(generation, "config_invalid", null);
      scheduleBoundary(job.generation);
      return;
    }
    if (!cfg.config.inFlightSwitch) {
      // The switch is OFF at the boundary instant: nothing destructive happens.
      const target = resolveTargetNow(cfg.config);
      recordBoundarySkip(generation, "disabled", target.model && target.model !== job.model ? target.model : null);
      scheduleBoundary(job.generation);
      return;
    }
    // Re-resolve LIVE at the boundary instant: the config may have changed since
    // the timer was armed (the switch target is never the scheduled guess).
    const target = resolveTargetNow(cfg.config);
    if (!target.model || !runner.catalog.ok || runner.catalog.source !== "cli-list-models") {
      recordBoundarySkip(generation, target.stale ? "model_stale" : "catalog_unavailable", null);
      scheduleBoundary(job.generation);
      return;
    }
    if (target.model === (job.model ?? null)) {
      // Same model at the boundary (a config change back, an overlapping slot, a
      // disabled slot): NO restart.
      recordBoundarySkip(generation, "same_model", null);
      scheduleBoundary(job.generation);
      return;
    }
    const sid = job.sessionId;
    if (!isValidSessionIdFor(job.provider, sid)) {
      // No durably recorded session id: there is nothing to `--resume`, so the
      // running CLI is NOT terminated and no context-less session is created.
      recordBoundarySkip(generation, "no_session", target.model);
      scheduleBoundary(job.generation);
      return;
    }
    if (cancelRequested || readCancelIntent(root, job.id) != null) {
      // A cancel ALWAYS wins: never terminate a run to change its model.
      recordBoundarySkip(generation, "cancel_requested", target.model);
      return;
    }
    const entry = registry.get(job.id);
    const pid = entry && entry.generation === generation ? (entry.child.pid ?? job.childPid) : job.childPid;
    if (pid == null) {
      recordBoundarySkip(generation, "no_live_child", target.model);
      scheduleBoundary(job.generation);
      return;
    }
    // Ask the loop to apply the switch for THIS generation. The generation is
    // raised only after the old tree's exit is CONFIRMED (see the loop).
    boundaryRequest = { generation, model: target.model, source: target.source, effort: target.effort, slotIndex: target.slotIndex, at: nowIso(now) };
    boundaryKill = killManagedTreeWithContainment({
      root,
      jobId: job.id,
      generation,
      childPid: pid,
      childStartedAtMs: attemptStartedAtMs(job, generation),
      childStartedAtUs: job.childStartedAtUs,
      alive,
      killOpts,
      by: "boundary",
      now,
      enumerateFn,
      ignoredPids: providerManagedIgnoredPids(job, env),
      platform
    })
      .then(() => undefined)
      .catch(() => undefined);
  };

  let terminalStatus: JobStatus | null = null;
  /**
   * The candidate a boundary switch moved the job to, consumed by the NEXT
   * generation only. Without it the loop would reset `job.model` to the startup
   * chain candidate and the switch would silently not take effect.
   */
  let switchCandidate: ModelCandidate | null = null;
  // `chainIndex` (initialised above) is the index into `modelChain` of the
  // candidate the CURRENT generation runs. It advances ONLY on a clear model
  // rate limit, so each candidate runs at most once and the chain never loops.
  try {
    for (;;) {
      const generation = job.generation;
      const resumedFrom = generation > 0 ? job.sessionId : null;

      // Defensive: no recorded child should remain between generations (the
      // pre-loop check and each attempt's close handling clear it). If one does,
      // prove it stopped before starting the next attempt.
      if (job.childPid != null) {
        const staleChildPid = job.childPid;
        const staleChildGeneration = job.childGeneration ?? generation;
        const tree = await ensureTreeStopped({
          root,
          jobId: job.id,
          generation: staleChildGeneration,
          childPid: staleChildPid,
          childStartedAtMs: attemptStartedAtMs(job, staleChildGeneration),
          childStartedAtUs: job.childStartedAtUs,
          alive,
          killOpts,
          by: "worker",
          now,
          enumerateFn,
          ignoredPids: providerManagedIgnoredPids(job, env),
          platform
        });
        if (!tree.stopped) {
          finalize(root, job, generation, {
            status: "orphaned",
            stopReason: "old_tree_alive",
            error: `The CrewDispatch-managed process tree of the previous generation's child process (PID ${staleChildPid}), including recognizable descendants, cannot be confirmed stopped; refusing to start a new generation. The child PID is retained for explicit cancel or manual handling.`,
            failureKind: "old_tree_alive",
            result: { ok: false, subtype: null, kind: "old_tree_alive", exitCode: null, stopReason: "old_tree_alive", finalText: null, fallbackEligible: false },
            childPid: staleChildPid,
            childGeneration: staleChildGeneration,
            finishedAt: null
          }, now);
          terminalStatus = "orphaned";
          break;
        }
        job.childPid = null;
        job.childStartedAtUs = null;
        job.childGeneration = null;
        persist();
      }

      // A cancel with no live child tree left is a safe terminal (matrix A: the
      // CLI genuinely finished, or nothing was ever spawned for this generation)
      // ONLY when the provider owns no unresolved out-of-tree turn: otherwise the
      // exact provider route must be resolved before claiming cancelled (tree
      // proof alone is never provider-owned proof).
      if (cancelRequested || readCancelIntent(root, job.id) != null) {
        cancelRequested = true;
        const providerCancel = providerTurnUnresolved(job) ? await resolveProviderCancelBeforeCancel() : null;
        if (providerCancel) job.cancelCleanup = cancelCleanupEvidence(providerCancel, nowIso(now), "worker", generation);
        if (!providerCancel || providerCancelAllowsCancellation(providerCancel)) {
          finalize(root, job, generation, {
            status: "cancelled",
            stopReason: "cancelled",
            error: null,
            failureKind: null,
            result: null,
            finishedAt: nowIso(now)
          }, now);
          terminalStatus = "cancelled";
          break;
        }
        finalize(root, job, generation, {
          status: "orphaned",
          stopReason: "provider_tool_unresolved",
          error:
            "Cancel was requested and the CrewDispatch-managed process tree stopped, but the provider-owned work of this turn (it runs outside that tree) cannot be confirmed stopped; " +
            "the cancellation evidence is retained and the job stays pending rather than falsely reporting cancellation.",
          failureKind: "provider_tool_unresolved",
          result: { ok: false, subtype: null, kind: "provider_tool_unresolved", exitCode: null, stopReason: "provider_tool_unresolved", finalText: null, fallbackEligible: false },
          finishedAt: null
        }, now);
        terminalStatus = "orphaned";
        break;
      }

      // The candidate this generation runs: the primary first, then each
      // configured downgrade candidate in order (at most once each).
      // A boundary switch target wins for exactly ONE generation (the one it
      // created); every other generation uses the startup chain candidate.
      const candidate: ModelCandidate =
        switchCandidate ??
        modelChain[Math.min(chainIndex, modelChain.length - 1)] ??
        { model: job.model ?? "", source: job.modelSource ?? "none", effort: job.effort };
      switchCandidate = null;
      job.model = candidate.model;
      job.modelSource = candidate.source;
      // The accepted effort follows the candidate: the primary's accepted
      // effort, then each configured candidate's OWN effort.
      job.effort = candidate.effort;
      persist();

      const attempt: JobAttempt = {
        generation,
        startedAt: nowIso(now),
        endedAt: null,
        exitCode: null,
        kind: null,
        failureKind: null,
        segment: false,
        resumedFrom,
        model: candidate.model,
        modelSource: candidate.source,
        effort: candidate.effort,
        rateLimited: false,
        switched: false,
        switchToModel: null,
        usage: emptyUsage()
      };
      job.attempts = [...job.attempts, attempt];
      // A pending approval belongs to exactly ONE generation: a new attempt must
      // never inherit the previous generation's pending state.
      job.pendingApproval = null;
      persist();
      // Arm the boundary switch for THIS generation (one timer per generation;
      // re-arming always replaces the previous one).
      scheduleBoundary(generation);

      // A generation that RESUMES an already-established session (the CLI's own
      // segment boundary or a rate-limit downgrade) carries the fixed internal
      // recovery prompt, NEVER the full task again.
      const attemptPrompt =
        job.promptKind === "recovery" ? RECOVERY_PROMPT : job.promptKind === "switch" ? BOUNDARY_SWITCH_PROMPT : job.task;
      // Model-default effort provenance for a RESUMED attempt. A null
      // (model-default) effort may continue under the provider's OWN resolved
      // default value ONLY when this job can prove it never selected an explicit
      // effort for THIS model on the session it resumes. Evidence is the durable
      // attempt history EXCLUDING the just-appended current attempt, bound to the
      // owned session (the resumed id is this job's recorded session) and the
      // SELECTED model. A genuinely earlier explicit level for this model, a
      // different model's level (never proof for this model), or an unproven
      // (external) session origin stays protected.
      const effortDefaultProven = isModelDefaultEffortProven({
        priorAttempts: job.attempts.slice(0, -1),
        currentModel: candidate.model,
        currentEffort: candidate.effort,
        resumedFrom,
        sessionId: job.sessionId
      });
      const ctx: AttemptContext = {
        jobId: job.id,
        generation,
        prompt: attemptPrompt,
        model: candidate.model,
        permissionMode: job.permissionMode,
        effort: candidate.effort,
        effortDefaultProven,
        resumeSessionId: resumedFrom,
        cwd: job.cwd,
        env: opts.env ?? process.env
      };
      const built = runner.buildAttempt(ctx);
      if (!built.ok) {
        attempt.endedAt = nowIso(now);
        finalize(root, job, generation, {
          status: "error",
          stopReason: "plan_error",
          error: built.error,
          failureKind: "plan_error",
          result: { ok: false, subtype: null, kind: "plan_error", exitCode: null, stopReason: "plan_error", finalText: null, fallbackEligible: false },
          finishedAt: nowIso(now)
        }, now);
        terminalStatus = "error";
        break;
      }

      // The Command Code bridge is a CrewDispatch-owned managed root. On Darwin
      // keep that root alive for a brief terminal-handshake window so the worker
      // can snapshot ancestry BEFORE macOS reparents descendants on root exit.
      // Other providers/fixtures simply ignore this internal env key.
      const terminalAckPath =
        platform === "darwin"
          ? path.join(root, "tree", `${job.id}.g${generation}.terminal-ack`)
          : null;
      if (terminalAckPath) {
        fs.mkdirSync(path.dirname(terminalAckPath), { recursive: true });
        try { fs.unlinkSync(terminalAckPath); } catch {}
        built.env = { ...built.env, [DARWIN_TERMINAL_ACK_ENV]: terminalAckPath };
      }
      const acknowledgeDarwinTerminal = (): void => {
        if (!terminalAckPath) return;
        try {
          fs.writeFileSync(terminalAckPath, "observed\n", { encoding: "utf8", mode: 0o600 });
        } catch {
          /* bridge has its own bounded timeout; failure stays fail-closed */
        }
      };

      // The pending approval THIS generation announced, if any. It is tracked
      // separately from the job record so the worker can clear the provider's
      // request FILE even when the provider process was force-killed and could
      // not run its own cleanup (see below).
      let generationApproval: PendingApproval | null = null;

      let terminalContainment: Promise<DarwinContainmentObservation> | null = null;
      const run = await spawnAndStream({
        file: built.file,
        args: built.args,
        windowsVerbatimArguments: built.windowsVerbatimArguments,
        cwd: built.cwd,
        env: built.env,
        prompt: attemptPrompt,
        runner,
        spawnFn,
        onSpawn: async (child) => {
          registry.register(job.id, generation, child);
          job.childPid = child.pid ?? null;
          job.childStartedAtUs = null;
          job.childGeneration = generation;
          // Persist the PID immediately so a worker crash during the tiny Darwin
          // identity-pin window still leaves conservative child evidence.
          persist();

          if (platform === "darwin" && child.pid) {
            const childIdentity = await captureSpawnedDarwinIdentity(child.pid, sleep);
            if (!childIdentity) {
              throw new Error(
                `The spawned Darwin provider process (PID ${child.pid}) could not be pinned to an exact birth/session identity.`
              );
            }
            job.childStartedAtUs = childIdentity.createdAtUs ?? null;
            persist();
          }
        },
        onLine: (line) => appendLog(root, job.id, line),
        // The official session id is persisted AS THE CLI STREAM ANNOUNCES IT,
        // not only when the attempt ends: an in-flight boundary switch may have
        // to `--resume` this session while the run is still going.
        onSessionId: (sid) => {
          if (!isValidSessionIdFor(job.provider, sid) || job.sessionId === sid) return;
          job.sessionId = sid;
          persist();
        },
        // IN-FLIGHT canonical usage: while the CLI is still running, a parsed
        // change to the attempt's canonical usage is persisted with the SAME
        // semantics as the terminal write below (`toJobUsage` + `totalUsage`
        // over the attempts), so the Hub's 2.5s refresh of GET /api/jobs/:id
        // exposes fresh metrics before the process exits. The change detector
        // bounds this to ONE write per meaningful usage change — never one per
        // text/reasoning chunk. The terminal write stays authoritative.
        onUsageChange: (snapshot) => {
          attempt.usage = toJobUsage(snapshot);
          job.usage = totalUsage(job.attempts);
          persist();
        },
        // The provider-neutral pending approval of THIS generation: persisted
        // verbatim while the provider turn waits for a decision, cleared the
        // moment it stops being pending (resolved / expired / abandoned). The
        // job stays honestly `running` either way. A record whose identity is
        // not this job+generation is dropped, so a mixed/stale stream can never
        // attach an approval to the wrong attempt.

        onTerminalObserved: () => {
          if (platform !== "darwin" || terminalContainment) return;
          const pid = job.childPid;
          if (pid == null) return;
          const releaseGroup = freezeDarwinProviderGroup(pid, job.childStartedAtUs);
          if (!releaseGroup) {
            acknowledgeDarwinTerminal();
            terminalContainment = Promise.resolve({
              ok: false,
              reason: diagnoseDarwinProviderGroup(pid, job.childStartedAtUs) ?? "darwin_terminal_group_freeze_unproven",
              outsidePids: []
            });
            return;
          }
          terminalContainment = observeDarwinManagedContainment({
            childPid: pid,
            childStartedAtMs: attemptStartedAtMs(job, generation),
            childStartedAtUs: job.childStartedAtUs,
            enumerateFn,
            ignoredPids: providerManagedIgnoredPids(job, env)
          }).finally(() => {
            // Write the ACK while the exact provider group is still stopped, then
            // resume it. The bridge can only continue teardown after the bounded
            // containment observation has completed.
            acknowledgeDarwinTerminal();
            releaseGroup();
          });
        },
        onApprovalChange: (approval) => {
          if (approval && (approval.jobId !== job.id || approval.generation !== generation)) return;
          generationApproval = approval;
          job.pendingApproval = approval;
          persist();
          // ONLY after the durable persistence above: alert the ORIGINAL caller
          // conversation at most once for this exact request identity. This is
          // provider-neutral — any provider that emits a PendingApproval gets the
          // same shared wake. Delivery never blocks the stream/heartbeat path.
          if (approval) notifyApproval(approval);
        }
      });
      // The stream verdict is closed here, after the process exited and every
      // stdout line was parsed; a provider-specific hook may reconcile final state.
      runner.finalizeOnExit?.(run.state, run.exitCode);
      // The provider process (and with it any approval bridge) is gone: no
      // approval can still be pending, whatever the stream last said. The next
      // persist writes this clearance with the attempt's own terminal fields.
      // The provider's pending request FILE is cleared with it: a bridge that
      // was force-killed (cancel / teardown) never ran its own cleanup, and a
      // stale request file must never be actionable in a later run. The
      // graceful path already cleared it, so this is an idempotent safety net.
      // The assertion defeats the compiler's control-flow narrowing: the value
      // is written by the stream callback above, which the analysis cannot see.
      const abandonedApproval = generationApproval as PendingApproval | null;
      generationApproval = null;
      job.pendingApproval = null;
      if (abandonedApproval) {
        clearPendingApproval(root, abandonedApproval.jobId, abandonedApproval.generation, abandonedApproval.requestId);
      }
      registry.unregister(job.id, generation);
      // A boundary kill issued for this generation must settle BEFORE the tree
      // state is resolved, so its confirmation is already on disk.
      if (boundaryKill) {
        await boundaryKill;
        boundaryKill = null;
      }
      // A `close` event only proves the ROOT exited, never its descendants. Keep
      // the generation's PID (and start time) until the whole TREE state is
      // resolved below — the previous code cleared the PID here and then bumped
      // the generation, so a surviving detached descendant of the dead root was
      // silently forgotten and a new tree started over it.
      const closedPid = job.childPid;
      const closedGeneration = job.childGeneration ?? generation;
      const childStartedAtMs = attemptStartedAtMs(job, closedGeneration);
      const childStartedAtUs = job.childStartedAtUs;
      const terminalContainmentResult =
        platform === "darwin" && terminalContainment
          ? await (terminalContainment as Promise<DarwinContainmentObservation>).catch(() => ({
              ok: false,
              reason: "darwin_terminal_containment_failed",
              outsidePids: []
            }))
          : null;
      if (terminalAckPath) {
        try { fs.unlinkSync(terminalAckPath); } catch {}
      }

      const cls = runner.classifyExit(run.exitCode);
      attempt.endedAt = nowIso(now);
      attempt.exitCode = run.exitCode;
      attempt.kind = cls.kind;
      attempt.failureKind = cls.failureKind;
      // ONLY a clear model rate limit (exit 5) is eligible to advance the chain.
      // auth (3), permission (4), insufficient credits (10), network, unknown and
      // a user cancel are never eligible.
      const rateLimited = cls.kind === "rate_limit" && cls.fallback === true;
      attempt.rateLimited = rateLimited;
      if (run.state.sessionId) job.sessionId = run.state.sessionId;
      // This attempt's OWN usage; the job total is the SUM over attempts, so each
      // attempt contributes exactly once and an absent metric stays null (never a
      // fabricated 0).
      attempt.usage = toJobUsage(runner.normalizeUsage(run.state));
      job.usage = totalUsage(job.attempts);
      persist();

      // A natural Darwin close may become an OS-GROUP confirmation only after a
      // provider terminal record was parsed before `close`. A successful pre-close
      // snapshot must show no escaped/unknown descendant. If the snapshot races
      // with the root's own exit and the root row is already gone, the terminal
      // record + vanished owned PGID still proves that OS group exited; the scope
      // never claims an arbitrary detached descendant behind lost ancestry.
      if (
        platform === "darwin" &&
        closedPid != null &&
        childStartedAtUs != null &&
        terminalContainmentResult?.ok === true &&
        groupAlive(closedPid) === false
      ) {
        writeTreeConfirmation(root, job.id, closedGeneration, closedPid, "os_tree_exited", "worker-close", now);
      }
      const observedCancelIntent = readCancelIntent(root, job.id);
      if (cancelRequested || observedCancelIntent != null) {
        cancelRequested = true;
        // The CLI may close before the next heartbeat tick copies the
        // out-of-band intent onto the single-writer job record. Record it here
        // before any terminal decision so an explicit cancel remains auditable
        // even when the kill wins that race.
        job.cancelIntent = {
          requested: true,
          requestedAt: job.cancelIntent.requestedAt ?? observedCancelIntent?.at ?? nowIso(now),
          by: job.cancelIntent.by ?? observedCancelIntent?.by ?? "cancel"
        };
        persist();
        if (killPromise) await killPromise;
        const tree = await ensureTreeStopped({
          root,
          jobId: job.id,
          generation: closedGeneration,
          childPid: closedPid,
          childStartedAtMs,
          childStartedAtUs,
          alive,
          killOpts,
          by: "worker",
          now,
          enumerateFn,
          ignoredPids: providerManagedIgnoredPids(job, env),
          platform
        });
        // PROVIDER-OWNED TURN (JQ-20261006-58): the managed tree is only half the
        // cancellation when the provider runs the turn outside it. The run may
        // CLOSE and observe the cancel intent BEFORE the 2s heartbeat tick ever
        // started the provider request (this block sets `cancelRequested` itself),
        // so start it here if it is not already in flight: claiming `cancelled`
        // without resolving the provider-owned cleanup is exactly the defect this
        // route exists to prevent. Resolve the owned cleanup before claiming
        // (a failed request is an UNRESOLVED request, never `null`).
        const providerCancel = await resolveProviderCancelBeforeCancel();
        job.cancelCleanup = cancelCleanupEvidence(providerCancel, nowIso(now), "worker", generation);
        const providerCleaned = providerCancelAllowsCancellation(providerCancel);
        // A genuine completion ALWAYS wins over a concurrent cancel intent
        // (matrix H): the CLI really finished, so its own result is kept. When
        // the tree is not proven stopped the PID evidence is preserved so a
        // later continuation can never start a new tree over the survivors.
        const natural = decideOutcome(run, cls, runner.exit8IsSegment ?? true);
        if (natural.status === "done") {
          finalize(root, job, generation, {
            status: "done",
            stopReason: natural.stopReason,
            finishReason: natural.finishReason,
            errorDetail: natural.errorDetail,
            approvalOutcome: natural.approvalOutcome,
            error: null,
            failureKind: null,
            result: natural.result,
            // `job.usage` already holds the cumulative total; do not overwrite it
            // with this attempt's own usage.
            finishedAt: nowIso(now),
            ...(tree.stopped ? {} : { childPid: closedPid, childGeneration: closedGeneration })
          }, now);
          terminalStatus = "done";
          break;
        }
        if (tree.stopped && providerCleaned) {
          finalize(root, job, generation, {
            status: "cancelled",
            stopReason: "cancelled",
            error: null,
            failureKind: null,
            result: null,
            finishedAt: nowIso(now)
          }, now);
          terminalStatus = "cancelled";
          break;
        }
        if (tree.stopped) {
          // The managed tree stopped, but the provider-owned work of this turn
          // could not be proven stopped. `cancelled` would claim a cancellation
          // that did not happen, so the job is held with its evidence.
          finalize(root, job, generation, {
            status: "orphaned",
            stopReason: "provider_tool_unresolved",
            error:
              "Cancel was requested and the CrewDispatch-managed process tree stopped, but the provider-owned work of this turn (it runs outside that tree) cannot be confirmed stopped; " +
              "the cancellation evidence is retained and the job stays pending rather than falsely reporting cancellation.",
            failureKind: "provider_tool_unresolved",
            result: { ok: false, subtype: null, kind: "provider_tool_unresolved", exitCode: run.exitCode, stopReason: "provider_tool_unresolved", finalText: null, fallbackEligible: false },
            childPid: closedPid,
            childGeneration: closedGeneration,
            finishedAt: null
          }, now);
          terminalStatus = "orphaned";
          break;
        }
        finalize(root, job, generation, {
          status: "orphaned",
          stopReason: "tree_unconfirmed",
          error:
            "Cancel was requested, but the CrewDispatch-managed CLI process tree (including recognizable descendants) cannot be confirmed stopped (only the root process may have exited, or descendants may still be running); " +
            "the child PID is retained as evidence and the job stays pending rather than falsely reporting cancellation.",
          failureKind: "tree_unconfirmed",
          result: { ok: false, subtype: null, kind: "tree_unconfirmed", exitCode: run.exitCode, stopReason: "tree_unconfirmed", finalText: null, fallbackEligible: false },
          childPid: closedPid,
          childGeneration: closedGeneration,
          finishedAt: null
        }, now);
        terminalStatus = "orphaned";
        break;
      }

      // Resolve the whole-tree state ONCE, before deciding any outcome. A dead
      // root with live (or unknowable) descendants must never let a new
      // generation start; only a proven-stopped tree may clear the PID.
      const tree = await ensureTreeStopped({
        root,
        jobId: job.id,
        generation: closedGeneration,
        childPid: closedPid,
        childStartedAtMs,
        childStartedAtUs,
        alive,
        killOpts,
        by: "worker",
        now,
        enumerateFn,
        ignoredPids: providerManagedIgnoredPids(job, env),
        platform,
        darwinPreCloseContainment: terminalContainmentResult
      });
      if (tree.stopped && isCurrentGeneration(job, generation)) {
        job.childPid = null;
        job.childStartedAtUs = null;
        job.childGeneration = null;
        persist();
      }
      const decided = decideOutcome(run, cls, runner.exit8IsSegment ?? true);
      attempt.segment = decided.segment;
      // Consume a pending boundary request for THIS generation only — a request
      // from a superseded generation is dropped (generation fencing).
      const boundary = takeBoundaryRequest(generation);

      if (rateLimited) {
        // A CLEAR model rate limit is the ONLY class that may advance the chain.
        // auth (3) / permission (4) / credits (10) are fatal (decideOutcome has
        // already stopped them); network, unknown, a user cancel and a segment
        // boundary never reach here. A pending boundary request is DROPPED: the
        // new generation re-arms its own timer from the new model.
        if (!tree.stopped) {
          // The old tree is not proven gone: NEVER start the next candidate over
          // it. Hold the honest non-terminal state with the PID as evidence.
          finalize(root, job, generation, {
            status: "orphaned",
            stopReason: "old_tree_alive",
            error:
              `Model ${candidate.model} hit the rate limit, but the CrewDispatch-managed process tree of the previous generation's child process (PID ${closedPid}), including recognizable descendants, cannot be confirmed stopped ` +
              `(${tree.reason ?? tree.state}); refusing to start the next downgrade candidate. The child PID is retained as evidence for explicit cancel or manual handling.`,
            failureKind: "old_tree_alive",
            approvalOutcome: decided.approvalOutcome,
            result: { ...decided.result, ok: false, stopReason: "old_tree_alive" },
            childPid: closedPid,
            childGeneration: closedGeneration,
            finishedAt: null
          }, now);
          terminalStatus = "orphaned";
          break;
        }
        const next = modelChain[chainIndex + 1];
        const sid = job.sessionId;
        const validSession = isValidSessionIdFor(job.provider, sid);
        if (!next) {
          // The chain is exhausted: a bounded, honest terminal error naming every
          // candidate tried. No loop, no retry, no substitution.
          finalize(root, job, generation, {
            status: "error",
            stopReason: "rate_limit_fallback_exhausted",
            error: rateLimitExhaustedError(job),
            failureKind: cls.failureKind,
            approvalOutcome: decided.approvalOutcome,
            result: { ...decided.result, stopReason: "rate_limit_fallback_exhausted" },
            finishedAt: nowIso(now)
          }, now);
          terminalStatus = "error";
          break;
        }
        if (!validSession) {
          // Without a recorded session id there is nothing to `--resume`. Starting
          // a second, context-less session would re-send the task and risk
          // duplicated work, so stop honestly instead.
          finalize(root, job, generation, {
            status: "error",
            stopReason: "rate_limit_without_session",
            error:
              `Model ${candidate.model} hit the rate limit, but this job has no resumable session id yet, so it cannot safely downgrade on the same session; ` +
              `it will not open a new context-less session or resend the task, and ends honestly.`,
            failureKind: "rate_limit_without_session",
            approvalOutcome: decided.approvalOutcome,
            result: { ...decided.result, stopReason: "rate_limit_without_session" },
            finishedAt: nowIso(now)
          }, now);
          terminalStatus = "error";
          break;
        }
        // Advance to the next candidate: SAME job id / session / permission mode /
        // task context, a NEW generation that `--resume`s the SAME session with
        // the fixed internal recovery prompt (never the full task again). Each
        // candidate runs at most once, and each carries its OWN configured effort
        // (an explicit single-job effort never leaks onto a fallback candidate).
        chainIndex += 1;
        job.model = next.model;
        job.modelSource = next.source;
        job.effort = next.effort;
        job.promptKind = "recovery";
        job.generation = generation + 1;
        persist();
        continue;
      }

      if (boundary && decided.status !== "done" && !cls.fatal) {
        // A boundary switch was requested for THIS generation and the exit is not
        // a genuine success nor a fatal CLI failure (the exit was caused by our
        // own boundary kill). PRIORITY (deterministic): cancel > rate limit >
        // boundary switch > the CLI's own segment resume > any other terminal.
        if (!tree.stopped) {
          // The old tree could not be PROVEN stopped: the PID stays as evidence,
          // the job is held in the honest non-terminal `orphaned` state and NO new
          // CLI tree is ever started.
          job.slotSwitch = pushSwitchEvent(switchAudit(), {
            generation,
            from: job.model ?? null,
            to: boundary.model,
            at: nowIso(now),
            ok: false,
            reason: `tree_unconfirmed:${tree.state}`,
            pid: closedPid,
            scope: tree.scope
          });
          finalize(root, job, generation, {
            status: "orphaned",
            stopReason: "boundary_tree_unconfirmed",
            error:
              `The time-slot boundary was reached, but the CrewDispatch-managed process tree of the previous generation's child process (PID ${closedPid}), including recognizable descendants, cannot be confirmed stopped ` +
              `(${tree.state}); refusing to start a new generation with ${boundary.model}. The child PID is retained for explicit cancel or manual handling.`,
            failureKind: "boundary_tree_unconfirmed",
            approvalOutcome: decided.approvalOutcome,
            result: { ...decided.result, ok: false, stopReason: "boundary_tree_unconfirmed" },
            childPid: closedPid,
            childGeneration: closedGeneration,
            finishedAt: null
          }, now);
          terminalStatus = "orphaned";
          break;
        }
        // The old tree is PROVEN stopped: raise the generation NOW and resume the
        // SAME session on the new model with the fixed internal switch prompt —
        // never the task, never a second job id, never a follow-up or a terminal
        // notification (the job is not finished, it changed models).
        attempt.switched = true;
        attempt.switchToModel = boundary.model;
        job.slotSwitch = pushSwitchEvent(switchAudit(), {
          generation,
          from: job.model ?? null,
          to: boundary.model,
          at: nowIso(now),
          ok: true,
          reason: null,
          pid: closedPid,
          scope: tree.scope
        });
        job.model = boundary.model;
        job.modelSource = boundary.source;
        job.effort = boundary.effort;
        job.promptKind = "switch";
        job.generation = generation + 1;
        switchCandidate = { model: boundary.model, source: boundary.source, effort: boundary.effort };
        persist();
        continue;
      }

      if (decided.segment) {
        if (!tree.stopped) {
          // The CLI reached its internal segment boundary, but the old tree is
          // not proven gone. Do NOT bump the generation (that is the defect);
          // hold the honest non-terminal state with the PID as evidence.
          finalize(root, job, generation, {
            status: "orphaned",
            stopReason: "old_tree_alive",
            error:
              `The CLI reached its internal segment boundary (max_turns), but the CrewDispatch-managed process tree of the previous generation's child process (PID ${closedPid}), including recognizable descendants, cannot be confirmed stopped ` +
              `(${tree.state}); refusing to start a new generation. The child PID is retained as evidence for explicit cancel or manual handling.`,
            failureKind: "old_tree_alive",
            approvalOutcome: decided.approvalOutcome,
            result: { ...decided.result, ok: false, stopReason: "old_tree_alive" },
            childPid: closedPid,
            childGeneration: closedGeneration,
            finishedAt: null
          }, now);
          terminalStatus = "orphaned";
          break;
        }
        const sid = job.sessionId;
        if (isValidSessionIdFor(job.provider, sid)) {
          // Internal segment boundary WITH a valid session id and a PROVEN-stopped
          // old tree: resume the SAME logical job in a NEW generation on the SAME
          // candidate, with the fixed internal recovery prompt (never the task).
          job.promptKind = "recovery";
          job.generation = generation + 1;
          persist();
          continue;
        }
        finalize(root, job, generation, {
          status: "error",
          stopReason: "segment_without_session",
          error: "The CLI reached its internal segment boundary (max_turns), but no session id is available, so it cannot safely continue; ending honestly.",
          failureKind: "segment_without_session",
          approvalOutcome: decided.approvalOutcome,
          result: { ...decided.result, ok: false, stopReason: "segment_without_session" },
          finishedAt: nowIso(now)
        }, now);
        terminalStatus = "error";
        break;
      }

      finalize(root, job, generation, {
        status: decided.status,
        stopReason: decided.stopReason,
        finishReason: decided.finishReason,
        errorDetail: decided.errorDetail,
        approvalOutcome: decided.approvalOutcome,
        error: decided.error,
        failureKind: decided.failureKind,
        result: decided.result,
        // `job.usage` already holds the cumulative total; do not overwrite it
        // with this attempt's own usage.
        finishedAt: nowIso(now),
        // A genuine terminal result is kept, but when the tree is NOT proven
        // stopped the PID evidence is preserved so `prepareContinuation` must
        // check (and refuse) before it can start a new generation, and the
        // shared passive recovery must independently re-prove the tree stopped
        // before the workspace is released to an INDEPENDENT new job.
        ...(tree.stopped ? {} : { childPid: closedPid, childGeneration: closedGeneration })
      }, now);
      terminalStatus = decided.status;
      break;
    }
  } finally {
    stopped = true;
    clearInterval(timer);
    // No boundary timer may outlive the run (no pending kill, no late restart).
    boundaryRequest = null;
    clearBoundaryTimer();
  }

  // TEST-ONLY seam (see RunWorkerOptions.beforeNotify): the terminal state is now
  // durable and the wake has not yet been attempted.
  if (opts.beforeNotify) {
    try {
      await opts.beforeNotify();
    } catch {
      /* a test hook must never change the worker's own outcome */
    }
  }

  await notifyTerminal();
  // Settle any approval wake still in flight (each is already bounded by its own
  // Hub-probe/delivery timeout). Its result file is independent of the terminal
  // outcome and can never alter it.
  await Promise.allSettled([...approvalDeliveries]);
  return { ok: terminalStatus === "done", jobId: job.id, status: terminalStatus, generation: job.generation, error: job.error };
}

/**
 * The single terminal-write path: current generation + not already terminal.
 *
 * `childPid`/`childGeneration` are cleared by default (a resolved job has no live
 * child). If a caller explicitly retains `childPid`, the matching
 * `childStartedAtUs` is retained atomically unless explicitly replaced; orphaned
 * paths rely on this exact-incarnation evidence.
 */
function finalize(
  root: string,
  job: JobRecord,
  generation: number,
  patch: Partial<JobRecord>,
  now?: () => Date
): JobRecord {
  if (!canFinalize(job, generation)) return job;
  const childPid = "childPid" in patch ? (patch.childPid ?? null) : null;
  // If a settlement deliberately RETAINS childPid as unresolved evidence, retain
  // the exact Darwin birth beside it unless the caller explicitly replaces it.
  // Clearing the PID clears the birth too. This keeps the two identity fields
  // atomic across every orphaned/terminal evidence path.
  const childStartedAtUs =
    childPid == null
      ? null
      : "childStartedAtUs" in patch
        ? (patch.childStartedAtUs ?? null)
        : (job.childStartedAtUs ?? null);
  const childGeneration = "childGeneration" in patch ? (patch.childGeneration ?? null) : null;
  Object.assign(job, patch, {
    status: (patch.status as JobStatus) ?? job.status,
    childPid,
    childStartedAtUs,
    childGeneration,
    // The per-attempt approval evidence is written with EVERY settlement: a
    // branch that carries none (a pre-run failure, a cancellation, an
    // unconfirmed tree) clears any previous generation's token instead of
    // letting it label this terminal state.
    approvalOutcome: patch.approvalOutcome ?? null,
    // A terminal/orphaned write can never still be waiting for a provider
    // approval: the state is cleared with the settlement it belonged to.
    pendingApproval: null,
    updatedAt: nowIso(now)
  });
  const saved = saveJob(root, job, now);
  // Capture the IMMUTABLE terminal facts (generation/status/target) OUTSIDE the
  // record the moment the terminal state is written. A later continuation bumps
  // the record to a new generation; without this snapshot the old terminal
  // generation (and its wake) would become undiscoverable.
  if (isTerminalStatus(saved.status)) {
    writeTerminalSnapshot(root, saved.id, generation, saved.status, saved.notifyTarget, "worker", now);
  }
  const assistantText = saved.result?.finalText;
  if (isTerminalStatus(saved.status) && typeof assistantText === "string" && assistantText.trim()) {
    try {
      const userHistory = loadUserMessagesInfo(root, saved.id);
      const conversationGeneration = userHistory.messages[userHistory.messages.length - 1]?.generation ?? generation;
      appendAssistantMessageOrThrow(root, saved.id, {
        generation: conversationGeneration,
        text: assistantText,
        at: saved.finishedAt ?? saved.updatedAt
      });
    } catch {
      // The provider result remains authoritative even if the optional Hub history
      // side-car cannot be updated; the latest reply is still present in JobRecord.
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Status / reconcile
// ---------------------------------------------------------------------------

export interface StatusOptions {
  now?: () => Date;
  thresholdMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  /** Child (CLI process tree root) liveness probe used by reconciliation. */
  isChildAliveFn?: (pid: number) => boolean | null;
  /** Tree-exit confirmation probe used by reconciliation (tests). */
  isTreeConfirmedFn?: (job: JobRecord) => boolean;
}

/** Load a job, reconciling a provably-dead owner first. Never reruns terminal work. */
export function getStatus(root: string, jobId: string, opts: StatusOptions = {}): JobRecord | null {
  const resolved = resolveDataRoot(root, process.env);
  const job = loadJob(resolved, jobId);
  if (!job) return null;
  const nowFn = opts.now ?? (() => new Date());
  const isTreeConfirmedFn = opts.isTreeConfirmedFn ?? ((j: JobRecord) => isTreeConfirmed(resolved, j));
  const next = reconcileJob(job, nowFn().getTime(), { ...opts, isTreeConfirmedFn });
  if (next) {
    const saved = saveJob(resolved, next, nowFn);
    // A reconciliation that reached a terminal state (a stale, dead-owner job)
    // must leave the same immutable terminal snapshot a worker would, so the MCP
    // entry that triggered it can perform the one generation-scoped wake.
    if (isTerminalStatus(saved.status)) {
      writeTerminalSnapshot(resolved, saved.id, saved.generation, saved.status, saved.notifyTarget, "reconcile", nowFn);
    }
    return saved;
  }
  return job;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelOptions extends StatusOptions, KillTreeOptions {
  by?: string;
  waitMs?: number;
  delayFn?: (ms: number) => Promise<void>;
  /** Process-table enumeration used to find a dead root's descendants (tests). */
  enumerateFn?: EnumerateProcesses;
  /** Terminal-wake delivery seams used when THIS client finalises the job. */
  notify?: DeliveryDeps;
  /** Environment used for provider-owned turn resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /**
   * Bounded wait for PROVIDER-OWNED work to stop after the exact turn
   * cancellation was requested. Default 8000. Never a turn deadline.
   */
  providerCancelWaitMs?: number;
  /** Provider cancellation seams (tests). */
  providerCancel?: ProviderCancelSeam;
}

export interface CancelResult {
  job: JobRecord | null;
  kill: KillTreeResult;
  finalizedBy: "worker" | "client" | "none";
  /**
   * Evidence of the provider-owned turn cancellation, or null when the provider
   * owns no out-of-tree work for this job (JQ-20261006-58). `state: "unresolved"`
   * means the exact cancellation was requested but the owned tool cleanup could
   * not be proven, so the job was NOT claimed as cancelled.
   */
  providerCancel: ProviderCancelEvidence | null;
}

/**
 * Build the `KillTreeResult` a cancel reports, from the raw kill plus the
 * resolved tree state. It NEVER upgrades a bounded observation into an absolute
 * whole-tree guarantee:
 *   - an OS tree kill reports `os_tree_exited`;
 *   - a scoped cleanup of identifiable descendants reports
 *     `identified_descendants_stopped`;
 *   - a dead root whose visible tree is empty reports `root_exited`;
 *   - a tree already covered by validated passive recovery evidence reports
 *     `recovery_confirmed`;
 * and an unresolved tree returns the raw kill unchanged.
 */
function cancelKillResult(kill: KillTreeResult, tree: TreeStopResult): KillTreeResult {
  if (!tree.stopped) return kill;
  switch (tree.scope) {
    case "os_tree_exited":
      return { ...kill, confirmed: true, scope: "os_tree_exited" };
    case "identified_descendants_stopped":
      return {
        killed: true,
        confirmed: true,
        scope: "identified_descendants_stopped",
        pid: kill.pid,
        method: kill.method === "none" ? "identified_descendants" : kill.method
      };
    case "root_exited":
    case "recovery_confirmed":
    case "none":
      return { ...kill, confirmed: true, scope: tree.scope };
    default:
      return { ...kill, confirmed: true, scope: "unconfirmed" };
  }
}

/**
 * The UNRESOLVED provider-cancel request used when the request could not be
 * produced (a thrown config/discovery/enumeration error). It is deliberately
 * NOT `not_owned`: an unknown failure is never proof that the provider owns no
 * work, so `resolveProviderOwnedTool` returns `unresolved` and the job retains
 * its ownership evidence instead of being reported `cancelled`.
 */
function providerCancelFailureRequest(job: JobRecord): ProviderCancelRequest {
  return {
    provider: job.provider,
    route: null,
    state: "unresolved",
    requested: false,
    sessionId: job.sessionId ?? null,
    survivingPids: [],
    detail: "provider_cancel_unavailable",
    ownedRoots: [],
    ownershipUnknown: true,
    exclusive: false,
    sinceMs: attemptStartedAtMs(job, job.childGeneration ?? job.generation)
  };
}

/**
 * Explicit cancel. Idempotent: a terminal job is returned unchanged.
 *
 * Order: record intent → reconcile a dead owner → REQUEST the provider-owned
 * cancellation of the EXACT session/turn (a provider may run the turn outside the
 * tree CrewDispatch spawned) → kill the process TREE → RESOLVE whether the
 * CrewDispatch-managed and identified processes stopped → wait for the owner
 * worker to finalise → if the owner is dead, RESOLVE the provider-owned tool
 * cleanup and finalise here — but ONLY when the managed tree is resolved as
 * stopped AND the provider-owned cleanup is resolved or provably absent. An
 * unresolved kill (a dead root with no confirmation, or a root-only fallback) or
 * an unresolved provider-owned tool leaves the job non-terminal with its child
 * PID preserved (never `cancelled`), so a later explicit cancel can retry or it
 * is held for manual handling. The reported `kill.scope` states exactly what was
 * proven; it never claims an arbitrary detached descendant behind an exited
 * intermediate is gone. A superseded generation can never unregister or overwrite
 * a terminal state.
 */
export async function requestCancel(root: string, jobId: string, opts: CancelOptions = {}): Promise<CancelResult> {
  const resolved = resolveDataRoot(root, process.env);
  ensureRoot(resolved);
  const nowFn = opts.now ?? (() => new Date());
  const sleep = opts.delayFn ?? delay;
  const by = opts.by || `cancel-${process.pid}`;
  const alive = opts.isAliveFn ?? isPidAlive;
  const killOpts: KillTreeOptions = opts;
  const env = opts.env ?? process.env;

  // Raw load first so the intent lands on disk BEFORE reconciliation can settle a
  // dead-owner job: a queued, never-spawned job must end `cancelled`, not
  // `interrupted`.
  let job = loadJob(resolved, jobId);
  if (!job) {
    return { job: null, kill: { killed: false, confirmed: true, scope: "none", pid: null, method: "none", reason: "not_found" }, finalizedBy: "none", providerCancel: null };
  }
  if (isTerminalStatus(job.status)) {
    return { job, kill: { killed: false, confirmed: true, scope: "none", pid: job.childPid, method: "none", reason: "already_terminal" }, finalizedBy: "none", providerCancel: null };
  }

  writeCancelIntent(resolved, job.id, by, nowFn);

  // Reconcile now that the intent is recorded (a dead owner with a proven-stopped
  // tree may already reach a terminal state here).
  job = getStatus(resolved, jobId, opts) ?? job;
  if (isTerminalStatus(job.status)) {
    return { job, kill: { killed: false, confirmed: true, scope: "none", pid: job.childPid, method: "none", reason: "reconciled" }, finalizedBy: "client", providerCancel: null };
  }

  // PROVIDER-OWNED TURN (JQ-20261006-58): before the disposable child tree is
  // killed, ask the provider to cancel the EXACT session/turn. Its work may live
  // outside this tree (WorkBuddy AI runs it in the Desktop sidecar's ACP
  // runtime), and a Windows tree kill never delivers the signal the bridge would
  // have used. This is a bounded control handshake, never a turn deadline.
  // A request that could not even be produced (a thrown config/discovery/list
  // error) is an UNRESOLVED request, never `null`/`not_owned`: an unknown
  // failure is not proof the provider owns no work.
  let cancelRequest: ProviderCancelRequest;
  try {
    cancelRequest = await requestProviderTurnCancel(resolved, job, {
      env,
      adapter: opts.providerCancel?.adapter ?? null,
      cancelTurnFn: opts.providerCancel?.cancelTurnFn,
      turnSlotKeyFn: opts.providerCancel?.turnSlotKeyFn,
      listJobsFn: opts.providerCancel?.listJobsFn,
      configDir: opts.providerCancel?.configDir,
      tmpDir: opts.providerCancel?.tmpDir,
      transport: opts.providerCancel?.transport,
      cancelAckWaitMs: opts.providerCancel?.cancelAckWaitMs
    });
  } catch {
    cancelRequest = providerCancelFailureRequest(job);
  }

  const generation = job.childGeneration ?? job.generation;
  const managedKill = await killManagedTreeWithContainment({
    root: resolved,
    jobId: job.id,
    generation,
    childPid: job.childPid,
    childStartedAtMs: attemptStartedAtMs(job, generation),
    childStartedAtUs: job.childStartedAtUs,
    alive,
    killOpts,
    by,
    now: nowFn,
    enumerateFn: opts.enumerateFn,
    ignoredPids: providerManagedIgnoredPids(job, env)
  });
  const kill = managedKill.kill;

  // Give the owner worker a moment to observe the intent and finalise.
  const waitMs = opts.waitMs ?? 5000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    job = loadJob(resolved, jobId);
    if (!job || isTerminalStatus(job.status)) {
      return { job, kill, finalizedBy: "worker", providerCancel: asEvidence(cancelRequest) };
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }

  // The owner is not responding. Finalise here ONLY if the owner is provably
  // dead AND the managed process tree is resolved as stopped — otherwise the CLI
  // may still be running (or identified descendants may survive) and `cancelled`
  // would be a lie. An unresolved kill keeps the child PID for a later retry /
  // manual handling.
  const ownerAlive = isOwnerAlive(job, alive);
  if (ownerAlive === false && canFinalize(job, job.generation)) {
    retirePendingApproval(resolved, job);
    // An explicit cancel is the one entry point allowed to ACTIVELY clean up a
    // dead root's surviving descendants: kill them (scoped to this job's root
    // PID + generation start time) and confirm they are gone.
    const tree = await ensureTreeStopped({
      root: resolved,
      jobId: job.id,
      generation,
      childPid: job.childPid,
      childStartedAtMs: attemptStartedAtMs(job, generation),
      childStartedAtUs: job.childStartedAtUs,
      alive,
      killOpts,
      by,
      now: nowFn,
      enumerateFn: opts.enumerateFn,
      killSurvivors: true,
      ignoredPids: providerManagedIgnoredPids(job, env)
    });
    // RESOLVE the provider-owned cleanup BEFORE claiming `cancelled`: the exact
    // turn cancellation was only a REQUEST, and a provider-owned tool that is
    // still alive means the cancellation is not complete.
    const providerCancel = await resolveProviderOwnedTool(cancelRequest, job, {
      env,
      waitMs: opts.providerCancelWaitMs,
      pollMs: 150,
      isAliveFn: alive,
      enumerateFn: opts.enumerateFn,
      delayFn: sleep
    });
    if (tree.stopped && providerCancelAllowsCancellation(providerCancel)) {
      const at = nowIso(nowFn);
      const cancelled: JobRecord = {
        ...job,
        status: "cancelled",
        stopReason: "cancelled",
        error: null,
        failureKind: null,
        // The durable outcome of a PROVEN cancellation is the SAME one the
        // worker's cancelled finalizer writes: NO result. Without this, the
        // worker's intermediate nonterminal `orphaned`/`provider_tool_unresolved`
        // result (kept while the provider cleanup was unresolved) survived into
        // the terminal cancelled record and was served as the job's result
        // payload — the installed host reported `cancelled` with
        // `result.kind: provider_tool_unresolved` (JQ-20261006-58 gen-3).
        result: null,
        // The per-attempt approval token is evidence for the SAME turn as
        // `result`; a cancelled settlement carries neither (the worker's
        // terminal-write path clears it for exactly this reason).
        approvalOutcome: null,
        childPid: null,
        childStartedAtUs: null,
        childGeneration: null,
        cancelIntent: { requested: true, requestedAt: job.cancelIntent.requestedAt ?? at, by },
        // A cancelled write can never still be waiting for a provider approval.
        pendingApproval: null,
        // Durable evidence of what the provider-owned cancellation proved.
        cancelCleanup: cancelCleanupEvidence(providerCancel, at, by, generation),
        finishedAt: at,
        updatedAt: at
      };
      saveJob(resolved, cancelled, nowFn);
      // This client wrote the terminal state, so it owns the one terminal wake.
      // Snapshot the immutable terminal facts first, then wake that exact
      // generation (never the live record, which a concurrent follow-up may bump).
      writeTerminalSnapshot(resolved, cancelled.id, cancelled.generation, cancelled.status, cancelled.notifyTarget, by, nowFn);
      try {
        await deliverTerminalNotification(resolved, cancelled.id, opts.notify ?? {}, { generation: cancelled.generation, by: "cancel" });
      } catch {
        /* recorded internally; never changes the terminal outcome */
      }
      // Report EXACTLY what was proven — never force a failed kill into an
      // absolute tree guarantee.
      return { job: cancelled, kill: cancelKillResult(kill, tree), finalizedBy: "client", providerCancel };
    }
    if (!providerCancelAllowsCancellation(providerCancel)) {
      // The provider-owned work could not be proven stopped: keep the job
      // non-terminal and RETAIN the unresolved evidence instead of reporting a
      // cancellation that did not happen. A later explicit cancel retries.
      const retained: JobRecord = {
        ...job,
        cancelCleanup: cancelCleanupEvidence(providerCancel, nowIso(nowFn), by, generation),
        // A cancelled write can never still be waiting for a provider approval.
        pendingApproval: null,
        updatedAt: nowIso(nowFn)
      };
      saveJob(resolved, retained, nowFn);
      return { job: retained, kill, finalizedBy: "none", providerCancel };
    }
  }
  return { job, kill, finalizedBy: "none", providerCancel: asEvidence(cancelRequest) };
}

/**
 * The durable form of one provider-cancel evidence. Added to the job record
 * whenever a provider owns out-of-tree work for the cancelled generation, so an
 * unresolved cleanup stays auditable instead of disappearing behind `cancelled`.
 */
function cancelCleanupEvidence(evidenceValue: ProviderCancelEvidence, at: string, by: string, generation: number): CancelCleanupEvidence {
  return {
    state: evidenceValue.state === "requested" ? "unresolved" : evidenceValue.state,
    provider: evidenceValue.provider,
    generation,
    route: evidenceValue.route,
    sessionId: evidenceValue.sessionId,
    survivingPids: [...evidenceValue.survivingPids],
    detail: evidenceValue.detail,
    at,
    by
  };
}

/** The public (resolution-independent) projection of a provider cancel request. */
function asEvidence(request: ProviderCancelRequest): ProviderCancelEvidence {
  return {
    provider: request.provider,
    route: request.route,
    state: request.state,
    requested: request.requested,
    sessionId: request.sessionId,
    survivingPids: request.survivingPids,
    detail: request.detail
  };
}

/**
 * Clear the durable pending-approval FILE of the generation being cancelled.
 *
 * A bridge killed by a Windows tree kill never runs its own teardown, so the
 * request file would otherwise stay on disk as an apparently actionable approval
 * for a job that is being cancelled.
 */
function retirePendingApproval(root: string, job: JobRecord): void {
  const approval = job.pendingApproval;
  if (!approval) return;
  if (approval.jobId !== job.id) return;
  clearPendingApproval(root, approval.jobId, approval.generation, approval.requestId);
}

// ---------------------------------------------------------------------------
// Continuation (a terminal job receives a later message → new generation)
// ---------------------------------------------------------------------------

export interface ContinuationInput {
  root: string;
  jobId: string;
  task: string;
  fixturePath?: string | null;
  cliPath?: string | null;
  workerScript?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  spawnWorkerFn?: typeof spawn;
  graceMs?: number;
  isAliveFn?: (pid: number) => boolean | null;
  execFileFn?: KillTreeOptions["execFileFn"];
  delayFn?: (ms: number) => Promise<void>;
  /** Process-table enumeration used to find a dead root's descendants (tests). */
  enumerateFn?: EnumerateProcesses;
  /**
   * Terminal-wake destination for the NEW generation. When omitted the previous
   * target is kept (the continuation stays on the same logical job/wake target).
   */
  notifyTarget?: NotifyTarget;
}

export type ContinuationResult =
  | { ok: true; job: JobRecord; workerPid: number | null }
  | { ok: false; code: string; error: string; job: JobRecord | null };

/**
 * Prepare a safe continuation: a terminal job with a VALID session id is reset
 * to a new generation and re-driven with `--resume`. Refuses while an old tree
 * may still be alive, and refuses the non-terminal `orphaned` state entirely
 * (its tree was never proven exited, so no new generation may start).
 */
function canFreshRetryWithoutSession(
  job: JobRecord,
  history: ReturnType<typeof loadUserMessagesInfo>
): boolean {
  return (
    job.status === "error" &&
    !isValidSessionIdFor(job.provider, job.sessionId) &&
    (job.result?.finalText ?? null) == null &&
    history.complete &&
    Boolean(history.messages[0]?.text.trim())
  );
}

function freshRetryTask(
  history: ReturnType<typeof loadUserMessagesInfo>,
  followUpMessage: string
): string {
  const prior = history.complete
    ? history.messages.map((m) => m.text.trim()).filter(Boolean)
    : [];
  const parts = prior.length ? prior : [];
  parts.push(followUpMessage.trim());
  return [
    "The previous provider generation failed before a resumable session was established.",
    "Execute the original task from scratch in the same logical CrewDispatch job, applying all follow-up instructions below.",
    "",
    ...parts.flatMap((text, index) => [
      index === 0 ? "ORIGINAL_TASK:" : `FOLLOW_UP_${index}:`,
      text,
      ""
    ])
  ].join("\n").trim();
}

export async function prepareContinuation(input: ContinuationInput): Promise<ContinuationResult> {
  const resolved = resolveDataRoot(input.root, input.env ?? process.env);
  ensureRoot(resolved);
  const nowFn = input.now ?? (() => new Date());
  let job = loadJob(resolved, input.jobId);
  if (!job) return { ok: false, code: "not_found", error: "Task not found.", job: null };
  if (!isTerminalStatus(job.status)) {
    return { ok: false, code: "job_not_terminal", error: "Only a finished (terminal) task can be continued.", job };
  }
  const sid = job.sessionId;
  const initialHistory = loadUserMessagesInfo(resolved, job.id);
  const freshRetry = !isValidSessionIdFor(job.provider, sid) && canFreshRetryWithoutSession(job, initialHistory);
  if (!isValidSessionIdFor(job.provider, sid) && !freshRetry) {
    return { ok: false, code: "no_session", error: "No usable session ID is available, so the task cannot be safely continued (--resume requires a valid session ID).", job };
  }
  // EARLY exact-workspace check (JQ-20261002-44): when ANOTHER active job already
  // holds this directory, refuse BEFORE any side effect — not even the
  // terminal-wake snapshot below is written. The authoritative check is taken
  // again under the reservation mutex, immediately before the new generation is
  // persisted, so a holder accepted while this continuation was waiting is still
  // caught.
  const earlyWorkspace = evaluateWorkspace(resolved, job.cwd, { excludeJobId: job.id });
  if (earlyWorkspace.holder) {
    return { ok: false, code: WORKSPACE_BUSY, error: workspaceBusyMessage(earlyWorkspace.holder, earlyWorkspace.canonicalCwd), job };
  }
  // A worker may have persisted this terminal state and then exited before it
  // could write the separate wake snapshot. Capture it before advancing the
  // mutable job to a new generation, while the old status and target are still
  // available. An existing snapshot is left untouched.
  writeTerminalSnapshot(resolved, job.id, job.generation, job.status, job.notifyTarget, "resume", nowFn);
  const childAlive = input.isAliveFn ?? isPidAlive;
  if (job.childPid != null) {
    // A leftover child tree must be PROVEN stopped before a new generation may
    // start. A dead root is NOT enough: its detached descendants are found by
    // enumerating the OS process table, scoped to this generation's start time.
    const generation = job.childGeneration ?? job.generation;
    const tree = await ensureTreeStopped({
      root: resolved,
      jobId: job.id,
      generation,
      childPid: job.childPid,
      childStartedAtMs: attemptStartedAtMs(job, generation),
      childStartedAtUs: job.childStartedAtUs,
      alive: childAlive,
      killOpts: { graceMs: input.graceMs, isAliveFn: input.isAliveFn, execFileFn: input.execFileFn, delayFn: input.delayFn },
      by: "resume",
      now: nowFn,
      enumerateFn: input.enumerateFn,
      ignoredPids: providerManagedIgnoredPids(job, input.env ?? process.env)
    });
    if (!tree.stopped) {
      return {
        ok: false,
        code: "old_tree_unconfirmed",
        error: `The CrewDispatch-managed process tree of the previous child (PID ${job.childPid}), including identified descendants, could not be confirmed stopped (${tree.state}); the continuation was refused.`,
        job
      };
    }
  }
  const release = acquireJobTransitionLock(resolved, job.id);
  if (!release) {
    return { ok: false, code: "job_transition_busy", error: "The task is switching state; try again shortly.", job };
  }
  let workspaceRelease: (() => void) | null = null;
  try {
    // Retention uses the same cross-process guard while it removes a terminal
    // group's diagnostics. Re-read under the guard so two MCP/Hub requests can
    // never both advance the same generation.
    const current = loadJob(resolved, job.id);
    if (!current) return { ok: false, code: "not_found", error: "Task not found.", job: null };
    if (current.generation !== job.generation || !isTerminalStatus(current.status)) {
      return { ok: false, code: "job_not_terminal", error: "The task state changed; only a finished (terminal) task can be continued.", job: current };
    }
    job = current;
    const followUpMessage = typeof input.task === "string" && input.task.trim() ? input.task.trim() : job.task;
    const currentSid = job.sessionId;
    const previousHistory = loadUserMessagesInfo(resolved, job.id);
    const currentFreshRetry = !isValidSessionIdFor(job.provider, currentSid) && canFreshRetryWithoutSession(job, previousHistory);
    if (!isValidSessionIdFor(job.provider, currentSid) && !currentFreshRetry) {
      return { ok: false, code: "no_session", error: "No usable session ID is available, and the original task history is not safe enough for a fresh retry.", job };
    }
    // AUTHORITATIVE exact-workspace check under the reservation mutex: another
    // job may have been accepted into this directory while this continuation was
    // waiting for the old tree. `excludeJobId` keeps the SAME logical job free to
    // hold its own workspace across generations. On refusal nothing is written:
    // no generation bump, no task message, no provider process, no notification.
    const workspace = acquireWorkspace({ root: resolved, cwd: job.cwd, excludeJobId: job.id });
    if (!workspace.ok) {
      return { ok: false, code: WORKSPACE_BUSY, error: workspaceBusyMessage(workspace.holder, workspace.canonicalCwd), job };
    }
    workspaceRelease = workspace.release;
    const task = currentFreshRetry ? freshRetryTask(previousHistory, followUpMessage) : followUpMessage;
    const at = nowIso(nowFn);
    const next: JobRecord = {
      ...job,
      status: "queued",
      generation: job.generation + 1,
      task,
      // A continuation's FIRST attempt carries the new user message, never the
      // internal recovery prompt.
      promptKind: "task",
      finishedAt: null,
      result: null,
      error: null,
      failureKind: null,
      stopReason: null,
      childPid: null,
      childStartedAtUs: null,
      childGeneration: null,
      heartbeatAt: null,
      owner: "",
      ownerPid: null,
      ownerStartedAtUs: null,
      cancelIntent: { requested: false, requestedAt: null, by: null },
      // A new generation starts with no pending approval of its own.
      pendingApproval: null,
      // Keep the accumulated per-generation notification log; a NEW generation gets
      // its own claim/attempt. The target may be refreshed by the caller.
      notifyTarget: input.notifyTarget ?? job.notifyTarget,
      updatedAt: at
    };

    try {
      appendUserMessageOrThrow(resolved, job.id, { text: followUpMessage, generation: next.generation, at });
    } catch (e) {
      return {
        ok: false,
        code: "message_history_write_failed",
        error: `Failed to persist the follow-up message; the task generation is unchanged: ${String((e as Error)?.message || e)}`,
        job
      };
    }
    try {
      saveJob(resolved, next, nowFn);
    } catch (e) {
      try {
        if (previousHistory.reason === "missing") removeUserMessages(resolved, job.id);
        else writeUserMessagesInfo(resolved, job.id, previousHistory);
      } catch {
        /* best-effort rollback; the generation was not accepted */
      }
      return {
        ok: false,
        code: "continuation_persist_failed",
        error: `Failed to save the continuation generation; the task state is unchanged: ${String((e as Error)?.message || e)}`,
        job
      };
    }

    clearCancelIntent(resolved, job.id);
    // A confirmation or passive recovery evidence for the OLD generation must
    // never approve a newer one. (Both are generation-bound, so this is belt and
    // braces — but it also keeps the tree evidence directory unambiguous.)
    clearTreeConfirmation(resolved, job.id);
    clearTreeRecovery(resolved, job.id);
    // The queued generation IS the durable workspace reservation now; the short
    // cross-process mutex is released before the worker is spawned.
    workspaceRelease();
    workspaceRelease = null;
    try {
      const spawned = spawnWorker({
        root: resolved,
        jobId: job.id,
        fixturePath: input.fixturePath,
        cliPath: input.cliPath,
        workerScript: input.workerScript,
        env: input.env,
        spawnFn: input.spawnWorkerFn
      });
      return { ok: true, job: next, workerPid: spawned.pid };
    } catch (e) {
      // A continuation whose worker cannot start is a durably accepted error
      // generation, with its user message already preserved in the side-car.
      const err = e instanceof JobServiceError ? e : new JobServiceError("worker_spawn_failed", `Failed to start the task worker: ${String((e as Error)?.message || e)}`);
      const failedAt = nowIso(nowFn);
      const failed: JobRecord = {
        ...next,
        status: "error",
        stopReason: err.code,
        error: err.message,
        failureKind: err.code,
        childPid: null,
        childStartedAtUs: null,
        childGeneration: null,
        result: { ok: false, subtype: null, kind: err.code, exitCode: null, stopReason: err.code, finalText: null, fallbackEligible: false },
        finishedAt: failedAt,
        updatedAt: failedAt
      };
      saveJob(resolved, failed, nowFn);
      return { ok: false, code: err.code, error: err.message, job: failed };
    }
  } finally {
    try { workspaceRelease?.(); } catch { /* best effort */ }
    release();
  }
}
