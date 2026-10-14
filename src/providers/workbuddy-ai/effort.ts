// effort.ts — model-specific reasoning-effort evidence for WorkBuddy AI.
//
// WHERE THE EVIDENCE COMES FROM (every source is a LOCAL read; this module adds
// no WorkBuddy process and no network request):
//
//   1. The Official App product snapshot CrewDispatch already reads for this
//      provider. A model row may publish `reasoning.supportedEfforts`,
//      `reasoning.defaultEffort` and/or `reasoning.effort`. When the App
//      publishes an explicit supported list it is AUTHORITATIVE: nothing else is
//      consulted for that model.
//   2. ONE deliberate fallback, for the single DeepSeek model id below only:
//      when the App publishes a default effort but no supported list, the SAME
//      model id's published effort list in the currently installed Command Code
//      catalog is consulted as fallback evidence. This is NOT a general
//      cross-provider inference: no other model id, and no other provider,
//      ever contributes an effort list here.
//
// The evidence is used for two things only:
//   * the Settings Reasoning dropdown options/labels (display), and
//   * a pre-launch check that rejects an effort the model's own published
//     metadata does not support (before the Desktop bridge/runtime starts).
// Nothing is ever inferred from an id, a name or a sibling model.
import { resolveCommandCodeCli } from "../command-code/discovery";
import { readInstalledModelCatalog, type InstalledCatalogRead } from "../command-code/local-catalog";
import type { CliResolution } from "../provider";

/**
 * The ONE model id with a deliberate cross-provider effort fallback. WorkBuddy
 * and Command Code both name this same model; the installed Command Code
 * catalog publishes its effort list while the current Official App snapshot
 * publishes only its default effort.
 */
export const WORKBUDDY_AI_DEEPSEEK_EFFORT_FALLBACK_MODEL = "deepseek-v4.1-flash";

/** A conservative effort token (the providers' own vocabulary is lowercase). */
const EFFORT_TOKEN_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Model-specific reasoning metadata proven by the Official App snapshot, plus
 * the provenance needed to render honest option labels.
 */
export interface WorkBuddyAiReasoningMeta {
  /** The Official App's own default effort (`defaultEffort`, else `effort`), or null. */
  app_default_effort: string | null;
  /**
   * The final supported-effort options for this model, or null when no reliable
   * list is known. Values are raw effort tokens; labels are display-only.
   */
  supported_efforts: string[] | null;
  /** Which local source published `supported_efforts`; null when there is no list. */
  supported_efforts_source: "official-app" | "command-code" | null;
}

/** The structural part of a model's metadata this module reads/writes. */
export interface WorkBuddyAiEffortCarrier {
  reasoning?: WorkBuddyAiReasoningMeta | null;
}

export interface WorkBuddyAiEffortFallbackDeps {
  /** A Command Code CLI path already configured in CrewDispatch (preferred when known). */
  configPath?: string | null;
  /** Environment used for the bounded local Command Code CLI resolution. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: the installed-package catalog reader (defaults to the real local read). */
  readInstalledCatalog?: (cliPath: string) => InstalledCatalogRead;
  /** Test seam: the Command Code CLI resolution (defaults to the real bounded local resolution). */
  resolveCli?: (input: { configPath?: string | null; env: NodeJS.ProcessEnv }) => CliResolution;
}

function normalizeEffortToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  return EFFORT_TOKEN_RE.test(token) ? token : null;
}

/** A published effort list: every entry must be a valid token, else null. */
function normalizeEffortList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const item of value) {
    const token = normalizeEffortToken(item);
    if (!token) return null;
    if (!out.includes(token)) out.push(token);
  }
  return out.length ? out : null;
}

/**
 * Parse one snapshot row's `reasoning` object into the model metadata.
 *
 * Returns null when the object publishes neither a supported list nor a default
 * effort — an honest "the App published no effort evidence for this model",
 * never a fabricated list. A malformed `supportedEfforts` array is treated as
 * unpublished rather than partially trusted.
 */
export function parseWorkBuddyAiReasoning(raw: unknown): WorkBuddyAiReasoningMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const supported = normalizeEffortList(value.supportedEfforts);
  const defaultEffort = normalizeEffortToken(value.defaultEffort) ?? normalizeEffortToken(value.effort);
  if (!supported && !defaultEffort) return null;
  return {
    app_default_effort: defaultEffort,
    supported_efforts: supported,
    supported_efforts_source: supported ? "official-app" : null
  };
}

/** The own-property names the installed-catalog reader is expected to use. */
const INSTALLED_CATALOG_EFFORT_KEYS = ["effortsByModel", "modelEfforts", "supportedEffortsByModel", "efforts"] as const;

/** One published entry: a raw level list, or an object carrying one. */
function effortEntry(value: unknown): string[] | null {
  const direct = normalizeEffortList(value);
  if (direct) return direct;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["supportedEfforts", "efforts", "supported", "levels"]) {
      const list = normalizeEffortList(record[key]);
      if (list) return list;
    }
  }
  return null;
}

/**
 * The per-model effort list the LIVE installed-catalog structure publishes.
 *
 * The installed package's own `Efforts` column is read by the same local
 * catalog read Command Code Settings already performs; this module adds no
 * second read and no second parser. The reader's per-model map is located by
 * its documented property name first and otherwise by shape (any own,
 * map-shaped property keyed by model id), so a concurrent extension of that
 * structure is consumed as-is instead of being guessed at or reverted.
 *
 * The installed reference namespaces ids (`deepseek/deepseek-v4.1-flash`), so
 * the lookup prefers an EXACT id and otherwise accepts an unambiguous
 * namespace-qualified key whose last `/`-separated segment is exactly the model
 * id. Two candidate rows yield no evidence at all.
 */
function installedCatalogModelEfforts(installed: InstalledCatalogRead, modelId: string): string[] | null {
  if (!installed.ok) return null;
  const catalog = installed.catalog as unknown as Record<string, unknown>;
  const maps: Record<string, unknown>[] = [];
  for (const key of INSTALLED_CATALOG_EFFORT_KEYS) {
    const value = catalog[key];
    if (value && typeof value === "object" && !Array.isArray(value)) maps.push(value as Record<string, unknown>);
  }
  for (const value of Object.values(catalog)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const map = value as Record<string, unknown>;
    if (!maps.includes(map)) maps.push(map);
  }
  for (const map of maps) {
    const exact = effortEntry(map[modelId]);
    if (exact) return exact;
    const namespaced: string[][] = [];
    for (const [id, entry] of Object.entries(map)) {
      if (!id.endsWith("/" + modelId)) continue;
      const list = effortEntry(entry);
      if (list) namespaced.push(list);
    }
    if (namespaced.length === 1) return namespaced[0] ?? null;
    if (namespaced.length > 1) return null;
  }
  return null;
}

/**
 * Read the SAME model id's published effort list from the currently installed
 * Command Code catalog. Pure local I/O: the bounded local CLI resolution plus
 * the existing installed-catalog read. Returns null when no such evidence
 * exists — never an invented list.
 */
export function readInstalledCommandCodeModelEfforts(
  model: string,
  deps: WorkBuddyAiEffortFallbackDeps = {}
): string[] | null {
  const modelId = typeof model === "string" ? model.trim() : "";
  if (!modelId) return null;
  const env = deps.env ?? process.env;
  const resolve = deps.resolveCli ?? ((input: { configPath?: string | null; env: NodeJS.ProcessEnv }) => resolveCommandCodeCli(input));
  let resolution: CliResolution;
  try {
    resolution = resolve({ configPath: deps.configPath ?? null, env });
  } catch {
    return null;
  }
  if (!resolution.ok || !resolution.path) return null;
  const read = deps.readInstalledCatalog ?? readInstalledModelCatalog;
  let installed: InstalledCatalogRead;
  try {
    installed = read(resolution.path);
  } catch {
    return null;
  }
  return installedCatalogModelEfforts(installed, modelId);
}

/**
 * The final supported-effort evidence for one model:
 *   * the App's explicit supported list when published (authoritative), else
 *   * the DS-only Command Code fallback list when the App published a default
 *     effort but no supported list, else
 *   * null (no reliable evidence — the caller must not invent one).
 */
export function resolveWorkBuddyAiSupportedEfforts(
  model: string,
  modelMeta: Record<string, WorkBuddyAiEffortCarrier> | null | undefined,
  deps: WorkBuddyAiEffortFallbackDeps = {}
): { supported_efforts: string[]; supported_efforts_source: "official-app" | "command-code" } | null {
  const modelId = typeof model === "string" ? model.trim() : "";
  if (!modelId) return null;
  const reasoning = modelMeta?.[modelId]?.reasoning ?? null;
  if (reasoning?.supported_efforts?.length) {
    return {
      supported_efforts: [...reasoning.supported_efforts],
      supported_efforts_source: reasoning.supported_efforts_source ?? "official-app"
    };
  }
  // DeepSeek special case ONLY: the App published a default effort but no
  // supported list, so the same model id's installed Command Code effort list
  // is consulted as fallback evidence.
  if (modelId !== WORKBUDDY_AI_DEEPSEEK_EFFORT_FALLBACK_MODEL) return null;
  if (!reasoning?.app_default_effort) return null;
  const fallback = readInstalledCommandCodeModelEfforts(modelId, deps);
  if (!fallback?.length) return null;
  return { supported_efforts: fallback, supported_efforts_source: "command-code" };
}

/**
 * Merge the DS-only fallback evidence into the model metadata that is about to
 * be published in the Settings view. Mutates ONLY the DeepSeek fallback model's
 * entry; every other model keeps exactly the Official App evidence.
 */
export function applyWorkBuddyAiEffortFallback(
  modelMeta: Record<string, WorkBuddyAiEffortCarrier>,
  deps: WorkBuddyAiEffortFallbackDeps = {}
): void {
  const model = WORKBUDDY_AI_DEEPSEEK_EFFORT_FALLBACK_MODEL;
  const meta = modelMeta[model];
  const reasoning = meta?.reasoning ?? null;
  // Only the "App published a default effort but no supported list" case is a
  // fallback candidate; an App-published list is already authoritative.
  if (!meta || !reasoning?.app_default_effort || reasoning.supported_efforts) return;
  const evidence = resolveWorkBuddyAiSupportedEfforts(model, modelMeta, deps);
  if (!evidence || evidence.supported_efforts_source !== "command-code") return;
  meta.reasoning = {
    ...reasoning,
    supported_efforts: evidence.supported_efforts,
    supported_efforts_source: evidence.supported_efforts_source
  };
}
