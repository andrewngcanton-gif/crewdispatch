import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ApprovalChannel,
  approvalOutcomeOfAnswer,
  mergeApprovalOutcome,
  WORKBUDDY_APPROVAL_PROVIDER_ID,
  type ApprovalOutcome
} from "./approval-channel";
import { TurnCancelChannel } from "./cancel-channel";
import { jobRuntimeId, registerOwnedRuntime, releaseRegisteredRuntime, markRuntimeSettled } from "./runtime-lifecycle";
import { captureProcessIdentity, DARWIN_TERMINAL_ACK_ENV } from "../../runtime/process";
import {
  ACP_FAILURE_MODEL_ERROR,
  acpHttpStatusFromErrorDetail,
  acpErrorResultRecord,
  acpInitRecord,
  acpTerminalResultRecord,
  acpToolApprovalEvidence,
  createAcpNormalizer,
  safeAcpErrorDetail,
  safeAcpEvidenceToken,
  safeAcpFinishReason,
  safeAcpHttpStatus,
  type AcpApprovalEvidence,
  type AcpNormalizer
} from "./acp-normalizer";

const SIDECAR_VERSION = 6;
const BRIDGE_VERSION = 2;
const CONTROL_TIMEOUT_MS = 15_000;
const SESSION_CREATE_TIMEOUT_MS = 60_000;
const ACP_REQUEST_TIMEOUT_MS = 45_000;
const SIDECAR_RECOVERY_CONNECT_RETRIES = 3;
const SIDECAR_RECOVERY_RETRY_MS = 200;
const SIDECAR_START_TIMEOUT_MS = 10_000;
const SIDECAR_MAX_OLD_SPACE_SIZE_FLAG = "--max-old-space-size=1024";
const WORKBUDDY_CREDENTIAL_POLICY = "fields";
const DESKTOP_APP_PROBE_TIMEOUT_MS = 3_000;


export async function waitForDarwinTerminalAck(opts: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  existsFn?: (path: string) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
} = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return;
  const env = opts.env ?? process.env;
  const ackPath = typeof env[DARWIN_TERMINAL_ACK_ENV] === "string" ? env[DARWIN_TERMINAL_ACK_ENV]!.trim() : "";
  if (!ackPath) return;
  const exists = opts.existsFn ?? fs.existsSync;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + Math.max(0, opts.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    try {
      if (exists(ackPath)) return;
    } catch {
      return;
    }
    await sleep(10);
  }
}

type JsonObject = Record<string, unknown>;

interface BridgeArgs {
  cliPath: string;
  model: string;
  permission: string;
  effort: string | null;
  resumeSessionId: string | null;
  disposeRuntime: boolean;
  /**
   * The owning CrewDispatch attempt, when the worker supplied it. Together these
   * bind an interactive approval to the exact job+generation; without them the
   * bridge keeps its historical fully non-interactive decline.
   */
  jobId: string | null;
  generation: number | null;
  dataRoot: string | null;
}

interface SidecarPidFile {
  pid: number;
  version: number;
  controlPipeUuid: string;
}

export interface SidecarSession {
  sessionId: string;
  acpEndpoint: string;
  runtimeId?: string;
  pid?: number;
}

interface RuntimeHandle extends SidecarSession {
  reused: boolean;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Null only for a real long-running provider turn, which has no CrewDispatch deadline. */
  timer: NodeJS.Timeout | null;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function boundedMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>").slice(0, 2000);
}

/**
 * Bounded, transport-proven evidence of one JSON-RPC error response.
 *
 * The installed runtime answers a `session/prompt` whose model stream ended
 * with `finish_reason=error` by REJECTING the request with a JSON-RPC error
 * (JQ-20261001-24; read locally from `cli/dist/codebuddy-headless.js`: the
 * AcpView catch logs "provider finish_reason=error — rejecting session/prompt
 * as JSON-RPC error" and the runtime's own `isProviderFinishReasonError`
 * matches `data.reason === "provider_finish_reason_error"`). Its RequestError
 * serializes as `{code, message, data}` — the bridge keeps ONLY bounded safe
 * tokens from `data`, never the payload itself.
 */
export interface AcpRpcErrorEvidence {
  /** The JSON-RPC error code (the model error is the runtime's -32004). */
  code: number | string | null;
  /** A bounded HTTP status when the runtime publishes one in error.data. */
  httpStatus: number | null;
  /** The runtime's own error category token ("model_service"), when published. */
  category: string | null;
  /** The provider's original finish reason token ("error"), when published. */
  finishReason: string | null;
  /** The runtime's own reason token ("provider_finish_reason_error"), when published. */
  reason: string | null;
}

const ACP_RPC_ERROR_EVIDENCE = Symbol("jobquay.acpRpcErrorEvidence");

/** The bounded evidence attached to one rejected ACP request, or null. */
export function readAcpRpcErrorEvidence(error: unknown): AcpRpcErrorEvidence | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<symbol, unknown>)[ACP_RPC_ERROR_EVIDENCE];
  return value && typeof value === "object" ? value as AcpRpcErrorEvidence : null;
}

function sha1(value: string, length: number): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, length);
}

export function workBuddyDesktopConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WORKBUDDY_CONFIG_DIR?.trim() || env.CODEBUDDY_CONFIG_DIR?.trim();
  return configured || path.join(os.homedir(), ".workbuddy-ai");
}

export function workBuddyDesktopInstanceToken(configDir: string): string {
  return sha1(configDir, 12);
}

export function workBuddyDesktopSidecarPidPath(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
  tmpDir = os.tmpdir()
): string {
  const token = workBuddyDesktopInstanceToken(configDir);
  if (platform === "linux") {
    const xdg = process.env.XDG_RUNTIME_DIR?.trim();
    if (xdg) return path.join(xdg, "workbuddy", token, "sidecar.pid");
    if (typeof process.getuid === "function") return path.join("/run/user", String(process.getuid()), "workbuddy", token, "sidecar.pid");
  }
  const uid = platform === "win32" || typeof process.getuid !== "function" ? null : process.getuid();
  const base = uid == null ? "wb" : `wb-${sha1(String(uid), 6)}`;
  return path.join(tmpDir, base, token, "sidecar.pid");
}

export function workBuddyDesktopControlEndpoint(
  configDir: string,
  controlPipeUuid: string,
  platform: NodeJS.Platform = process.platform,
  tmpDir = os.tmpdir()
): string {
  const token = workBuddyDesktopInstanceToken(configDir);
  if (platform === "win32") {
    return `\\\\.\\pipe\\workbuddy-${token}-sidecar-control-${controlPipeUuid}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (platform === "linux") {
    const xdg = process.env.XDG_RUNTIME_DIR?.trim();
    if (xdg) return path.join(xdg, "workbuddy", token, `sidecar-${controlPipeUuid}.sock`);
    if (uid != null) return path.join("/run/user", String(uid), "workbuddy", token, `sidecar-${controlPipeUuid}.sock`);
  }
  const base = uid == null ? "wb" : `wb-${sha1(String(uid), 6)}`;
  return path.join(tmpDir, base, token, `sidecar-${controlPipeUuid}.sock`);
}

function parseArgs(argv: string[]): BridgeArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`Unexpected bridge argument: ${String(key)}`);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
    i += 1;
  }
  const cliPath = values.get("--cli")?.trim() ?? "";
  const model = values.get("--model")?.trim() ?? "";
  const permission = values.get("--permission")?.trim() ?? "";
  const effort = values.get("--effort")?.trim() || null;
  const resumeSessionId = values.get("--resume")?.trim() || null;
  const disposeValue = values.get("--dispose-runtime")?.trim().toLowerCase() || "false";
  if (!new Set(["true", "false"]).has(disposeValue)) throw new Error("WorkBuddy AI bridge received an invalid dispose-runtime value.");
  const disposeRuntime = disposeValue === "true";
  if (!path.isAbsolute(cliPath)) throw new Error("WorkBuddy AI bridge requires an absolute bundled CLI path.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(model)) {
    throw new Error("WorkBuddy AI bridge received an invalid model id.");
  }
  if (!new Set(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto", "fullAccess"]).has(permission)) {
    throw new Error("WorkBuddy AI bridge received an invalid permission mode.");
  }
  if (effort && !/^[A-Za-z0-9_-]{1,32}$/.test(effort)) throw new Error("WorkBuddy AI bridge received an invalid effort.");
  if (resumeSessionId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(resumeSessionId)) {
    throw new Error("WorkBuddy AI bridge received an invalid resume session id.");
  }
  // The optional approval binding. All three parts are required together: a
  // partial identity could answer an approval for the wrong attempt, so it is
  // treated as no interactive route at all.
  const jobId = values.get("--job-id")?.trim() || null;
  const generationRaw = values.get("--generation")?.trim() || null;
  const dataRoot = values.get("--data-root")?.trim() || null;
  if (jobId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) throw new Error("WorkBuddy AI bridge received an invalid job id.");
  if (generationRaw && !/^\d+$/.test(generationRaw)) throw new Error("WorkBuddy AI bridge received an invalid generation.");
  if (dataRoot && !path.isAbsolute(dataRoot)) throw new Error("WorkBuddy AI bridge received a non-absolute data root.");
  const generation = generationRaw ? Number(generationRaw) : null;
  const bound = jobId != null && generation != null && dataRoot != null;
  return {
    cliPath,
    model,
    permission,
    effort,
    resumeSessionId,
    disposeRuntime,
    jobId: bound ? jobId : null,
    generation: bound ? generation : null,
    dataRoot: bound ? dataRoot : null
  };
}

/**
 * The running sidecar's own metadata, or null when it is not running (or its
 * metadata is incompatible with this build).
 *
 * Exported for the provider's cancellation route, which must reach the SAME
 * sidecar the bridge used without ever spawning or killing one.
 */
export function workBuddyDesktopSidecarMeta(
  configDir: string = workBuddyDesktopConfigDir(),
  platform: NodeJS.Platform = process.platform,
  tmpDir: string = os.tmpdir()
): SidecarPidFile | null {
  try { return readSidecarPidFile(configDir, platform, tmpDir); }
  catch { return null; }
}

function readSidecarPidFile(
  configDir: string,
  platform: NodeJS.Platform = process.platform,
  tmpDir: string = os.tmpdir()
): SidecarPidFile {
  const file = workBuddyDesktopSidecarPidPath(configDir, platform, tmpDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("WorkBuddy AI Desktop sidecar is not running. Open WorkBuddy AI and keep it running before dispatching this job.");
  }
  const obj = asObject(parsed);
  const pid = Number(obj?.pid);
  const version = Number(obj?.version);
  const controlPipeUuid = typeof obj?.controlPipeUuid === "string" ? obj.controlPipeUuid.trim() : "";
  if (!Number.isSafeInteger(pid) || pid <= 0 || version !== SIDECAR_VERSION || !/^[a-f0-9]{8}$/i.test(controlPipeUuid)) {
    throw new Error("WorkBuddy AI Desktop sidecar metadata is incompatible with this CrewDispatch build.");
  }
  return { pid, version, controlPipeUuid };
}

/** Current provider-managed WorkBuddy sidecar PID, or null when unavailable. */
export function workBuddyDesktopSidecarPid(
  configDir: string = workBuddyDesktopConfigDir()
): number | null {
  try { return readSidecarPidFile(configDir).pid; }
  catch { return null; }
}

interface WorkBuddyRecoveryOwnerReceipt {
  version: 1;
  helperPid: number;
  helperCreatedAtUs: number;
  sidecarPid: number;
}

export function workBuddyRecoveryOwnerReceiptPath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), "provider-runtime", "workbuddy-ai", "recovery-owner.json");
}

export function recordWorkBuddyRecoveryOwner(
  dataRoot: string,
  helperPid: number,
  helperCreatedAtUs: number,
  sidecarPid: number
): void {
  if (
    !Number.isSafeInteger(helperPid) || helperPid <= 0 ||
    !Number.isSafeInteger(helperCreatedAtUs) || helperCreatedAtUs <= 0 ||
    !Number.isSafeInteger(sidecarPid) || sidecarPid <= 0
  ) {
    throw new Error("WorkBuddy recovery owner identity is invalid.");
  }
  const file = workBuddyRecoveryOwnerReceiptPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record: WorkBuddyRecoveryOwnerReceipt = { version: 1, helperPid, helperCreatedAtUs, sidecarPid };
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Exact CrewDispatch-spawned owner of the current recovered WorkBuddy sidecar.
 * The receipt is accepted only while BOTH the provider-owned sidecar PID still
 * matches and the helper PID is the exact recorded process incarnation.
 */
export function workBuddyRecoveryOwnerPid(dataRoot: string, sidecarPid: number): number | null {
  if (!Number.isSafeInteger(sidecarPid) || sidecarPid <= 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(workBuddyRecoveryOwnerReceiptPath(dataRoot), "utf8")); }
  catch { return null; }
  const obj = asObject(parsed);
  const helperPid = Number(obj?.helperPid);
  const helperCreatedAtUs = Number(obj?.helperCreatedAtUs);
  const recordedSidecarPid = Number(obj?.sidecarPid);
  if (
    Number(obj?.version) !== 1 ||
    !Number.isSafeInteger(helperPid) || helperPid <= 0 ||
    !Number.isSafeInteger(helperCreatedAtUs) || helperCreatedAtUs <= 0 ||
    recordedSidecarPid !== sidecarPid
  ) return null;
  const identity = captureProcessIdentity(helperPid);
  return identity?.createdAtUs === helperCreatedAtUs ? helperPid : null;
}

function sidecarPidFileExists(configDir: string): boolean {
  try { return fs.statSync(workBuddyDesktopSidecarPidPath(configDir)).isFile(); } catch { return false; }
}

function sidecarMetadataIncompatible(error: unknown): boolean {
  return boundedMessage(error).includes("metadata is incompatible");
}

function unlinkSidecarPidFile(configDir: string): void {
  try { fs.unlinkSync(workBuddyDesktopSidecarPidPath(configDir)); } catch {}
}

export function workBuddyDesktopSidecarEntryPath(cliPath: string): string {
  return path.join(workBuddyDesktopAsarPath(cliPath), "main", "sidecar-entry.js");
}

export function workBuddyDesktopSidecarSpawnEnv(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    CODEBUDDY_CONFIG_DIR: configDir,
    WORKBUDDY_CONFIG_DIR: configDir,
    NODE_OPTIONS: SIDECAR_MAX_OLD_SPACE_SIZE_FLAG,
    DISABLE_TELEMETRY: "0",
    WORKBUDDY_AT_REST_ENCRYPTION: WORKBUDDY_CREDENTIAL_POLICY
  };
}

export function workBuddyDesktopMacRuntimeEnv(
  configDir: string,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  // The app-owned macOS sidecar is already the authentication boundary. Do not
  // forward CrewDispatch/OpenAI/provider secrets merely because they exist in
  // the worker environment. Keep the ordinary shell/tool environment needed by
  // the sidecar-hosted runtime, plus the exact WorkBuddy profile selectors.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME", "USER", "LOGNAME", "SHELL", "PATH",
    "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE",
    "TERM", "COLORTERM", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.CODEBUDDY_CONFIG_DIR = configDir;
  env.WORKBUDDY_CONFIG_DIR = configDir;
  env.CODEBUDDY_FORCE_HEADLESS_BUNDLE = "1";
  // Newer WorkBuddy packages may ship only the lite-wb non-TUI bundle. The
  // launcher prioritizes this flag; older launchers ignore it and keep using
  // the headless flag above.
  env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = "1";
  return env;
}

function sidecarConnectRecoverable(error: unknown): boolean {
  const code = typeof (error as NodeJS.ErrnoException)?.code === "string"
    ? String((error as NodeJS.ErrnoException).code).toUpperCase()
    : "";
  if (new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]).has(code)) return true;
  const message = boundedMessage(error).toLowerCase();
  return message.includes("sidecar connection closed") || message.includes("timed out connecting");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnDesktopSidecar(cliPath: string, configDir: string): Promise<SidecarPidFile> {
  if (process.platform !== "win32") throw new Error("WorkBuddy AI sidecar self-recovery is currently validated only on Windows.");
  const appExe = desktopExecutableFromCli(cliPath);
  const entryPath = workBuddyDesktopSidecarEntryPath(cliPath);
  const token = crypto.randomUUID();
  const controlPipeUuid = crypto.randomBytes(4).toString("hex");

  // The WorkBuddy 5.6.2 SidecarManager also replaces stale metadata before
  // spawning a fresh UUID control pipe. Do not kill the stale PID here: after a
  // reboot that PID may already belong to an unrelated process.
  unlinkSidecarPidFile(configDir);

  const child = spawn(appExe, [entryPath, "--token", token, "--control-pipe-uuid", controlPipeUuid], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: workBuddyDesktopSidecarSpawnEnv(configDir)
  });
  child.unref();
  if (child.pid == null) throw new Error("WorkBuddy AI sidecar recovery failed to spawn a process.");

  const deadline = Date.now() + SIDECAR_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(100);
    if (!sidecarPidFileExists(configDir)) continue;
    try {
      const meta = readSidecarPidFile(configDir);
      if (meta.pid === child.pid && meta.controlPipeUuid === controlPipeUuid) return meta;
    } catch {
      // The sidecar may still be replacing/writing the metadata file.
    }
  }
  throw new Error(`Timed out waiting for recovered WorkBuddy AI sidecar metadata (pid=${child.pid}).`);
}

async function connectSidecarMeta(meta: SidecarPidFile, configDir: string): Promise<SidecarClient> {
  const endpoint = workBuddyDesktopControlEndpoint(configDir, meta.controlPipeUuid);
  const sidecar = new SidecarClient(endpoint);
  await sidecar.connect();
  const ping = asObject(await sidecar.request("sidecar.ping", {}));
  if (Number(ping?.version) !== SIDECAR_VERSION || Number(ping?.pid) !== meta.pid) {
    sidecar.close();
    throw new Error("WorkBuddy AI Desktop sidecar identity changed while connecting; retry after the app settles.");
  }
  return sidecar;
}

async function connectDesktopSidecarWithRecovery(cliPath: string, configDir: string, dataRoot: string | null = null): Promise<SidecarClient> {
  const allowWindowsSelfRecovery = process.platform === "win32";
  const allowDarwinAppManagedRecovery = process.platform === "darwin";
  let meta: SidecarPidFile | null = null;
  let metadataError: unknown = null;
  for (let attempt = 0; attempt < SIDECAR_RECOVERY_CONNECT_RETRIES; attempt += 1) {
    try {
      meta = readSidecarPidFile(configDir);
      metadataError = null;
      break;
    } catch (error) {
      metadataError = error;
      if (sidecarMetadataIncompatible(error)) throw error;
      if (!sidecarPidFileExists(configDir)) break;
      if (attempt + 1 < SIDECAR_RECOVERY_CONNECT_RETRIES) await delay(SIDECAR_RECOVERY_RETRY_MS);
    }
  }
  if (!meta && metadataError && sidecarPidFileExists(configDir)) {
    if (!allowWindowsSelfRecovery) throw metadataError;
    // Windows can replace stale/partial metadata with a CrewDispatch-owned
    // recovered sidecar. Darwin delegates all such ownership decisions to the
    // official WorkBuddy SidecarManager instead of unlinking metadata itself.
    unlinkSidecarPidFile(configDir);
  }

  if (meta) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SIDECAR_RECOVERY_CONNECT_RETRIES; attempt += 1) {
      try { return await connectAuthenticatedSidecar(cliPath, meta, configDir); }
      catch (error) {
        lastError = error;
        if (!sidecarConnectRecoverable(error)) throw error;
        if (attempt + 1 < SIDECAR_RECOVERY_CONNECT_RETRIES) await delay(SIDECAR_RECOVERY_RETRY_MS);
      }
    }
    if (lastError && !allowWindowsSelfRecovery && !allowDarwinAppManagedRecovery) throw lastError;
    if (lastError && allowWindowsSelfRecovery && !sidecarConnectRecoverable(lastError)) throw lastError;
  }

  if (allowDarwinAppManagedRecovery) {
    const recovered = await ensureMacDesktopSidecarViaOfficialManager(cliPath, configDir, dataRoot);
    return await connectAuthenticatedSidecar(cliPath, recovered, configDir);
  }
  if (!allowWindowsSelfRecovery) {
    throw metadataError instanceof Error
      ? metadataError
      : new Error("WorkBuddy AI Desktop sidecar is unavailable. Open WorkBuddy AI and keep it running before dispatching this job.");
  }
  const recovered = await spawnDesktopSidecar(cliPath, configDir);
  return await connectAuthenticatedSidecar(cliPath, recovered, configDir);
}

export async function ensureWorkBuddyDesktopSidecarReady(
  cliPath: string,
  configDir: string = workBuddyDesktopConfigDir()
): Promise<SidecarPidFile> {
  const sidecar = await connectDesktopSidecarWithRecovery(cliPath, configDir);
  try { return readSidecarPidFile(configDir); }
  finally { sidecar.close(); }
}

function desktopExecutableFromCli(cliPath: string): string {
  const root = path.resolve(path.dirname(cliPath), "..", "..", "..", "..");
  if (process.platform === "darwin") {
    const expectedCli = path.join(root, "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
    if (path.resolve(cliPath) !== path.resolve(expectedCli)) {
      throw new Error("The WorkBuddy AI bundled CLI is not inside the expected macOS app layout.");
    }
    const candidate = path.join(root, "MacOS", "Electron");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
    throw new Error("The WorkBuddy AI Desktop executable was not found inside the macOS app bundle.");
  }
  if (process.platform !== "win32") {
    throw new Error("The WorkBuddy AI Desktop bridge is supported only on Windows and macOS.");
  }
  for (const name of ["WorkBuddyAI.exe", "WorkBuddy AI.exe"]) {
    const candidate = path.join(root, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next packaged executable name.
    }
  }
  throw new Error("The WorkBuddy AI Desktop executable was not found next to its bundled CLI.");
}

/** Exact-command predicate used by Darwin recovery; helper/sidecar Electron rows have argv and do not match. */
export function workBuddyDesktopAppCommandPresent(appExe: string, processCommands: string): boolean {
  const expected = path.resolve(appExe);
  return String(processCommands).split(/\r?\n/).some((line) => line.trim() === expected);
}

/** Return the one exact Desktop main PID; ambiguous/malformed rows fail closed. */
export function workBuddyDesktopMainPid(appExe: string, processRows: string): number | null {
  const expected = path.resolve(appExe);
  const matches: number[] = [];
  for (const raw of String(processRows).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(raw);
    if (!match || path.resolve(match[2]!) !== expected) continue;
    const pid = Number(match[1]!);
    if (Number.isSafeInteger(pid) && pid > 0) matches.push(pid);
  }
  return matches.length === 1 ? matches[0]! : null;
}

function workBuddyDesktopAppIdentity(appExe: string): { pid: number; createdAtUs: number } | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout: DESKTOP_APP_PROBE_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) return null;
  const pid = workBuddyDesktopMainPid(appExe, String(result.stdout || ""));
  if (!pid) return null;
  const identity = captureProcessIdentity(pid);
  return identity && Number.isSafeInteger(identity.createdAtUs) && Number(identity.createdAtUs) > 0
    ? { pid, createdAtUs: Number(identity.createdAtUs) }
    : null;
}

async function ensureMacDesktopSidecarViaOfficialManager(cliPath: string, configDir: string, dataRoot: string | null = null): Promise<SidecarPidFile> {
  const appExe = desktopExecutableFromCli(cliPath);
  const appIdentity = workBuddyDesktopAppIdentity(appExe);
  if (!appIdentity) {
    throw new Error("WorkBuddy AI Desktop app is not running with a provable process identity; refusing sidecar recovery.");
  }
  const helperPath = workBuddyDesktopRuntimeHelperPath();
  const child = spawn(appExe, [
    helperPath,
    "--asar", workBuddyDesktopAsarPath(cliPath),
    "--config-dir", configDir,
    "--ensure-sidecar", "1",
    "--app-owner-pid", String(appIdentity.pid),
    "--app-owner-created-at-us", String(appIdentity.createdAtUs)
  ], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEBUDDY_CONFIG_DIR: configDir,
      WORKBUDDY_CONFIG_DIR: configDir
    }
  });
  if (!child.stdout || child.pid == null) {
    try { child.kill(); } catch {}
    throw new Error("WorkBuddy official sidecar recovery helper failed to start.");
  }

  const ack = await new Promise<JsonObject>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: JsonObject): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for WorkBuddy official sidecar recovery acknowledgement.")),
      SIDECAR_START_TIMEOUT_MS + 15_000
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const parsed = asObject(JSON.parse(line));
          if (parsed?.ok === true && parsed?.policy === WORKBUDDY_CREDENTIAL_POLICY) return finish(undefined, parsed);
        } catch {
          // WorkBuddy's packaged manager may emit benign status lines before the bounded JSON ACK.
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`WorkBuddy official sidecar recovery helper exited before acknowledgement (exit ${String(code)}, signal ${String(signal)}).`));
    });
  });
  if (ack.ok !== true || ack.policy !== WORKBUDDY_CREDENTIAL_POLICY) {
    throw new Error("WorkBuddy official sidecar recovery helper returned an invalid acknowledgement.");
  }
  // After the ACK the helper stays detached as the exact app-lifetime owner of the
  // recovered sidecar. It emits no more output; sever our pipe and release it.
  const recovered = readSidecarPidFile(configDir);
  const helperIdentity = child.pid == null ? null : captureProcessIdentity(child.pid);
  child.stdout.destroy();
  child.unref();
  if (dataRoot) {
    if (!helperIdentity?.createdAtUs) {
      throw new Error("WorkBuddy recovery owner process identity could not be pinned.");
    }
    // Persist ONLY the exact helper incarnation CrewDispatch itself just spawned.
    // The worker uses this bounded receipt to exclude the app-lifetime helper (and
    // therefore its sidecar subtree) from the disposable bridge tree snapshot.
    recordWorkBuddyRecoveryOwner(dataRoot, child.pid!, helperIdentity.createdAtUs, recovered.pid);
  }
  return recovered;
}

function workBuddyDesktopAsarPath(cliPath: string): string {
  const appExe = desktopExecutableFromCli(cliPath);
  return process.platform === "darwin"
    ? path.join(path.dirname(path.dirname(appExe)), "Resources", "app.asar")
    : path.join(path.dirname(appExe), "resources", "app.asar");
}
function workBuddyDesktopRuntimeHelperPath(): string {
  return path.join(__dirname, "desktop-runtime-helper.js");
}

function bootstrapSidecarViaWorkBuddyHelper(
  cliPath: string,
  configDir: string,
  controlEndpoint: string
): void {
  const appExe = desktopExecutableFromCli(cliPath);
  const helperPath = workBuddyDesktopRuntimeHelperPath();
  const result = spawnSync(appExe, [
    helperPath,
    "--asar", workBuddyDesktopAsarPath(cliPath),
    "--config-dir", configDir,
    "--control-endpoint", controlEndpoint,
    "--bootstrap-only", "1"
  ], {
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEBUDDY_CONFIG_DIR: configDir,
      WORKBUDDY_CONFIG_DIR: configDir
    },
    encoding: "utf8",
    timeout: CONTROL_TIMEOUT_MS + 15_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "WorkBuddy credential bootstrap helper failed: " +
      String(result.stderr || result.stdout || ("exit " + String(result.status))).trim().slice(0, 1000)
    );
  }
  const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { throw new Error("WorkBuddy credential bootstrap helper returned invalid JSON."); }
  const ack = asObject(parsed);
  if (ack?.ok !== true || ack?.policy !== WORKBUDDY_CREDENTIAL_POLICY) {
    throw new Error("WorkBuddy credential bootstrap helper returned an invalid acknowledgement.");
  }
}

async function connectAuthenticatedSidecar(
  cliPath: string,
  meta: SidecarPidFile,
  configDir: string
): Promise<SidecarClient> {
  let sidecar = await connectSidecarMeta(meta, configDir);
  if (process.platform === "darwin") {
    // A Darwin sidecar either came from the live Desktop app or was recreated by
    // WorkBuddy's own packaged SidecarManager with the native `fields` bootstrap.
    // Never re-bootstrap/replace it from this generic connection path.
    return sidecar;
  }
  const endpoint = workBuddyDesktopControlEndpoint(configDir, meta.controlPipeUuid);
  try {
    bootstrapSidecarViaWorkBuddyHelper(cliPath, configDir, endpoint);
    return sidecar;
  } catch (error) {
    if (!/rejected credential bootstrap/i.test(boundedMessage(error))) {
      sidecar.close();
      throw error;
    }
    if (process.platform !== "win32") {
      // The macOS sidecar is owned by the running WorkBuddy AI Desktop app.
      // Never shut it down or replace it merely because credential bootstrap was
      // rejected; fail closed and let the user-owned app remain untouched.
      sidecar.close();
      throw new Error("WorkBuddy AI Desktop rejected credential bootstrap; refusing to replace the user-owned macOS sidecar.");
    }
  }

  // Windows-only compatibility recovery for older CrewDispatch sidecars that
  // were self-created with policy=off.
  try { await sidecar.request("sidecar.shutdown", {}); } catch {}
  sidecar.close();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && sidecarPidFileExists(configDir)) await delay(100);
  unlinkSidecarPidFile(configDir);

  const recovered = await spawnDesktopSidecar(cliPath, configDir);
  sidecar = await connectSidecarMeta(recovered, configDir);
  try {
    bootstrapSidecarViaWorkBuddyHelper(
      cliPath,
      configDir,
      workBuddyDesktopControlEndpoint(configDir, recovered.controlPipeUuid)
    );
    return sidecar;
  } catch (error) {
    sidecar.close();
    throw error;
  }
}
async function createHostRuntimeViaMacSidecar(
  sidecar: SidecarClient,
  args: BridgeArgs,
  configDir: string,
  sessionId: string
): Promise<SidecarSession> {
  const appExe = desktopExecutableFromCli(args.cliPath);
  const runtimeArgs = [
    args.cliPath,
    "--serve",
    "--setting-sources",
    "user",
    "--permission-mode",
    args.permission,
    ...(args.effort ? ["--effort", args.effort] : []),
    "--strict-mcp-config"
  ];
  const env = workBuddyDesktopMacRuntimeEnv(configDir);
  const result = await sidecar.request("session.create", {
    sessionId,
    command: appExe,
    args: runtimeArgs,
    cwd: process.cwd(),
    env,
    port: 0,
    cols: 100,
    rows: 30
  }, SESSION_CREATE_TIMEOUT_MS);
  const session = sidecarSession(result);
  if (!session || !session.runtimeId || !Number.isSafeInteger(session.pid) || session.pid! <= 0) {
    throw new Error("WorkBuddy macOS sidecar returned an incomplete private runtime identity.");
  }
  return session;
}

function createHostRuntimeViaWorkBuddyHelper(
  args: BridgeArgs,
  configDir: string,
  controlEndpoint: string,
  sessionId: string
): SidecarSession {
  const appExe = desktopExecutableFromCli(args.cliPath);
  const helperPath = workBuddyDesktopRuntimeHelperPath();
  const helperArgs = [
    helperPath,
    "--asar", workBuddyDesktopAsarPath(args.cliPath),
    "--config-dir", configDir,
    "--control-endpoint", controlEndpoint,
    "--session-id", sessionId,
    "--app-exe", appExe,
    "--cli", args.cliPath,
    "--cwd", process.cwd(),
    "--permission", args.permission,
    ...(args.effort ? ["--effort", args.effort] : [])
  ];
  const result = spawnSync(appExe, helperArgs, {
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEBUDDY_CONFIG_DIR: configDir,
      WORKBUDDY_CONFIG_DIR: configDir
    },
    encoding: "utf8",
    timeout: SESSION_CREATE_TIMEOUT_MS + 15_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      "WorkBuddy authenticated runtime helper failed: " +
      String(result.stderr || result.stdout || ("exit " + String(result.status))).trim().slice(0, 1000)
    );
  }
  const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  let parsed: unknown;
  try { parsed = JSON.parse(line); }
  catch { throw new Error("WorkBuddy authenticated runtime helper returned invalid JSON."); }
  const session = sidecarSession(parsed);
  if (!session) throw new Error("WorkBuddy authenticated runtime helper returned an invalid ACP endpoint.");
  return session;
}

export class SidecarClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();

  constructor(private readonly endpoint: string) {}

  async connect(timeoutMs = CONTROL_TIMEOUT_MS): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out connecting to the WorkBuddy AI Desktop sidecar."));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("data", (chunk) => this.onData(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
      socket.on("close", () => this.rejectAll(new Error("WorkBuddy AI Desktop sidecar connection closed.")));
    });
  }

  async request(method: string, params: unknown = {}, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (!this.socket) throw new Error("WorkBuddy AI Desktop sidecar is not connected.");
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WorkBuddy AI sidecar RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", "utf8");
    return await promise;
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        const parsed = JSON.parse(line);
        const obj = asObject(parsed);
        if (!obj) continue;
        message = obj;
      } catch {
        continue;
      }
      const id = typeof message.id === "number" ? message.id : null;
      if (id == null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      const error = asObject(message.error);
      if (error) pending.reject(new Error(typeof error.message === "string" ? error.message : "WorkBuddy AI sidecar RPC failed."));
      else pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/** Parse one `session.list` payload into the sidecar's own session shape. */
export function parseSidecarSessions(raw: unknown): SidecarSession[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sidecarSession).filter((item): item is SidecarSession => !!item);
}

function sidecarSession(value: unknown): SidecarSession | null {
  const obj = asObject(value);
  const sessionId = typeof obj?.sessionId === "string" ? obj.sessionId : "";
  const acpEndpoint = typeof obj?.acpEndpoint === "string" ? obj.acpEndpoint : "";
  if (!sessionId || !/^https?:\/\/127\.0\.0\.1:\d+\/api\/v1\/acp\/?$/.test(acpEndpoint)) return null;
  return {
    sessionId,
    acpEndpoint: acpEndpoint.replace(/\/$/, ""),
    runtimeId: typeof obj?.runtimeId === "string" ? obj.runtimeId : undefined,
    pid: typeof obj?.pid === "number" ? obj.pid : undefined
  };
}

/**
 * The deterministic id of the sidecar-hosted runtime the bridge uses for one
 * (cli, permission, effort, cwd) combination.
 *
 * Exported because the cancellation route must find the EXACT runtime the
 * bridge drove this turn through — it must never guess from the session list or
 * act on a runtime another combination owns.
 */
export function hostRuntimeId(
  cliPath: string,
  permission: string,
  effort: string | null,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): string {
  const canonicalKey = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const digest = sha1([
    canonicalKey(cliPath),
    permission,
    effort ?? "default",
    canonicalKey(cwd)
  ].join("\n"), 14);
  return `jobquay-host-v${BRIDGE_VERSION}-${digest}`;
}

async function listSidecarSessions(sidecar: SidecarClient): Promise<SidecarSession[]> {
  const raw = await sidecar.request("session.list", {});
  if (!Array.isArray(raw)) return [];
  return raw.map(sidecarSession).filter((item): item is SidecarSession => !!item);
}

async function createHostRuntime(
  sidecar: SidecarClient,
  args: BridgeArgs,
  configDir: string,
  sessionId: string
): Promise<RuntimeHandle> {
  if (process.platform === "darwin") {
    const result = await createHostRuntimeViaMacSidecar(sidecar, args, configDir, sessionId);
    return { ...result, reused: false };
  }
  const meta = readSidecarPidFile(configDir);
  const controlEndpoint = workBuddyDesktopControlEndpoint(configDir, meta.controlPipeUuid);
  const result = createHostRuntimeViaWorkBuddyHelper(args, configDir, controlEndpoint, sessionId);
  return { ...result, reused: false };
}

async function ensureHostRuntime(sidecar: SidecarClient, args: BridgeArgs, configDir: string): Promise<RuntimeHandle> {
  const sessionId = args.jobId != null && args.generation != null && args.dataRoot != null
    ? jobRuntimeId(args.dataRoot, args.jobId, args.generation)
    : hostRuntimeId(args.cliPath, args.permission, args.effort, process.cwd(), process.platform);
  const sessions = await listSidecarSessions(sidecar);
  const existing = sessions.find((item) => item.sessionId === sessionId);
  if (existing) return { ...existing, reused: true };

  try {
    return await createHostRuntime(sidecar, args, configDir, sessionId);
  } catch (error) {
    if (!/already exists/i.test(boundedMessage(error))) throw error;
    const retry = (await listSidecarSessions(sidecar)).find((item) => item.sessionId === sessionId);
    if (!retry) throw error;
    return { ...retry, reused: true };
  }
}

function emit(record: JsonObject): void {
  process.stdout.write(JSON.stringify(record) + "\n");
}

export class AcpClient {
  private connectionId = "";
  private sessionKey = "";
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private streamAbort: AbortController | null = null;
  private streamError: Error | null = null;
  /** The ONE ACP -> canonical CrewDispatch event normalizer of this ACP conversation. */
  private readonly normalizer: AcpNormalizer = createAcpNormalizer();
  /**
   * The CURRENT prompt turn's remembered interruption evidence (JQ-20261001-25):
   * the one proof `session/request_permission` carries — WorkBuddy demanded an
   * interactive approval for a tool action and CrewDispatch, being non-interactive,
   * declined it. Bounded to the classification, the provider's safe tool-name
   * token, and the provider's OWN named operation fields (command/description/
   * path/cwd/title); the request is never copied wholesale. It is cleared at the
   * prompt-turn boundaries (see prompt()), so it can never leak into a later
   * prompt or another session.
   */
  private approvalEvidence: AcpApprovalEvidence | null = null;
  /**
   * The CURRENT prompt turn's most specific PROVEN approval outcome
   * (`rejected` / `expired` / `no_route` / `no_allow_option` /
   * `publish_failed` / `cancelled`), or null when this turn had no unresolved
   * gate. It is scoped exactly like `approvalEvidence` — cleared at the
   * prompt-turn boundaries — so a previous turn's outcome can never refine a
   * later one, and it is carried onto the turn's terminal record as the
   * canonical `approval_outcome`.
   */
  private approvalOutcome: ApprovalOutcome | null = null;
  /**
   * The outcome proven for the CURRENT remembered gate (`approvalEvidence`),
   * bound to that ONE request (JQ-20261005-57). Unlike `approvalOutcome` — the
   * turn's diagnostic summary across every gate it saw — this is the CAUSAL
   * value the terminal classifier uses for the remembered gate. It is reset
   * when a new gate supersedes the current one, written only by the answer to
   * the gate it belongs to, and cleared at the prompt-turn boundaries, so an
   * older request's async answer can never label a newer gate or a later turn.
   */
  private gateOutcome: ApprovalOutcome | null = null;
  /** Identity of the CURRENT prompt turn; a late answer from an earlier turn writes nothing. */
  private turnToken: object | null = null;
  /** Identity of the CURRENT remembered gate; a late answer to a superseded gate cannot write `gateOutcome`. */
  private gateToken: object | null = null;
  /** At most ONE interactive approval may be waiting per ACP connection. */
  private permissionPending = false;

  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    /**
     * The optional interactive approval route. Null when the worker supplied no
     * job/generation/data-root binding: the client then declines every
     * permission request exactly as it historically did.
     */
    private readonly approvalChannel: ApprovalChannel | null = null
  ) {}

  async connect(): Promise<void> {
    const response = await fetch(this.endpoint + "/connect", {
      method: "POST",
      headers: { "x-codebuddy-request": "1" }
    });
    if (!response.ok) throw new Error(`ACP connect failed: HTTP ${response.status}`);
    const payload = asObject(await response.json());
    this.connectionId = typeof payload?.connectionId === "string" ? payload.connectionId : "";
    this.sessionKey = typeof payload?.sessionToken === "string" ? payload.sessionToken : "";
    if (!this.connectionId) throw new Error("ACP connect response did not include a connection id.");

    this.streamError = null;
    this.streamAbort = new AbortController();
    // Match the installed WorkBuddy Desktop client's transport contract: the
    // auxiliary GET/SSE channel is a ONE-SHOT best-effort notification route.
    // It is not the authoritative response stream for `session/prompt` (POST may
    // itself return SSE), and the official client neither reconnects this GET nor
    // lets a rejected/closed GET poison pending JSON-RPC requests. In particular,
    // WorkBuddy 5.7.6 can reject a later GET with HTTP 403 while an approval gate
    // is pending; treating that as a fatal connection error incorrectly aborts a
    // healthy prompt before the human can decide.
    void this.openEventStream(this.streamAbort.signal).catch((error) => {
      if ((error as Error)?.name === "AbortError") return;
      // Best-effort by provider contract. POST/SSE remains authoritative.
    });

    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "jobquay-workbuddy-bridge", version: "1.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: {
          "codebuddy.ai": {
            question: false,
            promptSuggestion: false,
            fileReferencesPathOnly: true,
            terminalOutput: true
          }
        }
      }
    }, ACP_REQUEST_TIMEOUT_MS);
  }

  async newSession(cwd: string): Promise<string> {
    const result = asObject(await this.request("session/new", { cwd, mcpServers: [] }, ACP_REQUEST_TIMEOUT_MS));
    const id = typeof result?.sessionId === "string" ? result.sessionId : "";
    if (!id) throw new Error("WorkBuddy ACP session/new did not return a session id.");
    return id;
  }

  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    await this.request("session/resume", { sessionId, cwd, mcpServers: [] }, ACP_REQUEST_TIMEOUT_MS);
  }

  async setModel(sessionId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId: this.model }, ACP_REQUEST_TIMEOUT_MS);
  }

  async prompt(
    sessionId: string,
    prompt: string
  ): Promise<{
    stopReason: string | null;
    finishReason: string | null;
    errorDetail: string | null;
    finalText: string;
    approval: AcpApprovalEvidence | null;
    approvalOutcome: ApprovalOutcome | null;
    gateOutcome: ApprovalOutcome | null;
  }> {
    // A real coding turn has NO CrewDispatch wall-clock or idle deadline. It ends
    // only when the provider returns, reports an explicit transport/provider
    // error, or the user cancels the job.
    //
    // PROMPT-TURN BOUNDARY (JQ-20261001-25): the remembered interruption
    // evidence belongs to THIS turn only. It is cleared when the turn starts
    // (a gate a previous prompt saw can never refine this one) and again when
    // the turn settles, whatever the outcome. The same scoping applies to the
    // turn's proven approval outcome and to the CURRENT gate's own causal
    // outcome (JQ-20261005-57): the turn token makes every late answer from an
    // earlier turn a no-op.
    this.approvalEvidence = null;
    this.approvalOutcome = null;
    this.gateOutcome = null;
    this.gateToken = null;
    const turnToken: object = {};
    this.turnToken = turnToken;
    try {
      const result = asObject(await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }]
      }, null));
      const stopReason =
        typeof result?.stopReason === "string" ? result.stopReason :
        typeof result?.stop_reason === "string" ? result.stop_reason :
        null;
      // The installed runtime publishes the model's own finish_reason as
      // `_meta["codebuddy.ai/finishReason"]` on the prompt result (BOTH
      // content_filter and refusal arrive as stopReason=refusal). It is read as a
      // bounded safe token only — never an arbitrary provider payload.
      const meta = asObject(result?._meta);
      const finishReason = safeAcpFinishReason(meta?.["codebuddy.ai/finishReason"]);
      // The SAME installed prompt-result construction publishes the provider's
      // terminal diagnostic as `_meta["codebuddy.ai/errorMessage"]` (a plain
      // message, or the JSON-encoded classified error response). Only the
      // bounded, single-line safe form leaves this boundary (JQ-20261001-24).
      const errorDetail = safeAcpErrorDetail(meta?.["codebuddy.ai/errorMessage"]);
      // The prompt turn ending is the last observable message boundary (ACP has no
      // explicit "message ended" update), so the pending assistant message is
      // closed here — before the terminal result record is emitted.
      this.flushPending();
      return {
        stopReason,
        finishReason,
        errorDetail,
        finalText: this.normalizer.assistantText(),
        approval: this.approvalEvidence,
        approvalOutcome: this.approvalOutcome,
        gateOutcome: this.gateOutcome
      };
    } finally {
      this.turnToken = null;
      this.gateToken = null;
      this.gateOutcome = null;
      this.approvalEvidence = null;
      this.approvalOutcome = null;
      // A gate that is still unanswered when the turn settles can never be
      // answered meaningfully: clear it and publish the resolution.
      this.approvalChannel?.cancel();
    }
  }

  /** Emit the canonical records of any message/thinking block still open. */
  flushPending(): void {
    for (const record of this.normalizer.flush()) emit(record);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.notify("session/cancel", { sessionId });
  }

  async close(): Promise<void> {
    // Teardown retires any pending interactive approval for good: the file is
    // cleared and the resolution published before the connection disappears.
    this.approvalChannel?.dispose();
    this.flushPending();
    this.streamAbort?.abort();
    this.streamAbort = null;
    if (!this.connectionId) return;
    try {
      await fetch(this.endpoint, { method: "DELETE", headers: this.headers() });
    } catch {
      // Closing a local ACP transport is best effort.
    }
    this.connectionId = "";
    this.sessionKey = "";
    this.streamError = null;
    this.rejectAll(new Error("ACP connection closed."));
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "x-codebuddy-request": "1",
      "acp-connection-id": this.connectionId,
      ...(this.sessionKey ? { "acp-session-token": this.sessionKey } : {})
    };
  }

  private async request(method: string, params: unknown, timeoutMs: number | null): Promise<unknown> {
    if (this.streamError) throw this.streamError;
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs == null ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    void this.post({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return await promise;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  private async reply(id: unknown, result: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", id, result });
  }

  private async post(message: JsonObject): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(message)
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ACP request failed: HTTP ${response.status}${body ? " - " + body.slice(0, 500) : ""}`);
    }
    const contentType = String(response.headers.get("content-type") ?? "");
    if (contentType.includes("application/json")) {
      const text = await response.text();
      if (text.trim()) await this.handleMessage(JSON.parse(text));
      return;
    }
    if (contentType.includes("text/event-stream") && response.body) {
      await this.consumeEventStream(response.body);
      return;
    }
    await response.arrayBuffer();
  }

  private async openEventStream(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(this.endpoint, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          // Installed WorkBuddy's own client intentionally sends ONLY the
          // connection id on the auxiliary GET. The per-session token belongs to
          // POST/DELETE requests and can make this GET unauthorized (HTTP 403).
          "acp-connection-id": this.connectionId
        },
        signal
      });
      // The official client treats a missing/rejected auxiliary SSE route as
      // non-fatal. A prompt's POST response may itself be the live SSE stream.
      if (!response.ok || !response.body) return;
      await this.consumeEventStream(response.body);
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || signal.aborted) return;
      // Best-effort notification route: transport errors here never reject
      // pending JSON-RPC calls. Their own POST transport remains authoritative.
    }
  }
  private async consumeEventStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
        for (;;) {
          const split = buffer.indexOf("\n\n");
          if (split < 0) break;
          const event = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = event.split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            await this.handleMessage(JSON.parse(data));
          } catch {
            // One malformed or unknown event must not terminate the healthy local stream.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    const message = asObject(value);
    if (!message) return;

    if (message.id !== undefined && typeof message.method !== "string") {
      const id = typeof message.id === "number" ? message.id : null;
      if (id == null) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      const error = asObject(message.error);
      if (error) {
        const err = new Error(typeof error.message === "string" ? error.message : "WorkBuddy ACP request failed.");
        if (typeof error.code === "string" || typeof error.code === "number") (err as Error & { code?: string | number }).code = error.code as string | number;
        // The runtime's rejected prompts carry their own bounded terminal
        // evidence in `error.data` (see AcpRpcErrorEvidence). Only safe tokens
        // are read; the data payload itself is never retained.
        const data = asObject(error.data);
        const evidence: AcpRpcErrorEvidence = {
          code: typeof error.code === "string" || typeof error.code === "number" ? error.code as string | number : null,
          httpStatus:
            safeAcpHttpStatus(data?.httpStatusCode) ??
            safeAcpHttpStatus(data?.httpStatus) ??
            safeAcpHttpStatus(data?.statusCode) ??
            safeAcpHttpStatus(data?.status),
          category: safeAcpEvidenceToken(data?.category),
          finishReason: safeAcpFinishReason(data?.finishReason),
          reason: safeAcpEvidenceToken(data?.reason)
        };
        if (evidence.httpStatus !== null || evidence.category || evidence.finishReason || evidence.reason) {
          Object.defineProperty(err, ACP_RPC_ERROR_EVIDENCE, { value: evidence, enumerable: false });
        }
        pending.reject(err);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    if (!method) return;
    if (method === "session/update") {
      this.handleSessionUpdate(message.params);
      return;
    }

    if (message.id !== undefined) {
      if (method === "session/request_permission") {
        // The ONE thing this request proves (JQ-20261001-25) is remembered
        // before anything else, so a declined/expired gate keeps the exact
        // historical classification. Only a structural tool-approval gate is
        // remembered; its own named operation fields (command/description/path/
        // cwd/title) are extracted one by one and later bounded/redacted by the
        // shared approval boundary — the request is never copied wholesale.
        const evidence = acpToolApprovalEvidence(message.params);
        if (evidence) {
          this.approvalEvidence = evidence;
          // A NEW gate supersedes the remembered one (JQ-20261005-57): its own
          // causal outcome is not known yet, and any answer still in flight for
          // the previous gate must never label this one.
          this.gateOutcome = null;
          this.gateToken = {};
        }
        // An interactive Hub route may answer this request later; the answer is
        // deliberately NOT awaited here — the ACP event stream must stay live
        // while the user decides, and the exact JSON-RPC request stays pending.
        void this.answerPermission(message.id, message.params, evidence, this.turnToken, this.gateToken).catch((error) => {
          process.stderr.write(`[jobquay-workbuddy-bridge] approval handling failed: ${boundedMessage(error)}\n`);
        });
      } else if (method === "_codebuddy.ai/question") {
        // An interactive QUESTION is not a tool-approval gate: it is never
        // remembered as permission evidence.
        await this.reply(message.id, { outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } });
      } else if (method === "elicitation/create") {
        await this.reply(message.id, { action: "cancel" });
      } else {
        await this.post({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "CrewDispatch bridge does not implement this interactive ACP method." }
        });
      }
    }
  }

  /**
   * Answer ONE `session/request_permission` on the SAME JSON-RPC request id.
   *
   * With an interactive route bound to this job+generation and a real
   * tool-approval gate, the exact request stays pending until the Hub selects
   * one of the provider's OWN published options (allow_once / allow_always /
   * reject_once semantics come from the provider's kinds, never an invented
   * alias), the bounded wait expires, or the bridge is torn down. Without a
   * route — or for a request that is not a tool-approval gate — the historical
   * non-interactive decline is sent unchanged.
   *
   * The turn/gate tokens captured with the request bind every state write to
   * the request it belongs to (JQ-20261005-57): the turn-level
   * `approvalOutcome` summary may absorb any answer of the CURRENT turn, but
   * the causal `gateOutcome` and the remembered gate evidence are written only
   * while this request is still the CURRENT gate. An older request's late
   * answer (a superseded gate, or a turn that already ended) therefore never
   * labels a newer gate or a later prompt turn.
   */
  private async answerPermission(
    id: unknown,
    params: unknown,
    evidence: AcpApprovalEvidence | null,
    turnToken: object | null,
    gateToken: object | null
  ): Promise<void> {
    const decline = { outcome: { outcome: "cancelled", reason: "CrewDispatch is non-interactive." } };
    // One pending interactive approval per connection; a concurrent second gate
    // keeps the safe decline rather than racing two decisions.
    if (!evidence || !this.approvalChannel || this.permissionPending) {
      // A structural tool-approval gate that cannot be offered over an
      // interactive route (no channel is bound, or another gate is already
      // waiting) is proven evidence of a MISSING ROUTE — never a human
      // decision. A request that is not a tool-approval gate at all (an
      // interactive question) proves nothing and records no outcome.
      if (evidence) {
        if (turnToken !== null && this.turnToken === turnToken) {
          this.approvalOutcome = mergeApprovalOutcome(this.approvalOutcome, "no_route");
        }
        if (gateToken !== null && this.gateToken === gateToken) this.gateOutcome = "no_route";
      }
      await this.reply(id, decline);
      return;
    }
    this.permissionPending = true;
    try {
      const answer = await this.approvalChannel.request(String(id), evidence, params);
      // Record exactly what the answer proves BEFORE replying: only a real
      // selected reject option becomes `rejected`; a decline keeps its own
      // proven cause (no route / no allow option / publish failure), an expiry
      // stays an expiry and an abandoned wait stays cancelled. The turn keeps
      // its most specific proven cause; the CURRENT gate keeps its own.
      const outcome = approvalOutcomeOfAnswer(answer);
      const sameTurn = turnToken !== null && this.turnToken === turnToken;
      if (sameTurn) this.approvalOutcome = mergeApprovalOutcome(this.approvalOutcome, outcome);
      const currentGate = sameTurn && gateToken !== null && this.gateToken === gateToken;
      if (currentGate) this.gateOutcome = outcome;
      if (answer.kind === "selected") {
        // Only a PROVEN allow satisfies the gate. A provider-declined choice
        // (reject_once / reject / …) keeps the remembered evidence, so the
        // resulting turn still classifies as the JQ-25 permission interruption
        // rather than an ordinary cancellation — JQ-25 is for a gate that was
        // actually declined/unavailable, never for work that continued.
        if (answer.allows && currentGate) this.approvalEvidence = null;
        await this.reply(id, { outcome: { outcome: "selected", optionId: answer.optionId } });
        return;
      }
      // A PROVEN expiry belongs to THIS prompt turn (JQ-20261001-26): the
      // outcome token carries it to the terminal record, which raises the
      // distinct approval-expired diagnostic. A decline, a disposal or a
      // rejection never becomes an expiry.
      const reason = answer.reason === "expired" ? "CrewDispatch's interactive approval expired." : "CrewDispatch is non-interactive.";
      await this.reply(id, { outcome: { outcome: "cancelled", reason } });
    } finally {
      this.permissionPending = false;
    }
  }

  /**
   * Map ONE ACP `session/update` payload onto the canonical CrewDispatch event
   * vocabulary. The normalization itself lives in acp-normalizer.ts: it reads
   * protocol fields only, so every WorkBuddy model on this transport produces
   * the same records and the Hub needs no WorkBuddy-specific event language.
   *
   * A `session_end` session update is deliberately NOT a second terminal
   * source: the installed runtime's own builder
   * (`buildAcpSessionEndUpdate`) publishes only `stopReason` (no finish reason
   * and no error detail) beside the authoritative `session/prompt` RESPONSE and
   * can suppress the frame entirely when the session is not idle. The
   * normalizer therefore ignores it generically (see the ACP-normalizer header)
   * and only the prompt result can end the run.
   */
  private handleSessionUpdate(value: unknown): void {
    const params = asObject(value);
    const update = asObject(params?.update);
    if (!update) return;
    for (const record of this.normalizer.handleUpdate(update)) emit(record);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * The bridge's one terminal error classification (exported for the focused
 * regression that replays the installed runtime's JSON-RPC error shape).
 *
 * The message-based classes keep their historical precedence: rate limit,
 * insufficient credits, auth, permission, network and server evidence win over
 * anything else. Only after none of those matched does the transport-proven
 * JSON-RPC evidence upgrade a model-service error (the installed runtime's
 * `finish_reason=error` rejection, see ACP_MODEL_ERROR_OUTCOME) out of the
 * generic `bridge_error` fallback; the bounded finish reason it proves is
 * carried into the terminal record. A bridge error without that evidence is
 * byte-for-byte the historical classification.
 */
export function classifyBridgeError(error: unknown): { exitCode: number; code: string; message: string; finishReason: string | null } {
  const message = boundedMessage(error);
  const lower = message.toLowerCase();
  const evidence = readAcpRpcErrorEvidence(error);
  const httpStatus = evidence?.httpStatus ?? acpHttpStatusFromErrorDetail(message);
  if (httpStatus === 429) return { exitCode: 5, code: "rate_limit", message, finishReason: null };
  if (/insufficient (?:credits?|quota)|credits? exhausted|out of credits/.test(lower)) return { exitCode: 10, code: "insufficient_credits", message, finishReason: null };
  if (/\b401\b|auth(?:entication)? required|not authenticated|login required|unauthori[sz]ed/.test(lower)) {
    return { exitCode: 3, code: "auth", message, finishReason: null };
  }
  if (/\b403\b|permission denied|permission required|forbidden|consent required/.test(lower)) {
    return { exitCode: 4, code: "permission", message, finishReason: null };
  }
  if (/econn|enotfound|eai_again|network|socket|fetch failed|timed out|timeout/.test(lower)) {
    return { exitCode: 6, code: "network", message, finishReason: null };
  }
  if (/\b5\d\d\b|server error|service unavailable/.test(lower)) return { exitCode: 7, code: "server", message, finishReason: null };
  // Transport-proven model-service error: the runtime's own reason token, or
  // its model_service category together with the original finish reason.
  if (
    evidence &&
    (evidence.reason === "provider_finish_reason_error" ||
      (evidence.category === "model_service" && evidence.finishReason === "error"))
  ) {
    return {
      exitCode: 16,
      code: ACP_FAILURE_MODEL_ERROR,
      message: "WorkBuddy AI's model service ended the response with an error (finish_reason=error); the task did not complete.",
      finishReason: evidence.finishReason
    };
  }
  return { exitCode: 1, code: "bridge_error", message, finishReason: null };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prompt = fs.readFileSync(0, "utf8");
  if (!prompt.trim()) throw new Error("WorkBuddy AI bridge received an empty task.");

  // The optional interactive approval route. It exists only when the worker
  // supplied the complete job+generation+data-root binding; even then the
  // channel still requires a live Hub to answer its route probe, so an
  // unattended run keeps the historical decline behavior.
  const approvalChannel =
    args.jobId != null && args.generation != null && args.dataRoot != null
      ? new ApprovalChannel(
          {
            jobId: args.jobId,
            generation: args.generation,
            dataRoot: args.dataRoot,
            provider: WORKBUDDY_APPROVAL_PROVIDER_ID
          },
          { emit }
        )
      : null;

  const configDir = workBuddyDesktopConfigDir();
  const sidecar = await connectDesktopSidecarWithRecovery(args.cliPath, configDir, args.dataRoot);
  let acp: AcpClient | null = null;
  let acpSessionId: string | null = null;
  let terminating = false;
  let privateRuntime: RuntimeHandle | null = null;
  const releaseRuntime = async (): Promise<void> => {
    if (!privateRuntime || !args.dataRoot) return;
    const runtime = privateRuntime;
    privateRuntime = null;
    let released = false;
    try { released = await releaseRegisteredRuntime(args.dataRoot, sidecar, runtime); } catch {}
    if (!released) {
      process.stderr.write("WorkBuddy private runtime cleanup unconfirmed; retained for bounded daemon maintenance.\n");
    }
  };

  const cancelAndExit = async (): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      if (acp && acpSessionId) await acp.cancel(acpSessionId);
    } catch {
      // Cancellation is best effort; CrewDispatch still owns the bridge process.
    }
    try { await acp?.close(); } catch {}
    // A pending approval never outlives the bridge: close() retires it, and
    // this covers the pre-connection teardown path too.
    approvalChannel?.dispose();
    await releaseRuntime();
    sidecar.close();
    process.exitCode = 130;
  };
  process.once("SIGINT", () => { void cancelAndExit(); });
  process.once("SIGTERM", () => { void cancelAndExit(); });

  try {
    let runtime = await ensureHostRuntime(sidecar, args, configDir);
    if (args.jobId != null && args.generation != null && args.dataRoot != null) {
      registerOwnedRuntime(args.dataRoot, args.jobId, args.generation, runtime);
      privateRuntime = runtime;
    }

    const connectAcp = async (): Promise<AcpClient> => {
      const client = new AcpClient(runtime.acpEndpoint, args.model, approvalChannel);
      await client.connect();
      return client;
    };

    try {
      acp = await connectAcp();
    } catch (error) {
      if (!runtime.reused) throw error;
      try {
        await sidecar.request("session.kill", {
          sessionId: runtime.sessionId,
          ...(runtime.runtimeId ? { expectedRuntimeId: runtime.runtimeId } : {})
        });
      } catch {
        // A stale runtime may already be gone.
      }
      runtime = await createHostRuntime(sidecar, args, configDir, runtime.sessionId);
      if (args.jobId != null && args.generation != null && args.dataRoot != null) {
        registerOwnedRuntime(args.dataRoot, args.jobId, args.generation, runtime);
        privateRuntime = runtime;
      }
      acp = await connectAcp();
    }

    if (args.resumeSessionId) {
      acpSessionId = args.resumeSessionId;
      await acp.resumeSession(acpSessionId, process.cwd());
    } else {
      acpSessionId = await acp.newSession(process.cwd());
    }

    await acp.setModel(acpSessionId);
    emit(acpInitRecord(acpSessionId, args.model));

    // LIVE-BRIDGE CANCELLATION WATCHER (JQ-20261006-58, generation-2): the
    // installed runtime routes `session/cancel` only to the connection that
    // owns the in-flight prompt, so an explicit cancel must be relayed by THIS
    // bridge over THIS connection. The watcher is bound to the exact
    // job+generation+session identity, runs only while the prompt is in flight
    // (stopped the moment it settles), delivers the exact `session/cancel`
    // through the SAME `AcpClient` the turn uses, and acknowledges the
    // in-protocol delivery only after it was accepted. A request for any other
    // identity is never delivered and never acknowledged; a missing/dead bridge
    // simply never acknowledges (the requester then reports a truthful
    // no-route). All waits here are bounded control handshakes.
    const promptClient = acp;
    const cancelChannel =
      args.jobId != null && args.generation != null && args.dataRoot != null
        ? new TurnCancelChannel({
            provider: WORKBUDDY_APPROVAL_PROVIDER_ID,
            jobId: args.jobId,
            generation: args.generation,
            sessionId: acpSessionId,
            dataRoot: args.dataRoot
          })
        : null;
    const promptPromise = promptClient.prompt(acpSessionId, prompt);
    const stopCancelWatch = cancelChannel?.watch(async (sessionId) => {
      await promptClient.cancel(sessionId);
    });
    let result: Awaited<ReturnType<AcpClient["prompt"]>>;
    try {
      result = await promptPromise;
    } finally {
      stopCancelWatch?.();
    }
    if (terminating) return;
    await acp.close();
    if (privateRuntime && args.dataRoot) {
      try { markRuntimeSettled(args.dataRoot, privateRuntime); } catch {}
      await releaseRuntime();
    }
    else if (args.disposeRuntime) {
      await sidecar.request("session.kill", {
        sessionId: runtime.sessionId,
        ...(runtime.runtimeId ? { expectedRuntimeId: runtime.runtimeId } : {})
      });
    }
    // A prompt turn RETURNING only proves the transport delivered a terminal
    // record. Only an `end_turn` stop reason is a successful user-task result;
    // a refusal (or any other ACP non-completion) is emitted as a classified
    // provider failure — never as `subtype:"success"` — and its own stop
    // reason is preserved in durable state. The runtime's bounded terminal
    // diagnostic (`_meta["codebuddy.ai/errorMessage"]`) is carried as the
    // record's safe `error_detail` on a failure only.
    //
    // JQ-20261001-25: a `cancelled` turn whose finish reason still wants tool
    // calls, beside the prompt turn's remembered declined tool-approval gate,
    // is the provider's permission interruption — not a cancellation. The
    // CURRENT gate's own proven outcome (`gateOutcome`) refines that further
    // (JQ-20261005-57): a real selected rejection gets its own classification,
    // a proven expiry keeps its own, and an abandoned wait stays a plain
    // cancellation. The turn-level `approvalOutcome` remains the diagnostic
    // summary carried on the record — an earlier gate's rejection/expiry can
    // never label the CURRENT gate's causal classification.
    const terminal = acpTerminalResultRecord({
      sessionId: acpSessionId,
      model: args.model,
      stopReason: result.stopReason,
      finalText: result.finalText,
      finishReason: result.finishReason,
      errorDetail: result.errorDetail,
      approval: result.approval,
      approvalOutcome: result.approvalOutcome,
      gateOutcome: result.gateOutcome
    });
    emit(terminal.record);
    // Keep the macOS bridge root alive briefly after publishing the terminal
    // record so the worker can freeze this exact process group, snapshot
    // containment while ancestry still exists, and persist generation-scoped
    // tree evidence before the bridge exits. Command Code already participates
    // in the same rendezvous; WorkBuddy must as well for safe same-session
    // follow-ups on Darwin.
    await waitForDarwinTerminalAck();
    process.exitCode = terminal.exitCode;
    sidecar.close();
  } catch (error) {
    if (terminating) return;
    const classified = classifyBridgeError(error);
    // A bridge failure must not leave a provider turn running after CrewDispatch
    // makes the job terminal. This uses the same provider cancellation path as
    // the UI/SIGTERM handler; it is best-effort because the transport itself may
    // be the thing that failed.
    try {
      if (acp && acpSessionId) await acp.cancel(acpSessionId);
    } catch {
      // Continue terminal error reporting.
    }
    // Close any assistant message the stream had already delivered, so a failed
    // run still shows the text it actually produced (never a partial row per chunk).
    try { acp?.flushPending(); } catch {}
    emit(acpErrorResultRecord({
      sessionId: acpSessionId,
      model: args.model,
      code: classified.code,
      message: classified.message,
      // A model-service rejection (finish_reason=error) carries its proven
      // bounded token into durable state instead of collapsing to a generic
      // bridge failure (JQ-20261001-24).
      finishReason: classified.finishReason
    }));
    await waitForDarwinTerminalAck();
    try { await acp?.close(); } catch {}
    await releaseRuntime();
    sidecar.close();
    process.exitCode = classified.exitCode;
  }
}

if (require.main === module) {
  void main();
}
