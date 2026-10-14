// run-isolation.ts — the SINGLE place that builds an isolated execution
// environment for an official-CLI invocation.
//
// This is a TEST/HARNESS concern, not the product job path. The product Job
// service (src/jobs/service.ts) deliberately runs the user-installed official
// CLI with the caller's own runtime environment and the job's requested cwd, so
// the user's own official login/account is used; it does NOT isolate the CLI
// profile. Isolation here exists so acceptance tests can drive a real CLI (or a
// controlled fixture) against a disposable profile and prove nothing real was
// touched. The batch-1 acceptance entries (probe-cli, one-shot-cli) and the
// batch-2 test harness are its callers.
//
// Isolation has two independent parts:
//
//   1. Data root. The installed `cmdc` roots all its state at
//      `${env.HOME ?? env.USERPROFILE}/.commandcode` (auth.json, sessions/,
//      projects/, history.jsonl, settings.json, mcp.json, plans/, skills/,
//      taste/), with no dedicated config-dir override (verified read-only in the
//      installed Command Code builds). This helper
//      creates a disposable temp tree and points HOME + USERPROFILE (plus the
//      per-user data roots APPDATA/LOCALAPPDATA and the temp roots
//      TEMP/TMP/TMPDIR, and the XDG data/config/cache/state roots when the
//      platform uses them) at directories inside that tree, so every
//      CLI-produced session/config/credential/temp file lands inside the
//      throwaway tree. It also gives the CLI a `cwd` inside that tree.
//
//   2. Credential hygiene — an ALLOWLIST, not a denylist. The child environment
//      is built from scratch out of MINIMAL_ENV_ALLOWLIST: only the
//      non-credential variables a process needs to START the official CLI
//      (PATH/PATHEXT/ComSpec/SystemRoot/... on Windows) are carried over. Every
//      other variable the operator happens to export — OPENAI_API_KEY,
//      ANTHROPIC_API_KEY, any provider token, any unrelated secret, and any
//      stray config path — is simply NOT inherited, whether or not it is on a
//      "known" list. A dedicated test credential is forwarded ONLY when the
//      operator names it explicitly for this run (`--credential-env <NAME>`),
//      and only its NAME is ever reported; the value is never printed. The
//      default (no forwarding) leaves the isolated CLI with no credential at
//      all, so a real request simply cannot use the real account.
//
// This helper never reads, copies, deletes or "cleans" a real auth.json,
// session, transcript or provider database. It only creates temp directories and
// derives an environment.
//
// HONEST LIMIT: the redirect is a mechanism, verified at the plan boundary. It
// does NOT prove that a real child never touched the real profile by some other
// path; that is a live acceptance item and is
// reported as `liveConfirmed: false` by the entries.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The ONLY variables carried from the source environment into an isolated run.
 *
 * This is a deliberate ALLOWLIST: anything not named here is dropped, so a
 * provider credential the operator has exported (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, ...) cannot reach the child even though CrewDispatch never had
 * to enumerate it. Each entry is a non-credential variable with a proven startup
 * or redirection purpose:
 *
 *   - PATH        — cmd.exe / the OS resolves the `node` the `.cmd` shim runs,
 *                   and CrewDispatch's own spawn plan resolves `cmd.exe` from it.
 *   - PATHEXT     — cmd.exe resolves a bare `node` to `node.exe`; the installed
 *                   cmdc.cmd shim itself rewrites PATHEXT.
 *   - COMSPEC     — the installed cmdc.cmd shim references `%COMSPEC%`; the
 *                   conventional cmd.exe locator.
 *   - SYSTEMROOT / WINDIR / SYSTEMDRIVE
 *                 — the Windows system directory/drive cmd.exe and the loader
 *                   rely on. (WINDIR is the same value under its historical name.)
 *   - TEMP / TMP / TMPDIR
 *                 — the child's temp directory; REDIRECTED into the isolated tree.
 *   - HOME / USERPROFILE / HOMEDRIVE / HOMEPATH
 *                 — the CLI's home (`HOME ?? USERPROFILE` + `.commandcode`);
 *                   REDIRECTED into the isolated tree.
 *   - APPDATA / LOCALAPPDATA
 *                 — per-user application data used by Node/npm and libraries;
 *                   REDIRECTED into the isolated tree.
 *   - XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME / XDG_STATE_HOME
 *                 — the POSIX data/config/cache/state roots; REDIRECTED into the
 *                   isolated tree (harmless if the CLI ignores them).
 *
 * Deliberately EXCLUDED (with reasons): NODE_OPTIONS (would let a stray
 * `--require`/flag reach the child), NODE_PATH/NODE_ENV (not needed to start the
 * CLI), HTTP_PROXY/HTTPS_PROXY/NO_PROXY (may embed credentials and are not
 * startup-required), and every `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD`/
 * `*_AUTH` variable. The list is never a blanket strip of unrelated tooling
 * state, and it never carries a credential.
 */
export const MINIMAL_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME"
]);

/**
 * Known CLI/provider credential env vars. Under the allowlist these are already
 * dropped; the list is kept so the report can name them explicitly (transparency
 * for the two credentials this project has documented). It is NOT the mechanism
 * any more — the mechanism is that nothing outside MINIMAL_ENV_ALLOWLIST is
 * inherited.
 */
export const KNOWN_CREDENTIAL_ENV_VARS: readonly string[] = Object.freeze([
  "COMMAND_CODE_API_KEY",
  "OPENROUTER_API_KEY"
]);

/**
 * Names that look like a secret. Used ONLY to name (never to read the value of)
 * source variables that the allowlist dropped, so the report can say
 * "OPENAI_API_KEY was present and was not carried" instead of staying silent.
 */
const SENSITIVE_NAME_RE =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(_|$)/i;

/** Upper bound on the number of dropped-sensitive names reported. */
const DROPPED_SENSITIVE_CAP = 64;

/** The env var names an operator may forward into an isolated run. */
export const CREDENTIAL_ENV_FLAG = "--credential-env";

export interface CliIsolationInput {
  /** The environment the isolated env is derived from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Temp directory prefix. Default: "jobquay-cli-". */
  tempPrefix?: string;
  /** Target platform for allowlist matching/redirection. Default: process.platform. */
  platform?: NodeJS.Platform;
  /**
   * Credential env var names the operator EXPLICITLY forwards into this run
   * (e.g. a dedicated test key). Only these are injected; every other variable
   * stays out because the child env is built from the allowlist.
   */
  forwardCredentialEnv?: readonly string[];
  /**
   * Parent directory for the disposable tree (created if absent). Default:
   * os.tmpdir(). A TEST harness passes its own scratch directory here so the
   * disposable CLI profile lives with the test workspace and is removed with it.
   */
  baseDir?: string;
}

export interface CliIsolation {
  /** The disposable temp root of this run. */
  root: string;
  /** The isolated CLI home (`<root>/cli-home`); HOME and USERPROFILE point here. */
  cliHome: string;
  /** The isolated working directory (`<root>/cwd`). */
  cwd: string;
  /** The environment to pass to EVERY official-CLI process of this run. */
  env: NodeJS.ProcessEnv;
  /** Allowlisted names carried from the source env (non-credential only). */
  carriedEnvVars: string[];
  /** Names redirected into the isolated tree → their isolated path. */
  redirectedEnv: Record<string, string>;
  /** Known credential vars that were present and dropped (not forwarded). */
  removedCredentialVars: string[];
  /** Secret-looking source names dropped by the allowlist (names only). */
  droppedSensitiveVars: string[];
  /** Credential vars the operator explicitly forwarded (present and injected). */
  forwardedCredentialVars: string[];
  /** Requested forward names that were absent from the source env. */
  missingCredentialVars: string[];
}

/** The plain-object form of an isolation, for a JSON report. */
export interface CliIsolationReport {
  root: string;
  cliHome: string;
  cwd: string;
  homeEnv: { HOME: string; USERPROFILE: string };
  /** Names redirected into the isolated tree → their isolated path (no secrets). */
  redirectedEnv: Record<string, string>;
  /** Allowlisted non-credential names carried from the source env. */
  carriedEnvVars: string[];
  removedCredentialVars: string[];
  droppedSensitiveVars: string[];
  forwardedCredentialVars: string[];
  missingCredentialVars: string[];
  /** The redirect is a mechanism only; a live confirmation is a separate item. */
  liveConfirmed: false;
  note: string;
}

const ISOLATION_NOTE =
  "Official-CLI env is built from a minimal non-credential allowlist (PATH/PATHEXT/ComSpec/SystemRoot on Windows); " +
  "HOME/USERPROFILE, APPDATA/LOCALAPPDATA, TEMP/TMP/TMPDIR and the XDG data/config/cache/state roots are redirected into " +
  "this disposable temp tree. Every non-allowlisted variable (including provider credentials) is NOT inherited; a dedicated " +
  "credential is forwarded only when named with --credential-env (name reported, value never). " +
  "The real ~/.commandcode is not referenced by this environment, but a live 'real profile unchanged' " +
  "confirmation is a separate acceptance item and is NOT claimed here.";

function normName(name: string, win: boolean): string {
  return win ? name.toUpperCase() : name;
}

/** Case-insensitive (on win32) lookup of a source variable's value. */
function lookupSource(source: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  if (!win) return source[name];
  const target = name.toUpperCase();
  for (const key of Object.keys(source)) {
    if (key.toUpperCase() === target) {
      const v = source[key];
      if (typeof v === "string") return v;
    }
  }
  return undefined;
}

/** Set a variable, removing any case-variant first so Windows never gets duplicates. */
function setEnv(env: NodeJS.ProcessEnv, name: string, value: string, win: boolean): void {
  if (win) {
    const target = name.toUpperCase();
    for (const key of Object.keys(env)) {
      if (key !== name && key.toUpperCase() === target) delete env[key];
    }
  }
  env[name] = value;
}

/**
 * Create the disposable tree and derive the isolated environment.
 *
 * The returned `env` REPLACES the child environment (it is not merged with
 * process.env by the caller). It contains ONLY allowlisted non-credential
 * variables (with the home/data/temp roots redirected into the tree) plus any
 * credential the operator explicitly forwarded.
 */
export function createCliIsolation(input: CliIsolationInput = {}): CliIsolation {
  const source = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const win = platform === "win32";

  const parent = input.baseDir && input.baseDir.trim() ? input.baseDir.trim() : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, input.tempPrefix ?? "jobquay-cli-"));
  const cliHome = path.join(root, "cli-home");
  const cwd = path.join(root, "cwd");
  const appData = path.join(root, "appdata");
  const localAppData = path.join(root, "localappdata");
  const tmpDir = path.join(root, "tmp");
  const xdgData = path.join(root, "xdg", "data");
  const xdgConfig = path.join(root, "xdg", "config");
  const xdgCache = path.join(root, "xdg", "cache");
  const xdgState = path.join(root, "xdg", "state");
  for (const dir of [cliHome, cwd, appData, localAppData, tmpDir, xdgData, xdgConfig, xdgCache, xdgState]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 1. Carry ONLY allowlisted, non-credential variables from the source.
  const allowed = new Set(MINIMAL_ENV_ALLOWLIST.map((n) => normName(n, win)));
  const env: NodeJS.ProcessEnv = {};
  const carriedEnvVars: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const norm = normName(key, win);
    if (!allowed.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    env[key] = value;
    carriedEnvVars.push(key);
  }

  // 2. Redirect the home / data / temp / XDG roots into the disposable tree.
  const redirectedEnv: Record<string, string> = {};
  const redirect = (name: string, value: string): void => {
    setEnv(env, name, value, win);
    redirectedEnv[name] = value;
  };
  redirect("HOME", cliHome);
  redirect("USERPROFILE", cliHome);
  redirect("APPDATA", appData);
  redirect("LOCALAPPDATA", localAppData);
  redirect("TEMP", tmpDir);
  redirect("TMP", tmpDir);
  redirect("TMPDIR", tmpDir);
  redirect("XDG_DATA_HOME", xdgData);
  redirect("XDG_CONFIG_HOME", xdgConfig);
  redirect("XDG_CACHE_HOME", xdgCache);
  redirect("XDG_STATE_HOME", xdgState);
  if (win) {
    // Use win32 semantics regardless of host so a drive path splits correctly;
    // HOMEDRIVE + HOMEPATH reconstructs cliHome.
    const parsed = path.win32.parse(cliHome);
    redirect("HOMEDRIVE", parsed.root.replace(/[\\/]+$/, ""));
    redirect("HOMEPATH", cliHome.slice(parsed.root.length - 1));
  }

  // 3. Credential hygiene on the allowlisted environment.
  const forwardSet = input.forwardCredentialEnv ?? [];
  const forwardNorm = new Set(forwardSet.map((n) => normName(n, win)));

  const removedCredentialVars: string[] = [];
  for (const name of KNOWN_CREDENTIAL_ENV_VARS) {
    if (lookupSource(source, name, win) !== undefined && !forwardNorm.has(normName(name, win))) {
      removedCredentialVars.push(name);
    }
  }

  // Name (never read the value of) secret-looking variables the allowlist dropped,
  // so the report is explicit that e.g. OPENAI_API_KEY was present and excluded.
  const knownNorm = new Set(KNOWN_CREDENTIAL_ENV_VARS.map((n) => normName(n, win)));
  const droppedSensitiveVars: string[] = [];
  for (const key of Object.keys(source)) {
    if (typeof source[key] !== "string") continue;
    const norm = normName(key, win);
    if (allowed.has(norm) || knownNorm.has(norm) || forwardNorm.has(norm)) continue;
    if (!SENSITIVE_NAME_RE.test(key)) continue;
    droppedSensitiveVars.push(key);
  }
  droppedSensitiveVars.sort();
  if (droppedSensitiveVars.length > DROPPED_SENSITIVE_CAP) {
    droppedSensitiveVars.length = DROPPED_SENSITIVE_CAP;
  }

  const forwardedCredentialVars: string[] = [];
  const missingCredentialVars: string[] = [];
  for (const name of forwardSet) {
    const value = lookupSource(source, name, win);
    if (typeof value === "string" && value.length > 0) {
      setEnv(env, name, value, win);
      forwardedCredentialVars.push(name);
    } else {
      missingCredentialVars.push(name);
    }
  }

  return {
    root,
    cliHome,
    cwd,
    env,
    carriedEnvVars,
    redirectedEnv,
    removedCredentialVars,
    droppedSensitiveVars,
    forwardedCredentialVars,
    missingCredentialVars
  };
}

/**
 * Parse `--credential-env <NAME>` (repeatable) and `--credential-env=<NAME>`.
 * Only env var NAMES are accepted; no credential value ever appears on a command
 * line. Duplicates collapse.
 */
export function parseForwardCredentialEnv(
  argv: readonly string[],
  flag: string = CREDENTIAL_ENV_FLAG
): string[] {
  const out: string[] = [];
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    let name: string | null = null;
    if (a === flag) {
      const next = argv[i + 1];
      if (typeof next === "string") {
        name = next;
        i += 1;
      }
    } else if (a.startsWith(eqPrefix)) {
      name = a.slice(eqPrefix.length);
    }
    if (name) {
      const v = name.trim();
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** The reportable shape of an isolation (paths + env hygiene, never a value). */
export function describeCliIsolation(isolation: CliIsolation): CliIsolationReport {
  return {
    root: isolation.root,
    cliHome: isolation.cliHome,
    cwd: isolation.cwd,
    homeEnv: { HOME: isolation.cliHome, USERPROFILE: isolation.cliHome },
    redirectedEnv: { ...isolation.redirectedEnv },
    carriedEnvVars: [...isolation.carriedEnvVars],
    removedCredentialVars: [...isolation.removedCredentialVars],
    droppedSensitiveVars: [...isolation.droppedSensitiveVars],
    forwardedCredentialVars: [...isolation.forwardedCredentialVars],
    missingCredentialVars: [...isolation.missingCredentialVars],
    liveConfirmed: false,
    note: ISOLATION_NOTE
  };
}
