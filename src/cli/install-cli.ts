import { doctorClaudeClient, installClaudeClient, uninstallClaudeClient } from "../claude/client-install";
import { doctor } from "../install/doctor";
import { InstallError, install, uninstall, upgrade } from "../install/manager";
import { REQUIRED_NODE_MAJOR } from "../install/node-runtime";

type Command =
  | "install"
  | "upgrade"
  | "uninstall"
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
}

const COMMANDS: readonly Command[] = ["install", "upgrade", "uninstall", "doctor"];
const CLAUDE_COMMANDS: readonly Command[] = ["claude-install", "claude-upgrade", "claude-reinstall", "claude-uninstall", "claude-doctor"];

function isClaudeCommand(command: Command): boolean {
  return CLAUDE_COMMANDS.includes(command);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { command: null, target: null, config: null, help: true };
  }
  const command = argv[0];
  if (!COMMANDS.includes(command as Command) && !CLAUDE_COMMANDS.includes(command as Command)) {
    throw new InstallError("unknown_command", `Unknown command: ${command ?? ""}.`, { commands: [...COMMANDS, ...CLAUDE_COMMANDS] });
  }
  let target: string | null = null;
  let config: string | null = null;
  let help = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
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
  if (isClaudeCommand(parsed) && target !== null) {
    throw new InstallError("unsupported_option", `--target does not apply to ${parsed}; the Claude client install is user-level. Use --config to select a configuration directory.`);
  }
  if (!isClaudeCommand(parsed) && config !== null) {
    throw new InstallError("unsupported_option", `--config does not apply to ${parsed}; use --target <absolute-directory>.`);
  }
  return { command: parsed, target, config, help };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help(command: Command | null): void {
  const usage = command && isClaudeCommand(command)
    ? `node dist/cli/install-cli.js ${command} [--config <claude-config-directory>]`
    : command
      ? `node dist/cli/install-cli.js ${command} --target <absolute-directory>`
      : "node dist/cli/install-cli.js <install|upgrade|uninstall|doctor> --target <absolute-directory>\n" +
        "node dist/cli/install-cli.js <claude-install|claude-reinstall|claude-uninstall|claude-doctor> [--config <claude-config-directory>]";
  print({
    ok: true,
    usage,
    commands: COMMANDS,
    claudeCommands: CLAUDE_COMMANDS,
    notes: [
      "Internal unreleased installer; the target must be given explicitly as an absolute path.",
      "install accepts only a directory that does not yet exist; upgrade and uninstall accept only a directory that carries the CrewDispatch install marker.",
      "install/upgrade registers (and refreshes) the Dashboard login autostart for the current Windows user; uninstall removes only the CrewDispatch entry that points at this installation. A registration failure is reported as a downgrade and does not block the install commit.",
      "doctor outputs JSON and checks supported local CLI metadata without sending a model prompt.",
      "claude-install/claude-reinstall install or refresh the user-level Claude Code caller integration (MCP registration, dispatch skill, compact command, SessionStart/SessionEnd binding hooks). Without --config they use the official default locations (~/.claude and ~/.claude.json); --config <dir> (or CLAUDE_CONFIG_DIR) selects an explicit configuration directory.",
      "claude-uninstall removes only entries and files recorded as managed by a previous claude-install; edited or foreign entries are preserved.",
      "claude-doctor separates installation integrity and the MCP smoke probe from wake capability; it never reads credentials or session tokens."
    ]
  });
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
