#!/usr/bin/env node
// Explicit user-level registration; does not alter the MCP/plugin installation.
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
    console.log("Usage: node scripts/install-codex-command.cjs [--codex-home <directory>]");
    return;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== "--codex-home" || !argv[1])) {
    throw new Error("Expected --codex-home <directory>, or no arguments.");
  }
  const targetRoot = path.resolve(argv[1] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const source = path.join(__dirname, "..", "integrations", "codex", "prompts", "crewdispatch.md");
  const content = fs.readFileSync(source, "utf8");
  const target = path.join(targetRoot, "prompts", "crewdispatch.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(target, "utf8");
    if (existing !== content) {
      if (sha256(existing) === PRECANONICAL_CREWDISPATCH_PROMPT_SHA256) {
        fs.writeFileSync(target, content, "utf8");
        console.log(`Updated pre-0.1.0 CrewDispatch command at ${target}`);
      } else {
        throw new Error(`Preserved existing command with different content: ${target}. Review and back it up before replacing it.`);
      }
    }
  }
  console.log(`Registered /prompts:crewdispatch at ${target}`);
  console.log("Reload Codex to refresh its command list. The CrewDispatch plugin must be enabled.");
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
