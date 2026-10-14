// claude-binding.test.ts — unit coverage of the PRIVATE Claude session binding
// store: identifier vocabulary, registration/replacement, exact-incarnation
// cleanup, privacy reporting, malformed/hostile input rejection and the
// fail-closed lookup. No real Claude host and no network are involved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeBindingDir,
  claudeBindingPath,
  ClaudeBindingError,
  isValidClaudeSocket,
  isValidClaudeToken,
  listClaudeBindings,
  readClaudeBindingFile,
  registerClaudeBinding,
  removeClaudeBindingFile,
  removeClaudeBindingForIncarnation,
  resolveClaudeBinding,
  restrictLocalPath
} from "../../claude/binding";
import { isValidClaudeBindingId, isValidClaudeSessionId, newClaudeBindingId } from "../../claude/ids";

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "99999999-8888-4777-8666-555555555555";
const SOCKET_A = process.platform === "win32" ? "\\\\.\\pipe\\claude-inbox-a" : "/tmp/claude-inbox-a.sock";
const SOCKET_B = process.platform === "win32" ? "\\\\.\\pipe\\claude-inbox-b" : "/tmp/claude-inbox-b.sock";
const TOKEN = "session-token-marker-0123456789";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-bind-"));
}

function register(root: string, sessionId: string, socket: string, at: string, token = TOKEN) {
  return registerClaudeBinding(root, { sessionId, socket, token, now: () => new Date(at) });
}

test("claude session ids are opaque UUID-like tokens; binding ids are lowercase hex", () => {
  assert.equal(isValidClaudeSessionId(SESSION_A), true);
  assert.equal(isValidClaudeSessionId("abc.DEF_123-456"), true);
  assert.equal(isValidClaudeSessionId(""), false);
  assert.equal(isValidClaudeSessionId(" padded"), false);
  assert.equal(isValidClaudeSessionId("padded "), false);
  assert.equal(isValidClaudeSessionId("a b"), false);
  assert.equal(isValidClaudeSessionId("a/b"), false);
  assert.equal(isValidClaudeSessionId("..\\evil"), false);
  assert.equal(isValidClaudeSessionId("a..b"), false);
  assert.equal(isValidClaudeSessionId("a".repeat(129)), false);
  assert.equal(isValidClaudeSessionId(42), false);

  assert.equal(isValidClaudeBindingId(newClaudeBindingId()), true);
  assert.equal(isValidClaudeBindingId("abcdef0123456789"), true);
  assert.equal(isValidClaudeBindingId("ABCDEF0123456789"), false, "uppercase hex is not the emitted vocabulary");
  assert.equal(isValidClaudeBindingId("abcdef"), false);
  assert.equal(isValidClaudeBindingId("abcdef0123456789".repeat(5)), false);
  assert.equal(isValidClaudeBindingId("\\\\.\\pipe\\x"), false);

  // The socket/token validators accept real inbox values and reject framing breaks.
  assert.equal(isValidClaudeSocket(SOCKET_A), true);
  assert.equal(isValidClaudeSocket(""), false);
  assert.equal(isValidClaudeSocket("a\nb"), false);
  assert.equal(isValidClaudeSocket("x".repeat(1025)), false);
  assert.equal(isValidClaudeToken(TOKEN), true);
  assert.equal(isValidClaudeToken(""), false);
  assert.equal(isValidClaudeToken("a\nb"), false);
});

test("a registered binding resolves by binding id and by session id", () => {
  const root = tmpRoot();
  try {
    const record = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");
    assert.equal(record.sessionId, SESSION_A);
    assert.equal(record.socket, SOCKET_A);
    assert.equal(record.incarnation, SOCKET_A);
    assert.equal(path.dirname(claudeBindingPath(root, record.bindingId)), claudeBindingDir(root));

    const byId = resolveClaudeBinding(root, { bindingId: record.bindingId });
    assert.equal(byId?.bindingId, record.bindingId);
    const bySession = resolveClaudeBinding(root, { sessionId: SESSION_A });
    assert.equal(bySession?.bindingId, record.bindingId);
    assert.equal(bySession?.token, TOKEN, "the transport must be able to read the session token from the private store");

    // When BOTH references are present they must identify the SAME
    // registration: a matching pair resolves directly, a conflicting pair
    // fails closed instead of silently resolving the directly named binding.
    const other = register(root, SESSION_B, SOCKET_B, "2026-10-01T00:00:01.000Z");
    assert.equal(resolveClaudeBinding(root, { bindingId: other.bindingId, sessionId: SESSION_B })?.bindingId, other.bindingId);
    assert.equal(
      resolveClaudeBinding(root, { bindingId: other.bindingId, sessionId: SESSION_A }),
      null,
      "a binding id plus a DIFFERENT session id must never resolve"
    );
    assert.equal(resolveClaudeBinding(root, { bindingId: record.bindingId, sessionId: SESSION_A })?.bindingId, record.bindingId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the binding file's privacy is restricted for the actual OS and reported honestly", () => {
  const root = tmpRoot();
  try {
    const record = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");
    const file = claudeBindingPath(root, record.bindingId);
    if (process.platform === "win32") {
      assert.ok(
        record.privacy === "windows_acl_user" || record.privacy === "windows_user_profile_inherited",
        `unexpected Windows privacy scope: ${record.privacy}`
      );
      // No pretense that chmod secures Windows: the record says which Windows
      // mechanism was actually used, never `posix_0600`.
      assert.notEqual(record.privacy, "posix_0600");
    } else {
      assert.equal(record.privacy, "posix_0600");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(claudeBindingDir(root)).mode & 0o777, 0o700);
    }
    assert.equal(fs.existsSync(file), true);

    // Direct Windows fallback verification requires actual Windows ACL/profile
    // semantics; do not emulate icacls/profile ownership from a POSIX host.
    if (process.platform === "win32") {
      const result = restrictLocalPath(file, "file", { platform: "win32", env: { USERNAME: "" } as NodeJS.ProcessEnv });
      assert.equal(result.ok, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration rejects malformed inputs with stable codes and never leaks the token", () => {
  const root = tmpRoot();
  try {
    const bad = [
      () => registerClaudeBinding(root, { sessionId: "../evil", socket: SOCKET_A, token: TOKEN }),
      () => registerClaudeBinding(root, { sessionId: SESSION_A, socket: "bad\nsocket", token: TOKEN }),
      () => registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: "" })
    ];
    const codes = ["invalid_session_id", "invalid_inbox_address", "invalid_inbox_token"];
    bad.forEach((fn, i) => {
      assert.throws(fn, (e: unknown) => {
        assert.ok(e instanceof ClaudeBindingError);
        assert.equal(e.code, codes[i]);
        assert.equal(e.message.includes(TOKEN), false, "an error message must never carry the token");
        return true;
      });
    });
    assert.equal(listClaudeBindings(root).length, 0, "a rejected registration writes nothing");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("lookups fail closed for wrong identities and malformed/hostile records", (t) => {
  const root = tmpRoot();
  try {
    const record = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");

    // Wrong identity: a different valid session id and a random valid binding id.
    assert.equal(resolveClaudeBinding(root, { sessionId: SESSION_B }), null);
    assert.equal(resolveClaudeBinding(root, { bindingId: newClaudeBindingId() }), null);
    // A socket/token-shaped value is not a binding reference and resolves to nothing.
    assert.equal(resolveClaudeBinding(root, { sessionId: SOCKET_A }), null);
    assert.equal(resolveClaudeBinding(root, { bindingId: "not-a-binding" }), null);
    // Path traversal through the id vocabulary is refused, not resolved.
    assert.throws(() => claudeBindingPath(root, "../escape"), (e: unknown) => e instanceof ClaudeBindingError && e.code === "bad_binding_id");
    assert.equal(readClaudeBindingFile(root, "../escape"), null);

    // Malformed JSON at a valid file name reads as absent.
    const malformedId = newClaudeBindingId();
    fs.writeFileSync(claudeBindingPath(root, malformedId), "{not json");
    assert.equal(readClaudeBindingFile(root, malformedId), null);

    // An oversized record is refused before parsing.
    const oversizedId = newClaudeBindingId();
    fs.writeFileSync(claudeBindingPath(root, oversizedId), "x".repeat(20 * 1024));
    assert.equal(readClaudeBindingFile(root, oversizedId), null);

    // A record whose stored bindingId does not match its file name is ignored.
    const mismatchedId = newClaudeBindingId();
    fs.writeFileSync(
      claudeBindingPath(root, mismatchedId),
      JSON.stringify({ ...record, bindingId: newClaudeBindingId() })
    );
    assert.equal(readClaudeBindingFile(root, mismatchedId), null);

    // A symlinked record is refused. Creating symlinks may require privileges
    // on Windows; when the OS refuses, this assertion is honestly skipped.
    const linkId = newClaudeBindingId();
    const link = claudeBindingPath(root, linkId);
    try {
      fs.symlinkSync(claudeBindingPath(root, record.bindingId), link, "file");
    } catch {
      t.diagnostic("symlink creation refused by the OS; symlink rejection not exercised");
      assert.equal(readClaudeBindingFile(root, linkId), null);
    }
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) {
      assert.equal(readClaudeBindingFile(root, linkId), null, "a symlinked binding must never be read");
    }

    // list only ever returns readable managed records.
    const listed = listClaudeBindings(root);
    assert.deepEqual(listed.map((b) => b.bindingId), [record.bindingId]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("re-registering a session replaces the older binding and resolve picks the newest", () => {
  const root = tmpRoot();
  try {
    const first = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");
    const second = register(root, SESSION_A, SOCKET_B, "2026-10-01T00:00:10.000Z");
    assert.notEqual(first.bindingId, second.bindingId);
    assert.equal(readClaudeBindingFile(root, first.bindingId), null, "the older registration is removed");
    assert.equal(readClaudeBindingFile(root, second.bindingId)?.socket, SOCKET_B);

    const resolved = resolveClaudeBinding(root, { sessionId: SESSION_A });
    assert.equal(resolved?.bindingId, second.bindingId);
    assert.equal(listClaudeBindings(root).length, 1);

    // A late registration from an OLDER incarnation must never delete the newer
    // binding (its updatedAt is older, so the replace rule leaves the newer one).
    const lateOld = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:05.000Z");
    assert.equal(readClaudeBindingFile(root, second.bindingId)?.socket, SOCKET_B, "the newer binding survives a late older registration");
    assert.equal(resolveClaudeBinding(root, { sessionId: SESSION_A })?.bindingId, second.bindingId, "the newest binding still wins");
    assert.equal(readClaudeBindingFile(root, lateOld.bindingId)?.socket, SOCKET_A);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionEnd cleanup removes only the exact incarnation and never a resumed binding", () => {
  const root = tmpRoot();
  try {
    const first = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");
    const resumed = register(root, SESSION_A, SOCKET_B, "2026-10-01T00:00:10.000Z");
    assert.equal(readClaudeBindingFile(root, first.bindingId), null);

    // A late SessionEnd of the OLD incarnation cannot delete the resumed binding.
    const stale = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN });
    assert.equal(stale.removed, false);
    assert.equal(stale.reason, "incarnation_mismatch");
    assert.equal(readClaudeBindingFile(root, resumed.bindingId)?.socket, SOCKET_B);

    // Without a provable address nothing is removed at all.
    const noAddress = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: "", token: TOKEN });
    assert.equal(noAddress.removed, false);
    assert.equal(noAddress.reason, "no_incarnation_address");
    assert.equal(listClaudeBindings(root).length, 1);

    // Without the hook's OWN token nothing is removed either: the address
    // alone is not incarnation evidence.
    const noToken = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_B, token: "" });
    assert.equal(noToken.removed, false);
    assert.equal(noToken.reason, "no_incarnation_token");
    assert.equal(listClaudeBindings(root).length, 1);

    // The matching incarnation is removed.
    const exact = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_B, token: TOKEN });
    assert.equal(exact.removed, true);
    assert.equal(listClaudeBindings(root).length, 0);

    // Nothing to remove is a truthful reason, not a fabricated success.
    assert.deepEqual(removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_B, token: TOKEN }), {
      removed: false,
      reason: "not_found"
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reused native address with a NEW token preserves the newer binding (old SessionEnd is inert)", () => {
  const root = tmpRoot();
  try {
    // The host reused the SAME named-pipe address across a resume/restart; only
    // the per-session token changed. The address is NOT evidence of incarnation.
    const oldToken = "old-incarnation-token-1111";
    const newToken = "new-incarnation-token-2222";
    register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z", oldToken);
    const newer = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:01.000Z", newToken);

    // The late SessionEnd of the OLD incarnation carries the old token.
    const stale = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: oldToken });
    assert.equal(stale.removed, false);
    assert.equal(stale.reason, "incarnation_mismatch");
    assert.equal(readClaudeBindingFile(root, newer.bindingId)?.token, newToken, "the newer binding must survive the stale end");

    // A wrong token of any shape is inert too — comparison is exact.
    const wrong = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: `${newToken}x` });
    assert.equal(wrong.removed, false);
    assert.equal(readClaudeBindingFile(root, newer.bindingId)?.token, newToken);

    // Only the ending hook's OWN token removes its own registration.
    const exact = removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: newToken });
    assert.equal(exact.removed, true);
    assert.equal(listClaudeBindings(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a delayed old SessionEnd racing a new SessionStart cannot unlink the replacement", () => {
  const root = tmpRoot();
  try {
    const oldToken = "race-old-token-aaaa";
    const newToken = "race-new-token-bbbb";
    const old = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z", oldToken);
    // New SessionStart at the SAME address with a NEW token replaces the old file.
    const newer = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:05.000Z", newToken);
    assert.equal(readClaudeBindingFile(root, old.bindingId), null, "the replaced file is gone at registration time");

    // The delayed old SessionEnd removes nothing and the replacement survives.
    assert.equal(removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: oldToken }).removed, false);
    assert.equal(readClaudeBindingFile(root, newer.bindingId)?.bindingId, newer.bindingId);

    // In the reverse order (old end first, new start later) the new start
    // simply registers a fresh binding and the old end cannot touch it.
    const first = register(root, SESSION_B, SOCKET_B, "2026-10-01T00:00:00.000Z", oldToken);
    assert.equal(removeClaudeBindingForIncarnation(root, { sessionId: SESSION_B, socket: SOCKET_B, token: oldToken }).removed, true);
    assert.equal(readClaudeBindingFile(root, first.bindingId), null);
    const second = register(root, SESSION_B, SOCKET_B, "2026-10-01T00:00:01.000Z", newToken);
    assert.equal(removeClaudeBindingForIncarnation(root, { sessionId: SESSION_B, socket: SOCKET_B, token: oldToken }).removed, false);
    assert.equal(readClaudeBindingFile(root, second.bindingId)?.token, newToken);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveClaudeBinding keeps the documented stale-id session fallback but never crosses identities", () => {
  const root = tmpRoot();
  try {
    const record = register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z");

    // A stale binding id PLUS the session it was bound to: the session's newest
    // binding is the documented rebinding fallback.
    const staleId = newClaudeBindingId();
    assert.equal(resolveClaudeBinding(root, { bindingId: staleId, sessionId: SESSION_A })?.bindingId, record.bindingId);
    // A stale binding id plus a DIFFERENT session: nothing resolves.
    assert.equal(resolveClaudeBinding(root, { bindingId: staleId, sessionId: SESSION_B }), null);
    // A stale binding id alone: nothing resolves (no session fallback).
    assert.equal(resolveClaudeBinding(root, { bindingId: staleId }), null);
    // One legal reference alone keeps working.
    assert.equal(resolveClaudeBinding(root, { sessionId: SESSION_A })?.bindingId, record.bindingId);
    assert.equal(resolveClaudeBinding(root, { bindingId: record.bindingId })?.bindingId, record.bindingId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the managed binding subtree refuses a symlink/junction redirect before any write", (t) => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    const sentinel = path.join(outside, "outside-sentinel.txt");
    fs.writeFileSync(sentinel, "outside-content-must-stay\n", "utf8");
    const outsideMode = process.platform === "win32" ? null : fs.statSync(outside).mode & 0o777;

    // A REAL Windows directory junction (or a POSIX directory symlink) at
    // root/claude: registration must refuse BEFORE mkdir/ACL/write.
    const claudeDir = path.join(root, "claude");
    try {
      fs.symlinkSync(outside, claudeDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.diagnostic("the OS refused to create a directory link; junction/symlink rejection not exercised");
      return;
    }
    assert.equal(fs.lstatSync(claudeDir).isSymbolicLink(), true, "the fixture must be a real reparse point");

    assert.throws(
      () => register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z"),
      (e: unknown) => e instanceof ClaudeBindingError && e.code === "unsafe_binding_path",
      "registration through a redirected subtree must be refused"
    );
    assert.equal(fs.existsSync(path.join(outside, "bindings")), false, "nothing may be created outside the data root");
    assert.deepEqual(fs.readdirSync(outside), ["outside-sentinel.txt"], "the outside directory must stay untouched");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "outside-content-must-stay\n");
    if (outsideMode !== null) assert.equal(fs.statSync(outside).mode & 0o777, outsideMode, "outside permissions must stay unchanged");

    // Reads, listings and cleanup refuse the redirected subtree as well.
    assert.equal(readClaudeBindingFile(root, newClaudeBindingId()), null);
    assert.deepEqual(listClaudeBindings(root), []);
    assert.equal(removeClaudeBindingFile(root, newClaudeBindingId()), false);
    assert.deepEqual(removeClaudeBindingForIncarnation(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN }), {
      removed: false,
      reason: "not_found"
    });
    assert.equal(fs.existsSync(path.join(outside, "bindings")), false, "no operation may follow the redirect");
  } finally {
    try {
      fs.unlinkSync(path.join(root, "claude"));
    } catch {
      /* the fixture may not exist */
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a redirected bindings component under a real claude dir is refused too, and a legitimate root still works", (t) => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    fs.writeFileSync(path.join(outside, "sentinel.txt"), "keep\n", "utf8");
    const claudeDir = path.join(root, "claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(claudeDir, "bindings"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.diagnostic("the OS refused to create a directory link; junction/symlink rejection not exercised");
      return;
    }

    assert.throws(
      () => register(root, SESSION_A, SOCKET_A, "2026-10-01T00:00:00.000Z"),
      (e: unknown) => e instanceof ClaudeBindingError && e.code === "unsafe_binding_path"
    );
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"], "the outside target keeps exactly its own content");

    // A legitimate data root reached through a junction is still usable: only
    // the components this module creates and manages are validated.
    const realRoot = tmpRoot();
    const linkParent = tmpRoot();
    const linkRoot = path.join(linkParent, "root-link");
    try {
      try {
        fs.symlinkSync(realRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
      } catch {
        t.diagnostic("the OS refused to create a directory link; canonical-root case not exercised");
        return;
      }
      const record = registerClaudeBinding(linkRoot, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN });
      assert.equal(readClaudeBindingFile(linkRoot, record.bindingId)?.sessionId, SESSION_A);
      assert.equal(fs.existsSync(path.join(realRoot, "claude", "bindings", `${record.bindingId}.json`)), true);
    } finally {
      try {
        fs.unlinkSync(linkRoot);
      } catch {
        /* fixture */
      }
      fs.rmSync(realRoot, { recursive: true, force: true });
      fs.rmSync(linkParent, { recursive: true, force: true });
    }
  } finally {
    try {
      fs.unlinkSync(path.join(root, "claude", "bindings"));
    } catch {
      /* the fixture may not exist */
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("concurrent sessions register independently and never cross-resolve", () => {
  const root = tmpRoot();
  try {
    const sessions = [SESSION_A, SESSION_B, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "session-four"];
    const records = sessions.map((sessionId, i) => register(root, sessionId, `\\\\.\\pipe\\inbox-${i}`, `2026-10-01T00:00:0${i}.000Z`));
    assert.equal(listClaudeBindings(root).length, sessions.length);
    sessions.forEach((sessionId, i) => {
      const resolved = resolveClaudeBinding(root, { sessionId });
      assert.equal(resolved?.bindingId, records[i]!.bindingId, `session ${sessionId} must resolve to its own binding`);
      assert.equal(resolved?.socket, `\\\\.\\pipe\\inbox-${i}`);
    });

    // Removing one session's binding leaves every other session intact.
    assert.equal(removeClaudeBindingFile(root, records[1]!.bindingId), true);
    assert.equal(resolveClaudeBinding(root, { sessionId: SESSION_B }), null);
    assert.equal(resolveClaudeBinding(root, { sessionId: SESSION_A })?.bindingId, records[0]!.bindingId);
    assert.equal(removeClaudeBindingFile(root, "../escape"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
