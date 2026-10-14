// config-select.test.ts — the PURE model-selection logic: slot cap, cross-
// midnight, overlap priority, boundary inclusivity, explicit priority and stale
// / unreliable catalog handling. No clock, no I/O, no CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, type CrewDispatchConfig, type TimeSlot } from "../../config/schema";
import {
  MAX_MODEL_CHAIN,
  matchSlot,
  nextModelBoundary,
  nextOccurrenceMs,
  selectModel,
  selectModelChain,
  selectModelChainFromIntent,
  secondsOfDay,
  type CatalogEvidence
} from "../../config/select";
import type { AcceptedModelIntent } from "../../jobs/types";

const RELIABLE: CatalogEvidence = { ok: true, source: "cli-list-models", models: ["m/a", "m/b", "m/c"], defaultModel: "m/a" };
const UNAVAILABLE: CatalogEvidence = { ok: false, source: "unavailable", models: [], defaultModel: null };

function at(hour: number, minute = 0): Date {
  return new Date(2026, 8, 24, hour, minute, 0, 0);
}

function cfg(patch: Partial<CrewDispatchConfig>): CrewDispatchConfig {
  return { ...defaultConfig(), ...patch };
}

function slot(start: string, end: string, model: string, enabled = true): TimeSlot {
  return { start, end, model, enabled };
}

test("secondsOfDay reads the local wall clock", () => {
  assert.equal(secondsOfDay(at(0, 0)), 0);
  assert.equal(secondsOfDay(at(9, 30)), 9 * 3600 + 30 * 60);
  assert.equal(secondsOfDay(at(23, 59)), 23 * 3600 + 59 * 60);
});

test("an explicit per-job model ALWAYS wins and is never affected by a slot", () => {
  const config = cfg({ timeSlots: [slot("00:00", "23:59", "m/b")], defaultModel: "m/c" });
  const sel = selectModel({ explicitModel: "m/a", config, now: at(10), catalog: RELIABLE });
  assert.equal(sel.ok, true);
  assert.equal(sel.model, "m/a");
  assert.equal(sel.source, "explicit");
  assert.equal(sel.explicitModel, "m/a");
  assert.equal(sel.slotIndex, null);
});

test("with no explicit model, the matching enabled slot wins (top-to-bottom priority)", () => {
  const config = cfg({
    timeSlots: [slot("08:00", "12:00", "m/b"), slot("00:00", "23:59", "m/c")],
    defaultModel: "m/a"
  });
  const sel = selectModel({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(sel.ok, true);
  assert.equal(sel.model, "m/b");
  assert.equal(sel.source, "slot");
  assert.equal(sel.slotIndex, 0);
});

test("overlapping slots: the first enabled slot in list order wins", () => {
  const config = cfg({
    timeSlots: [slot("08:00", "18:00", "m/b"), slot("09:00", "10:00", "m/c")]
  });
  assert.equal(selectModel({ explicitModel: null, config, now: at(9), catalog: RELIABLE }).model, "m/b");
});

test("a disabled slot is skipped", () => {
  const config = cfg({ timeSlots: [slot("08:00", "18:00", "m/b", false), slot("08:00", "18:00", "m/c", true)] });
  const sel = selectModel({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(sel.model, "m/c");
  assert.equal(sel.slotIndex, 1);
});

test("boundaries: start is inclusive, end is exclusive", () => {
  const config = cfg({ timeSlots: [slot("08:00", "12:00", "m/b")] });
  assert.equal(selectModel({ explicitModel: null, config, now: at(8, 0), catalog: RELIABLE }).model, "m/b", "08:00 matches");
  assert.equal(selectModel({ explicitModel: null, config, now: at(11, 59), catalog: RELIABLE }).model, "m/b");
  const noon = selectModel({ explicitModel: null, config, now: at(12, 0), catalog: RELIABLE });
  assert.equal(noon.source, "cli-default", "12:00 is excluded, so it falls through to the CLI default");
  assert.equal(noon.slotIndex, null);
});

test("adjacent windows never double-match (end is exclusive)", () => {
  const config = cfg({ timeSlots: [slot("08:00", "12:00", "m/b"), slot("12:00", "18:00", "m/c")] });
  const noon = selectModel({ explicitModel: null, config, now: at(12, 0), catalog: RELIABLE });
  assert.equal(noon.model, "m/c");
  assert.equal(noon.slotIndex, 1);
});

test("cross-midnight windows (start > end) wrap past midnight", () => {
  const config = cfg({ timeSlots: [slot("23:00", "08:00", "m/b")] });
  assert.equal(selectModel({ explicitModel: null, config, now: at(23, 30), catalog: RELIABLE }).model, "m/b", "before midnight");
  assert.equal(selectModel({ explicitModel: null, config, now: at(2, 0), catalog: RELIABLE }).model, "m/b", "after midnight");
  assert.equal(selectModel({ explicitModel: null, config, now: at(7, 59), catalog: RELIABLE }).model, "m/b");
  assert.equal(selectModel({ explicitModel: null, config, now: at(8, 0), catalog: RELIABLE }).slotIndex, null, "08:00 ends the window");
  assert.equal(selectModel({ explicitModel: null, config, now: at(12, 0), catalog: RELIABLE }).slotIndex, null);
});

test("no slot match falls back to the configured default, then to the CLI catalog default", () => {
  const withDefault = cfg({ defaultModel: "m/b", timeSlots: [slot("08:00", "12:00", "m/c")] });
  const d = selectModel({ explicitModel: null, config: withDefault, now: at(20), catalog: RELIABLE });
  assert.equal(d.model, "m/b");
  assert.equal(d.source, "config-default");

  const noDefault = cfg({ timeSlots: [slot("08:00", "12:00", "m/c")] });
  const c = selectModel({ explicitModel: null, config: noDefault, now: at(20), catalog: RELIABLE });
  assert.equal(c.model, "m/a", "the CLI's own catalog default");
  assert.equal(c.source, "cli-default");

  // No slot, no default, no catalog default → honest none.
  const empty = selectModel({ explicitModel: null, config: defaultConfig(), now: at(20), catalog: UNAVAILABLE });
  assert.equal(empty.ok, false);
  assert.equal(empty.source, "none");
  assert.equal(empty.model, null);
});

test("the slot cap is 3: a 4th entry can never win (defensive)", () => {
  const config = cfg({
    timeSlots: [
      slot("00:00", "01:00", "m/a"),
      slot("00:00", "01:00", "m/a"),
      slot("00:00", "01:00", "m/a"),
      slot("00:00", "01:00", "m/c")
    ]
  });
  // Validation caps the persisted list at 3; matchSlot additionally refuses a 4th.
  const hit = matchSlot(config.timeSlots, secondsOfDay(at(0, 30)));
  assert.equal(hit?.index, 0);
});

test("a stale WINNING model is refused, never substituted (explicit / slot / default)", () => {
  const reliable = RELIABLE;
  const explicit = selectModel({ explicitModel: "m/zzz", config: defaultConfig(), now: at(9), catalog: reliable });
  assert.equal(explicit.ok, false);
  assert.match(String(explicit.error), /is not in the installed CLI's current catalog/);

  const slotStale = cfg({ timeSlots: [slot("08:00", "12:00", "m/zzz")] });
  const s = selectModel({ explicitModel: null, config: slotStale, now: at(9), catalog: reliable });
  assert.equal(s.ok, false);
  assert.equal(s.source, "slot");

  const defStale = cfg({ defaultModel: "m/zzz" });
  const d = selectModel({ explicitModel: null, config: defStale, now: at(9), catalog: reliable });
  assert.equal(d.ok, false);
  assert.equal(d.source, "config-default");
});

test("a stale NON-winning id is reported as a diagnostic without blocking dispatch", () => {
  const config = cfg({
    defaultModel: "m/zzz",
    rateLimitFallbackModel: "m/yyy",
    timeSlots: [slot("08:00", "12:00", "m/b"), slot("13:00", "14:00", "m/xxx", true)]
  });
  const sel = selectModel({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(sel.ok, true);
  assert.equal(sel.model, "m/b");
  const stale = sel.diagnostics.filter((x) => x.code === "model_stale").map((x) => x.value).sort();
  assert.deepEqual(stale, ["m/xxx", "m/yyy", "m/zzz"]);
  assert.equal(sel.catalogReliable, true);
});

test("an unavailable catalog never claims a configured id is valid (catalog_unavailable)", () => {
  const config = cfg({ defaultModel: "m/b" });
  const sel = selectModel({ explicitModel: null, config, now: at(9), catalog: UNAVAILABLE });
  assert.equal(sel.ok, true, "an unverifiable id is still used as written");
  assert.equal(sel.model, "m/b");
  assert.equal(sel.catalogReliable, false);
  assert.equal(sel.catalogSource, "unavailable");
  assert.ok(sel.diagnostics.some((x) => x.code === "catalog_unavailable"));
});

test("a fixture-style cliDefaultModel is used when nothing else is configured", () => {
  const sel = selectModel({ explicitModel: null, config: defaultConfig(), now: at(9), catalog: UNAVAILABLE, cliDefaultModel: "fixture/controlled" });
  assert.equal(sel.ok, true);
  assert.equal(sel.model, "fixture/controlled");
  assert.equal(sel.source, "cli-default");
});

// ---------------------------------------------------------------------------
// The rate-limit downgrade CANDIDATE CHAIN (pure)
// ---------------------------------------------------------------------------

test("the chain is primary > configured default > configured final fallback (in order)", () => {
  const config = cfg({
    defaultModel: "m/b",
    rateLimitFallbackModel: "m/c",
    timeSlots: [slot("08:00", "12:00", "m/a")]
  });
  const chain = selectModelChain({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [
    { model: "m/a", source: "slot", effort: null },
    { model: "m/b", source: "config-default", effort: null },
    { model: "m/c", source: "rate-limit-fallback", effort: null }
  ]);
});

test("the chain is canonical-id deduped: a repeated model is never tried twice", () => {
  // Primary == configured default == fallback: exactly one candidate.
  const config = cfg({ defaultModel: "m/a", rateLimitFallbackModel: "m/a" });
  const chain = selectModelChain({ explicitModel: null, config, now: at(20), catalog: RELIABLE });
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "config-default", effort: null }]);

  // Primary (slot m/b) != default (m/a): two candidates, fallback m/b deduped.
  const config2 = cfg({
    defaultModel: "m/a",
    rateLimitFallbackModel: "m/b",
    timeSlots: [slot("00:00", "23:59", "m/b")]
  });
  const chain2 = selectModelChain({ explicitModel: null, config: config2, now: at(9), catalog: RELIABLE });
  assert.deepEqual(chain2.chain, [
    { model: "m/b", source: "slot", effort: null },
    { model: "m/a", source: "config-default", effort: null }
  ]);
});

test("the chain is capped at MAX_MODEL_CHAIN (3) — primary + at most two", () => {
  assert.equal(MAX_MODEL_CHAIN, 3);
  const config = cfg({
    defaultModel: "m/b",
    rateLimitFallbackModel: "m/c",
    timeSlots: [slot("00:00", "23:59", "m/a")]
  });
  const chain = selectModelChain({ explicitModel: null, config, now: at(20), catalog: RELIABLE });
  assert.equal(chain.chain.length, 3);
  assert.deepEqual(chain.chain.map((c) => c.model), ["m/a", "m/b", "m/c"]);
});

test("an unset final fallback adds NO candidate — no invented/free model", () => {
  const config = cfg({
    defaultModel: "m/b",
    rateLimitFallbackModel: null,
    timeSlots: [slot("00:00", "23:59", "m/a")]
  });
  const chain = selectModelChain({ explicitModel: null, config, now: at(20), catalog: RELIABLE });
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain.map((c) => c.model), ["m/a", "m/b"]);
  assert.equal(
    chain.chain.some((c) => c.source === "rate-limit-fallback"),
    false,
    "no fallback candidate may be synthesized when none is configured"
  );
});

test("a stale/unavailable PRIMARY blocks dispatch (never substituted)", () => {
  // The primary is a stale explicit id → the whole chain is unusable.
  const stale = selectModelChain({ explicitModel: "m/zzz", config: defaultConfig(), now: at(9), catalog: RELIABLE });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.chain, []);
  assert.match(String(stale.error), /is not in the installed CLI's current catalog/);

  // The primary would be the CLI default, but the catalog is unavailable and
  // nothing else is configured → honest "no model", empty chain.
  const none = selectModelChain({ explicitModel: null, config: defaultConfig(), now: at(9), catalog: UNAVAILABLE });
  assert.equal(none.ok, false);
  assert.deepEqual(none.chain, []);
});

test("a stale NON-primary candidate is OMITTED with a diagnostic naming the field", () => {
  // The PRIMARY is a matching slot (m/b); the configured default is a stale id.
  const config = cfg({
    defaultModel: "m/zzz",
    rateLimitFallbackModel: "m/c",
    timeSlots: [slot("00:00", "23:59", "m/b")]
  });
  const chain = selectModelChain({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(chain.ok, true);
  // m/zzz (defaultModel) is stale → omitted; the fallback m/c survives.
  assert.deepEqual(chain.chain, [
    { model: "m/b", source: "slot", effort: null },
    { model: "m/c", source: "rate-limit-fallback", effort: null }
  ]);
  const stale = chain.diagnostics.find((d) => d.code === "model_stale" && d.value === "m/zzz");
  assert.ok(stale, "the omitted candidate must be reported");
  assert.equal(stale!.field, "defaultModel");
});

test("with an UNRELIABLE catalog, non-primary candidates are omitted (never called)", () => {
  const config = cfg({ defaultModel: "m/b", rateLimitFallbackModel: "m/c" });
  const chain = selectModelChain({ explicitModel: null, config, now: at(9), catalog: UNAVAILABLE });
  // The primary (m/b, the configured default) is used as written; the final
  // fallback cannot be proven available, so it is omitted with a diagnostic.
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [{ model: "m/b", source: "config-default", effort: null }]);
  const omitted = chain.diagnostics.filter((d) => d.code === "catalog_unavailable" && d.value === "m/c");
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0]!.field, "rateLimitFallbackModel");
});

test("an explicit primary is first in the chain and deduped against the rest", () => {
  const config = cfg({ defaultModel: "m/a", rateLimitFallbackModel: "m/b" });
  const chain = selectModelChain({ explicitModel: "m/b", config, now: at(9), catalog: RELIABLE });
  assert.deepEqual(chain.chain, [
    { model: "m/b", source: "explicit", effort: null },
    { model: "m/a", source: "config-default", effort: null }
  ]);
});

// ---------------------------------------------------------------------------
// Independent reasoning effort per candidate
// ---------------------------------------------------------------------------

test("each chain candidate carries its OWN configured effort (default and rate-limit fallback are independent)", () => {
  const config = cfg({
    defaultModel: "m/b",
    defaultEffort: "high",
    rateLimitFallbackModel: "m/c",
    rateLimitFallbackEffort: "low",
    timeSlots: [slot("08:00", "12:00", "m/a")]
  });
  const chain = selectModelChain({ explicitModel: null, config, now: at(9), catalog: RELIABLE });
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [
    { model: "m/a", source: "slot", effort: null },
    { model: "m/b", source: "config-default", effort: "high" },
    { model: "m/c", source: "rate-limit-fallback", effort: "low" }
  ]);
});

test("an explicit per-job effort applies ONLY to the initial model; the configured candidates keep their own", () => {
  const config = cfg({
    defaultModel: "m/a",
    defaultEffort: "high",
    rateLimitFallbackModel: "m/b",
    rateLimitFallbackEffort: "low"
  });
  const chain = selectModelChain({ explicitModel: "m/b", config, now: at(9), catalog: RELIABLE, explicitEffort: "max" });
  assert.deepEqual(chain.chain, [
    { model: "m/b", source: "explicit", effort: "max" },
    { model: "m/a", source: "config-default", effort: "high" }
  ]);
});

test("an explicit OTHER model without an effort uses the provider default, never the configured default's effort", () => {
  const config = cfg({ defaultModel: "m/a", defaultEffort: "high" });
  const chain = selectModelChain({ explicitModel: "m/c", config, now: at(9), catalog: RELIABLE });
  assert.deepEqual(chain.chain, [
    { model: "m/c", source: "explicit", effort: null },
    { model: "m/a", source: "config-default", effort: "high" }
  ]);
});

test("an explicit model that MATCHES the configured default may use the default's saved effort", () => {
  const config = cfg({ defaultModel: "m/a", defaultEffort: "high" });
  const chain = selectModelChain({ explicitModel: "m/a", config, now: at(9), catalog: RELIABLE });
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "explicit", effort: "high" }]);
});

test("an explicit null effort forces the provider default even for a matching configured default", () => {
  const config = cfg({ defaultModel: "m/a", defaultEffort: "high" });
  const chain = selectModelChain({ explicitModel: "m/a", config, now: at(9), catalog: RELIABLE, explicitEffort: null });
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "explicit", effort: null }]);
});

// ---------------------------------------------------------------------------
// The FROZEN dispatch-time intent (v11)
// ---------------------------------------------------------------------------

function intent(patch: Partial<AcceptedModelIntent>): AcceptedModelIntent {
  return { primaryModel: null, primarySource: "none", primaryEffort: null, fallbacks: [], ...patch };
}

test("the frozen intent's accepted model/effort pairs are used verbatim (the live config is never consulted)", () => {
  // The config still says m/b/m/c, but the accepted intent (captured earlier)
  // names m/a + m/c with their OWN efforts. Only the intent may be used.
  const accepted = intent({
    primaryModel: "m/a",
    primarySource: "config-default",
    primaryEffort: "high",
    fallbacks: [{ model: "m/c", source: "rate-limit-fallback", effort: "low" }]
  });
  const chain = selectModelChainFromIntent(accepted, RELIABLE, null);
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [
    { model: "m/a", source: "config-default", effort: "high" },
    { model: "m/c", source: "rate-limit-fallback", effort: "low" }
  ]);
  assert.equal(chain.explicitModel, null);
});

test("a frozen intent's accepted fallback is dropped when the catalog no longer proves it (stale), naming the field", () => {
  const accepted = intent({
    primaryModel: "m/a",
    primarySource: "config-default",
    primaryEffort: "high",
    fallbacks: [{ model: "m/gone", source: "rate-limit-fallback", effort: "low" }]
  });
  const chain = selectModelChainFromIntent(accepted, RELIABLE, null);
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "config-default", effort: "high" }]);
  assert.equal(chain.diagnostics.some((d) => d.code === "model_stale" && d.field === "rateLimitFallbackModel"), true);
});

test("a frozen intent whose accepted primary is stale blocks honestly (never substituted)", () => {
  const accepted = intent({ primaryModel: "m/gone", primarySource: "config-default", primaryEffort: "high" });
  const chain = selectModelChainFromIntent(accepted, RELIABLE, null);
  assert.equal(chain.ok, false);
  assert.deepEqual(chain.chain, []);
  assert.match(String(chain.error), /never substitutes another model/);
});

test("a frozen intent with no accepted model resolves the CLI's own default (cliDefaultModel wins), never a config value", () => {
  const accepted = intent({ primaryModel: null, primarySource: "none", primaryEffort: null });
  const chain = selectModelChainFromIntent(accepted, RELIABLE, null);
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "cli-default", effort: null }]);
  const injected = selectModelChainFromIntent(accepted, UNAVAILABLE, null, "fixture/controlled");
  assert.deepEqual(injected.chain, [{ model: "fixture/controlled", source: "cli-default", effort: null }]);
});

test("a no-model accepted intent preserves an explicit effort on the CLI default and preserves explicit null", () => {
  const explicit = selectModelChainFromIntent(intent({ primaryEffort: "high" }), RELIABLE, null);
  assert.deepEqual(explicit.chain, [{ model: "m/a", source: "cli-default", effort: "high" }]);

  const providerDefault = selectModelChainFromIntent(intent({ primaryEffort: null }), RELIABLE, null);
  assert.deepEqual(providerDefault.chain, [{ model: "m/a", source: "cli-default", effort: null }]);
});

test("an unreliable catalog keeps a frozen accepted primary but omits its unprovable fallbacks", () => {
  const accepted = intent({
    primaryModel: "m/a",
    primarySource: "config-default",
    primaryEffort: "high",
    fallbacks: [{ model: "m/c", source: "rate-limit-fallback", effort: "low" }]
  });
  const chain = selectModelChainFromIntent(accepted, UNAVAILABLE, null);
  assert.equal(chain.ok, true);
  assert.deepEqual(chain.chain, [{ model: "m/a", source: "config-default", effort: "high" }]);
  assert.equal(chain.diagnostics.some((d) => d.code === "catalog_unavailable"), true);
});

test("the frozen intent echoes the explicit override it was accepted with", () => {
  const accepted = intent({ primaryModel: "m/b", primarySource: "explicit", primaryEffort: "max" });
  const chain = selectModelChainFromIntent(accepted, RELIABLE, "m/b");
  assert.equal(chain.explicitModel, "m/b");
  assert.deepEqual(chain.chain, [{ model: "m/b", source: "explicit", effort: "max" }]);
});
