import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserNodeRuntime } from "../../install/node-runtime";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BUILDER = path.join(REPO_ROOT, "scripts", "build-release-candidate.cjs");
const CLEANROOM_VERIFIER = path.join(REPO_ROOT, "scripts", "verify-release-candidate.cjs");
const { macosMachOArchitectureForNodeArch, macosHelperArchitecturesMatchNodeArch } = require(path.join(REPO_ROOT, "scripts", "macos-architecture.cjs")) as {
  macosMachOArchitectureForNodeArch(nodeArch: string): string | null;
  macosHelperArchitecturesMatchNodeArch(architectures: string[] | null, nodeArch: string): boolean;
};

interface CandidateReport {
  releaseEligible: boolean;
  internalOnly: boolean;
  gitDirty: boolean;
  candidateMetadataValid: boolean;
  publicDistributionApproved: boolean;
  providerScope: string;
  providersBundled: boolean;
  npmPublishBlocked: boolean;
  distributionForm: {
    kind: string;
    signing: string;
    developerIdRequired: boolean;
    notarizationRequired: boolean;
    gatekeeperUserConfirmationRequired: boolean;
  };
  productLicense: { path: string; spdx: string; bytes: number; sha256: string };
  buildHost: { platform: string; arch: string };
  candidateScope: { platform: string; architectures: string[] };
  commandEntrypoints: { name: string; archiveEntry: string }[];
  notices: { path: string; bytes: number; sha256: string }[];
  nativeArtifacts: {
    path: string;
    format: string;
    architectures: string[];
    mode: number;
    bytes: number;
    sha256: string;
    signature: { kind: string; teamIdentifier: string | null; cdHashSha256: string | null };
  }[];
  archive: { path: string; sha256: string; bytes: number; posixModes: string };
  files: { path: string; mode: number; bytes: number; sha256: string }[];
  releaseBlockers: string[];
}

function runNode(entry: string, args: string[], cwd: string, env = process.env) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  assert.ifError(result.error);
  return result;
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function writeCommandCodeShim(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const shimPath = path.join(directory, process.platform === "win32" ? "cmdc.cmd" : "cmdc");
  const body = process.platform === "win32"
    ? [
        "@echo off",
        'if "%~1"=="--version" (echo 1.2.3& exit /b 0)',
        'if "%~1"=="--help" (echo Usage: cmdc --list-models& exit /b 0)',
        'if "%~1"=="--list-models" (echo provider/free-model& exit /b 0)',
        "exit /b 3",
        ""
      ].join("\r\n")
    : [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi',
        'if [ "$1" = "--help" ]; then echo "Usage: cmdc --list-models"; exit 0; fi',
        'if [ "$1" = "--list-models" ]; then echo provider/free-model; exit 0; fi',
        "exit 3",
        ""
      ].join("\n");
  fs.writeFileSync(shimPath, body, "utf8");
  if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

test("macOS candidate architecture mapping is exact and fail-closed", () => {
  assert.equal(macosMachOArchitectureForNodeArch("arm64"), "arm64");
  assert.equal(macosMachOArchitectureForNodeArch("x64"), "x86_64");
  assert.equal(macosMachOArchitectureForNodeArch("ia32"), null);
  assert.equal(macosHelperArchitecturesMatchNodeArch(["arm64"], "arm64"), true);
  assert.equal(macosHelperArchitecturesMatchNodeArch(["x86_64"], "x64"), true);
  assert.equal(macosHelperArchitecturesMatchNodeArch(["arm64"], "x64"), false);
  assert.equal(macosHelperArchitecturesMatchNodeArch(["x86_64"], "arm64"), false);
  assert.equal(macosHelperArchitecturesMatchNodeArch(["arm64", "x86_64"], "arm64"), false);
  assert.equal(macosHelperArchitecturesMatchNodeArch(null, "arm64"), false);
});

test("internal release candidate archive installs, diagnoses, upgrades and uninstalls from one independently unpacked root", { skip: process.platform !== "win32" && process.platform !== "darwin" }, () => {
  const tempBase = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const tempRoot = fs.mkdtempSync(path.join(tempBase, "jobquay-release-candidate-"));
  const outputDir = path.join(tempRoot, "out");
  const unpacked = path.join(tempRoot, "unpacked");
  const foreignCwd = path.join(tempRoot, "foreign-cwd");
  const target = path.join(tempRoot, "install");
  const dataRoot = path.join(tempRoot, "data");
  fs.mkdirSync(foreignCwd, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, "release-sentinel.txt");
  fs.writeFileSync(sentinel, "keep-me\n", "utf8");
  const sentinelHash = crypto.createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex");

  try {
    const built = runNode(BUILDER, ["--allow-dirty", "--scope", "command-code+workbuddy-ai", "--output-dir", outputDir], foreignCwd);
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const report = JSON.parse(built.stdout) as CandidateReport;
    const secondOutputDir = path.join(tempRoot, "out-second");
    const builtAgain = runNode(BUILDER, ["--allow-dirty", "--scope", "command-code+workbuddy-ai", "--output-dir", secondOutputDir], foreignCwd);
    assert.equal(builtAgain.status, 0, builtAgain.stderr || builtAgain.stdout);
    const secondReport = JSON.parse(builtAgain.stdout) as CandidateReport;
    assert.equal(secondReport.archive.sha256, report.archive.sha256, "same source bytes must produce the same candidate hash");
    assert.equal(secondReport.archive.bytes, report.archive.bytes);
    assert.deepEqual(fs.readFileSync(secondReport.archive.path), fs.readFileSync(report.archive.path));
    assert.equal(report.internalOnly, true);
    assert.equal(report.releaseEligible, false);
    assert.equal(report.publicDistributionApproved, false);
    assert.equal(report.providerScope, "command-code+workbuddy-ai");
    assert.equal(report.providersBundled, false);
    assert.equal(report.npmPublishBlocked, true, "private:true blocks accidental npm publication without blocking GitHub ZIP licensing");
    assert.equal(report.distributionForm.kind, "github-zip");
    assert.equal(report.distributionForm.developerIdRequired, false);
    assert.equal(report.distributionForm.notarizationRequired, false);
    assert.ok(report.releaseBlockers.some((value) => value.includes("public release acceptance gates")));
    assert.equal(report.releaseBlockers.some((value) => /package\.json is private/i.test(value)), false);
    assert.equal(report.releaseBlockers.some((value) => /license.*not selected|UNLICENSED/i.test(value)), false);
    assert.equal(report.releaseBlockers.some((value) => /versions are not aligned/i.test(value)), false);
    assert.equal(report.releaseBlockers.some((value) => /provider-scope exposure alignment/i.test(value)), false);
    assert.equal(report.releaseBlockers.some((value) => /signing\/notarization/i.test(value)), false);
    assert.ok(path.isAbsolute(report.archive.path));
    assert.ok(fs.existsSync(report.archive.path));
    const archive = fs.readFileSync(report.archive.path);
    assert.equal(crypto.createHash("sha256").update(archive).digest("hex"), report.archive.sha256);
    assert.equal(archive.length, report.archive.bytes);
    assert.match(path.basename(report.archive.path), new RegExp(`-${process.platform}-${process.arch}-`));
    assert.deepEqual(report.buildHost, { platform: process.platform, arch: process.arch });
    assert.equal(report.archive.posixModes, "unix-external-attributes");
    assert.deepEqual(
      report.commandEntrypoints,
      [
        { name: "crewdispatch", archiveEntry: "dist/cli/crewdispatch-cli.js" },
        { name: "jobquay", archiveEntry: "dist/cli/jobquay-cli.js" }
      ]
    );
    assert.equal(report.notices.length, 1);
    assert.equal(report.notices[0]!.path, "THIRD_PARTY_NOTICES");
    assert.match(report.notices[0]!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.productLicense.path, "LICENSE");
    assert.equal(report.productLicense.spdx, "Apache-2.0");
    assert.match(report.productLicense.sha256, /^[a-f0-9]{64}$/);

    const files = new Set(report.files.map((file) => file.path));
    for (const required of [
      "dist/cli/install-cli.js",
      "dist/mcp/server.js",
      "dist/hub/server.js",
      "dist/ui/client.js",
      "integrations/claude/commands/crewdispatch.md",
      "integrations/codex/prompts/crewdispatch.md",
      "scripts/install-codex-command.cjs",
      "scripts/uninstall-codex-command.cjs",
      "plugins/crewdispatch/.codex-plugin/plugin.json",
      "plugins/crewdispatch/skills/crewdispatch/SKILL.md",
      "plugins/crewdispatch/mcp.template.json",
      "package.json",
      "package-lock.json",
      "LICENSE",
      "THIRD_PARTY_NOTICES"
    ]) {
      assert.equal(files.has(required), true, `candidate manifest missing ${required}`);
    }
    assert.equal([...files].some((file) => file.startsWith("dist/tests/")), false);
    assert.equal([...files].some((file) => file === ".env" || file.startsWith(".env.") || file.startsWith(".git/")), false);
    if (process.platform === "darwin") {
      const expectedArchitecture = macosMachOArchitectureForNodeArch(process.arch);
      assert.ok(expectedArchitecture, `supported Darwin Node architecture: ${process.arch}`);
      assert.deepEqual(report.candidateScope, { platform: "darwin", architectures: [expectedArchitecture] });
      const helperManifest = report.files.find((file) => file.path === "dist/native/macos-process-info");
      assert.ok(helperManifest, "candidate manifest includes the native process helper");
      assert.equal((helperManifest!.mode & 0o111) !== 0, true, "candidate manifest records an executable helper mode");
      const native = report.nativeArtifacts.find((file) => file.path === "dist/native/macos-process-info");
      assert.ok(native, "candidate native inventory includes the process helper");
      assert.equal(native!.format, "mach-o");
      assert.deepEqual(native!.architectures, [expectedArchitecture]);
      assert.equal(native!.mode, helperManifest!.mode);
      assert.equal(native!.sha256, helperManifest!.sha256);
      assert.ok(
        ["unsigned", "adhoc", "signed"].includes(native!.signature.kind),
        `unexpected helper signature kind: ${native!.signature.kind}`
      );
      if (native!.signature.kind === "unsigned") {
        assert.equal(native!.signature.cdHashSha256, null, "an unsigned helper has no CodeDirectory hash");
      } else {
        assert.match(String(native!.signature.cdHashSha256 || ""), /^[a-f0-9]{40,64}$/);
      }
      assert.equal(report.distributionForm.signing, "unsigned-or-adhoc");
      assert.equal(report.distributionForm.gatekeeperUserConfirmationRequired, true);
    } else {
      assert.equal(report.nativeArtifacts.length, 0);
    }

    fs.mkdirSync(unpacked, { recursive: true });
    const expand = process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${psQuote(report.archive.path)} -DestinationPath ${psQuote(unpacked)} -Force`],
          { cwd: foreignCwd, encoding: "utf8", timeout: 120000, windowsHide: true }
        )
      : spawnSync("/usr/bin/ditto", ["-x", "-k", report.archive.path, unpacked], {
          cwd: foreignCwd,
          encoding: "utf8",
          timeout: 120000,
          windowsHide: true
        });
    assert.ifError(expand.error);
    assert.equal(expand.status, 0, expand.stderr);

    const unpackedInstaller = path.join(unpacked, "dist", "cli", "install-cli.js");
    assert.equal(fs.existsSync(unpackedInstaller), true);
    assert.equal(fs.existsSync(path.join(unpacked, "dist", "tests")), false);
    const unpackedLicense = fs.readFileSync(path.join(unpacked, "LICENSE"), "utf8");
    assert.match(unpackedLicense, /Apache License/);
    assert.match(unpackedLicense, /Version 2\.0, January 2004/);
    assert.match(unpackedLicense, /END OF TERMS AND CONDITIONS/);
    // The Claude caller command asset travels with the candidate: the packaged
    // runtime is the source root a packaged `claude-install` reads.
    assert.equal(fs.existsSync(path.join(unpacked, "integrations", "claude", "commands", "crewdispatch.md")), true);
    if (process.platform === "darwin") {
      const helper = path.join(unpacked, "dist", "native", "macos-process-info");
      assert.equal(fs.existsSync(helper), true);
      assert.equal((fs.statSync(helper).mode & 0o111) !== 0, true, "unpack preserves the native helper executable bit");
      const helperProbe = spawnSync(helper, ["process", String(process.pid)], {
        cwd: foreignCwd,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      });
      assert.ifError(helperProbe.error);
      assert.equal(helperProbe.status, 0, helperProbe.stderr || helperProbe.stdout);
      const helperReply = JSON.parse(helperProbe.stdout || "{}") as Record<string, unknown>;
      assert.equal(helperReply.ok, true);
      assert.equal(helperReply.op, "process");
      assert.equal(Number(helperReply.pid), process.pid);
    }

    const env = {
      ...process.env,
      JOBQUAY_DATA_ROOT: dataRoot,
      JOBQUAY_CLI_AUTODISCOVER: "false",
      JOBQUAY_COMMAND_CODE_CLI_PATH: writeCommandCodeShim(path.join(tempRoot, "command-code-shim")),
      // Never write a real HKCU Run value or real macOS LaunchAgent from this automated test.
      JOBQUAY_TEST_AUTOSTART_REGISTRY: path.join(tempRoot, "autostart-registry.json"),
      JOBQUAY_TEST_LAUNCHAGENT_DIR: path.join(tempRoot, "LaunchAgents"),
      JOBQUAY_TEST_LAUNCHCTL_STATE: path.join(tempRoot, "launchctl-state.json")
    };
    const installed = runNode(unpackedInstaller, ["install", "--target", target], foreignCwd, env);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const installJson = JSON.parse(installed.stdout) as Record<string, unknown>;
    assert.equal(installJson.ok, true);
    assert.equal((installJson.productLicense as Record<string, unknown>).spdx, "Apache-2.0");
    assert.equal((installJson.productLicense as Record<string, unknown>).path, "LICENSE");
    assert.equal(fs.readFileSync(path.join(target, "LICENSE"), "utf8"), unpackedLicense);
    assert.equal(fs.existsSync(path.join(target, "dist", "tests")), false);
    assert.equal(
      fs.existsSync(path.join(target, "integrations", "claude", "commands", "crewdispatch.md")),
      true,
      "the installed runtime must carry the Claude caller command asset"
    );

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(target, "plugins", "crewdispatch", ".mcp.json"), "utf8")) as {
      mcpServers: { crewdispatch: { command: string; args: string[] } };
    };
    assert.equal(path.resolve(mcpConfig.mcpServers.crewdispatch.command), path.resolve(resolveUserNodeRuntime()!.path));
    assert.equal(path.resolve(mcpConfig.mcpServers.crewdispatch.args[0]!), path.join(target, "dist", "mcp", "server.js"));
    assert.equal(mcpConfig.mcpServers.crewdispatch.args[0]!.startsWith(unpacked), false, "installed MCP entry must not point back to the unpacked candidate");

    for (const name of ["crewdispatch", "jobquay"]) {
      const wrapper = path.join(target, "bin", process.platform === "win32" ? `${name}.cmd` : name);
      assert.equal(fs.existsSync(wrapper), true, `installed ${name} wrapper exists`);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755, `installed ${name} wrapper keeps mode 0755`);
      }
      const help = process.platform === "win32"
        ? spawnSync(
            process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
            ["/d", "/s", "/v:off", "/c", `"\"${wrapper}\" \"--help\""`],
            { cwd: foreignCwd, env, encoding: "utf8", timeout: 10_000, windowsHide: true, windowsVerbatimArguments: true }
          )
        : spawnSync(wrapper, ["--help"], { cwd: foreignCwd, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
      assert.ifError(help.error);
      assert.equal(help.status, 0, String(help.stderr || help.stdout));
      assert.match(String(help.stdout || ""), /CrewDispatch/);
    }

    const mismatchRoot = path.join(tempRoot, "hash-mismatch-must-not-exist");
    const badHash = runNode(
      CLEANROOM_VERIFIER,
      ["--archive", report.archive.path, "--sha256", "0".repeat(64), "--root", mismatchRoot],
      foreignCwd
    );
    assert.notEqual(badHash.status, 0, "hash mismatch must fail before extraction");
    const badHashJson = JSON.parse(badHash.stdout) as Record<string, unknown>;
    assert.equal(badHashJson.ok, false);
    assert.match(String((badHashJson.error as Record<string, unknown>)?.message || ""), /SHA-256 mismatch/);
    assert.equal(fs.existsSync(mismatchRoot), false, "hash mismatch must not create the requested extraction root");

    const cleanroomRoot = path.join(tempRoot, "cleanroom-verifier-root");
    const cleanroom = runNode(
      CLEANROOM_VERIFIER,
      ["--archive", report.archive.path, "--sha256", report.archive.sha256, "--root", cleanroomRoot],
      foreignCwd
    );
    assert.equal(cleanroom.status, 0, cleanroom.stderr || cleanroom.stdout);
    const cleanroomJson = JSON.parse(cleanroom.stdout) as Record<string, unknown>;
    assert.equal(cleanroomJson.ok, true);
    assert.equal(cleanroomJson.providerAuthenticatedChecked, false);
    assert.equal(cleanroomJson.gatekeeperChecked, false);
    assert.equal(cleanroomJson.cleanOsAssumed, false);
    assert.equal(cleanroomJson.providerProbeMode, "stubbed-command-code-metadata-only");
    assert.equal(cleanroomJson.packageVersion, "0.1.2");
    assert.equal((cleanroomJson.archive as Record<string, unknown>).sha256, report.archive.sha256);
    assert.equal(cleanroomJson.doctorStatus, "healthy");
    assert.equal((cleanroomJson.wrapperChecks as unknown[]).length, 2);
    assert.equal((cleanroomJson.uninstall as Record<string, unknown>).ok, true);
    assert.equal(cleanroomJson.dataHashBefore, cleanroomJson.dataHashAfter);
    assert.deepEqual(cleanroomJson.stagingResidue, []);

    const installedInstaller = path.join(target, "dist", "cli", "install-cli.js");
    const doctor = runNode(installedInstaller, ["doctor", "--target", target], foreignCwd, env);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorJson = JSON.parse(doctor.stdout) as Record<string, unknown>;
    assert.equal(doctorJson.ok, true, JSON.stringify(doctorJson));
    assert.equal(doctorJson.status, "healthy");

    const operatorFile = path.join(target, "operator-candidate-note.txt");
    fs.writeFileSync(operatorFile, "preserve-me\n", "utf8");
    const beforeMarker = JSON.parse(fs.readFileSync(path.join(target, ".jobquay-install.json"), "utf8")) as { installId: string };
    const upgraded = runNode(unpackedInstaller, ["upgrade", "--target", target], foreignCwd, env);
    assert.equal(upgraded.status, 0, upgraded.stderr || upgraded.stdout);
    const afterMarker = JSON.parse(fs.readFileSync(path.join(target, ".jobquay-install.json"), "utf8")) as { installId: string };
    assert.equal(afterMarker.installId, beforeMarker.installId, "candidate upgrade keeps the managed install identity");
    assert.equal(fs.readFileSync(operatorFile, "utf8"), "preserve-me\n", "candidate upgrade preserves unowned operator files");

    const postUpgradeDoctor = runNode(installedInstaller, ["doctor", "--target", target], foreignCwd, env);
    assert.equal(postUpgradeDoctor.status, 0, postUpgradeDoctor.stderr || postUpgradeDoctor.stdout);
    assert.equal((JSON.parse(postUpgradeDoctor.stdout) as Record<string, unknown>).ok, true);

    const removed = runNode(installedInstaller, ["uninstall", "--target", target], foreignCwd, env);
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    const uninstallJson = JSON.parse(removed.stdout) as Record<string, unknown>;
    assert.equal(uninstallJson.ok, true);
    assert.equal(fs.existsSync(operatorFile), true, "candidate uninstall preserves unowned operator files");
    assert.equal(fs.readFileSync(operatorFile, "utf8"), "preserve-me\n");
    if (process.platform === "darwin") {
      assert.equal(fs.existsSync(path.join(tempRoot, "LaunchAgents", "com.crewdispatch.dashboard.plist")), false, "candidate uninstall removes its exact test LaunchAgent");
    }

    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep-me\n");
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex"), sentinelHash);
    const residue = fs.readdirSync(tempRoot).filter((name) => name.startsWith(".jobquay-stage-") || name.startsWith(".jobquay-backup-"));
    assert.deepEqual(residue, [], `installer left staging residue: ${JSON.stringify(residue)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
