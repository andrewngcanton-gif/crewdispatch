// select.ts — the PURE model-selection logic of CrewDispatch.
//
// Given a validated config and a local instant, decide the effective model and
// WHERE it came from. Pure: no clock side effects beyond reading the supplied
// `now`, no I/O, no CLI. This is the single decision the startup path, a future
// Hub UI and a future rate-limit fallback / in-flight switch all share.
//
// PRIORITY (highest first):
//   1. an explicit per-job model — ALWAYS wins and is NEVER affected by a time
//      slot (the requirement that an explicit override never switches);
//   2. the first ENABLED time slot (top-to-bottom = priority) whose window
//      contains the local second-of-day; a cross-midnight window (start > end)
//      wraps past midnight; start is INCLUSIVE and end is EXCLUSIVE, so adjacent
//      windows never double-match;
//   3. the configured default model;
//   4. the official CLI catalog's own default model;
//   5. otherwise there is no model and the caller gets an honest error (CrewDispatch
//      NEVER invents a model id).
//
// STALE / RELIABILITY: a model id is only validated against the CLI's OWN public
// `--list-models` catalog. When that catalog is unavailable, a configured id
// cannot be proven valid — the result says so (`catalogReliable:false`) and adds
// a `catalog_unavailable` diagnostic. A conservative/documented fallback list is
// NEVER treated as proof that a model is accepted. A configured id that is NOT
// in a reliable catalog is reported as `model_stale`; it is never silently
// substituted with a different model.
import { MAX_TIME_SLOTS, toSeconds, type CrewDispatchConfig, type TimeSlot } from "./schema";
import type { AcceptedModelIntent, ModelChainPlanEntry, ModelSource } from "../jobs/types";

export { toSeconds };

/** The most candidate models a single logical run may ever try (primary + 2). */
export const MAX_MODEL_CHAIN = 3;

/**
 * Which public provider source published a catalog.
 *
 * `cli-list-models` is Command Code's `--list-models`; `cli-help-models` is the
 * public `--help` fallback; `cli-control-models` is WorkBuddy AI's bundled CLI
 * read-only `get_available_models` fallback; `workbuddy-product-snapshot` is
 * WorkBuddy AI's resolved Product Configuration snapshot; and
 * `installed-package-reference` is the Command Code package's OWN shipped model
 * reference (`…/command-code-knowledge/reference/models.md`), read locally from
 * the currently installed package.
 */
export type CatalogSource =
  | "cli-list-models"
  | "cli-help-models"
  | "cli-control-models"
  | "installed-package-reference"
  | "workbuddy-product-snapshot"
  | "unavailable";

/** The CLI catalog evidence the decision is validated against. */
export interface CatalogEvidence {
  ok: boolean;
  source: CatalogSource;
  models: string[];
  defaultModel: string | null;
}

/** Public catalog sources that can prove configured model ids for this selection path. */
export function isReliableConfigCatalogSource(source: CatalogSource): boolean {
  return (
    source === "cli-list-models" ||
    source === "cli-help-models" ||
    source === "cli-control-models" ||
    source === "installed-package-reference" ||
    source === "workbuddy-product-snapshot"
  );
}

export interface ModelDiagnostic {
  /** The config field the value came from (`defaultModel`, `timeSlots[0].model`, ...). */
  field: string;
  value: string;
  code: "model_stale" | "catalog_unavailable";
  message: string;
}

export interface SelectModelInput {
  /** The per-job explicit override (already trimmed or null). */
  explicitModel: string | null;
  config: CrewDispatchConfig;
  now: Date;
  catalog: CatalogEvidence;
  /** Fallback default when neither a slot nor a config default applies. */
  cliDefaultModel?: string | null;
  /**
   * The per-job EXPLICIT effort for the PRIMARY candidate only. `undefined`
   * (absent) means "not supplied" — the primary then uses the effort that
   * belongs to its resolved source (the configured default model's effort, or
   * the provider/model default). `null`/blank is an explicit "provider/model
   * default" that suppresses any configured effort for the primary. It NEVER
   * applies to the later fallback candidates: each of those carries its OWN
   * configured effort.
   */
  explicitEffort?: string | null;
}

export interface ModelSelection {
  ok: boolean;
  model: string | null;
  source: ModelSource;
  /** The explicit override this decision saw (persisted as the source of truth). */
  explicitModel: string | null;
  /** The winning slot index when `source === "slot"`, else null. */
  slotIndex: number | null;
  /** The raw configured value that won (before any catalog check). */
  rawModel: string | null;
  catalogSource: CatalogSource;
  catalogReliable: boolean;
  error: string | null;
  diagnostics: ModelDiagnostic[];
}

/** Local second-of-day of an instant (the wall clock the slots are written in). */
export function secondsOfDay(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

export interface SlotMatch {
  index: number;
  slot: TimeSlot;
}

/**
 * The first ENABLED slot (top-to-bottom, capped at `MAX_TIME_SLOTS`) whose window
 * contains `secs`. Start inclusive, end exclusive; `start > end` wraps midnight.
 * A disabled or malformed slot never matches.
 */
export function matchSlot(slots: readonly TimeSlot[], secs: number, limit: number = MAX_TIME_SLOTS): SlotMatch | null {
  const n = Math.min(slots.length, limit);
  for (let i = 0; i < n; i += 1) {
    const s = slots[i];
    if (!s || !s.enabled || !s.model) continue;
    const start = toSeconds(s.start);
    const end = toSeconds(s.end);
    if (start == null || end == null) continue;
    const inside = start <= end ? secs >= start && secs < end : secs >= start || secs < end;
    if (inside) return { index: i, slot: s };
  }
  return null;
}

function trimmedOrNull(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The configured effort that belongs to one RESOLVED selection:
 *   * a `config-default` route uses the default model's own effort;
 *   * a `rate-limit-fallback` route uses the fallback model's own effort;
 *   * an `explicit` override that names the SAME configured default model may
 *     use the default model's effort (the "main configured pair");
 *   * every other route (a time slot, the CLI catalog default, or an explicit
 *     model that is NOT the configured default) has no configured effort, so it
 *     runs at the provider/model default (null).
 * The two efforts are independent and are never copied from one another.
 */
export function effortForModelSource(
  config: CrewDispatchConfig,
  source: ModelSource,
  model: string | null
): string | null {
  if (source === "config-default") return trimmedOrNull(config.defaultEffort);
  if (source === "rate-limit-fallback") return trimmedOrNull(config.rateLimitFallbackEffort);
  if (source === "explicit" && model && model === trimmedOrNull(config.defaultModel)) return trimmedOrNull(config.defaultEffort);
  return null;
}

/**
 * Decide the effective model. Pure and total: it always returns a
 * `ModelSelection`, using `ok:false` + `error` for an honest "no usable model".
 */
export function selectModel(input: SelectModelInput): ModelSelection {
  const { config, now, catalog } = input;
  const explicit = trimmedOrNull(input.explicitModel);
  const reliable = catalog.ok && isReliableConfigCatalogSource(catalog.source);
  const known = new Set(catalog.models);
  const diagnostics: ModelDiagnostic[] = [];

  const check = (field: string, value: string | null): void => {
    if (!value || !reliable) return;
    if (!known.has(value)) {
      diagnostics.push({
        field,
        value,
        code: "model_stale",
        message: `Configured model ${value} (${field}) is not in the installed CLI's current catalog; CrewDispatch never substitutes another model automatically.`
      });
    }
  };

  check("defaultModel", trimmedOrNull(config.defaultModel));
  for (let i = 0; i < Math.min(config.timeSlots.length, MAX_TIME_SLOTS); i += 1) {
    const s = config.timeSlots[i];
    if (s && s.enabled) check(`timeSlots[${i}].model`, trimmedOrNull(s.model));
  }
  check("rateLimitFallbackModel", trimmedOrNull(config.rateLimitFallbackModel));
  check("explicitModel", explicit);

  // The catalog could not be read: nothing configured can be PROVEN available.
  // Report that honestly instead of implying the ids are valid.
  if (!reliable && (trimmedOrNull(config.defaultModel) || explicit || config.timeSlots.some((s) => s && s.enabled && s.model))) {
    diagnostics.push({
      field: "catalog",
      value: "",
      code: "catalog_unavailable",
      message: "The official CLI's model catalog is unavailable, so configured model IDs cannot be verified; this is not evidence that those models are available."
    });
  }

  const base = { explicitModel: explicit, catalogSource: catalog.source, catalogReliable: reliable, diagnostics };

  if (explicit) {
    if (reliable && !known.has(explicit)) {
      return {
        ...base,
        ok: false,
        model: null,
        source: "explicit",
        slotIndex: null,
        rawModel: explicit,
        error: `The explicit model ${explicit} is not in the installed CLI's current catalog; CrewDispatch never substitutes another model.`
      };
    }
    return { ...base, ok: true, model: explicit, source: "explicit", slotIndex: null, rawModel: explicit, error: null };
  }

  const hit = matchSlot(config.timeSlots, secondsOfDay(now));
  if (hit) {
    const m = trimmedOrNull(hit.slot.model);
    if (m) {
      if (reliable && !known.has(m)) {
        return {
          ...base,
          ok: false,
          model: null,
          source: "slot",
          slotIndex: hit.index,
          rawModel: m,
          error: `The model ${m} configured on the matching time slot [${hit.slot.start}-${hit.slot.end}] is not in the installed CLI's current catalog; CrewDispatch never substitutes another model.`
        };
      }
      return { ...base, ok: true, model: m, source: "slot", slotIndex: hit.index, rawModel: m, error: null };
    }
  }

  const def = trimmedOrNull(config.defaultModel);
  if (def) {
    if (reliable && !known.has(def)) {
      return {
        ...base,
        ok: false,
        model: null,
        source: "config-default",
        slotIndex: null,
        rawModel: def,
        error: `The configured default model ${def} is not in the installed CLI's current catalog; CrewDispatch never substitutes another model.`
      };
    }
    return { ...base, ok: true, model: def, source: "config-default", slotIndex: null, rawModel: def, error: null };
  }

  const cliDefault = trimmedOrNull(input.cliDefaultModel ?? catalog.defaultModel);
  if (cliDefault) {
    return { ...base, ok: true, model: cliDefault, source: "cli-default", slotIndex: null, rawModel: cliDefault, error: null };
  }

  return {
    ...base,
    ok: false,
    model: null,
    source: "none",
    slotIndex: null,
    rawModel: null,
    error:
      "No usable model: no default model or time slot is configured and the official CLI catalog provides no default model; " +
      "CrewDispatch never invents a model ID and never falls back to any built-in list."
  };
}

// ---------------------------------------------------------------------------
// WHEN does the effective model change? (the in-flight boundary switch, pure)
// ---------------------------------------------------------------------------
//
// `selectModel` answers "which model wins at THIS instant". The boundary switch
// needs the NEXT question: "at which future LOCAL wall-clock instant does the
// effective model actually CHANGE, so a running generation should be moved to
// the new model?" This function is PURE — no timers, no I/O, no clock reads
// beyond the supplied `now`.
//
// RULES (all locked by tests):
//   * an EXPLICIT per-job model is never auto-switched → no boundary at all;
//   * a slot's START and END are the only possible boundaries (start inclusive,
//     end exclusive), and each is mapped to its NEXT occurrence, wrapping past
//     midnight — so a cross-midnight window yields both of its boundaries;
//   * a DISABLED (or model-less / malformed) slot contributes no boundary;
//   * OVERLAPPING slots: `matchSlot` is first-match-wins, so a shadowed slot's
//     boundaries evaluate to the SAME effective model and are skipped;
//   * a boundary whose effective model equals the CURRENT one is skipped (a
//     same-model boundary must never restart a job);
//   * a boundary whose model cannot be PROVEN is skipped: an unreliable CLI
//     catalog yields NO boundary at all, and a stale (not-in-catalog) winning id
//     is never a switch target — CrewDispatch never starts a model it cannot verify.
const DAY_MS = 24 * 3600 * 1000;

/** The next local-wall-clock epoch ms of a second-of-day STRICTLY after `nowMs`. */
export function nextOccurrenceMs(sec: number, nowMs: number): number {
  const base = new Date(nowMs);
  base.setHours(0, 0, 0, 0);
  let t = base.getTime() + sec * 1000;
  while (t <= nowMs) t += DAY_MS;
  return t;
}

export interface ModelBoundary {
  /** Epoch ms of the boundary instant (local wall clock). */
  atMs: number;
  atIso: string;
  /** The model effective AT the boundary (never stale, never a guess). */
  model: string;
  source: ModelSource;
  slotIndex: number | null;
  rawModel: string | null;
  /** The effort belonging to the boundary's own resolved source. */
  effort: string | null;
}

export interface NextBoundaryInput {
  config: CrewDispatchConfig;
  now: Date;
  catalog: CatalogEvidence;
  /** The per-job explicit override: when set there is NEVER a boundary. */
  explicitModel?: string | null;
  /** The model the CURRENT generation runs; a boundary to the same model is skipped. */
  currentModel?: string | null;
  cliDefaultModel?: string | null;
  limit?: number;
}

/**
 * The next local instant at which the effective model differs from
 * `currentModel`, or null when there is none.
 *
 * Null means "no future boundary that may switch": an explicit override, no
 * enabled slot with a boundary, only same-model / unprovable boundaries, or an
 * unreliable CLI catalog.
 */
export function nextModelBoundary(input: NextBoundaryInput): ModelBoundary | null {
  const { config, catalog } = input;
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number(input.now);
  if (!Number.isFinite(nowMs)) return null;
  // An explicit per-job override is pinned for the whole run (requirement): it
  // never switches with the clock, so no timer is ever armed for it.
  if (trimmedOrNull(input.explicitModel)) return null;
  // Nothing configured can be PROVEN available without the CLI's own catalog, so
  // there is no switch target — never a restart on an unverifiable model.
  const reliable = catalog.ok && catalog.source === "cli-list-models";
  if (!reliable) return null;

  const current = trimmedOrNull(input.currentModel);
  const limit = input.limit ?? MAX_TIME_SLOTS;
  const seconds = new Set<number>();
  const n = Math.min(config.timeSlots.length, limit);
  for (let i = 0; i < n; i += 1) {
    const s = config.timeSlots[i];
    if (!s || !s.enabled || !s.model) continue;
    const start = toSeconds(s.start);
    const end = toSeconds(s.end);
    if (start != null) seconds.add(start);
    if (end != null) seconds.add(end);
  }
  if (seconds.size === 0) return null;

  const times = [...seconds].map((sec) => nextOccurrenceMs(sec, nowMs)).sort((a, b) => a - b);
  for (const at of times) {
    // Resolve LIVE at the boundary instant (never from the scheduled guess): the
    // winning slot / default is whatever the config says for THAT second.
    const sel = selectModel({
      explicitModel: null,
      config,
      now: new Date(at),
      catalog,
      cliDefaultModel: input.cliDefaultModel
    });
    if (!sel.ok || !sel.model || !sel.catalogReliable) continue;
    if (current && sel.model === current) continue;
    return { atMs: at, atIso: new Date(at).toISOString(), model: sel.model, source: sel.source, slotIndex: sel.slotIndex, rawModel: sel.rawModel, effort: effortForModelSource(config, sel.source, sel.model) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The rate-limit downgrade CANDIDATE CHAIN (pure)
// ---------------------------------------------------------------------------
//
// ONE logical run may try an ordered, canonical-id-deduped list of at most
// `MAX_MODEL_CHAIN` models. The chain is:
//
//   1. the PRIMARY route (explicit override > matching enabled slot > configured
//      default > the CLI catalog default) — exactly `selectModel` above;
//   2. the configured `defaultModel` (when set and not already candidate #1);
//   3. the configured `rateLimitFallbackModel` (when set and not already tried).
//
// There is deliberately NO built-in/free model: an unset `rateLimitFallbackModel`
// adds no candidate, so a job whose primary is rate-limited simply ends honestly
// instead of being silently moved to a model the user never configured.
//
// A NON-primary candidate is added ONLY when the installed CLI's own public
// catalog PROVES it exists (a reliable catalog that lists the exact id). An
// unverifiable candidate — a stale id, or ANY candidate while the catalog is
// unavailable — is OMITTED (the CLI is never called with it, and it is never
// silently substituted) and a diagnostic names the exact config field. The
// primary keeps the existing `selectModel` behaviour (a stale WINNING id blocks
// dispatch honestly).
export interface ChainCandidate {
  model: string;
  /** Where the id came from (persisted per attempt for the fallback audit). */
  source: ModelSource;
  /**
   * The reasoning effort THIS candidate runs with: the configured effort that
   * belongs to its source (see `effortForModelSource`), or the per-job explicit
   * effort for the primary when one was supplied. Null = the provider/model
   * default. The pair is snapshotted per candidate; dedupe is by model id ONLY,
   * so an effort-only change never creates another retry.
   */
  effort: string | null;
}

export interface ModelChainSelection {
  ok: boolean;
  /** Ordered, canonical-id-deduped candidates (primary first), at most 3. */
  chain: ChainCandidate[];
  /** The primary's source (`none` when no model could be resolved). */
  source: ModelSource;
  explicitModel: string | null;
  catalogSource: CatalogSource;
  catalogReliable: boolean;
  error: string | null;
  diagnostics: ModelDiagnostic[];
}

/** Build the ordered, deduped candidate chain. Pure and total. */
export function selectModelChain(input: SelectModelInput): ModelChainSelection {
  const primary = selectModel(input);
  const diagnostics = [...primary.diagnostics];
  const base = {
    source: primary.source,
    explicitModel: primary.explicitModel,
    catalogSource: primary.catalogSource,
    catalogReliable: primary.catalogReliable,
    diagnostics
  };
  if (!primary.ok || !primary.model) {
    return { ...base, ok: false, chain: [], error: primary.error };
  }

  const reliable = primary.catalogReliable;
  const known = new Set(input.catalog.models);
  // The primary's effort: an explicitly supplied per-job effort wins (null =
  // provider/model default), otherwise the configured effort that belongs to
  // the resolved source. The later candidates always use their OWN configured
  // effort — an explicit single-job effort never leaks onto them.
  const primaryEffort =
    input.explicitEffort !== undefined
      ? trimmedOrNull(input.explicitEffort)
      : effortForModelSource(input.config, primary.source, primary.model);
  const chain: ChainCandidate[] = [{ model: primary.model, source: primary.source, effort: primaryEffort }];
  const seen = new Set<string>([primary.model]);

  const add = (field: string, raw: string | null | undefined, source: ModelSource): void => {
    const value = trimmedOrNull(raw);
    if (!value) return;
    // Canonical (exact-id) dedupe: the same model is never tried twice.
    if (seen.has(value)) return;
    if (!reliable) {
      // The catalog could not be read, so this candidate cannot be PROVEN
      // available: it is never called and never substituted.
      diagnostics.push({
        field,
        value,
        code: "catalog_unavailable",
        message: `The official CLI's model catalog is unavailable, so fallback candidate ${value} (${field}) cannot be verified; the candidate was skipped, the CLI is never called with it and no other model is substituted.`
      });
      return;
    }
    if (!known.has(value)) {
      diagnostics.push({
        field,
        value,
        code: "model_stale",
        message: `Fallback candidate ${value} (${field}) is not in the installed CLI's current catalog; the candidate was skipped, the CLI is never called with it and no other model is substituted.`
      });
      return;
    }
    seen.add(value);
    chain.push({ model: value, source, effort: effortForModelSource(input.config, source, value) });
  };

  add("defaultModel", input.config.defaultModel, "config-default");
  add("rateLimitFallbackModel", input.config.rateLimitFallbackModel, "rate-limit-fallback");

  return { ...base, ok: true, chain: chain.slice(0, MAX_MODEL_CHAIN), error: null };
}

/**
 * Validate a FROZEN dispatch-time model/effort INTENT against the installed
 * CLI's own catalog and build the ordered candidate chain.
 *
 * This is exactly `selectModelChain`'s proof rule, applied to the pairs that
 * were captured BEFORE the queued job was exposed (see `AcceptedModelIntent`):
 * a candidate is only ever dispatched when the catalog PROVES it, and the
 * accepted model/effort pair is carried through unchanged — the live config is
 * never consulted, so a Settings edit made while the job was queued can never
 * pair a later model with an earlier effort.
 *
 * The primary may be `null` in the intent (the dispatch-time settings
 * contributed no model): it then resolves to the CLI's own catalog default
 * (`cliDefaultModel` wins over `catalog.defaultModel`, mirroring `selectModel`),
 * exactly as a fresh job would. `explicitModel` is echoed back so the caller can
 * persist the same override it accepted.
 */
export function selectModelChainFromIntent(
  intent: AcceptedModelIntent,
  catalog: CatalogEvidence,
  explicitModel: string | null = null,
  cliDefaultModel?: string | null
): ModelChainSelection {
  const reliable = catalog.ok && isReliableConfigCatalogSource(catalog.source);
  const known = new Set(catalog.models);
  const diagnostics: ModelDiagnostic[] = [];
  const base = {
    explicitModel: trimmedOrNull(explicitModel),
    catalogSource: catalog.source,
    catalogReliable: reliable,
    diagnostics
  };

  const primaryModel = trimmedOrNull(intent.primaryModel);
  let primary: ChainCandidate;
  if (primaryModel) {
    if (reliable && !known.has(primaryModel)) {
      diagnostics.push({
        field: "acceptedModel",
        value: primaryModel,
        code: "model_stale",
        message: `The accepted model ${primaryModel} is not in the installed CLI's current catalog; CrewDispatch never substitutes another model.`
      });
      return {
        ...base,
        ok: false,
        chain: [],
        source: intent.primarySource,
        error: `The accepted model ${primaryModel} is not in the installed CLI's current catalog; CrewDispatch never substitutes another model.`
      };
    }
    primary = { model: primaryModel, source: intent.primarySource, effort: trimmedOrNull(intent.primaryEffort) };
  } else {
    // No accepted model (the dispatch-time settings contributed none): resolve
    // the CLI's own default exactly as `selectModel` does — an injected provider
    // default wins over the catalog's, and neither is a config value.
    const cliDefault = trimmedOrNull(cliDefaultModel ?? catalog.defaultModel);
    if (!cliDefault) {
      if (!reliable) {
        diagnostics.push({
          field: "catalog",
          value: "",
          code: "catalog_unavailable",
          message:
            "The official CLI's model catalog is unavailable and publishes no default, so the accepted job's model cannot be resolved; this is not evidence that any model is available."
        });
      }
      return {
        ...base,
        ok: false,
        chain: [],
        source: "none",
        error:
          "No usable model: the accepted job configured no model and the official CLI catalog provides no default; " +
          "CrewDispatch never invents a model ID and never falls back to any built-in list."
      };
    }
    // A per-job explicit effort is still valid when model resolution is deferred
    // to the CLI default. An accepted null stays null and means provider default.
    primary = { model: cliDefault, source: "cli-default", effort: trimmedOrNull(intent.primaryEffort) };
  }

  const chain: ChainCandidate[] = [primary];
  const seen = new Set<string>([primary.model]);

  const add = (entry: ModelChainPlanEntry): void => {
    const value = trimmedOrNull(entry.model);
    if (!value || seen.has(value)) return;
    const field = entry.source === "rate-limit-fallback" ? "rateLimitFallbackModel" : "defaultModel";
    if (!reliable) {
      // The catalog could not be read, so this candidate cannot be PROVEN
      // available: it is never called and never substituted.
      diagnostics.push({
        field,
        value,
        code: "catalog_unavailable",
        message: `The official CLI's model catalog is unavailable, so accepted fallback candidate ${value} (${field}) cannot be verified; the candidate was skipped, the CLI is never called with it and no other model is substituted.`
      });
      return;
    }
    if (!known.has(value)) {
      diagnostics.push({
        field,
        value,
        code: "model_stale",
        message: `Accepted fallback candidate ${value} (${field}) is not in the installed CLI's current catalog; the candidate was skipped, the CLI is never called with it and no other model is substituted.`
      });
      return;
    }
    seen.add(value);
    chain.push({ model: value, source: entry.source, effort: trimmedOrNull(entry.effort) });
  };

  for (const fallback of intent.fallbacks) add(fallback);

  return { ...base, ok: true, chain: chain.slice(0, MAX_MODEL_CHAIN), source: primary.source, error: null };
}
