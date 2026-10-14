// global.ts — CrewDispatch's persistent, GLOBAL (provider-independent) UI settings.
//
// Scope (M1 batch 7A, Command Code only):
//   * the settings live under CrewDispatch's OWN data root (`<root>/global-settings.json`).
//     NOTHING outside that root is read or written, and no other product's file
//     is touched;
//   * every write goes through the shared temp-file + fsync + rename helper, so a
//     crash can never leave a half-written file that a reader would parse;
//   * the file is purely additive state (never rejects a missing file — defaults
//     apply). An unknown top-level field or an illegal value is REJECTED with a
//     stable code and the stored file is left untouched (never partially written,
//     never silently repaired);
//   * the only three knobs are the session-list page size and the two diagnostics
//     retention limits (days + total bytes). There is NO provider/edition
//     selector and no free/paid model claim — M1 exposes exactly one provider.
//
// The retention limits are read by the diagnostics-cleanup module
// (src/hub/retention.ts); a change here applies to the NEXT cleanup entry point
// (a settings save, a Hub restart or the explicit cleanup endpoint) without a
// resident timer. `0` means "no limit" for every one of the three values.
import fs from "node:fs";
import path from "node:path";
import { assertInside, atomicWriteFile, resolveDataRoot } from "../jobs/store";

/** The page-size options the UI may offer (0 = "unlimited"). */
export const JOBS_PAGE_SIZE_OPTIONS: readonly number[] = Object.freeze([20, 50, 100, 200, 0]);
export const DEFAULT_JOBS_PAGE_SIZE = 50;
export const DEFAULT_DIAG_RETENTION_DAYS = 30;
export const DEFAULT_DIAG_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export interface GlobalSettings {
  /** Session-list page size (one of JOBS_PAGE_SIZE_OPTIONS). */
  jobs_page_size: number;
  /** Diagnostics kept by age, in days (0 = keep forever). */
  diag_retention_days: number;
  /** Diagnostics kept by total size, in bytes (0 = unlimited). */
  diag_max_total_bytes: number;
}

export const DEFAULT_GLOBAL: GlobalSettings = {
  jobs_page_size: DEFAULT_JOBS_PAGE_SIZE,
  diag_retention_days: DEFAULT_DIAG_RETENTION_DAYS,
  diag_max_total_bytes: DEFAULT_DIAG_MAX_TOTAL_BYTES
};

/** A stable, user-reportable validation error. */
export class GlobalSettingsError extends Error {
  readonly code: string;
  readonly field: string | null;
  constructor(code: string, message: string, field: string | null = null) {
    super(message);
    this.name = "GlobalSettingsError";
    this.code = code;
    this.field = field;
  }
}

export function globalSettingsPath(root: string): string {
  return path.join(root, "global-settings.json");
}

/**
 * Strict non-negative-integer coercion. Returns null when the value is NOT a
 * non-negative integer, so the API can answer 400 instead of silently coercing
 * (a string "false" must never become 0/true, a float must never be truncated).
 */
function toNonNegativeInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Validate `jobs_page_size`: exactly one of JOBS_PAGE_SIZE_OPTIONS, else null. */
export function normalizeJobsPageSize(v: unknown): number | null {
  const n = toNonNegativeInt(v);
  return n !== null && (JOBS_PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : null;
}

/** Validate `diag_retention_days` (0 = keep forever), else null. */
export function normalizeDiagRetentionDays(v: unknown): number | null {
  return toNonNegativeInt(v);
}

/** Validate `diag_max_total_bytes` (0 = unlimited), else null. */
export function normalizeDiagMaxTotalBytes(v: unknown): number | null {
  return toNonNegativeInt(v);
}

const GLOBAL_KEYS: ReadonlySet<string> = new Set([
  "jobs_page_size",
  "diag_retention_days",
  "diag_max_total_bytes"
]);

export interface LoadGlobalResult {
  ok: boolean;
  present: boolean;
  settings: GlobalSettings;
  error: GlobalSettingsError | null;
  rawText: string | null;
}

/**
 * Read `<root>/global-settings.json`. A missing file is a normal "not configured
 * yet" result (the defaults apply). A present but invalid file is reported with
 * a stable error and its raw text — it is NEVER silently repaired or overwritten.
 */
export function loadGlobalSettings(root: string): LoadGlobalResult {
  const file = globalSettingsPath(root);
  assertInside(root, file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, present: false, settings: { ...DEFAULT_GLOBAL }, error: null, rawText: null };
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
      settings: { ...DEFAULT_GLOBAL },
      error: new GlobalSettingsError("global_corrupt", `Global settings file is not valid JSON: ${file}`, null),
      rawText: text
    };
  }
  const v = validateGlobal(raw);
  if (!v.ok) return { ok: false, present: true, settings: { ...DEFAULT_GLOBAL }, error: v.error, rawText: text };
  return { ok: true, present: true, settings: v.value, error: null, rawText: text };
}

export type ValidateGlobalResult =
  | { ok: true; value: GlobalSettings }
  | { ok: false; error: GlobalSettingsError };

/** Validate + normalise an arbitrary JSON value into GlobalSettings. */
export function validateGlobal(raw: unknown): ValidateGlobalResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: new GlobalSettingsError("global_invalid_type", "Global settings must be a JSON object.", null) };
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!GLOBAL_KEYS.has(key)) {
      return {
        ok: false,
        error: new GlobalSettingsError("global_unknown_field", `Unknown global settings field: ${key} (only jobs_page_size / diag_retention_days / diag_max_total_bytes are accepted).`, key)
      };
    }
  }
  const pageSize = normalizeJobsPageSize(r.jobs_page_size);
  if (r.jobs_page_size !== undefined && pageSize === null) {
    return {
      ok: false,
      error: new GlobalSettingsError(
        "global_invalid_page_size",
        `jobs_page_size: ${JSON.stringify(r.jobs_page_size)} is not a valid option (allowed: ${JOBS_PAGE_SIZE_OPTIONS.join(", ")}; 0 = unlimited).`,
        "jobs_page_size"
      )
    };
  }
  const days = normalizeDiagRetentionDays(r.diag_retention_days);
  if (r.diag_retention_days !== undefined && days === null) {
    return {
      ok: false,
      error: new GlobalSettingsError(
        "global_invalid_retention_days",
        `diag_retention_days: ${JSON.stringify(r.diag_retention_days)} must be a non-negative integer (0 = keep forever).`,
        "diag_retention_days"
      )
    };
  }
  const bytes = normalizeDiagMaxTotalBytes(r.diag_max_total_bytes);
  if (r.diag_max_total_bytes !== undefined && bytes === null) {
    return {
      ok: false,
      error: new GlobalSettingsError(
        "global_invalid_max_bytes",
        `diag_max_total_bytes: ${JSON.stringify(r.diag_max_total_bytes)} must be a non-negative integer (0 = unlimited).`,
        "diag_max_total_bytes"
      )
    };
  }
  return {
    ok: true,
    value: {
      jobs_page_size: pageSize ?? DEFAULT_GLOBAL.jobs_page_size,
      diag_retention_days: days ?? DEFAULT_GLOBAL.diag_retention_days,
      diag_max_total_bytes: bytes ?? DEFAULT_GLOBAL.diag_max_total_bytes
    }
  };
}

/**
 * Map an external (snake_case) settings payload to a patch, keeping ONLY the keys
 * that were actually present so an omitted field is left unchanged rather than
 * reset to a default.
 *
 * An UNKNOWN top-level key is REJECTED with `global_unknown_field` — it is never
 * silently dropped.
 */
export function globalPatchFromSnake(input: unknown): Record<string, unknown> {
  const a = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const key of Object.keys(a)) {
    if (!GLOBAL_KEYS.has(key)) {
      throw new GlobalSettingsError("global_unknown_field", `Unknown global settings field: ${key} (only jobs_page_size / diag_retention_days / diag_max_total_bytes are accepted).`, key);
    }
  }
  return { ...a };
}

/** Validate + atomically persist global settings. Never writes an invalid file. */
export function saveGlobalSettings(root: string, settings: GlobalSettings): GlobalSettings {
  const file = globalSettingsPath(root);
  assertInside(root, file);
  const v = validateGlobal(settings);
  if (!v.ok) throw v.error;
  const out: GlobalSettings = { ...DEFAULT_GLOBAL, ...v.value };
  atomicWriteFile(file, JSON.stringify(out, null, 2));
  return out;
}

/** Apply a patch and persist in ONE validated, atomic write. */
export function updateGlobalSettings(root: string, patch: unknown): GlobalSettings {
  const current = loadGlobalSettings(root);
  if (!current.ok) throw current.error ?? new GlobalSettingsError("global_corrupt", "The global settings file cannot be read.", null);
  const merged: Record<string, unknown> = { ...current.settings };
  const p = globalPatchFromSnake(patch);
  for (const key of Object.keys(p)) merged[key] = p[key];
  const v = validateGlobal(merged);
  if (!v.ok) throw v.error;
  return saveGlobalSettings(root, v.value);
}

/** The effective retention policy for the diagnostics cleanup (0 = no limit). */
export interface RetentionPolicy {
  /** Max age in ms (0 = unlimited). */
  maxAgeMs: number;
  /** Max total bytes across all diagnostic files (0 = unlimited). */
  maxBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve the effective retention policy from the CURRENT global settings. */
export function resolveRetentionPolicy(root: string): RetentionPolicy {
  const g = loadGlobalSettings(root).settings;
  return {
    maxAgeMs: g.diag_retention_days > 0 ? g.diag_retention_days * DAY_MS : 0,
    maxBytes: g.diag_max_total_bytes > 0 ? g.diag_max_total_bytes : 0
  };
}

export { resolveDataRoot };
