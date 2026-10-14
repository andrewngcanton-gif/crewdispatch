#!/usr/bin/env node
// generate-plugin-mcp.cjs — produce the CrewDispatch plugin's `.mcp.json` from the
// migratable template (`plugins/crewdispatch/mcp.template.json`).
//
// WHY THIS EXISTS
//   An MCP host launches a stdio server with a `command`/`args` pair, and a
//   RELATIVE entry (the old `"dist/mcp/server.js"`) resolves against the HOST's
//   working directory — which is not the CrewDispatch checkout. The plugin therefore
//   failed to start from any cwd other than the repo root (verified: node threw
//   MODULE_NOT_FOUND). The generated config pins both the server entry and the
//   already-running Node executable to ABSOLUTE paths so the plugin works from
//   any cwd and does not depend on a GUI host inheriting shell PATH.
//
// THIS SCRIPT VS. THE REAL INSTALLER
//   The absolute path is machine-specific, and there are two generation paths:
//
//   1. This script — a DEV-CHECKOUT convenience. It derives the path from its own
//      location and pins the entry to this checkout's `dist/mcp/server.js`.
//      Re-run it after moving/copying the repo:
//
//        node scripts/generate-plugin-mcp.cjs
//        node scripts/generate-plugin-mcp.cjs --plugin-dir <pluginDir> [--entry <absServer.js>] [--node <absNode>]
//
//   2. The real installer — `renderMcpConfig()` in src/install/manager.ts. This is
//      what an installed package actually ships: install/upgrade render the same
//      `mcp.template.json` with an absolute path under the FINAL install target,
//      so the config staged next to a fresh install already points at where the
//      package will live.
//
//   Both outputs are absolute, machine-specific configs for the current host.
//   They are rendered installation/development artifacts rather than a portable
//   cross-machine config; this stage ships no relative launcher.
const fs = require("node:fs");
const path = require("node:path");

const SERVER_PLACEHOLDER = '"__CREWDISPATCH_SERVER_ENTRY__"';
const NODE_PLACEHOLDER = '"__CREWDISPATCH_NODE_ENTRY__"';

function parseArgs(argv) {
  const out = { pluginDir: null, entry: null, node: null, template: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--plugin-dir") out.pluginDir = argv[++i];
    else if (a === "--entry") out.entry = argv[++i];
    else if (a === "--node") out.node = argv[++i];
    else if (a === "--template") out.template = argv[++i];
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: node scripts/generate-plugin-mcp.cjs [--plugin-dir <dir>] [--entry <abs server.js>] [--node <abs node>] [--template <file>] [--quiet]\n"
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const pluginDir = path.resolve(args.pluginDir || path.join(repoRoot, "plugins", "crewdispatch"));
  const templatePath = path.resolve(args.template || path.join(pluginDir, "mcp.template.json"));
  const entry = path.resolve(args.entry || path.join(repoRoot, "dist", "mcp", "server.js"));
  const node = path.resolve(args.node || process.execPath);
  const outPath = path.join(pluginDir, ".mcp.json");

  if (!fs.existsSync(templatePath)) {
    process.stderr.write(`template not found: ${templatePath}\n`);
    process.exit(1);
  }
  const template = fs.readFileSync(templatePath, "utf8");
  if (!template.includes(SERVER_PLACEHOLDER) || !template.includes(NODE_PLACEHOLDER)) {
    process.stderr.write(`template is missing a required MCP placeholder: ${templatePath}\n`);
    process.exit(1);
  }
  // Pin both the server and the Node runtime. GUI hosts and LaunchAgents may not
  // inherit a shell PATH containing Node even though the installer/generator is
  // already running under a valid Node executable.
  const rendered = template
    .split(SERVER_PLACEHOLDER).join(JSON.stringify(entry))
    .split(NODE_PLACEHOLDER).join(JSON.stringify(node));
  // Re-serialise for a stable, sorted shape and a trailing newline.
  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch (e) {
    process.stderr.write(`generated config is not valid JSON: ${String(e && e.message)}\n`);
    process.exit(1);
  }
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  if (!args.quiet) {
    const entryExists = fs.existsSync(entry);
    process.stdout.write(`wrote ${outPath}\n  node: ${node}\n  server entry: ${entry}${entryExists ? "" : "  (MISSING — run the build first)"}\n`);
    if (!entryExists) process.exitCode = 1;
  }
}

main();
