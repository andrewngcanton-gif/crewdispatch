// workbuddy-ai.ts — provider-specific settings for the international WorkBuddy AI CLI.
//
// WorkBuddy AI deliberately has no daily time-slot schedule or in-flight
// clock-boundary switching. Its persisted provider settings are limited to the
// ordinary knobs that make sense across providers: CLI path, default model,
// rate-limit fallback, permission mode and reasoning effort.
import fs from "node:fs";
import path from "node:path";
import { assertInside, atomicWriteFile } from "../jobs/store";
import { EFFORT_LEVELS } from "../providers/command-code/capability";
import { MODEL_TOKEN_RE } from "../providers/command-code/argv";
import { describeCommandCodeCliSource } from "../providers/command-code/discovery";
import {
  createWorkBuddyAiAdapter,
  readWorkBuddyAiPresentation,
  readWorkBuddyAiProductSnapshot,
  workBuddyAiProfileEnv
} from "../providers/workbuddy-ai/index";
import {
  applyWorkBuddyAiEffortFallback,
  type WorkBuddyAiEffortFallbackDeps,
  type WorkBuddyAiReasoningMeta
} from "../providers/workbuddy-ai/effort";
import type { ModelDiagnostic } from "./select";
import type { ProviderAdapter } from "../providers/provider";
import {
  ConfigError,
  defaultConfig,
  loadConfigResult,
  type CrewDispatchConfig,
  type LoadConfigResult
} from "./schema";

export const WORKBUDDY_AI_CONFIG_VERSION = 1;
export const WORKBUDDY_AI_PERMISSION_MODES = [
  "default",
  "plan",
  "accept-edits",
  "yolo",
  "dont-ask",
  "auto",
  // WorkBuddy AI's native Full Access mode (CLI token `fullAccess`): skips ALL
  // permission checks, including dangerous commands, for every agent. It is a
  // distinct native mode from `yolo`/`bypassPermissions`, which only skips the
  // ordinary prompts. Exposed as a plain Permission choice — no extra flag is
  // added and it is the product default.
  "full-access"
] as const;

export interface WorkBuddyAiConfig {
  configVersion: number;
  cliPath: string | null;
  defaultModel: string | null;
  rateLimitFallbackModel: string | null;
  permissionMode: string;
  /** Effort for the default model; null = the model's own provider default. */
  defaultEffort: string | null;
  /** Effort for the rate-limit fallback model; null = that model's own default. */
  rateLimitFallbackEffort: string | null;
}

export interface WorkBuddyAiConfigView {
  cli_path: string | null;
  default_model: string | null;
  rate_limit_fallback_model: string | null;
  permission_mode: string;
  default_effort: string | null;
  rate_limit_fallback_effort: string | null;
}

export interface LoadWorkBuddyAiConfigResult {
  ok: boolean;
  present: boolean;
  config: WorkBuddyAiConfig;
  error: ConfigError | null;
  rawText: string | null;
}

export interface WorkBuddyAiSettingsView {
  ok: true;
  config_version: number;
  config_present: boolean;
  config: WorkBuddyAiConfigView;
  cli: {
    available: boolean;
    path: string | null;
    source: string;
    source_label: string;
    version: string | null;
    error: string | null;
  };
  catalog: {
    available: boolean;
    source: string;
    reliable: boolean;
    count: number;
    models: string[];
    default_model: string | null;
    refreshed_at: string | null;
    error: string | null;
  };
  /** App-facing subset of catalog.models used by dropdowns. */
  offered_models: string[];
  /**
   * Display-only App metadata; never used for routing. `reasoning` carries the
   * model's published effort evidence (supported list + Official App default +
   * provenance), including the DS-only Command Code fallback list.
   */
  model_meta: Record<string, {
    label: string;
    credits: string | null;
    free?: boolean;
    description_en?: string | null;
    description_zh?: string | null;
    reasoning?: WorkBuddyAiReasoningMeta | null;
  }>;
  /** Earliest future provider promotion boundary that can change Free-now display. */
  promotion_next_boundary_at: string | null;
  capabilities: { supports_effort: boolean; permission_modes: string[] };
  effective: { model: string | null; source: string; at: string };
  diagnostics: ModelDiagnostic[];
  features: {
    rate_limit_fallback_active: boolean;
    time_scheduling_active: false;
    note: string;
  };
}

export type ReadWorkBuddyAiSettingsResult =
  | { ok: true; view: WorkBuddyAiSettingsView }
  | { ok: false; code: string; message: string; field: string | null; raw: string | null };

/** The WorkBuddy AI product default permission mode (full-access: skips interactive permission checks). */
export const DEFAULT_WORKBUDDY_AI_PERMISSION_MODE = "full-access";

export function defaultWorkBuddyAiConfig(): WorkBuddyAiConfig {
  return {
    configVersion: WORKBUDDY_AI_CONFIG_VERSION,
    cliPath: null,
    defaultModel: "deepseek-v4.1-flash",
    rateLimitFallbackModel: "hy3",
    permissionMode: DEFAULT_WORKBUDDY_AI_PERMISSION_MODE,
    defaultEffort: null,
    rateLimitFallbackEffort: null
  };
}

const KEYS = new Set([
  "configVersion",
  "cliPath",
  "defaultModel",
  "rateLimitFallbackModel",
  "permissionMode",
  "defaultEffort",
  "rateLimitFallbackEffort"
]);
const SNAKE_TO_CAMEL: ReadonlyArray<readonly [string, keyof WorkBuddyAiConfig]> = [
  ["cli_path", "cliPath"],
  ["default_model", "defaultModel"],
  ["rate_limit_fallback_model", "rateLimitFallbackModel"],
  ["permission_mode", "permissionMode"],
  ["default_effort", "defaultEffort"],
  ["rate_limit_fallback_effort", "rateLimitFallbackEffort"]
];
const SNAKE_KEYS = new Set(SNAKE_TO_CAMEL.map(([k]) => k));

function nullableModel(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConfigError("config_invalid_type", field + " must be a string or null.", field);
  const v = value.trim();
  if (!v) return null;
  if (!MODEL_TOKEN_RE.test(v)) throw new ConfigError("config_invalid_model", field + " is not a valid model ID.", field);
  return v;
}

export function validateWorkBuddyAiConfig(raw: unknown): WorkBuddyAiConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config_invalid_type", "WorkBuddy AI configuration must be a JSON object.", null);
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!KEYS.has(key)) throw new ConfigError("config_unknown_field", "Unknown WorkBuddy AI configuration field: " + key + ".", key);
  }

  if (r.configVersion !== undefined) {
    if (typeof r.configVersion !== "number" || !Number.isInteger(r.configVersion) || r.configVersion < 0) {
      throw new ConfigError("config_invalid_type", "configVersion must be a non-negative integer.", "configVersion");
    }
    if (r.configVersion > WORKBUDDY_AI_CONFIG_VERSION) {
      throw new ConfigError(
        "config_version_too_new",
        "WorkBuddy AI configuration version " + r.configVersion + " is newer than this build supports (" + WORKBUDDY_AI_CONFIG_VERSION + ").",
        "configVersion"
      );
    }
  }

  let cliPath: string | null = null;
  if (r.cliPath !== undefined && r.cliPath !== null) {
    if (typeof r.cliPath !== "string") throw new ConfigError("config_invalid_type", "cliPath must be a string or null.", "cliPath");
    const v = r.cliPath.trim();
    if (v) {
      if (/[\0\r\n]/.test(v)) throw new ConfigError("config_invalid_cli_path", "cliPath must not contain control characters.", "cliPath");
      if (!path.isAbsolute(v)) throw new ConfigError("config_invalid_cli_path", "cliPath must be an absolute path.", "cliPath");
      cliPath = v;
    }
  }

  const defaultModel = nullableModel(r.defaultModel, "defaultModel");
  const fallback = nullableModel(r.rateLimitFallbackModel, "rateLimitFallbackModel");

  let permissionMode = DEFAULT_WORKBUDDY_AI_PERMISSION_MODE;
  if (r.permissionMode !== undefined && r.permissionMode !== null) {
    if (typeof r.permissionMode !== "string") throw new ConfigError("config_invalid_type", "permissionMode must be a string.", "permissionMode");
    const v = r.permissionMode.trim().toLowerCase();
    if (!(WORKBUDDY_AI_PERMISSION_MODES as readonly string[]).includes(v)) {
      throw new ConfigError("config_invalid_permission", "Unsupported WorkBuddy AI permissionMode: " + JSON.stringify(r.permissionMode) + ".", "permissionMode");
    }
    permissionMode = v;
  }

  const defaultEffort = nullableEffort(r.defaultEffort, "defaultEffort");
  const rateLimitFallbackEffort = nullableEffort(r.rateLimitFallbackEffort, "rateLimitFallbackEffort");

  return {
    configVersion: WORKBUDDY_AI_CONFIG_VERSION,
    cliPath,
    defaultModel,
    rateLimitFallbackModel: fallback,
    permissionMode,
    defaultEffort,
    rateLimitFallbackEffort
  };
}

/** One effort setting: blank/null = the model's own provider default. */
function nullableEffort(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ConfigError("config_invalid_type", field + " must be a string or null.", field);
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (!EFFORT_LEVELS.includes(v)) {
    throw new ConfigError("config_invalid_effort", "Unsupported WorkBuddy AI " + field + ": " + JSON.stringify(value) + ".", field);
  }
  return v;
}

export function workBuddyAiConfigPath(root: string): string {
  return path.join(root, "providers", "workbuddy-ai.json");
}

export function loadWorkBuddyAiConfigResult(root: string): LoadWorkBuddyAiConfigResult {
  const file = workBuddyAiConfigPath(root);
  assertInside(root, file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, present: false, config: defaultWorkBuddyAiConfig(), error: null, rawText: null };
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
      config: defaultWorkBuddyAiConfig(),
      error: new ConfigError("config_corrupt", "WorkBuddy AI configuration file is not valid JSON: " + file, null),
      rawText: text
    };
  }
  try {
    return { ok: true, present: true, config: validateWorkBuddyAiConfig(raw), error: null, rawText: text };
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, present: true, config: defaultWorkBuddyAiConfig(), error: e, rawText: text };
    throw e;
  }
}

export function workBuddyAiConfigPatchFromSnake(input: unknown): Record<string, unknown> {
  const a = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  for (const key of Object.keys(a)) {
    if (!SNAKE_KEYS.has(key)) throw new ConfigError("config_unknown_field", "Unknown WorkBuddy AI configuration field: " + key + ".", key);
  }
  const patch: Record<string, unknown> = {};
  for (const [snake, camel] of SNAKE_TO_CAMEL) {
    if (Object.prototype.hasOwnProperty.call(a, snake)) patch[camel] = a[snake];
  }
  return patch;
}

export function updateWorkBuddyAiConfig(root: string, patch: unknown): { config: WorkBuddyAiConfig } {
  const current = loadWorkBuddyAiConfigResult(root);
  if (!current.ok) throw current.error ?? new ConfigError("config_corrupt", "The WorkBuddy AI configuration cannot be read.", null);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ConfigError("config_invalid_type", "A configuration update must be a JSON object.", null);
  const p = patch as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!KEYS.has(key)) throw new ConfigError("config_unknown_field", "Unknown WorkBuddy AI configuration field: " + key + ".", key);
  }
  // A selection's MODEL change resets ONLY that selection's effort to the
  // provider default, unless the SAME patch explicitly supplies a replacement.
  const own = (key: string): boolean => Object.prototype.hasOwnProperty.call(p, key);
  const norm = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const merged: Record<string, unknown> = { ...current.config, ...p };
  if (own("defaultModel") && norm(p.defaultModel) !== norm(current.config.defaultModel) && !own("defaultEffort")) {
    merged.defaultEffort = null;
  }
  if (own("rateLimitFallbackModel") && norm(p.rateLimitFallbackModel) !== norm(current.config.rateLimitFallbackModel) && !own("rateLimitFallbackEffort")) {
    merged.rateLimitFallbackEffort = null;
  }
  const config = validateWorkBuddyAiConfig(merged);
  const file = workBuddyAiConfigPath(root);
  assertInside(root, file);
  atomicWriteFile(file, JSON.stringify(config, null, 2));
  return { config };
}

export function workBuddyAiConfigView(config: WorkBuddyAiConfig): WorkBuddyAiConfigView {
  return {
    cli_path: config.cliPath,
    default_model: config.defaultModel,
    rate_limit_fallback_model: config.rateLimitFallbackModel,
    permission_mode: config.permissionMode,
    default_effort: config.defaultEffort,
    rate_limit_fallback_effort: config.rateLimitFallbackEffort
  };
}

export function workBuddyAiRuntimeConfig(config: WorkBuddyAiConfig): CrewDispatchConfig {
  return {
    ...defaultConfig(),
    cliPath: config.cliPath,
    defaultModel: config.defaultModel,
    rateLimitFallbackModel: config.rateLimitFallbackModel,
    permissionMode: config.permissionMode,
    defaultEffort: config.defaultEffort,
    rateLimitFallbackEffort: config.rateLimitFallbackEffort,
    timeSlots: [],
    inFlightSwitch: false
  };
}

export function loadWorkBuddyAiRuntimeConfigResult(root: string): LoadConfigResult {
  const loaded = loadWorkBuddyAiConfigResult(root);
  return {
    ok: loaded.ok,
    present: loaded.present,
    config: loaded.ok ? workBuddyAiRuntimeConfig(loaded.config) : defaultConfig(),
    error: loaded.error,
    rawText: loaded.rawText
  };
}

export interface ReadWorkBuddyAiSettingsDeps {
  /** Injectable provider adapter (tests). Defaults to the production WorkBuddy adapter. */
  adapter?: ProviderAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Test seam: the DS-only Command Code fallback evidence readers (the installed
   * catalog read + the local CLI resolution). Production uses the real bounded
   * local reads; no process and no network is ever involved.
   */
  effortFallback?: WorkBuddyAiEffortFallbackDeps;
}

export async function readWorkBuddyAiSettings(
  root: string,
  deps: ReadWorkBuddyAiSettingsDeps = {}
): Promise<ReadWorkBuddyAiSettingsResult> {
  const cfg = loadWorkBuddyAiConfigResult(root);
  if (!cfg.ok) {
    return {
      ok: false,
      code: cfg.error?.code ?? "config_invalid",
      message: cfg.error?.message ?? "Invalid WorkBuddy AI configuration.",
      field: cfg.error?.field ?? null,
      raw: cfg.rawText
    };
  }

  const env = workBuddyAiProfileEnv(deps.env ?? process.env);
  const now = (deps.now ?? (() => new Date()))();
  const adapter = deps.adapter ?? createWorkBuddyAiAdapter();
  const resolution = adapter.resolveCli(cfg.config.cliPath ? { configPath: cfg.config.cliPath, env } : { env });
  const cli = {
    available: false,
    path: null as string | null,
    source: resolution.source,
    source_label: describeCommandCodeCliSource(resolution.source),
    version: null as string | null,
    error: resolution.ok ? null : resolution.reason ?? "The WorkBuddy AI CLI is unavailable."
  };
  const catalog: WorkBuddyAiSettingsView["catalog"] = {
    available: false,
    source: "unavailable",
    reliable: false,
    count: 0,
    models: [] as string[],
    default_model: null as string | null,
    refreshed_at: null as string | null,
    error: cli.error ?? "The WorkBuddy AI model catalog was not read."
  };
  let capabilities = { supports_effort: false, permission_modes: [] as string[] };
  let offeredModels: string[] = [];
  let modelMeta: WorkBuddyAiSettingsView["model_meta"] = {};
  let promotionNextBoundaryAt: string | null = null;

  if (resolution.ok && resolution.path) {
    const probeInput = { cliPath: resolution.path, env };
    const caps = await adapter.probeCapabilities(probeInput);
    const cat = await adapter.readModelCatalog(probeInput);
    cli.available = true;
    cli.path = resolution.path;
    cli.version = caps.version;
    cli.error = caps.ok ? null : caps.errors.join("; ") || "Capability probe failed.";
    capabilities = { supports_effort: caps.supportsEffort, permission_modes: caps.permissionModes };
    catalog.available = cat.ok;
    catalog.source = cat.source;
    catalog.reliable = cat.ok && (cat.source === "workbuddy-product-snapshot" || cat.source === "cli-control-models" || cat.source === "cli-list-models" || cat.source === "cli-help-models");
    catalog.count = cat.ok ? cat.models.length : 0;
    catalog.models = cat.ok ? cat.models : [];
    catalog.default_model = cat.defaultModel;
    catalog.refreshed_at = cat.ok ? now.toISOString() : null;
    catalog.error = cat.error;
    if (cat.ok) {
      // A successful live get_available_models read is the authoritative set of
      // CURRENT selectable ids. Enrich those ids with the provider-owned product
      // snapshot's promotion/reasoning metadata when available, without letting
      // the older cache shrink or replace the live list.
      const snapshot = cat.source === "cli-control-models" ? readWorkBuddyAiProductSnapshot(env) : null;
      const presentation = readWorkBuddyAiPresentation(resolution.path, cat.models, snapshot?.raw ?? cat.raw, now);
      offeredModels = presentation.offeredModels;
      modelMeta = presentation.modelMeta;
      // DS-ONLY effort fallback: when the Official App snapshot publishes a
      // default effort for the DeepSeek fallback model but no supported list,
      // the SAME model id's list in the locally installed Command Code catalog
      // is added as fallback evidence. Pure local reads; no process/network.
      // Every other model keeps exactly the Official App evidence.
      const ccConfig = loadConfigResult(root);
      applyWorkBuddyAiEffortFallback(modelMeta, {
        ...(deps.effortFallback ?? {}),
        configPath: deps.effortFallback?.configPath ?? (ccConfig.ok ? ccConfig.config.cliPath : null),
        env: deps.effortFallback?.env ?? env
      });
      promotionNextBoundaryAt = presentation.nextPromotionBoundaryAt;
      if (presentation.error) {
        catalog.error = catalog.error ? catalog.error + "; " + presentation.error : presentation.error;
      }
    }
  }

  const diagnostics: ModelDiagnostic[] = [];
  const known = new Set(catalog.models);
  const check = (field: string, value: string | null): void => {
    if (!value) return;
    if (!catalog.reliable) {
      diagnostics.push({
        field,
        value,
        code: "catalog_unavailable",
        message: "The WorkBuddy AI CLI model catalog is unavailable, so this configured model cannot be verified."
      });
    } else if (!known.has(value)) {
      diagnostics.push({
        field,
        value,
        code: "model_stale",
        message: "Configured model " + value + " is not in the WorkBuddy AI CLI's current published model catalog."
      });
    }
  };
  check("defaultModel", cfg.config.defaultModel);
  check("rateLimitFallbackModel", cfg.config.rateLimitFallbackModel);

  const defaultVerified =
    !!cfg.config.defaultModel &&
    catalog.reliable &&
    known.has(cfg.config.defaultModel);
  const catalogDefaultVerified =
    !cfg.config.defaultModel &&
    !!catalog.default_model &&
    catalog.reliable &&
    known.has(catalog.default_model);

  return {
    ok: true,
    view: {
      ok: true,
      config_version: cfg.config.configVersion,
      config_present: cfg.present,
      config: workBuddyAiConfigView(cfg.config),
      cli,
      catalog,
      offered_models: offeredModels.length ? offeredModels : [...catalog.models],
      model_meta: modelMeta,
      promotion_next_boundary_at: promotionNextBoundaryAt,
      capabilities,
      effective: {
        model: defaultVerified ? cfg.config.defaultModel : catalogDefaultVerified ? catalog.default_model : null,
        source: defaultVerified ? "config-default" : catalogDefaultVerified ? "cli-default" : "none",
        at: now.toISOString()
      },
      diagnostics,
      features: {
        rate_limit_fallback_active: true,
        time_scheduling_active: false,
        note: "WorkBuddy AI uses a normal default model plus an optional rate-limit fallback. Time-of-day schedules and automatic clock-boundary model switching are intentionally disabled for this provider."
      }
    }
  };
}
