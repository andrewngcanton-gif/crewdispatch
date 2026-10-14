#!/usr/bin/env node
// Build the small Darwin process-fact helper into dist/native for source-core
// development and managed-install staging. Windows/Linux builds are unchanged.
//
// Public distribution packages a prebuilt helper for the candidate's exact
// native architecture; installed users must not need Xcode/clang.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { macosMachOArchitectureForNodeArch } = require("./macos-architecture.cjs");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function main() {
  if (process.platform !== "darwin") return;
  const architecture = macosMachOArchitectureForNodeArch(process.arch);
  if (!architecture) {
    fail(`CrewDispatch macOS builds support native arm64 or x64 Node only; got ${process.arch}`);
  }

  const root = path.resolve(__dirname, "..");
  const source = path.join(__dirname, "macos-process-info.c");
  const outDir = path.join(root, "dist", "native");
  const output = path.join(outDir, "macos-process-info");
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-Wall",
      "-arch",
      architecture,
      "-Wextra",
      "-Werror",
      "-O2",
      "-mmacosx-version-min=13.0",
      source,
      "-o",
      output
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }
  );
  if (result.error || result.status !== 0) {
    fail(
      `failed to build Darwin process helper: ${result.error ? result.error.message : String(result.stderr || result.stdout || "").trim()}`
    );
  }
  fs.chmodSync(output, 0o755);
  process.stdout.write(`Built macOS ${architecture} process helper: ${path.relative(root, output)}\n`);
}

if (require.main === module) main();
