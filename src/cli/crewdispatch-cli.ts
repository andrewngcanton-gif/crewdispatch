#!/usr/bin/env node
"use strict";

import { DashboardLauncherError, DEFAULT_DASHBOARD_PORT, ensureDashboard } from "../dashboard/launcher";
import { autostartDiagnosticPath, runDashboardAutostart, type AutostartRunRecord } from "../dashboard/autostart";
import {
  inspectDashboardAutostart,
  registerDashboardAutostart,
  removeDashboardAutostart,
  type AutostartInspection
} from "../install/autostart";
import { resolveDataRoot } from "../jobs/store";

type Command = "web" | "autostart";
type AutostartAction = "run" | "status" | "enable" | "disable";

const AUTOSTART_ACTIONS: readonly AutostartAction[] = ["run", "status", "enable", "disable"];

interface ParsedArgs {
  command: Command | null;
  action: AutostartAction | null;
  noOpen: boolean;
  json: boolean;
  help: boolean;
  port: number | undefined;
  target: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: Command | null = null;
  let action: AutostartAction | null = null;
  let noOpen = false;
  let json = false;
  let help = false;
  let port: number | undefined;
  let target: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--no-open") {
      noOpen = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--port") {
      const raw = argv[++i];
      if (raw == null) throw new DashboardLauncherError("invalid_arguments", "--port requires a value.");
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new DashboardLauncherError("invalid_port", `--port must be an integer from 1 to 65535; got ${JSON.stringify(raw)}.`);
      }
      port = parsed;
      continue;
    }
    if (token === "--target") {
      const raw = argv[++i];
      if (raw == null || raw.startsWith("--")) throw new DashboardLauncherError("invalid_arguments", "--target requires an installed-directory path.");
      target = raw;
      continue;
    }
    if (token.startsWith("--")) throw new DashboardLauncherError("invalid_arguments", `Unknown option: ${token}`);
    if (command == null) {
      if (token !== "web" && token !== "autostart") throw new DashboardLauncherError("invalid_arguments", `Unknown command: ${token}`);
      command = token;
      continue;
    }
    if (command === "autostart" && action == null) {
      if (!AUTOSTART_ACTIONS.includes(token as AutostartAction)) {
        throw new DashboardLauncherError("invalid_arguments", `Unknown autostart action: ${token} (expected ${AUTOSTART_ACTIONS.join(", ")}).`);
      }
      action = token as AutostartAction;
      continue;
    }
    throw new DashboardLauncherError("invalid_arguments", `Unexpected argument: ${token}`);
  }
  if (command === "autostart" && action == null) action = "status";
  return { command, action, noOpen, json, help, port, target };
}

function printHelp(): void {
  process.stdout.write([
    "CrewDispatch",
    "",
    "Usage:",
    "  crewdispatch web [--no-open] [--port <1..65535>] [--json]",
    "  crewdispatch autostart run [--port <1..65535>] [--json]",
    "  crewdispatch autostart status [--target <installed-directory>] [--json]",
    "  crewdispatch autostart enable --target <installed-directory> [--json]",
    "  crewdispatch autostart disable [--json]",
    "",
    "Commands:",
    "  web                 Ensure the local CrewDispatch Hub is running and open the Dashboard.",
    "  autostart run       Ensure the Hub headlessly (no browser); used by the user login autostart.",
    "  autostart status    Report the user-scoped Windows/macOS login autostart and its last run.",
    "  autostart enable    Register the login autostart for an installed CrewDispatch directory.",
    "  autostart disable   Remove the CrewDispatch-owned login autostart entry.",
    "",
    "Options:",
    "  --no-open Start/reuse the Hub without opening a browser.",
    `  --port    Override the Hub port (default ${DEFAULT_DASHBOARD_PORT}; HUB_PORT/PORT are also honored).`,
    "  --target  Installed CrewDispatch directory for autostart enable/status.",
    "  --json    Emit machine-readable JSON.",
    "",
    "The Dashboard is loopback-only. Windows and macOS open the system default browser;",
    "Linux uses xdg-open when available. `autostart run` never opens a browser and writes",
    "its last result to <dataRoot>/autostart/last-run.json."
  ].join("\n") + "\n");
}

function hubOutcomeLine(result: { action: AutostartRunRecord["action"]; hub_pid: number | null }): string {
  if (result.action === "started") {
    return `Hub started in the background${result.hub_pid ? ` (pid ${result.hub_pid})` : ""}.`;
  }
  if (result.action === "restarted") {
    return `Hub restarted for the current build${result.hub_pid ? ` (pid ${result.hub_pid})` : ""}; the previous build was replaced.`;
  }
  return "Hub already running; reusing it.";
}

function printRecord(record: AutostartRunRecord): void {
  const outcome = record.ok
    ? hubOutcomeLine(record)
    : `Autostart failed: ${record.error?.code ?? "unknown"} — ${record.error?.message ?? "no detail"}`;
  process.stdout.write(`CrewDispatch Dashboard autostart: ${record.url ?? `port ${record.port}`}\n`);
  process.stdout.write(`${outcome}\n`);
  process.stdout.write(`Diagnostic: ${autostartDiagnosticPath(resolveDataRoot(undefined, process.env))}\n`);
}

function printInspection(inspection: AutostartInspection): void {
  const lines: string[] = [];
  lines.push(`CrewDispatch Dashboard autostart: ${inspection.status} (${inspection.mechanism}, value "${inspection.valueName}")`);
  if (inspection.registeredCommand) lines.push(`  registered:   ${inspection.registeredCommand}`);
  if (inspection.expectedCommand) lines.push(`  expected:     ${inspection.expectedCommand}`);
  if (inspection.targetsThisInstall !== null) {
    lines.push(`  targets this installation: ${inspection.targetsThisInstall ? "yes" : `no (${inspection.registeredInstallRoot ?? "unknown"})`}`);
  }
  if (inspection.shim.path) lines.push(`  shim:         ${inspection.shim.path} (${inspection.shim.exists ? "present" : "MISSING"})`);
  if (inspection.metadata.valid) {
    lines.push(`  runtime:      ${inspection.metadata.nodePath} (${inspection.metadata.nodeExists ? "present" : "MISSING"})`);
  } else if (inspection.metadata.error) {
    lines.push(`  metadata:     ${inspection.metadata.error}`);
  }
  if (inspection.lastRun) {
    const record = inspection.lastRun;
    lines.push(`  last run:     ${record.at} ${record.action} port ${record.port}${record.hub_pid ? ` pid ${record.hub_pid}` : ""}${record.ok ? "" : ` (${record.error?.code ?? "error"})`}`);
  } else {
    lines.push(`  last run:     ${inspection.lastRunError ?? "no recorded run yet"}`);
  }
  lines.push(`  hub endpoint: port ${inspection.hubEndpoint.port ?? "unknown"} ${inspection.hubEndpoint.state}${inspection.hubEndpoint.version ? ` (version ${inspection.hubEndpoint.version})` : ""}`);
  if (inspection.error) lines.push(`  problem:      ${inspection.error.code} — ${inspection.error.message}`);
  if (inspection.hint) lines.push(`  hint:         ${inspection.hint}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const e = error instanceof DashboardLauncherError ? error : new DashboardLauncherError("invalid_arguments", String((error as Error)?.message || error));
    process.stderr.write(`CrewDispatch: ${e.message}\n`);
    return 2;
  }

  if (parsed.help || parsed.command == null) {
    printHelp();
    return 0;
  }

  try {
    if (parsed.command === "web") {
      const result = await ensureDashboard({ port: parsed.port, noOpen: parsed.noOpen });
      if (parsed.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        process.stdout.write(`CrewDispatch Dashboard: ${result.url}\n`);
        process.stdout.write(`${hubOutcomeLine(result)}\n`);
        if (parsed.noOpen) process.stdout.write("Browser opening skipped (--no-open).\n");
        else process.stdout.write("Opened in the system default browser.\n");
      }
      return 0;
    }

    if (parsed.action === "run") {
      const result = await runDashboardAutostart({ port: parsed.port });
      if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else printRecord(result.record);
      return result.ok ? 0 : 1;
    }

    if (parsed.action === "status") {
      const inspection = await inspectDashboardAutostart({ target: parsed.target });
      if (parsed.json) process.stdout.write(JSON.stringify(inspection, null, 2) + "\n");
      else printInspection(inspection);
      return inspection.status === "healthy" || inspection.status === "disabled" || inspection.status === "unsupported" ? 0 : 1;
    }

    if (parsed.action === "enable") {
      if (!parsed.target) {
        throw new DashboardLauncherError("target_required", "autostart enable requires --target <installed-directory>.");
      }
      const result = registerDashboardAutostart(parsed.target);
      if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else if (result.ok && result.registered) process.stdout.write(`Dashboard autostart registered: ${result.command}\n`);
      else if (result.ok) process.stdout.write(`Dashboard autostart not registered: ${result.note ?? "not supported on this platform"}\n`);
      else process.stderr.write(`CrewDispatch: ${result.error?.code}: ${result.error?.message}\n`);
      return result.ok ? 0 : 1;
    }

    if (parsed.action === "disable") {
      const result = removeDashboardAutostart({});
      if (parsed.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else if (!result.ok) process.stderr.write(`CrewDispatch: ${result.error?.code}: ${result.error?.message}\n`);
      else if (result.removed) process.stdout.write(`Dashboard autostart removed (${result.valueName}).\n`);
      else process.stdout.write(`Dashboard autostart was not registered (${result.reason}).\n`);
      return result.ok ? 0 : 1;
    }

    throw new DashboardLauncherError("invalid_arguments", `Unsupported command: ${parsed.command} ${parsed.action ?? ""}`.trim());
  } catch (error) {
    const e = error instanceof DashboardLauncherError ? error : new DashboardLauncherError("dashboard_failed", String((error as Error)?.message || error));
    if (parsed.json) process.stdout.write(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2) + "\n");
    else process.stderr.write(`CrewDispatch: ${e.message}\n`);
    return 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`CrewDispatch: ${String((error as Error)?.message || error)}\n`);
    process.exitCode = 1;
  });
