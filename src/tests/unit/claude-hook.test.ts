// claude-hook.test.ts — unit coverage of the synchronous SessionStart /
// SessionEnd hook logic: registration from hook JSON + session exports, safe
// guidance output, exact-incarnation cleanup and the never-fail contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_GUIDANCE_CAP, runClaudeHookCli, runSessionEndHook, runSessionStartHook } from "../../claude/hook";
import { listClaudeBindings, registerClaudeBinding } from "../../claude/binding";

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "hook-token-marker-0123456789";
const SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\claude-hook-test" : "/tmp/claude-hook-test.sock";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-hook-"));
}

function envWith(socket: string | undefined, token: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (socket !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = socket;
  if (token !== undefined) env.CLAUDE_CODE_MESSAGING_TOKEN = token;
  return env;
}

test("SessionStart registers the exact session and emits ONE safe guidance line", () => {
  const root = tmpRoot();
  try {
    const result = runSessionStartHook({
      stdinText: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", cwd: process.cwd() }),
      env: envWith(SOCKET, TOKEN),
      root
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, null);
    assert.ok(result.stdout);
    const line = result.stdout!;
    assert.equal(line.includes("\n"), false);
    assert.ok(line.length <= HOOK_GUIDANCE_CAP);
    assert.ok(line.includes(SESSION), "the guidance names the current session id");
    assert.equal(line.includes(TOKEN), false, "the guidance must never carry the token");
    assert.equal(line.includes(SOCKET), false, "the guidance must never carry the inbox address");
    assert.match(line, /claude_session_id="[^"]+"/);
    assert.match(line, /claude_binding_id="[a-f0-9]{32}"/);

    const bindings = listClaudeBindings(root);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]!.sessionId, SESSION);
    assert.equal(bindings[0]!.socket, SOCKET);
    assert.equal(bindings[0]!.token, TOKEN);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart without a usable session id or inbox exports registers nothing and never fails", () => {
  const root = tmpRoot();
  try {
    const cases: Array<{ stdin: string; env: NodeJS.ProcessEnv; expect: RegExp }> = [
      { stdin: JSON.stringify({ hook_event_name: "SessionStart" }), env: envWith(SOCKET, TOKEN), expect: /no usable session_id/ },
      { stdin: JSON.stringify({ session_id: "../evil" }), env: envWith(SOCKET, TOKEN), expect: /no usable session_id/ },
      { stdin: "not json at all", env: envWith(SOCKET, TOKEN), expect: /no usable session_id/ },
      { stdin: JSON.stringify({ session_id: SESSION }), env: envWith(undefined, undefined), expect: /no native inbox exports/ },
      { stdin: JSON.stringify({ session_id: SESSION }), env: envWith(SOCKET, undefined), expect: /no native inbox exports/ }
    ];
    for (const c of cases) {
      const result = runSessionStartHook({ stdinText: c.stdin, env: c.env, root });
      assert.equal(result.exitCode, 0, "the hook must never fail a session");
      assert.equal(result.stdout, null);
      assert.match(String(result.stderr), c.expect);
      assert.equal(String(result.stderr).includes(TOKEN), false);
    }
    assert.equal(listClaudeBindings(root).length, 0, "no rejected input may leave a binding behind");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart injects the caller-owner identity when supplied and stays owner-less otherwise", () => {
  const root = tmpRoot();
  const root2 = tmpRoot();
  try {
    const owner = { platform: "win32", pid: 4242, createdAtMs: 1_000_000, imageName: "claude.exe", proof: 1 };
    const withOwner = runSessionStartHook({
      stdinText: JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart" }),
      env: envWith(SOCKET, TOKEN),
      root,
      owner
    });
    assert.equal(withOwner.exitCode, 0);
    const stored = listClaudeBindings(root);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]!.owner, owner, "the injected owner identity is stored on the exact binding");
    // The owner identity never leaks into the guidance line.
    assert.equal(String(withOwner.stdout).includes("4242"), false);
    assert.equal(String(withOwner.stderr ?? "").includes("4242"), false);

    // A registration without an injected owner stores no owner at all.
    runSessionStartHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(SOCKET, TOKEN), root: root2 });
    assert.equal(listClaudeBindings(root2)[0]!.owner ?? null, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("SessionEnd removes only the exact incarnation (session + address + token) and stays silent otherwise", () => {
  const root = tmpRoot();
  try {
    const oldSocket = process.platform === "win32" ? "\\\\.\\pipe\\claude-hook-old" : "/tmp/claude-hook-old.sock";
    const current = registerClaudeBinding(root, { sessionId: SESSION, socket: SOCKET, token: TOKEN });

    // A late SessionEnd from an older incarnation must not delete the binding.
    const stale = runSessionEndHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(oldSocket, TOKEN), root });
    assert.equal(stale.exitCode, 0);
    assert.match(String(stale.stderr), /incarnation_mismatch/);
    assert.equal(listClaudeBindings(root).length, 1);

    // The SAME address with a DIFFERENT token is a different incarnation: a
    // resumed session may reuse the native address, so the old end must not
    // delete the newer registration.
    const wrongToken = runSessionEndHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(SOCKET, "different-token"), root });
    assert.equal(wrongToken.exitCode, 0);
    assert.match(String(wrongToken.stderr), /incarnation_mismatch/);
    assert.equal(listClaudeBindings(root).length, 1);
    assert.equal(listClaudeBindings(root)[0]!.token, TOKEN);

    // An end without a provable address removes nothing (safe by design).
    const noAddress = runSessionEndHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(undefined, undefined), root });
    assert.equal(noAddress.exitCode, 0);
    assert.match(String(noAddress.stderr), /no_incarnation_address/);
    assert.equal(listClaudeBindings(root).length, 1);

    // An address WITHOUT the hook's own token removes nothing either.
    const noToken = runSessionEndHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(SOCKET, undefined), root });
    assert.equal(noToken.exitCode, 0);
    assert.match(String(noToken.stderr), /no_incarnation_token/);
    assert.equal(listClaudeBindings(root).length, 1);
    assert.equal(String(noToken.stderr).includes(TOKEN), false, "a diagnostic must never carry the token");

    // The exact incarnation is removed.
    const exact = runSessionEndHook({ stdinText: JSON.stringify({ session_id: SESSION }), env: envWith(SOCKET, TOKEN), root });
    assert.equal(exact.exitCode, 0);
    assert.equal(exact.stderr, null);
    assert.equal(listClaudeBindings(root).length, 0);
    assert.equal(current.sessionId, SESSION);

    // A malformed end input is a silent no-op, never a failure.
    const malformed = runSessionEndHook({ stdinText: "{}", env: envWith(SOCKET, TOKEN), root });
    assert.deepEqual(malformed, { stdout: null, stderr: null, exitCode: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the hook CLI refuses an unknown mode with a usage diagnostic and exit 0", () => {
  const result = runClaudeHookCli(["bogus-mode"], envWith(SOCKET, TOKEN));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, null);
  assert.match(String(result.stderr), /usage: hook\.js/);
});
