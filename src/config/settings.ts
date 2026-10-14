// settings.ts — the READ view of CrewDispatch's configuration.
//
// It answers, from the built artifact: what is configured, whether the official
// CLI is available and how it was found, where the model catalog came from and
// when it was read, which model is EFFECTIVE right now (and which slot matched),
// and which configured model ids are stale.
//
// TWO SEPARATE EVIDENCE PHASES (Command Code):
//   1. the CATALOG phase — read from the CURRENTLY INSTALLED package's own
//      shipped model reference (`…/command-code-knowledge/reference/models.md`,
//      discovered from the resolved CLI executable). That is a bounded local
//      file read: no process, no network, no cache. It is what makes the
//      Settings model dropdown and the Command Code Free-now labels available
//      promptly, without waiting for `cmdc --list-models`. For Command Code,
//      "free" therefore means free according to the installed version's own
//      shipped metadata — not a live billing guarantee.
//   2. the CAPABILITY phase — `--version` / `--help` (and, only when the
//      installed reference was unusable, the CLI's own public `--list-models`
//      fallback). This is the only part that needs the CLI process, so it is
//      bounded on its own settings budget AND served as a SEPARATE later read.
//
// The two phases are separate READS, not a cache: every Settings open/provider
// switch still performs a real read of both, and nothing is ever replayed from
// an earlier read. Splitting them is what stops a cold or hung CLI from holding
// the model dropdown hostage: the catalog phase never spawns a process, so it
// answers in milliseconds regardless of how long `--version`/`--help` take.
// While the capability phase has not answered, permission modes / reasoning
// effort are reported as NOT CHECKED (`capabilities.checked === false`) — an
// honest "unknown", never a fabricated mode/effort and never a claim that the
// CLI lacks them.
//
// Only PUBLIC read-only CLI commands are ever run (`--version`, `--help`,
// `--list-models` fallback); no prompt, no credential, no other product's data.
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { describeCommandCodeCliSource } from "../providers/command-code/discovery";
import { readInstalledModelCatalog, type InstalledCatalogRead } from "../providers/command-code/local-catalog";
import type { CapabilityProbeResult, ProviderAdapter } from "../providers/provider";
import { configView, loadConfigResult, type ConfigView } from "./schema";
import { isReliableConfigCatalogSource, selectModel, type CatalogSource, type ModelDiagnostic } from "./select";

/**
 * Bound on ONE Settings capability probe (`--version` / `--help`). The CLI's
 * own probe module keeps its wider standalone bounds for the run path; the
 * Settings read only needs enough evidence to present permission modes and
 * effort, and must never hold the model list hostage to a slow CLI.
 */
export const SETTINGS_CAPABILITY_PROBE_TIMEOUT_MS = 10_000;
/**
 * Total bound on the Settings capability evidence step. When it is exhausted the
 * catalog is still served and the capability fields are reported as unconfirmed.
 */
export const SETTINGS_CAPABILITY_BUDGET_MS = 20_000;

/**
 * Which evidence a Settings read performs.
 *
 * - `"catalog"` — ONLY the process-free evidence: the config, the CLI
 *   resolution, the installed package's own shipped model reference and the
 *   effective model. It never spawns the CLI, so it returns promptly even when
 *   `--version` / `--help` hang. Capability fields are reported as NOT CHECKED.
 * - `"full"` — catalog AND capability evidence in one response. The default,
 *   so every existing caller (MCP, embedding, the real-CLI acceptance) keeps
 *   the complete view it has always had.
 */
export type SettingsReadPhase = "catalog" | "full";

export interface SettingsDeps {
  /** Injectable provider adapter (tests). Defaults to the accepted Command Code adapter. */
  adapter?: ProviderAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Test/ops seam: total bound on the capability evidence step (defaults to
   * `SETTINGS_CAPABILITY_BUDGET_MS`). It never bounds the local catalog read.
   */
  capabilityBudgetMs?: number;
  /** Test seam: the installed-package reader (defaults to the real local reader). */
  readInstalledCatalog?: (cliPath: string) => InstalledCatalogRead;
  /** Which evidence this read performs (default `"full"`). */
  phase?: SettingsReadPhase;
}

export interface SettingsCliView {
  available: boolean;
  path: string | null;
  source: string;
  source_label: string;
  version: string | null;
  error: string | null;
}

export interface SettingsCatalogView {
  available: boolean;
  source: CatalogSource;
  /**
   * True when the model ids are proven by the installed Command Code package's
   * own shipped reference, or by the CLI's own public catalog (fallback). Never
   * true for an invented list.
   */
  reliable: boolean;
  count: number;
  /**
   * The ordered model ids the installed Command Code package (or, as a
   * fallback, the CLI's own `--list-models`) published (empty when the catalog
   * is unavailable — a dropdown must never be filled from a fabricated list).
   */
  models: string[];
  default_model: string | null;
  /** ISO time the catalog was actually read, or null when it was NOT refreshed. */
  refreshed_at: string | null;
  error: string | null;
}

export interface SettingsEffectiveView {
  model: string | null;
  source: string;
  slot_index: number | null;
  at: string;
}

export interface SettingsFeatures {
  /** True: a clear model rate limit (exit 5) advances the configured candidate chain. */
  rate_limit_fallback_active: boolean;
  /** True: a running job is moved to the new model at a configured time-slot boundary. */
  in_flight_switch_active: boolean;
  note: string;
}

export interface SettingsView {
  ok: true;
  config_version: number;
  config_present: boolean;
  config: ConfigView;
  cli: SettingsCliView;
  catalog: SettingsCatalogView;
  /**
   * Display-only metadata proven by Command Code's own public model catalog and
   * by the installed package's own shipped reference. `efforts` is the model's
   * OWN published reasoning-effort list (absent = the reference published none
   * for that model: "unknown", never "supports nothing"), read from the SAME
   * installed-package file this phase already reads — no extra process or read.
   */
  model_meta: Record<string, { free?: boolean; efforts?: string[] }>;
  /**
   * `checked` is false when the capability phase has not answered yet (the
   * catalog-phase read). An unchecked result carries `supports_effort:false` /
   * `permission_modes:[]` as PLACEHOLDERS, not as evidence: consumers must
   * present "not checked yet", never "the CLI lacks these".
   */
  capabilities: { supports_effort: boolean; permission_modes: string[]; checked: boolean };
  effective: SettingsEffectiveView;
  diagnostics: ModelDiagnostic[];
  features: SettingsFeatures;
}

export type ReadSettingsResult =
  | { ok: true; view: SettingsView }
  | { ok: false; code: string; message: string; field: string | null; raw: string | null };

const FEATURES: SettingsFeatures = {
  rate_limit_fallback_active: true,
  in_flight_switch_active: false,
  note:
    "rate-limit fallback is active: at task start the primary model is chosen in the order explicit model > configured default model > CLI catalog default, " +
    "and a deduplicated candidate chain is built as primary → configured default model → configured final fallback; only when the official CLI ends with exit code 5 (model rate limit) " +
    "does the next candidate continue on the same job / same session with a fixed internal recovery prompt (each candidate at most once, no loops). " +
    "Time-of-day model schedules and in-flight clock-boundary model switching are currently disabled for every provider."
};

/**
 * Read the settings view for a data root. A present-but-invalid config file is
 * reported with its stable error code (and never rewritten); a missing CLI or
 * catalog is reported as an honest unavailable state.
 */
export async function readSettings(root: string, deps: SettingsDeps = {}): Promise<ReadSettingsResult> {
  const cfg = loadConfigResult(root);
  if (!cfg.ok) {
    return {
      ok: false,
      code: cfg.error?.code ?? "config_invalid",
      message: cfg.error?.message ?? "Invalid configuration.",
      field: cfg.error?.field ?? null,
      raw: cfg.rawText
    };
  }
  const config = cfg.config;
  // Time-of-day routing is retained only as legacy persisted data for backward
  // compatibility. It is not a current product feature for any provider.
  const runtimeConfig = { ...config, timeSlots: [], inFlightSwitch: false };
  const adapter = deps.adapter ?? createCommandCodeAdapter();
  const env = deps.env ?? process.env;
  // The "effective model right now" is evaluated against the same instant the
  // worker uses: an explicit seam, else the TEST-ONLY `JOBQUAY_TEST_NOW` env
  // value, else the real local clock.
  const envNowRaw = typeof env.JOBQUAY_TEST_NOW === "string" ? env.JOBQUAY_TEST_NOW.trim() : "";
  const envNowMs = envNowRaw ? Date.parse(envNowRaw) : Number.NaN;
  const envShiftRaw = typeof env.JOBQUAY_TEST_NOW_SHIFT_MS === "string" ? env.JOBQUAY_TEST_NOW_SHIFT_MS.trim() : "";
  const envShiftMs = envShiftRaw ? Number(envShiftRaw) : Number.NaN;
  const nowFn =
    deps.now ??
    (Number.isFinite(envNowMs)
      ? () => new Date(envNowMs)
      : Number.isFinite(envShiftMs)
        ? () => new Date(Date.now() + envShiftMs)
        : () => new Date());
  const now = nowFn();

  const resolution = adapter.resolveCli(runtimeConfig.cliPath ? { configPath: runtimeConfig.cliPath, env } : { env });
  const cli: SettingsCliView = {
    available: false,
    path: null,
    source: resolution.source,
    source_label: describeCommandCodeCliSource(resolution.source),
    version: null,
    error: resolution.ok ? null : resolution.reason ?? "The official Command Code CLI is unavailable."
  };
  let catalogModels: string[] = [];
  const catalog: SettingsCatalogView = {
    available: false,
    source: "unavailable",
    reliable: false,
    count: 0,
    models: [],
    default_model: null,
    // NOT refreshed: the CLI/catalog was unavailable, so no read happened.
    refreshed_at: null,
    error: cli.error ?? "The official Command Code CLI is unavailable; the model catalog was not read."
  };
  const phase: SettingsReadPhase = deps.phase ?? "full";
  let capabilities: { supports_effort: boolean; permission_modes: string[]; checked: boolean } = {
    supports_effort: false,
    permission_modes: [],
    checked: false
  };
  let modelMeta: SettingsView["model_meta"] = {};

  if (resolution.ok && resolution.path) {
    cli.available = true;
    cli.path = resolution.path;

    // (1) The installed package's OWN shipped model reference. A bounded local
    // file read, performed BEFORE any process starts, so the model dropdown and
    // the Command Code Free-now labels never depend on the CLI probe chain.
    const readInstalled = deps.readInstalledCatalog ?? readInstalledModelCatalog;
    const installed = readInstalled(resolution.path);
    if (installed.ok) {
      const free = new Set(installed.catalog.freeModels);
      const rated = new Set(installed.catalog.ratedModels);
      catalogModels = [...installed.catalog.models];
      catalog.available = true;
      catalog.source = "installed-package-reference";
      catalog.reliable = true;
      catalog.count = catalogModels.length;
      catalog.models = catalogModels;
      // The shipped reference publishes ids and rates, not a default model.
      catalog.default_model = null;
      catalog.refreshed_at = now.toISOString();
      catalog.error = null;
      modelMeta = Object.fromEntries(
        catalogModels.map((id) => {
          const efforts = installed.catalog.effortsByModel[id];
          return [
            id,
            {
              ...(free.has(id) ? { free: true } : rated.has(id) ? { free: false } : {}),
              // The row's OWN published effort list, when it publishes one. An
              // absent list is "unknown" and is deliberately not defaulted to
              // anything — the Reasoning dropdown must never invent levels.
              ...(efforts && efforts.length ? { efforts: [...efforts] } : {})
            }
          ];
        })
      );
    }

    if (!installed.ok) {
      // The catalog phase publishes no invented list; it says exactly what is
      // missing and that the CLI's own fallback is checked separately.
      catalog.error =
        phase === "catalog"
          ? "The installed Command Code package's shipped model reference could not be read; the CLI's own --list-models fallback is checked in a separate later read."
          : catalog.error;
    }

    if (phase === "full") {
      // (2) Capability evidence (`--version` / `--help`) — the ONLY part that
      // needs the CLI process. Bounded on its own settings budget.
      const budgetMs = Number.isFinite(deps.capabilityBudgetMs) && (deps.capabilityBudgetMs as number) > 0
        ? (deps.capabilityBudgetMs as number)
        : SETTINGS_CAPABILITY_BUDGET_MS;
      const caps = await probeCapabilitiesWithinBudget(
        adapter,
        { cliPath: resolution.path, env, timeoutMs: SETTINGS_CAPABILITY_PROBE_TIMEOUT_MS },
        budgetMs
      );
      cli.version = caps.version;
      cli.error = caps.ok ? null : caps.errors.join("; ") || "Capability probe failed.";
      capabilities = { supports_effort: caps.supportsEffort, permission_modes: caps.permissionModes, checked: true };

      // (3) Fallback ONLY when the installed reference could not be used: the
      // CLI's own public `--list-models` remains the catalog source (its own
      // wider bound). It is never required for the normal path.
      if (!installed.ok) {
        const cat = await adapter.readModelCatalog({ cliPath: resolution.path, env });
        catalogModels = cat.models;
        catalog.available = cat.ok;
        catalog.source = cat.source;
        catalog.reliable = cat.ok && isReliableConfigCatalogSource(cat.source);
        catalog.count = cat.ok ? cat.models.length : 0;
        catalog.models = cat.ok ? cat.models : [];
        catalog.default_model = cat.defaultModel;
        // A refresh time is reported ONLY when a catalog was actually published.
        catalog.refreshed_at = cat.ok ? now.toISOString() : null;
        catalog.error = cat.error;
        if (catalog.reliable) {
          const free = new Set(cat.freeModels ?? []);
          modelMeta = Object.fromEntries(cat.models.map((id) => [id, { free: free.has(id) }]));
        }
      }
    }
  }

  const selection = selectModel({
    explicitModel: null,
    config: runtimeConfig,
    now,
    catalog: {
      ok: catalog.available,
      source: catalog.available && isReliableConfigCatalogSource(catalog.source) ? catalog.source : "unavailable",
      models: catalogModels,
      defaultModel: catalog.default_model
    }
  });

  return {
    ok: true,
    view: {
      ok: true,
      config_version: config.configVersion,
      config_present: cfg.present,
      config: configView(runtimeConfig),
      cli,
      catalog,
      model_meta: modelMeta,
      capabilities,
      effective: { model: selection.model, source: selection.source, slot_index: selection.slotIndex, at: now.toISOString() },
      diagnostics: selection.diagnostics,
      features: FEATURES
    }
  };
}

/**
 * The CAPABILITY phase patch — everything a `phase:"catalog"` read deliberately
 * leaves out, produced by a SEPARATE later read of the same generation.
 */
export interface SettingsCapabilityPatch {
  cli: { available: boolean; version: string | null; error: string | null; checked: true };
  capabilities: { supports_effort: boolean; permission_modes: string[]; checked: true };
  /**
   * Present ONLY when the fast phase could not publish a catalog (the installed
   * package's shipped reference was unusable): the CLI's own `--list-models`
   * fallback catalog. Null means "the fast phase already published it" — this
   * phase never re-publishes or overrides an installed-package catalog.
   */
  catalog: SettingsCatalogView | null;
  /**
   * Present ONLY with a fallback `catalog` (the installed reference was
   * unusable), so it carries the CLI's own Free evidence and never a
   * per-model effort list — that evidence exists only in the installed
   * package's shipped reference.
   */
  model_meta: Record<string, { free?: boolean }> | null;
}

export type ReadSettingsCapabilitiesResult =
  | { ok: true; patch: SettingsCapabilityPatch }
  | { ok: false; code: string; message: string; field: string | null; raw: string | null };

/**
 * The CAPABILITY phase of the Settings read: `--version` / `--help` (plus the
 * CLI's own `--list-models` fallback catalog when the installed reference was
 * unusable). This is the ONLY Settings read that spawns the CLI, so it is the
 * only one that can be slow — which is exactly why it is served as its own
 * later request instead of being awaited by the catalog read.
 *
 * It is a real, always-fresh read: no earlier result is replayed, and the Hub
 * runs it through the same worker-backed, in-flight-deduped read path as the
 * catalog phase. A hung CLI yields an honest "unconfirmed" capability with the
 * reason attached — never a fabricated mode/effort.
 */
export async function readSettingsCapabilities(root: string, deps: SettingsDeps = {}): Promise<ReadSettingsCapabilitiesResult> {
  const cfg = loadConfigResult(root);
  if (!cfg.ok) {
    return {
      ok: false,
      code: cfg.error?.code ?? "config_invalid",
      message: cfg.error?.message ?? "Invalid configuration.",
      field: cfg.error?.field ?? null,
      raw: cfg.rawText
    };
  }
  const runtimeConfig = { ...cfg.config, timeSlots: [], inFlightSwitch: false };
  const adapter = deps.adapter ?? createCommandCodeAdapter();
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const resolution = adapter.resolveCli(runtimeConfig.cliPath ? { configPath: runtimeConfig.cliPath, env } : { env });

  if (!resolution.ok || !resolution.path) {
    return {
      ok: true,
      patch: {
        cli: {
          available: false,
          version: null,
          error: resolution.reason ?? "The official Command Code CLI is unavailable.",
          checked: true
        },
        capabilities: { supports_effort: false, permission_modes: [], checked: true },
        catalog: null,
        model_meta: null
      }
    };
  }

  const budgetMs = Number.isFinite(deps.capabilityBudgetMs) && (deps.capabilityBudgetMs as number) > 0
    ? (deps.capabilityBudgetMs as number)
    : SETTINGS_CAPABILITY_BUDGET_MS;
  const caps = await probeCapabilitiesWithinBudget(
    adapter,
    { cliPath: resolution.path, env, timeoutMs: SETTINGS_CAPABILITY_PROBE_TIMEOUT_MS },
    budgetMs
  );
  const patch: SettingsCapabilityPatch = {
    cli: {
      available: true,
      version: caps.version,
      error: caps.ok ? null : caps.errors.join("; ") || "Capability probe failed.",
      checked: true
    },
    capabilities: { supports_effort: caps.supportsEffort, permission_modes: caps.permissionModes, checked: true },
    catalog: null,
    model_meta: null
  };

  // The `--list-models` fallback belongs to THIS phase (it spawns the CLI), and
  // only when the fast phase had no installed-package catalog to publish.
  const readInstalled = deps.readInstalledCatalog ?? readInstalledModelCatalog;
  if (!readInstalled(resolution.path).ok) {
    const cat = await adapter.readModelCatalog({ cliPath: resolution.path, env });
    const models = cat.ok ? cat.models : [];
    const catalog: SettingsCatalogView = {
      available: cat.ok,
      source: cat.source,
      reliable: cat.ok && isReliableConfigCatalogSource(cat.source),
      count: cat.ok ? models.length : 0,
      models,
      default_model: cat.defaultModel,
      // A refresh time is reported ONLY when a catalog was actually published.
      refreshed_at: cat.ok ? now.toISOString() : null,
      error: cat.error
    };
    patch.catalog = catalog;
    if (catalog.reliable) {
      const free = new Set(cat.freeModels ?? []);
      patch.model_meta = Object.fromEntries(models.map((id) => [id, { free: free.has(id) }]));
    }
  }
  return { ok: true, patch };
}

/**
 * The bounded capability-evidence step. The probe's own spawn bounds already
 * cap a hung CLI; this budget additionally caps a probe implementation that
 * never settles, so a slow/unavailable capability probe can never withhold the
 * (already read) local model catalog. A budget hit or a rejection is reported
 * as an honest unconfirmed capability — never as a fabricated mode/effort.
 */
async function probeCapabilitiesWithinBudget(
  adapter: ProviderAdapter,
  input: { cliPath: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  budgetMs: number
): Promise<CapabilityProbeResult> {
  const unconfirmed = (reason: string): CapabilityProbeResult => ({
    ok: false,
    cliPath: input.cliPath,
    version: null,
    helpText: null,
    supportsEffort: false,
    permissionModes: [],
    errors: [reason]
  });
  let timer: NodeJS.Timeout | null = null;
  const budget = new Promise<CapabilityProbeResult>((resolve) => {
    // NOT unref'd: this bound is the only pending work when a probe hangs, so it
    // must keep the loop alive until it fires.
    timer = setTimeout(
      () => resolve(unconfirmed(`the capability probe did not answer within the ${budgetMs} ms settings budget; permission modes and reasoning effort stay unconfirmed`)),
      budgetMs
    );
  });
  try {
    return await Promise.race([adapter.probeCapabilities(input), budget]);
  } catch (error) {
    return unconfirmed(`capability probe failed: ${String((error as Error)?.message || error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
