// probe.ts — bounded, read-only probing of the user-installed official CLI.
//
// Only PUBLIC commands are ever run here: `--version`, `--help` and
// `--list-models`. None of them can submit a prompt, and none of them is a job.
// The probe is therefore the ONLY place with a finite timeout: a hung CLI must
// fail explicitly instead of being waited on forever. That bound is a probe bound
// — CrewDispatch imposes NO wall-clock timeout on a real run (see
// the capability-probe contract).
//
// Spawning: shell:false always; a Windows `.cmd`/`.bat` shim goes through
// %ComSpec% via the shared spawn plan. No CLI is bundled: the path comes from the
// user's own installation (env / config / PATH).
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import os from "node:os";
import type { CapabilityProbeResult, ModelCatalogResult } from "../provider";
import { parseHelpEffortSupport, parseHelpPermissionModes } from "./capability";
import { buildCommandCodeSpawnPlan } from "./spawn-plan";
import { parseListModelsCatalog } from "./catalog";

// The first `--list-models` of a freshly started CLI is SLOW (the reference
// project measured ~6.6-8.3 s cold for the shim + the product's own
// account/model fetch, vs <1 s warm; a 5 s budget was what emptied its catalog).
// Version/help probes retain a 20 s bound. A fresh isolated --list-models
// probe exceeded that bound during acceptance on 2026-09-24; the same real
// entry completed with a 45 s bound. Keep catalog probing finite but give its
// cold start the observed headroom.
export const PROBE_TIMEOUT_MS = 20000;
export const MODEL_CATALOG_TIMEOUT_MS = 45000;
export const PROBE_MAX_BYTES = 256 * 1024;

export interface ProbeRunInput {
  cliPath: string;
  args: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  comSpec?: string;
  cwd?: string;
  /** Injectable for tests (never mocks a real CLI at acceptance). */
  spawnSyncFn?: (file: string, args: readonly string[], options: SpawnSyncOptions) => SpawnSyncReturns<string>;
}

export interface ProbeRunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timedOut: boolean;
}

export function runCliProbe(input: ProbeRunInput): ProbeRunResult {
  const built = buildCommandCodeSpawnPlan({
    cliPath: input.cliPath,
    argv: input.args,
    platform: input.platform || process.platform,
    comSpec: input.comSpec,
    env: input.env || process.env
  });
  if (!built.ok) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: built.error, timedOut: false };
  }
  const maxBytes = input.maxBytes || PROBE_MAX_BYTES;
  const run = input.spawnSyncFn || (spawnSync as (f: string, a: readonly string[], o: SpawnSyncOptions) => SpawnSyncReturns<string>);
  let res: SpawnSyncReturns<string>;
  try {
    res = run(built.plan.file, built.plan.args, {
      shell: false,
      windowsVerbatimArguments: built.plan.windowsVerbatimArguments,
      windowsHide: true,
      cwd: input.cwd || os.tmpdir(),
      env: input.env || process.env,
      timeout: input.timeoutMs || PROBE_TIMEOUT_MS,
      maxBuffer: maxBytes,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", error: String((e as Error)?.message || e), timedOut: false };
  }

  const errorText = typeof res.error === "undefined" || res.error === null ? null : String(res.error.message || res.error);
  const timedOut = !!errorText && /ETIMEDOUT|timed out/i.test(errorText);
  const stdout = typeof res.stdout === "string" ? res.stdout.slice(0, maxBytes) : "";
  const stderr = typeof res.stderr === "string" ? res.stderr.slice(0, maxBytes) : "";
  const exitCode = typeof res.status === "number" ? res.status : null;

  let error: string | null = errorText;
  if (!error && exitCode !== 0) {
    error = `exit ${exitCode ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`;
  }
  return { ok: !error && exitCode === 0, exitCode, stdout, stderr, error, timedOut };
}

export interface CapabilityProbeInput {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  comSpec?: string;
  cwd?: string;
  spawnSyncFn?: ProbeRunInput["spawnSyncFn"];
}

/** `--version` + `--help`: the CLI's own public statement of what it supports. */
export function probeCapabilities(input: CapabilityProbeInput): CapabilityProbeResult {
  const errors: string[] = [];
  const version = runCliProbe({ ...input, args: ["--version"] });
  if (!version.ok) errors.push(`--version probe failed: ${version.error || "no output"}`);
  const help = runCliProbe({ ...input, args: ["--help"] });
  if (!help.ok) errors.push(`--help probe failed: ${help.error || "no output"}`);

  return {
    ok: version.ok && help.ok,
    cliPath: input.cliPath,
    version: version.ok ? version.stdout.trim() || null : null,
    helpText: help.ok ? help.stdout || null : null,
    supportsEffort: parseHelpEffortSupport(help.stdout),
    permissionModes: parseHelpPermissionModes(help.stdout),
    errors
  };
}

export interface ModelCatalogInput extends CapabilityProbeInput {}

/** `--list-models`: the model catalog of the installed CLI (never a guess). */
export function readModelCatalog(input: ModelCatalogInput): ModelCatalogResult {
  const run = runCliProbe({ ...input, args: ["--list-models"], timeoutMs: input.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS });
  if (!run.ok) {
    return {
      ok: false,
      source: "unavailable",
      models: [],
      defaultModel: null,
      raw: run.stdout || null,
      error: run.error || "cmdc --list-models returned no usable output"
    };
  }
  const catalog = parseListModelsCatalog(run.stdout);
  if (!catalog) {
    return {
      ok: false,
      source: "unavailable",
      models: [],
      defaultModel: null,
      raw: run.stdout || null,
      error: "cmdc --list-models output could not be parsed as a model catalog (no model ID was invented)"
    };
  }
  return {
    ok: true,
    source: "cli-list-models",
    models: catalog.models,
    defaultModel: catalog.defaultModel,
    freeModels: catalog.freeModels,
    raw: run.stdout || null,
    error: null
  };
}
