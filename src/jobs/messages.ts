// messages.ts — durable, bounded Hub user-message history side-car.
//
// `prepareContinuation` replaces `JobRecord.task` with the latest follow-up, so
// the Hub cannot reconstruct the original task from the record after a resume.
// This side-car is written before a generation is accepted. Older records with
// no side-car report incomplete history; their current `task` is never guessed
// to be the original message.
import fs from "node:fs";
import path from "node:path";
import { assertInside, atomicWriteFile, safeId } from "./store";

export type UserMessageSource = "codex" | "claude" | "dashboard" | "callback" | "unknown";

/** One user message in a job's conversation (Hub session view). */
export interface UserMessage {
  text: string;
  generation: number;
  at: string;
  /** Local UI provenance only; never included in the provider prompt. */
  source?: UserMessageSource;
}
export interface UserMessageHistory {
  /** True when a valid side-car exists. A valid but incomplete history is possible. */
  available: boolean;
  /** True only when the original generation-0 message is known to be present. */
  complete: boolean;
  messages: UserMessage[];
  reason: "missing" | "invalid" | null;
}

/** One durable assistant reply paired with the user-message generation it answers. */
export interface AssistantMessage {
  text: string;
  generation: number;
  at: string;
}

export interface AssistantMessageHistory {
  available: boolean;
  messages: AssistantMessage[];
  reason: "missing" | "invalid" | null;
}

const FORMAT_VERSION = 1;
const MAX_MESSAGES = 200;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

export function messageDir(root: string): string {
  return path.join(root, "messages");
}

export function messagePath(root: string, id: string): string {
  return path.join(messageDir(root), `${safeId(id)}.json`);
}

export function assistantMessagePath(root: string, id: string): string {
  return path.join(messageDir(root), `${safeId(id)}.assistant.json`);
}

function isUserMessageSource(value: unknown): value is UserMessageSource {
  return value === "codex" || value === "claude" || value === "dashboard" || value === "callback" || value === "unknown";
}

function isUserMessage(v: unknown): v is UserMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return typeof m.text === "string" &&
    Number.isInteger(m.generation) && (m.generation as number) >= 0 &&
    typeof m.at === "string" &&
    (m.source === undefined || isUserMessageSource(m.source));
}
function isAssistantMessage(v: unknown): v is AssistantMessage {
  return isUserMessage(v);
}

function invalidHistory(): UserMessageHistory {
  return { available: false, complete: false, messages: [], reason: "invalid" };
}

/** Load history while distinguishing a missing/invalid side-car from an empty conversation. */
export function loadUserMessagesInfo(root: string, id: string): UserMessageHistory {
  const file = messagePath(root, id);
  assertInside(root, file);
  let text: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HISTORY_BYTES) return invalidHistory();
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { available: false, complete: false, messages: [], reason: "missing" };
    }
    return invalidHistory();
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidHistory();
  }
  // Read the original array format for compatibility with early batch-7A WIP.
  if (Array.isArray(raw)) {
    if (!raw.every(isUserMessage)) return invalidHistory();
    const messages = raw as UserMessage[];
    const complete = messages.length > 0 && messages[0]!.generation === 0;
    return { available: true, complete, messages, reason: complete ? null : "missing" };
  }
  if (!raw || typeof raw !== "object") return invalidHistory();
  const record = raw as Record<string, unknown>;
  if (record.version !== FORMAT_VERSION || typeof record.complete !== "boolean" || !Array.isArray(record.messages) || !record.messages.every(isUserMessage)) {
    return invalidHistory();
  }
  const messages = record.messages as UserMessage[];
  const complete = record.complete && messages.length > 0 && messages[0]!.generation === 0;
  return { available: true, complete, messages, reason: complete ? null : "missing" };
}

/** Compatibility helper for callers that only need the parsed messages. */
export function loadUserMessages(root: string, id: string): UserMessage[] {
  return loadUserMessagesInfo(root, id).messages;
}

function encodedHistory(messages: UserMessage[], complete: boolean): string {
  if (messages.length > MAX_MESSAGES) {
    throw new Error(`message history limit exceeded (${MAX_MESSAGES} messages)`);
  }
  const text = JSON.stringify({ version: FORMAT_VERSION, complete, messages }, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) {
    throw new Error(`message history limit exceeded (${MAX_HISTORY_BYTES} bytes)`);
  }
  return text;
}

/** Atomically write a validated history snapshot. Used to roll back a failed generation save. */
export function writeUserMessagesInfo(root: string, id: string, history: UserMessageHistory): void {
  if (history.available && history.reason === "invalid") throw new Error("cannot overwrite invalid message history");
  const file = messagePath(root, id);
  assertInside(root, file);
  atomicWriteFile(file, encodedHistory(history.messages, history.complete));
}

/** Remove only this job's exact history side-car (used for rollback before job acceptance). */
export function removeUserMessages(root: string, id: string): void {
  const file = messagePath(root, id);
  assertInside(root, file);
  try {
    fs.unlinkSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
}

/** Persist one message before the matching generation is accepted. Throws on any failure. */
export function appendUserMessageOrThrow(root: string, id: string, msg: UserMessage): UserMessageHistory {
  if (!isUserMessage(msg)) throw new Error("invalid user message");
  const previous = loadUserMessagesInfo(root, id);
  if (previous.reason === "invalid") throw new Error("message history is unreadable; refusing to overwrite it");
  const messages = previous.messages.slice();
  const last = messages[messages.length - 1];
  if (last && msg.generation <= last.generation) {
    // Allow the same append to be retried after a failed job-record write, while
    // rejecting a different message for an already-persisted generation.
    if (msg.generation === last.generation && msg.text === last.text) return previous;
    throw new Error("message generation is not newer than the persisted history");
  }
  messages.push(msg);
  const complete = previous.complete || (messages.length === 1 && msg.generation === 0);
  const next: UserMessageHistory = {
    available: true,
    complete,
    messages,
    reason: complete ? null : "missing"
  };
  const file = messagePath(root, id);
  assertInside(root, file);
  atomicWriteFile(file, encodedHistory(messages, complete));
  return next;
}

function invalidAssistantHistory(): AssistantMessageHistory {
  return { available: false, messages: [], reason: "invalid" };
}

export function loadAssistantMessagesInfo(root: string, id: string): AssistantMessageHistory {
  const file = assistantMessagePath(root, id);
  assertInside(root, file);
  let text: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HISTORY_BYTES) return invalidAssistantHistory();
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { available: false, messages: [], reason: "missing" };
    return invalidAssistantHistory();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalidAssistantHistory();
  }
  if (!raw || typeof raw !== "object") return invalidAssistantHistory();
  const record = raw as Record<string, unknown>;
  if (record.version !== FORMAT_VERSION || !Array.isArray(record.messages) || !record.messages.every(isAssistantMessage)) return invalidAssistantHistory();
  return { available: true, messages: record.messages as AssistantMessage[], reason: null };
}

function encodedAssistantHistory(messages: AssistantMessage[]): string {
  if (messages.length > MAX_MESSAGES) throw new Error(`assistant message history limit exceeded (${MAX_MESSAGES} messages)`);
  const text = JSON.stringify({ version: FORMAT_VERSION, messages }, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_HISTORY_BYTES) throw new Error(`assistant message history limit exceeded (${MAX_HISTORY_BYTES} bytes)`);
  return text;
}

/** Persist one terminal assistant reply. Same-generation retries are idempotent. */
export function appendAssistantMessageOrThrow(root: string, id: string, msg: AssistantMessage): AssistantMessageHistory {
  if (!isAssistantMessage(msg)) throw new Error("invalid assistant message");
  const previous = loadAssistantMessagesInfo(root, id);
  if (previous.reason === "invalid") throw new Error("assistant message history is unreadable; refusing to overwrite it");
  const messages = previous.messages.slice();
  const existing = messages.find((item) => item.generation === msg.generation);
  if (existing) {
    if (existing.text === msg.text) return previous;
    throw new Error("assistant message generation already has a different persisted reply");
  }
  messages.push(msg);
  messages.sort((a, b) => a.generation - b.generation);
  const file = assistantMessagePath(root, id);
  assertInside(root, file);
  atomicWriteFile(file, encodedAssistantHistory(messages));
  return { available: true, messages, reason: null };
}
