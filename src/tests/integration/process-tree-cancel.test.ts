// process-tree-cancel.test.ts — REAL Windows process-tree kill with a controlled
// child/grandchild fixture.
//
// This is not a mock: it spawns a real Node parent that spawns a real Node
// grandchild, then asks the production `killProcessTree` to terminate the tree
// and confirms BOTH PIDs are gone. Killing only the direct child would leave the
// grandchild running — the exact defect this test locks out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess, type execFile } from "node:child_process";
import { classifyProcessGroupContainment, confirmPidExit, enumerateDescendantProcesses, enumerateExitedRootDescendants, enumerateProcessByPid, findDescendants, isPidAlive, killProcessTree, parseProcessList } from "../../runtime/process";

function writeTreeFixture(dir: string): string {
  const file = path.join(dir, "tree-fixture.js");
  fs.writeFileSync(
    file,
    [
      'const { spawn } = require("node:child_process");',
      'const grand = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });',
      'process.stdout.write(JSON.stringify({ parent: process.pid, grandchild: grand.pid }) + "\\n");',
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );
  return file;
}

function spawnFixture(file: string): Promise<{ child: ChildProcess; parentPid: number; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("fixture did not report its pids in time")), 15000);
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buf.slice(0, nl)) as { parent: number; grandchild: number };
        resolve({ child, parentPid: parsed.parent, grandchildPid: parsed.grandchild });
      } catch (e) {
        reject(e as Error);
      }
    });
    child.on("error", reject);
  });
}

test("POSIX containment flags an escaped descendant instead of upgrading a group exit", () => {
  const root = 100;
  const processes = [
    { pid: root, ppid: 1, createdAtMs: 1000, pgid: root, sid: root },
    { pid: 101, ppid: root, createdAtMs: 1100, pgid: root, sid: root },
    { pid: 102, ppid: 101, createdAtMs: 1200, pgid: 102, sid: 102 }
  ];
  const result = classifyProcessGroupContainment(processes, root, 900);
  assert.deepEqual(result.descendantPids, [101, 102]);
  assert.deepEqual(result.outsidePids, [102]);
  assert.equal(result.unknown, false);
});

test("POSIX containment stays unknown when a descendant lacks group/session facts", () => {
  const root = 200;
  const result = classifyProcessGroupContainment(
    [
      { pid: root, ppid: 1, createdAtMs: 1000, pgid: root, sid: root },
      { pid: 201, ppid: root, createdAtMs: 1100 }
    ],
    root,
    900
  );
  assert.deepEqual(result.descendantPids, [201]);
  assert.deepEqual(result.outsidePids, []);
  assert.equal(result.unknown, true);
});

test(
  "killProcessTree kills a real child AND its grandchild, and confirms exit",
  { timeout: 40000, skip: process.platform === "win32" ? false : "Windows process-tree behaviour" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-tree-"));
    const file = writeTreeFixture(dir);
    const { parentPid, grandchildPid } = await spawnFixture(file);
    try {
      assert.equal(isPidAlive(parentPid), true, "parent should be alive before the kill");
      assert.equal(isPidAlive(grandchildPid), true, "grandchild should be alive before the kill");

      const result = await killProcessTree(parentPid);
      assert.equal(result.killed, true);
      assert.equal(result.confirmed, true, `kill not confirmed: ${JSON.stringify(result)}`);
      assert.equal(result.scope, "os_tree_exited", "a successful taskkill /T /F proves the OS-tracked tree stopped");
      assert.equal(result.method, "taskkill");

      assert.equal(isPidAlive(parentPid), false, "parent must be gone");
      assert.equal(isPidAlive(grandchildPid), false, "grandchild must be gone (tree kill, not just the direct child)");
    } finally {
      await killProcessTree(parentPid, { graceMs: 2000 }).catch(() => undefined);
      await killProcessTree(grandchildPid, { graceMs: 2000 }).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test("killProcessTree is idempotent: nothing alive is already confirmed", { timeout: 20000 }, async () => {
  const noPid = await killProcessTree(null);
  assert.equal(noPid.confirmed, true);
  assert.equal(noPid.scope, "none", "no PID means there is no tree to prove");
  assert.equal(noPid.reason, "no_pid");
  assert.equal(noPid.killed, false);

  const deadPid = await killProcessTree(2 ** 31 - 1, { graceMs: 500 });
  assert.equal(deadPid.confirmed, true);
  assert.equal(deadPid.reason, "already_dead");
  assert.equal(
    deadPid.scope,
    "root_exited",
    "a dead ROOT never proves its descendants stopped (matrix E)"
  );
});

test("confirmPidExit resolves true for a PID that never existed", { timeout: 10000 }, async () => {
  assert.equal(await confirmPidExit(2 ** 31 - 1, 500), true);
});

/** An execFile stand-in that reports taskkill FAILURE without touching any process. */
const failingExecFile = ((...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: Error) => void;
  cb(new Error("taskkill failed (simulated)"));
}) as unknown as typeof execFile;

/** An execFile stand-in that reports taskkill SUCCESS. */
const okExecFile = ((...args: unknown[]) => {
  const cb = args[args.length - 1] as (e: Error | null) => void;
  cb(null);
}) as unknown as typeof execFile;

test("killProcessTree never reports a confirmed TREE when taskkill fails (root-only fallback)", { timeout: 20000, skip: process.platform === "win32" ? false : "Windows taskkill fallback semantics" }, async () => {
  // A pid that does not exist (so the direct `process.kill` fallback is a no-op),
  // but a probe that claims it is alive → forces the fallback path. The probe
  // never reports it gone, so even the root is unconfirmed.
  const result = await killProcessTree(2 ** 31 - 1, {
    isAliveFn: () => true,
    execFileFn: failingExecFile,
    graceMs: 50,
    pollMs: 5,
    delayFn: async () => undefined
  });
  assert.equal(result.killed, true);
  assert.equal(result.confirmed, false, "a root-only fallback must never be reported as a confirmed kill");
  assert.equal(result.scope, "unconfirmed", "a root-only fallback is never a tree guarantee");
  assert.notEqual(result.scope, "os_tree_exited");
  assert.equal(result.reason, "tree_unconfirmed");
});

test("parseProcessList reads pid/ppid/creation-time and treats an unreported time as unknown", () => {
  const list = parseProcessList("100 1 1700000000000\n200 100 0\nnot a process line\n\n300 100 1700000000001\n");
  assert.deepEqual(list, [
    { pid: 100, ppid: 1, createdAtMs: 1700000000000 },
    { pid: 200, ppid: 100, createdAtMs: null },
    { pid: 300, ppid: 100, createdAtMs: 1700000000001 }
  ]);
});

test("targeted Windows descendant enumeration uses one direct-child CIM query and keeps an empty snapshot successful", async () => {
  let command = "";
  const execStub = ((...args: unknown[]) => {
    command = String((args[1] as string[])[3] ?? "");
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "501 500 1700000000100 node.exe\n", "");
  }) as unknown as typeof execFile;
  const scan = await enumerateDescendantProcesses(500, { execFileFn: execStub, platform: "win32", timeoutMs: 1000 });
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.processes.map((p) => [p.pid, p.ppid]), [[501, 500]]);
  assert.match(command, /ParentProcessId=500/);
  assert.equal(command.includes("while("), false, "the targeted boundary must not expand into repeated CIM queries");

  const emptyStub = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "", "");
  }) as unknown as typeof execFile;
  const empty = await enumerateDescendantProcesses(500, { execFileFn: emptyStub, platform: "win32", timeoutMs: 1000 });
  assert.deepEqual(empty, { ok: true, processes: [] });
});

test("exited-root Windows enumeration prefers fast WMIC evidence and falls back to Toolhelp without weakening identity", async () => {
  let calls = 0;
  const wmicChildStub = ((...args: unknown[]) => {
    calls += 1;
    assert.equal(args[0], "wmic.exe");
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(
      null,
      "\r\r\nNode,CreationDate,Name,ParentProcessId,ProcessId\r\r\nRUNNER,20261010131319.205922+000,node.exe,500,501\r\r\n",
      ""
    );
  }) as unknown as typeof execFile;
  const scan = await enumerateExitedRootDescendants(500, { execFileFn: wmicChildStub, platform: "win32", timeoutMs: 1000 });
  assert.equal(calls, 1, "a successful WMIC observation needs no fallback process");
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.processes, [{ pid: 501, ppid: 500, createdAtMs: Date.parse("2026-10-10T13:13:19.205Z"), imageName: "node.exe" }]);

  const rootPresentStub = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(
      null,
      "Node,CreationDate,Name,ParentProcessId,ProcessId\nRUNNER,20261010131319.205922+000,node.exe,100,500\n",
      ""
    );
  }) as unknown as typeof execFile;
  const present = await enumerateExitedRootDescendants(500, { execFileFn: rootPresentStub, platform: "win32", timeoutMs: 1000 });
  assert.deepEqual(present, { ok: false, processes: [], reason: "root_pid_present" });

  const emptyWmicStub = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "\r\r\nNode,\r\r\n", "No Instance(s) Available.\r\r\n");
  }) as unknown as typeof execFile;
  const empty = await enumerateExitedRootDescendants(500, { execFileFn: emptyWmicStub, platform: "win32", timeoutMs: 1000 });
  assert.deepEqual(empty, { ok: true, processes: [] });

  const unknownBirthStub = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "Node,CreationDate,Name,ParentProcessId,ProcessId\nRUNNER,,node.exe,500,501\n", "");
  }) as unknown as typeof execFile;
  const unknownBirth = await enumerateExitedRootDescendants(500, { execFileFn: unknownBirthStub, platform: "win32", timeoutMs: 1000 });
  assert.equal(unknownBirth.ok, true);
  assert.equal(unknownBirth.processes[0]?.createdAtMs, null, "an unreadable WMIC child birth remains unknown, never guessed");

  const executables: string[] = [];
  let toolhelpCommand = "";
  const fallbackStub = ((...args: unknown[]) => {
    const file = String(args[0]);
    executables.push(file);
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    if (file === "wmic.exe") {
      cb(Object.assign(new Error("wmic missing"), { code: "ENOENT" }), "", "");
      return;
    }
    toolhelpCommand = String((args[1] as string[])[3] ?? "");
    cb(null, "501 500 1700000000100 node.exe\n", "");
  }) as unknown as typeof execFile;
  const fallback = await enumerateExitedRootDescendants(500, { execFileFn: fallbackStub, platform: "win32", timeoutMs: 1000 });
  assert.deepEqual(executables, ["wmic.exe", "powershell"]);
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.processes.map((p) => p.pid), [501]);
  assert.match(toolhelpCommand, /CreateToolhelp32Snapshot/);
  assert.match(toolhelpCommand, /Snapshot\(\[uint32\]500\)/);
  assert.equal(toolhelpCommand.includes("Get-CimInstance"), false, "the fallback must not re-enter the cold CIM provider");
});
test("targeted Windows pid enumeration distinguishes a present row from a successful absent snapshot", async () => {
  let command = "";
  const presentStub = ((...args: unknown[]) => {
    command = String((args[1] as string[])[3] ?? "");
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "777 100 1700000000300 node.exe\n", "");
  }) as unknown as typeof execFile;
  const present = await enumerateProcessByPid(777, { execFileFn: presentStub, platform: "win32", timeoutMs: 1000 });
  assert.equal(present.ok, true);
  assert.deepEqual(present.processes, [{ pid: 777, ppid: 100, createdAtMs: 1700000000300, imageName: "node.exe" }]);
  assert.match(command, /ProcessId=777/);

  const absentStub = ((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: Error | null, stdout?: string, stderr?: string) => void;
    cb(null, "", "");
  }) as unknown as typeof execFile;
  const absent = await enumerateProcessByPid(777, { execFileFn: absentStub, platform: "win32", timeoutMs: 1000 });
  assert.deepEqual(absent, { ok: true, processes: [] });
});

test("findDescendants scopes to the root PID + generation start time (a pre-generation child is never ours)", () => {
  const start = 1_700_000_000_000;
  const procs = [
    { pid: 20, ppid: 999, createdAtMs: start + 10 }, // ours
    { pid: 21, ppid: 20, createdAtMs: start + 20 }, // ours (deeper)
    { pid: 30, ppid: 999, createdAtMs: start - 5000 }, // created BEFORE this generation → not ours
    { pid: 40, ppid: 30, createdAtMs: start + 30 } // child of an excluded process → not ours
  ];
  const scan = findDescendants(procs, 999, start - 2000);
  assert.deepEqual(scan.pids.slice().sort((a, b) => a - b), [20, 21]);
  assert.equal(scan.unknown, false);
});

test("findDescendants reports the scan as unknown when a candidate's creation time is unreported", () => {
  const scan = findDescendants([{ pid: 5, ppid: 42, createdAtMs: null }], 42, 0);
  assert.equal(scan.unknown, true, "an unidentifiable candidate must never be silently accepted or ignored");
});

test("findDescendants can exclude an explicitly provider-managed daemon and its subtree", () => {
  const start = Date.now();
  const scan = findDescendants([
    { pid: 10, ppid: 42, createdAtMs: start + 10 },
    { pid: 11, ppid: 10, createdAtMs: start + 20 },
    { pid: 20, ppid: 42, createdAtMs: start + 30 }
  ], 42, start, new Set([10]));
  assert.deepEqual(scan.pids, [20]);
  assert.equal(scan.unknown, false);
});

test("an ignored provider daemon with unknown creation time does not make the job tree unknown", () => {
  const scan = findDescendants([
    { pid: 10, ppid: 42, createdAtMs: null },
    { pid: 20, ppid: 42, createdAtMs: 1000 }
  ], 42, 0, new Set([10]));
  assert.deepEqual(scan.pids, [20]);
  assert.equal(scan.unknown, false);
});

test("killProcessTree confirms the TREE only when taskkill succeeds and the root is gone", { timeout: 20000, skip: process.platform === "win32" ? false : "Windows taskkill semantics" }, async () => {
  let probes = 0;
  const result = await killProcessTree(4242, {
    // alive at the initial check, gone once taskkill has run.
    isAliveFn: () => {
      probes += 1;
      return probes === 1;
    },
    execFileFn: okExecFile,
    graceMs: 50,
    pollMs: 5,
    delayFn: async () => undefined
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.scope, "os_tree_exited");
  assert.equal(result.method, "taskkill");
});

test("killProcessTree reports root_exited (never a tree guarantee) when taskkill fails but the root dies", { timeout: 20000, skip: process.platform === "win32" ? false : "Windows taskkill fallback semantics" }, async () => {
  let probes = 0;
  const result = await killProcessTree(4242, {
    // alive at the initial check, gone after the direct fallback kill.
    isAliveFn: () => {
      probes += 1;
      return probes === 1;
    },
    execFileFn: failingExecFile,
    graceMs: 50,
    pollMs: 5,
    delayFn: async () => undefined
  });
  assert.equal(result.confirmed, true, "the fallback did prove the ROOT gone");
  assert.equal(result.scope, "root_exited", "but a root-only kill is not a tree guarantee");
  assert.notEqual(result.scope, "os_tree_exited");
  assert.equal(result.method, "taskkill+kill");
  assert.equal(result.reason, "tree_unconfirmed");
});
