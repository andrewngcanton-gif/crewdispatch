// notify.ts — terminal-wake and approval-wake TRANSPORT adapters plus the
// at-most-once terminal delivery loop (M1 batch 3; approval wake added with the
// shared caller-notification work).
//
// The neutral event model, the transport registry and the approval-wake
// orchestration live in src/jobs/notifications.ts. THIS module owns the three
// real caller transports and registers them:
//
//   * `callback`      — one short HTTP(S) POST (terminal body unchanged:
//                       `{job_id,status}`; approval body carries an explicit
//                       `event:"approval_required"` discriminator + identity);
//   * `codex_thread`  — a safe `codex queue` argv (shell-free; a Windows
//                       .cmd/.bat shim goes through %ComSpec% with per-token
//                       quoting). The terminal message keeps its one-shot
//                       collection hint; the approval message tells the caller
//                       the job is WAITING (not terminal), to show the human the
//                       operation + Hub link, and NOT to collect a result or
//                       approve automatically.
//   * `claude_session` — the official native session inbox of a local Claude
//                       Code conversation (Windows named pipe / Unix socket).
//                       Only the opaque session/binding reference is persisted;
//                       the address and per-session token stay in the private
//                       binding store (src/claude/binding.ts). The adapter
//                       itself lives in src/claude/transport.ts and is
//                       registered here.
//
// A future caller transport adds ONE adapter (here or in a small sibling
// module) + its `NotifyTarget` resolution kind; the job service, the Hub/daemon
// and every provider stay untouched.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/core.mjs` codexWake / notify / buildCodexWakeArgs / resolveCodexCli
// and the wake-target priority.
//
// Rules carried over and tightened:
//   * wake target priority is callback_url > explicit Claude session/binding >
//     explicit codex_thread_id > `CODEX_THREAD_ID` env fallback > truthful
//     no-target diagnostic (competing explicit caller identities are rejected);
//   * the target is resolved ONCE at dispatch and PERSISTED on the job, so the
//     detached worker that reaches the terminal state never depends on inheriting
//     the caller's thread id (a long-running MCP server does not reliably
//     inherit it);
//   * the terminal wake body is SHORT (job id + status only) — never the task,
//     transcript, result or a credential;
//   * `codex queue` is invoked through a SAFE argv (shell-free; a Windows
//     .cmd/.bat shim goes through %ComSpec% with per-token quoting) and never
//     carries the task text;
//   * the Codex CLI is resolved like the WebCodex run-task driver resolves it:
//     explicit path > `CODEX_CLI_PATH` > the installed Codex Desktop locations
//     on Windows (%LOCALAPPDATA%\OpenAI\Codex\bin\<newest>\codex.exe, then
//     <CODEX_HOME>\.sandbox-bin\codex.exe) > `codex` on PATH, so a finalizing
//     process whose PATH lacks `codex` can still deliver;
//   * a terminal wake is attempted AT MOST ONCE per terminal generation (an
//     exclusive claim file guards it across processes); an internal `max_turns`
//     segment or a mid-run model change is NOT a terminal wake;
//   * the recorded result persists the delivery ORIGIN (`by`) when the caller
//     supplies one; an unknown origin stays null and is never invented;
//   * a failed `codex queue` child attaches its BOUNDED, sanitized stderr tail
//     to the recorded `exit_<n>` reason (empty/unusable stderr keeps the plain
//     code; a successful delivery never records stderr);
//   * a delivery failure is RECORDED and NEVER changes the job's own outcome.
//
// There is no cloud polling anywhere here: the one attempt happens inside the
// product process that wrote the durable state.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { envValue } from "../providers/command-code/discovery";
import { cmdShimTokenProblem, resolveCliExecutable } from "../providers/command-code/spawn-plan";
import { isValidClaudeBindingId, isValidClaudeSessionId } from "../claude/ids";
import { claudeNotificationTransport } from "../claude/transport";
import {
  claimNotificationAttempt,
  loadJob,
  readNotificationResult,
  readTerminalSnapshot,
  readTerminalSnapshots,
  writeNotificationResult,
  type TerminalSnapshot
} from "../jobs/store";
import { isTerminalStatus, type NotificationRecord, type NotifyTarget } from "../jobs/types";
import {
  APPROVAL_OPERATION_CAP,
  deliverNotificationEvent,
  notificationCallbackBody,
  registerNotificationMaintenance,
  registerNotificationTransport,
  sanitizeOneLineText,
  type ApprovalRequiredNotificationEvent,
  type DeliveryDeps,
  type DeliveryOutcome,
  type NotificationEvent
} from "../jobs/notifications";
import { claudeCallerBindingMaintenance } from "../claude/lifecycle";

export { sanitizeOneLineText };
export type { DeliveryDeps, DeliveryOutcome };

/** Stable error codes for a rejected wake target (never a raw task/transcript). */
export class NotifyInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NotifyInputError";
    this.code = code;
  }
}

// Codex UUIDs (v1–v7, braces optional are NOT accepted — keep it strict) and
// session names. Mirrors the reference `wb-crew/src/core.mjs`
// CODEX_THREAD_ID_RE; rejects empty/whitespace/shell metacharacters.
const CODEX_THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;

export function isValidCodexThreadId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (!trimmed || trimmed !== id) return false;
  return CODEX_THREAD_ID_RE.test(id);
}

/** Hard cap on the terminal wake message so a wake can never become a large payload. */
export const WAKE_MESSAGE_HARD_CAP = 200;

/**
 * Hard cap on the approval wake message. An approval wake MUST carry the
 * complete, correct Hub deep link (a link is never truncated), the job/run
 * identity, the essential "waiting / do not collect a result / do not approve
 * automatically" guidance and an honest operation summary. The VALIDATED
 * approval identity bounds every part:
 *   - job id <= 128 chars (safe token; URL-encoding is identity),
 *   - request id <= 128 UTF-16 code units, each percent-encoding to at most 9
 *     characters → a worst-case link of ~1.35k chars,
 *   - generation <= Number.MAX_SAFE_INTEGER → a run number of at most 17 chars,
 *   - operation summary <= APPROVAL_OPERATION_CAP (200) + a clip marker.
 * 2048 therefore holds the worst-case VALID event with margin and remains a
 * single compact argv line, far below any OS command-line limit. The builder
 * NEVER truncates the link and never drops or clips a PUBLISHED operation to
 * satisfy this budget: only the operation text can be clipped, and then only
 * with an explicit `[truncated]` mark; an absent operation is stated as absent
 * and is never implied by budget pressure.
 */
export const APPROVAL_WAKE_MESSAGE_CAP = 2048;

/**
 * Raw stderr collection bound for a child process whose stderr is kept as
 * durable evidence. Shared by the worker's CLI run and a failed wake child; the
 * complete output never enters a record.
 */
export const STDERR_TAIL_CAP = 4000;

/**
 * Bound of the NORMALIZED stderr evidence recorded in a durable diagnostic (a
 * generic non-zero CLI exit error, or a rejected codex queue wake): the same
 * conservative 800-char terminal preview the one-shot CLI reports. The raw
 * stream is bounded by `STDERR_TAIL_CAP`, so the diagnostic only ever carries
 * this compact tail.
 */
export const STDERR_DIAGNOSTIC_CAP = 800;

/**
 * The terminal wake message: job id + status + a one-shot collection hint. It is
 * ALWAYS <= WAKE_MESSAGE_HARD_CAP chars and NEVER contains the task, result,
 * transcript or a credential. A normal short id/status is preserved exactly.
 */
export function buildWakeMessage(jobId: string, status: string): string {
  const head = "CrewDispatch job ";
  const mid = " finished with status ";
  const tail = ". ";
  const hintHead = 'Call crewdispatch_result(id="';
  const hintTail = '") exactly once to collect the result (legacy: jobquay_result).';
  const overhead = head.length + mid.length + tail.length + hintHead.length + hintTail.length;
  const id = sanitizeOneLineText(jobId, "unknown");
  const st = sanitizeOneLineText(status, "unknown");
  const render = (i: string, s: string): string => `${head}${i}${mid}${s}${tail}${hintHead}${i}${hintTail}`;
  const full = render(id, st);
  if (full.length <= WAKE_MESSAGE_HARD_CAP) return full;
  // Overflow (never expected for a real job id/status): shorten the id and status
  // by prefix so the whole message — including the complete hint — fits.
  const budget = WAKE_MESSAGE_HARD_CAP - overhead;
  let statusLen = Math.min(st.length, budget);
  let idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  if (statusLen < st.length) {
    statusLen = Math.min(8, st.length);
    idLen = Math.max(0, Math.floor((budget - statusLen) / 2));
  }
  return render(id.slice(0, idLen), st.slice(0, statusLen));
}

/** The argv after the executable for a Codex wake (`codex queue ...`). */
export function buildCodexWakeArgs(threadId: string, jobId: string, status: string): string[] | null {
  if (!isValidCodexThreadId(threadId)) return null;
  return ["queue", "--thread", threadId, "--message", buildWakeMessage(jobId, status)];
}

/**
 * The approval wake message: job/run identity, the proven Hub deep link and an
 * HONEST operation summary. It is one line and NEVER contains the task, result,
 * transcript, credentials or raw provider payload. It deliberately contains NO
 * result-collection instruction: an approval is not a completion, so the caller
 * must tell the human, must not call `crewdispatch_result` yet and must never
 * approve on the human's behalf.
 *
 * Guarantees under APPROVAL_WAKE_MESSAGE_CAP:
 *   - the COMPLETE link is always present, byte-for-byte, and is never the part
 *     that gets compressed;
 *   - a PUBLISHED operation is always shown; when it is longer than the
 *     remaining budget it is clipped and explicitly marked `[truncated]`;
 *   - an ABSENT operation is stated as absent — budget pressure can never turn
 *     a published operation into "not provided";
 *   - the human run number is 1-based (`generation + 1`), matching the
 *     Dashboard's `Run N`; the callback body keeps the raw protocol generation.
 */
export function buildApprovalWakeMessage(event: ApprovalRequiredNotificationEvent): string {
  const id = sanitizeOneLineText(event.jobId, "unknown");
  const generation = Number.isInteger(event.generation) && event.generation >= 0 ? event.generation : 0;
  const link = sanitizeOneLineText(event.hubUrl, "");
  const rawOperation = sanitizeOneLineText(event.operation, "");
  const head = `CrewDispatch job ${id} run ${generation + 1} is waiting for human approval (not finished). `;
  const guidance = `Do not call crewdispatch_result and do not approve automatically; show the human this decision and let them resolve it in the Dashboard: ${link} `;
  const prefix = "Operation: ";
  const truncatedMark = " [truncated]";
  if (!rawOperation) {
    return `${head}${guidance}${prefix}not provided by the provider.`;
  }
  // Fixed parts (identity + guidance + full link) are never compressed; only
  // the operation text is, with an explicit mark. The budget floor of one
  // character keeps a published operation present even for an out-of-domain
  // (unvalidated) identity; for every validated event the budget is >= the
  // operation cap, so nothing is clipped at all.
  const available = APPROVAL_WAKE_MESSAGE_CAP - head.length - guidance.length - prefix.length - truncatedMark.length;
  const maxOperation = Math.min(APPROVAL_OPERATION_CAP, Math.max(1, available));
  return rawOperation.length <= maxOperation
    ? `${head}${guidance}${prefix}${rawOperation}`
    : `${head}${guidance}${prefix}${rawOperation.slice(0, maxOperation)}${truncatedMark}`;
}

/** The argv after the executable for a Codex approval wake (`codex queue ...`). */
export function buildCodexApprovalWakeArgs(threadId: string, event: ApprovalRequiredNotificationEvent): string[] | null {
  if (!isValidCodexThreadId(threadId)) return null;
  return ["queue", "--thread", threadId, "--message", buildApprovalWakeMessage(event)];
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ResolveNotifyInput {
  callbackUrl?: unknown;
  codexThreadId?: unknown;
  /**
   * Explicit Claude session identity / opaque registered binding reference.
   * They are accepted ONLY as the two opaque reference forms; a native inbox
   * address or authentication token is never a valid input here.
   */
  claudeSessionId?: unknown;
  claudeBindingId?: unknown;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the persisted terminal-wake target with the required priority:
 * callback_url > explicit Claude session/binding > explicit codex_thread_id >
 * `CODEX_THREAD_ID` env fallback.
 *
 * A non-empty but invalid explicit value is REJECTED (stable code), never
 * silently ignored; an absent/empty value is treated as "not supplied".
 * Competing explicit caller identities (a Codex thread id together with a
 * Claude session/binding, or both Claude reference forms) are rejected as
 * ambiguous instead of being resolved by precedence, so a job can never be
 * bound to a different session than the caller named.
 */
export function resolveNotifyTarget(input: ResolveNotifyInput): NotifyTarget {
  const rawCallback = typeof input.callbackUrl === "string" ? input.callbackUrl.trim() : "";
  if (input.callbackUrl != null && String(input.callbackUrl).trim() !== "" && !isHttpUrl(rawCallback)) {
    throw new NotifyInputError("invalid_callback_url", "callback_url must be a valid http(s) URL.");
  }
  const rawThread = typeof input.codexThreadId === "string" ? input.codexThreadId.trim() : "";
  if (input.codexThreadId != null && rawThread !== "" && !isValidCodexThreadId(input.codexThreadId)) {
    throw new NotifyInputError(
      "invalid_codex_thread_id",
      "codex_thread_id must be a valid Codex session UUID or session name (alphanumeric, dot, underscore, hyphen)."
    );
  }
  const rawClaudeSession = typeof input.claudeSessionId === "string" ? input.claudeSessionId.trim() : "";
  if (input.claudeSessionId != null && rawClaudeSession !== "" && !isValidClaudeSessionId(input.claudeSessionId)) {
    throw new NotifyInputError(
      "invalid_claude_session_id",
      "claude_session_id must be the opaque Claude session id shown by the CrewDispatch SessionStart binding line (UUID-like token)."
    );
  }
  const rawClaudeBinding = typeof input.claudeBindingId === "string" ? input.claudeBindingId.trim() : "";
  if (input.claudeBindingId != null && rawClaudeBinding !== "" && !isValidClaudeBindingId(input.claudeBindingId)) {
    throw new NotifyInputError(
      "invalid_claude_binding_id",
      "claude_binding_id must be the opaque binding reference shown by the CrewDispatch SessionStart binding line (hex token)."
    );
  }
  const hasThread = rawThread !== "" && isValidCodexThreadId(rawThread);
  const hasClaude = (rawClaudeSession !== "" && isValidClaudeSessionId(rawClaudeSession)) || (rawClaudeBinding !== "" && isValidClaudeBindingId(rawClaudeBinding));
  if (hasThread && hasClaude) {
    throw new NotifyInputError(
      "conflicting_notify_targets",
      "Pass either codex_thread_id or a Claude session/binding reference, not both: the wake destination would be ambiguous."
    );
  }
  if (rawClaudeSession !== "" && isValidClaudeSessionId(rawClaudeSession) && rawClaudeBinding !== "" && isValidClaudeBindingId(rawClaudeBinding)) {
    throw new NotifyInputError(
      "conflicting_notify_targets",
      "Pass either claude_session_id or claude_binding_id, not both: the wake destination would be ambiguous."
    );
  }
  if (rawCallback && isHttpUrl(rawCallback)) {
    return { kind: "callback", callbackUrl: rawCallback, codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: "callback_url" };
  }
  if (hasClaude) {
    return {
      kind: "claude_session",
      callbackUrl: null,
      codexThreadId: null,
      claudeSessionId: rawClaudeSession !== "" && isValidClaudeSessionId(rawClaudeSession) ? rawClaudeSession : null,
      claudeBindingId: rawClaudeBinding !== "" && isValidClaudeBindingId(rawClaudeBinding) ? rawClaudeBinding : null,
      source: rawClaudeSession !== "" ? "claude_session_id" : "claude_binding_id"
    };
  }
  if (hasThread) {
    return { kind: "codex_thread", callbackUrl: null, codexThreadId: rawThread, claudeSessionId: null, claudeBindingId: null, source: "codex_thread_id" };
  }
  const env = input.env ?? process.env;
  const envId = env.CODEX_THREAD_ID;
  if (isValidCodexThreadId(envId)) {
    return { kind: "codex_thread", callbackUrl: null, codexThreadId: envId as string, claudeSessionId: null, claudeBindingId: null, source: "env" };
  }
  return { kind: "none", callbackUrl: null, codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: null };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface CodexQueueSpawn {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  shellShim: string | null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `%LOCALAPPDATA%\OpenAI\Codex\bin\<version>\codex.exe`: the newest version
 * directory that actually contains a `codex.exe` wins. A directory without one
 * (for example an `rg.exe`-only helper directory) is skipped.
 */
function findNewestCodexExe(binRoot: string): string | null {
  let names: string[];
  try {
    names = fs
      .readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(binRoot, name, "codex.exe");
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) candidates.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      /* this version directory has no codex.exe */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.length ? candidates[0]!.file : null;
}

/**
 * The installed Codex Desktop locations on Windows, in the run-task driver's
 * proven order: `%LOCALAPPDATA%\OpenAI\Codex\bin\<newest>\codex.exe`, then
 * `<CODEX_HOME>\.sandbox-bin\codex.exe` (an absolute `CODEX_HOME`, else
 * `~/.codex`). Returns null when no real file can be proven, so the caller
 * keeps the honest PATH attempt instead of guessing.
 */
export function findInstalledWindowsCodex(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const localAppData = (envValue(env, "LOCALAPPDATA", platform) ?? "").trim();
  if (localAppData) {
    const found = findNewestCodexExe(path.join(localAppData, "OpenAI", "Codex", "bin"));
    if (found) return found;
  }
  const rawHome = (envValue(env, "CODEX_HOME", platform) ?? "").trim();
  const codexHome = rawHome && path.isAbsolute(rawHome) ? rawHome : path.join(os.homedir(), ".codex");
  const sandbox = path.join(codexHome, ".sandbox-bin", "codex.exe");
  return isFile(sandbox) ? sandbox : null;
}

/**
 * Current macOS ChatGPT ships the native Codex CLI inside the merged ChatGPT
 * application bundle. Check only the two normal application roots that were
 * verified on the native host; never crawl arbitrary apps or infer from process
 * names. The caller may still override this through CODEX_CLI_PATH.
 */
export function findInstalledMacCodex(
  env: NodeJS.ProcessEnv,
  opts: { systemApplicationsRoot?: string; userApplicationsRoot?: string | null } = {}
): string | null {
  const rel = path.join(
    "ChatGPT.app",
    "Contents",
    "Resources",
    "codex-cli",
    "CodexCLI.app",
    "Contents",
    "MacOS",
    "codex"
  );
  const home = (envValue(env, "HOME", "darwin") ?? "").trim();
  const systemRoot = opts.systemApplicationsRoot ?? "/Applications";
  const userRoot = opts.userApplicationsRoot === undefined
    ? (home ? path.join(home, "Applications") : null)
    : opts.userApplicationsRoot;
  const candidates = [
    path.join(systemRoot, rel),
    ...(userRoot ? [path.join(userRoot, rel)] : [])
  ];
  for (const file of candidates) {
    if (isFile(file)) return file;
  }
  return null;
}

/**
 * Resolve the Codex CLI for a terminal wake: explicit path > `CODEX_CLI_PATH` >
 * the installed host location (Windows Codex Desktop layout or the merged
 * ChatGPT.app CodexCLI bundle on macOS) > `codex` on PATH.
 *
 * An explicit/env value that cannot be proven as a file is NOT silently
 * replaced by a discovered install: the lookup continues to the bare `codex`
 * attempt, whose honest recorded failure stays the accurate diagnostic.
 * Linux remains PATH-based.
 */
export function resolveCodexCli(input: {
  codexCliPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string {
  const explicit = typeof input.codexCliPath === "string" ? input.codexCliPath.trim() : "";
  if (explicit) {
    if (/[\\/]/.test(explicit) || /^[A-Za-z]:/.test(explicit)) {
      try {
        if (fs.statSync(explicit).isFile()) return explicit;
      } catch {
        /* fall through */
      }
      return "codex";
    }
    return explicit;
  }
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const fromEnv = (envValue(env, "CODEX_CLI_PATH", platform) ?? "").trim();
  if (fromEnv) return resolveCodexCli({ codexCliPath: fromEnv, env, platform });
  if (platform === "win32") {
    const installed = findInstalledWindowsCodex(env, platform);
    if (installed) return installed;
  } else if (platform === "darwin") {
    const installed = findInstalledMacCodex(env);
    if (installed) return installed;
  }
  return "codex";
}

/**
 * Build a shell-free, Windows-shim-safe spawn plan for `codex queue ...`. Every
 * token is validated against the measured .cmd/.bat refusals before a shim plan
 * is produced, so a hostile thread id/message can never escape into a shell.
 */
export function buildCodexQueueSpawn(
  codexCli: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; comSpec?: string } = {}
): CodexQueueSpawn {
  const platform = opts.platform ?? process.platform;
  const exe = resolveCliExecutable(codexCli, { platform, env: opts.env ?? process.env }) || codexCli;
  for (const a of args) {
    if (a.includes("\0")) throw new NotifyInputError("unsafe_argv", "The codex queue argument contains a NUL; refusing to start.");
  }
  if (platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    for (const a of args) {
      const problem = cmdShimTokenProblem(a);
      if (problem) {
        throw new NotifyInputError("unsafe_shim_argv", `codex is a .cmd/.bat script and the argument contains ${problem}; refusing to start.`);
      }
    }
    const line = `"${exe}" ${args.map((a) => `"${a}"`).join(" ")}`;
    const com = opts.comSpec && opts.comSpec.trim() ? opts.comSpec.trim() : "cmd.exe";
    return { file: com, args: ["/d", "/s", "/v:off", "/c", `"${line}"`], windowsVerbatimArguments: true, shellShim: exe };
  }
  return { file: exe, args: [...args], windowsVerbatimArguments: false, shellShim: null };
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Default callback delivery: a single short-timeout POST, no retry. */
function defaultHttpPost(url: string, body: string, timeoutMs: number): Promise<DeliveryOutcome> {
  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    const done = (outcome: DeliveryOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let mod: typeof http | typeof https;
    try {
      mod = new URL(url).protocol === "https:" ? https : http;
    } catch {
      done({ delivered: false, reason: "invalid_url" });
      return;
    }
    let req: http.ClientRequest;
    try {
      req = mod.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        res.resume();
        const code = res.statusCode ?? 0;
        done({ delivered: code >= 200 && code < 300, reason: code >= 200 && code < 300 ? null : `http_status_${code}` });
      });
    } catch (e) {
      done({ delivered: false, reason: `request_failed:${String((e as Error)?.message || e)}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      done({ delivered: false, reason: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    req.on("error", (e: Error) => {
      clearTimeout(timer);
      done({ delivered: false, reason: `request_failed:${String(e?.message || e)}` });
    });
    req.write(body);
    req.end();
  });
}

/** The minimal immutable facts a wake needs — never the live (mutable) record. */
export interface WakeFacts {
  id: string;
  generation: number;
  status: string;
  notifyTarget: NotifyTarget;
}

/**
 * The compact stderr evidence of a FAILED codex queue wake (a NON-ZERO exit).
 * Control characters/newlines are normalized through the shared safe-output
 * cleanup and the kept slice is the BOUNDED TAIL — the final stderr bytes carry
 * the rejection reason. `null` means nothing useful remains, so the caller keeps
 * the plain `exit_<n>` code. A successful exit never consults stderr.
 */
function wakeStderrDiagnostic(stderrTail: string): string | null {
  const normalized = sanitizeOneLineText(stderrTail, "");
  if (!normalized) return null;
  return normalized.length <= STDERR_DIAGNOSTIC_CAP ? normalized : normalized.slice(-STDERR_DIAGNOSTIC_CAP);
}

// ---------------------------------------------------------------------------
// The two real caller transports, registered into the shared neutral registry
// ---------------------------------------------------------------------------

/**
 * HTTP callback transport: a single short-timeout POST, no retry. The terminal
 * body is byte-compatible with the historical wake; the approval body carries
 * the explicit `approval_required` discriminator and never a terminal status.
 */
registerNotificationTransport({
  kind: "callback",
  async deliver(event, target, deps) {
    if (!target.callbackUrl) return { delivered: false, reason: "no_target" };
    // The recovered-terminal event belongs ONLY to the local Claude inbox path
    // that recorded the phase evidence; a callback/Codex target never receives
    // it (the recovery pass restricts eligibility to Claude targets, and this
    // explicit refusal keeps that boundary even if a caller misroutes it).
    if (event.event === "terminal_recovered") return { delivered: false, reason: "unsupported_event" };
    const post = deps.httpPostFn ?? defaultHttpPost;
    try {
      return await post(target.callbackUrl, notificationCallbackBody(event), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (e) {
      return { delivered: false, reason: `request_failed:${String((e as Error)?.message || e)}` };
    }
  }
});

/**
 * Codex-thread transport: a safe `codex queue` argv, shell-free, never the task
 * text. The terminal message is unchanged; the approval message tells the
 * caller the job is waiting and how to show the human the Hub link.
 */
registerNotificationTransport({
  kind: "codex_thread",
  async deliver(event, target, deps) {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const threadId = target.codexThreadId;
    if (!isValidCodexThreadId(threadId)) return { delivered: false, reason: "invalid_thread_id" };
    // See the callback adapter: the recovered-terminal event is Claude-inbox
    // only and is refused here rather than rendered as an approval message.
    if (event.event === "terminal_recovered") return { delivered: false, reason: "unsupported_event" };
    const args = event.event === "terminal"
      ? buildCodexWakeArgs(threadId as string, event.jobId, event.status)
      : buildCodexApprovalWakeArgs(threadId as string, event);
    if (!args) return { delivered: false, reason: "invalid_thread_id" };
    const codexCli = resolveCodexCli({ codexCliPath: deps.codexCliPath, env: deps.env, platform: deps.platform });
    let plan: CodexQueueSpawn;
    try {
      plan = buildCodexQueueSpawn(codexCli, args, { env: deps.env, platform: deps.platform });
    } catch (e) {
      return { delivered: false, reason: e instanceof NotifyInputError ? e.code : "unsafe_argv" };
    }
    const spawnFn = deps.spawnFn ?? spawn;
    return await new Promise<DeliveryOutcome>((resolve) => {
      let settled = false;
      const done = (outcome: DeliveryOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      let child: ChildProcess;
      try {
        child = spawnFn(plan.file, plan.args, {
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
          // stdio is piped ONLY for stderr: a rejected `codex queue` explains
          // itself there, while stdout is never useful to a wake. The stream must
          // be consumed so the child can never block on a full pipe.
          stdio: ["ignore", "ignore", "pipe"]
        });
      } catch (e) {
        done({ delivered: false, reason: `spawn_failed:${String((e as Error)?.message || e)}` });
        return;
      }
      let stderrTail = "";
      child.stderr?.on("data", (d: Buffer | string) => {
        stderrTail = (stderrTail + d.toString("utf8")).slice(-STDERR_TAIL_CAP);
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done({ delivered: false, reason: "timeout" });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        done({ delivered: false, reason: `spawn_failed:${String(e?.message || e)}` });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) {
          // A successful wake records NO stderr: only its delivery matters.
          done({ delivered: true, reason: null });
          return;
        }
        // A non-zero exit may carry an actionable rejection on stderr; when it is
        // empty/unusable the honest `exit_<n>` code is kept. The attempt itself is
        // unchanged — this is diagnostic text only, never a retry.
        const diagnostic = typeof code === "number" ? wakeStderrDiagnostic(stderrTail) : null;
        done({ delivered: false, reason: diagnostic ? `exit_${code}: ${diagnostic}` : `exit_${code}` });
      });
    });
  }
});

/**
 * The local Claude session transport (native session inbox). It opens the
 * bound inbox ONLY when an event is ready, reads the native address/token from
 * the private binding store under the data root (`DeliveryDeps.root`), sends
 * the bounded frames and closes. A missing/closed/held inbox is a truthful
 * recorded failure that never changes the job outcome.
 */
registerNotificationTransport(claudeNotificationTransport);

/**
 * The bounded Claude caller-binding MAINTENANCE adapter, registered beside the
 * transport. It reaps a private binding whose recorded stable owner process has
 * PROVABLY exited even when the host's SessionEnd carried no socket/token
 * exports. The daemon's existing reconcile cycle invokes the shared
 * `runNotificationMaintenance` entry; the ancestry/binding decision stays in
 * src/claude/lifecycle.ts.
 */
registerNotificationMaintenance(claudeCallerBindingMaintenance);

/** The neutral terminal event of one immutable terminal snapshot. */
function terminalEvent(facts: WakeFacts): NotificationEvent {
  return { event: "terminal", jobId: facts.id, generation: facts.generation, status: facts.status };
}

/**
 * Deliver one terminal wake through the registered neutral transport. Never
 * throws (an absent target/adapter or a transport failure becomes a recorded
 * reason) and never retries. The data root is forwarded so transports that
 * need a private local binding (Claude) can resolve it; the HTTP/Codex
 * transports ignore it.
 */
async function attemptDelivery(facts: WakeFacts, deps: DeliveryDeps): Promise<DeliveryOutcome> {
  return deliverNotificationEvent(terminalEvent(facts), facts.notifyTarget, deps);
}

export interface DeliverTerminalOptions {
  /**
   * Deliver for exactly this terminal generation. The detached worker passes the
   * generation it just finalised, so a continuation that bumps the record to a
   * newer generation in the meantime cannot make the terminal generation
   * undiscoverable. When omitted, EVERY terminal generation of the job that has
   * no recorded result yet is attempted (in generation order) — used by the MCP
   * read/cancel entries to cover a terminal state written by reconciliation or by
   * a worker that died before it could wake.
   */
  generation?: number;
  /**
   * Origin tag of the recorded attempt, persisted in the durable result:
   * `worker` / `cancel` / `mcp` / `daemon-reconcile` / `hub-reconcile` are the
   * production values. An omitted/blank value is persisted as null — an unknown
   * origin is never invented.
   */
  by?: string;
}

function snapshotToFacts(snap: TerminalSnapshot): WakeFacts {
  return { id: snap.id, generation: snap.generation, status: snap.status, notifyTarget: snap.notifyTarget };
}

/** The live record, only as a LEGACY fallback when no snapshot exists at all. */
function legacySnapshot(root: string, jobId: string): TerminalSnapshot | null {
  const job = loadJob(root, jobId);
  if (!job || !isTerminalStatus(job.status)) return null;
  return { id: job.id, generation: job.generation, status: job.status, notifyTarget: job.notifyTarget, at: job.updatedAt, by: "legacy" };
}

/**
 * Attempt the terminal wake for one or more terminal generations, AT MOST ONCE
 * each, and record each outcome in its OWN generation-scoped file.
 *
 * It reads the IMMUTABLE terminal snapshot (never the mutable job record) and
 * writes ONLY the result file — it NEVER rewrites the job record, so a slow
 * HTTP POST / queue child can never clobber a newer generation's state. It NEVER
 * changes the job's status, result or error; a delivery failure is a recorded
 * diagnostic only. A generation that was already attempted (its claim file
 * exists) is never retried.
 */
export async function deliverTerminalNotification(
  root: string,
  jobId: string,
  deps: DeliveryDeps = {},
  opts: DeliverTerminalOptions = {}
): Promise<NotificationRecord | null> {
  const now = deps.now ?? (() => new Date());
  let snapshots: TerminalSnapshot[];
  if (opts.generation != null) {
    const snap = readTerminalSnapshot(root, jobId, opts.generation);
    if (snap) {
      snapshots = [snap];
    } else {
      const legacy = legacySnapshot(root, jobId);
      snapshots = legacy && legacy.generation === opts.generation ? [legacy] : [];
    }
  } else {
    snapshots = readTerminalSnapshots(root, jobId);
    // A crash can leave the CURRENT terminal record without its separate
    // snapshot even when older generations already have snapshots. Recover that
    // generation too; checking only for an empty snapshot list would miss it.
    const legacy = legacySnapshot(root, jobId);
    if (legacy && !snapshots.some((s) => s.generation === legacy.generation)) {
      snapshots.push(legacy);
      snapshots.sort((a, b) => a.generation - b.generation);
    }
  }

  // The delivery ORIGIN (which finalizer attempted this wake) is persisted on
  // every record; an omitted origin stays null rather than being invented.
  const origin = typeof opts.by === "string" && opts.by.trim() ? opts.by.trim() : null;

  let last: NotificationRecord | null = null;
  for (const snap of snapshots) {
    if (!isTerminalStatus(snap.status)) continue;
    // Already recorded (a completed delivery) → never repeat.
    if (readNotificationResult(root, jobId, snap.generation)) continue;
    // At most once per generation: an exclusive claim across processes.
    if (!claimNotificationAttempt(root, jobId, snap.generation)) continue;

    const outcome = await attemptDelivery(snapshotToFacts(snap), { ...deps, root });
    const record: NotificationRecord = {
      generation: snap.generation,
      kind: snap.notifyTarget.kind,
      attemptedAt: now().toISOString(),
      delivered: outcome.delivered,
      reason: outcome.reason,
      by: origin,
      // Bounded transport-phase evidence: persisted only when the transport can
      // prove it (the Claude inbox adapter); null for HTTP/Codex = unknown.
      phase: outcome.phase ?? null
    };
    writeNotificationResult(root, jobId, snap.generation, record, now);
    last = record;
  }
  return last;
}
