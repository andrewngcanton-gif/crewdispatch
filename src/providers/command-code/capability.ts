// capability.ts — Command Code provider constants and the PUBLIC capability
// probe of the installed CLI.
//
// Compatibility note: behaviour re-implemented
// from the read-only reference `wb-crew/src/command-code.mjs` and
// `wb-crew/src/editions.mjs` (effort/capability part). Provider identity,
// environment variable names and user-facing text are CrewDispatch's own; the
// official CLI's flag set, permission enum, effort enum and exit codes are
// documented facts about that CLI and are reproduced as such.
//
// HARD BOUNDARY: only the user-installed official `cmdc` (or `command-code`)
// executable is ever resolved or launched. No private harness package, no
// credential/database read or write, no bundled CLI.

export const COMMAND_CODE_PROVIDER = "command-code";
export const COMMAND_CODE_DISPLAY_NAME = "Command Code";

// CrewDispatch's own configuration namespace. The old installation used WB_CREW_*
// names; the new product must not read or write the old product's variables.
export const CLI_PATH_ENV = "JOBQUAY_COMMAND_CODE_CLI_PATH";
export const CLI_COMMAND_ENV = "JOBQUAY_COMMAND_CODE_CLI_COMMAND";
export const CLI_AUTODISCOVER_ENV = "JOBQUAY_CLI_AUTODISCOVER";

/** All official Command Code executable aliases used for package-bin recognition. */
export const CLI_PATH_NAMES: readonly string[] = Object.freeze(["cmdc", "cmd", "command-code"]);

/** Platform-specific official PATH aliases. */
export function commandCodePathNames(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? ["cmdc", "command-code"] : ["cmd", "command-code"];
}

// ---- Permission modes (the installed CLI's enum + persisted contract) ----
//
// The KNOWN persisted-mode contract of this provider: the modes the installed
// CLI natively publishes (`standard`, `plan`, `accept-edits`, `yolo`) PLUS the
// reference-only token `dont-ask` kept so an already-saved value is never
// rejected or rewritten. `config.json` may persist any of these.
//
// The canonical PUBLIC spelling of the installed CLI's Standard mode is
// `standard`. The CLI's own `--help` calls it the default permission mode and
// its ACP wire names the mode id `default`, so the exact input token `default`
// is accepted as a DOCUMENTED SYNONYM and normalized to `standard` by
// `normalizePermissionMode` — it is not a separate mode, it is never persisted
// as `default` by the config layer, and it always means standard approval
// behavior (never `yolo` / `accept-edits` / a broader permission).
//
// This list is NOT the launch allow-list: at launch the INSTALLED CLI's own
// published `--help` list is authoritative (see `buildCommandCodeArgv`), so a
// mode the installed CLI does not publish fails at launch instead of being
// silently replaced by a different permission. The capability check is applied
// to the NORMALIZED mode, so `default` is only accepted when `standard` is
// proven supported by the installed CLI.
export const PERMISSION_MODES: readonly string[] = Object.freeze([
  "standard",
  "plan",
  "accept-edits",
  "yolo",
  "dont-ask"
]);

/**
 * The documented synonymous spelling of the Standard mode. The installed CLI's
 * own help line describes `--permission-mode` as its "Default permission mode",
 * so `default` is the name a caller (or an older packet) may use for Standard.
 * It is normalized to the canonical public `standard`; it is never a separate
 * mode and never maps to another permission.
 */
export const PERMISSION_MODE_STANDARD_SYNONYM = "default";

const PERMISSION_MODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [PERMISSION_MODE_STANDARD_SYNONYM]: "standard"
});
export const DEFAULT_PERMISSION_MODE = "accept-edits";
/** The mode the UI must warn about: no prompts at all. */
export const RISKY_PERMISSION_MODE = "yolo";

// The permission modes the INSTALLED CLI publishes in its own `--help`
// (e.g. `--permission-mode <mode>  Set permission mode (standard, plan,
// accept-edits, yolo)`). Support is discovered, never assumed: when the CLI
// publishes a list, a mode outside it is REJECTED instead of being sent to a CLI
// that may not accept it. When no list could be read, the known persisted-mode
// contract above is the fallback.
const PERMISSION_MODE_HELP_RE = /--permission-mode\s+(?:<[^>\r\n]+>|\[[^\]\r\n]*\])/;
const MODE_TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseHelpPermissionModes(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const line = raw.split("\n").find((l) => PERMISSION_MODE_HELP_RE.test(l));
  if (!line) return [];
  const parens = /\(([^)]*)\)/.exec(line);
  if (!parens || typeof parens[1] !== "string") return [];
  const out: string[] = [];
  for (const piece of parens[1].split(",")) {
    const v = piece.trim().toLowerCase();
    if (MODE_TOKEN_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Normalize a permission mode: trim, lowercase, resolve the ONE documented
 * synonym (`default` -> `standard`), then validate against the accepted set.
 *
 * This is the single CC provider normalization function reused by the config
 * layer (`src/config/schema.ts`) and the launch paths (`buildCommandCodeArgv`,
 * the ACP bridge argv parser), so every entry point agrees on the canonical
 * public spelling.
 *
 * @param publishedModes the modes the installed CLI's own help published; when
 *   present they are the ONLY accepted values (an unpublished mode is rejected
 *   rather than silently sent). The check applies to the NORMALIZED mode, so
 *   `default` is accepted only when `standard` itself is proven supported.
 */
export function normalizePermissionMode(value: unknown, publishedModes?: readonly string[] | null): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const mode = PERMISSION_MODE_ALIASES[v] ?? v;
  const allowed = Array.isArray(publishedModes) && publishedModes.length > 0 ? publishedModes : PERMISSION_MODES;
  return allowed.includes(mode) ? mode : null;
}

/** The effective mode of one profile: configured when valid, else the default. */
export function effectivePermissionMode(profile: { permission_mode?: unknown } | null | undefined): string {
  const v = profile && profile.permission_mode;
  return normalizePermissionMode(v) || DEFAULT_PERMISSION_MODE;
}

// ---- Reasoning effort (capability-driven, never assumed) ----
//
// `--effort <level>` is written ONLY when the installed CLI's own public
// `--help` publishes the option AND a level was resolved. A CLI whose help does
// not publish it is treated as NOT supporting effort: an explicit effort is
// rejected (never silently dropped, never written to an unprobed CLI).
export const EFFORT_LEVELS: readonly string[] = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
export const EFFORT_FLAG = "--effort";

// The strict option-token grammar of a CLI `--help` option list. `--effort` must
// be bounded by whitespace / start of line and must NOT be followed by a word
// char or `-` (so `--effortless` never counts), and it must TAKE A VALUE on the
// same line: `<level>`, `=<level>` or `[level]`. A bare prose mention
// ("use the --effort flag") is not credited.
const EFFORT_HELP_OPTION_RE =
  /(?:^|[\s,])--effort(?![-A-Za-z0-9_])(?:\s*=\s*(?:<[^>\r\n]+>|\[[^\]\r\n]*\]|\([^)\r\n]+\))|[ \t]+(?:<[^>\r\n]+>|\[[^\]\r\n]*\]))/;

/** True when a CLI `--help` text publishes an `--effort <level>` option. */
export function parseHelpEffortSupport(raw: unknown): boolean {
  return typeof raw === "string" && EFFORT_HELP_OPTION_RE.test(raw);
}

/**
 * The help lines that mention `--effort`, kept as external evidence for the
 * capability decision (bounded, verbatim, never rewritten).
 */
export function findEffortHelpLines(raw: unknown, limit = 5): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.includes("--effort")) out.push(line.trim());
    if (out.length >= limit) break;
  }
  return out;
}

export function normalizeEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return EFFORT_LEVELS.includes(v) ? v : null;
}

/**
 * The MODEL-SPECIFIC effort decision, evaluated BEFORE any process starts.
 *
 * `supported` is the reliable published effort list for THIS EXACT model id, or
 * null/empty when no list is known. A blank effort always means "the
 * provider/model default" and is never validated; an unknown model (no reliable
 * list) is never rejected — no evidence means "unknown", never "unsupported".
 * When a list IS known and does not contain the requested level, the run is
 * refused with an error naming the model, the requested effort and the levels
 * that model does publish.
 */
export function checkModelEffort(input: {
  model: string;
  effort: unknown;
  supported?: readonly string[] | null;
}): { ok: true; effort: string | null } | { ok: false; error: string } {
  const requested = normalizeEffort(input.effort);
  if (isBlankEffort(input.effort) || !requested) return { ok: true, effort: requested };
  // Only the CLI's own levels are accepted from the published list: a
  // placeholder or an unknown token never becomes a supported level.
  const supported: string[] = [];
  for (const item of Array.isArray(input.supported) ? input.supported : []) {
    const level = normalizeEffort(item);
    if (level && !supported.includes(level)) supported.push(level);
  }
  if (supported.length === 0 || supported.includes(requested)) return { ok: true, effort: requested };
  return {
    ok: false,
    error:
      `model ${input.model} does not support reasoning effort ${JSON.stringify(requested)}; ` +
      `its published efforts are: ${supported.join(", ")}. ` +
      `Use one of those levels, or leave the effort unset to use the provider default.`
  };
}

/** A blank effort means "unset" (CLI/model default) — distinct from invalid. */
export function isBlankEffort(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

// ---- Official exit codes ----
//
// Documented by the official CLI: 0 success, 3 auth, 4 permission,
// 5 rate limit, 6 network, 7 server, 8 max turns, 9 no response,
// 10 insufficient credits, 130 interrupted.
export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  AUTH: 3,
  PERMISSION: 4,
  RATE_LIMIT: 5,
  NETWORK: 6,
  SERVER: 7,
  MAX_TURNS: 8,
  NO_RESPONSE: 9,
  INSUFFICIENT_CREDITS: 10,
  INTERRUPTED: 130
});

export const FAILURE_AUTH = "cli_auth_error";
export const FAILURE_PERMISSION = "cli_permission_error";
export const FAILURE_RATE_LIMIT = "cli_rate_limited";
export const FAILURE_QUOTA_EXHAUSTED = "cli_quota_exhausted";

// ---- Detection source labels (product-owned UI text) ----
const CLI_SOURCE_LABELS: Record<string, string> = Object.freeze({
  "env-path": "CLI path from environment variable",
  "env-command": "command from environment variable",
  "config-path": "CLI path from configuration",
  "config-command": "command from configuration",
  "path-cmdc": "Command Code CLI on PATH (cmd/cmdc/command-code)",
  missing: "not found",
  unknown: "unknown"
});

export function describeCliSource(source: string): string {
  return CLI_SOURCE_LABELS[source] || source || CLI_SOURCE_LABELS.unknown || "unknown";
}
