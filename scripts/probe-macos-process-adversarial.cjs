#!/usr/bin/env node
// MAC-03 adversarial native macOS fixtures.
// Test-only: no production process signaling or reconciliation path imports this.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { macosMachOArchitectureForNodeArch } = require("./macos-architecture.cjs");

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    encoding: "utf8",
    timeout: options.timeout || 15000,
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env })
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  return (async () => {
    for (;;) {
      if (predicate()) return;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(20);
    }
  })();
}
function helper(binary, args, options = {}) {
  const r = run(binary, args, options);
  const text = String(r.stdout || "").trim();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, stdout: text, stderr: String(r.stderr || "").trim(), json };
}
function exactIdentity(info) {
  if (!info || info.ok !== true) return null;
  if (!Number.isInteger(info.pid) || !Number.isInteger(info.start_sec) || !Number.isInteger(info.start_usec)) return null;
  return { pid: info.pid, sec: info.start_sec, usec: info.start_usec };
}
function sameIdentity(a, b) {
  return !!a && !!b && a.pid === b.pid && a.sec === b.sec && a.usec === b.usec;
}
async function waitGone(binary, pid, timeout = 5000) {
  await waitFor(() => {
    const q = helper(binary, ["process", String(pid)]);
    return q.json && q.json.ok === false;
  }, timeout, `pid ${pid} to disappear`);
}
function killQuiet(pid, signal = "SIGKILL", group = false) {
  try { process.kill(group ? -pid : pid, signal); } catch {}
}
function write(file, body) { fs.writeFileSync(file, body, "utf8"); }

async function main() {
  assert.equal(process.platform, "darwin", "MAC-03 requires macOS");
  const expectedArchitecture = macosMachOArchitectureForNodeArch(process.arch);
  assert.ok(expectedArchitecture, `MAC-03 requires native arm64/x64 Node; got ${process.arch}`);

  const repo = path.resolve(__dirname, "..");
  const source = path.join(__dirname, "macos-process-info.c");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-mac03-"));
  const binary = path.join(tmp, "macos-process-info");
  const mountPoint = path.join(tmp, "case-sensitive");
  const image = path.join(tmp, "case-sensitive.dmg");
  let attached = false;
  const owned = new Set();

  try {
    const compile = run("/usr/bin/xcrun", [
      "clang", "-arch", expectedArchitecture, "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0",
      source, "-o", binary
    ], { timeout: 30000 });
    assert.equal(compile.status, 0, `helper compile failed: ${compile.stderr}`);

    // Sparse GUI/LaunchAgent-like environment: the helper is an absolute binary
    // and must not depend on PATH, HOME or shell startup.
    const sparseSelf = helper(binary, ["process", String(process.pid)], { env: {} });
    assert.equal(sparseSelf.status, 0, sparseSelf.stderr);
    assert.equal(sparseSelf.json.ok, true);

    const boot = helper(binary, ["boot"]);
    assert.equal(boot.status, 0, boot.stderr);
    assert.equal(boot.json.ok, true);

    const leaf = path.join(tmp, "leaf.cjs");
    const childScript = path.join(tmp, "child.cjs");
    const parentScript = path.join(tmp, "parent.cjs");
    const topologyFile = path.join(tmp, "topology.json");
    const childFile = path.join(tmp, "child.json");

    write(leaf, [
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);"
    ].join("\n"));
    write(childScript, [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      "const g=spawn(process.execPath,[process.env.LEAF],{stdio:'ignore',windowsHide:true});",
      "fs.writeFileSync(process.env.CHILD_FILE,JSON.stringify({childPid:process.pid,grandchildPid:g.pid}));",
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);"
    ].join("\n"));
    write(parentScript, [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      "const c=spawn(process.execPath,[process.env.CHILD_SCRIPT],{stdio:'ignore',env:{...process.env},windowsHide:true});",
      "const e=spawn(process.execPath,[process.env.LEAF],{stdio:'ignore',detached:true,windowsHide:true}); e.unref();",
      "const deadline=Date.now()+5000;",
      "while(!fs.existsSync(process.env.CHILD_FILE)){if(Date.now()>deadline)throw new Error('child timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20)}",
      "const child=JSON.parse(fs.readFileSync(process.env.CHILD_FILE,'utf8'));",
      "fs.writeFileSync(process.env.TOPOLOGY_FILE,JSON.stringify({parentPid:process.pid,childPid:child.childPid,grandchildPid:child.grandchildPid,escapedPid:e.pid}));",
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);"
    ].join("\n"));

    const parent = spawn(process.execPath, [parentScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        LEAF: leaf,
        CHILD_SCRIPT: childScript,
        CHILD_FILE: childFile,
        TOPOLOGY_FILE: topologyFile
      }
    });
    assert.ok(parent.pid);
    owned.add(parent.pid);
    await waitFor(() => fs.existsSync(topologyFile), 5000, "process topology");
    const top = JSON.parse(fs.readFileSync(topologyFile, "utf8"));
    for (const key of ["parentPid", "childPid", "grandchildPid", "escapedPid"]) {
      assert.ok(Number.isInteger(top[key]) && top[key] > 0, `${key} present`);
      owned.add(top[key]);
    }

    const initial = {};
    for (const [name, pid] of Object.entries(top)) {
      const q = helper(binary, ["process", String(pid)]);
      assert.equal(q.status, 0, `${name}: ${q.stderr}`);
      initial[name] = q.json;
      const id = exactIdentity(q.json);
      assert.ok(id, `${name} has exact birth identity`);
      const plusOneUsec = { ...id, usec: id.usec === 999999 ? 999998 : id.usec + 1 };
      assert.equal(sameIdentity(id, plusOneUsec), false, "one-microsecond birth change is PID reuse");
      assert.equal(sameIdentity(id, null), false, "unknown identity never matches");
    }

    assert.equal(initial.parentPid.pgid, top.parentPid);
    assert.equal(initial.parentPid.sid, top.parentPid);
    assert.equal(initial.childPid.pgid, top.parentPid, "child stays in parent process group");
    assert.equal(initial.childPid.sid, top.parentPid, "child stays in parent session");
    assert.equal(initial.grandchildPid.pgid, top.parentPid, "grandchild stays in parent group");
    assert.equal(initial.grandchildPid.sid, top.parentPid, "grandchild stays in parent session");
    assert.equal(initial.escapedPid.pgid, top.escapedPid, "escaped descendant owns another group");
    assert.equal(initial.escapedPid.sid, top.escapedPid, "escaped descendant owns another session");

    for (const info of Object.values(initial)) {
      assert.ok(info.start_sec * 1000000 + info.start_usec >
        boot.json.sec * 1000000 + boot.json.usec, "process birth is after current boot");
    }

    // Root death is not tree death.
    killQuiet(top.parentPid);
    await waitGone(binary, top.parentPid);
    const childAfterRoot = helper(binary, ["process", String(top.childPid)]).json;
    const grandAfterRoot = helper(binary, ["process", String(top.grandchildPid)]).json;
    const escapedAfterRoot = helper(binary, ["process", String(top.escapedPid)]).json;
    assert.equal(childAfterRoot.ok, true, "child survives dead root");
    assert.equal(grandAfterRoot.ok, true, "grandchild survives dead root");
    assert.equal(escapedAfterRoot.ok, true, "escaped descendant survives dead root");

    // Killing the old process group cleans the in-group descendants only.
    killQuiet(top.parentPid, "SIGKILL", true);
    await waitGone(binary, top.childPid);
    await waitGone(binary, top.grandchildPid);
    assert.equal(helper(binary, ["process", String(top.escapedPid)]).json.ok, true,
      "escaped new-session descendant survives the old group kill");

    // Exact owned cleanup of escaped descendant.
    killQuiet(top.escapedPid, "SIGKILL", true);
    await waitGone(binary, top.escapedPid);
    owned.clear();

    // A process that ignores TERM proves TERM delivery is not exit proof.
    const termReady = path.join(tmp, "term-ready");
    const termScript = path.join(tmp, "term.cjs");
    write(termScript, [
      "const fs=require('node:fs');",
      "process.on('SIGTERM',()=>{});",
      "fs.writeFileSync(process.env.READY,'ready');",
      "setInterval(()=>{},1000);"
    ].join("\n"));
    const termChild = spawn(process.execPath, [termScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, READY: termReady }
    });
    assert.ok(termChild.pid);
    owned.add(termChild.pid);
    await waitFor(() => fs.existsSync(termReady), 5000, "TERM fixture");
    const termBefore = exactIdentity(helper(binary, ["process", String(termChild.pid)]).json);
    assert.ok(termBefore);
    killQuiet(termChild.pid, "SIGTERM", true);
    await sleep(250);
    const termAfter = exactIdentity(helper(binary, ["process", String(termChild.pid)]).json);
    assert.equal(sameIdentity(termBefore, termAfter), true, "ignored TERM leaves same incarnation alive");
    killQuiet(termChild.pid, "SIGKILL", true);
    await waitGone(binary, termChild.pid);
    owned.delete(termChild.pid);

    // Default filesystem: record the actual case/Unicode behavior and verify
    // canonicalWorkspacePath follows the filesystem's real path.
    const workspace = require(path.join(repo, "dist", "jobs", "workspace.js"));
    const defaultFsDir = path.join(tmp, "default-fs");
    fs.mkdirSync(defaultFsDir);
    const mixed = path.join(defaultFsDir, "CaseProbe");
    fs.mkdirSync(mixed);
    const lower = path.join(defaultFsDir, "caseprobe");
    const defaultCaseInsensitive = fs.existsSync(lower);
    if (defaultCaseInsensitive) {
      assert.equal(workspace.canonicalWorkspacePath(mixed), workspace.canonicalWorkspacePath(lower));
      assert.equal(workspace.workspaceKey(workspace.canonicalWorkspacePath(mixed)),
        workspace.workspaceKey(workspace.canonicalWorkspacePath(lower)));
    }

    const symlinkAlias = path.join(defaultFsDir, "symlink-alias");
    fs.symlinkSync(mixed, symlinkAlias, "dir");
    assert.equal(
      workspace.canonicalWorkspacePath(symlinkAlias),
      workspace.canonicalWorkspacePath(mixed),
      "a macOS symlink alias resolves to the same workspace"
    );
    assert.equal(
      workspace.workspaceKey(workspace.canonicalWorkspacePath(symlinkAlias)),
      workspace.workspaceKey(workspace.canonicalWorkspacePath(mixed)),
      "a macOS symlink alias has the same workspace key"
    );

    const nfcName = "\u00e9";
    const nfdName = "e\u0301";
    const nfcPath = path.join(defaultFsDir, nfcName);
    fs.mkdirSync(nfcPath);
    const unicodeAlias = fs.existsSync(path.join(defaultFsDir, nfdName));
    if (unicodeAlias) {
      assert.equal(
        workspace.canonicalWorkspacePath(nfcPath),
        workspace.canonicalWorkspacePath(path.join(defaultFsDir, nfdName)),
        "Unicode-normalization aliases resolve to one real workspace"
      );
    }

    // Real case-sensitive APFS image, unprivileged and disposable.
    fs.mkdirSync(mountPoint);
    const create = run("/usr/bin/hdiutil", [
      "create", "-quiet", "-size", "32m", "-fs", "Case-sensitive APFS",
      "-volname", "CrewDispatchCase", image
    ], { timeout: 30000 });
    assert.equal(create.status, 0, `hdiutil create: ${create.stderr}`);
    const attach = run("/usr/bin/hdiutil", [
      "attach", "-quiet", "-nobrowse", "-mountpoint", mountPoint, image
    ], { timeout: 30000 });
    assert.equal(attach.status, 0, `hdiutil attach: ${attach.stderr}`);
    attached = true;

    const upperCs = path.join(mountPoint, "Foo");
    const lowerCs = path.join(mountPoint, "foo");
    fs.mkdirSync(upperCs);
    fs.mkdirSync(lowerCs);
    assert.notEqual(workspace.canonicalWorkspacePath(upperCs), workspace.canonicalWorkspacePath(lowerCs));
    assert.notEqual(
      workspace.workspaceKey(workspace.canonicalWorkspacePath(upperCs)),
      workspace.workspaceKey(workspace.canonicalWorkspacePath(lowerCs)),
      "case-sensitive APFS keeps distinct directories distinct"
    );

    const receipt = {
      kind: "macos-process-adversarial-v1",
      platform: process.platform,
      arch: process.arch,
      macos_release: os.release(),
      node: process.version,
      boot: boot.json,
      topology: {
        initial: {
          parent: initial.parentPid,
          child: initial.childPid,
          grandchild: initial.grandchildPid,
          escaped: initial.escapedPid
        },
        dead_root_descendants_survived: true,
        old_group_killed_in_group_descendants: true,
        escaped_descendant_survived_old_group: true
      },
      identity: {
        microsecond_difference_is_reuse: true,
        unknown_identity_never_matches: true
      },
      ignored_term: true,
      sparse_environment_helper: true,
      filesystem: {
        default_case_insensitive_observed: defaultCaseInsensitive,
        symlink_alias_same_workspace: true,
        unicode_normalization_alias_observed: unicodeAlias,
        case_sensitive_apfs_distinct_paths: true
      }
    };
    process.stdout.write(`MACOS_ADVERSARIAL_RECEIPT=${JSON.stringify(receipt)}\n`);
  } finally {
    for (const pid of owned) {
      killQuiet(pid, "SIGKILL", true);
      killQuiet(pid);
    }
    if (attached) run("/usr/bin/hdiutil", ["detach", "-quiet", mountPoint], { timeout: 30000 });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
