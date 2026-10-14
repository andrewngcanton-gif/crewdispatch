#!/usr/bin/env node
// Explicit removal of the optional CrewDispatch Codex composer prompt.
// Delete only the exact file CrewDispatch currently installs; preserve edits.
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const PRECANONICAL_CREWDISPATCH_PROMPT_SHA256 = "502d82e8476e3463cca5db6c0e3f26a0e782bcc9419bb2f87ab2b1fb2759f9a4";

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function main(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log("Usage: node scripts/uninstall-codex-command.cjs [--codex-home <directory>]");
    return;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== "--codex-home" || !argv[1])) {
    throw new Error("Expected --codex-home <directory>, or no arguments.");
  }

  const targetRoot = path.resolve(argv[1] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const source = path.join(__dirname, "..", "integrations", "codex", "prompts", "crewdispatch.md");
  const expected = fs.readFileSync(source, "utf8");
  const promptsDir = path.join(targetRoot, "prompts");
  const target = path.join(promptsDir, "crewdispatch.md");

  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`CrewDispatch Codex command already absent: ${target}`);
      return;
    }
    throw error;
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Preserved non-regular command entry: ${target}`);
  }
  const current = fs.readFileSync(target, "utf8");
  if (current !== expected && sha256(current) !== PRECANONICAL_CREWDISPATCH_PROMPT_SHA256) {
    throw new Error(`Preserved user-modified command: ${target}`);
  }

  fs.rmSync(target, { force: true });
  try {
    if (fs.readdirSync(promptsDir).length === 0) fs.rmdirSync(promptsDir);
  } catch {}
  console.log(`Removed /prompts:crewdispatch from ${target}`);
  console.log("Reload Codex to refresh its command list.");
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
