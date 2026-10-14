// hook.ts — the tiny Claude Code hook entry that registers THIS session's
// native inbox binding and exits immediately.
//
//   node dist/claude/hook.js session-start   (SessionStart hook)
//   node dist/claude/hook.js session-end     (SessionEnd hook)
//
// Why a hook: the installed MCP server is long-lived and is NOT reliably given
// the per-session `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` exports, and its own
// identity must never be inferred from cwd/title/process state. A SessionStart
// hook receives the exact `session_id` in its JSON input together with the
// session's exported inbox address/token, so it can register the EXACT current
// session. It writes only the private binding store (src/claude/binding.ts) and
// prints ONE safe guidance line to Claude — never the address, never the token.
//
// After a SUCCESSFUL registration the CLI additionally asks the existing
// authenticated daemon for ONE bounded notification-recovery pass for this
// exact session (opaque session/binding ids only): a job whose original wake
// provably never began writing is re-notified to the session's CURRENT inbox.
// That request is bounded end to end by `RECOVERY_REQUEST_BUDGET_MS` (broker
// connect/start + request round-trip) and can never fail the session. It is
// NOT instantaneous — with a stopped broker the budget is largely spent
// starting it — so the honest guarantee is a finite bound, not "never waits".
// It is deliberately NOT part of the pure registration function, so the hook
// logic stays reusable and testable without a broker.
//
// The hook is deliberately tiny: no listener, no timer, no background process.
// It NEVER blocks or fails a session: every error path exits 0 with a stderr
// diagnostic (Claude treats a non-zero hook exit as a session-visible failure,
// which this convenience must not cause).
//
// SessionEnd cleanup matches the EXACT incarnation (session id + this hook's
// own inbox address + this hook's own session token), so a late end of an
// older/resumed incarnation can never delete the newer registration — even
// when the host reused the same native address with a new token.
import fs from "node:fs";
import { ClaudeBindingError, registerClaudeBinding, removeClaudeBindingForIncarnation, type ClaudeOwnerRef } from "./binding";
import { isValidClaudeSessionId } from "./ids";
import { resolveDataRoot } from "../jobs/store";
import { requestClaudeSessionRecovery } from "../daemon/client";
import { captureCallerOwner } from "./lifecycle";

/** One-line cap for the SessionStart guidance emitted into the conversation. */
export const HOOK_GUIDANCE_CAP = 600;

export interface ClaudeHookInput {
  /** Raw hook stdin JSON (Claude passes a single JSON object). */
  stdinText: string;
  env: NodeJS.ProcessEnv;
  /** Explicit data root override (tests); defaults to the shared resolution. */
  root?: string | null;
  /**
   * Optional, already-validated caller-owner identity, injected ONLY by the
   * async CLI orchestration after a best-effort OS capture. It is never read
   * from the hook env; absent/null keeps the registration owner-less.
   */
  owner?: ClaudeOwnerRef | null;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export interface ClaudeHookResult {
  /** Safe line for Claude's context (SessionStart only), or null. */
  stdout: string | null;
  /** Local diagnostic; never contains a token/address value. */
  stderr: string | null;
  /** Always 0: the hook never fails a session. */
  exitCode: 0;
  /**
   * The EXACT registration a successful SessionStart wrote (opaque ids only;
   * never printed). Absent on every other path. The CLI uses it to request the
   * bounded recovery pass; the pure hook logic itself never touches a broker.
   */
  registration?: { sessionId: string; bindingId: string };
}

function parseHookJson(stdinText: string): Record<string, unknown> | null {
  if (!stdinText.trim()) return null;
  try {
    const parsed = JSON.parse(stdinText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function envString(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value : "";
}

/**
 * SessionStart: register the exact session binding from the hook JSON plus the
 * exported inbox address/token, and emit ONE bounded guidance line. Without a
 * usable session id or inbox export nothing is registered and no guidance is
 * emitted (the truthful state is "wake capability unavailable in this host").
 */
export function runSessionStartHook(input: ClaudeHookInput): ClaudeHookResult {
  const json = parseHookJson(input.stdinText);
  const sessionId = json?.session_id;
  if (!isValidClaudeSessionId(sessionId)) {
    return { stdout: null, stderr: "crewdispatch: SessionStart hook had no usable session_id; no binding registered.", exitCode: 0 };
  }
  const socket = envString(input.env, "CLAUDE_CODE_MESSAGING_SOCKET");
  const token = envString(input.env, "CLAUDE_CODE_MESSAGING_TOKEN");
  if (!socket || !token) {
    return {
      stdout: null,
      stderr: "crewdispatch: this session exposes no native inbox exports (messaging unavailable); no binding registered.",
      exitCode: 0
    };
  }
  let root: string;
  try {
    root = resolveDataRoot(input.root, input.env);
  } catch (e) {
    return { stdout: null, stderr: `crewdispatch: could not resolve the data root (${safeError(e)}).`, exitCode: 0 };
  }
  try {
    const binding = registerClaudeBinding(root, {
      sessionId,
      socket,
      token,
      owner: input.owner,
      now: input.now,
      platform: input.platform,
      env: input.env
    });
    const guidance = sanitizeGuidance(
      `CrewDispatch: this conversation's Claude session binding is registered. When dispatching work through CrewDispatch in THIS conversation, pass claude_session_id="${binding.sessionId}" (or claude_binding_id="${binding.bindingId}") to crewdispatch_spawn/crewdispatch_run/crewdispatch_follow_up so the completion or approval wake returns here. Never pass a socket or token.`
    );
    return { stdout: guidance, stderr: null, exitCode: 0, registration: { sessionId: binding.sessionId, bindingId: binding.bindingId } };
  } catch (e) {
    const code = e instanceof ClaudeBindingError ? e.code : "registration_failed";
    return { stdout: null, stderr: `crewdispatch: session binding not registered (${code}).`, exitCode: 0 };
  }
}

/**
 * SessionEnd: remove this session's binding ONLY when the ending incarnation
 * still matches exactly (same session id, this hook's own inbox address AND
 * this hook's own session token). The token is the decisive evidence: a
 * resumed session can be given the same native address with a new token, so
 * the address alone must never justify a deletion. Missing address or token
 * means nothing is removed — leaving a stale binding is safe because delivery
 * fails closed against a dead inbox; deleting a newer registration would not
 * be.
 */
export function runSessionEndHook(input: ClaudeHookInput): ClaudeHookResult {
  const json = parseHookJson(input.stdinText);
  const sessionId = json?.session_id;
  if (!isValidClaudeSessionId(sessionId)) {
    return { stdout: null, stderr: null, exitCode: 0 };
  }
  const socket = envString(input.env, "CLAUDE_CODE_MESSAGING_SOCKET");
  const token = envString(input.env, "CLAUDE_CODE_MESSAGING_TOKEN");
  let root: string;
  try {
    root = resolveDataRoot(input.root, input.env);
  } catch (e) {
    return { stdout: null, stderr: `crewdispatch: could not resolve the data root (${safeError(e)}).`, exitCode: 0 };
  }
  const result = removeClaudeBindingForIncarnation(root, { sessionId, socket, token });
  return {
    stdout: null,
    stderr: result.removed ? null : `crewdispatch: no session binding removed (${result.reason}).`,
    exitCode: 0
  };
}

function safeError(e: unknown): string {
  const message = String((e as Error)?.message || e);
  return message.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function sanitizeGuidance(text: string): string {
  const oneLine = text.replace(/[\r\n]+/g, " ").trim();
  return oneLine.length <= HOOK_GUIDANCE_CAP ? oneLine : oneLine.slice(0, HOOK_GUIDANCE_CAP);
}

/** Process entry: reads stdin synchronously, dispatches, prints, exits 0. */
export function runClaudeHookCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ClaudeHookResult {
  const mode = argv[0] === "session-end" ? "session-end" : argv[0] === "session-start" ? "session-start" : null;
  if (!mode) return { stdout: null, stderr: "crewdispatch: usage: hook.js <session-start|session-end>.", exitCode: 0 };
  let stdinText = "";
  try {
    stdinText = fs.readFileSync(0, "utf8");
  } catch {
    stdinText = "";
  }
  const input: ClaudeHookInput = { stdinText, env };
  return mode === "session-start" ? runSessionStartHook(input) : runSessionEndHook(input);
}

/**
 * The ASYNC CLI orchestration the process entry actually runs.
 *
 * SessionStart: after the native session/address/token are known to be usable,
 * capture the stable caller-owner lifetime identity with a small finite budget
 * (best-effort; a missing/failed/unsupported scan yields null and changes
 * nothing), register with it, and then — ONLY after a successful registration —
 * ask the existing authenticated daemon for ONE bounded recovery pass for that
 * exact session.
 *
 * SessionEnd: the pure exact-incarnation cleanup only (no capture, no recovery).
 *
 * The broker request is bounded end to end by `RECOVERY_REQUEST_BUDGET_MS` and
 * never throws, so this function always resolves with exit code 0 and never
 * fails a host session; the recovery diagnostic is merged into stderr and never
 * into the guidance line. The bound is finite, not zero: a stopped broker is
 * started within that budget, so the session can be held up to it — never
 * longer. Owner capture adds at most `OWNER_CAPTURE_BUDGET_MS` before it.
 */
export async function runClaudeHookCliAsync(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ClaudeHookResult> {
  const mode = argv[0] === "session-end" ? "session-end" : argv[0] === "session-start" ? "session-start" : null;
  if (!mode) return { stdout: null, stderr: "crewdispatch: usage: hook.js <session-start|session-end>.", exitCode: 0 };
  let stdinText = "";
  try {
    stdinText = fs.readFileSync(0, "utf8");
  } catch {
    stdinText = "";
  }
  if (mode === "session-end") return runSessionEndHook({ stdinText, env });
  const owner = await captureOwnerForStart(stdinText, env);
  const result = runSessionStartHook({ stdinText, env, owner });
  const registration = result.registration;
  if (!registration) return result;
  let diagnostic: string | null = null;
  try {
    const root = resolveDataRoot(undefined, env);
    const recovery = await requestClaudeSessionRecovery(root, registration, env);
    if (!recovery.ok) {
      diagnostic = `crewdispatch: bounded session recovery was not performed (${recovery.code}).`;
    }
  } catch (e) {
    diagnostic = `crewdispatch: bounded session recovery was not performed (${safeError(e)}).`;
  }
  if (!diagnostic) return result;
  return { ...result, stderr: result.stderr ? `${result.stderr} ${diagnostic}` : diagnostic };
}

/**
 * Best-effort owner capture for a real SessionStart: it runs ONLY when the
 * native session id and both inbox exports are usable (so a session with no
 * wake capability never pays for a scan), and it NEVER throws. The identity is
 * injected into the pure registration, never read from the env by the hook.
 */
async function captureOwnerForStart(stdinText: string, env: NodeJS.ProcessEnv): Promise<ClaudeOwnerRef | null> {
  const json = parseHookJson(stdinText);
  if (!isValidClaudeSessionId(json?.session_id)) return null;
  if (!envString(env, "CLAUDE_CODE_MESSAGING_SOCKET") || !envString(env, "CLAUDE_CODE_MESSAGING_TOKEN")) return null;
  try {
    return await captureCallerOwner({});
  } catch {
    return null;
  }
}

if (require.main === module) {
  void runClaudeHookCliAsync(process.argv.slice(2), process.env).then((result) => {
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = 0;
  });
}
