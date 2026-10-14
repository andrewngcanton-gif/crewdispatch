// claude-lifecycle.test.ts — PURE guards for the additive owner-exit cleanup.
//
// Covers the packet's pure-guard matrix with INJECTED process snapshots (no real
// OS scan): malformed/missing identity, no usable ancestor, ancestry/time
// ambiguity, alive owner, confirmed exit, pid reuse, UNKNOWN scan, unsupported
// platform, a legacy owner-less record, and the "never remove a replaced/newer
// registration" rule. The REAL process-lifetime boundary is proven separately in
// claude-lifecycle-real.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeBindingPath,
  listClaudeBindings,
  readClaudeBindingFile,
  registerClaudeBinding,
  removeClaudeBindingForOwnerExit,
  type ClaudeOwnerRef
} from "../../claude/binding";
import { newClaudeBindingId } from "../../claude/ids";
import {
  captureCallerOwner,
  CLAUDE_BINDING_MAINTENANCE_KIND,
  findOwnerAncestor,
  maintainClaudeCallerBindings,
  OWNER_PROOF_VERSION
} from "../../claude/lifecycle";
import type { ProcessEntry, ProcessScan } from "../../runtime/process";

const SESSION_A = "11111111-2222-4333-8444-555555555555";
const SESSION_B = "99999999-8888-4777-8666-555555555555";
const SOCKET_A = "\\\\.\\pipe\\claude-owner-a";
const SOCKET_B = "\\\\.\\pipe\\claude-owner-b";
const TOKEN = "owner-test-token-0123456789";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-lifecycle-"));
}
function owner(pid: number, createdAtMs: number, imageName = "claude.exe"): ClaudeOwnerRef {
  return { platform: "win32", pid, createdAtMs, imageName, proof: OWNER_PROOF_VERSION };
}
function scan(processes: ProcessEntry[]): ProcessScan {
  return { ok: true, processes };
}

// ---------------------------------------------------------------------------
// findOwnerAncestor (pure ancestry resolution)
// ---------------------------------------------------------------------------

test("findOwnerAncestor picks the HIGHEST native Claude ancestor with coherent times", () => {
  const procs: ProcessEntry[] = [
    { pid: 10, ppid: 0, createdAtMs: 1000, imageName: "claude.exe" }, // stable Desktop owner (highest)
    { pid: 20, ppid: 10, createdAtMs: 2000, imageName: "node.exe" }, // bundled CLI child (transient)
    { pid: 30, ppid: 20, createdAtMs: 3000, imageName: "cmd.exe" }, // shell (transient)
    { pid: 40, ppid: 30, createdAtMs: 4000, imageName: "node.exe" } // the hook itself
  ];
  const o = findOwnerAncestor(procs, 40, "win32");
  assert.equal(o?.pid, 10);
  assert.equal(o?.imageName, "claude.exe");
  assert.equal(o?.proof, OWNER_PROOF_VERSION);
  assert.equal(o?.platform, "win32");
});

test("findOwnerAncestor on Darwin keeps exact microsecond birth and rejects sub-ms ancestry reuse", () => {
  const good: ProcessEntry[] = [
    { pid: 10, ppid: 0, createdAtMs: 1000, createdAtUs: 1_000_100, imageName: "Claude" },
    { pid: 20, ppid: 10, createdAtMs: 1000, createdAtUs: 1_000_200, imageName: "Claude Helper" },
    { pid: 40, ppid: 20, createdAtMs: 1000, createdAtUs: 1_000_300, imageName: "node" }
  ];
  const owner = findOwnerAncestor(good, 40, "darwin");
  assert.equal(owner?.pid, 10);
  assert.equal(owner?.platform, "darwin");
  assert.equal(owner?.createdAtUs, 1_000_100);

  assert.equal(
    findOwnerAncestor(good.map((p) => p.pid === 10 ? { ...p, createdAtUs: undefined } : p), 40, "darwin"),
    null,
    "Darwin owner proof never drops to millisecond precision"
  );
  assert.equal(
    findOwnerAncestor([
      { pid: 10, ppid: 0, createdAtMs: 1000, createdAtUs: 1_000_250, imageName: "Claude" },
      { pid: 40, ppid: 10, createdAtMs: 1000, createdAtUs: 1_000_200, imageName: "node" }
    ], 40, "darwin"),
    null,
    "a parent born one microsecond after its child is a reused PID even inside the same millisecond"
  );
});

test("findOwnerAncestor returns null when no native Claude ancestor exists", () => {
  const procs: ProcessEntry[] = [
    { pid: 20, ppid: 10, createdAtMs: 2000, imageName: "node.exe" },
    { pid: 40, ppid: 20, createdAtMs: 4000, imageName: "node.exe" }
  ];
  assert.equal(findOwnerAncestor(procs, 40, "win32"), null);
});

test("findOwnerAncestor rejects missing birth, incoherent order and a missing start", () => {
  // An ancestor with no reported creation time is UNKNOWN → no owner.
  assert.equal(
    findOwnerAncestor(
      [
        { pid: 10, ppid: 0, createdAtMs: null, imageName: "claude.exe" },
        { pid: 40, ppid: 10, createdAtMs: 4000, imageName: "node.exe" }
      ],
      40,
      "win32"
    ),
    null
  );
  // A parent born AFTER its child is incoherent.
  assert.equal(
    findOwnerAncestor(
      [
        { pid: 10, ppid: 0, createdAtMs: 9000, imageName: "claude.exe" },
        { pid: 40, ppid: 10, createdAtMs: 4000, imageName: "node.exe" }
      ],
      40,
      "win32"
    ),
    null
  );
  // The start process must be present with a birth.
  assert.equal(findOwnerAncestor([{ pid: 10, ppid: 0, createdAtMs: 1000, imageName: "claude.exe" }], 999, "win32"), null);
});

// ---------------------------------------------------------------------------
// captureCallerOwner (best-effort, bounded, never throws)
// ---------------------------------------------------------------------------

test("captureCallerOwner is null off supported hosts and on any failed/unknown/exception scan", async () => {
  assert.equal(await captureCallerOwner({ platform: "linux", enumerateFn: async () => scan([]) }), null);
  assert.equal(await captureCallerOwner({ platform: "darwin", arch: "x64", enumerateFn: async () => scan([]) }), null);
  assert.equal(
    await captureCallerOwner({ platform: "win32", enumerateFn: async () => ({ ok: false, processes: [], reason: "unsupported_platform" }) }),
    null
  );
  assert.equal(
    await captureCallerOwner({
      platform: "win32",
      enumerateFn: async () => {
        throw new Error("boom");
      }
    }),
    null
  );
});

test("captureCallerOwner returns the owner from a usable snapshot", async () => {
  const o = await captureCallerOwner({
    platform: "win32",
    pid: 40,
    enumerateFn: async () =>
      scan([
        { pid: 10, ppid: 0, createdAtMs: 1000, imageName: "claude.exe" },
        { pid: 40, ppid: 10, createdAtMs: 4000, imageName: "node.exe" }
      ])
  });
  assert.equal(o?.pid, 10);
});

test("captureCallerOwner accepts an exact Darwin arm64 ancestry snapshot", async () => {
  const result = await captureCallerOwner({
    platform: "darwin",
    arch: "arm64",
    pid: 40,
    enumerateFn: async () => scan([
      { pid: 10, ppid: 0, createdAtMs: 1000, createdAtUs: 1_000_100, imageName: "Claude" },
      { pid: 20, ppid: 10, createdAtMs: 1000, createdAtUs: 1_000_200, imageName: "Claude Helper" },
      { pid: 40, ppid: 20, createdAtMs: 1000, createdAtUs: 1_000_300, imageName: "node" }
    ])
  });
  assert.deepEqual(result, {
    platform: "darwin", pid: 10, createdAtMs: 1000, createdAtUs: 1_000_100, imageName: "Claude", proof: OWNER_PROOF_VERSION
  });
});

// ---------------------------------------------------------------------------
// maintainClaudeCallerBindings (pure over injected snapshots)
// ---------------------------------------------------------------------------

test("maintenance performs NO OS scan when no binding carries owner evidence", async () => {
  const root = tmpRoot();
  try {
    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN }); // owner-less
    let called = 0;
    const res = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => {
        called += 1;
        return scan([]);
      }
    });
    assert.equal(called, 0, "an owner-less store must not trigger an OS scan");
    assert.equal(res.kind, CLAUDE_BINDING_MAINTENANCE_KIND);
    assert.equal(res.scanned, false);
    assert.equal(res.checked, 0);
    assert.equal(res.removed, 0);
    assert.equal(listClaudeBindings(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live owner preserves its binding; a confirmed exit (pid absent) removes exactly it", async () => {
  const root = tmpRoot();
  try {
    const rec = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: owner(4242, 1_000_000) });
    // Alive: the recorded pid is present with the matching birth instant.
    const alive = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => scan([{ pid: 4242, ppid: 1, createdAtMs: 1_000_000, imageName: "claude.exe" }])
    });
    assert.equal(alive.scanned, true);
    assert.equal(alive.removed, 0);
    assert.equal(listClaudeBindings(root).length, 1);

    // Confirmed exit: the pid is absent from a successful, complete snapshot.
    const gone = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => scan([{ pid: 9999, ppid: 1, createdAtMs: 5, imageName: "other.exe" }])
    });
    assert.equal(gone.removed, 1);
    assert.equal(listClaudeBindings(root).length, 0);
    assert.equal(readClaudeBindingFile(root, rec.bindingId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reused pid with a different birth is a confirmed exit (never mistaken for a live owner)", async () => {
  const root = tmpRoot();
  try {
    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: owner(4242, 1_000_000) });
    const reused = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => scan([{ pid: 4242, ppid: 1, createdAtMs: 9_000_000, imageName: "claude.exe" }])
    });
    assert.equal(reused.removed, 1);
    assert.equal(listClaudeBindings(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unknown scans, unknown births and unsupported platforms all preserve the binding", async () => {
  const root = tmpRoot();
  try {
    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: owner(4242, 1_000_000) });

    // pid present but its birth is unreported → UNKNOWN → preserve.
    const unknownBirth = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => scan([{ pid: 4242, ppid: 1, createdAtMs: null, imageName: "claude.exe" }])
    });
    assert.equal(unknownBirth.removed, 0);

    // A failed/empty scan is UNKNOWN → preserve, with a diagnostic.
    const unknownScan = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => ({ ok: false, processes: [], reason: "empty_process_list" })
    });
    assert.equal(unknownScan.removed, 0);
    assert.equal(unknownScan.scanned, false);
    assert.match(String(unknownScan.reason), /scan_unknown/);

    // An unsupported platform is never guessed → preserve.
    const unsupported = await maintainClaudeCallerBindings(root, { platform: "linux", enumerateFn: async () => scan([]) });
    assert.equal(unsupported.removed, 0);
    assert.equal(unsupported.reason, "unsupported_platform");

    assert.equal(listClaudeBindings(root).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin maintenance uses exact microsecond incarnation and preserves incomplete or foreign evidence", async () => {
  const root = tmpRoot();
  const darwinOwner = (createdAtUs: number | null | undefined): ClaudeOwnerRef => ({
    platform: "darwin",
    pid: 4242,
    createdAtMs: 1_000_000,
    ...(createdAtUs != null ? { createdAtUs } : {}),
    imageName: "Claude",
    proof: OWNER_PROOF_VERSION
  });
  try {
    const exact = darwinOwner(1_000_000_123);
    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: exact });
    const alive = await maintainClaudeCallerBindings(root, {
      platform: "darwin",
      enumerateFn: async () => scan([{
        pid: 4242, ppid: 1, createdAtMs: 1_000_000, createdAtUs: 1_000_000_123, imageName: "Claude"
      }])
    });
    assert.equal(alive.removed, 0);

    const reused = await maintainClaudeCallerBindings(root, {
      platform: "darwin",
      enumerateFn: async () => scan([{
        pid: 4242, ppid: 1, createdAtMs: 1_000_000, createdAtUs: 1_000_000_124, imageName: "Claude"
      }])
    });
    assert.equal(reused.removed, 1, "one-microsecond Darwin birth mismatch proves PID reuse");

    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: darwinOwner(null) });
    const incomplete = await maintainClaudeCallerBindings(root, {
      platform: "darwin",
      enumerateFn: async () => scan([{
        pid: 4242, ppid: 1, createdAtMs: 1_000_000, createdAtUs: 1_000_000_999, imageName: "Claude"
      }])
    });
    assert.equal(incomplete.removed, 0, "legacy Darwin evidence without exact birth is UNKNOWN");

    const foreign = owner(4242, 1_000_000);
    registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET_B, token: TOKEN, owner: foreign });
    const crossPlatform = await maintainClaudeCallerBindings(root, {
      platform: "darwin",
      enumerateFn: async () => scan([{
        pid: 4242, ppid: 1, createdAtMs: 1_000_000, createdAtUs: 1_000_000_999, imageName: "Claude"
      }])
    });
    assert.equal(crossPlatform.removed, 0, "Windows owner evidence is never applied to a Darwin PID namespace");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy owner-less record is never touched, even when another binding triggers a scan", async () => {
  const root = tmpRoot();
  try {
    const legacy = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN }); // no owner
    registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET_B, token: TOKEN, owner: owner(1111, 1_000_000) });
    const res = await maintainClaudeCallerBindings(root, { platform: "win32", enumerateFn: async () => scan([]) });
    assert.equal(res.checked, 1, "only the owner-bearing binding is a candidate");
    assert.equal(res.removed, 1);
    const remaining = listClaudeBindings(root);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.bindingId, legacy.bindingId);
    assert.equal(remaining[0]!.owner ?? null, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live independent owner of another session survives a dead owner's removal", async () => {
  const root = tmpRoot();
  try {
    registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: owner(1111, 1_000_000) }); // dead
    const live = registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET_B, token: TOKEN, owner: owner(2222, 2_000_000) });
    const res = await maintainClaudeCallerBindings(root, {
      platform: "win32",
      enumerateFn: async () => scan([{ pid: 2222, ppid: 1, createdAtMs: 2_000_000, imageName: "claude.exe" }])
    });
    assert.equal(res.removed, 1);
    const remaining = listClaudeBindings(root);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.bindingId, live.bindingId);
    assert.equal(remaining[0]!.sessionId, SESSION_B);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeClaudeBindingForOwnerExit (exact re-verification before unlink)
// ---------------------------------------------------------------------------

test("removeClaudeBindingForOwnerExit never removes a replaced/newer registration or a wrong identity", () => {
  const root = tmpRoot();
  try {
    const o = owner(4242, 1_000_000);
    const first = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: o });
    const newer = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_B, token: TOKEN, owner: o });

    // The old file is already gone (a same-session re-registration replaced it).
    assert.equal(removeClaudeBindingForOwnerExit(root, first.bindingId, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: o }), false);
    // Targeting the newer binding with the OLD socket/token removes nothing.
    assert.equal(removeClaudeBindingForOwnerExit(root, newer.bindingId, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: o }), false);
    // A wrong owner (different birth) removes nothing.
    assert.equal(removeClaudeBindingForOwnerExit(root, newer.bindingId, { sessionId: SESSION_A, socket: SOCKET_B, token: TOKEN, owner: owner(4242, 1_000_001) }), false);
    // A wrong token removes nothing.
    assert.equal(removeClaudeBindingForOwnerExit(root, newer.bindingId, { sessionId: SESSION_A, socket: SOCKET_B, token: "wrong-token", owner: o }), false);
    assert.equal(listClaudeBindings(root).length, 1);

    // Only the exact current identity removes it.
    assert.equal(removeClaudeBindingForOwnerExit(root, newer.bindingId, { sessionId: SESSION_A, socket: SOCKET_B, token: TOKEN, owner: o }), true);
    assert.equal(listClaudeBindings(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner metadata round-trips and an unusable owner field reads as absent", () => {
  const root = tmpRoot();
  try {
    const o = owner(4242, 1_000_000);
    const rec = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET_A, token: TOKEN, owner: o });
    assert.deepEqual(readClaudeBindingFile(root, rec.bindingId)?.owner, o);

    const exact: ClaudeOwnerRef = { platform: "darwin", pid: 4243, createdAtMs: 2_000_000, createdAtUs: 2_000_000_123, imageName: "Claude", proof: OWNER_PROOF_VERSION };
    const exactRec = registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET_B, token: TOKEN, owner: exact });
    assert.deepEqual(readClaudeBindingFile(root, exactRec.bindingId)?.owner, exact);

    // A malformed owner field never becomes a removal target.
    const badId = newClaudeBindingId();
    fs.writeFileSync(claudeBindingPath(root, badId), JSON.stringify({ ...rec, bindingId: badId, owner: { pid: -1 } }));
    assert.equal(readClaudeBindingFile(root, badId)?.owner ?? null, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("findOwnerAncestor rejects a reused parent PID born even slightly after its child", () => {
  assert.equal(findOwnerAncestor([
    { pid: 40, ppid: 20, createdAtMs: 2000, imageName: "node.exe" },
    { pid: 20, ppid: 10, createdAtMs: 1000, imageName: "claude.exe" },
    { pid: 10, ppid: 0, createdAtMs: 1500, imageName: "claude.exe" }
  ], 40, "win32"), null);
});

test("findOwnerAncestor rejects a cyclic ancestry snapshot", () => {
  assert.equal(findOwnerAncestor([
    { pid: 40, ppid: 20, createdAtMs: 1000, imageName: "node.exe" },
    { pid: 20, ppid: 40, createdAtMs: 1000, imageName: "claude.exe" }
  ], 40, "win32"), null);
});
