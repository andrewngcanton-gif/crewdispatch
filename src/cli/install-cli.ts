import { doctorClaudeClient, installClaudeClient, uninstallClaudeClient } from "../claude/client-install";
import { doctor } from "../install/doctor";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { InstallError, inspectManagedTarget, install, purgeDataRoot, uninstall, upgrade } from "../install/manager";
import { resolveDataRoot } from "../jobs/store";
import { REQUIRED_NODE_MAJOR } from "../install/node-runtime";

type Command =
  | "install"
  | "upgrade"
  | "uninstall"
  | "complete-uninstall"
  | "doctor"
  | "claude-install"
  | "claude-upgrade"
  | "claude-reinstall"
  | "claude-uninstall"
  | "claude-doctor";

interface ParsedArgs {
  command: Command | null;
  target: string | null;
  config: string | null;
  help: boolean;
  purgeData: boolean;
}

const COMMANDS: readonly Command[] = ["install", "upgrade", "uninstall", "complete-uninstall", "doctor"];
const CLAUDE_COMMANDS: readonly Command[] = ["claude-install", "claude-upgrade", "claude-reinstall", "claude-uninstall", "claude-doctor"];

function isClaudeCommand(command: Command): boolean {
  return CLAUDE_COMMANDS.includes(command);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: null, target: null, config: null, help: true, purgeData: false };
  }
  const command = argv[0];
  if (!COMMANDS.includes(command as Command) && !CLAUDE_COMMANDS.includes(command as Command)) {
    throw new InstallError("unknown_command", `Unknown command: ${command ?? ""}.`, { commands: [...COMMANDS, ...CLAUDE_COMMANDS] });
  }
  let target: string | null = null;
  let config: string | null = null;
  let help = false;
  let purgeData = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--purge-data") {
      purgeData = true;
      continue;
    }
    if (arg === "--target") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new InstallError("target_required", "--target must be followed by an absolute path.");
      if (target !== null) throw new InstallError("duplicate_target", "--target may appear only once.");
      target = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      if (target !== null) throw new InstallError("duplicate_target", "--target may appear only once.");
      target = arg.slice("--target=".length);
      if (!target) throw new InstallError("target_required", "--target must be followed by an absolute path.");
      continue;
    }
    if (arg === "--config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new InstallError("config_required", "--config must be followed by a directory path.");
      if (config !== null) throw new InstallError("duplicate_config", "--config may appear only once.");
      config = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      if (config !== null) throw new InstallError("duplicate_config", "--config may appear only once.");
      config = arg.slice("--config=".length);
      if (!config) throw new InstallError("config_required", "--config must be followed by a directory path.");
      continue;
    }
    throw new InstallError("unknown_option", `Unsupported argument: ${arg}.`);
  }
  const parsed = command as Command;
  if (purgeData && parsed !== "complete-uninstall") {
    throw new InstallError("unsupported_option", "--purge-data applies only to complete-uninstall.");
  }
  if (isClaudeCommand(parsed) && target !== null) {
    throw new InstallError("unsupported_option", `--target does not apply to ${parsed}; the Claude client install is user-level. Use --config to select a configuration directory.`);
  }
  if (!isClaudeCommand(parsed) && config !== null) {
    throw new InstallError("unsupported_option", `--config does not apply to ${parsed}; use --target <absolute-directory>.`);
  }
  return { command: parsed, target, config, help, purgeData };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(command: Command | null): void {
  const usage = command && isClaudeCommand(command)
    ? `node dist/cli/install-cli.js ${command} [--config <claude-config-directory>]`
    : command === "complete-uninstall"
      ? "node dist/cli/install-cli.js complete-uninstall --target <absolute-directory> [--purge-data]"
    : command
      ? `node dist/cli/install-cli.js ${command} --target <absolute-directory>`
      : "node dist/cli/install-cli.js <install|upgrade|uninstall|complete-uninstall|doctor> --target <absolute-directory> [--purge-data]\n" +
        "node dist/cli/install-cli.js <claude-install|claude-reinstall|claude-uninstall|claude-doctor> [--config <claude-config-directory>]";
  print({
    ok: true,
    usage,
    commands: COMMANDS,
    claudeCommands: CLAUDE_COMMANDS,
    notes: [
      "The target must be given explicitly as an absolute path.",
      "install accepts only a directory that does not yet exist; upgrade, uninstall, and complete-uninstall accept only a directory that carries the CrewDispatch install marker.",
      "complete-uninstall also removes unmodified Codex/Claude caller integration. Add --purge-data to remove the dedicated JobQuay/CrewDispatch data root after safety validation; edited or foreign caller files are preserved and reported.",
      "install/upgrade registers (and refreshes) the Dashboard login autostart for the current Windows user; uninstall removes only the CrewDispatch entry that points at this installation. A registration failure is reported as a downgrade and does not block the install commit.",
      "doctor outputs JSON and checks supported local CLI metadata without sending a model prompt.",
      "claude-install/claude-reinstall install or refresh the user-level Claude Code caller integration (MCP registration, dispatch skill, compact command, SessionStart/SessionEnd binding hooks). Without --config they use the official default locations (~/.claude and ~/.claude.json); --config <dir> (or CLAUDE_CONFIG_DIR) selects an explicit configuration directory.",
      "claude-uninstall removes only entries and files recorded as managed by a previous claude-install; edited or foreign entries are preserved.",
      "claude-doctor separates installation integrity and the MCP smoke probe from wake capability; it never reads credentials or session tokens."
    ]
  });
}

function cleanupCodexCaller(target: string): Record<string, unknown> {
  const script = path.join(target, "scripts", "uninstall-codex-command.cjs");
  if (!fs.existsSync(script)) return { ok: true, status: "already_absent" };
  const run = spawnSync(process.execPath, [script], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const stdout = String(run.stdout || "").trim();
  const stderr = String(run.stderr || "").trim();
  if (run.error) return { ok: false, status: "error", error: run.error.message, stdout, stderr };
  if (run.status === 0) return { ok: true, status: "removed_or_absent", stdout };
  // The Codex cleanup intentionally exits non-zero when a user-edited prompt is
  // preserved. Complete uninstall reports that conflict but continues safely.
  return { ok: false, status: "preserved_or_error", exitCode: run.status, stdout, stderr };
}

function cleanupClaudeCaller(): Record<string, unknown> {
  try {
    const result = uninstallClaudeClient();
    return { ...result, status: result.ok ? "removed_or_absent" : "preserved_conflicts" };
  } catch (e) {
    if (e instanceof InstallError && e.code === "not_managed") return { ok: true, status: "already_absent" };
    return { ok: false, status: "error", error: String((e as Error)?.message || e) };
  }
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    const error = e instanceof InstallError ? e : new InstallError("invalid_arguments", String((e as Error).message || e));
    print({ ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return 2;
  }
  if (parsed.help) {
    help(parsed.command);
    return 0;
  }
  if (!parsed.command) {
    const error = new InstallError("command_required", "A command is required.");
    print({ ok: false, error: { code: error.code, message: error.message } });
    return 2;
  }
  if (isClaudeCommand(parsed.command)) {
    if (Number(process.versions.node.split(".")[0]) < REQUIRED_NODE_MAJOR) {
      print({ ok: false, command: parsed.command, error: { code: "node_version_unsupported", message: `The CrewDispatch installer requires Node.js >=${REQUIRED_NODE_MAJOR}.`, actual: process.version } });
      return 2;
    }
    try {
      const options = { configDir: parsed.config };
      if (parsed.command === "claude-install" || parsed.command === "claude-upgrade" || parsed.command === "claude-reinstall") {
        print(installClaudeClient(options));
      } else if (parsed.command === "claude-uninstall") {
        print(uninstallClaudeClient(options));
      } else {
        const report = await doctorClaudeClient(options);
        print(report);
        return report.ok === true ? 0 : 1;
      }
      return 0;
    } catch (e) {
      if (e instanceof InstallError) {
        print({ ok: false, command: parsed.command, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
      } else {
        print({ ok: false, command: parsed.command, error: { code: "internal_error", message: String((e as Error)?.message || e) } });
      }
      return 1;
    }
  }
  if (!parsed.target) {
    const error = new InstallError("target_required", "--target <absolute-directory> is required.");
    print({ ok: false, error: { code: error.code, message: error.message } });
    return 2;
  }
  if (Number(process.versions.node.split(".")[0]) < REQUIRED_NODE_MAJOR) {
    print({ ok: false, command: parsed.command, error: { code: "node_version_unsupported", message: `The CrewDispatch installer requires Node.js >=${REQUIRED_NODE_MAJOR}.`, actual: process.version } });
    return 2;
  }

  try {
    if (parsed.command === "install") print(install(parsed.target));
    else if (parsed.command === "upgrade") print(upgrade(parsed.target));
    else if (parsed.command === "uninstall") print(uninstall(parsed.target));
    else if (parsed.command === "complete-uninstall") {
      const managed = inspectManagedTarget(parsed.target);
      if (!managed.marker) {
        throw new InstallError(managed.markerError || "not_managed", "Complete uninstall requires a valid managed CrewDispatch installation before caller cleanup.", { target: parsed.target });
      }
      let dataRoot: string | null = null;
      let dataResolutionError: string | null = null;
      if (parsed.purgeData) {
        try {
          dataRoot = resolveDataRoot(undefined, process.env);
        } catch (e) {
          dataResolutionError = String((e as Error)?.message || e);
        }
      }
      const callers = {
        codex: cleanupCodexCaller(parsed.target),
        claude: cleanupClaudeCaller()
      };
      const core = uninstall(parsed.target);
      let data: Record<string, unknown> = { ok: true, requested: false, path: null, removed: false, alreadyAbsent: false };
      if (parsed.purgeData) {
        if (dataResolutionError) {
          data = { ok: false, requested: true, path: null, removed: false, alreadyAbsent: false, error: dataResolutionError };
        } else {
          try {
            data = { ok: true, requested: true, ...purgeDataRoot(dataRoot!, parsed.target) };
          } catch (e) {
            data = {
              ok: false,
              requested: true,
              path: dataRoot,
              removed: false,
              alreadyAbsent: false,
              error: e instanceof InstallError ? { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } : String((e as Error)?.message || e)
            };
          }
        }
      }
      const callerCleanupOk = callers.codex.ok === true && callers.claude.ok === true;
      const dataCleanupOk = !parsed.purgeData || data.ok === true;
      print({
        ...core,
        command: "complete-uninstall",
        callers,
        data,
        dataRootUntouched: !parsed.purgeData || data.ok !== true,
        complete: callerCleanupOk && dataCleanupOk
      });
    }
    else {
      const report = await doctor(parsed.target);
      print(report);
      return report.ok === true ? 0 : 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof InstallError) {
      print({ ok: false, command: parsed.command, error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
    } else {
      print({ ok: false, command: parsed.command, error: { code: "internal_error", message: String((e as Error)?.message || e) } });
    }
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    print({ ok: false, error: { code: "internal_error", message: String((e as Error)?.message || e) } });
    process.exitCode = 1;
  });
