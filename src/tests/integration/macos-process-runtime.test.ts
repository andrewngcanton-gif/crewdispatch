import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { captureProcessIdentity, enumerateProcesses, isPidAlive, killProcessTree, readBootTime } from "../../runtime/process";

test(
  "production Darwin runtime exposes exact native process and boot facts",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
  async () => {
    const scan = await enumerateProcesses({ timeoutMs: 10_000 });
    assert.equal(scan.ok, true, scan.reason ?? "Darwin process scan failed");
    const self = scan.processes.find((entry) => entry.pid === process.pid);
    assert.ok(self, "native snapshot includes the current process");
    assert.equal(self!.ppid > 0, true);
    assert.equal(self!.createdAtMs != null && self!.createdAtMs > 0, true);
    assert.equal(self!.createdAtUs != null && self!.createdAtUs > 0, true);
    assert.equal(Number.isSafeInteger(self!.createdAtUs), true);
    assert.equal(self!.createdAtMs, Math.floor(self!.createdAtUs! / 1000));
    assert.equal(self!.pgid != null && self!.pgid > 0, true);
    assert.equal(self!.sid != null && self!.sid > 0, true);

    const boot = await readBootTime();
    assert.equal(boot.ok, true, boot.reason ?? "Darwin boot-time probe failed");
    assert.equal(boot.bootTimeMs != null && boot.bootTimeMs > 0, true);
    assert.equal(boot.bootTimeUs != null && boot.bootTimeUs > 0, true);
    assert.equal(boot.bootTimeMs, Math.floor(boot.bootTimeUs! / 1000));
    assert.ok(boot.bootTimeMs! < self!.createdAtMs!, "boot predates the running test process");
  }
);

test(
  "Darwin persisted PID signaling requires the exact microsecond birth and owned process group",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch), timeout: 20_000 },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    const pid = child.pid;
    assert.ok(pid != null && pid > 0, "detached control child started");
    try {
      const deadline = Date.now() + 5_000;
      let identity = pid ? captureProcessIdentity(pid) : null;
      while (!identity && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        identity = pid ? captureProcessIdentity(pid) : null;
      }
      assert.ok(identity?.createdAtUs != null, "Darwin exact birth is observable");
      assert.equal(identity!.pgid, pid);
      assert.equal(identity!.sid, pid);
      assert.equal(identity!.sessionLeader, true);

      const reused = await killProcessTree(pid, {
        expectedCreatedAtUs: identity!.createdAtUs! + 1,
        graceMs: 250
      });
      assert.equal(reused.killed, false, "a mismatched birth is never signalled");
      assert.equal(reused.reason, "pid_reused");
      assert.equal(isPidAlive(pid), true, "the unrelated current incarnation survives");

      const unpinned = await killProcessTree(pid, {
        expectedCreatedAtUs: null,
        graceMs: 250
      });
      assert.equal(unpinned.killed, false, "legacy/unpinned Darwin PID is never signalled");
      assert.equal(unpinned.reason, "identity_unpinned");
      assert.equal(isPidAlive(pid), true, "the unpinned process survives");

      const exact = await killProcessTree(pid, {
        expectedCreatedAtUs: identity!.createdAtUs!,
        graceMs: 4_000
      });
      assert.equal(exact.confirmed, true);
      assert.equal(exact.scope, "os_tree_exited");
      assert.equal(isPidAlive(pid), false, "only the exact recorded incarnation is stopped");
    } finally {
      try { process.kill(-(pid as number), "SIGKILL"); } catch {}
      try { process.kill(pid as number, "SIGKILL"); } catch {}
    }
  }
);
