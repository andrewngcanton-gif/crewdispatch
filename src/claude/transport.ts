// transport.ts — the ONE Claude notification transport adapter: a short,
// bounded send into a bound session's official native inbox.
//
// Wire shape (isolated in `buildClaudeInboxFrames`, and exercised by a real
// installed-host gate): the connection is newline-delimited JSON frames, and a
// native Windows named pipe requires the FIRST frame to be
// `{type:"auth",token}`; the second frame is
// `{type:"user",message:{role:"user",content:<bounded text>}}`. Unix sockets
// accept the same auth frame. This shape is NOT a versioned protocol
// specification: it comes from the official cross-session messaging docs and
// the observed host probe, so it is deliberately behind one adapter and one
// capability check rather than spread through the product.
//
// Honest delivery semantics: `delivered: true` means the frames were fully
// WRITTEN to the bound inbox endpoint and the connection closed without an
// error. The wire protocol provides no versioned acknowledgement, so this is
// NOT proof that the model/conversation observed the message — that is proven
// only by the installed-host acceptance gate. A closed/refusing/held inbox,
// a missing binding, a partial write or a timeout are recorded truthfully and
// NEVER change the job status/result.
//
// Bounded PHASE evidence (see `DeliveryPhase`): `writingStarted` is set
// immediately BEFORE the single `socket.end(...)` write call — never from its
// callback — so every outcome can be classified as proven NOT-WRITTEN (the
// write call was never issued) or WRITING-STARTED/unknown. Only `not_written`
// is eligible for the bounded recovery path; `inbox_held`, a partial/early
// close, a post-write disconnect and a crash remain uncertain and are never
// resent automatically. The phase carries no token/address material.
//
// A RESOLVED-ABSENT binding is the same proven class: when no binding of the
// exact session exists there is no address and no token to write to, so no
// write could have begun. That is the ordinary "the conversation was closed and
// SessionEnd removed the binding while the job ran" shape, and it is recorded
// as `not_written` — otherwise a job that provably never reached an inbox could
// never be recovered on reopen.
//
// There is no retry, no heartbeat and no long-lived connection: the transport
// opens the inbox only when an event is ready and closes it; the timeout bounds
// ONLY this connection/send, never the task lifetime.
import net from "node:net";
import type { DeliveryDeps, DeliveryOutcome, NotificationTransportAdapter } from "../jobs/notifications";
import type { DeliveryPhase } from "../jobs/types";
import { resolveClaudeBinding } from "./binding";
import { buildClaudeApprovalWakeMessage, buildClaudeRecoveryWakeMessage, buildClaudeWakeMessage } from "./messages";

/** Default bound for one inbox connection/send (never a task timeout). */
export const CLAUDE_INBOX_TIMEOUT_MS = 5000;

/** Injection seam so tests can supply a real socket without a real host. */
export type ClaudeConnectFn = (socketPath: string) => net.Socket;

export interface ClaudeInboxSendInput {
  socket: string;
  token: string;
  message: string;
  timeoutMs: number;
  connectFn?: ClaudeConnectFn;
}

/**
 * Build the exact native-inbox byte payload: one auth frame followed by one
 * user frame, newline-delimited. Kept as a single pure function so the
 * unversioned wire shape has exactly one definition.
 */
export function buildClaudeInboxFrames(token: string, message: string): string {
  const auth = JSON.stringify({ type: "auth", token });
  const user = JSON.stringify({ type: "user", message: { role: "user", content: message } });
  return `${auth}\n${user}\n`;
}

function mapSocketError(code: string | undefined): string {
  switch (code) {
    case "ENOENT":
    case "ECONNREFUSED":
      return "inbox_unreachable";
    case "EACCES":
    case "EPERM":
      return "inbox_permission_denied";
    default:
      return `inbox_error:${code || "unknown"}`;
  }
}

/**
 * Send one bounded message to one bound native inbox. Never throws; the
 * returned outcome is recorded verbatim by the shared notification layer.
 *
 * The returned `phase` is derived from ONE in-process fact: whether the single
 * write call (`socket.end`) had been ISSUED when the outcome settled. It is set
 * immediately before the call, so:
 *   - a missing/refused connection, a stalled connect or a synchronous
 *     construction failure settles BEFORE any write → `not_written`;
 *   - a held endpoint, an early/partial close, a post-write disconnect or any
 *     error after the write call → `writing_started` (uncertain);
 *   - a clean close after the frames were flushed → `handoff`.
 * A crash before the result is recorded leaves NO phase at all, which recovery
 * treats as unknown/ineligible.
 */
export function sendClaudeInboxMessage(input: ClaudeInboxSendInput): Promise<DeliveryOutcome> {
  return new Promise<DeliveryOutcome>((resolve) => {
    let settled = false;
    let flushed = false;
    let replyReceived = false;
    // Set immediately BEFORE the write call, never from its callback.
    let writingStarted = false;
    const phase = (): DeliveryPhase => (writingStarted ? "writing_started" : "not_written");
    const done = (outcome: DeliveryOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(outcome);
    };
    const fail = (reason: string): void => done({ delivered: false, reason, phase: phase() });
    const connectFn = input.connectFn ?? ((p: string) => net.createConnection(p));
    let socket: net.Socket;
    try {
      socket = connectFn(input.socket);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // The socket was never even constructed: provably no write began.
      resolve({ delivered: false, reason: `inbox_error:${String(code || (e as Error)?.message || e)}`, phase: "not_written" });
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    // `inbox_held` is a bounded SEND timeout only: the frames were flushed but
    // the endpoint neither closed nor errored within the window. The wire shape
    // has no acknowledgement, so this is NOT protocol evidence of any host
    // approval/consent policy — it is recorded as an honest send failure.
    const armTimer = (): void => {
      timer = setTimeout(() => {
        done(flushed ? { delivered: false, reason: "inbox_held", phase: "writing_started" } : { delivered: false, reason: "timeout", phase: phase() });
      }, input.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    };
    // The bound covers the WHOLE connection/send (a stalled connect included),
    // never the task lifetime: there is no retry and no long-lived connection.
    armTimer();
    socket.once("connect", () => {
      try {
        // THE write marker: set synchronously before the only write call.
        writingStarted = true;
        socket.end(buildClaudeInboxFrames(input.token, input.message), () => {
          flushed = true;
        });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        fail(`inbox_error:${String(code || (e as Error)?.message || e)}`);
      }
    });
    socket.on("data", () => {
      // The protocol defines no acknowledgement we may interpret; inbound bytes
      // are noted but never parsed as success or failure text.
      replyReceived = true;
    });
    socket.once("error", (e: Error) => {
      if (timer) clearTimeout(timer);
      fail(mapSocketError((e as NodeJS.ErrnoException)?.code));
    });
    socket.once("timeout", () => {
      if (timer) clearTimeout(timer);
      done(flushed ? { delivered: false, reason: "inbox_held", phase: "writing_started" } : { delivered: false, reason: "timeout", phase: phase() });
    });
    socket.setTimeout(input.timeoutMs);
    socket.once("close", (hadError: boolean) => {
      if (timer) clearTimeout(timer);
      if (hadError) {
        fail("inbox_error:closed");
        return;
      }
      if (!flushed) {
        // The endpoint closed before our frames were fully written; a partial
        // or refused write is never reported as delivered.
        fail(replyReceived ? "inbox_rejected" : "inbox_closed_early");
        return;
      }
      done({ delivered: true, reason: null, phase: "handoff" });
    });
  });
}

/**
 * The registered `claude_session` transport. It resolves the PRIVATE binding
 * from the data root carried in `DeliveryDeps.root`, then sends the bounded
 * event text. A missing binding (never registered / already cleaned up / the
 * record names a different session) fails closed with `no_binding`.
 */
export const claudeNotificationTransport: NotificationTransportAdapter = {
  kind: "claude_session",
  async deliver(event, target, deps: DeliveryDeps): Promise<DeliveryOutcome> {
    const root = deps.root;
    if (!root) return { delivered: false, reason: "no_data_root" };
    const binding = resolveClaudeBinding(root, {
      bindingId: target.claudeBindingId ?? null,
      sessionId: target.claudeSessionId ?? null
    });
    // No binding of the exact session resolves: there is no inbox to write to,
    // so the write provably never began. Recorded as `not_written` (see the
    // module comment) — strict resolution is unchanged, and this is still a
    // failure, never a success.
    if (!binding) return { delivered: false, reason: "no_binding", phase: "not_written" };
    const message =
      event.event === "terminal"
        ? buildClaudeWakeMessage(event.jobId, event.status)
        : event.event === "terminal_recovered"
          ? buildClaudeRecoveryWakeMessage(event.jobId, event.generation, event.status, event.collected)
          : buildClaudeApprovalWakeMessage(event);
    return sendClaudeInboxMessage({
      socket: binding.socket,
      token: binding.token,
      message,
      timeoutMs: deps.timeoutMs ?? CLAUDE_INBOX_TIMEOUT_MS,
      connectFn: deps.claudeConnectFn
    });
  }
};
