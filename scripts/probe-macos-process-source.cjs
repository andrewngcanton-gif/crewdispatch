#!/usr/bin/env node
// MAC-02 bounded source-selection probe. It compiles the checked-in Darwin
// helper into a disposable directory, compares it with built-in text surfaces,
// and prints one redaction-safe receipt. It does not install a binary or modify
// the production runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { macosMachOArchitectureForNodeArch } = require("./macos-architecture.cjs");

function fail(message, details) {
  const suffix = details ? `\n${details}` : "";
  throw new Error(`${message}${suffix}`);
}

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    encoding: "utf8",
    timeout: options.timeout || 10000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
}

function parseJsonLine(text, label) {
  const line = String(text || "").trim();
  if (!line) fail(`${label} returned no JSON`);
  try {
    return JSON.parse(line);
  } catch (e) {
    fail(`${label} returned invalid JSON`, `${line}\n${e.message}`);
  }
}

function helperCall(binary, args) {
  const result = run(binary, args);
  return {
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    json: parseJsonLine(result.stdout, `helper ${args.join(" ")}`)
  };
}

function psFacts(pid) {
  const result = run("/bin/ps", ["-o", "pid=,ppid=,pgid=,sess=,lstart=,comm=", "-p", String(pid)]);
  if (result.status !== 0) return null;
  const parts = String(result.stdout || "").trim().split(/\s+/);
  if (parts.length < 10) return null;
  const startText = parts.slice(4, 9).join(" ");
  return {
    pid: Number(parts[0]),
    ppid: Number(parts[1]),
    pgid: Number(parts[2]),
    session_raw: parts[3],
    start_text: startText,
    start_epoch_ms: Date.parse(startText),
    command: parts.slice(9).join(" ")
  };
}

function sysctlBoot() {
  const result = run("/usr/sbin/sysctl", ["-n", "kern.boottime"]);
  assert.equal(result.status, 0, String(result.stderr || ""));
  const raw = String(result.stdout || "").trim();
  const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(raw);
  assert.ok(match, `unreadable sysctl kern.boottime: ${raw}`);
  return { raw, sec: Number(match[1]), usec: Number(match[2]) };
}

async function main() {
  const expectedArchitecture = macosMachOArchitectureForNodeArch(process.arch);
  if (process.platform !== "darwin" || !expectedArchitecture) {
    fail(`MAC-02 probe requires native supported macOS arm64/x64; got ${process.platform}/${process.arch}`);
  }

  const repo = path.resolve(__dirname, "..");
  const source = path.join(__dirname, "macos-process-info.c");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-macos-proc-source-"));
  const binary = path.join(tmp, "macos-process-info");

  let child = null;
  try {
    const clangPath = run("/usr/bin/xcrun", ["--find", "clang"]);
    assert.equal(clangPath.status, 0, `xcrun clang unavailable: ${clangPath.stderr}`);
    const clang = String(clangPath.stdout).trim();
    assert.ok(path.isAbsolute(clang), `unexpected clang path: ${clang}`);

    const compile = run("/usr/bin/xcrun", [
      "clang",
      "-Wall",
      "-arch",
      expectedArchitecture,
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=13.0",
      source,
      "-o",
      binary
    ], { timeout: 30000 });    assert.equal(
      compile.status,
      0,
      `Darwin helper compile failed:\n${compile.stdout}\n${compile.stderr}`
    );

    const fileResult = run("/usr/bin/file", [binary]);
    assert.equal(fileResult.status, 0, String(fileResult.stderr || ""));
    const binaryDescription = String(fileResult.stdout || "").trim();
    assert.match(binaryDescription, new RegExp(expectedArchitecture, "u"), `probe helper must be native ${expectedArchitecture}`);

    child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    assert.ok(child.pid && child.pid > 0, "detached comparison child started");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const exact = helperCall(binary, ["process", String(child.pid)]);
    assert.equal(exact.status, 0, `${exact.stdout}\n${exact.stderr}`);
    assert.equal(exact.json.ok, true);
    assert.equal(exact.json.pid, child.pid);
    assert.equal(exact.json.ppid, process.pid, "KERN_PROC_PID reports the real parent");
    assert.equal(exact.json.pgid, child.pid, "detached child is its own process-group leader");
    assert.equal(exact.json.sid, child.pid, "getsid reports the detached child as session leader");
    assert.equal(exact.json.session_leader, true, "KERN_PROC_PID session-leader flag is set");
    assert.ok(Number.isInteger(exact.json.start_sec) && exact.json.start_sec > 0);
    assert.ok(Number.isInteger(exact.json.start_usec) && exact.json.start_usec >= 0 && exact.json.start_usec < 1000000);

    const ps = psFacts(child.pid);
    assert.ok(ps, "BSD ps can observe the child for comparison");
    assert.equal(ps.pid, exact.json.pid);
    assert.equal(ps.ppid, exact.json.ppid);
    assert.equal(ps.pgid, exact.json.pgid);
    assert.ok(Number.isFinite(ps.start_epoch_ms));
    const exactStartMs = exact.json.start_sec * 1000 + Math.floor(exact.json.start_usec / 1000);
    assert.ok(
      Math.abs(ps.start_epoch_ms - exactStartMs) < 1000,
      "ps lstart and KERN_PROC_PID identify the same start second"
    );

    const helperBoot = helperCall(binary, ["boot"]);
    assert.equal(helperBoot.status, 0, `${helperBoot.stdout}\n${helperBoot.stderr}`);
    assert.equal(helperBoot.json.ok, true);
    const textBoot = sysctlBoot();
    assert.equal(helperBoot.json.sec, textBoot.sec, "sysctlbyname and sysctl agree on boot seconds");
    assert.equal(helperBoot.json.usec, textBoot.usec, "sysctlbyname and sysctl agree on boot microseconds");

    const snapshot = helperCall(binary, ["snapshot"]);
    assert.equal(snapshot.status, 0, `${snapshot.stdout.slice(0, 1000)}\n${snapshot.stderr}`);
    assert.equal(snapshot.json.ok, true);
    assert.ok(Array.isArray(snapshot.json.processes) && snapshot.json.processes.length > 0);
    const snapshotChild = snapshot.json.processes.find((item) => item.pid === child.pid);
    assert.ok(snapshotChild, "KERN_PROC_ALL snapshot includes the detached child");
    assert.equal(snapshotChild.ppid, exact.json.ppid);
    assert.equal(snapshotChild.pgid, exact.json.pgid);
    assert.equal(snapshotChild.start_sec, exact.json.start_sec);
    assert.equal(snapshotChild.start_usec, exact.json.start_usec);
    assert.equal(snapshotChild.sid, exact.json.sid);

    const impossible = helperCall(binary, ["process", "2147483647"]);
    assert.notEqual(impossible.status, 0, "a missing pid is a failure, never fabricated process data");
    assert.equal(impossible.json.ok, false);

    const launchctl = run("/bin/launchctl", ["procinfo", String(child.pid)]);
    const launchctlObservation = {
      status: launchctl.status,
      stderr: String(launchctl.stderr || "").trim().slice(0, 300),
      usable_without_root: launchctl.status === 0
    };

    const pid1 = helperCall(binary, ["process", "1"]);
    const pid1Observation = {
      status: pid1.status,
      ok: pid1.json.ok,
      errno: pid1.json.errno ?? null,
      error: pid1.json.error ?? null
    };

    const originalBirth = {
      sec: exact.json.start_sec,
      usec: exact.json.start_usec
    };
    const childPid = child.pid;
    try { process.kill(-childPid, "SIGKILL"); } catch {}
    try { process.kill(childPid, "SIGKILL"); } catch {}
    await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("comparison child did not exit")), 5000))
    ]);

    const afterExit = helperCall(binary, ["process", String(childPid)]);
    let exitClassification = "gone";
    if (afterExit.json.ok === true) {
      const newBirth = { sec: afterExit.json.start_sec, usec: afterExit.json.start_usec };
      assert.notDeepEqual(newBirth, originalBirth, "a live reused pid must have a different exact birth");
      exitClassification = "reused";
    } else {
      assert.notEqual(afterExit.status, 0, "dead pid query fails closed");
    }
    child = null;

    const receipt = {
      kind: "macos-process-source-spike-v1",
      platform: process.platform,
      arch: process.arch,
      macos_release: os.release(),
      node: process.version,
      compiler: clang,
      helper_binary: binaryDescription,
      selected_source: "BSD sysctl(KERN_PROC_PID/KERN_PROC_ALL) + getsid + sysctlbyname(kern.boottime)",
      exact_process: exact.json,
      snapshot_process_count: snapshot.json.processes.length,
      ps_comparison: {
        ...ps,
        precision_limit: "lstart is one-second precision; sess raw marker is not a usable session id"
      },
      boot: helperBoot.json,
      sysctl_boot_raw: textBoot.raw,
      missing_pid: impossible.json,
      pid1_observation: pid1Observation,
      launchctl_procinfo: launchctlObservation,
      post_exit_classification: exitClassification,
      production_decision: {
        ps: "reject for exact birth/session identity",
        launchctl_procinfo: "reject because it requires root on this host",
        sysctl_helper: "accept as MAC-10 production candidate behind Darwin boundary; uses exported kinfo_proc fields rather than libproc private interfaces",
        runtime_compiler_dependency: `reject; distributed installs must receive a prebuilt helper for native ${expectedArchitecture}`
      },
      repo
    };
    process.stdout.write(`MACOS_PROCESS_SOURCE_RECEIPT=${JSON.stringify(receipt)}\n`);
  } finally {
    if (child && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      try { process.kill(child.pid, "SIGKILL"); } catch {}
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
