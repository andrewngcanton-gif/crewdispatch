// command-code-package-fixture.ts — a REAL temp filesystem laid out like an
// installed Command Code package (npm prefix + `node_modules/command-code`).
//
// It lets the settings/local-catalog tests exercise the production discovery and
// parsing paths against a package that really exists on disk, without a real
// CLI, without a network and without a user-specific path.
import fs from "node:fs";
import path from "node:path";

export const COMMAND_CODE_PACKAGE_NAME = "command-code";

/**
 * A models reference in the shape the installed 1.72.4 package ships, including
 * the stealth ids whose names contain no "free" and a decoy id that DOES.
 */
export const MODELS_REFERENCE_FIXTURE: string = [
  "<!-- Generated from the Command Code docs: https://commandcode.ai/docs -->",
  "",
  "# Command Code Models",
  "",
  "The model catalog — every id `/model`, `--model`, `model:effort` shorthand, and agent-file `model:` pinning accept.",
  "",
  "## Open Source",
  "",
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (latest) | 1M | high, max | $0.66/$1.98 · cache $0.022 | Go and above | hybrid-attention long-context reasoning |",
  "| `deepseek/deepseek-v4.1-flash` | DeepSeek V4.1 Flash | 1M | low, high, max | $0.15/$0.6 · cache $0.003 | Go and above | V4.1 hybrid-attention reasoning with vision |",
  "| `poolside/laguna-s-2.1-free` | Laguna S 2.1 | 256K | — | $0/$0 · cache $0 | Go and above | open-weight agentic coding and long-horizon work |",
  "| `inclusionai/ling-3.1-flash:free` | Ling 3.1 Flash | 262K | low, medium, high | $0/$0 · cache $0 | Go and above | hybrid-reasoning MoE for coding & tool-using agents |",
  "## Stealth",
  "",
  "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
  "|---|---|---|---|---|---|---|",
  "| `stealth/space-bunny-alpha` | Space Bunny Alpha | 1M | low, medium, high | $0/$0 · cache $0 | Go and above | stealth model with 1M context |",
  "| `stealth/pixel-canary` | Pixel Canary | 262K | low, medium, xhigh | $0/$0 · cache $0 | Go and above | stealth coding model for web and mobile apps |",
  "",
  "Rates are the advertised price list resolved from the billing source of truth (promos are already baked in)."
].join("\n");

export interface InstalledPackageFixture {
  /** The npm-style prefix directory (holds the shim and `node_modules`). */
  prefixDir: string;
  /** `<prefix>/node_modules/command-code`. */
  packageRoot: string;
  /** The installed package's own shipped reference file. */
  referencePath: string;
  /** `<packageRoot>/dist/index.mjs`. */
  entryPath: string;
}

/** Create a real installed-package layout under `prefixDir`. */
export function writeInstalledCommandCodePackage(
  prefixDir: string,
  options: { modelsText?: string; referenceRelative?: string; version?: string } = {}
): InstalledPackageFixture {
  const root = path.join(prefixDir, "node_modules", COMMAND_CODE_PACKAGE_NAME);
  const referenceRelative = options.referenceRelative ?? "dist/bundled/command-code-knowledge/reference/models.md";
  const referencePath = path.join(root, ...referenceRelative.split("/"));
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.writeFileSync(referencePath, options.modelsText ?? MODELS_REFERENCE_FIXTURE, "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: COMMAND_CODE_PACKAGE_NAME,
        version: options.version ?? "9.9.9-test",
        bin: { cmdc: "dist/index.mjs", "command-code": "dist/index.mjs" }
      },
      null,
      2
    ),
    "utf8"
  );
  const entryPath = path.join(root, "dist", "index.mjs");
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// fake command code entry (never executed by these tests)\n", "utf8");
  return { prefixDir, packageRoot: root, referencePath, entryPath };
}

/**
 * Write a resolved-CLI shim inside a prefix. The npm convention launches a
 * package-relative script; `launch` can override that with any target text.
 */
export function writeCommandCodeShim(
  dir: string,
  options: { name?: string; launch?: string; js?: string } = {}
): string {
  const name = options.name ?? "cmdc";
  const launch = options.launch ?? `node_modules/${COMMAND_CODE_PACKAGE_NAME}/dist/index.mjs`;
  if (process.platform === "win32") {
    const shim = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nendLocal & node "%dp0%\\${launch.replace(/\//g, "\\")}" %*\r\n`, "utf8");
    return shim;
  }
  const shim = path.join(dir, name);
  fs.writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/${launch}" "$@"\n`, "utf8");
  fs.chmodSync(shim, 0o755);
  return shim;
}

/**
 * Write a fake Command Code CLI that answers the PUBLIC probes and logs every
 * invocation. `--list-models` is intentionally optional: tests assert whether
 * the installed-package path ever needs it.
 */
export function writeFakeCommandCodeCli(
  dir: string,
  options: { name?: string; probeDelayMs?: number; listModels?: string | null; permissionModes?: string; effort?: boolean } = {}
): { shim: string; log: string; js: string } {
  const name = options.name ?? "fake-cmdc";
  const log = path.join(dir, `${name}-invocations.jsonl`);
  const listModels = options.listModels === undefined ? "Available models · 2 models\n\nfake/model-a   FREE   First fake model (default)\nfake/model-b   Second fake model\n" : options.listModels;
  const permissionModes = options.permissionModes ?? "plan, accept-edits, yolo";
  const js = path.join(dir, `${name}.js`);
  const lines = [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    'if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ argv: args }) + "\\n");',
    "function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* slow CLI */ } }",
    `const delayMs = Number(process.env.FAKE_CLI_DELAY_MS || ${options.probeDelayMs ?? 0});`,
    'if (args.includes("--version")) { sleep(delayMs); process.stdout.write("9.9.9-fake\\n"); process.exit(0); }',
    'if (args.includes("--help")) {',
    "  sleep(delayMs);",
    `  process.stdout.write("Usage: cmdc [options]\\n  --model <id>  Model to use\\n  --permission-mode <mode>  Set permission mode (${permissionModes})\\n"${options.effort === false ? "" : ' + "  --effort <level>  Reasoning effort (minimal, low, medium, high)\\n"'});`,
    "  process.exit(0);",
    "}",
    ...(listModels === null
      ? []
      : [
          'if (args.includes("--list-models")) {',
          "  sleep(delayMs);",
          `  process.stdout.write(${JSON.stringify(listModels)});`,
          "  process.exit(0);",
          "}"
        ]),
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (d) => { input += d; });',
    'process.stdin.on("end", () => { process.exit(0); });'
  ];
  fs.writeFileSync(js, lines.join("\n"), "utf8");
  const shim = process.platform === "win32" ? path.join(dir, `${name}.cmd`) : path.join(dir, name);
  if (process.platform === "win32") {
    fs.writeFileSync(shim, `@echo off\r\nnode "%~dp0${name}.js" %*\r\n`, "utf8");
  } else {
    fs.writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/${name}.js" "$@"\n`, "utf8");
    fs.chmodSync(shim, 0o755);
  }
  return { shim, log, js };
}

/** Every argv the fake CLI logged. */
export function readInvocationArgs(log: string): string[][] {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}
