import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexQueueSpawn, resolveCodexCli } from "../mcp/notify";

export const CODEX_MARKETPLACE_NAME = "crewdispatch-local";
export const CODEX_PLUGIN_NAME = "crewdispatch";
export const CODEX_PLUGIN_ID = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;
export const CODEX_INSTALL_MANIFEST = "crewdispatch-install.json";
const CODEX_INSTALL_FORMAT_VERSION = 1;

export interface CodexCliResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  error: string | null;
}

export interface CodexClientOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  codexCliPath?: string | null;
  timeoutMs?: number;
  runCli?: (args: string[]) => CodexCliResult;
  runPromptScript?: (script: string) => CodexCliResult;
}

export interface CodexClientOperationResult {
  ok: boolean;
  command: "codex-install" | "codex-uninstall";
  target: string;
  codexHome: string;
  marketplace: Record<string, unknown>;
  plugin: Record<string, unknown>;
  prompt: Record<string, unknown>;
  warnings: string[];
  conflicts: { target: string; reason: string }[];
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function codexHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const raw = env.CODEX_HOME?.trim();
  if (raw && path.isAbsolute(raw)) return path.resolve(raw);
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".codex");
}

interface CodexInstallManifest {
  product: "crewdispatch";
  formatVersion: number;
  target: string;
  marketplaceInstalled: boolean;
  pluginInstalled: boolean;
  promptInstalled: boolean;
}

function manifestPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return path.join(codexHome(env, platform), CODEX_INSTALL_MANIFEST);
}

function readManifest(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): CodexInstallManifest | null {
  const file = manifestPath(env, platform);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CodexInstallManifest>;
    if (parsed.product !== "crewdispatch" || parsed.formatVersion !== CODEX_INSTALL_FORMAT_VERSION || typeof parsed.target !== "string") return null;
    return {
      product: "crewdispatch",
      formatVersion: CODEX_INSTALL_FORMAT_VERSION,
      target: parsed.target,
      marketplaceInstalled: parsed.marketplaceInstalled === true,
      pluginInstalled: parsed.pluginInstalled === true,
      promptInstalled: parsed.promptInstalled === true
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null;
  }
}

function writeManifest(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, manifest: CodexInstallManifest): void {
  const file = manifestPath(env, platform);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function runCodex(args: string[], opts: CodexClientOptions): CodexCliResult {
  if (opts.runCli) return opts.runCli(args);
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cli = resolveCodexCli({ codexCliPath: opts.codexCliPath, env, platform });
  let plan;
  try {
    plan = buildCodexQueueSpawn(cli, args, { platform, env, comSpec: env.ComSpec || env.COMSPEC });
  } catch (error) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: String((error as Error)?.message || error) };
  }
  let run: SpawnSyncReturns<string>;
  try {
    run = spawnSync(plan.file, plan.args, {
      env,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 20_000,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: String((error as Error)?.message || error) };
  }
  const stdout = String(run.stdout || "").trim();
  const stderr = String(run.stderr || "").trim();
  return {
    ok: !run.error && run.status === 0,
    exitCode: run.status,
    stdout,
    stderr,
    json: parseJson(stdout),
    error: run.error ? run.error.message : null
  };
}

function runPrompt(script: string, opts: CodexClientOptions): CodexCliResult {
  if (opts.runPromptScript) return opts.runPromptScript(script);
  const run = spawnSync(process.execPath, [script], {
    env: opts.env ?? process.env,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  const stdout = String(run.stdout || "").trim();
  const stderr = String(run.stderr || "").trim();
  return {
    ok: !run.error && run.status === 0,
    exitCode: run.status,
    stdout,
    stderr,
    json: null,
    error: run.error ? run.error.message : null
  };
}

function summarize(result: CodexCliResult): Record<string, unknown> {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    ...(result.json ? { result: result.json } : {}),
    ...(result.stdout && !result.json ? { stdout: result.stdout.slice(-2000) } : {}),
    ...(result.stderr ? { stderr: result.stderr.slice(-2000) } : {}),
    ...(result.error ? { error: result.error } : {})
  };
}

function canonical(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

type OwnershipStatus = "owned" | "absent" | "foreign" | null;

function marketplaceOwnership(list: CodexCliResult, target: string, platform: NodeJS.Platform): OwnershipStatus {
  if (!list.ok || !list.json) return null;
  const rows = Array.isArray(list.json.marketplaces) ? list.json.marketplaces : [];
  const item = rows.find((row) => row && typeof row === "object" && (row as Record<string, unknown>).name === CODEX_MARKETPLACE_NAME) as Record<string, unknown> | undefined;
  if (!item) return "absent";
  const root = typeof item.root === "string" ? item.root : "";
  return root !== "" && canonical(root, platform) === canonical(target, platform) ? "owned" : "foreign";
}

function pluginOwnership(list: CodexCliResult, target: string, platform: NodeJS.Platform): OwnershipStatus {
  if (!list.ok || !list.json) return null;
  const rows = Array.isArray(list.json.installed) ? list.json.installed : [];
  const item = rows.find((row) => row && typeof row === "object" && (row as Record<string, unknown>).pluginId === CODEX_PLUGIN_ID) as Record<string, unknown> | undefined;
  if (!item) return "absent";
  const marketplaceSource = item.marketplaceSource && typeof item.marketplaceSource === "object"
    ? item.marketplaceSource as Record<string, unknown>
    : null;
  const source = marketplaceSource && typeof marketplaceSource.source === "string" ? marketplaceSource.source : "";
  return source !== "" && canonical(source, platform) === canonical(target, platform) ? "owned" : "foreign";
}
export function installCodexClient(targetArg: string, opts: CodexClientOptions = {}): CodexClientOperationResult {
  const target = path.resolve(targetArg);
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const conflicts: { target: string; reason: string }[] = [];
  const promptScript = path.join(target, "scripts", "install-codex-command.cjs");
  const marketplaceFile = path.join(target, ".agents", "plugins", "marketplace.json");
  const existingManifestFile = manifestPath(env, platform);
  if (fs.existsSync(existingManifestFile)) {
    const existingManifest = readManifest(env, platform);
    if (!existingManifest || canonical(existingManifest.target, platform) !== canonical(target, platform)) {
      conflicts.push({ target: existingManifestFile, reason: "an unrecognized or different-install CrewDispatch Codex ownership manifest was preserved" });
      return {
        ok: false,
        command: "codex-install",
        target,
        codexHome: codexHome(env, platform),
        marketplace: { ok: false, skipped: true },
        plugin: { ok: false, skipped: true },
        prompt: { ok: false, skipped: true },
        warnings: ["Codex caller integration was not changed because its ownership manifest could not be safely reused."],
        conflicts
      };
    }
  }

  const prompt = fs.existsSync(promptScript)
    ? runPrompt(promptScript, opts)
    : { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: `missing prompt installer: ${promptScript}` } satisfies CodexCliResult;
  if (!prompt.ok) warnings.push("Codex composer prompt was not installed; existing user content may have been preserved.");

  if (!fs.existsSync(marketplaceFile)) {
    const missing = { ok: false, error: `missing CrewDispatch marketplace: ${marketplaceFile}` };
    return {
      ok: false,
      command: "codex-install",
      target,
      codexHome: codexHome(env, platform),
      marketplace: missing,
      plugin: { ok: false, skipped: true },
      prompt: summarize(prompt),
      warnings: [...warnings, "Codex plugin marketplace payload is missing."],
      conflicts
    };
  }

  const marketplace = runCodex(["plugin", "marketplace", "add", target, "--json"], opts);
  if (!marketplace.ok) warnings.push("Codex plugin marketplace registration was not completed.");
  const plugin = marketplace.ok
    ? runCodex(["plugin", "add", CODEX_PLUGIN_ID, "--json"], opts)
    : { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: "marketplace registration failed" } satisfies CodexCliResult;
  if (!plugin.ok) warnings.push("Codex plugin was not installed or refreshed.");

  let manifestWritten = false;
  try {
    writeManifest(env, platform, {
      product: "crewdispatch",
      formatVersion: CODEX_INSTALL_FORMAT_VERSION,
      target,
      marketplaceInstalled: marketplace.ok,
      pluginInstalled: plugin.ok,
      promptInstalled: prompt.ok
    });
    manifestWritten = true;
  } catch (error) {
    warnings.push(`Codex caller ownership manifest was not written: ${String((error as Error)?.message || error)}`);
  }

  return {
    ok: prompt.ok && marketplace.ok && plugin.ok && manifestWritten,
    command: "codex-install",
    target,
    codexHome: codexHome(env, platform),
    marketplace: summarize(marketplace),
    plugin: summarize(plugin),
    prompt: summarize(prompt),
    warnings,
    conflicts
  };
}

export function uninstallCodexClient(targetArg: string, opts: CodexClientOptions = {}): CodexClientOperationResult {
  const target = path.resolve(targetArg);
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const conflicts: { target: string; reason: string }[] = [];
  const promptScript = path.join(target, "scripts", "uninstall-codex-command.cjs");
  const prompt = fs.existsSync(promptScript)
    ? runPrompt(promptScript, opts)
    : { ok: true, exitCode: 0, stdout: "prompt uninstaller already absent", stderr: "", json: null, error: null } satisfies CodexCliResult;
  if (!prompt.ok) {
    conflicts.push({ target: path.join(codexHome(env, platform), "prompts", "crewdispatch.md"), reason: "the CrewDispatch prompt was edited or could not be safely removed" });
  }

  const manifest = readManifest(env, platform);
  const manifestOwned = manifest !== null && canonical(manifest.target, platform) === canonical(target, platform);

  let registrationConflict = false;
  let plugin: CodexCliResult;
  if (manifestOwned && manifest!.pluginInstalled) {
    const listedPlugin = runCodex(["plugin", "list", "--marketplace", CODEX_MARKETPLACE_NAME, "--json"], opts);
    const ownership = pluginOwnership(listedPlugin, target, platform);
    if (ownership === "owned") {
      plugin = runCodex(["plugin", "remove", CODEX_PLUGIN_ID, "--json"], opts);
      if (!plugin.ok) warnings.push("Codex plugin removal failed.");
    } else if (ownership === "absent") {
      plugin = { ok: true, exitCode: 0, stdout: "plugin already absent", stderr: "", json: null, error: null };
    } else {
      plugin = listedPlugin;
      registrationConflict = true;
      warnings.push(ownership === "foreign" ? "Codex plugin points at a different marketplace root; it was preserved." : "Could not verify Codex plugin ownership; it was preserved.");
      conflicts.push({ target: CODEX_PLUGIN_ID, reason: ownership === "foreign" ? "plugin points at a different marketplace root" : "plugin ownership could not be verified" });
    }
  } else {
    plugin = { ok: true, exitCode: 0, stdout: "plugin was not installed by this CrewDispatch installation", stderr: "", json: null, error: null };
  }

  let marketplace: CodexCliResult;
  if (manifestOwned && manifest!.marketplaceInstalled && plugin.ok && !registrationConflict) {
    const listedMarketplaces = runCodex(["plugin", "marketplace", "list", "--json"], opts);
    const ownership = marketplaceOwnership(listedMarketplaces, target, platform);
    if (ownership === "owned") {
      marketplace = runCodex(["plugin", "marketplace", "remove", CODEX_MARKETPLACE_NAME, "--json"], opts);
      if (!marketplace.ok) warnings.push("Codex marketplace removal failed.");
    } else if (ownership === "absent") {
      marketplace = { ok: true, exitCode: 0, stdout: "marketplace already absent", stderr: "", json: null, error: null };
    } else {
      marketplace = listedMarketplaces;
      registrationConflict = true;
      warnings.push(ownership === "foreign" ? "Codex marketplace name now points at a different root; it was preserved." : "Could not verify Codex marketplace ownership; it was preserved.");
      conflicts.push({ target: CODEX_MARKETPLACE_NAME, reason: ownership === "foreign" ? "marketplace name points at a different root" : "marketplace ownership could not be verified" });
    }
  } else if (manifestOwned && manifest!.marketplaceInstalled) {
    marketplace = { ok: false, exitCode: null, stdout: "", stderr: "", json: null, error: "plugin cleanup is unresolved; marketplace was preserved" };
    warnings.push("Codex marketplace was preserved because plugin cleanup is unresolved.");
  } else {
    marketplace = { ok: true, exitCode: 0, stdout: "marketplace was not installed by this CrewDispatch installation", stderr: "", json: null, error: null };
  }

  if (manifestOwned && plugin.ok && marketplace.ok && !registrationConflict) {
    try { fs.rmSync(manifestPath(env, platform), { force: true }); }
    catch (error) { warnings.push(`Codex caller ownership manifest could not be removed: ${String((error as Error)?.message || error)}`); }
  } else if (manifestOwned) {
    warnings.push("Codex caller ownership manifest was preserved so an unresolved plugin/marketplace cleanup can be retried safely.");
  }
  return {
    ok: prompt.ok && plugin.ok && marketplace.ok && conflicts.length === 0,
    command: "codex-uninstall",
    target,
    codexHome: codexHome(env, platform),
    marketplace: summarize(marketplace),
    plugin: summarize(plugin),
    prompt: summarize(prompt),
    warnings,
    conflicts
  };
}