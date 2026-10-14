// settings-fixtures.ts — realistic provider settings views for the settings
// read-path and browser tests. The shapes mirror exactly what the real probe
// paths produce, so the shared read path, the Hub routes and the browser client
// all operate on production-shaped payloads without touching a real CLI.
import type { SettingsView } from "../../config/settings";
import type { WorkBuddyAiSettingsView } from "../../config/workbuddy-ai";

export function commandCodeSettingsView(options: {
  models?: string[];
  freeModels?: string[];
  defaultModel?: string | null;
  /** Extra display metadata for ids outside `models` (e.g. a configured current model). */
  extraMeta?: Record<string, { free?: boolean; efforts?: string[] }>;
} = {}): SettingsView {
  const models = options.models ?? ["cc/model-a", "cc/model-b"];
  const free = new Set(options.freeModels ?? []);
  const defaultModel = options.defaultModel ?? models[0] ?? null;
  return {
    ok: true,
    config_version: 1,
    config_present: true,
    config: {
      cli_path: null,
      default_model: defaultModel,
      rate_limit_fallback_model: null,
      permission_mode: "yolo",
      default_effort: null,
      rate_limit_fallback_effort: null,
      time_slots: [],
      in_flight_switch: false
    },
    cli: {
      available: true,
      path: process.platform === "win32" ? "C:\\fake\\cmdc.cmd" : "/fake/cmdc",
      source: "config-path",
      source_label: "configured path",
      version: "9.9.9-fake",
      error: null
    },
    catalog: {
      available: true,
      source: "cli-list-models",
      reliable: true,
      count: models.length,
      models: [...models],
      default_model: models[0] ?? null,
      refreshed_at: new Date().toISOString(),
      error: null
    },
    model_meta: {
      ...Object.fromEntries(models.map((id) => [id, { free: free.has(id) }])),
      ...(options.extraMeta ?? {})
    },
    // This fixture models a COMPLETE read, so its capability evidence is checked.
    capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
    effective: { model: defaultModel, source: "config-default", slot_index: null, at: new Date().toISOString() },
    diagnostics: [],
    features: {
      rate_limit_fallback_active: true,
      in_flight_switch_active: false,
      note: "test fixture"
    }
  };
}

export function workBuddyAiSettingsView(options: {
  models?: string[];
  offeredModels?: string[];
  meta?: Record<string, { label?: string; credits?: string | null; free?: boolean; reasoning?: WorkBuddyAiSettingsView["model_meta"][string]["reasoning"] }>;
  nextPromotionBoundaryAt?: string | null;
  defaultModel?: string | null;
  /** The persisted DEFAULT-model reasoning effort (e.g. the saved `max`). */
  effort?: string | null;
  /** The persisted RATE-LIMIT-FALLBACK-model reasoning effort (independent). */
  fallbackEffort?: string | null;
} = {}): WorkBuddyAiSettingsView {
  const models = options.models ?? ["deepseek-v4.1-flash", "hy3"];
  const meta: WorkBuddyAiSettingsView["model_meta"] = {};
  for (const id of models) {
    const source = options.meta?.[id];
    meta[id] = {
      label: source?.label ?? id,
      credits: source?.credits ?? null,
      free: source?.free,
      reasoning: source?.reasoning ?? null
    };
  }
  const defaultModel = options.defaultModel ?? models[0] ?? null;
  return {
    ok: true,
    config_version: 1,
    config_present: true,
    config: {
      cli_path: null,
      default_model: defaultModel,
      rate_limit_fallback_model: models[1] ?? null,
      permission_mode: "yolo",
      default_effort: options.effort ?? null,
      rate_limit_fallback_effort: options.fallbackEffort ?? null
    },
    cli: {
      available: true,
      path: process.platform === "win32" ? "C:\\fake\\wb\\codebuddy.exe" : "/fake/wb/codebuddy",
      source: "config-path",
      source_label: "configured path",
      version: "9.9.9-fake",
      error: null
    },
    catalog: {
      available: true,
      source: "workbuddy-product-snapshot",
      reliable: true,
      count: models.length,
      models: [...models],
      default_model: null,
      refreshed_at: new Date().toISOString(),
      error: null
    },
    offered_models: [...(options.offeredModels ?? models)],
    model_meta: meta,
    promotion_next_boundary_at: options.nextPromotionBoundaryAt ?? null,
    capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo", "auto"] },
    effective: { model: defaultModel, source: "config-default", at: new Date().toISOString() },
    diagnostics: [],
    features: {
      rate_limit_fallback_active: true,
      time_scheduling_active: false,
      note: "test fixture"
    }
  };
}
