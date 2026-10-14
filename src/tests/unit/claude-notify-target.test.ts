// claude-notify-target.test.ts — unit coverage of the caller wake-target
// resolution (priority, competing identities, opaque-reference validation) and
// the persisted-target normalization for the Claude caller fields.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotifyInputError, resolveNotifyTarget } from "../../mcp/notify";
import { createJobRecord } from "../../jobs/service";
import { ensureRoot, loadJob, normalizeJob, saveJob } from "../../jobs/store";
import { registerClaudeBinding, resolveClaudeBinding } from "../../claude/binding";
import { newClaudeBindingId } from "../../claude/ids";
import type { JobRecord } from "../../jobs/types";

const SESSION = "11111111-2222-4333-8444-555555555555";
const CODEX = "12345678-1234-1234-1234-123456789abc";

test("wake priority is callback_url > Claude reference > explicit thread id > env fallback", () => {
  const env = { CODEX_THREAD_ID: "env-thread" } as NodeJS.ProcessEnv;

  // A callback URL coexists with one explicit caller identity and wins.
  const all = resolveNotifyTarget({ callbackUrl: "http://127.0.0.1:9/w", claudeSessionId: SESSION, env });
  assert.equal(all.kind, "callback");
  assert.equal(all.source, "callback_url");
  assert.equal(all.claudeSessionId, null);
  assert.equal(all.codexThreadId, null);

  // An explicit Claude reference wins over the CODEX_THREAD_ID env fallback.
  const claudeOverEnv = resolveNotifyTarget({ claudeSessionId: SESSION, env });
  assert.equal(claudeOverEnv.kind, "claude_session");
  assert.equal(claudeOverEnv.source, "claude_session_id");
  assert.equal(claudeOverEnv.claudeSessionId, SESSION);
  assert.equal(claudeOverEnv.codexThreadId, null);

  const explicit = resolveNotifyTarget({ codexThreadId: CODEX, env });
  assert.equal(explicit.kind, "codex_thread");
  assert.equal(explicit.source, "codex_thread_id");

  const fallback = resolveNotifyTarget({ env });
  assert.equal(fallback.kind, "codex_thread");
  assert.equal(fallback.source, "env");

  const none = resolveNotifyTarget({ env: {} as NodeJS.ProcessEnv });
  assert.equal(none.kind, "none");
  assert.equal(none.source, null);
  assert.equal(none.claudeSessionId, null);
  assert.equal(none.claudeBindingId, null);

  // Two DIFFERENT explicit caller identities never resolve by precedence: the
  // ambiguous request is rejected so a job can never be bound to a different
  // conversation than the caller named (see the dedicated conflict test).
  assert.throws(
    () => resolveNotifyTarget({ claudeSessionId: SESSION, codexThreadId: CODEX, env }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "conflicting_notify_targets"
  );
});

test("a Claude binding reference is an accepted opaque target form", () => {
  const bindingId = newClaudeBindingId();
  const target = resolveNotifyTarget({ claudeBindingId: bindingId });
  assert.equal(target.kind, "claude_session");
  assert.equal(target.source, "claude_binding_id");
  assert.equal(target.claudeBindingId, bindingId);
  assert.equal(target.claudeSessionId, null);
  assert.equal(target.callbackUrl, null);
  assert.equal(target.codexThreadId, null);
});

test("competing explicit caller identities are rejected instead of silently choosing one", () => {
  assert.throws(
    () => resolveNotifyTarget({ claudeSessionId: SESSION, codexThreadId: CODEX }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "conflicting_notify_targets"
  );
  assert.throws(
    () => resolveNotifyTarget({ claudeBindingId: newClaudeBindingId(), codexThreadId: CODEX }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "conflicting_notify_targets"
  );
  assert.throws(
    () => resolveNotifyTarget({ claudeSessionId: SESSION, claudeBindingId: newClaudeBindingId() }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "conflicting_notify_targets"
  );
  // A conflicting pair is rejected even when a callback URL would have won:
  // an ambiguous explicit caller identity is never silently discarded.
  assert.throws(
    () => resolveNotifyTarget({ callbackUrl: "http://127.0.0.1:9/w", claudeSessionId: SESSION, codexThreadId: CODEX }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "conflicting_notify_targets"
  );
});

test("malformed Claude references are rejected with stable codes and no fallback", () => {
  const badSessions = ["../evil", "a b", " padded", "padded ", "a".repeat(129), "\\\\.\\pipe\\claude-1", "a\nb"];
  for (const value of badSessions) {
    assert.throws(
      () => resolveNotifyTarget({ claudeSessionId: value }),
      (e: unknown) => e instanceof NotifyInputError && e.code === "invalid_claude_session_id",
      `session value ${JSON.stringify(value)} must be rejected`
    );
  }
  const badBindings = ["not-hex", "ABCDEF0123456789", "abcdef", "a".repeat(66), "\\\\.\\pipe\\x"];
  for (const value of badBindings) {
    assert.throws(
      () => resolveNotifyTarget({ claudeBindingId: value }),
      (e: unknown) => e instanceof NotifyInputError && e.code === "invalid_claude_binding_id",
      `binding value ${JSON.stringify(value)} must be rejected`
    );
  }
  // An invalid explicit value is refused even when the env fallback exists: it
  // is never silently ignored in favor of another conversation.
  assert.throws(
    () => resolveNotifyTarget({ claudeSessionId: "bad id!", env: { CODEX_THREAD_ID: "env-thread" } as NodeJS.ProcessEnv }),
    (e: unknown) => e instanceof NotifyInputError && e.code === "invalid_claude_session_id"
  );
});

test("absent/empty Claude values are not supplied, and existing Codex/callback behavior is unchanged", () => {
  // These no-target cases MUST supply an explicit environment. Without it the
  // resolver falls back to the PROCESS environment, so a caller-hosted run
  // (e.g. Codex with its own CODEX_THREAD_ID exported) would change `kind`
  // from `none` to `codex_thread` — the assertion would depend on the parent
  // process, not on the code under test.
  for (const value of [null, undefined, "", "   "]) {
    const target = resolveNotifyTarget({ claudeSessionId: value, claudeBindingId: value, env: {} as NodeJS.ProcessEnv });
    assert.equal(target.kind, "none");
    assert.equal(target.source, null);
  }
  // The environment fallback itself stays deterministic when the environment
  // is supplied explicitly (it is only ever read from the given environment).
  const fallback = resolveNotifyTarget({ env: { CODEX_THREAD_ID: "env-thread" } as NodeJS.ProcessEnv });
  assert.equal(fallback.kind, "codex_thread");
  assert.equal(fallback.source, "env");
  assert.equal(fallback.codexThreadId, "env-thread");
  const cb = resolveNotifyTarget({ callbackUrl: "https://example.test/wake", env: {} as NodeJS.ProcessEnv });
  assert.deepEqual(cb, { kind: "callback", callbackUrl: "https://example.test/wake", codexThreadId: null, claudeSessionId: null, claudeBindingId: null, source: "callback_url" });
  const thread = resolveNotifyTarget({ codexThreadId: CODEX, env: {} as NodeJS.ProcessEnv });
  assert.deepEqual(thread, { kind: "codex_thread", callbackUrl: null, codexThreadId: CODEX, claudeSessionId: null, claudeBindingId: null, source: "codex_thread_id" });
});

test("a persisted Claude target survives save/load with only opaque references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-target-"));
  try {
    ensureRoot(root);
    const bindingId = newClaudeBindingId();
    const job = createJobRecord({
      task: "claude-target-task",
      cwd: process.cwd(),
      notifyTarget: { kind: "claude_session", callbackUrl: null, codexThreadId: null, claudeSessionId: SESSION, claudeBindingId: bindingId, source: "claude_binding_id" }
    });
    const saved = saveJob(root, job);
    const loaded = loadJob(root, saved.id)!;
    assert.equal(loaded.notifyTarget.kind, "claude_session");
    assert.equal(loaded.notifyTarget.claudeSessionId, SESSION);
    assert.equal(loaded.notifyTarget.claudeBindingId, bindingId);
    assert.equal(loaded.notifyTarget.source, "claude_binding_id");

    // The raw record carries ONLY the opaque references — no address, no token.
    const raw = JSON.parse(fs.readFileSync(path.join(root, "jobs", `${saved.id}.json`), "utf8")) as { notifyTarget: Record<string, unknown> };
    assert.deepEqual(raw.notifyTarget, {
      kind: "claude_session",
      callbackUrl: null,
      codexThreadId: null,
      claudeSessionId: SESSION,
      claudeBindingId: bindingId,
      source: "claude_binding_id"
    });

    // Resolution of the LOADED persisted pair: it must identify one binding.
    // A matching pair resolves; a persisted pair whose binding belongs to a
    // DIFFERENT session fails closed instead of silently waking that session.
    const stored = registerClaudeBinding(root, {
      sessionId: SESSION,
      socket: process.platform === "win32" ? "\\\\.\\pipe\\claude-target-test" : "/tmp/claude-target-test.sock",
      token: "target-test-token"
    });
    assert.equal(resolveClaudeBinding(root, { bindingId: stored.bindingId, sessionId: loaded.notifyTarget.claudeSessionId })?.bindingId, stored.bindingId);
    assert.equal(
      resolveClaudeBinding(root, { bindingId: stored.bindingId, sessionId: "99999999-8888-4777-8666-555555555555" }),
      null,
      "a persisted pair naming another session's binding must not resolve"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalization keeps a malformed Claude target fail-closed and legacy records unchanged", () => {
  const base = createJobRecord({ task: "t", cwd: process.cwd(), notifyTarget: { kind: "none", callbackUrl: null, codexThreadId: null, source: null } });

  const asRaw = (target: unknown): Record<string, unknown> => {
    const raw = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    raw.notifyTarget = target;
    return raw;
  };

  // A malformed Claude target keeps the kind but null references: delivery then
  // fails closed with `no_binding` instead of rerouting to another session.
  const malformed = normalizeJob(
    asRaw({ kind: "claude_session", claudeSessionId: "../evil", claudeBindingId: "NOPE", source: "claude_session_id" })
  );
  assert.equal(malformed.notifyTarget.kind, "claude_session");
  assert.equal(malformed.notifyTarget.claudeSessionId, null);
  assert.equal(malformed.notifyTarget.claudeBindingId, null);

  // Claude fields on a NON-Claude kind are dropped, never smuggled through.
  const smuggled = normalizeJob(asRaw({ kind: "callback", callbackUrl: "http://127.0.0.1:1/w", claudeSessionId: SESSION, source: "callback_url" }));
  assert.equal(smuggled.notifyTarget.kind, "callback");
  assert.equal(smuggled.notifyTarget.claudeSessionId, null);

  // A legacy v11 record has no Claude keys at all and must read as null fields
  // with its original target semantics intact.
  const legacy = normalizeJob(asRaw({ kind: "codex_thread", codexThreadId: CODEX, source: "codex_thread_id" }));
  assert.equal(legacy.notifyTarget.kind, "codex_thread");
  assert.equal(legacy.notifyTarget.codexThreadId, CODEX);
  assert.equal(legacy.notifyTarget.claudeSessionId, null);
  assert.equal(legacy.notifyTarget.claudeBindingId, null);

  // An unknown source is unknown, never invented.
  const unknownSource = normalizeJob(asRaw({ kind: "claude_session", claudeSessionId: SESSION, source: "made_up" }));
  assert.equal(unknownSource.notifyTarget.source, null);
  assert.equal(unknownSource.notifyTarget.claudeSessionId, SESSION);
});

test("a follow-up continuation can replace the wake target for the new generation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-cont-"));
  try {
    ensureRoot(root);
    const first = saveJob(
      root,
      createJobRecord({
        task: "gen0",
        cwd: process.cwd(),
        notifyTarget: { kind: "claude_session", callbackUrl: null, codexThreadId: null, claudeSessionId: SESSION, claudeBindingId: null, source: "claude_session_id" }
      })
    );
    // A continuation that names a DIFFERENT session replaces the persisted
    // target for the new generation (the worker reads the record's target).
    const other = "99999999-8888-4777-8666-555555555555";
    const next: JobRecord = {
      ...loadJob(root, first.id)!,
      generation: 1,
      status: "running",
      notifyTarget: { kind: "claude_session", callbackUrl: null, codexThreadId: null, claudeSessionId: other, claudeBindingId: null, source: "claude_session_id" }
    };
    saveJob(root, next);
    const loaded = loadJob(root, first.id)!;
    assert.equal(loaded.generation, 1);
    assert.equal(loaded.notifyTarget.claudeSessionId, other);
    assert.equal(loaded.notifyTarget.kind, "claude_session");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
