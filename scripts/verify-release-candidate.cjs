#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function usage() {
  process.stdout.write(
    "usage: node scripts/verify-release-candidate.cjs --archive <candidate.zip> --sha256 <64-hex> [--root <empty-dir>] [--keep-root]\n"
  );
}

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function parseArgs(argv) {
  const out = { archive: null, sha256: null, root: null, keepRoot: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--archive") out.archive = argv[++i] || null;
    else if (arg === "--sha256") out.sha256 = argv[++i] || null;
    else if (arg === "--root") out.root = argv[++i] || null;
    else if (arg === "--keep-root") out.keepRoot = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else fail("unknown argument", { argument: arg });
  }
  if (!out.archive) fail("--archive is required");
  if (!out.sha256 || !/^[a-f0-9]{64}$/i.test(out.sha256)) fail("--sha256 must be exactly 64 hexadecimal characters");
  return { ...out, sha256: out.sha256.toLowerCase() };
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { fail(label + " does not exist", { path: file }); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(label + " must be a regular file", { path: file });
  return stat;
}

function ensureDisposableRoot(requested) {
  const tempBase = fs.realpathSync.native(os.tmpdir());
  if (!requested) {
    const root = fs.mkdtempSync(path.join(tempBase, "crewdispatch-cleanroom-"));
    return { root, owned: true };
  }
  if (!path.isAbsolute(requested)) fail("--root must be an absolute path", { root: requested });
  const root = path.resolve(requested);
  if (root === path.parse(root).root) fail("refusing filesystem root as clean-room root", { root });
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("--root must be a real directory", { root });
    if (fs.readdirSync(root).length !== 0) fail("--root must be empty", { root });
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  return { root, owned: false };
}

function runChecked(executable, args, options, label) {
  const result = spawnSync(executable, args, {
    ...options,
    encoding: "utf8",
    timeout: options?.timeout ?? 600000,
    maxBuffer: options?.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail(label + " failed", {
      exitCode: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error ? String(result.error.message || result.error) : null,
      stdoutTail: String(result.stdout || "").slice(-2000),
      stderrTail: String(result.stderr || "").slice(-2000)
    });
  }
  return result;
}

function runNodeJson(entry, args, cwd, env, label) {
  const result = runChecked(process.execPath, [entry, ...args], { cwd, env }, label);
  const text = String(result.stdout || "").trim();
  let value;
  try { value = JSON.parse(text); }
  catch { fail(label + " did not return JSON", { stdoutTail: text.slice(-2000) }); }
  if (!value || typeof value !== "object" || value.ok !== true) fail(label + " returned ok=false", { result: value });
  return value;
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === "darwin") {
    runChecked("/usr/bin/ditto", ["-x", "-k", archive, destination], {}, "ditto archive extraction");
    return;
  }
  if (process.platform === "win32") {
    const shell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const script = "& { param($archive,$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    runChecked(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, archive, destination], {}, "PowerShell archive extraction");
    return;
  }
  fail("clean-room verifier supports Windows and macOS only", { platform: process.platform, arch: process.arch });
}

function commandCodeShim(root) {
  fs.mkdirSync(root, { recursive: true });
  if (process.platform === "win32") {
    const file = path.join(root, "cmdc.cmd");
    fs.writeFileSync(file, [
      "@echo off",
      "if \"%~1\"==\"--version\" (echo cleanroom-shim-0.0.0& exit /b 0)",
      "if \"%~1\"==\"--help\" (echo Usage: cmdc --list-models& exit /b 0)",
      "if \"%~1\"==\"--list-models\" (echo provider/cleanroom-metadata-only& exit /b 0)",
      "exit /b 3",
      ""
    ].join("\r\n"), "utf8");
    return file;
  }
  const file = path.join(root, "cmdc");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo cleanroom-shim-0.0.0; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "Usage: cmdc --list-models"; exit 0; fi',
    'if [ "$1" = "--list-models" ]; then echo provider/cleanroom-metadata-only; exit 0; fi',
    "exit 3",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function cleanEnv(root, dataRoot, cliShim) {
  const env = {};
  for (const name of ["PATH", "PATHEXT", "COMSPEC", "ComSpec", "SystemRoot", "WINDIR", "SYSTEMDRIVE"]) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  const home = path.join(root, "home");
  const local = path.join(root, "localappdata");
  const roaming = path.join(root, "appdata");
  const temp = path.join(root, "tmp");
  for (const dir of [home, local, roaming, temp, dataRoot]) fs.mkdirSync(dir, { recursive: true });
  env.HOME = home;
  env.USERPROFILE = home;
  env.CODEX_HOME = path.join(home, ".codex");
  env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  env.LOCALAPPDATA = local;
  env.APPDATA = roaming;
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  env.JOBQUAY_DATA_ROOT = dataRoot;
  env.JOBQUAY_CLI_AUTODISCOVER = "false";
  env.JOBQUAY_COMMAND_CODE_CLI_PATH = cliShim;
  env.JOBQUAY_TEST_AUTOSTART_REGISTRY = path.join(root, "autostart-registry.json");
  env.JOBQUAY_TEST_LAUNCHAGENT_DIR = path.join(root, "LaunchAgents");
  env.JOBQUAY_TEST_LAUNCHCTL_STATE = path.join(root, "launchctl-state.json");
  env.CREWDISPATCH_DISPATCH_DASHBOARD = "0";
  return env;
}

function installedWrapper(installRoot, name) {
  return path.join(installRoot, "bin", process.platform === "win32" ? name + ".cmd" : name);
}

function runWrapper(file, cwd, env) {
  if (process.platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    const line = `"${file}" "--help"`;
    return runChecked(
      comspec,
      ["/d", "/s", "/v:off", "/c", `"${line}"`],
      { cwd, env, timeout: 30000, windowsVerbatimArguments: true },
      path.basename(file) + " --help"
    );
  }
  return runChecked(file, ["--help"], { cwd, env: { ...env, PATH: "/usr/bin:/bin" }, timeout: 30000 }, path.basename(file) + " --help");
}

function residueNames(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.startsWith(".jobquay-stage-") || name.startsWith(".jobquay-backup-"));
}

function main() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    fail("clean-room verifier supports Windows and macOS only", { platform: process.platform, arch: process.arch });
  }
  const args = parseArgs(process.argv.slice(2));
  const archive = path.resolve(args.archive);
  const archiveStat = regularFile(archive, "archive");
  const actualHash = sha256File(archive);
  if (actualHash !== args.sha256) {
    fail("archive SHA-256 mismatch; refusing extraction", { expected: args.sha256, actual: actualHash, archive });
  }

  const disposable = ensureDisposableRoot(args.root);
  const root = disposable.root;
  const unpacked = path.join(root, "unpacked");
  const installRoot = path.join(root, "install");
  const dataRoot = path.join(root, "data");
  const foreignCwd = path.join(root, "foreign-cwd");
  const sentinel = path.join(dataRoot, "cleanroom-data-sentinel.txt");
  let preserve = args.keepRoot || !disposable.owned;
  let report = null;

  try {
    fs.mkdirSync(foreignCwd, { recursive: true });
    extractArchive(archive, unpacked);
    for (const rel of ["package.json", "LICENSE", path.join("dist", "cli", "install-cli.js")]) {
      regularFile(path.join(unpacked, rel), "candidate " + rel);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
    const cliShim = commandCodeShim(path.join(root, "provider-shim"));
    const env = cleanEnv(root, dataRoot, cliShim);
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(sentinel, "clean-room verifier data sentinel\n", "utf8");
    const sentinelBefore = sha256File(sentinel);

    const sourceInstaller = path.join(unpacked, "dist", "cli", "install-cli.js");
    const install = runNodeJson(sourceInstaller, ["install", "--target", installRoot], foreignCwd, env, "candidate install");

    const wrapperChecks = [];
    for (const name of ["crewdispatch", "jobquay"]) {
      const wrapper = installedWrapper(installRoot, name);
      regularFile(wrapper, name + " installed wrapper");
      if (process.platform !== "win32") {
        const mode = fs.statSync(wrapper).mode & 0o777;
        if (mode !== 0o755) fail(name + " installed wrapper mode mismatch", { mode, expected: 0o755 });
      }
      const content = fs.readFileSync(wrapper, "utf8").replace(/%%/g, "%");
      if (!content.includes(installRoot)) fail(name + " wrapper does not point at installed root", { wrapper });
      if (content.includes(unpacked)) fail(name + " wrapper points back to unpacked candidate", { wrapper });
      const run = runWrapper(wrapper, foreignCwd, env);
      if (!/CrewDispatch/.test(String(run.stdout || ""))) fail(name + " --help did not identify CrewDispatch", { stdout: String(run.stdout || "").slice(-1000) });
      wrapperChecks.push({
        name,
        path: wrapper,
        sha256: sha256File(wrapper),
        exitCode: run.status,
        checkoutIndependent: true,
        ...(process.platform !== "win32" ? { mode: fs.statSync(wrapper).mode & 0o777 } : {})
      });
    }

    const installedInstaller = path.join(installRoot, "dist", "cli", "install-cli.js");
    const doctor = runNodeJson(installedInstaller, ["doctor", "--target", installRoot], foreignCwd, env, "installed doctor");
    if (doctor.status !== "healthy") fail("installed doctor is not healthy", { status: doctor.status });
    const doctorChecks = doctor.checks && typeof doctor.checks === "object" ? doctor.checks : {};
    const doctorWrappers = doctorChecks.wrappers && typeof doctorChecks.wrappers === "object" ? doctorChecks.wrappers : null;
    if (!doctorWrappers || doctorWrappers.ok !== true) fail("installed doctor wrapper check is not healthy", { wrappers: doctorWrappers });

    const uninstall = runNodeJson(installedInstaller, ["uninstall", "--target", installRoot], foreignCwd, env, "installed uninstall");
    const sentinelAfter = sha256File(sentinel);
    if (sentinelAfter !== sentinelBefore) fail("disposable data sentinel changed during install/uninstall", { before: sentinelBefore, after: sentinelAfter });
    for (const name of ["crewdispatch", "jobquay"]) {
      if (fs.existsSync(installedWrapper(installRoot, name))) fail("managed wrapper survived uninstall", { name });
    }
    const residue = residueNames(root);
    if (residue.length) fail("staging/backup residue remains after uninstall", { residue });

    report = {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      archive: { path: archive, sha256: actualHash, bytes: archiveStat.size },
      packageVersion: typeof pkg.version === "string" ? pkg.version : null,
      cleanRoomRoot: root,
      rootPreserved: preserve,
      installRoot,
      dataRoot,
      providerProbeMode: "stubbed-command-code-metadata-only",
      providerAuthenticatedChecked: false,
      gatekeeperChecked: false,
      cleanOsAssumed: false,
      install: { ok: install.ok === true, version: install.version || null },
      doctorStatus: doctor.status,
      wrapperChecks,
      uninstall: {
        ok: uninstall.ok === true,
        targetRemoved: uninstall.targetRemoved === true,
        preserved: uninstall.preserved || null,
        modifiedManagedFiles: uninstall.modifiedManagedFiles || null
      },
      dataHashBefore: sentinelBefore,
      dataHashAfter: sentinelAfter,
      stagingResidue: residue
    };
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    preserve = true;
    const out = {
      ok: false,
      platform: process.platform,
      arch: process.arch,
      archive,
      cleanRoomRoot: root,
      rootPreserved: true,
      error: {
        message: String(error?.message || error).slice(0, 1000),
        ...(error?.details && typeof error.details === "object" ? { details: error.details } : {})
      },
      providerAuthenticatedChecked: false,
      gatekeeperChecked: false,
      cleanOsAssumed: false
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    if (!preserve && disposable.owned && report?.ok === true) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  const out = {
    ok: false,
    platform: process.platform,
    arch: process.arch,
    error: {
      message: String(error?.message || error).slice(0, 1000),
      ...(error?.details && typeof error.details === "object" ? { details: error.details } : {})
    },
    providerAuthenticatedChecked: false,
    gatekeeperChecked: false,
    cleanOsAssumed: false
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = 1;
}
