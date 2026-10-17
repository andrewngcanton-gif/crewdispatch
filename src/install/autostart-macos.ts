
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataRoot } from "../jobs/store";
import { resolveUserNodeRuntime } from "./node-runtime";

export const MACOS_AUTOSTART_MECHANISM_ID = "macos-user-launchagent";
export const MACOS_AUTOSTART_LABEL = "com.crewdispatch.dashboard";
export const MACOS_AUTOSTART_PLIST_NAME = "com.crewdispatch.dashboard.plist";
export const MACOS_TEST_LAUNCHAGENT_DIR_ENV = "JOBQUAY_TEST_LAUNCHAGENT_DIR";
export const MACOS_TEST_LAUNCHCTL_STATE_ENV = "JOBQUAY_TEST_LAUNCHCTL_STATE";

export interface MacLaunchAgentSpec {
  label: string;
  plistPath: string;
  installRoot: string;
  nodePath: string;
  cliEntry: string;
  programArguments: string[];
  environmentVariables: Record<string, string>;
  dataRoot: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface ParsedMacLaunchAgent {
  label: string | null;
  programArguments: string[];
  runAtLoad: boolean | null;
  keepAlive: boolean | null;
}

export interface MacLaunchAgentRegistration {
  ok: boolean;
  registered: boolean;
  spec: MacLaunchAgentSpec;
  loaded: boolean | null;
  changed: boolean;
  error: { code: string; message: string } | null;
}

export interface MacLaunchAgentRemoval {
  ok: boolean;
  removed: boolean;
  reason: "removed" | "not_registered" | "value_not_jobquay" | "points_at_other_install" | null;
  plistPath: string;
  registeredInstallRoot: string | null;
  loaded: boolean | null;
  error: { code: string; message: string } | null;
}

export interface MacLaunchAgentInspection {
  ok: boolean;
  status: "healthy" | "disabled" | "broken" | "unknown";
  plistPath: string;
  exists: boolean;
  owned: boolean | null;
  loaded: boolean | null;
  spec: MacLaunchAgentSpec | null;
  registeredProgramArguments: string[] | null;
  registeredInstallRoot: string | null;
  nodeExists: boolean | null;
  cliEntryExists: boolean | null;
  error: { code: string; message: string } | null;
}

function currentHome(env: NodeJS.ProcessEnv): string {
  const value = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : os.homedir();
  return path.resolve(value);
}

export function macLaunchAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const seam = typeof env[MACOS_TEST_LAUNCHAGENT_DIR_ENV] === "string" ? env[MACOS_TEST_LAUNCHAGENT_DIR_ENV]!.trim() : "";
  return path.resolve(seam || path.join(currentHome(env), "Library", "LaunchAgents"));
}

export function macLaunchAgentPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(macLaunchAgentDir(env), MACOS_AUTOSTART_PLIST_NAME);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

function afterKey(plist: string, key: string): string | null {
  const marker = "<key>" + key + "</key>";
  const index = plist.indexOf(marker);
  return index < 0 ? null : plist.slice(index + marker.length);
}

function readString(plist: string, key: string): string | null {
  const tail = afterKey(plist, key);
  if (tail === null) return null;
  const start = tail.indexOf("<string>");
  const end = tail.indexOf("</string>", start + 8);
  return start < 0 || end < 0 ? null : xmlUnescape(tail.slice(start + 8, end));
}

function readBool(plist: string, key: string): boolean | null {
  const tail = afterKey(plist, key);
  if (tail === null) return null;
  const trueAt = tail.search(/\S/);
  if (trueAt < 0) return null;
  const rest = tail.slice(trueAt);
  if (rest.startsWith("<true/>")) return true;
  if (rest.startsWith("<false/>")) return false;
  return null;
}

function readStringArray(plist: string, key: string): string[] {
  const tail = afterKey(plist, key);
  if (tail === null) return [];
  const arrayStart = tail.indexOf("<array>");
  const arrayEnd = tail.indexOf("</array>", arrayStart + 7);
  if (arrayStart < 0 || arrayEnd < 0) return [];
  const body = tail.slice(arrayStart + 7, arrayEnd);
  const values: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = body.indexOf("<string>", cursor);
    if (start < 0) break;
    const end = body.indexOf("</string>", start + 8);
    if (end < 0) break;
    values.push(xmlUnescape(body.slice(start + 8, end)));
    cursor = end + 9;
  }
  return values;
}

export function parseMacLaunchAgentPlist(plist: string): ParsedMacLaunchAgent {
  return {
    label: readString(plist, "Label"),
    programArguments: readStringArray(plist, "ProgramArguments"),
    runAtLoad: readBool(plist, "RunAtLoad"),
    keepAlive: readBool(plist, "KeepAlive")
  };
}

export function renderMacLaunchAgentPlist(spec: MacLaunchAgentSpec): string {
  const args = spec.programArguments.map((arg) => "    <string>" + xmlEscape(arg) + "</string>").join("\n");
  const environment = Object.entries(spec.environmentVariables)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["    <key>" + xmlEscape(key) + "</key>", "    <string>" + xmlEscape(value) + "</string>"]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xmlEscape(spec.label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...environment,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    '  <string>' + xmlEscape(spec.stdoutPath) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + xmlEscape(spec.stderrPath) + '</string>',
    '</dict>',
    '</plist>',
    ''
  ].join("\n");
}

export function makeMacLaunchAgentSpec(
  installRoot: string,
  options: { env?: NodeJS.ProcessEnv; nodePath?: string; dataRoot?: string } = {}
): MacLaunchAgentSpec {
  const env = options.env ?? process.env;
  const root = path.resolve(installRoot);
  const dataRoot = path.resolve(options.dataRoot ?? resolveDataRoot(undefined, env));
  const diagnosticDir = path.join(dataRoot, "autostart");
  const nodePath = path.resolve(options.nodePath ?? resolveUserNodeRuntime(env, "darwin")?.path ?? process.execPath);
  const cliEntry = path.join(root, "dist", "cli", "jobquay-cli.js");
  const environmentVariables: Record<string, string> = { JOBQUAY_DATA_ROOT: dataRoot };
  if (typeof env.PATH === "string" && env.PATH.trim()) environmentVariables.PATH = env.PATH.trim();
  if (typeof env.HUB_PORT === "string" && env.HUB_PORT.trim()) environmentVariables.HUB_PORT = env.HUB_PORT.trim();
  else if (typeof env.PORT === "string" && env.PORT.trim()) environmentVariables.PORT = env.PORT.trim();
  return {
    label: MACOS_AUTOSTART_LABEL,
    plistPath: macLaunchAgentPlistPath(env),
    installRoot: root,
    nodePath,
    cliEntry,
    programArguments: [nodePath, cliEntry, "autostart", "run", "--json"],
    environmentVariables,
    dataRoot,
    stdoutPath: path.join(diagnosticDir, "launchagent.stdout.log"),
    stderrPath: path.join(diagnosticDir, "launchagent.stderr.log")
  };
}

export function isCrewDispatchMacLaunchAgent(parsed: ParsedMacLaunchAgent): boolean {
  const args = parsed.programArguments;
  return parsed.label === MACOS_AUTOSTART_LABEL
    && parsed.runAtLoad === true
    && parsed.keepAlive === false
    && args.length === 5
    && args[2] === "autostart"
    && args[3] === "run"
    && args[4] === "--json"
    && path.isAbsolute(args[0] || "")
    && path.isAbsolute(args[1] || "")
    && path.basename(args[1] || "") === "jobquay-cli.js"
    && path.basename(path.dirname(args[1] || "")) === "cli"
    && path.basename(path.dirname(path.dirname(args[1] || ""))) === "dist";
}

export function macLaunchAgentInstallRoot(parsed: ParsedMacLaunchAgent): string | null {
  return isCrewDispatchMacLaunchAgent(parsed)
    ? path.dirname(path.dirname(path.dirname(parsed.programArguments[1]!)))
    : null;
}

interface LaunchctlResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

interface LaunchctlBackend {
  kind: "launchctl" | "emulated-file";
  print(label: string): LaunchctlResult & { loaded: boolean };
  bootstrap(plistPath: string, label: string): LaunchctlResult;
  bootout(label: string): LaunchctlResult & { removed: boolean };
  enable(label: string): LaunchctlResult;
}

function realLaunchctl(): LaunchctlBackend {
  if (process.platform !== "darwin") throw new Error("macOS LaunchAgent operations require Darwin.");
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Unable to resolve the current macOS user id.");
  const domain = "gui/" + String(uid);
  const service = (label: string): string => domain + "/" + label;
  const run = (args: string[]): LaunchctlResult => {
    const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", windowsHide: true });
    return {
      ok: result.status === 0 && !result.error,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ? result.error.message : null
    };
  };
  return {
    kind: "launchctl",
    print(label) {
      const result = run(["print", service(label)]);
      return { ...result, loaded: result.ok };
    },
    bootstrap(plistPath, _label) {
      return run(["bootstrap", domain, plistPath]);
    },
    bootout(label) {
      const before = run(["print", service(label)]);
      if (!before.ok) return { ...before, ok: true, removed: false, error: null };
      const result = run(["bootout", service(label)]);
      return { ...result, removed: result.ok };
    },
    enable(label) {
      return run(["enable", service(label)]);
    }
  };
}

interface EmulatedLaunchctlData {
  product: "jobquay-test-launchctl";
  loaded: Record<string, string>;
}

function emulatedLaunchctl(file: string): LaunchctlBackend {
  const statePath = path.resolve(file);
  const read = (): { ok: true; data: EmulatedLaunchctlData } | { ok: false; error: string } => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<EmulatedLaunchctlData>;
      if (!parsed || parsed.product !== "jobquay-test-launchctl" || !parsed.loaded || typeof parsed.loaded !== "object") {
        return { ok: false, error: "the emulated launchctl state has an unsupported shape" };
      }
      return { ok: true, data: { product: "jobquay-test-launchctl", loaded: { ...(parsed.loaded as Record<string, string>) } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true, data: { product: "jobquay-test-launchctl", loaded: {} } };
      }
      return { ok: false, error: String((error as Error)?.message || error) };
    }
  };
  const write = (data: EmulatedLaunchctlData): LaunchctlResult => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2) + "\n", "utf8");
      return { ok: true, status: 0, stdout: "", stderr: "", error: null };
    } catch (error) {
      return { ok: false, status: 1, stdout: "", stderr: "", error: String((error as Error)?.message || error) };
    }
  };
  return {
    kind: "emulated-file",
    print(label) {
      const state = read();
      if (!state.ok) return { ok: false, status: 1, stdout: "", stderr: "", error: state.error, loaded: false };
      const loaded = typeof state.data.loaded[label] === "string";
      return { ok: loaded, status: loaded ? 0 : 1, stdout: loaded ? state.data.loaded[label]! : "", stderr: "", error: null, loaded };
    },
    bootstrap(plistPath, label) {
      const state = read();
      if (!state.ok) return { ok: false, status: 1, stdout: "", stderr: "", error: state.error };
      state.data.loaded[label] = path.resolve(plistPath);
      return write(state.data);
    },
    bootout(label) {
      const state = read();
      if (!state.ok) return { ok: false, status: 1, stdout: "", stderr: "", error: state.error, removed: false };
      const removed = Object.prototype.hasOwnProperty.call(state.data.loaded, label);
      delete state.data.loaded[label];
      const result = write(state.data);
      return { ...result, removed: result.ok && removed };
    },
    enable(_label) {
      return { ok: true, status: 0, stdout: "", stderr: "", error: null };
    }
  };
}

function resolveLaunchctl(env: NodeJS.ProcessEnv): LaunchctlBackend {
  const seam = typeof env[MACOS_TEST_LAUNCHCTL_STATE_ENV] === "string" ? env[MACOS_TEST_LAUNCHCTL_STATE_ENV]!.trim() : "";
  return seam ? emulatedLaunchctl(seam) : realLaunchctl();
}

function checkedLaunchAgentsDir(dir: string): void {
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("LaunchAgents path is not a real directory: " + dir);
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function readExistingPlist(plistPath: string): { raw: string; parsed: ParsedMacLaunchAgent } | null {
  try {
    const stat = fs.lstatSync(plistPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("LaunchAgent plist is not a regular file: " + plistPath);
    const raw = fs.readFileSync(plistPath, "utf8");
    return { raw, parsed: parseMacLaunchAgentPlist(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function atomicWritePlist(spec: MacLaunchAgentSpec, content: string): boolean {
  checkedLaunchAgentsDir(path.dirname(spec.plistPath));
  const prior = readExistingPlist(spec.plistPath);
  if (prior?.raw === content) return false;
  const temp = path.join(path.dirname(spec.plistPath), "." + path.basename(spec.plistPath) + "." + String(process.pid) + "." + String(Date.now()) + ".tmp");
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
  fs.chmodSync(temp, 0o644);
  fs.renameSync(temp, spec.plistPath);
  return true;
}

export function registerMacLaunchAgent(
  installRoot: string,
  options: { env?: NodeJS.ProcessEnv; nodePath?: string; dataRoot?: string } = {}
): MacLaunchAgentRegistration {
  const env = options.env ?? process.env;
  const spec = makeMacLaunchAgentSpec(installRoot, options);
  const base: MacLaunchAgentRegistration = { ok: false, registered: false, spec, loaded: null, changed: false, error: null };
  try {
    const existing = readExistingPlist(spec.plistPath);
    if (existing && !isCrewDispatchMacLaunchAgent(existing.parsed)) {
      return { ...base, error: { code: "launchagent_foreign", message: "Refusing to replace a non-CrewDispatch LaunchAgent at " + spec.plistPath + "." } };
    }
    fs.mkdirSync(path.join(spec.dataRoot, "autostart"), { recursive: true, mode: 0o700 });
    const backend = resolveLaunchctl(env);
    const before = backend.print(spec.label);
    if (!existing && before.loaded) {
      return {
        ...base,
        loaded: true,
        error: {
          code: "launchagent_loaded_without_owned_plist",
          message: "A service with the CrewDispatch label is already loaded, but the owned plist is absent; refusing to boot it out or replace it."
        }
      };
    }
    if (before.loaded) {
      const stopped = backend.bootout(spec.label);
      if (!stopped.ok) return { ...base, error: { code: "launchagent_bootout_failed", message: stopped.error || stopped.stderr || "launchctl bootout failed" } };
    }
    const content = renderMacLaunchAgentPlist(spec);
    const changed = atomicWritePlist(spec, content);
    const reread = readExistingPlist(spec.plistPath);
    if (!reread || !isCrewDispatchMacLaunchAgent(reread.parsed) || !sameArgs(reread.parsed.programArguments, spec.programArguments)) {
      return { ...base, changed, error: { code: "launchagent_verification_failed", message: "LaunchAgent plist read-back did not match the expected CrewDispatch program arguments." } };
    }
    const enabled = backend.enable(spec.label);
    if (!enabled.ok) return { ...base, changed, error: { code: "launchagent_enable_failed", message: enabled.error || enabled.stderr || "launchctl enable failed" } };
    const bootstrapped = backend.bootstrap(spec.plistPath, spec.label);
    if (!bootstrapped.ok) return { ...base, changed, error: { code: "launchagent_bootstrap_failed", message: bootstrapped.error || bootstrapped.stderr || "launchctl bootstrap failed" } };
    const verify = backend.print(spec.label);
    if (!verify.loaded) return { ...base, changed, loaded: false, error: { code: "launchagent_verification_failed", message: verify.error || verify.stderr || "launchctl print did not find the registered service" } };
    return { ok: true, registered: true, spec, loaded: true, changed, error: null };
  } catch (error) {
    return { ...base, error: { code: "launchagent_registration_failed", message: String((error as Error)?.message || error) } };
  }
}

export function removeMacLaunchAgent(options: { env?: NodeJS.ProcessEnv; target?: string | null } = {}): MacLaunchAgentRemoval {
  const env = options.env ?? process.env;
  const plistPath = macLaunchAgentPlistPath(env);
  const base: MacLaunchAgentRemoval = { ok: false, removed: false, reason: null, plistPath, registeredInstallRoot: null, loaded: null, error: null };
  try {
    const existing = readExistingPlist(plistPath);
    if (!existing) return { ...base, ok: true, reason: "not_registered", loaded: false };
    if (!isCrewDispatchMacLaunchAgent(existing.parsed)) return { ...base, ok: true, reason: "value_not_jobquay" };
    const registeredInstallRoot = macLaunchAgentInstallRoot(existing.parsed);
    if (options.target && registeredInstallRoot && path.resolve(options.target) !== path.resolve(registeredInstallRoot)) {
      return { ...base, ok: true, reason: "points_at_other_install", registeredInstallRoot };
    }
    const backend = resolveLaunchctl(env);
    const loaded = backend.print(MACOS_AUTOSTART_LABEL).loaded;
    if (loaded) {
      const stopped = backend.bootout(MACOS_AUTOSTART_LABEL);
      if (!stopped.ok) return { ...base, loaded: true, registeredInstallRoot, error: { code: "launchagent_bootout_failed", message: stopped.error || stopped.stderr || "launchctl bootout failed" } };
    }
    const check = readExistingPlist(plistPath);
    if (!check || !isCrewDispatchMacLaunchAgent(check.parsed)) {
      return { ...base, loaded: false, registeredInstallRoot, error: { code: "launchagent_changed", message: "LaunchAgent ownership changed before removal; the file was preserved." } };
    }
    fs.unlinkSync(plistPath);
    return { ...base, ok: true, removed: true, reason: "removed", registeredInstallRoot, loaded: false };
  } catch (error) {
    return { ...base, error: { code: "launchagent_removal_failed", message: String((error as Error)?.message || error) } };
  }
}

export function inspectMacLaunchAgent(
  options: { env?: NodeJS.ProcessEnv; target?: string | null; nodePath?: string; dataRoot?: string } = {}
): MacLaunchAgentInspection {
  const env = options.env ?? process.env;
  const plistPath = macLaunchAgentPlistPath(env);
  const spec = options.target ? makeMacLaunchAgentSpec(options.target, options) : null;
  const base: MacLaunchAgentInspection = {
    ok: false, status: "unknown", plistPath, exists: false, owned: null, loaded: null, spec,
    registeredProgramArguments: null, registeredInstallRoot: null, nodeExists: null, cliEntryExists: null, error: null
  };
  try {
    const existing = readExistingPlist(plistPath);
    if (!existing) return { ...base, ok: true, status: "disabled", loaded: false };
    if (!isCrewDispatchMacLaunchAgent(existing.parsed)) {
      return { ...base, status: "broken", exists: true, owned: false, error: { code: "launchagent_foreign", message: "The LaunchAgent at " + plistPath + " is not CrewDispatch-owned and was left untouched." } };
    }
    const registeredInstallRoot = macLaunchAgentInstallRoot(existing.parsed);
    const args = existing.parsed.programArguments;
    const nodePath = args[0]!;
    const cliEntry = args[1]!;
    const loaded = resolveLaunchctl(env).print(MACOS_AUTOSTART_LABEL).loaded;
    const targetMismatch = Boolean(spec && registeredInstallRoot && path.resolve(registeredInstallRoot) !== path.resolve(spec.installRoot));
    const argsMismatch = Boolean(spec && !sameArgs(args, spec.programArguments));
    const nodeExists = fs.existsSync(nodePath);
    const cliEntryExists = fs.existsSync(cliEntry);
    const problem = targetMismatch
      ? { code: "other_install", message: "The registered LaunchAgent points at " + registeredInstallRoot + ", not " + spec!.installRoot + "." }
      : argsMismatch
        ? { code: "launchagent_arguments_mismatch", message: "The registered LaunchAgent arguments do not match the expected installation." }
        : !nodeExists
          ? { code: "runtime_missing", message: "The recorded Node runtime is missing: " + nodePath }
          : !cliEntryExists
            ? { code: "cli_entry_missing", message: "The recorded CrewDispatch CLI entry is missing: " + cliEntry }
            : !loaded
              ? { code: "launchagent_not_loaded", message: "The CrewDispatch LaunchAgent plist exists but launchctl does not report it loaded." }
              : null;
    return {
      ...base,
      ok: problem === null,
      status: problem === null ? "healthy" : "broken",
      exists: true,
      owned: true,
      loaded,
      registeredProgramArguments: args,
      registeredInstallRoot,
      nodeExists,
      cliEntryExists,
      error: problem
    };
  } catch (error) {
    return { ...base, error: { code: "launchagent_read_failed", message: String((error as Error)?.message || error) } };
  }
}
