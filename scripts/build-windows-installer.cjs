#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fail(message) { console.error(message); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

const payloadDir = arg("--payload-dir");
const output = arg("--output");
if (!payloadDir || !output) fail("usage: build-windows-installer.cjs --payload-dir <extracted-windows-candidate> --output <exe>");
const payload = path.resolve(payloadDir);
const packageFile = path.join(payload, "package.json");
const installerEntry = path.join(payload, "dist", "cli", "install-cli.js");
if (!fs.existsSync(packageFile) || !fs.existsSync(installerEntry)) fail("payload directory is not an extracted CrewDispatch release candidate");
const payloadPkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const sourcePkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
if (payloadPkg.version !== sourcePkg.version) fail(`payload version ${payloadPkg.version} does not match source version ${sourcePkg.version}`);

const candidates = [process.env.MAKENSIS, "makensis"].filter(Boolean);
let compiler = null;
for (const exe of candidates) {
  const probe = spawnSync(exe, ["-VERSION"], { encoding: "utf8", windowsHide: true });
  if (!probe.error && probe.status === 0) { compiler = exe; break; }
}
if (!compiler) fail("makensis was not found. Install NSIS or set MAKENSIS to the compiler path.");
const out = path.resolve(output);
fs.mkdirSync(path.dirname(out), { recursive: true });
const script = path.join(__dirname, "..", "installers", "windows", "CrewDispatch.nsi");
const definePrefix = process.platform === "win32" ? "/D" : "-D";
const result = spawnSync(compiler, [
  `${definePrefix}VERSION=${sourcePkg.version}`,
  `${definePrefix}PAYLOAD_DIR=${payload}`,
  `${definePrefix}OUTPUT_FILE=${out}`,
  script
], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (result.error || result.status !== 0) fail(`makensis failed: ${result.error ? result.error.message : (result.stderr || result.stdout || "").trim()}`);
process.stdout.write(`${JSON.stringify({ ok: true, version: sourcePkg.version, output: out, sha256: sha256(out), bytes: fs.statSync(out).size, compiler }, null, 2)}\n`);
