// claude-lifecycle-real.test.ts — REAL process-lifetime boundary for the
// additive owner-exit cleanup.
//
// This test uses a REAL child process as the recorded owner, reads its ACTUAL OS
// pid + creation instant from the real public enumeration, and drives the SAME
// shared maintenance entry the daemon's reconcile cycle calls
// (`runNotificationMaintenance`, whose Claude adapter is registered in
// src/mcp/notify.ts beside the transport). A real child exit then removes the
// exact old binding; a live independent owner and a newer same-session
// registration survive.
//
// HONEST LABEL: the owner metadata here is SYNTHETIC FIXTURE OWNERSHIP — it is
// constructed from a real child's real pid/birth, NOT captured from a native
// Claude Desktop ancestry (that capture is covered by the pure guards and a
// separate live-app topology receipt). OS fakes are used nowhere here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enumerateProcesses, isPidAlive } from "../../runtime/process";
import {
  listClaudeBindings,
  readClaudeBindingFile,
  registerClaudeBinding,
  type ClaudeOwnerRef
} from "../../claude/binding";
import { OWNER_PROOF_VERSION } from "../../claude/lifecycle";
import { runNotificationMaintenance } from "../../jobs/notifications";
// Side-effect import: registers the Claude binding-maintenance adapter (and the
// transports) exactly as the daemon does when it loads src/mcp/notify.ts.
import "../../mcp/notify";

const SESSION_A = "1a1a1a1a-2222-4333-8444-555555555555";
const SESSION_B = "2b2b2b2b-3333-4444-8555-666666666666";
const SESSION_C = "3c3c3c3c-4444-4555-8666-777777777777";
const SESSION_D = "4d4d4d4d-5555-4666-8777-888888888888";
const SOCKET = (n: number): string => (process.platform === "win32" ? `\\\\.\\pipe\\claude-lifecycle-real-${n}` : `/tmp/claude-lifecycle-real-${n}.sock`);
const TOKEN = "lifecycle-real-token-0123456789";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAlive(pid: number, wantAlive: boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isPidAlive(pid) === wantAlive) return true;
    if (Date.now() >= deadline) return isPidAlive(pid) === wantAlive;
    await delay(100);
  }
}

/** Spawn a real, long-lived owner child and return its pid. */
function spawnOwner(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(function(){}, 1000)"], { stdio: "ignore", windowsHide: true });
}

/** Read a real process's ACTUAL creation instant from the real OS snapshot. */
async function realOwnerEntry(pid: number) {
  const scan = await enumerateProcesses({ timeoutMs: 20000 });
  if (!scan.ok) return null;
  return scan.processes.find((p) => p.pid === pid) ?? null;
}

function ownerFor(entry: NonNullable<Awaited<ReturnType<typeof realOwnerEntry>>>): ClaudeOwnerRef {
  return {
    platform: process.platform,
    pid: entry.pid,
    createdAtMs: entry.createdAtMs as number,
    ...(entry.createdAtUs != null ? { createdAtUs: entry.createdAtUs } : {}),
    imageName: entry.imageName || "node",
    proof: OWNER_PROOF_VERSION
  };
}

test("a real owner child exit removes its exact binding through the shared maintenance entry", { timeout: 120000 }, async (t) => {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    t.diagnostic("real Claude owner-lifetime maintenance is accepted only on Windows and macOS");
    return;
  }
  if (process.platform === "darwin" && !["arm64", "x64"].includes(process.arch)) {
    t.diagnostic(`unsupported macOS architecture for Claude owner-lifetime maintenance: ${process.arch}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-lifecycle-real-"));
  const children: ChildProcess[] = [];
  const killAll = (): void => {
    for (const c of children) {
      try {
        if (c.pid && isPidAlive(c.pid) === true) c.kill();
      } catch {
        /* best effort */
      }
    }
  };
  try {
    // --- fixture: a real owner child with real pid + real birth ---------------
    const owner1 = spawnOwner();
    children.push(owner1);
    assert.ok(owner1.pid && owner1.pid > 0, "the fixture owner must have a real pid");
    await waitForAlive(owner1.pid!, true);
    const ownerEntry1 = await realOwnerEntry(owner1.pid!);
    assert.ok(ownerEntry1?.createdAtMs && ownerEntry1.createdAtMs > 0, "the real OS snapshot must report the owner's creation instant");
    if (process.platform === "darwin") assert.ok(ownerEntry1!.createdAtUs && ownerEntry1!.createdAtUs! > 0, "Darwin must retain exact microsecond birth");
    const ownerRef1 = ownerFor(ownerEntry1!);

    const rec = registerClaudeBinding(root, { sessionId: SESSION_A, socket: SOCKET(1), token: TOKEN, owner: ownerRef1 });
    assert.deepEqual(readClaudeBindingFile(root, rec.bindingId)?.owner, ownerRef1);

    // --- a live owner preserves its binding -----------------------------------
    const livePass = await runNotificationMaintenance(root);
    assert.equal(livePass.reduce((n, r) => n + r.removed, 0), 0, "a live owner must preserve its binding");
    assert.equal(listClaudeBindings(root).length, 1);

    // --- the real child exits → the exact binding is removed ------------------
    owner1.kill();
    assert.equal(await waitForAlive(owner1.pid!, false), true, "the fixture owner must actually exit");
    const exitPass = await runNotificationMaintenance(root);
    assert.equal(exitPass.reduce((n, r) => n + r.removed, 0), 1, "a confirmed owner exit must remove exactly its binding");
    assert.equal(listClaudeBindings(root).length, 0);
    assert.equal(readClaudeBindingFile(root, rec.bindingId), null);

    // --- a newer same-session registration survives a stale owner's removal ---
    const owner2 = spawnOwner();
    children.push(owner2);
    await waitForAlive(owner2.pid!, true);
    const ownerEntry2 = await realOwnerEntry(owner2.pid!);
    assert.ok(ownerEntry2?.createdAtMs && ownerEntry2.createdAtMs > 0);
    const ownerRef2 = ownerFor(ownerEntry2!);

    // Register an OLD binding for SESSION_B owned by the ALREADY-DEAD owner1…
    registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET(2), token: TOKEN, owner: ownerRef1 });
    // …then a NEWER same-session registration owned by the live owner2 replaces it.
    const newer = registerClaudeBinding(root, { sessionId: SESSION_B, socket: SOCKET(3), token: TOKEN, owner: ownerRef2 });
    assert.equal(listClaudeBindings(root).filter((b) => b.sessionId === SESSION_B).length, 1, "a same-session re-registration leaves exactly the newer binding");
    const afterNewer = await runNotificationMaintenance(root);
    assert.equal(afterNewer.reduce((n, r) => n + r.removed, 0), 0, "the live newer registration must survive the stale owner's exit");
    assert.equal(readClaudeBindingFile(root, newer.bindingId)?.socket, SOCKET(3));

    // --- a concurrent independent live owner survives a dead owner's removal --
    registerClaudeBinding(root, { sessionId: SESSION_C, socket: SOCKET(4), token: TOKEN, owner: ownerRef2 }); // live
    registerClaudeBinding(root, { sessionId: SESSION_D, socket: SOCKET(5), token: TOKEN, owner: ownerRef1 }); // dead
    const mixed = await runNotificationMaintenance(root);
    assert.equal(mixed.reduce((n, r) => n + r.removed, 0), 1, "only the dead owner's binding is removed");
    const remaining = listClaudeBindings(root);
    assert.equal(remaining.length, 2, "the live SESSION_B and SESSION_C bindings survive");
    assert.equal(remaining.some((b) => b.sessionId === SESSION_C), true);
    assert.equal(remaining.some((b) => b.sessionId === SESSION_D), false);
  } finally {
    killAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
