// probe-cli.ts — REAL process entry: probe the user-installed official Command
// Code CLI from the BUILT artifact (dist/cli/probe-cli.js).
//
//   npm.cmd run smoke      -> node dist/cli/probe-cli.js
//
// What it does, against the real installed executable only:
//   1. resolve the official CLI (env / config / PATH) and report its source;
//   2. create the SAME isolated environment used by the one-shot entry (a
//      disposable temp home + credential hygiene, see run-isolation.ts) BEFORE
//      any probe, and report its path;
//   3. `cmdc --version`, `cmdc --help`, `cmdc --list-models` (public, read-only,
//      cannot submit a prompt), each with a finite probe timeout and the SAME
//      isolated env + cwd;
//   4. print the public capability decision (`--effort` only when the CLI's own
//      help publishes it) and the model catalog as the CLI published it.
//
// Nothing is mocked, no real credential or provider database is read, no CLI is
// bundled and no file is written outside the disposable tree. A probe that cannot
// be completed is reported as an explicit failure (never silently "unknown"), and
// the catalog is NEVER taken from the real user profile as a fallback: if
// `--list-models` yields nothing under isolation, the smoke reports that honestly.
//
// The isolated CLI home starts empty, so a probe that needs auth may legitimately
// fail or return an empty catalog. The child environment is a minimal
// non-credential allowlist (see run-isolation.ts), so the operator's everyday
// provider credentials are not inherited. To use a DEDICATED test credential, the
// operator names it explicitly: `--credential-env COMMAND_CODE_API_KEY` (the value
// is read from the operator's own environment for this run only; only the name is
// reported, never the value).
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { describeCommandCodeCliSource } from "../providers/command-code/discovery";
import { findEffortHelpLines } from "../providers/command-code/capability";
import { runCliProbe } from "../providers/command-code/probe";
import { createCliIsolation, describeCliIsolation, parseForwardCredentialEnv } from "./run-isolation";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" ? v : null;
}

async function main(): Promise<number> {
  const explicitPath = argValue("--cli-path");
  const timeoutMs = Number(argValue("--timeout") || "") || undefined;
  const forwardCredentialEnv = parseForwardCredentialEnv(process.argv);

  const adapter = createCommandCodeAdapter();
  const resolution = adapter.resolveCli(explicitPath ? { configPath: explicitPath } : {});

  const report: Record<string, unknown> = {
    entry: "dist/cli/probe-cli.js",
    node: process.version,
    platform: process.platform,
    args: process.argv.slice(2),
    resolution: {
      ok: resolution.ok,
      path: resolution.path,
      source: resolution.source,
      sourceLabel: describeCommandCodeCliSource(resolution.source),
      reason: resolution.reason ?? null
    }
  };

  if (!resolution.ok || !resolution.path) {
    report.error = "The official Command Code CLI was not found; no probe was performed.";
    console.log(JSON.stringify(report, null, 2));
    return 1;
  }

  // Isolation is created BEFORE any official-CLI probe, and the same env + cwd
  // are passed to every probe below.
  const isolation = createCliIsolation({ tempPrefix: "jobquay-probe-", forwardCredentialEnv });
  report.isolation = describeCliIsolation(isolation);

  const probeInput = { cliPath: resolution.path, timeoutMs, env: isolation.env, cwd: isolation.cwd };
  const capabilities = await adapter.probeCapabilities(probeInput);
  const versionProbe = runCliProbe({ cliPath: resolution.path, args: ["--version"], timeoutMs, env: isolation.env, cwd: isolation.cwd });
  const helpProbe = runCliProbe({ cliPath: resolution.path, args: ["--help"], timeoutMs, env: isolation.env, cwd: isolation.cwd });
  const catalog = await adapter.readModelCatalog(probeInput);

  report.probes = {
    version: { ok: versionProbe.ok, exitCode: versionProbe.exitCode, stdout: versionProbe.stdout.trim(), error: versionProbe.error },
    help: {
      ok: helpProbe.ok,
      exitCode: helpProbe.exitCode,
      bytes: helpProbe.stdout.length,
      head: helpProbe.stdout.slice(0, 1200),
      error: helpProbe.error
    },
    listModels: {
      ok: catalog.ok,
      error: catalog.error,
      rawHead: catalog.raw ? catalog.raw.slice(0, 1200) : null
    }
  };
  report.capabilities = {
    supportsEffort: capabilities.supportsEffort,
    effortHelpEvidence: findEffortHelpLines(capabilities.helpText),
    permissionModes: capabilities.permissionModes,
    errors: capabilities.errors
  };
  report.catalog = {
    ok: catalog.ok,
    source: catalog.source,
    count: catalog.models.length,
    defaultModel: catalog.defaultModel,
    models: catalog.models.slice(0, 20)
  };

  const ok = catalog.ok && capabilities.ok;
  report.result = ok ? "ok" : "failed";
  console.log(JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code));
