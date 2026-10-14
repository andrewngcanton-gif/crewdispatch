// windows-shim.test.ts — CROSS-PROCESS test of the real Windows cmd.exe shim path.
//
// This is not the official CLI: it is a real `.cmd` shim (the npm forwarding
// shape `"<exe>" "<script>" %*`) created in a throwaway temp directory and
// launched through the production spawn plan with a REAL cmd.exe. It measures the
// characters cmd.exe can and cannot carry, so the pre-spawn refusals in
// spawn-plan.ts stay grounded in evidence rather than assumption.
//
// Cross-process acceptance against the real official `cmdc` is separate:
// `npm.cmd run smoke` and `npm.cmd run test:e2e:command-code`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildCommandCodeSpawnPlan } from "../../providers/command-code/spawn-plan";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";

function makeShim(): { dir: string; shimPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-shim-"));
  const printer = path.join(dir, "print-args.js");
  fs.writeFileSync(printer, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', "utf8");
  const shimPath = path.join(dir, "echo-args.cmd");
  // The standard npm shim shape: forward every argument to a real executable.
  fs.writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "%~dp0print-args.js" %*\r\n`, "utf8");
  return { dir, shimPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runPlan(plan: { file: string; args: string[]; windowsVerbatimArguments: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => (out ? resolve(out) : reject(new Error(`shim produced no stdout; stderr=${err}`))));
  });
}

test(
  "a real .cmd shim receives the production argv byte-identically",
  { timeout: 30000, skip: process.platform === "win32" ? false : "Windows shim behaviour" },
  async () => {
    const { shimPath, cleanup } = makeShim();
    try {
      const argv = ["-p", "--output-format", "json", "--model", "deepseek/deepseek-v4-flash", "--permission-mode", "accept-edits", "--skip-onboarding"];
      const plan = buildCommandCodeSpawnPlan({ cliPath: shimPath, argv, platform: "win32" });
      assert.equal(plan.ok, true);
      assert.ok(plan.ok);
      assert.equal(plan.plan.windowsVerbatimArguments, true);
      assert.equal(plan.plan.file.toLowerCase().endsWith("cmd.exe"), true);

      const raw = await runPlan(plan.plan);
      assert.deepEqual(JSON.parse(raw), argv);
    } finally {
      cleanup();
    }
  }
);

test(
  "characters cmd.exe can carry arrive unchanged through the real shim",
  { timeout: 30000, skip: process.platform === "win32" ? false : "Windows shim behaviour" },
  async () => {
    const { shimPath, cleanup } = makeShim();
    try {
      const argv = ["a b", "a&b", "a|b", "(x)", "a^b", "hi!", "\u4e2d\u6587", "a\\b", "a;b"];
      const plan = buildCommandCodeSpawnPlan({ cliPath: shimPath, argv, platform: "win32" });
      assert.ok(plan.ok);
      const raw = await runPlan(plan.plan);
      assert.deepEqual(JSON.parse(raw), argv);
    } finally {
      cleanup();
    }
  }
);

test(
  "a token cmd.exe cannot carry is refused BEFORE the spawn (no child is started)",
  { timeout: 30000 },
  () => {
    const { shimPath, cleanup } = makeShim();
    try {
      for (const bad of ["a\rb", "line\nbreak", "%PATH%", 'say "hi"', "trailing\\"]) {
        const plan = buildCommandCodeSpawnPlan({ cliPath: shimPath, argv: ["-p", bad], platform: "win32" });
        assert.equal(plan.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      }
    } finally {
      cleanup();
    }
  }
);

test("the resolved official CLI, when installed, is planned as a shim or a native image", () => {
  const r = resolveCommandCodeCli({});
  if (!r.ok || !r.path) {
    // Honest state: nothing was verified here because the CLI is not installed.
    assert.equal(r.source, "missing");
    return;
  }
  const plan = buildCommandCodeSpawnPlan({ cliPath: r.path, argv: ["-p"], platform: process.platform });
  assert.equal(plan.ok, true);
  assert.ok(plan.ok);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(r.path)) {
    assert.equal(plan.plan.windowsVerbatimArguments, true);
    assert.equal(plan.plan.shellShim, r.path);
  } else {
    assert.equal(plan.plan.windowsVerbatimArguments, false);
  }
});
