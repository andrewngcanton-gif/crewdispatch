// acp-bridge.ts — the Command Code ACP bridge, owned by the existing
// daemon/worker: the production `command-code` provider entry launches THIS
// script (see index.ts `buildRunPlan`), it speaks the official CLI's own ACP
// protocol over stdio and translates the real protocol evidence into the
// EXISTING canonical NDJSON stream.
//
// Contract with the shared runner (unchanged):
//   * the task arrives on stdin (UTF-8, EOF-terminated);
//   * canonical records leave on stdout, one JSON object per line;
//   * the process exit code is classified by the existing Command Code exit
//     table (0/3/4/5/6/7/8/9/10/130), so the shared outcome/fallback logic is
//     untouched.
//
// Sequence for one attempt:
//   initialize -> session/new | session/resume (| session/load) -> set model ->
//   reconcile effort (explicit set + provider-state verification; a null intent
//   is only accepted when the provider's reported state proves it — a resumed
//   session's remembered explicit level with no ACP reset fails BEFORE the
//   prompt) -> set mode -> prompt. Every configuration step is validated
//   against the CLI's OWN published session state BEFORE the prompt is sent; an
//   unsupported capability or an unprovable configuration fails clearly instead
//   of being silently ignored.
//
// Interactive approvals: the CLI's `session/request_permission` requests are
// answered through the shared provider-neutral approval channel
// (src/jobs/approval-channel.ts). With no live Hub route the bridge keeps the
// historical fully non-interactive decline (the tool is denied, nothing is
// written). A pending request never outlives the connection: teardown clears it.
// Every terminal record of the turn additionally carries the most specific
// PROVEN approval outcome (`approval_outcome`: a real selected rejection, an
// expiry, a missing route, or an abandoned wait), so a completed turn whose
// gated operation never ran can never be read as an unqualified success and an
// unavailable route can never be read as a human refusal.
//
// No print-mode fallback exists: if the installed CLI cannot serve ACP, the
// bridge fails with the CLI's own error instead of silently switching transport.
import fs from "node:fs";
import { CcAcpConnection, CcAcpError } from "./acp-client";
import { ApprovalChannel, approvalOutcomeOfAnswer, mergeApprovalOutcome } from "../../jobs/approval-channel";
import { safeApprovalToken, type ApprovalOutcome } from "../../jobs/approval";
import { COMMAND_CODE_PROVIDER, normalizeEffort, normalizePermissionMode } from "./capability";
import { MODEL_TOKEN_RE, SESSION_TOKEN_RE } from "./argv";
import { CcAcpNormalizer } from "./acp-normalizer";
import {
  CC_ACP_INTERRUPTED_TEXT,
  CC_ACP_JSONRPC,
  CC_ACP_METHODS,
  CC_ACP_NO_RESPONSE_TEXT,
  CC_ACP_PROTOCOL_VERSION,
  ccAcpModeForPermissionMode,
  ccAcpStopReason,
  ccAcpTerminalForStopReason,
  classifyCcAcpRunError,
  parseCcAcpConfigOptions,
  parseCcAcpModes,
  parseCcAcpModels,
  type CcAcpConfigOptionState
} from "./acp-wire";
import type { spawn } from "node:child_process";
import { DARWIN_TERMINAL_ACK_ENV } from "../../runtime/process";

export interface CcAcpAttemptIdentity {
  jobId: string;
  generation: number;
  dataRoot: string;
}

export interface CcAcpBridgeArgs {
  cliPath: string;
  model: string;
  permissionMode: string;
  effort: string | null;
  resumeSessionId: string | null;
  /**
   * Proven model-default provenance (see `RunPlanInput.effortDefaultProven`).
   * When true AND this attempt resumes a session with a null/model-default
   * effort, the provider's own resolved concrete value is accepted as the model
   * default rather than refused as a remembered explicit level.
   */
  effortDefaultProven: boolean;
  attempt: CcAcpAttemptIdentity | null;
}

const BRIDGE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The bridge argv of one attempt (pure; used by the provider entry and tests).
 * The prompt is NEVER an argv token — it is written to the bridge's stdin.
 */
export function buildCcAcpBridgeArgv(input: {
  cliPath: string;
  model: string;
  permissionMode: string;
  effort?: string | null;
  resumeSessionId?: string | null;
  effortDefaultProven?: boolean;
  attempt?: CcAcpAttemptIdentity | null;
}): string[] {
  const argv = ["--cli", input.cliPath, "--model", input.model, "--permission", input.permissionMode];
  if (input.effort) argv.push("--effort", input.effort);
  if (input.resumeSessionId) argv.push("--resume", input.resumeSessionId);
  if (input.effortDefaultProven) argv.push("--effort-default-proven");
  if (input.attempt) {
    argv.push(
      "--job-id", input.attempt.jobId,
      "--generation", String(input.attempt.generation),
      "--data-root", input.attempt.dataRoot
    );
  }
  return argv;
}

/** Strict argv parsing: an unknown/missing/invalid flag is an honest failure. */
export function parseCcAcpBridgeArgv(argv: readonly string[]): { ok: true; args: CcAcpBridgeArgs } | { ok: false; error: string } {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const known = new Set([
    "--cli", "--model", "--permission", "--effort", "--resume", "--job-id", "--generation", "--data-root",
    "--effort-default-proven"
  ]);
  // Value-less BOOLEAN flags carry no following token.
  const booleanFlags = new Set(["--effort-default-proven"]);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === undefined) return { ok: false, error: "missing Command Code ACP bridge argument" };
    if (!known.has(flag)) return { ok: false, error: `unknown Command Code ACP bridge argument: ${JSON.stringify(flag)}` };
    if (booleanFlags.has(flag)) {
      if (booleans.has(flag)) return { ok: false, error: `duplicate ${flag}` };
      booleans.add(flag);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) return { ok: false, error: `missing value for ${flag}` };
    if (values.has(flag)) return { ok: false, error: `duplicate ${flag}` };
    values.set(flag, value);
    i += 1;
  }
  const cliPath = (values.get("--cli") ?? "").trim();
  if (!cliPath) return { ok: false, error: "missing --cli" };
  const model = (values.get("--model") ?? "").trim();
  if (!model || !MODEL_TOKEN_RE.test(model)) return { ok: false, error: `invalid --model: ${JSON.stringify(model)}` };
  const permissionMode = normalizePermissionMode(values.get("--permission"));
  if (!permissionMode) return { ok: false, error: `invalid --permission: ${JSON.stringify(values.get("--permission") ?? "")}` };
  const effortRaw = (values.get("--effort") ?? "").trim();
  const effort = effortRaw ? normalizeEffort(effortRaw) : null;
  if (effortRaw && !effort) return { ok: false, error: `invalid --effort: ${JSON.stringify(effortRaw)}` };
  const resumeRaw = (values.get("--resume") ?? "").trim();
  if (resumeRaw && !SESSION_TOKEN_RE.test(resumeRaw)) {
    return { ok: false, error: `invalid --resume session id: ${JSON.stringify(resumeRaw)}` };
  }
  const jobId = (values.get("--job-id") ?? "").trim();
  const generationRaw = (values.get("--generation") ?? "").trim();
  const dataRoot = (values.get("--data-root") ?? "").trim();
  let attempt: CcAcpAttemptIdentity | null = null;
  if (jobId || generationRaw || dataRoot) {
    if (!BRIDGE_JOB_ID_RE.test(jobId)) return { ok: false, error: `invalid --job-id: ${JSON.stringify(jobId)}` };
    const generation = Number(generationRaw);
    if (!Number.isInteger(generation) || generation < 0) {
      return { ok: false, error: `invalid --generation: ${JSON.stringify(generationRaw)}` };
    }
    if (!dataRoot) return { ok: false, error: "missing --data-root" };
    attempt = { jobId, generation, dataRoot };
  }
  return {
    ok: true,
    args: {
      cliPath,
      model,
      permissionMode,
      effort,
      resumeSessionId: resumeRaw || null,
      effortDefaultProven: booleans.has("--effort-default-proven"),
      attempt
    }
  };
}

export interface CcAcpBridgeIo {
  stdin: NodeJS.ReadableStream;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  comSpec?: string;
  spawnFn?: typeof spawn;
  killTreeFn?: (pid: number) => Promise<boolean>;
  /** Bounded wait for a graceful close before the forced tree kill. */
  closeGraceMs?: number;
  /** Install the SIGTERM/SIGINT handler (defaults to the real process). */
  registerSignalHandler?: (handler: () => void) => void;
  /** Bounded control-call timeout override (tests). */
  controlTimeoutMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Bounded, single-line, control-stripped diagnostic text. */
export function boundedOneLine(value: unknown, cap = 400): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length <= cap ? text : text.slice(0, cap);
}

function safeToken(value: unknown, cap = 200): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v && v.length <= cap ? v : null;
}

/**
 * A provider-published operation string passed to the shared approval boundary
 * UNCHOPPED: the shared sanitizer applies the display bound AND the honest
 * truncated/redacted marks. Chopping here first would silently drop an
 * oversized command and lose the truncation evidence.
 */
function rawOperationText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The provider's separately supplied argv (`toolCall.rawInput.args`). The
 * installed CLI's `shell_command` tool publishes its executable in `command`
 * and any arguments it did NOT inline in `args` as a string list (the CLI's own
 * schema recommends the separate form for shell safety); a bare string is
 * accepted too because the CLI's own permission shape accepts both. The value
 * is handed to the shared sanitizer as-is — it bounds, redacts and marks it.
 */
function rawOperationArgs(value: unknown): unknown {
  return Array.isArray(value) || typeof value === "string" ? value : null;
}

function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string | Buffer) => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    stream.on("end", () => resolve(data));
    stream.on("error", (error: Error) => reject(error));
  });
}

/** Classify a control/JSON-RPC failure (auth has its own JSON-RPC code). */
function classifyControlError(error: unknown): { exitCode: number; reason: string } {
  if (error instanceof CcAcpError) {
    if (error.code === CC_ACP_JSONRPC.AUTH_REQUIRED) {
      return { exitCode: 3, reason: boundedOneLine(error.message, 300) ?? "authentication required" };
    }
    const classified = classifyCcAcpRunError({ data: error.data, message: error.message });
    return { exitCode: classified.exitCode, reason: boundedOneLine(error.message, 300) ?? classified.reason };
  }
  return { exitCode: 1, reason: boundedOneLine((error as Error)?.message ?? String(error), 300) ?? "unknown error" };
}

/**
 * Run one attempt through the ACP bridge. Returns the process exit code; never
 * throws. `io` is injectable so a deterministic test can drive a fake ACP
 * server through the REAL bridge code.
 */
export async function runCcAcpBridge(args: CcAcpBridgeArgs, io: CcAcpBridgeIo): Promise<number> {
  const emit = (record: Record<string, unknown>): void => {
    io.stdout.write(JSON.stringify(record) + "\n");
  };
  const diag = (text: string): void => {
    const line = boundedOneLine(text, 800);
    if (line) io.stderr.write(line + "\n");
  };

  let sessionId: string | null = null;
  let approval: ApprovalChannel | null = null;
  let connection: CcAcpConnection | null = null;
  let cancelRequested = false;
  let terminalEmitted = false;
  const waitForDarwinTerminalAck = async (): Promise<void> => {
    if (!terminalEmitted || (io.platform ?? process.platform) !== "darwin") return;
    const ackPath = typeof io.env[DARWIN_TERMINAL_ACK_ENV] === "string"
      ? io.env[DARWIN_TERMINAL_ACK_ENV]!.trim()
      : "";
    if (!ackPath) return;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(ackPath)) return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /**
   * The turn's most specific PROVEN approval outcome (see jobs/approval.ts):
   * a real selected reject option, a proven expiry, a proven missing approval
   * route, or an abandoned wait. It is carried on every terminal record of the
   * turn, so a completed turn whose gated operation never ran explains that
   * fact and an unavailable route is never presented as a human refusal. It
   * never changes the terminal class, the exit code or the fallback policy.
   */
  let approvalOutcome: ApprovalOutcome | null = null;
  const noteApprovalOutcome = (outcome: ApprovalOutcome | null): void => {
    approvalOutcome = mergeApprovalOutcome(approvalOutcome, outcome);
  };

  const emitTerminal = (input: {
    subtype: "success" | "error" | "max_turns";
    stopReason?: string | null;
    error?: string | null;
    errorDetail?: string | null;
    finishReason?: string | null;
    finalText?: string;
    isError: boolean;
  }): void => {
    const record: Record<string, unknown> = { type: "result", subtype: input.subtype, is_error: input.isError };
    if (sessionId) record.session_id = sessionId;
    if (input.stopReason) record.stop_reason = input.stopReason;
    if (input.finishReason) record.finish_reason = input.finishReason;
    if (input.errorDetail) record.error_detail = input.errorDetail;
    // The turn-scoped approval outcome rides EVERY terminal record (success
    // included): the shared result path keeps it durable, so the caller, the
    // Hub and the Dashboard never have to guess the cause from prose.
    if (approvalOutcome) record.approval_outcome = approvalOutcome;
    if (input.error) record.error = input.error;
    record.finalText = input.finalText ?? "";
    terminalEmitted = true;
    emit(record);
  };

  /** Fail clearly: bounded reason, honest terminal record, no guessed success. */
  const fail = async (stage: string, reason: string, exitCode: number): Promise<number> => {
    const text = boundedOneLine(`${stage}: ${reason}`, 600) ?? "The Command Code ACP run failed.";
    emitTerminal({ subtype: "error", error: text, errorDetail: text, isError: true });
    diag(text);
    if (connection) await connection.close({ graceMs: io.closeGraceMs });
    return exitCode;
  };

  let prompt: string;
  try {
    prompt = await readAllStdin(io.stdin);
  } catch (error) {
    return fail("The task could not be read from stdin", (error as Error)?.message ?? String(error), 1);
  }
  if (!prompt.trim()) {
    return fail("The task is empty", "no prompt was provided on stdin", 1);
  }

  const acpMode = ccAcpModeForPermissionMode(args.permissionMode);
  if (!acpMode) {
    return fail("Unsupported permission mode", `${JSON.stringify(args.permissionMode)} has no ACP mode mapping`, 1);
  }

  const started = CcAcpConnection.start({
    cliPath: args.cliPath,
    cwd: io.cwd,
    env: io.env,
    platform: io.platform,
    comSpec: io.comSpec,
    spawnFn: io.spawnFn,
    killTreeFn: io.killTreeFn,
    controlTimeoutMs: io.controlTimeoutMs
  });
  if (!started.ok) {
    return fail("The Command Code ACP process could not be started", started.error, 1);
  }
  connection = started.connection;
  const conn = connection;

  // Interactive approvals: bound to the exact job+generation; absent identity
  // keeps the bridge fully non-interactive (the historical decline).
  if (args.attempt) {
    approval = new ApprovalChannel(
      {
        jobId: args.attempt.jobId,
        generation: args.attempt.generation,
        dataRoot: args.attempt.dataRoot,
        provider: COMMAND_CODE_PROVIDER
      },
      { emit, env: io.env }
    );
  }
  conn.onRequest(async (method, params, id) => {
    if (method !== CC_ACP_METHODS.SESSION_REQUEST_PERMISSION) {
      throw new CcAcpError(CC_ACP_JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
    const request = asRecord(params);
    const toolCall = asRecord(request?.toolCall);
    const requestId = typeof id === "number" ? String(id) : safeToken(id, 64) ?? `perm-${Date.now()}`;
    const rawInput = asRecord(toolCall?.rawInput);
    const toolName = safeApprovalToken(toolCall?.kind, 64);
    // The provider's OWN named operation fields, never the request wholesale.
    // `command` + `args` is the complete operation the CLI will run: its own
    // `shell_command` tool may carry the executable alone and the arguments
    // separately, so dropping `args` would show a human `node` for a real
    // `node wait-for-resume.cjs`. Bounding/redaction/truncation marks are the
    // shared sanitizer's job (see jobs/approval.ts).
    const detail = {
      title: rawOperationText(toolCall?.title),
      command: rawOperationText(rawInput?.command),
      args: rawOperationArgs(rawInput?.args),
      description: rawOperationText(rawInput?.description),
      path: rawOperationText(rawInput?.file_path) ?? rawOperationText(rawInput?.path),
      cwd: rawOperationText(rawInput?.cwd)
    };
    if (!approval) {
      // No approval channel exists at all for this attempt (the bridge was
      // launched without a job binding): the PROVEN cause is a missing
      // interactive route, never a human decision.
      noteApprovalOutcome("no_route");
      return { outcome: { outcome: "cancelled" } };
    }
    const answer = await approval.request(requestId, { kind: "tool_approval", toolName, detail }, params);
    // Record exactly what the answer proves BEFORE replying: only a real
    // selected reject option becomes `rejected`; a decline keeps its own
    // proven cause (no route / no allow option / publish failure), an expiry
    // stays an expiry and an abandoned wait stays cancelled.
    noteApprovalOutcome(approvalOutcomeOfAnswer(answer));
    if (answer.kind === "selected") {
      return { outcome: { outcome: "selected", optionId: answer.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  });

  const onSignal = (): void => {
    cancelRequested = true;
    approval?.cancel();
    if (sessionId) conn.notify(CC_ACP_METHODS.SESSION_CANCEL, { sessionId });
    // A bounded fallback: if the turn does not settle, tear the child down.
    setTimeout(() => {
      void conn.close({ graceMs: 1000 });
    }, 3000).unref?.();
  };
  (io.registerSignalHandler ?? ((handler: () => void) => {
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  }))(onSignal);

  try {
    // ---- initialize ----
    let initResult: unknown;
    try {
      initResult = await conn.request(CC_ACP_METHODS.INITIALIZE, {
        protocolVersion: CC_ACP_PROTOCOL_VERSION,
        clientCapabilities: {}
      });
    } catch (error) {
      const classified = classifyControlError(error);
      return fail("The installed Command Code CLI did not accept an ACP initialize", classified.reason, classified.exitCode);
    }
    const capabilities = asRecord(asRecord(initResult)?.agentCapabilities);
    if (!capabilities) {
      return fail("The installed Command Code CLI published no ACP agent capabilities", "initialize returned no agentCapabilities", 1);
    }
    const sessionCapabilities = asRecord(capabilities.sessionCapabilities) ?? {};

    // ---- attach a session ----
    let attachResult: unknown;
    if (args.resumeSessionId) {
      const canResume = sessionCapabilities.resume !== undefined;
      const canLoad = capabilities.loadSession === true;
      if (!canResume && !canLoad) {
        return fail(
          "This session cannot be continued over ACP",
          "the installed CLI publishes neither session/resume nor session/load",
          1
        );
      }
      const attachParams = { sessionId: args.resumeSessionId, cwd: io.cwd, mcpServers: [] };
      try {
        attachResult = canResume
          ? await conn.request(CC_ACP_METHODS.SESSION_RESUME, attachParams)
          : await conn.request(CC_ACP_METHODS.SESSION_LOAD, attachParams);
      } catch (error) {
        // A CLI that publishes the capability but not the method falls back to
        // the other attach form ONCE; any other failure is reported honestly.
        if (canResume && canLoad && error instanceof CcAcpError && error.code === CC_ACP_JSONRPC.METHOD_NOT_FOUND) {
          try {
            attachResult = await conn.request(CC_ACP_METHODS.SESSION_LOAD, attachParams);
          } catch (second) {
            const classified = classifyControlError(second);
            return fail("The existing Command Code session could not be loaded over ACP", classified.reason, classified.exitCode);
          }
        } else {
          const classified = classifyControlError(error);
          return fail("The existing Command Code session could not be resumed over ACP", classified.reason, classified.exitCode);
        }
      }
      sessionId = args.resumeSessionId;
    } else {
      try {
        attachResult = await conn.request(CC_ACP_METHODS.SESSION_NEW, { cwd: io.cwd, mcpServers: [] });
      } catch (error) {
        const classified = classifyControlError(error);
        return fail("A Command Code ACP session could not be created", classified.reason, classified.exitCode);
      }
      const created = safeToken(asRecord(attachResult)?.sessionId, 200);
      if (!created) {
        return fail("A Command Code ACP session could not be created", "session/new returned no session id", 1);
      }
      sessionId = created;
    }

    // The session id is announced BEFORE any configuration, so an in-flight
    // boundary switch can already resume this exact session.
    emit({ type: "event", event: { type: "init", session_id: sessionId, model: args.model } });

    let configOptions: CcAcpConfigOptionState[] = parseCcAcpConfigOptions(attachResult);
    const applyConfigState = (value: unknown): void => {
      const parsed = parseCcAcpConfigOptions(value);
      if (parsed.length) configOptions = parsed;
    };
    const effortOptionOf = (): CcAcpConfigOptionState | undefined =>
      configOptions.find((option) => option.id === "effort");
    const hasModelOption = (): boolean => configOptions.some((option) => option.id === "model");
    const modelOptionValue = (): string | null =>
      configOptions.find((option) => option.id === "model")?.currentValue ?? null;
    // Bounded wait for the provider's OWN published state to settle after a
    // change (the installed CLI returns the updated `configOptions` in the set
    // response AND emits `config_option_update`; either is authoritative).
    let configWaiters: Array<() => void> = [];
    const wakeConfigWaiters = (): void => {
      const waiters = configWaiters;
      configWaiters = [];
      for (const wake of waiters) wake();
    };
    const waitForConfigState = (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
      if (predicate()) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          resolve(predicate());
        };
        const timer = setTimeout(() => {
          configWaiters = configWaiters.filter((entry) => entry !== waiter);
          resolve(predicate());
        }, timeoutMs);
        configWaiters.push(waiter);
      });
    };
    const configVerifyMs = Math.min(io.controlTimeoutMs ?? 30_000, 5_000);
    const normalizer = new CcAcpNormalizer({ emit, freshSession: !args.resumeSessionId });
    // Registered only AFTER the attach completed, so a `session/load` history
    // replay (which arrives before its response) is never translated into this
    // attempt's stream: a previous generation is never duplicated.
    conn.onNotification((method, params) => {
      if (method !== CC_ACP_METHODS.SESSION_UPDATE) return;
      const update = asRecord(params)?.update;
      // A `config_option_update` publishes the CURRENT model's own effort
      // options; it is the authoritative state for the effort gate below.
      const record = asRecord(update);
      if (record?.sessionUpdate === "config_option_update") {
        applyConfigState(record);
        wakeConfigWaiters();
      }
      normalizer.handleUpdate(update);
    });

    // ---- configure the session BEFORE the prompt ----
    const models = parseCcAcpModels(attachResult);
    if (!models || models.availableModels.length === 0) {
      return fail(
        `The model ${args.model} cannot be verified for this session`,
        "the installed CLI's ACP session published no model state",
        1
      );
    }
    if (!models.availableModels.some((model) => model.modelId === args.model)) {
      const offered = models.availableModels.map((model) => model.modelId).slice(0, 12).join(", ");
      return fail(
        `The model ${args.model} is not offered by the installed Command Code CLI`,
        `its ACP session offers: ${offered}`,
        1
      );
    }
    const modelChanged = models.currentModelId !== args.model;
    if (modelChanged) {
      let setModelResult: unknown;
      try {
        setModelResult = await conn.request(CC_ACP_METHODS.SESSION_SET_MODEL, { sessionId, modelId: args.model });
      } catch (error) {
        const classified = classifyControlError(error);
        return fail(`The model ${args.model} could not be selected`, classified.reason, classified.exitCode);
      }
      // The installed CLI's set_model result carries the NEW model's own
      // config state (model + effort); applying it is what makes the effort
      // gate below describe the REQUESTED model rather than the previous one.
      applyConfigState(setModelResult);
      if (hasModelOption() && modelOptionValue() !== args.model) {
        const settled = await waitForConfigState(() => modelOptionValue() === args.model, configVerifyMs);
        if (!settled) {
          return fail(
            `The model ${args.model} could not be verified after selection`,
            `the session reports ${JSON.stringify(modelOptionValue())}; refusing to prompt under an unconfirmed model`,
            1
          );
        }
      }
    }

    // ---- reconcile the requested effort with the provider's reported state ----
    // The frozen intent is either an explicit level or null (= the model's own
    // default). The CLI remembers per-model effort across a session resume and
    // CANNOT reset an explicit level back to "default" (`-32602 Unknown effort:
    // default` once a level is set), so an omitted setter is never treated as
    // proof of the default.
    if (args.effort) {
      const effortOption = effortOptionOf();
      if (!effortOption) {
        return fail(
          `The model ${args.model} has no reasoning effort setting`,
          "its ACP session published no effort option",
          1
        );
      }
      if (effortOption.values.length > 0 && !effortOption.values.includes(args.effort)) {
        return fail(
          `The model ${args.model} does not support reasoning effort ${JSON.stringify(args.effort)}`,
          `its published efforts are: ${effortOption.values.join(", ")}`,
          1
        );
      }
      let setEffortResult: unknown;
      try {
        setEffortResult = await conn.request(CC_ACP_METHODS.SESSION_SET_CONFIG_OPTION, {
          sessionId,
          configId: "effort",
          value: args.effort
        });
      } catch (error) {
        const classified = classifyControlError(error);
        return fail(
          `The reasoning effort ${JSON.stringify(args.effort)} could not be set for model ${args.model}`,
          classified.reason,
          classified.exitCode
        );
      }
      applyConfigState(setEffortResult);
      const verified = await waitForConfigState(() => effortOptionOf()?.currentValue === args.effort, configVerifyMs);
      if (!verified) {
        return fail(
          `The reasoning effort ${JSON.stringify(args.effort)} could not be verified for model ${args.model}`,
          `the session reports ${JSON.stringify(effortOptionOf()?.currentValue ?? null)} after the change; refusing to prompt with an unconfirmed effort`,
          1
        );
      }
    } else {
      const effortOption = effortOptionOf();
      if (effortOption && effortOption.currentValue !== "default") {
        if (effortOption.values.includes("default")) {
          // A PROVEN reset exists on this build: select the model default and
          // verify the provider's own state actually reports it.
          let resetResult: unknown;
          try {
            resetResult = await conn.request(CC_ACP_METHODS.SESSION_SET_CONFIG_OPTION, {
              sessionId,
              configId: "effort",
              value: "default"
            });
          } catch (error) {
            const classified = classifyControlError(error);
            return fail(
              `The reasoning effort of model ${args.model} could not be reset to its default`,
              classified.reason,
              classified.exitCode
            );
          }
          applyConfigState(resetResult);
          const reset = await waitForConfigState(() => effortOptionOf()?.currentValue === "default", configVerifyMs);
          if (!reset) {
            return fail(
              `The reasoning effort of model ${args.model} could not be reset to its default`,
              `the session reports ${JSON.stringify(effortOptionOf()?.currentValue ?? null)} after the reset`,
              1
            );
          }
        } else if (args.effortDefaultProven) {
          // PROVEN model-default provenance for an OWNED resumed session: this
          // job created the session and can prove it never selected an explicit
          // effort for THIS model, so the provider's concrete reported value is
          // its OWN resolution of the model default — never a remembered
          // explicit level. Accept the provider's reported state without a
          // setter. An unproven provenance falls through to the guard below.
        } else if (args.resumeSessionId) {
          // A RESUMED session can remember an explicit level from an earlier
          // generation. This CLI publishes no way to reset it over ACP, and a
          // first observed explicit value cannot be distinguished from a
          // remembered one — so the run fails clearly BEFORE the prompt rather
          // than silently inheriting it.
          return fail(
            `The resumed session remembers reasoning effort ${JSON.stringify(effortOption.currentValue)} for model ${args.model}`,
            "the installed Command Code CLI cannot reset an explicit effort to the model default over ACP (it rejects \"default\" with -32602 once a level is set); refusing to prompt at a remembered level. Set an explicit reasoning effort for this job, or do not resume that session.",
            1
          );
        }
        // FRESH session: this attempt created the session with `session/new`, so
        // an explicit value here is the provider's OWN resolution for a brand
        // new session (its configured default) — it cannot be a remembered
        // level from an earlier generation. Proceeding without a setter is
        // accepting the provider's reported state, not assuming the default.
      }
    }

    const modes = parseCcAcpModes(attachResult);
    if (!modes || modes.availableModes.length === 0) {
      return fail("The requested permission mode cannot be verified", "the installed CLI's ACP session published no mode state", 1);
    }
    if (!modes.availableModes.some((mode) => mode.id === acpMode)) {
      const offered = modes.availableModes.map((mode) => mode.id).join(", ");
      return fail(
        `The permission mode ${JSON.stringify(args.permissionMode)} is not offered over ACP`,
        `the installed CLI publishes: ${offered}`,
        1
      );
    }
    if (modes.currentModeId !== acpMode) {
      try {
        await conn.request(CC_ACP_METHODS.SESSION_SET_MODE, { sessionId, modeId: acpMode });
      } catch (error) {
        const classified = classifyControlError(error);
        return fail(`The permission mode ${JSON.stringify(args.permissionMode)} could not be set`, classified.reason, classified.exitCode);
      }
    }

    // ---- run the turn ----
    // Everything observed after this point is THIS turn's work: the cost
    // normalizer reconciles cumulative cost only against a baseline proven
    // before the prompt (0 for a fresh session, or a pre-prompt observation).
    normalizer.markPromptStarted();
    emit({ type: "event", event: { type: "turn_start" } });
    let promptResult: unknown;
    try {
      promptResult = await conn.request(
        CC_ACP_METHODS.SESSION_PROMPT,
        { sessionId, prompt: [{ type: "text", text: prompt }] },
        null
      );
    } catch (error) {
      // A failed prompt can still have streamed reasoning before the failure.
      // Close the display block at the turn boundary so explicit Show reasoning
      // keeps that real provider output instead of silently dropping it.
      normalizer.flushReasoning();
      emit({ type: "event", event: { type: "turn_end" } });
      const childExit = conn.exit();
      const summary = normalizer.summary();
      const deniedFinish = summary.deniedTool || approvalOutcome !== null ? "permission_denied" : null;
      // A provider connection that ended without a result is DISTINCT evidence:
      // the official CLI's own exit code when it published one, else "no
      // response". It is never mapped to a rate limit.
      if (childExit.exited && typeof childExit.code === "number" && childExit.code !== 0) {
        const text = boundedOneLine(
          `The Command Code CLI exited with code ${childExit.code} before the turn produced a result.`,
          400
        ) ?? "The Command Code CLI exited before the turn produced a result.";
        emitTerminal({ subtype: "error", error: text, errorDetail: text, finishReason: "provider_exit", isError: true });
        diag(text);
        return childExit.code;
      }
      if (error instanceof CcAcpError && error.code === CC_ACP_JSONRPC.INTERNAL_ERROR && error.data !== undefined) {
        const classified = classifyCcAcpRunError({ data: error.data, message: error.message });
        const text = boundedOneLine(`${classified.reason}: ${error.message}`, 600) ?? classified.reason;
        emitTerminal({ subtype: "error", error: text, errorDetail: text, finishReason: deniedFinish, isError: true });
        diag(text);
        return classified.exitCode;
      }
      const text = boundedOneLine(`The Command Code ACP turn failed: ${(error as Error)?.message ?? String(error)}`, 600)
        ?? "The Command Code ACP turn failed.";
      emitTerminal({ subtype: "error", error: text, errorDetail: text, finishReason: "provider_eof", isError: true });
      diag(text);
      return 9; // the CLI's own "no response" class
    }

    normalizer.handlePromptResult(promptResult);
    emit({ type: "event", event: { type: "turn_end" } });
    const summary = normalizer.summary();
    const stopReason = ccAcpStopReason(promptResult);
    const outcome = ccAcpTerminalForStopReason(stopReason);
    const deniedFinish = summary.deniedTool || approvalOutcome !== null ? "permission_denied" : null;

    if (outcome.kind === "success" && summary.finalText.trim()) {
      // The CLI's own mapping is `permission_denied -> end_turn` (the model is
      // told the tool was denied and may still finish the turn), so a denied
      // operation on a completed turn keeps its own bounded refinement rather
      // than disappearing: the denial is durable evidence, not a success story.
      // The turn's proven cause travels beside it as `approval_outcome`, so a
      // human rejection, an expiry and a missing approval route stay
      // distinguishable on the SAME completed turn.
      emitTerminal({
        subtype: "success",
        stopReason: "end_turn",
        finishReason: deniedFinish,
        finalText: summary.finalText,
        isError: false
      });
      return 0;
    }
    if (outcome.kind === "success") {
      // The turn completed without any answer: the CLI's own no-response class
      // (exit 9), never a fabricated success and never a rate limit.
      emitTerminal({
        subtype: "error",
        error: CC_ACP_NO_RESPONSE_TEXT,
        errorDetail: CC_ACP_NO_RESPONSE_TEXT,
        finishReason: deniedFinish,
        finalText: "",
        isError: true
      });
      diag(CC_ACP_NO_RESPONSE_TEXT);
      return 9;
    }
    if (outcome.kind === "max_turns") {
      emitTerminal({ subtype: "max_turns", stopReason: "max_turn_requests", finalText: summary.finalText, isError: true });
      return 8;
    }
    if (outcome.kind === "cancelled") {
      const text = boundedOneLine(
        cancelRequested ? CC_ACP_INTERRUPTED_TEXT : "The turn was cancelled before it completed.",
        400
      ) ?? "The turn was cancelled.";
      emitTerminal({
        subtype: "error",
        stopReason: "cancelled",
        error: text,
        errorDetail: text,
        finalText: summary.finalText,
        isError: true
      });
      return 130;
    }
    const text = boundedOneLine(`The turn ended with an unrecognized stop reason: ${stopReason ?? "(none)"}`, 400)
      ?? "The turn ended without a recognized completion.";
    emitTerminal({
      subtype: "error",
      stopReason,
      error: text,
      errorDetail: text,
      finishReason: "unknown_stop_reason",
      finalText: summary.finalText,
      isError: true
    });
    return 1;
  } finally {
    approval?.dispose();
    await waitForDarwinTerminalAck();
    if (connection) {
      const sessionToClose = sessionId;
      connection.setCloseSession(
        sessionToClose ? () => connection!.request(CC_ACP_METHODS.SESSION_CLOSE, { sessionId: sessionToClose }, 5000) : null
      );
      const closed = await connection.close({ graceMs: io.closeGraceMs });
      if (!closed.exited) {
        diag("The Command Code ACP child process could not be proven exited.");
      }
      const tail = connection.stderrTail();
      if (tail) diag(tail);
    }
  }
}

/** The real entry point: run the bridge against the current process's stdio. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCcAcpBridgeArgv(argv);
  if (!parsed.ok) {
    process.stderr.write(`Command Code ACP bridge: ${parsed.error}\n`);
    return 1;
  }
  return runCcAcpBridge(parsed.args, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd()
  });
}

// The compiled bridge is launched directly (`node dist/providers/command-code/acp-bridge.js`).
if (typeof require !== "undefined" && require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
