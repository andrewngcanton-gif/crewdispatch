// discovery.ts — resolution of the user-installed official Command Code CLI.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` resolveCommandCodeCli / findOnPath. Read-only:
// this module only stats candidate files, never executes anything and never reads
// provider credentials or databases.
import fs from "node:fs";
import type { CliResolution, CliResolveInput } from "../provider";
import {
  CLI_AUTODISCOVER_ENV,
  CLI_COMMAND_ENV,
  CLI_PATH_ENV,
  COMMAND_CODE_PROVIDER,
  commandCodePathNames,
  describeCliSource
} from "./capability";

function defaultExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows environment-variable names are case-insensitive, but a serialized
 * env object (for example one carried through workerData) is an ordinary
 * case-sensitive JavaScript object. Preserve Windows semantics explicitly so
 * keys such as the OS-provided `Path` still satisfy lookups for `PATH`.
 * Shared with the Codex wake resolver in src/mcp/notify.ts.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const direct = env[name];
  if (typeof direct === "string") return direct;
  if (platform !== "win32") return undefined;
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = match ? env[match] : undefined;
  return typeof value === "string" ? value : undefined;
}

/**
 * Bounded PATH lookup for one or more command names. One stat per PATH entry per
 * name/ext; no recursion and no full-disk scan.
 *
 * The separator and extensions follow the TARGET platform, not the host, so a
 * win32 PATH is `;`-separated and a `.cmd`/`.bat`/`.exe` shim is found even when
 * simulated from a POSIX host.
 */
export function findOnPath(
  names: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}
): string | null {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || defaultExists;
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const join = (dir: string, leaf: string): string =>
    String(dir).replace(/[\\/]+$/, "") + (win ? "\\" : "/") + leaf;
  const dirs = String(envValue(env, "PATH", platform) || "")
    .split(sep)
    .filter(Boolean);
  const exts = win ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const cand = join(dir, name + ext);
        if (exists(cand)) return cand;
      }
    }
  }
  return null;
}

function autoDiscoverEnabled(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const v = envValue(env, CLI_AUTODISCOVER_ENV, platform);
  if (typeof v !== "string") return true;
  const t = v.trim().toLowerCase();
  return !(t === "0" || t === "false" || t === "off" || t === "no");
}

/**
 * Resolve the official Command Code CLI.
 *
 * Precedence: CrewDispatch env path -> configured cli.path -> CrewDispatch env command ->
 * configured cli.command -> bounded platform PATH lookup (`cmd` on POSIX,
 * `cmdc` on native Windows, then `command-code`).
 *
 * `cli.command` is an EXECUTABLE (a path or a bare command name), never a shell
 * template: the argv is fixed by the official CLI and the child runs with
 * shell:false, so a template would have nothing to substitute and would only
 * invite shell interpolation.
 *
 * There is no fallback to any other CLI. A missing official CLI is reported
 * honestly with the detection source "missing".
 */
export function resolveCommandCodeCli(input: CliResolveInput = {}): CliResolution {
  const env = input.env || process.env;
  const platform = input.platform || process.platform;
  const exists = input.exists || defaultExists;
  const autoDiscover = input.autoDiscover !== undefined ? !!input.autoDiscover : autoDiscoverEnabled(env, platform);

  const envPathValue = envValue(env, CLI_PATH_ENV, platform);
  const envPath = typeof envPathValue === "string" ? envPathValue.trim() : "";
  if (envPath) return { ok: true, provider: COMMAND_CODE_PROVIDER, path: envPath, source: "env-path" };

  const cfgPath = typeof input.configPath === "string" ? input.configPath.trim() : "";
  if (cfgPath) return { ok: true, provider: COMMAND_CODE_PROVIDER, path: cfgPath, source: "config-path" };

  const envCmdValue = envValue(env, CLI_COMMAND_ENV, platform);
  const envCmd = typeof envCmdValue === "string" ? envCmdValue.trim() : "";
  if (envCmd) return { ok: true, provider: COMMAND_CODE_PROVIDER, path: envCmd, source: "env-command" };

  const cfgCmd = typeof input.configCommand === "string" ? input.configCommand.trim() : "";
  if (cfgCmd) return { ok: true, provider: COMMAND_CODE_PROVIDER, path: cfgCmd, source: "config-command" };

  const pathNames = commandCodePathNames(platform);
  if (autoDiscover) {
    const found = findOnPath(pathNames, { env, platform, exists });
    if (found) return { ok: true, provider: COMMAND_CODE_PROVIDER, path: found, source: "path-cmdc" };
  }

  return {
    ok: false,
    provider: COMMAND_CODE_PROVIDER,
    path: null,
    source: "missing",
    reason:
      `Command Code CLI is unavailable: no executable is configured and ${pathNames.join(" / ")} was not found on PATH. ` +
      `Install the official Command Code CLI, or configure cli.path (executable path) / cli.command (executable command), ` +
      `or set the ${CLI_PATH_ENV} / ${CLI_COMMAND_ENV} environment variable. CrewDispatch never falls back to another CLI.`
  };
}

/** Short human-readable description of where the CLI came from (UI/errors). */
export function describeCommandCodeCliSource(source: string): string {
  return describeCliSource(source);
}
