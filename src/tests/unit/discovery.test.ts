// discovery.test.ts — unit tests for the official CLI resolution.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommandCodeCli, findOnPath } from "../../providers/command-code/discovery";
import { CLI_COMMAND_ENV, CLI_PATH_ENV, CLI_AUTODISCOVER_ENV } from "../../providers/command-code/capability";
import { describeCommandCodeCliSource } from "../../providers/command-code/discovery";

const WIN_ENV = { PATH: "C:\\one;C:\\two" } as NodeJS.ProcessEnv;
const existsIn = (set: string[]) => (p: string) => set.includes(p);

test("precedence: env path beats config path", () => {
  const r = resolveCommandCodeCli({
    configPath: "C:\\cfg\\cmdc.exe",
    env: { ...WIN_ENV, [CLI_PATH_ENV]: "C:\\env\\cmdc.exe" } as NodeJS.ProcessEnv,
    platform: "win32",
    exists: existsIn(["C:\\cfg\\cmdc.exe", "C:\\env\\cmdc.exe"])
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, "C:\\env\\cmdc.exe");
  assert.equal(r.source, "env-path");
});

test("precedence: config path beats env command, which beats config command", () => {
  const cfg = resolveCommandCodeCli({
    configPath: "C:\\cfg\\cmdc.exe",
    configCommand: "cfg-cmd",
    env: { ...WIN_ENV, [CLI_COMMAND_ENV]: "env-cmd" } as NodeJS.ProcessEnv,
    platform: "win32",
    exists: () => true
  });
  assert.equal(cfg.path, "C:\\cfg\\cmdc.exe");
  assert.equal(cfg.source, "config-path");

  const envCmd = resolveCommandCodeCli({
    configCommand: "cfg-cmd",
    env: { ...WIN_ENV, [CLI_COMMAND_ENV]: "env-cmd" } as NodeJS.ProcessEnv,
    platform: "win32",
    exists: () => true
  });
  assert.equal(envCmd.path, "env-cmd");
  assert.equal(envCmd.source, "env-command");

  const cfgCmd = resolveCommandCodeCli({ configCommand: "cfg-cmd", env: WIN_ENV, platform: "win32", exists: () => true });
  assert.equal(cfgCmd.path, "cfg-cmd");
  assert.equal(cfgCmd.source, "config-command");
});

test("PATH lookup finds cmdc.cmd before command-code (win32 separator and extensions)", () => {
  const found = findOnPath(["cmdc", "command-code"], {
    env: WIN_ENV,
    platform: "win32",
    exists: existsIn(["C:\\two\\cmdc.cmd"])
  });
  assert.equal(found, "C:\\two\\cmdc.cmd");

  const r = resolveCommandCodeCli({ env: WIN_ENV, platform: "win32", exists: existsIn(["C:\\two\\cmdc.cmd"]) });
  assert.equal(r.ok, true);
  assert.equal(r.source, "path-cmdc");
});

test("win32 env lookup remains case-insensitive after env is serialized into a plain object", () => {
  // Real Windows commonly exposes the OS key as `Path`. process.env itself is
  // case-insensitive on the main thread, but workerData/plain objects are not.
  const serializedEnv = {
    Path: "C:\\one;C:\\two",
    jobquay_command_code_cli_autodiscover: "1"
  } as NodeJS.ProcessEnv;
  const found = findOnPath(["cmdc", "command-code"], {
    env: serializedEnv,
    platform: "win32",
    exists: existsIn(["C:\\two\\cmdc.cmd"])
  });
  assert.equal(found, "C:\\two\\cmdc.cmd");

  const resolved = resolveCommandCodeCli({
    env: serializedEnv,
    platform: "win32",
    exists: existsIn(["C:\\two\\cmdc.cmd"])
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, "C:\\two\\cmdc.cmd");
  assert.equal(resolved.source, "path-cmdc");
});

test("POSIX PATH uses ':' and no extensions", () => {
  const found = findOnPath(["cmdc"], {
    env: { PATH: "/usr/bin:/usr/local/bin" } as NodeJS.ProcessEnv,
    platform: "linux",
    exists: (p) => p === "/usr/local/bin/cmdc"
  });
  assert.equal(found, "/usr/local/bin/cmdc");
});

test("macOS/Linux auto-discovery uses the official `cmd` alias before full command-code", () => {
  const env = { PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin" } as NodeJS.ProcessEnv;
  const exists = existsIn(["/opt/homebrew/bin/cmd", "/usr/local/bin/command-code"]);

  const mac = resolveCommandCodeCli({ env, platform: "darwin", exists });
  assert.equal(mac.ok, true);
  assert.equal(mac.path, "/opt/homebrew/bin/cmd");
  assert.equal(mac.source, "path-cmdc");

  const linux = resolveCommandCodeCli({ env, platform: "linux", exists });
  assert.equal(linux.ok, true);
  assert.equal(linux.path, "/opt/homebrew/bin/cmd");
});

test("native Windows never mistakes the built-in `cmd` shell for Command Code", () => {
  const env = { PATH: "C:\\Windows\\System32;C:\\npm" } as NodeJS.ProcessEnv;
  const resolved = resolveCommandCodeCli({
    env,
    platform: "win32",
    exists: existsIn(["C:\\Windows\\System32\\cmd.exe", "C:\\npm\\command-code.cmd"])
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, "C:\\npm\\command-code.cmd");
});

test("a sparse macOS environment can use an explicit verified CLI path without shell startup files", () => {
  const cli = "/opt/homebrew/bin/cmd";
  const resolved = resolveCommandCodeCli({
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", [CLI_PATH_ENV]: cli } as NodeJS.ProcessEnv,
    platform: "darwin",
    exists: existsIn([cli])
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, cli);
  assert.equal(resolved.source, "env-path");
});

test("auto-discovery can be switched off, and a missing CLI is reported honestly", () => {
  const off = resolveCommandCodeCli({
    env: { ...WIN_ENV, [CLI_AUTODISCOVER_ENV]: "0" } as NodeJS.ProcessEnv,
    platform: "win32",
    exists: () => true
  });
  assert.equal(off.ok, false);
  assert.equal(off.source, "missing");
  assert.equal(off.path, null);
  assert.ok(off.reason && off.reason.includes("cmdc"));
  assert.ok(off.reason && off.reason.includes("CrewDispatch never falls back to another CLI"));

  const missing = resolveCommandCodeCli({ env: WIN_ENV, platform: "win32", exists: () => false });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, "missing");
});

test("detection sources have product-owned labels", () => {
  assert.equal(describeCommandCodeCliSource("path-cmdc"), "Command Code CLI on PATH (cmd/cmdc/command-code)");
  assert.equal(describeCommandCodeCliSource("env-path"), "CLI path from environment variable");
  assert.equal(describeCommandCodeCliSource("missing"), "not found");
});
