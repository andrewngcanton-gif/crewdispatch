#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inspectMachOArchitectures } = require("./build-release-candidate.cjs");

function fail(message) { console.error(message); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.error || r.status !== 0) fail(`${exe} failed: ${r.error ? r.error.message : (r.stderr || r.stdout || "").trim()}`);
  return r.stdout;
}
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function packageVersion(archive) {
  const raw = run("/usr/bin/unzip", ["-p", archive, "package.json"]);
  try { return JSON.parse(raw).version; } catch { fail(`invalid package.json in ${archive}`); }
}
function packageArchitectures(archive) {
  const r = spawnSync("/usr/bin/unzip", ["-p", archive, "dist/native/macos-process-info"], { encoding: null, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0 || !Buffer.isBuffer(r.stdout)) fail(`could not inspect macOS helper in ${archive}`);
  return inspectMachOArchitectures(r.stdout) || [];
}

const arm = arg("--arm64-archive");
const x64 = arg("--x64-archive");
const output = arg("--output");
if (!arm || !x64 || !output) fail("usage: build-macos-installer.cjs --arm64-archive <zip> --x64-archive <zip> --output <pkg>");
for (const file of [arm, x64]) if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`archive not found: ${file}`);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
if (packageVersion(arm) !== pkg.version || packageVersion(x64) !== pkg.version) fail(`candidate version must match package ${pkg.version}`);
const armArchitectures = packageArchitectures(arm);
const x64Architectures = packageArchitectures(x64);
if (armArchitectures.length !== 1 || armArchitectures[0] !== "arm64") fail(`arm64 candidate has unexpected helper architecture: ${armArchitectures.join(",") || "unknown"}`);
if (x64Architectures.length !== 1 || x64Architectures[0] !== "x86_64") fail(`x86_64 candidate has unexpected helper architecture: ${x64Architectures.join(",") || "unknown"}`);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-pkg-"));
try {
  const scripts = path.join(temp, "scripts");
  fs.mkdirSync(scripts);
  fs.copyFileSync(path.join(__dirname, "..", "installers", "macos", "postinstall"), path.join(scripts, "postinstall"));
  fs.chmodSync(path.join(scripts, "postinstall"), 0o755);
  fs.copyFileSync(arm, path.join(scripts, "payload-arm64.zip"));
  fs.copyFileSync(x64, path.join(scripts, "payload-x86_64.zip"));
  fs.writeFileSync(
    path.join(scripts, "SHA256SUMS.txt"),
    `${sha256(path.join(scripts, "payload-arm64.zip"))}  payload-arm64.zip\n${sha256(path.join(scripts, "payload-x86_64.zip"))}  payload-x86_64.zip\n`,
    "utf8"
  );
  for (const file of ["postinstall", "payload-arm64.zip", "payload-x86_64.zip", "SHA256SUMS.txt"]) {
    const cleaned = spawnSync("/usr/bin/xattr", ["-c", path.join(scripts, file)], { encoding: "utf8", windowsHide: true });
    if (cleaned.error || cleaned.status !== 0) fail(`xattr cleanup failed for ${file}: ${cleaned.error ? cleaned.error.message : cleaned.stderr.trim()}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  run("/usr/bin/pkgbuild", [
    "--nopayload",
    "--identifier", "com.crewdispatch.installer",
    "--version", String(pkg.version),
    "--scripts", scripts,
    path.resolve(output)
  ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const result = {
    ok: true,
    version: pkg.version,
    output: path.resolve(output),
    sha256: sha256(path.resolve(output)),
    bytes: fs.statSync(path.resolve(output)).size,
    arm64PayloadSha256: sha256(arm),
    x86_64PayloadSha256: sha256(x64),
    signed: false,
    notarized: false
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
