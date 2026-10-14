#!/usr/bin/env node
// MAC-14 native APFS workspace-identity receipt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function run(program, args, options = {}) {
  return spawnSync(program, args, {
    encoding: "utf8",
    timeout: options.timeout || 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
}

async function main() {
  assert.equal(process.platform, "darwin", "MAC-14 native probe requires macOS");
  assert.ok(["arm64", "x64"].includes(process.arch), `MAC-14 requires native arm64/x64 Node; got ${process.arch}`);

  const repo = path.resolve(__dirname, "..");
  const workspace = require(path.join(repo, "dist", "jobs", "workspace.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-mac-workspace-id-"));
  const image = path.join(tmp, "case-sensitive.dmg");
  const mountPoint = path.join(tmp, "case-sensitive-mount");
  let attached = false;

  try {
    const defaultDir = path.join(tmp, "default");
    fs.mkdirSync(defaultDir);

    const mixed = path.join(defaultDir, "CaseProbe");
    fs.mkdirSync(mixed);
    const mixedIdentity = workspace.resolveWorkspaceIdentity(mixed);
    assert.equal(mixedIdentity.source, "filesystem");
    assert.match(String(mixedIdentity.persistentIdentity), /^darwin-fs:\d+:\d+$/);

    const symlinkAlias = path.join(defaultDir, "symlink-alias");
    fs.symlinkSync(mixed, symlinkAlias, "dir");
    const symlinkIdentity = workspace.resolveWorkspaceIdentity(symlinkAlias);
    assert.equal(symlinkIdentity.persistentIdentity, mixedIdentity.persistentIdentity);
    assert.equal(symlinkIdentity.primaryKey, mixedIdentity.primaryKey);

    const lower = path.join(defaultDir, "caseprobe");
    const defaultCaseInsensitive = fs.existsSync(lower);
    if (defaultCaseInsensitive) {
      const lowerIdentity = workspace.resolveWorkspaceIdentity(lower);
      assert.equal(lowerIdentity.persistentIdentity, mixedIdentity.persistentIdentity);
      assert.equal(lowerIdentity.primaryKey, mixedIdentity.primaryKey);
    }

    const nfc = path.join(defaultDir, "\u00e9");
    const nfd = path.join(defaultDir, "e\u0301");
    fs.mkdirSync(nfc);
    const unicodeAlias = fs.existsSync(nfd);
    if (unicodeAlias) {
      const nfcIdentity = workspace.resolveWorkspaceIdentity(nfc);
      const nfdIdentity = workspace.resolveWorkspaceIdentity(nfd);
      assert.equal(nfcIdentity.persistentIdentity, nfdIdentity.persistentIdentity);
      assert.equal(nfcIdentity.primaryKey, nfdIdentity.primaryKey);
    }

    const beforeRename = workspace.resolveWorkspaceIdentity(mixed);
    const renamed = path.join(defaultDir, "RenamedProbe");
    fs.unlinkSync(symlinkAlias);
    fs.renameSync(mixed, renamed);
    const afterRename = workspace.resolveWorkspaceIdentity(renamed);
    assert.equal(afterRename.persistentIdentity, beforeRename.persistentIdentity);
    assert.equal(afterRename.primaryKey, beforeRename.primaryKey);
    assert.notEqual(afterRename.legacyKey, beforeRename.legacyKey);

    const missing = workspace.resolveWorkspaceIdentity(path.join(defaultDir, "missing"));
    assert.equal(missing.source, "path_fallback");
    assert.equal(missing.persistentIdentity, null);
    assert.equal(missing.primaryKey, missing.legacyKey);

    fs.mkdirSync(mountPoint);
    const create = run("/usr/bin/hdiutil", [
      "create", "-quiet", "-size", "32m", "-fs", "Case-sensitive APFS",
      "-volname", "CrewDispatchWorkspace", image
    ]);
    assert.equal(create.status, 0, `hdiutil create: ${create.stderr}`);
    const attach = run("/usr/bin/hdiutil", [
      "attach", "-quiet", "-nobrowse", "-mountpoint", mountPoint, image
    ]);
    assert.equal(attach.status, 0, `hdiutil attach: ${attach.stderr}`);
    attached = true;

    const upperCs = path.join(mountPoint, "Foo");
    const lowerCs = path.join(mountPoint, "foo");
    fs.mkdirSync(upperCs);
    fs.mkdirSync(lowerCs);
    const upperIdentity = workspace.resolveWorkspaceIdentity(upperCs);
    const lowerIdentity = workspace.resolveWorkspaceIdentity(lowerCs);
    assert.equal(upperIdentity.source, "filesystem");
    assert.equal(lowerIdentity.source, "filesystem");
    assert.notEqual(upperIdentity.persistentIdentity, lowerIdentity.persistentIdentity);
    assert.notEqual(upperIdentity.primaryKey, lowerIdentity.primaryKey);
    assert.notEqual(upperIdentity.canonicalCwd, lowerIdentity.canonicalCwd);

    const receipt = {
      kind: "macos-workspace-identity-v1",
      platform: process.platform,
      arch: process.arch,
      macos_release: os.release(),
      node: process.version,
      filesystem: {
        default_case_insensitive_observed: defaultCaseInsensitive,
        unicode_normalization_alias_observed: unicodeAlias,
        symlink_alias_same_identity: true,
        rename_preserves_primary_identity: true,
        rename_changes_legacy_path_key: true,
        missing_path_falls_back_to_legacy_key: true,
        case_sensitive_apfs_distinct_identity: true
      }
    };
    process.stdout.write(`MACOS_WORKSPACE_IDENTITY_RECEIPT=${JSON.stringify(receipt)}\n`);
  } finally {
    if (attached) {
      run("/usr/bin/hdiutil", ["detach", "-quiet", mountPoint]);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
