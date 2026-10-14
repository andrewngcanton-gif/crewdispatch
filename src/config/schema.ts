// schema.ts — CrewDispatch's OWN versioned, atomic JSON configuration.
//
// Scope (M1 batch 4, Command Code only):
//   * the config lives under CrewDispatch's own data root (`<root>/config.json`).
//     NOTHING outside that root is read or written, and no other product's
//     configuration file is touched;
//   * every write goes through the shared temp-file + fsync + rename helper, so
//     a crash can never leave a half-written config that a reader would parse;
//   * the file is versioned (`configVersion`). A file written by a NEWER build is
//     refused honestly instead of being misread;
//   * the schema is a WHITELIST. There is deliberately NO edition/provider
//     selector and no free/paid model claim: M1 exposes exactly one provider
//     (the official Command Code CLI). An unknown field is REJECTED with a stable
//     code and the stored file is never silently repaired or overwritten;
//   * the rate-limit fallback model and the in-flight boundary switch are STORED
//     here and BOTH are executed by the worker under the persisted regression contract.
//     The in-flight switch only FIRES under its documented conditions (toggle ON, no
//     explicit model, a reliable official catalog and a resumable session); otherwise
//     a running job keeps its current model.
//
// Validation is total: `validateConfig` either returns a normalised config or a
// stable `ConfigError` code — it never coerces a bad value into a different one.
import fs from "node:fs";
import path from "node:path";
import { assertInside, atomicWriteFile } from "../jobs/store";
import { EFFORT_LEVELS, normalizePermissionMode, PERMISSION_MODE_STANDARD_SYNONYM, PERMISSION_MODES } from "../providers/command-code/capability";
import { MODEL_TOKEN_RE } from "../providers/command-code/argv";

export const CONFIG_VERSION = 1;
export const MAX_TIME_SLOTS = 3;
/** The product default permission mode (yolo: no interactive confirmation prompts). */
export const DEFAULT_CONFIG_PERMISSION_MODE = "yolo";

/** One time window. `start`/`end` are local wall-clock `HH:mm`. */
export interface TimeSlot {
  start: string;
  end: string;
  model: string;
  enabled: boolean;
}

/**
 * CrewDispatch's persisted configuration. Flat on purpose: M1 has one provider, so
 * there is no provider/edition namespace and no selector.
 */
export interface CrewDispatchConfig {
  configVersion: number;
  /** Optional explicit official-CLI executable override (null = discover). */
  cliPath: string | null;
  /** Default model id; null = fall through to the CLI's own catalog default. */
  defaultModel: string | null;
  /** Final rate-limit fallback id — executed on a clear exit-5 model rate limit (same job/session). */
  rateLimitFallbackModel: string | null;
  /**
   * Default permission mode for a job that does not specify one. Stored in the
   * canonical public spelling: the documented Command Code synonym `default`
   * is normalized to `standard` (see `normalizePermissionMode`); an existing
   * file is normalized on read but never rewritten by a read.
   */
  permissionMode: string;
  /**
   * Reasoning effort for the configured DEFAULT model; null = the provider's
   * own model default (`--effort` is not passed). It is INDEPENDENT of the
   * fallback model's effort: changing one never rewrites the other.
   */
  defaultEffort: string | null;
  /**
   * Reasoning effort for the configured `rateLimitFallbackModel`; null = the
   * provider's own model default. Reached only on a clear exit-5 model rate
   * limit, together with that fallback candidate.
   */
  rateLimitFallbackEffort: string | null;
  /** Up to `MAX_TIME_SLOTS` windows; list order is the priority order. */
  timeSlots: TimeSlot[];
  /** In-flight boundary auto switch — executed under its conditions: toggle ON, no explicit model, reliable catalog, resumable session; the old CLI tree is safely stopped (exit confirmed) and the same job/session resumes in a new generation. Otherwise the job keeps its current model. */
  inFlightSwitch: boolean;
}

export function defaultConfig(): CrewDispatchConfig {
  return {
    configVersion: CONFIG_VERSION,
    cliPath: null,
    defaultModel: null,
    rateLimitFallbackModel: null,
    permissionMode: DEFAULT_CONFIG_PERMISSION_MODE,
    defaultEffort: null,
    rateLimitFallbackEffort: null,
    timeSlots: [],
    inFlightSwitch: false
  };
}

/** A stable, user-reportable configuration error. */
export class ConfigError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.field = field;
  }
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "configVersion",
  "cliPath",
  "defaultModel",
  "rateLimitFallbackModel",
  "permissionMode",
  "defaultEffort",
  "rateLimitFallbackEffort",
  "timeSlots",
  "inFlightSwitch"
]);
const SLOT_KEYS: ReadonlySet<string> = new Set(["start", "end", "model", "enabled"]);

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;

/** Local second-of-day for an `HH:mm` value, or null when unparseable. */
export function toSeconds(hms: unknown): number | null {
  if (typeof hms !== "string") return null;
  const m = HHMM_RE.exec(hms.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 3600 + mi * 60;
}

/** Normalise `H:mm` / `HH:mm` to a zero-padded `HH:mm`, or null when invalid. */
export function normalizeHhMm(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = HHMM_RE.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: ConfigError };

function fail(code: string, message: string, field: string | null): { ok: false; error: ConfigError } {
  return { ok: false, error: new ConfigError(code, message, field) };
}

function nullableModel(value: unknown, field: string): Validated<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail("config_invalid_type", `${field} must be a string or null.`, field);
  const v = value.trim();
  if (!v) return { ok: true, value: null };
  if (!MODEL_TOKEN_RE.test(v)) return fail("config_invalid_model", `${field} is not a valid model ID: ${JSON.stringify(v)}.`, field);
  return { ok: true, value: v };
}

/**
 * Validate one reasoning-effort setting. A blank string is an honest "unset"
 * (null = the provider/model default, no `--effort`), never an empty claim.
 */
function nullableEffort(value: unknown, field: string): Validated<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail("config_invalid_type", `${field} must be a string or null.`, field);
  const v = value.trim().toLowerCase();
  if (!v) return { ok: true, value: null };
  if (!EFFORT_LEVELS.includes(v)) {
    return fail(
      "config_invalid_effort",
      `${field} ${JSON.stringify(value)} is not a supported level (valid values: ${EFFORT_LEVELS.join(", ")}; blank means --effort is not passed).`,
      field
    );
  }
  return { ok: true, value: v };
}

function validateSlots(raw: unknown): Validated<TimeSlot[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail("config_invalid_type", "timeSlots must be an array.", "timeSlots");
  if (raw.length > MAX_TIME_SLOTS) {
    return fail("config_too_many_slots", `At most ${MAX_TIME_SLOTS} time slots are allowed; got ${raw.length}.`, "timeSlots");
  }
  const out: TimeSlot[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const field = `timeSlots[${i}]`;
    const el = raw[i];
    if (!el || typeof el !== "object" || Array.isArray(el)) return fail("config_invalid_type", `${field} must be an object.`, field);
    const o = el as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (!SLOT_KEYS.has(key)) return fail("config_unknown_field", `Unknown time-slot field: ${field}.${key}.`, `${field}.${key}`);
    }
    const start = normalizeHhMm(o.start);
    if (!start) return fail("config_invalid_slot", `${field}.start must be HH:mm (00:00–23:59); got ${JSON.stringify(o.start)}.`, `${field}.start`);
    const end = normalizeHhMm(o.end);
    if (!end) return fail("config_invalid_slot", `${field}.end must be HH:mm (00:00–23:59); got ${JSON.stringify(o.end)}.`, `${field}.end`);
    if (start === end) {
      return fail("config_invalid_slot", `${field} start and end are equal (${start}), which is an empty window; use two different times.`, field);
    }
    const model = nullableModel(o.model, `${field}.model`);
    if (!model.ok) return model;
    if (!model.value) return fail("config_invalid_model", `${field}.model must not be empty.`, `${field}.model`);
    if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
      return fail("config_invalid_type", `${field}.enabled must be a boolean.`, `${field}.enabled`);
    }
    out.push({ start, end, model: model.value, enabled: o.enabled === true });
  }
  return { ok: true, value: out };
}

/**
 * Validate and normalise an arbitrary JSON value into a `CrewDispatchConfig`.
 *
 * A value that cannot be represented is REJECTED with a stable code; it is never
 * silently dropped, repaired or replaced by a different value.
 */
export function validateConfig(raw: unknown): Validated<CrewDispatchConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("config_invalid_type", "Configuration must be a JSON object.", null);
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!CONFIG_KEYS.has(key)) {
      return fail("config_unknown_field", `Unknown configuration field: ${key} (CrewDispatch configuration accepts only whitelisted fields and has no provider/edition selector).`, key);
    }
  }

  if (r.configVersion !== undefined) {
    const v = r.configVersion;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return fail("config_invalid_type", "configVersion must be a non-negative integer.", "configVersion");
    }
    if (v > CONFIG_VERSION) {
      return fail("config_version_too_new", `Configuration version ${v} is newer than this build supports (${CONFIG_VERSION}); it was refused rather than misread.`, "configVersion");
    }
  }

  // cliPath: optional executable override. An empty string means "unset". The
  // value is documented as an ABSOLUTE path, so a relative one is rejected at
  // this boundary (per the CURRENT platform) instead of being silently resolved
  // against an unpredictable cwd later.
  let cliPath: string | null = null;
  if (r.cliPath !== undefined && r.cliPath !== null) {
    if (typeof r.cliPath !== "string") return fail("config_invalid_type", "cliPath must be a string or null.", "cliPath");
    const v = r.cliPath.trim();
    if (v) {
      if (/[\0\r\n]/.test(v)) return fail("config_invalid_cli_path", "cliPath must not contain control characters.", "cliPath");
      if (!path.isAbsolute(v)) {
        return fail("config_invalid_cli_path", `cliPath must be an absolute path (current platform ${process.platform}); got ${JSON.stringify(v)}.`, "cliPath");
      }
      cliPath = v;
    }
  }

  const defaultModel = nullableModel(r.defaultModel, "defaultModel");
  if (!defaultModel.ok) return defaultModel;
  const rateLimitFallbackModel = nullableModel(r.rateLimitFallbackModel, "rateLimitFallbackModel");
  if (!rateLimitFallbackModel.ok) return rateLimitFallbackModel;

  let permissionMode = DEFAULT_CONFIG_PERMISSION_MODE;
  if (r.permissionMode !== undefined && r.permissionMode !== null) {
    if (typeof r.permissionMode !== "string") return fail("config_invalid_type", "permissionMode must be a string.", "permissionMode");
    // The ONE Command Code provider normalization (trim/case + the documented
    // `default` synonym -> canonical `standard`) is reused here, so a saved/new
    // value is persisted in the same canonical spelling the launch path uses.
    const v = normalizePermissionMode(r.permissionMode);
    if (!v) {
      return fail(
        "config_invalid_permission_mode",
        `permissionMode ${JSON.stringify(r.permissionMode)} is not a supported permission mode (valid values: ${PERMISSION_MODES.join(", ")}; "${PERMISSION_MODE_STANDARD_SYNONYM}" is accepted as a synonym for "standard").`,
        "permissionMode"
      );
    }
    permissionMode = v;
  }

  const defaultEffort = nullableEffort(r.defaultEffort, "defaultEffort");
  if (!defaultEffort.ok) return defaultEffort;
  const rateLimitFallbackEffort = nullableEffort(r.rateLimitFallbackEffort, "rateLimitFallbackEffort");
  if (!rateLimitFallbackEffort.ok) return rateLimitFallbackEffort;

  const slots = validateSlots(r.timeSlots);
  if (!slots.ok) return slots;

  if (r.inFlightSwitch !== undefined && typeof r.inFlightSwitch !== "boolean") {
    return fail("config_invalid_type", "inFlightSwitch must be a boolean.", "inFlightSwitch");
  }

  return {
    ok: true,
    value: {
      configVersion: CONFIG_VERSION,
      cliPath,
      defaultModel: defaultModel.value,
      rateLimitFallbackModel: rateLimitFallbackModel.value,
      permissionMode,
      defaultEffort: defaultEffort.value,
      rateLimitFallbackEffort: rateLimitFallbackEffort.value,
      timeSlots: slots.value,
      inFlightSwitch: r.inFlightSwitch === true
    }
  };
}

// ---------------------------------------------------------------------------
// Patch / merge
// ---------------------------------------------------------------------------

/** The external (snake_case) field names accepted by the settings entry points. */
export const CONFIG_SNAKE_TO_CAMEL: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["cli_path", "cliPath"],
  ["default_model", "defaultModel"],
  ["rate_limit_fallback_model", "rateLimitFallbackModel"],
  ["permission_mode", "permissionMode"],
  ["default_effort", "defaultEffort"],
  ["rate_limit_fallback_effort", "rateLimitFallbackEffort"],
  ["time_slots", "timeSlots"],
  ["in_flight_switch", "inFlightSwitch"]
]);

const CONFIG_SNAKE_KEYS: ReadonlySet<string> = new Set(CONFIG_SNAKE_TO_CAMEL.map(([snake]) => snake));

/**
 * Map a snake_case settings payload (the MCP/CLI surface) to a config patch,
 * keeping ONLY the keys that were actually present so an omitted field is left
 * unchanged rather than reset to a default.
 *
 * An UNKNOWN top-level key is REJECTED with `config_unknown_field` — it is never
 * silently dropped. This matters for the MCP path: a request that names an
 * unsupported field (e.g. a `provider` selector or a typo) must fail loudly
 * instead of returning `ok:true` while persisting nothing.
 */
export function configPatchFromSnake(input: unknown): Record<string, unknown> {
  const a = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const key of Object.keys(a)) {
    if (!CONFIG_SNAKE_KEYS.has(key)) {
      throw new ConfigError("config_unknown_field", `Unknown configuration field: ${key} (CrewDispatch configuration accepts only whitelisted fields and has no provider/edition selector).`, key);
    }
  }
  const patch: Record<string, unknown> = {};
  for (const [snake, camel] of CONFIG_SNAKE_TO_CAMEL) {
    if (Object.prototype.hasOwnProperty.call(a, snake)) patch[camel] = a[snake];
  }
  return patch;
}

/**
 * Merge an update patch onto a base config (a shallow merge for every field
 * EXCEPT `timeSlots`, which the patch REPLACES wholesale). The result is a
 * candidate value that must still pass `validateConfig`; an unknown patch field
 * is rejected up front. The caller never writes a partially-valid file.
 *
 * One derived rule: when the patch CHANGES a selection's model and does NOT
 * carry that selection's own effort key, the effort is reset to null (provider
 * default). An explicit effort in the same patch is preserved.
 */
export function applyConfigPatch(base: CrewDispatchConfig, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ConfigError("config_invalid_type", "A configuration update must be a JSON object.", null);
  }
  const p = patch as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new ConfigError("config_unknown_field", `Unknown configuration field: ${key} (CrewDispatch configuration accepts only whitelisted fields).`, key);
    }
  }
  const candidate: Record<string, unknown> = { ...base };
  for (const key of Object.keys(p)) candidate[key] = p[key];
  // A selection's MODEL change resets ONLY that selection's effort to the
  // provider default, unless the SAME patch explicitly supplies a replacement.
  // The two efforts are independent: changing the default model never rewrites
  // the fallback model's effort and vice versa.
  const own = (key: string): boolean => Object.prototype.hasOwnProperty.call(p, key);
  if (own("defaultModel") && !sameModelValue(p.defaultModel, base.defaultModel) && !own("defaultEffort")) {
    candidate.defaultEffort = null;
  }
  if (own("rateLimitFallbackModel") && !sameModelValue(p.rateLimitFallbackModel, base.rateLimitFallbackModel) && !own("rateLimitFallbackEffort")) {
    candidate.rateLimitFallbackEffort = null;
  }
  return candidate;
}

/** Trimmed model-id equality for the "did this patch change the model?" rule. */
function sameModelValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export function configPath(root: string): string {
  return path.join(root, "config.json");
}

export interface LoadConfigResult {
  ok: boolean;
  /** True when a config file exists (even if it is invalid). */
  present: boolean;
  /** The parsed config on success; the defaults when absent or invalid. */
  config: CrewDispatchConfig;
  error: ConfigError | null;
  /** The raw file text, kept for an honest diagnostic (never re-written here). */
  rawText: string | null;
}

/**
 * Read `<root>/config.json`. A missing file is a normal "not configured yet"
 * result (the defaults apply). A present but invalid file is reported with a
 * stable error and its raw text — it is NEVER silently repaired or overwritten.
 */
export function loadConfigResult(root: string): LoadConfigResult {
  const file = configPath(root);
  assertInside(root, file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, present: false, config: defaultConfig(), error: null, rawText: null };
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      present: true,
      config: defaultConfig(),
      error: new ConfigError("config_corrupt", `Configuration file is not valid JSON: ${file}`, null),
      rawText: text
    };
  }
  const v = validateConfig(raw);
  if (!v.ok) return { ok: false, present: true, config: defaultConfig(), error: v.error, rawText: text };
  return { ok: true, present: true, config: v.value, error: null, rawText: text };
}

/** Load the config, throwing a `ConfigError` when the file is present but invalid. */
export function loadConfig(root: string): CrewDispatchConfig {
  const r = loadConfigResult(root);
  if (!r.ok) throw r.error ?? new ConfigError("config_corrupt", "The configuration file cannot be read.", null);
  return r.config;
}

/** Validate + atomically persist a config. Never writes an invalid file. */
export function saveConfig(root: string, config: CrewDispatchConfig): CrewDispatchConfig {
  const file = configPath(root);
  assertInside(root, file);
  const v = validateConfig(config);
  if (!v.ok) throw v.error;
  atomicWriteFile(file, JSON.stringify(v.value, null, 2));
  return v.value;
}

export interface UpdateConfigResult {
  config: CrewDispatchConfig;
}

/**
 * Apply a patch and persist the result in ONE validated, atomic write.
 *
 * A MISSING file is a normal "not configured yet" case: the patch is applied
 * against the defaults and a new file is created. A file that is PRESENT but
 * corrupt/invalid is NEVER silently repaired or overwritten — the existing
 * config error is thrown and the file is left byte-identical. An invalid
 * patch/merge likewise throws and leaves the stored file exactly as it was.
 */
export function updateConfig(root: string, patch: unknown): UpdateConfigResult {
  const current = loadConfigResult(root);
  if (!current.ok) throw current.error ?? new ConfigError("config_corrupt", "The configuration file cannot be read.", null);
  const candidate = applyConfigPatch(current.config, patch);
  const v = validateConfig(candidate);
  if (!v.ok) throw v.error;
  saveConfig(root, v.value);
  return { config: v.value };
}

/** The whitelisted config shape returned to a caller (snake_case). */
export interface ConfigView {
  cli_path: string | null;
  default_model: string | null;
  rate_limit_fallback_model: string | null;
  permission_mode: string;
  default_effort: string | null;
  rate_limit_fallback_effort: string | null;
  time_slots: Array<{ start: string; end: string; model: string; enabled: boolean }>;
  in_flight_switch: boolean;
}

export function configView(config: CrewDispatchConfig): ConfigView {
  return {
    cli_path: config.cliPath,
    default_model: config.defaultModel,
    rate_limit_fallback_model: config.rateLimitFallbackModel,
    permission_mode: config.permissionMode,
    default_effort: config.defaultEffort,
    rate_limit_fallback_effort: config.rateLimitFallbackEffort,
    time_slots: config.timeSlots.map((s) => ({ start: s.start, end: s.end, model: s.model, enabled: s.enabled })),
    in_flight_switch: config.inFlightSwitch
  };
}

/** @deprecated Use CrewDispatchConfig; retained for source consumers. */
export type JobQuayConfig = CrewDispatchConfig;
