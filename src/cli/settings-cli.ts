// settings-cli.ts — a small BUILT acceptance helper for the CrewDispatch settings.
//
//   node dist/cli/settings-cli.js get    --root <dir> [--now-iso <iso>]
//   node dist/cli/settings-cli.js update --root <dir> [--patch <json>]   (else stdin)
//
// This is an INTERNAL acceptance harness, not the product UI and not the MCP
// entry. It reads/writes ONLY the CrewDispatch config under the given data root and
// runs only the official CLI's public read-only probes (through `readSettings`).
// It never touches another product's config, a credential or the real profile.
import fs from "node:fs";
import { resolveDataRoot } from "../jobs/store";
import { ConfigError, configPatchFromSnake, configView, updateConfig } from "../config/schema";
import { readSettings } from "../config/settings";

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(0, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (typeof next === "string" && !next.startsWith("--")) {
          flags.set(a, next);
          i += 1;
        } else {
          flags.set(a, "true");
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function print(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const root = args.flags.get("--root");
  if (!root) {
    print({ ok: false, error: "--root is required" });
    return 1;
  }
  const nowIso = args.flags.get("--now-iso");
  const now = nowIso ? () => new Date(nowIso) : undefined;
  const result = await readSettings(resolveDataRoot(root), { env: process.env, ...(now ? { now } : {}) });
  if (!result.ok) {
    print({ ok: false, code: result.code, message: result.message, field: result.field });
    return 1;
  }
  print(result.view);
  return 0;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const root = args.flags.get("--root");
  if (!root) {
    print({ ok: false, error: "--root is required" });
    return 1;
  }
  const raw = args.flags.get("--patch") ?? readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    print({ ok: false, code: "config_invalid_json", message: "The update payload is not valid JSON." });
    return 1;
  }
  try {
    // The CLI surface uses the same snake_case field names as the MCP tool; an
    // unknown field is rejected rather than silently dropped.
    const patch = configPatchFromSnake(parsed);
    const result = updateConfig(resolveDataRoot(root), patch);
    print({ ok: true, config: configView(result.config) });
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      print({ ok: false, code: e.code, message: e.message, field: e.field });
      return 1;
    }
    print({ ok: false, code: "config_write_failed", message: String((e as Error)?.message || e) });
    return 1;
  }
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<number>> = {
  get: cmdGet,
  update: cmdUpdate
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    print({ ok: false, error: `usage: settings-cli.js <${Object.keys(COMMANDS).join("|")}> --root <dir> [--patch <json>|--now-iso <iso>]` });
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    print({ ok: false, error: `unknown command: ${command}`, commands: Object.keys(COMMANDS) });
    return 1;
  }
  return handler(parseArgs(argv.slice(1)));
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    print({ ok: false, error: String((e as Error)?.stack || e) });
    process.exit(1);
  });
