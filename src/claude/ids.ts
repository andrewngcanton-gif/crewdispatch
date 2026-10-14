// ids.ts — the pure identifier vocabulary of the local Claude caller binding.
//
// These validators are deliberately dependency-free (node builtins only) so the
// shared job store (persisted-target normalization) and the Claude binding store
// use the SAME rules without a module cycle. They validate SHAPE only: a Claude
// session id is an opaque UUID-like token and a binding id is a hex token this
// product generates. Neither is a secret — the per-session authentication token
// and the native inbox address are stored separately (src/claude/binding.ts)
// and are NEVER accepted through these public identifiers.
import crypto from "node:crypto";

/**
 * A Claude session identity: an opaque UUID-like token. Rejects empty,
 * whitespace-padded, path-like and shell-metacharacter values, so an invalid
 * explicit value is refused visibly instead of being resolved as a path.
 */
const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidClaudeSessionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  if (value.includes("..")) return false;
  return CLAUDE_SESSION_ID_RE.test(value);
}

/**
 * A registered binding reference: the opaque token the SessionStart hook emits
 * (hex). It is never an address, a token, a path or a caller-selected socket.
 */
const CLAUDE_BINDING_ID_RE = /^[a-f0-9]{16,64}$/;

export function isValidClaudeBindingId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return CLAUDE_BINDING_ID_RE.test(value);
}

/** A random opaque binding reference (32 hex chars). */
export function newClaudeBindingId(): string {
  return crypto.randomBytes(16).toString("hex");
}
