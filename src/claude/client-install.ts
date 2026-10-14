// client-install.ts — the cohesive user-level installation of the LOCAL Claude
// Code caller integration (CLI and desktop Code surfaces share the same user
// configuration).
//
// What it manages:
//   * ONE user-scope MCP server entry (`crewdispatch`) in the Claude user
//     config JSON (default `~/.claude.json`; under an explicit/CLAUDE_CONFIG_DIR
//     config directory, `<configDir>/.claude.json`);
//   * ONE SessionStart hook and ONE SessionEnd hook in `<configDir>/settings.json`
//     (the binding registration/cleanup entries only — no listener, no timer);
//   * the dispatch skill at `<configDir>/skills/crewdispatch/SKILL.md` and the
//     compact composer command at `<configDir>/commands/crewdispatch.md`.
//
// Preservation rules (this module never does a broad JSON replacement):
//   * unrelated MCP servers, unrelated hooks/settings keys and every other key
//     of the user config/settings files are preserved byte-for-value;
//   * an entry/file this installer did not write (or that the user edited after
//     a previous install) is NEVER overwritten: it is reported as a conflict and
//     left untouched;
//   * a previous install's entry/file is upgraded only when it still matches
//     exactly what the recorded manifest owns;
//   * no credential, token or native inbox address is ever read, written to the
//     manifest or printed.
//
// The actual private session binding (address + token) is NOT installed here:
// it is registered at runtime by the installed SessionStart hook into the
// private binding store under the CrewDispatch data root.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonLineProcess } from "../install/doctor";
import { InstallError } from "../install/manager";
import { REQUIRED_NODE_MAJOR, probeNodeRuntimePath, resolveUserNodeRuntime } from "../install/node-runtime";
import { resolveDataRoot } from "../jobs/store";
import { listClaudeBindings } from "./binding";

const PRODUCT = "crewdispatch";
const FORMAT_VERSION = 1;
const MCP_SERVER_NAME = "crewdispatch";
const SKILL_REL = path.join("skills", "crewdispatch", "SKILL.md");
const COMMAND_REL = path.join("commands", "crewdispatch.md");
const MANIFEST_FILE = "crewdispatch-install.json";
/** Documented minimum Claude Code version for all-provider cross-session messaging. */
export const CLAUDE_MESSAGING_MIN_VERSION = "2.1.248";

export interface ClaudeClientPaths {
  configDir: string;
  userConfigFile: string;
  settingsFile: string;
  skillFile: string;
  commandFile: string;
  manifestFile: string;
  /** True when the config dir came from an explicit option / CLAUDE_CONFIG_DIR. */
  explicitConfigDir: boolean;
}

export interface ClaudeClientOptions {
  configDir?: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string | null;
  platform?: NodeJS.Platform;
  now?: () => Date;
  /** Product source root (test seam); defaults to the checkout/install root. */
  sourceRoot?: string;
  /** Claude CLI executable for the bounded version probe (test seam). */
  claudeCliPath?: string | null;
}

interface ClaudeClientFileRecord {
  path: string;
  sha256: string;
}

interface ClaudeClientManifest {
  product: "crewdispatch";
  formatVersion: number;
  configDir: string;
  userConfigFile: string;
  createdAt: string;
  updatedAt: string;
  nodePath: string;
  serverEntry: string;
  hookEntry: string;
  /** Shape ownership needed to restore empty parents/files on uninstall. */
  userConfigExistedBefore: boolean | null;
  mcpServersExistedBefore: boolean | null;
  settingsExistedBefore: boolean | null;
  hooksExistedBefore: boolean | null;
  files: ClaudeClientFileRecord[];
  mcpEntry: Record<string, unknown> | null;
  hookEntries: { sessionStart: Record<string, unknown> | null; sessionEnd: Record<string, unknown> | null };
}

export interface ClaudeClientConflict {
  target: string;
  reason: string;
}

export interface ClaudeClientOperationResult {
  ok: boolean;
  command: "claude-install" | "claude-upgrade" | "claude-uninstall" | "claude-doctor";
  configDir: string;
  userConfigFile: string;
  manifestFile: string;
  changed: string[];
  preserved: string[];
  conflicts: ClaudeClientConflict[];
  warnings: string[];
  [key: string]: unknown;
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new InstallError(code, message, details);
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True when a resolved path stays inside the given directory. */
function isInsideDir(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Stable deep equality (key order independent) for the small managed entries. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Resolve the user-level Claude configuration locations.
 *
 * Default: `~/.claude` for settings/skills/commands and `~/.claude.json` for
 * the user-scope MCP servers. An explicit `--config` directory (or the
 * documented `CLAUDE_CONFIG_DIR` override) moves BOTH under that directory:
 * `<dir>/.claude.json` and `<dir>/settings.json`. No Claude-3p, DS-model or
 * desktop-profile assumption is made anywhere.
 */
export function resolveClaudeClientPaths(opts: ClaudeClientOptions = {}): ClaudeClientPaths {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home =
    (opts.homeDir && opts.homeDir.trim()) ||
    (platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim()) ||
    env.HOME?.trim() ||
    env.USERPROFILE?.trim() ||
    os.homedir();
  const explicitRaw = (opts.configDir && opts.configDir.trim()) || env.CLAUDE_CONFIG_DIR?.trim() || "";
  const explicitConfigDir = explicitRaw !== "";
  const configDir = explicitConfigDir ? path.resolve(explicitRaw) : path.join(home, ".claude");
  const userConfigFile = explicitConfigDir ? path.join(configDir, ".claude.json") : path.join(home, ".claude.json");
  return {
    configDir,
    userConfigFile,
    settingsFile: path.join(configDir, "settings.json"),
    skillFile: path.join(configDir, SKILL_REL),
    commandFile: path.join(configDir, COMMAND_REL),
    manifestFile: path.join(configDir, MANIFEST_FILE),
    explicitConfigDir
  };
}

function readManifest(manifestFile: string): ClaudeClientManifest | null {
  let raw: string;
  try {
    const stat = fs.lstatSync(manifestFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("unsafe_managed_file", "The CrewDispatch Claude install manifest is not a regular file; refusing to touch it.", { path: manifestFile });
    }
    raw = fs.readFileSync(manifestFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid_manifest", "The CrewDispatch Claude install manifest is not valid JSON; review and remove it before reinstalling.", { path: manifestFile });
  }
  if (!isPlainObject(parsed) || parsed.product !== PRODUCT || parsed.formatVersion !== FORMAT_VERSION) {
    fail("invalid_manifest", "The CrewDispatch Claude install manifest format is unsupported.", { path: manifestFile });
  }
  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((f): f is ClaudeClientFileRecord => isPlainObject(f) && typeof f.path === "string" && typeof f.sha256 === "string")
    : [];
  return {
    product: PRODUCT,
    formatVersion: FORMAT_VERSION,
    configDir: typeof parsed.configDir === "string" ? parsed.configDir : "",
    userConfigFile: typeof parsed.userConfigFile === "string" ? parsed.userConfigFile : "",
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : nowIso(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : nowIso(),
    nodePath: typeof parsed.nodePath === "string" ? parsed.nodePath : "",
    serverEntry: typeof parsed.serverEntry === "string" ? parsed.serverEntry : "",
    hookEntry: typeof parsed.hookEntry === "string" ? parsed.hookEntry : "",
    userConfigExistedBefore: typeof parsed.userConfigExistedBefore === "boolean" ? parsed.userConfigExistedBefore : null,
    mcpServersExistedBefore: typeof parsed.mcpServersExistedBefore === "boolean" ? parsed.mcpServersExistedBefore : null,
    settingsExistedBefore: typeof parsed.settingsExistedBefore === "boolean" ? parsed.settingsExistedBefore : null,
    hooksExistedBefore: typeof parsed.hooksExistedBefore === "boolean" ? parsed.hooksExistedBefore : null,
    files,
    mcpEntry: isPlainObject(parsed.mcpEntry) ? parsed.mcpEntry : null,
    hookEntries: isPlainObject(parsed.hookEntries)
      ? {
          sessionStart: isPlainObject((parsed.hookEntries as Record<string, unknown>).sessionStart)
            ? ((parsed.hookEntries as Record<string, unknown>).sessionStart as Record<string, unknown>)
            : null,
          sessionEnd: isPlainObject((parsed.hookEntries as Record<string, unknown>).sessionEnd)
            ? ((parsed.hookEntries as Record<string, unknown>).sessionEnd as Record<string, unknown>)
            : null
        }
      : { sessionStart: null, sessionEnd: null }
  };
}

function writeManifest(manifestFile: string, manifest: ClaudeClientManifest): void {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
  const tmp = `${manifestFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, manifestFile);
}

/** Read a user JSON file, refusing links and malformed JSON instead of overwriting. */
function readUserJson(file: string, code: string): { exists: boolean; value: Record<string, unknown> } {
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("unsafe_managed_file", `Refusing to modify ${file}: it is not a regular file.`, { path: file });
    }
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, value: {} };
    throw e;
  }
  if (!raw.trim()) return { exists: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(code, `Refusing to modify ${file}: it is not valid JSON.`, { path: file });
  }
  if (!isPlainObject(parsed)) fail(code, `Refusing to modify ${file}: its top level is not a JSON object.`, { path: file });
  return { exists: true, value: parsed };
}

function writeUserJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail("unsafe_managed_file", `Refusing to modify ${file}: it is not a regular file.`, { path: file });
    }
    if (process.platform !== "win32") mode = stat.mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
  }
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  if (process.platform !== "win32") fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function quoteCommandArg(value: string): string {
  if (/["\u0000\r\n]/.test(value)) fail("unsafe_path", `A path contains a character that cannot be quoted safely: ${JSON.stringify(value)}`);
  return `"${value}"`;
}

function hookCommand(nodePath: string, hookEntry: string, mode: "session-start" | "session-end"): string {
  return `${quoteCommandArg(nodePath)} ${quoteCommandArg(hookEntry)} ${mode}`;
}

/**
 * Host-side hook timeout, in SECONDS, per event.
 *
 * SessionStart MUST exceed the bounded recovery I/O budget
 * (`RECOVERY_REQUEST_BUDGET_MS`, 15s in `src/daemon/client.ts`), because the
 * real hook first registers the binding and THEN asks the broker for one
 * bounded recovery pass. With the old 10s host timeout the host could kill the
 * hook while the bounded request was still running — before the request
 * returned AND before the hook could emit its guidance on stdout — so the
 * advertised finite bound was not actually reachable on the installed path.
 *
 * 30s covers the 15s request plus registration and ordinary overhead, and stays
 * finite. These are explicit literals on purpose: no new settings framework and
 * no resident helper for two numbers.
 *
 * SessionEnd only performs the synchronous registration cleanup and has no
 * recovery request, so it keeps its shorter bound.
 */
const SESSION_START_HOOK_TIMEOUT_S = 30;
const SESSION_END_HOOK_TIMEOUT_S = 10;

function hookEntry(mode: "session-start" | "session-end", nodePath: string, hookEntryPath: string): Record<string, unknown> {
  return {
    hooks: [
      {
        type: "command",
        command: hookCommand(nodePath, hookEntryPath, mode),
        timeout: mode === "session-start" ? SESSION_START_HOOK_TIMEOUT_S : SESSION_END_HOOK_TIMEOUT_S
      }
    ]
  };
}

/** True when a hook group contains the exact command string of one of our hooks. */
function containsCommand(entry: unknown, command: string): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => isPlainObject(h) && h.command === command);
}

function sourceRootOf(opts: ClaudeClientOptions): string {
  return opts.sourceRoot ? path.resolve(opts.sourceRoot) : path.resolve(__dirname, "..", "..");
}

interface SourceAssets {
  serverEntry: string;
  hookEntry: string;
  skillText: string;
  commandText: string;
}

function loadSourceAssets(opts: ClaudeClientOptions): SourceAssets {
  const root = sourceRootOf(opts);
  const serverEntry = path.join(root, "dist", "mcp", "server.js");
  const hookEntryPath = path.join(root, "dist", "claude", "hook.js");
  const skillSource = path.join(root, "plugins", "crewdispatch", "skills", "crewdispatch", "SKILL.md");
  const commandSource = path.join(root, "integrations", "claude", "commands", "crewdispatch.md");
  for (const file of [serverEntry, hookEntryPath, skillSource, commandSource]) {
    if (!fs.existsSync(file)) {
      fail("build_artifacts_missing", `The Claude client install needs ${file}. Run the build first and confirm the repository assets exist.`, { missing: file });
    }
  }
  return {
    serverEntry,
    hookEntry: hookEntryPath,
    skillText: fs.readFileSync(skillSource, "utf8"),
    commandText: fs.readFileSync(commandSource, "utf8")
  };
}

/** Install or refresh the managed Claude client assets (idempotent). */
export function installClaudeClient(opts: ClaudeClientOptions = {}): ClaudeClientOperationResult {
  const paths = resolveClaudeClientPaths(opts);
  const assets = loadSourceAssets(opts);
  const previous = readManifest(paths.manifestFile);
  const runtime = resolveUserNodeRuntime();
  if (!runtime) fail("node_runtime_missing", `Node.js ${REQUIRED_NODE_MAJOR} or newer must be installed and available on PATH before installing the Claude caller integration.`);
  if (runtime.major < REQUIRED_NODE_MAJOR) fail("node_runtime_unsupported", `Node.js ${REQUIRED_NODE_MAJOR} or newer is required; PATH currently resolves Node.js ${runtime.version}.`, { nodePath: runtime.path, nodeVersion: runtime.version, required: `>=${REQUIRED_NODE_MAJOR}` });
  const nodePath = runtime.path;
  const changed: string[] = [];
  const preserved: string[] = [];
  const conflicts: ClaudeClientConflict[] = [];
  const warnings: string[] = [];

  // GUI hosts commonly have a sparse PATH. Pin the stable user-managed Node entry
  // discovered from the installer's PATH instead of relying on a bare `node` lookup.
  const desiredMcpEntry: Record<string, unknown> = { command: nodePath, args: [assets.serverEntry] };
  const desiredStart = hookEntry("session-start", nodePath, assets.hookEntry);
  const desiredEnd = hookEntry("session-end", nodePath, assets.hookEntry);

  // ---- 1. user config: our MCP server entry only ----
  const userConfig = readUserJson(paths.userConfigFile, "invalid_user_config");
  const mcpServersRaw = userConfig.value.mcpServers;
  if (mcpServersRaw !== undefined && !isPlainObject(mcpServersRaw)) {
    conflicts.push({ target: `${paths.userConfigFile}#mcpServers`, reason: "existing mcpServers is not a JSON object" });
  } else {
    const mcpServers = isPlainObject(mcpServersRaw) ? mcpServersRaw : {};
    const current = mcpServers[MCP_SERVER_NAME];
    if (current === undefined) {
      mcpServers[MCP_SERVER_NAME] = desiredMcpEntry;
      changed.push("mcpServers.crewdispatch");
      userConfig.value.mcpServers = mcpServers;
      writeUserJson(paths.userConfigFile, userConfig.value);
    } else if (deepEqual(current, desiredMcpEntry)) {
      preserved.push("mcpServers.crewdispatch");
    } else if (previous?.mcpEntry && deepEqual(current, previous.mcpEntry)) {
      mcpServers[MCP_SERVER_NAME] = desiredMcpEntry;
      changed.push("mcpServers.crewdispatch (upgraded)");
      userConfig.value.mcpServers = mcpServers;
      writeUserJson(paths.userConfigFile, userConfig.value);
    } else {
      conflicts.push({
        target: `${paths.userConfigFile}#mcpServers.crewdispatch`,
        reason: "an existing entry this installer does not own differs from the managed entry; it was preserved"
      });
    }
  }

  // ---- 2. settings.json: only our two hook entries ----
  const settings = readUserJson(paths.settingsFile, "invalid_settings");
  const settingsChanged = { value: false };
  const hooksRaw = settings.value.hooks;
  if (hooksRaw !== undefined && !isPlainObject(hooksRaw)) {
    conflicts.push({ target: `${paths.settingsFile}#hooks`, reason: "existing hooks is not a JSON object" });
  } else {
    const hooks = isPlainObject(hooksRaw) ? hooksRaw : {};
    const applyHook = (
      event: "SessionStart" | "SessionEnd",
      desired: Record<string, unknown>,
      recorded: Record<string, unknown> | null,
      label: string
    ): void => {
      const list = hooks[event];
      if (list !== undefined && !Array.isArray(list)) {
        conflicts.push({ target: `${paths.settingsFile}#hooks.${event}`, reason: `existing hooks.${event} is not an array` });
        return;
      }
      const arr = Array.isArray(list) ? list : [];
      const command = (desired.hooks as Array<Record<string, unknown>>)[0]!.command as string;
      const index = arr.findIndex((entry) => containsCommand(entry, command));
      const recordedCommand = recorded && Array.isArray(recorded.hooks)
        ? ((recorded.hooks as Array<Record<string, unknown>>)[0]?.command as string | undefined)
        : undefined;
      const recordedIndex = recordedCommand ? arr.findIndex((entry) => containsCommand(entry, recordedCommand)) : -1;
      // Ownership is decided EXACTLY: the live entry is installer's own
      // untouched managed state only when it deep-equals the entry the
      // previous manifest recorded. Any difference from that recorded state —
      // including a `timeout` the user changed by hand — is a USER EDIT and is
      // preserved and reported, never overwritten. Only untouched managed state
      // may be upgraded to the current desired entry.
      const userEdit = (reason: string): void => {
        conflicts.push({ target: `${paths.settingsFile}#hooks.${event}`, reason });
      };
      if (index >= 0) {
        if (deepEqual(arr[index], desired)) {
          preserved.push(label);
          return;
        }
        if (recorded && deepEqual(arr[index], recorded)) {
          arr[index] = desired;
          hooks[event] = arr;
          changed.push(`${label} (upgraded)`);
          settingsChanged.value = true;
          return;
        }
        userEdit(`${label} was edited after install; it was preserved`);
        return;
      }
      // The install PATH moved (a new node or hook entry), so the desired
      // command matches nothing. The previously recorded entry may still be
      // replaced — but only if it is untouched managed state. A user-edited
      // entry is preserved and reported here too.
      if (recordedIndex >= 0 && recorded) {
        if (deepEqual(arr[recordedIndex], recorded)) {
          arr[recordedIndex] = desired;
          hooks[event] = arr;
          changed.push(`${label} (upgraded)`);
          settingsChanged.value = true;
        } else {
          userEdit(`${label} was edited after install; it was preserved`);
        }
        return;
      }
      arr.push(desired);
      hooks[event] = arr;
      changed.push(label);
      settingsChanged.value = true;
    };
    applyHook("SessionStart", desiredStart, previous?.hookEntries.sessionStart ?? null, "hooks.SessionStart");
    applyHook("SessionEnd", desiredEnd, previous?.hookEntries.sessionEnd ?? null, "hooks.SessionEnd");
    if (settingsChanged.value || hooksRaw === undefined) {
      settings.value.hooks = hooks;
    }
    if (settingsChanged.value) writeUserJson(paths.settingsFile, settings.value);
  }

  // ---- 3. skill + compact command files (hash-managed) ----
  const previousHashes = new Map((previous?.files ?? []).map((f) => [f.path, f.sha256]));
  const managedFiles: ClaudeClientFileRecord[] = [];
  const installTextFile = (file: string, rel: string, desired: string): void => {
    const desiredHash = sha256Text(desired);
    let existing: string | null = null;
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        conflicts.push({ target: file, reason: "existing path is not a regular file; it was preserved" });
        return;
      }
      existing = fs.readFileSync(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
    }
    if (existing !== null) {
      const existingHash = sha256Text(existing);
      if (existingHash === desiredHash) {
        preserved.push(rel);
      } else if (previousHashes.get(rel) === existingHash) {
        fs.writeFileSync(file, desired, "utf8");
        changed.push(`${rel} (upgraded)`);
      } else {
        conflicts.push({ target: file, reason: "the file differs from the managed content; it was preserved" });
        return;
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, desired, { encoding: "utf8", flag: "wx" });
      changed.push(rel);
    }
    managedFiles.push({ path: rel, sha256: desiredHash });
  };
  installTextFile(paths.skillFile, SKILL_REL.split(path.sep).join("/"), assets.skillText);
  installTextFile(paths.commandFile, COMMAND_REL.split(path.sep).join("/"), assets.commandText);

  // ---- 4. managed manifest ----
  const manifest: ClaudeClientManifest = {
    product: PRODUCT,
    formatVersion: FORMAT_VERSION,
    configDir: paths.configDir,
    userConfigFile: paths.userConfigFile,
    createdAt: previous?.createdAt ?? nowIso(opts.now),
    updatedAt: nowIso(opts.now),
    nodePath,
    serverEntry: assets.serverEntry,
    hookEntry: assets.hookEntry,
    userConfigExistedBefore: previous?.userConfigExistedBefore ?? userConfig.exists,
    mcpServersExistedBefore: previous?.mcpServersExistedBefore ?? (mcpServersRaw !== undefined),
    settingsExistedBefore: previous?.settingsExistedBefore ?? settings.exists,
    hooksExistedBefore: previous?.hooksExistedBefore ?? (hooksRaw !== undefined),
    files: managedFiles,
    mcpEntry: conflicts.some((c) => c.target.includes("mcpServers")) ? previous?.mcpEntry ?? null : desiredMcpEntry,
    hookEntries: {
      sessionStart: conflicts.some((c) => c.target.endsWith("hooks.SessionStart")) ? previous?.hookEntries.sessionStart ?? null : desiredStart,
      sessionEnd: conflicts.some((c) => c.target.endsWith("hooks.SessionEnd")) ? previous?.hookEntries.sessionEnd ?? null : desiredEnd
    }
  };
  writeManifest(paths.manifestFile, manifest);
  changed.push(MANIFEST_FILE);

  if (conflicts.length > 0) {
    warnings.push("Some existing Claude configuration was left untouched; resolve the conflicts and reinstall if those entries should be managed by CrewDispatch.");
  }
  return {
    ok: conflicts.length === 0,
    command: previous ? "claude-upgrade" : "claude-install",
    configDir: paths.configDir,
    userConfigFile: paths.userConfigFile,
    manifestFile: paths.manifestFile,
    changed,
    preserved,
    conflicts,
    warnings,
    managedFiles,
    serverEntry: assets.serverEntry,
    hookEntry: assets.hookEntry,
    secretsWritten: false
  };
}

/** Remove ONLY the entries/files this installer recorded as managed. */
export function uninstallClaudeClient(opts: ClaudeClientOptions = {}): ClaudeClientOperationResult {
  const paths = resolveClaudeClientPaths(opts);
  const manifest = readManifest(paths.manifestFile);
  if (!manifest) {
    fail("not_managed", "No CrewDispatch Claude client install manifest was found for this configuration directory.", { configDir: paths.configDir });
  }
  const removed: string[] = [];
  const preserved: string[] = [];
  const conflicts: ClaudeClientConflict[] = [];

  // ---- user config ----
  const userConfig = readUserJson(paths.userConfigFile, "invalid_user_config");
  const mcpServersRaw = userConfig.value.mcpServers;
  if (isPlainObject(mcpServersRaw) && manifest.mcpEntry) {
    const current = mcpServersRaw[MCP_SERVER_NAME];
    if (current === undefined) {
      preserved.push("mcpServers.crewdispatch (already absent)");
    } else if (deepEqual(current, manifest.mcpEntry)) {
      delete mcpServersRaw[MCP_SERVER_NAME];
      if (Object.keys(mcpServersRaw).length === 0 && manifest.mcpServersExistedBefore === false) {
        delete userConfig.value.mcpServers;
      }
      if (manifest.userConfigExistedBefore === false && Object.keys(userConfig.value).length === 0) {
        fs.rmSync(paths.userConfigFile, { force: true });
      } else {
        writeUserJson(paths.userConfigFile, userConfig.value);
      }
      removed.push("mcpServers.crewdispatch");
    } else {
      conflicts.push({ target: `${paths.userConfigFile}#mcpServers.crewdispatch`, reason: "the entry changed after install; it was preserved" });
    }
  }

  // ---- settings hooks ----
  const settings = readUserJson(paths.settingsFile, "invalid_settings");
  const hooksRaw = settings.value.hooks;
  let settingsChanged = false;
  if (isPlainObject(hooksRaw)) {
    const removeHook = (event: "SessionStart" | "SessionEnd", recorded: Record<string, unknown> | null, label: string): void => {
      const list = hooksRaw[event];
      if (!Array.isArray(list) || !recorded) {
        if (recorded) preserved.push(`${label} (already absent)`);
        return;
      }
      const command = Array.isArray(recorded.hooks)
        ? ((recorded.hooks as Array<Record<string, unknown>>)[0]?.command as string | undefined)
        : undefined;
      if (!command) return;
      const index = list.findIndex((entry) => containsCommand(entry, command));
      if (index < 0) {
        preserved.push(`${label} (already absent)`);
        return;
      }
      if (!deepEqual(list[index], recorded)) {
        conflicts.push({ target: `${paths.settingsFile}#hooks.${event}`, reason: `${label} was edited after install; it was preserved` });
        return;
      }
      list.splice(index, 1);
      if (list.length === 0) delete hooksRaw[event];
      else hooksRaw[event] = list;
      settingsChanged = true;
      removed.push(label);
    };
    removeHook("SessionStart", manifest.hookEntries.sessionStart, "hooks.SessionStart");
    removeHook("SessionEnd", manifest.hookEntries.sessionEnd, "hooks.SessionEnd");
    if (settingsChanged) {
      if (Object.keys(hooksRaw).length === 0 && manifest.hooksExistedBefore === false) delete settings.value.hooks;
      if (manifest.settingsExistedBefore === false && Object.keys(settings.value).length === 0) {
        fs.rmSync(paths.settingsFile, { force: true });
      } else {
        writeUserJson(paths.settingsFile, settings.value);
      }
    }
  }

  // ---- managed files (only when the recorded hash still matches) ----
  for (const record of manifest.files) {
    // A manifest is a local file that could have been hand-edited: never follow
    // a recorded path outside the config directory (traversal or absolute).
    const file = path.resolve(paths.configDir, ...record.path.split("/"));
    if (!isInsideDir(paths.configDir, file)) {
      conflicts.push({ target: record.path, reason: "the recorded path escapes the config directory; it was preserved" });
      continue;
    }
    let currentHash: string | null = null;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        conflicts.push({ target: file, reason: "not a regular file; it was preserved" });
        continue;
      }
      currentHash = sha256File(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        preserved.push(`${record.path} (already absent)`);
        continue;
      }
      throw e;
    }
    if (currentHash === record.sha256) {
      fs.rmSync(file, { force: true });
      removed.push(record.path);
    } else {
      conflicts.push({ target: file, reason: "the file was edited after install; it was preserved" });
    }
  }

  // The manifest itself is removed LAST, and only when it still matches what we
  // wrote (a concurrently modified manifest is preserved).
  let manifestRemoved = false;
  try {
    const raw = fs.readFileSync(paths.manifestFile, "utf8");
    const parsed = JSON.parse(raw) as { product?: unknown; formatVersion?: unknown };
    if (parsed.product === PRODUCT && parsed.formatVersion === FORMAT_VERSION) {
      fs.rmSync(paths.manifestFile, { force: true });
      manifestRemoved = true;
      removed.push(MANIFEST_FILE);
    } else {
      conflicts.push({ target: paths.manifestFile, reason: "the manifest changed after install; it was preserved" });
    }
  } catch {
    conflicts.push({ target: paths.manifestFile, reason: "the manifest could not be re-read; it was preserved" });
  }
  return {
    ok: conflicts.length === 0,
    command: "claude-uninstall",
    configDir: paths.configDir,
    userConfigFile: paths.userConfigFile,
    manifestFile: paths.manifestFile,
    changed: removed,
    preserved,
    conflicts,
    warnings: conflicts.length ? ["Some managed entries/files were edited and were left untouched."] : [],
    manifestRemoved
  };
}

interface ProbeResult {
  ok: boolean;
  serverName: string | null;
  tools: string[];
  error: string | null;
}

/** Bounded MCP handshake against the installed server entry (initialize + tools/list only). */
async function probeMcpServer(entry: string, dataRoot: string, tempRoot: string): Promise<ProbeResult> {
  if (!fs.existsSync(entry)) return { ok: false, serverName: null, tools: [], error: "server entry missing" };
  const env: NodeJS.ProcessEnv = { ...process.env, JOBQUAY_DATA_ROOT: dataRoot };
  const proc = new JsonLineProcess(entry, tempRoot, env);
  try {
    const init = await proc.request(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crewdispatch-claude-doctor", version: "1" } },
      10_000
    );
    proc.notify("notifications/initialized", {});
    const listed = await proc.request("tools/list", {}, 10_000);
    const serverInfo = init.serverInfo as Record<string, unknown> | undefined;
    const tools = Array.isArray(listed.tools) ? listed.tools.map((t) => String((t as Record<string, unknown>).name)) : [];
    return {
      ok: serverInfo?.name === PRODUCT && tools.includes("crewdispatch_spawn") && tools.includes("crewdispatch_result"),
      serverName: typeof serverInfo?.name === "string" ? serverInfo.name : null,
      tools,
      error: null
    };
  } catch (e) {
    return { ok: false, serverName: null, tools: [], error: String((e as Error)?.message || e) };
  } finally {
    await proc.stop();
  }
}

/**
 * Extract the first semantic version from `claude --version` output. The real
 * CLI prints e.g. `2.1.286 (Claude Code)` (exit 0), so the version is NOT the
 * last whitespace token. Returns null when no valid version is present.
 */
function parseClaudeCliVersion(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout);
  return match ? match[1]! : null;
}

/** Bounded `claude --version` probe; never required for install integrity. */
function probeClaudeCli(cliPath: string | null | undefined, env: NodeJS.ProcessEnv): { available: boolean; version: string | null; meetsMessagingMin: boolean | null; error: string | null } {
  const exe = (cliPath && cliPath.trim()) || "claude";
  // On Windows the probe runs through the shell so npm's `claude.cmd` shims
  // work. The executable must then be quoted: cmd stops at the first space of
  // an unquoted path, so a CLI under e.g. `C:\Program Files\...` would fail.
  const useShell = process.platform === "win32";
  const command = useShell ? `"${exe}"` : exe;
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env,
    shell: useShell
  });
  if (result.error || result.status !== 0) {
    return { available: false, version: null, meetsMessagingMin: null, error: String(result.error?.message || `exit ${result.status}`) };
  }
  const version = parseClaudeCliVersion(result.stdout || "");
  if (version === null) {
    // The CLI ran, but its version is unknown: report availability without
    // inventing a version, and keep the diagnostic for the doctor warning.
    return { available: true, version: null, meetsMessagingMin: null, error: "unparseable version output" };
  }
  const meets = compareVersions(version, CLAUDE_MESSAGING_MIN_VERSION);
  return { available: true, version, meetsMessagingMin: meets == null ? null : meets >= 0, error: null };
}

/** Numeric version comparison; null when either side is unparseable. */
function compareVersions(a: string, b: string): number | null {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Diagnose the installed Claude client integration. Installation integrity and
 * the MCP smoke probe are reported separately from WAKE capability: a live
 * session binding proves registration, but visible conversation receipt is
 * proven only by the installed-host acceptance gate (never claimed here).
 */
export async function doctorClaudeClient(opts: ClaudeClientOptions = {}): Promise<ClaudeClientOperationResult> {
  const paths = resolveClaudeClientPaths(opts);
  const env = opts.env ?? process.env;
  const manifest = readManifest(paths.manifestFile);
  const conflicts: ClaudeClientConflict[] = [];
  const warnings: string[] = [];
  const preserved: string[] = [];

  const serverEntry = manifest?.serverEntry ?? path.join(sourceRootOf(opts), "dist", "mcp", "server.js");
  const hookEntryPath = manifest?.hookEntry ?? path.join(sourceRootOf(opts), "dist", "claude", "hook.js");
  const nodeRuntime = manifest?.nodePath ? probeNodeRuntimePath(manifest.nodePath) : null;
  const nodeRuntimeOk = nodeRuntime !== null && nodeRuntime.major >= REQUIRED_NODE_MAJOR;

  // MCP registration check.
  let mcpEntryOk = false;
  let mcpEntryMatchesManifest = false;
  try {
    const userConfig = readUserJson(paths.userConfigFile, "invalid_user_config");
    const mcpServers = userConfig.value.mcpServers;
    const entry = isPlainObject(mcpServers) ? mcpServers[MCP_SERVER_NAME] : undefined;
    const nodeCommand = isPlainObject(entry) && typeof entry.command === "string" ? entry.command : "";
    mcpEntryOk =
      isPlainObject(entry) &&
      path.isAbsolute(nodeCommand) &&
      fs.existsSync(nodeCommand) &&
      nodeCommand === manifest?.nodePath &&
      Array.isArray(entry.args) &&
      entry.args.length === 1 &&
      entry.args[0] === serverEntry;
    mcpEntryMatchesManifest = !!manifest?.mcpEntry && deepEqual(entry, manifest.mcpEntry);
  } catch (e) {
    warnings.push(`user config could not be read: ${String((e as Error)?.message || e)}`);
  }

  // Hook entries check.
  let hooksOk = false;
  try {
    const settings = readUserJson(paths.settingsFile, "invalid_settings");
    const hooks = isPlainObject(settings.value.hooks) ? settings.value.hooks : {};
    const startList = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    const endList = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
    const startCmd = manifest?.hookEntries.sessionStart ? (manifest.hookEntries.sessionStart.hooks as Array<Record<string, unknown>>)[0]?.command : undefined;
    const endCmd = manifest?.hookEntries.sessionEnd ? (manifest.hookEntries.sessionEnd.hooks as Array<Record<string, unknown>>)[0]?.command : undefined;
    hooksOk =
      typeof startCmd === "string" &&
      typeof endCmd === "string" &&
      startList.some((e) => containsCommand(e, startCmd)) &&
      endList.some((e) => containsCommand(e, endCmd));
  } catch (e) {
    warnings.push(`settings could not be read: ${String((e as Error)?.message || e)}`);
  }

  // Managed files check.
  const files = (manifest?.files ?? []).map((record) => {
    const file = path.join(paths.configDir, ...record.path.split("/"));
    const current = sha256File(file);
    return { path: record.path, present: current !== null, matches: current === record.sha256 };
  });
  const filesOk = files.length > 0 && files.every((f) => f.matches);

  // MCP smoke probe on a disposable data root.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-claude-doctor-"));
  let mcpProbe: ProbeResult;
  try {
    mcpProbe = await probeMcpServer(serverEntry, path.join(tempRoot, "data"), tempRoot);
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      warnings.push("the disposable doctor probe directory could not be removed completely");
    }
  }

  // Wake capability: private bindings present + optional CLI version evidence.
  const dataRoot = resolveDataRoot(undefined, env);
  const bindings = listClaudeBindings(dataRoot);
  const cli = probeClaudeCli(opts.claudeCliPath, env);
  const wake = {
    status: bindings.length > 0 ? "binding_registered" : "no_binding",
    bindingCount: bindings.length,
    latestBindingAt: bindings[0]?.updatedAt ?? null,
    sessions: bindings.slice(0, 8).map((b) => b.sessionId),
    /** A binding proves registration; visible wake receipt is a host acceptance item. */
    visibleReceiptProven: false,
    note:
      "A registered binding means the SessionStart hook stored this session's inbox address; it does not prove that a sent message was observed in the conversation. That is verified only by the installed-host acceptance gate."
  };

  if (!manifest) conflicts.push({ target: paths.manifestFile, reason: "no CrewDispatch Claude install manifest found; run claude-install" });
  if (manifest && !nodeRuntimeOk) conflicts.push({ target: manifest.nodePath || paths.manifestFile, reason: `the managed Node runtime is missing or below the required >=${REQUIRED_NODE_MAJOR}` });
  if (manifest && !mcpEntryOk) conflicts.push({ target: `${paths.userConfigFile}#mcpServers.crewdispatch`, reason: "the managed MCP entry is missing or differs" });
  if (manifest && !hooksOk) conflicts.push({ target: `${paths.settingsFile}#hooks`, reason: "the managed SessionStart/SessionEnd hook entries are missing or differ" });
  if (manifest && !filesOk) conflicts.push({ target: paths.configDir, reason: "a managed skill/command file is missing or modified" });
  if (!cli.available) warnings.push("The `claude` CLI was not found on PATH; host version compatibility could not be probed (this is not required for desktop hosts).");
  else if (cli.meetsMessagingMin === false) warnings.push(`Claude Code ${cli.version} is below the documented ${CLAUDE_MESSAGING_MIN_VERSION} minimum for all-provider cross-session messaging; wake capability is unsupported on this version.`);
  else if (cli.meetsMessagingMin === null && cli.version === null) warnings.push(`The Claude CLI --version output could not be parsed; compatibility with the documented minimum ${CLAUDE_MESSAGING_MIN_VERSION} is unknown.`);
  else if (cli.meetsMessagingMin === null) warnings.push(`The Claude CLI version (${cli.version}) could not be compared to the documented minimum ${CLAUDE_MESSAGING_MIN_VERSION}.`);

  const installOk = !!manifest && nodeRuntimeOk && mcpEntryOk && hooksOk && filesOk && fs.existsSync(serverEntry) && fs.existsSync(hookEntryPath) && mcpProbe.ok;
  return {
    ok: installOk,
    command: "claude-doctor",
    configDir: paths.configDir,
    userConfigFile: paths.userConfigFile,
    manifestFile: paths.manifestFile,
    changed: [],
    preserved,
    conflicts,
    warnings,
    checks: {
      manifest: { ok: !!manifest, path: paths.manifestFile },
      nodeRuntime: { ok: nodeRuntimeOk, path: manifest?.nodePath ?? null, version: nodeRuntime?.version ?? null, major: nodeRuntime?.major ?? null, required: `>=${REQUIRED_NODE_MAJOR}` },
      mcpRegistration: { ok: mcpEntryOk, matchesManifest: mcpEntryMatchesManifest, serverEntry, serverEntryExists: fs.existsSync(serverEntry) },
      hooks: { ok: hooksOk, hookEntry: hookEntryPath, hookEntryExists: fs.existsSync(hookEntryPath) },
      files,
      mcpProbe,
      wake,
      claudeCli: cli
    },
    secretsRead: false
  };
}
