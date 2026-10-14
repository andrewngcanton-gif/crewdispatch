// binding.ts — the narrowly scoped PRIVATE local store of Claude session inbox
// bindings, owned by CrewDispatch's data root.
//
// One binding is the exact, currently-registered native inbox of ONE Claude
// session: the session's opaque id, the native inbox address (a Windows named
// pipe or a Unix socket) and the session's own per-session authentication
// token. A SessionStart hook writes it; the notification transport reads it
// when a terminal/approval event is actually ready.
//
// Privacy and safety rules:
//   * the native token and address NEVER enter a job record, an MCP argument or
//     result, a prompt, the UI or a log — only this private file carries them;
//   * the file is created with the strongest permission restriction the actual
//     OS supports: POSIX mode 0600, or on Windows an explicit ACL restricted to
//     the current user (with an honest weaker fallback ONLY when the file
//     provably lives inside the user's own profile and the ACL tool is
//     unavailable — never a pretense that chmod secures Windows);
//   * reads reject symlinks, path traversal, oversized/malformed records and
//     invalid identifiers; a broken binding reads as "absent" and delivery then
//     fails closed instead of guessing another session;
//   * the managed subtree (root/claude, root/claude/bindings) is validated for
//     symlink/junction (reparse) traversal BEFORE any mkdir/ACL/write/read/
//     delete, so a redirected directory can never leak the token outside the
//     data root or have an external target chmod-ed/ACL-ed through it;
//   * cleanup removes ONLY a managed binding file and only when the exact
//     incarnation matches: session id + inbox address + the ending hook's OWN
//     session token (compared securely, never logged). An address alone is NOT
//     sufficient evidence — a resumed session may reuse the same native
//     address with a new token — so a stale SessionEnd can never delete the
//     newer registration;
//   * ADDITIVE owner-exit cleanup: when a binding records an optional, verified
//     caller-owner lifetime proof (pid + creation instant) and a bounded OS scan
//     proves that exact incarnation gone, the maintenance pass may remove ONLY
//     that exact binding id after re-verifying session/address/token AND the
//     owner metadata on a fresh read. A record without owner proof, an unknown
//     scan, an alive owner or a concurrent newer registration is preserved;
//     deletion is never by TTL, age, session id alone, socket reuse, name or a
//     guessed pid;
//   * no credential, API key or model-provider secret is ever stored here.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, assertInside } from "../jobs/store";
import { isValidClaudeBindingId, isValidClaudeSessionId, newClaudeBindingId } from "./ids";

/** Hard bounds so a malformed/hostile binding can never become a large record. */
const BINDING_FILE_MAX_BYTES = 16 * 1024;
const SOCKET_MAX_CHARS = 1024;
const TOKEN_MAX_CHARS = 4096;

export class ClaudeBindingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeBindingError";
    this.code = code;
  }
}

/** How the binding file's privacy was actually established. */
export type ClaudeBindingPrivacy = "posix_0600" | "windows_acl_user" | "windows_user_profile_inherited";

/**
 * Optional, best-effort proof of the STABLE caller process lifetime that owns a
 * binding (the native Claude host process, not the transient hook/CLI child).
 *
 * It exists so a binding can be cleaned up when the recorded owner has provably
 * exited even though the host's SessionEnd carried no socket/token exports. It
 * is deliberately minimal: an actual OS pid + its creation instant (the two
 * facts that distinguish one process incarnation from a reused pid), the image
 * name as an ancestry hint, the platform and a proof-version tag. It NEVER
 * carries a command line, an environment value, a token or an address, and it
 * is not evidence of liveness on its own — a missing/unknown scan preserves the
 * binding.
 */
export interface ClaudeOwnerRef {
  /** Host platform the identity was captured on (e.g. "win32"). */
  platform: string;
  /** The actual OS pid of the stable owner process. */
  pid: number;
  /** The owner process creation instant, epoch ms (portable/legacy identity). */
  createdAtMs: number;
  /** Exact epoch-microsecond birth when the OS can prove it (Darwin arm64). */
  createdAtUs?: number | null;
  /** Best-effort image/executable name of the owner (ancestry hint only). */
  imageName: string;
  /** Capture-proof schema version (future-proofing for the owner shape). */
  proof: number;
}

export interface ClaudeBinding {
  /** Opaque registered binding reference (the file name, hex). */
  bindingId: string;
  /** The Claude session this inbox belongs to (opaque UUID-like token). */
  sessionId: string;
  /** The native inbox address (named pipe path / Unix socket path). */
  socket: string;
  /** The session's per-session authentication token. NEVER logged or persisted elsewhere. */
  token: string;
  /** Exact-incarnation evidence for cleanup (the address it was registered with). */
  incarnation: string;
  createdAt: string;
  updatedAt: string;
  /** Which OS restriction was actually applied to the binding file. */
  privacy: ClaudeBindingPrivacy;
  /**
   * Optional best-effort caller-owner lifetime proof (see ClaudeOwnerRef). A
   * record without it retains the EXACT-identity SessionEnd cleanup only.
   */
  owner?: ClaudeOwnerRef | null;
}

export interface RegisterClaudeBindingInput {
  sessionId: unknown;
  socket: unknown;
  token: unknown;
  /**
   * Optional, already-validated owner identity injected by the async CLI
   * orchestration (never read from the hook env). Absent/null keeps the record
   * owner-less and the existing behavior.
   */
  owner?: ClaudeOwnerRef | null;
  now?: () => Date;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** The binding directory under the CrewDispatch data root (never another product's dir). */
export function claudeBindingDir(root: string): string {
  return path.join(root, "claude", "bindings");
}

export function claudeBindingPath(root: string, bindingId: string): string {
  if (!isValidClaudeBindingId(bindingId)) {
    throw new ClaudeBindingError("bad_binding_id", "invalid Claude binding id");
  }
  const file = path.join(claudeBindingDir(root), `${bindingId}.json`);
  assertInside(root, file);
  return file;
}

/** A native inbox address: non-empty, bounded, single-line, no NUL. */
export function isValidClaudeSocket(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s || s !== value) return false;
  if (s.length > SOCKET_MAX_CHARS) return false;
  return !/[\u0000\r\n]/.test(s);
}

/** A per-session token: non-empty, bounded, single-line, no NUL. */
export function isValidClaudeToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value) return false;
  if (value.length > TOKEN_MAX_CHARS) return false;
  return !/[\u0000\r\n]/.test(value);
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Managed-subtree containment: the token may only ever live under
// <root>/claude/bindings reached through REAL directories. A symlink or a
// Windows directory junction (both are reparse points) on any component we
// manage redirects mkdir/ACL/write/read/delete outside the data root, so every
// operation validates the subtree FIRST. The data root itself is the caller's
// chosen location and may legitimately be reached through a junction — only
// the components this module creates and owns are validated.
// ---------------------------------------------------------------------------

/** The managed components under the data root, parent first. */
function managedBindingDirs(root: string): string[] {
  return [path.join(root, "claude"), claudeBindingDir(root)];
}

/**
 * True when every EXISTING managed component is a real directory (not a
 * symlink/junction) and nothing unexpected occupies the path. Absent
 * components are fine (they will be created as real directories).
 */
function bindingSubtreeIsSafe(root: string): boolean {
  for (const dir of managedBindingDirs(root)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue; // absent: safe to create/read as empty
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/** Throw when a managed component exists as a symlink/junction or a non-directory. */
function assertBindingSubtreeSafe(root: string): void {
  for (const dir of managedBindingDirs(root)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue; // absent: safe to create
    }
    if (stat.isSymbolicLink()) {
      throw new ClaudeBindingError(
        "unsafe_binding_path",
        "The Claude binding directory is a symlink or junction; refusing to write the binding store through it."
      );
    }
    if (!stat.isDirectory()) {
      throw new ClaudeBindingError("unsafe_binding_path", "The Claude binding path exists and is not a directory.");
    }
  }
}

/** Constant-time comparison of two session tokens (never logged, length-safe). */
function tokenEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** True when `file` provably lives inside the current user's own profile. */
function insideUserProfile(file: string, env: NodeJS.ProcessEnv): boolean {
  const candidates = [env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA, os.homedir()].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );
  return candidates.some((dir) => isWithin(dir, file));
}

/**
 * Apply the strongest permission restriction the actual OS supports to one
 * path (a directory or a file).
 *
 * POSIX: chmod 0600 (files) / 0700 (directories) and verify the mode.
 * Windows: an explicit `icacls` ACL that removes inherited entries and grants
 * only the current user. When `icacls` is unavailable AND the path provably
 * lives inside the current user's own profile directory, the inherited
 * per-user profile ACL is reported honestly as the weaker
 * `windows_user_profile_inherited` scope; anywhere else the operation FAILS so
 * a token is never silently stored with unknown access.
 */
export function restrictLocalPath(
  target: string,
  kind: "file" | "dir",
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): { ok: true; privacy: ClaudeBindingPrivacy } | { ok: false; reason: string } {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== "win32") {
    try {
      fs.chmodSync(target, kind === "dir" ? 0o700 : 0o600);
      const mode = fs.statSync(target).mode & 0o777;
      const expected = kind === "dir" ? 0o700 : 0o600;
      if (mode !== expected) return { ok: false, reason: `chmod verification failed (mode ${mode.toString(8)})` };
      return { ok: true, privacy: "posix_0600" };
    } catch (e) {
      return { ok: false, reason: `chmod failed: ${String((e as Error)?.message || e)}` };
    }
  }
  const user = (env.USERNAME || "").trim() || safeUsername();
  if (user) {
    const result = spawnSync(
      "icacls",
      [target, "/inheritance:r", "/grant:r", `${user}:F`],
      { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }
    );
    if (!result.error && result.status === 0) return { ok: true, privacy: "windows_acl_user" };
  }
  // icacls unavailable/failed: accept ONLY the inherited per-user profile ACL,
  // and only when the path provably lives inside that profile.
  if (insideUserProfile(target, env)) return { ok: true, privacy: "windows_user_profile_inherited" };
  return { ok: false, reason: "could not restrict access to the current user on this Windows path" };
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** A usable owner identity: pid + creation instant + a bounded platform/name. */
export function isValidClaudeOwnerRef(value: unknown): value is ClaudeOwnerRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.platform !== "string" || !r.platform || r.platform.length > 32) return false;
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) return false;
  if (typeof r.createdAtMs !== "number" || !Number.isFinite(r.createdAtMs) || r.createdAtMs <= 0) return false;
  if (r.createdAtUs != null) {
    if (typeof r.createdAtUs !== "number" || !Number.isSafeInteger(r.createdAtUs) || r.createdAtUs <= 0) return false;
    if (Math.floor(r.createdAtUs / 1000) !== Math.floor(r.createdAtMs)) return false;
  }
  if (typeof r.imageName !== "string" || r.imageName.length > 260) return false;
  if (typeof r.proof !== "number" || !Number.isInteger(r.proof) || r.proof < 0) return false;
  return true;
}

/** Normalize an optional owner field: an unusable value reads as absent. */
function normalizeOwnerRef(raw: unknown): ClaudeOwnerRef | null {
  return isValidClaudeOwnerRef(raw) ? { ...raw } : null;
}

function normalizeStoredBinding(raw: unknown): ClaudeBinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const bindingId = r.bindingId;
  const sessionId = r.sessionId;
  const socket = r.socket;
  const token = r.token;
  const incarnation = typeof r.incarnation === "string" && r.incarnation ? r.incarnation : socket;
  if (!isValidClaudeBindingId(bindingId)) return null;
  if (!isValidClaudeSessionId(sessionId)) return null;
  if (!isValidClaudeSocket(socket)) return null;
  if (!isValidClaudeToken(token)) return null;
  if (!isValidClaudeSocket(incarnation)) return null;
  const privacy: ClaudeBindingPrivacy =
    r.privacy === "posix_0600" || r.privacy === "windows_acl_user" || r.privacy === "windows_user_profile_inherited"
      ? r.privacy
      : "windows_user_profile_inherited";
  const createdAt = typeof r.createdAt === "string" && r.createdAt ? r.createdAt : new Date(0).toISOString();
  const updatedAt = typeof r.updatedAt === "string" && r.updatedAt ? r.updatedAt : createdAt;
  return { bindingId, sessionId, socket, token, incarnation, createdAt, updatedAt, privacy, owner: normalizeOwnerRef(r.owner) };
}

/**
 * Register (or refresh) the binding of one session. The write is atomic and
 * permission-restricted; a previous registration of the SAME session is removed
 * afterwards, but only when it is strictly OLDER (updatedAt, then bindingId) —
 * so a late registration from an old incarnation can never delete a newer
 * binding, and the newest registration always wins on lookup.
 *
 * Never returns the token in an error message. Throws `ClaudeBindingError`
 * with a stable code when the inputs or the OS restriction are unusable.
 */
export function registerClaudeBinding(root: string, input: RegisterClaudeBindingInput): ClaudeBinding {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (!isValidClaudeSessionId(input.sessionId)) {
    throw new ClaudeBindingError("invalid_session_id", "The Claude session id is missing or malformed; nothing was registered.");
  }
  if (!isValidClaudeSocket(input.socket)) {
    throw new ClaudeBindingError("invalid_inbox_address", "The Claude inbox address is missing or malformed; nothing was registered.");
  }
  if (!isValidClaudeToken(input.token)) {
    throw new ClaudeBindingError("invalid_inbox_token", "The Claude inbox token is missing or malformed; nothing was registered.");
  }
  const now = input.now ?? (() => new Date());
  const at = now().toISOString();
  const bindingId = newClaudeBindingId();
  const dir = claudeBindingDir(root);
  // Validate the managed subtree BEFORE mkdir/ACL/write: a symlinked or
  // junctioned component must never be followed (it would leak the token
  // outside the data root and ACL an external target).
  assertBindingSubtreeSafe(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertBindingSubtreeSafe(root);
  const dirPrivacy = restrictLocalPath(dir, "dir", { platform, env });
  if (!dirPrivacy.ok) {
    throw new ClaudeBindingError("privacy_unavailable", `Could not restrict the binding directory to the current user (${dirPrivacy.reason}).`);
  }
  const file = claudeBindingPath(root, bindingId);
  const owner = normalizeOwnerRef(input.owner);
  const record: ClaudeBinding = {
    bindingId,
    sessionId: input.sessionId,
    socket: input.socket,
    token: input.token,
    incarnation: input.socket,
    createdAt: at,
    updatedAt: at,
    privacy: dirPrivacy.privacy,
    owner
  };
  atomicWriteFile(file, JSON.stringify(record));
  const filePrivacy = restrictLocalPath(file, "file", { platform, env });
  if (!filePrivacy.ok) {
    // Fail closed: never keep a token in a file whose access could not be
    // restricted for this OS.
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
    throw new ClaudeBindingError("privacy_unavailable", `Could not restrict the binding file to the current user (${filePrivacy.reason}).`);
  }
  record.privacy = filePrivacy.privacy;
  atomicWriteFile(file, JSON.stringify(record));
  // The atomic write REPLACES the file with a fresh instance, which re-inherits
  // the binding directory's ACL. Re-apply the restriction to the final instance
  // so a stored token can never sit behind an inherited (e.g. directory-level)
  // grant — the recorded privacy is already inside the file.
  const finalPrivacy = restrictLocalPath(file, "file", { platform, env });
  if (!finalPrivacy.ok) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
    throw new ClaudeBindingError("privacy_unavailable", `Could not restrict the binding file to the current user (${finalPrivacy.reason}).`);
  }

  // Replace any previous registration of the same session. A resumed session
  // registers a NEW binding (its native address MAY be the same as the old
  // one, so the address is not what distinguishes the incarnations). Only
  // files that parse as valid managed bindings are ever removed, and only
  // registrations strictly OLDER than ours: a late `SessionStart` from an
  // older incarnation can therefore never delete the newer binding, while
  // concurrent registrations still converge to exactly one (the max by
  // updatedAt, then bindingId).
  for (const existing of listClaudeBindings(root)) {
    if (existing.bindingId === bindingId || existing.sessionId !== record.sessionId) continue;
    const older =
      existing.updatedAt < record.updatedAt ||
      (existing.updatedAt === record.updatedAt && existing.bindingId < record.bindingId);
    if (older) removeClaudeBindingFile(root, existing.bindingId);
  }
  return record;
}

/** Read ONE binding by its opaque file id. Symlinks/oversized/malformed records read as null. */
export function readClaudeBindingFile(root: string, bindingId: string): ClaudeBinding | null {
  if (!isValidClaudeBindingId(bindingId)) return null;
  // A redirected managed subtree reads as "no binding": the transport then
  // fails closed instead of following the redirect.
  if (!bindingSubtreeIsSafe(root)) return null;
  let file: string;
  try {
    file = claudeBindingPath(root, bindingId);
  } catch {
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BINDING_FILE_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const record = normalizeStoredBinding(parsed);
    if (!record || record.bindingId !== bindingId) return null;
    return record;
  } catch {
    return null;
  }
}

/** Every readable managed binding, newest first. */
export function listClaudeBindings(root: string): ClaudeBinding[] {
  if (!bindingSubtreeIsSafe(root)) return [];
  const dir = claudeBindingDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: ClaudeBinding[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const record = readClaudeBindingFile(root, id);
    if (record) out.push(record);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.bindingId.localeCompare(b.bindingId)));
  return out;
}

/**
 * Resolve the binding a persisted target names. A binding id wins when given;
 * otherwise the NEWEST registration of that session id is used. Returns null
 * when nothing matches — the caller then fails closed with a truthful
 * diagnostic instead of guessing another session.
 *
 * When BOTH references are present they must identify the SAME registration:
 * a binding id belonging to another session than the supplied session id is a
 * conflicting pair and resolves to null — the resolver never falls back to
 * "some other binding of that session" behind a conflicting direct reference.
 */
export function resolveClaudeBinding(root: string, ref: { bindingId?: unknown; sessionId?: unknown }): ClaudeBinding | null {
  const hasBindingId = isValidClaudeBindingId(ref.bindingId);
  const hasSessionId = isValidClaudeSessionId(ref.sessionId);
  if (hasBindingId) {
    const direct = readClaudeBindingFile(root, ref.bindingId as string);
    if (direct) {
      if (hasSessionId && direct.sessionId !== ref.sessionId) return null;
      return direct;
    }
    // A binding id that no longer exists is a stale/replaced registration: fall
    // through ONLY when the target also names the session it was bound to.
    if (!hasSessionId) return null;
  }
  if (hasSessionId) {
    const matches = listClaudeBindings(root).filter((b) => b.sessionId === ref.sessionId);
    return matches.length > 0 ? matches[0]! : null;
  }
  return null;
}

/** Remove one managed binding file by id. Only the binding dir is ever touched. */
export function removeClaudeBindingFile(root: string, bindingId: string): boolean {
  let file: string;
  try {
    file = claudeBindingPath(root, bindingId);
  } catch {
    return false;
  }
  const record = readClaudeBindingFile(root, bindingId);
  if (!record) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove one managed binding file ONLY when, at removal time, it still matches
 * the full expected incarnation. The binding file name is the registration's
 * immutable identity (a replacement registration is always written under a NEW
 * binding id), so re-verifying session + address + token on a fresh read
 * immediately before unlinking means cleanup can never unlink a replacement
 * that raced in between listing and removal.
 */
function removeClaudeBindingExact(
  root: string,
  bindingId: string,
  expected: { sessionId: string; socket: string; token: string }
): boolean {
  const record = readClaudeBindingFile(root, bindingId);
  if (!record) return false;
  if (record.sessionId !== expected.sessionId) return false;
  if (record.socket !== expected.socket && record.incarnation !== expected.socket) return false;
  if (!tokenEquals(record.token, expected.token)) return false;
  let file: string;
  try {
    file = claudeBindingPath(root, bindingId);
  } catch {
    return false;
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * SessionEnd cleanup with EXACT incarnation matching. A binding is removed only
 * when the ending hook proves ALL of: the same session id, its own inbox
 * address AND its own session token (compared securely, never logged). The
 * address alone is NOT sufficient evidence — a resumed/restarted session can
 * be given the SAME native address with a NEW token, and deleting that newer
 * registration would silently kill the live wake path. Missing required
 * evidence (session id, address or token) removes NOTHING: a stale binding is
 * safe because delivery fails closed against a dead inbox; a wrong deletion is
 * not.
 */
export function removeClaudeBindingForIncarnation(
  root: string,
  ref: { sessionId: unknown; socket: unknown; token: unknown }
): { removed: boolean; reason: string } {
  if (!isValidClaudeSessionId(ref.sessionId)) return { removed: false, reason: "invalid_session_id" };
  if (!isValidClaudeSocket(ref.socket)) return { removed: false, reason: "no_incarnation_address" };
  if (!isValidClaudeToken(ref.token)) return { removed: false, reason: "no_incarnation_token" };
  const matches = listClaudeBindings(root).filter((b) => b.sessionId === ref.sessionId);
  let removed = false;
  for (const binding of matches) {
    if (binding.socket !== ref.socket && binding.incarnation !== ref.socket) continue;
    if (!tokenEquals(binding.token, ref.token)) continue;
    if (removeClaudeBindingExact(root, binding.bindingId, { sessionId: ref.sessionId, socket: ref.socket, token: ref.token })) {
      removed = true;
    }
  }
  return removed ? { removed: true, reason: "removed" } : { removed: false, reason: matches.length ? "incarnation_mismatch" : "not_found" };
}

/** Exact equality of two owner identities (every recorded fact must match). */
export function ownerRefEquals(a: ClaudeOwnerRef | null | undefined, b: ClaudeOwnerRef | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.platform === b.platform &&
    a.pid === b.pid &&
    a.createdAtMs === b.createdAtMs &&
    (a.createdAtUs ?? null) === (b.createdAtUs ?? null) &&
    a.imageName === b.imageName &&
    a.proof === b.proof
  );
}

/**
 * Cleanup for a PROVEN owner exit. The caller (the bounded maintenance pass) has
 * already established, in ONE coherent OS snapshot, that the recorded owner
 * incarnation is gone — its PID is absent, or the same PID now has a positively
 * different creation instant (reuse). This function only re-verifies, on a
 * fresh read immediately before unlinking, that the binding file is STILL the
 * exact registration the caller inspected: same opaque binding id, same
 * session/address/token AND the same owner metadata. A concurrent same-session
 * re-registration (always a NEW binding id) or a replacement therefore survives.
 * It never guesses: any mismatch or unreadable record removes nothing.
 */
export function removeClaudeBindingForOwnerExit(
  root: string,
  bindingId: string,
  expected: { sessionId: unknown; socket: unknown; token: unknown; owner: ClaudeOwnerRef | null | undefined }
): boolean {
  if (!isValidClaudeBindingId(bindingId)) return false;
  if (!isValidClaudeSessionId(expected.sessionId)) return false;
  if (!isValidClaudeSocket(expected.socket)) return false;
  if (!isValidClaudeToken(expected.token)) return false;
  const record = readClaudeBindingFile(root, bindingId);
  if (!record) return false;
  if (record.sessionId !== expected.sessionId) return false;
  if (record.socket !== expected.socket && record.incarnation !== expected.socket) return false;
  if (!tokenEquals(record.token, expected.token)) return false;
  if (!ownerRefEquals(record.owner, expected.owner)) return false;
  let file: string;
  try {
    file = claudeBindingPath(root, bindingId);
  } catch {
    return false;
  }
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}
