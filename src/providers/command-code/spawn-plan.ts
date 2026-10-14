// spawn-plan.ts — the shell-free Windows-safe spawn plan.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` buildCommandCodeSpawnPlan and
// `wb-crew/src/cli-transport.mjs` resolveCliExecutable / buildCliSpawnPlan
// (including the measured cmd.exe shim refusals).
//
// WHY: a Windows `.cmd`/`.bat` shim is a batch script, not an executable image,
// so CreateProcess cannot start it and it must go through %ComSpec%, which
// RE-PARSES the command line. Every token below is therefore either a fixed
// flag, an enum value or a token-validated id, and each is quoted individually.
// The prompt and the working directory are never on this line (stdin and the
// spawn `cwd` option carry them), so no value can escape into a shell.
import fs from "node:fs";
import path from "node:path";
import type { SpawnPlan } from "../provider";
import { findOnPath } from "./discovery";

export type SpawnPlanInput = {
  cliPath: unknown;
  argv: readonly string[];
  platform?: NodeJS.Platform;
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
};

export type SpawnPlanResult = { ok: true; plan: SpawnPlan } | { ok: false; error: string };

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the executable the way a shell would have: an explicit path (or a
 * drive letter) is used verbatim; a bare command name is looked up on PATH
 * including the Windows `.cmd`/`.bat`/`.exe` extensions (the normal shape of an
 * npm-installed CLI). An unresolvable bare name is returned as-is so the OS
 * reports it.
 */
export function resolveCliExecutable(
  file: string,
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}
): string | null {
  const f = typeof file === "string" ? file.trim() : "";
  if (!f) return null;
  if (/[\\/]/.test(f) || /^[A-Za-z]:/.test(f)) return f;
  return findOnPath([f], opts) || f;
}

// Characters a Windows .cmd/.bat shim CANNOT carry unchanged. Each entry was
// MEASURED against a real cmd.exe fixture in the reference project (see
// the compatibility contract); none is guessed here, and
// tests/integration/windows-shim.test.ts re-measures them for CrewDispatch.
const CMD_SHIM_REFUSED: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["\r", "a carriage return (cmd.exe DELETES it; a CRLF pair truncates the argument)"],
  ["\n", "a newline (cmd.exe reads it as the END of the command, so the argument is TRUNCATED)"],
  ["%", "a '%' (cmd.exe EXPANDS %VAR% even inside double quotes)"],
  ["\"", "a double quote (cmd.exe cannot represent a literal one; it MERGES neighbouring arguments)"]
]);

/** Why one argv token cannot cross a Windows `.cmd`/`.bat` shim, or null. */
export function cmdShimTokenProblem(token: string): string | null {
  for (const [ch, why] of CMD_SHIM_REFUSED) {
    if (token.includes(ch)) return why;
  }
  if (token.endsWith("\\")) {
    return "a TRAILING backslash (it escapes the closing quote cmd.exe adds, corrupting this argument AND every argument after it)";
  }
  return null;
}

/**
 * Build the spawn plan of one run. The caller MUST spawn with `shell: false`.
 *
 * Windows shim: `cmd.exe /d /s /v:off /c ""<cli>" "<arg>" ..."`.
 * `windowsVerbatimArguments` makes Node pass that line through unmodified, `/s`
 * strips exactly the outer quote pair, and `/v:off` pins delayed expansion OFF
 * for this invocation so `!` stays literal whatever the machine registry says.
 */
export function buildCommandCodeSpawnPlan(input: SpawnPlanInput): SpawnPlanResult {
  const raw = typeof input.cliPath === "string" ? input.cliPath.trim() : "";
  if (!raw) return { ok: false, error: "no Command Code CLI executable resolved" };
  const argv = Array.isArray(input.argv) ? input.argv : [];
  if (argv.length === 0) return { ok: false, error: "no Command Code argv built" };

  for (const a of argv) {
    if (typeof a !== "string") {
      return { ok: false, error: `non-string Command Code argv token: ${JSON.stringify(a)}` };
    }
    if (a.includes("\0")) {
      return { ok: false, error: `Command Code argv token contains a NUL, which cannot cross a process boundary: ${JSON.stringify(a)}` };
    }
  }

  const platform = input.platform || process.platform;
  const exe = resolveCliExecutable(raw, { platform, env: input.env || process.env, exists: input.exists || fileExists }) || "";
  if (/[\0\r\n"]/.test(exe)) {
    return { ok: false, error: `unsafe Command Code CLI path: ${JSON.stringify(exe)}` };
  }

  // Official/provider CLI entries may be Node shebang scripts (for example the
  // macOS npm `cmd` symlink -> dist/index.mjs uses `#!/usr/bin/env node`). A GUI
  // or LaunchAgent-style sparse PATH may not contain the Node binary even though
  // CrewDispatch itself is already running under a valid Node runtime. Execute a
  // proven Node-shebang file through THIS runtime on every platform: shell:false,
  // no startup-file dependency, and every CLI flag remains an independent argv
  // token. Windows also needs this because CreateProcess does not interpret
  // shebangs at all.
  if (fileExists(exe)) {
    try {
      const head = fs.readFileSync(exe, { encoding: "utf8" }).slice(0, 160);
      if (/^#![^\r\n]*\bnode\b/i.test(head)) {
        return {
          ok: true,
          plan: { file: process.execPath, args: [exe, ...argv], windowsVerbatimArguments: false, shellShim: null }
        };
      }
    } catch {
      // Fall through: the ordinary direct-spawn path will surface the OS error.
    }
  }

  if (platform === "win32" && /\.(cmd|bat)$/i.test(exe)) {
    for (const a of argv) {
      const problem = cmdShimTokenProblem(a);
      if (problem) {
        return {
          ok: false,
          error:
            `The Command Code CLI is a Windows .cmd/.bat script (${JSON.stringify(exe)}) and one of its arguments contains ${problem}; ` +
            `cmd.exe cannot pass it through verbatim, so startup is refused rather than silently truncating the task. Offending argument: ${JSON.stringify(a)}. ` +
            `Point the CLI at the underlying executable (for example node.exe plus the CLI's js entry point) instead of the .cmd/.bat script.`
        };
      }
    }
    const line = `"${exe}" ${argv.map((a) => `"${a}"`).join(" ")}`;
    const com = typeof input.comSpec === "string" && input.comSpec.trim() ? input.comSpec.trim() : "cmd.exe";
    return {
      ok: true,
      plan: { file: com, args: ["/d", "/s", "/v:off", "/c", `"${line}"`], windowsVerbatimArguments: true, shellShim: exe }
    };
  }

  // A native executable receives each token as its own argv element (Node quotes
  // it), but a line/quote break is still refused: it is never a legitimate flag,
  // enum value or id, and it is exactly what a shell would have reinterpreted.
  for (const a of argv) {
    if (/[\r\n"]/.test(a)) {
      return { ok: false, error: `unsafe Command Code argv token: ${JSON.stringify(a)}` };
    }
  }

  return { ok: true, plan: { file: exe, args: [...argv], windowsVerbatimArguments: false, shellShim: null } };
}
