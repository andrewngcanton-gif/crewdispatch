// spawn-plan.test.ts — unit tests for the shell-free Windows-safe spawn plan.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommandCodeSpawnPlan, cmdShimTokenProblem } from "../../providers/command-code/spawn-plan";

const ARGV = ["-p", "--output-format", "json", "--model", "deepseek/deepseek-v4-flash"];

test("a native executable is spawned directly, without verbatim arguments", () => {
  const r = buildCommandCodeSpawnPlan({ cliPath: "C:\\tools\\cmdc.exe", argv: ARGV, platform: "win32" });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.plan.file, "C:\\tools\\cmdc.exe");
  assert.deepEqual(r.plan.args, ARGV);
  assert.equal(r.plan.windowsVerbatimArguments, false);
  assert.equal(r.plan.shellShim, null);
});

test("an extensionless Node shebang entry uses node.exe on Windows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-shebang-"));
  const cli = path.join(dir, "codebuddy");
  try {
    fs.writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('ok')\n", "utf8");
    const r = buildCommandCodeSpawnPlan({ cliPath: cli, argv: ARGV, platform: "win32" });
    assert.ok(r.ok);
    assert.equal(r.plan.file, process.execPath);
    assert.deepEqual(r.plan.args, [cli, ...ARGV]);
    assert.equal(r.plan.windowsVerbatimArguments, false);
    assert.equal(r.plan.shellShim, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Windows .cmd shim goes through %ComSpec% with one verbatim line", () => {
  const r = buildCommandCodeSpawnPlan({
    cliPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\cmdc.cmd",
    argv: ARGV,
    platform: "win32",
    comSpec: "C:\\WINDOWS\\system32\\cmd.exe"
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.plan.file, "C:\\WINDOWS\\system32\\cmd.exe");
  assert.deepEqual(r.plan.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(r.plan.windowsVerbatimArguments, true);
  assert.equal(r.plan.shellShim, "C:\\Users\\me\\AppData\\Roaming\\npm\\cmdc.cmd");
  // cmd.exe `/s` strips exactly the OUTER pair of quotes of the /c argument.
  const raw = r.plan.args[4] || "";
  assert.ok(raw.startsWith('"') && raw.endsWith('"'), "the /c argument must be one quoted command line");
  const line = raw.slice(1, -1);
  assert.ok(line.startsWith(`"C:\\Users\\me\\AppData\\Roaming\\npm\\cmdc.cmd" `));
  for (const token of ARGV) assert.ok(line.includes(`"${token}"`), `token ${token} must be individually quoted`);
});

test("/v:off pins delayed expansion off so '!' stays literal", () => {
  const r = buildCommandCodeSpawnPlan({ cliPath: "C:\\npm\\cmdc.cmd", argv: ARGV, platform: "win32" });
  assert.ok(r.ok && r.plan.args.includes("/v:off"));
});

test("the default ComSpec is cmd.exe when none is supplied", () => {
  const r = buildCommandCodeSpawnPlan({ cliPath: "C:\\npm\\cmdc.cmd", argv: ARGV, platform: "win32", comSpec: undefined });
  assert.ok(r.ok);
  assert.equal(r.plan.file, "cmd.exe");
});

test("refuses empty cli path, empty argv, non-string and unsafe tokens", () => {
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "", argv: ARGV, platform: "win32" }).ok, false);
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "C:\\a.exe", argv: [], platform: "win32" }).ok, false);
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "C:\\a.exe", argv: ["ok", 1 as unknown as string], platform: "win32" }).ok, false);
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "C:\\a.exe", argv: ["line\nnope"], platform: "win32" }).ok, false);
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "C:\\a.exe", argv: ["has\"quote"], platform: "win32" }).ok, false);
  assert.equal(buildCommandCodeSpawnPlan({ cliPath: "C:\\a.exe", argv: ["nul\0byte"], platform: "win32" }).ok, false);
});

test("a Windows shim refuses tokens cmd.exe cannot carry", () => {
  for (const bad of ["a\rb", "line\nbreak", "%PATH%", 'say "hi"', "trailing\\"]) {
    assert.ok(cmdShimTokenProblem(bad), `expected a problem for ${JSON.stringify(bad)}`);
    const r = buildCommandCodeSpawnPlan({ cliPath: "C:\\npm\\cmdc.cmd", argv: ["-p", bad], platform: "win32" });
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    assert.ok(!r.ok && r.error.includes("startup is refused"));
  }
  // Characters measured as safe through the same shim shape are NOT refused.
  for (const okToken of ["a b", "a&b", "a|b", "(x)", "a^b", "hi!", "\u4e2d\u6587", "a\\b"]) {
    assert.equal(cmdShimTokenProblem(okToken), null, `unexpected refusal for ${JSON.stringify(okToken)}`);
  }
});

test("a POSIX plan never uses the shim path", () => {
  const r = buildCommandCodeSpawnPlan({ cliPath: "/usr/local/bin/cmdc", argv: ARGV, platform: "linux" });
  assert.ok(r.ok);
  assert.equal(r.plan.file, "/usr/local/bin/cmdc");
  assert.equal(r.plan.windowsVerbatimArguments, false);
});

test("the macOS `cmd` alias resolves shell-free on PATH", { skip: process.platform !== "darwin" ? "requires native macOS path/filesystem semantics" : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-macos-cmd-"));
  const cli = path.join(dir, "cmd");
  try {
    fs.writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('ok')\n", { encoding: "utf8", mode: 0o755 });
    const r = buildCommandCodeSpawnPlan({
      cliPath: "cmd",
      argv: ARGV,
      platform: "darwin",
      env: { PATH: `/usr/bin:${dir}` } as NodeJS.ProcessEnv,
      exists: (p) => p === cli
    });
    assert.ok(r.ok);
    assert.equal(r.plan.file, process.execPath);
    assert.deepEqual(r.plan.args, [cli, ...ARGV]);
    assert.equal(r.plan.windowsVerbatimArguments, false);
    assert.equal(r.plan.shellShim, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a macOS Node-shebang CLI does not depend on sparse PATH finding node", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-macos-sparse-"));
  const cli = path.join(dir, "cmd");
  try {
    fs.writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write(process.version)\n", { encoding: "utf8", mode: 0o755 });
    const r = buildCommandCodeSpawnPlan({
      cliPath: cli,
      argv: ["--version"],
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } as NodeJS.ProcessEnv
    });
    assert.ok(r.ok);
    assert.equal(r.plan.file, process.execPath);
    assert.deepEqual(r.plan.args, [cli, "--version"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare command name is resolved on PATH (including the .cmd extension)", () => {
  const r = buildCommandCodeSpawnPlan({
    cliPath: "cmdc",
    argv: ARGV,
    platform: "win32",
    env: { PATH: "C:\\one;C:\\two" } as NodeJS.ProcessEnv,
    exists: (p) => p === "C:\\two\\cmdc.cmd"
  });
  assert.ok(r.ok);
  assert.equal(r.plan.shellShim, "C:\\two\\cmdc.cmd");
  assert.equal(r.plan.file, "cmd.exe");
});
