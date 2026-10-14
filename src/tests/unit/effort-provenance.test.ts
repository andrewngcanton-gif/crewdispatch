// effort-provenance.test.ts — offline coverage of the pure rule that decides
// whether a null (model-default) effort on a RESUMED attempt is the provider's
// own resolved default (safe to continue) or an unproven/remembered value that
// must stay protected.
import test from "node:test";
import assert from "node:assert/strict";
import { isModelDefaultEffortProven, type EffortProvenanceAttempt } from "../../jobs/effort-provenance";

const M = "stealth/space-bunny-alpha";
const OTHER = "stealth/other-model";
const S = "6f5d7d77-d968-4f9f-9bbe-fef3a0a11210";

function attempt(overrides: Partial<EffortProvenanceAttempt> = {}): EffortProvenanceAttempt {
  return { generation: 0, model: M, effort: null, ...overrides };
}

test("a fresh model-default turn followed by a null resume of the SAME owned session is proven", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: null })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    true
  );
});

test("a prior EXPLICIT effort for the SAME model keeps the null resume protected", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: "high" })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    false
  );
});

test("an UNKNOWN resume (no proven fresh origin) stays protected", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    false,
    "with no generation-0 attempt the session's origin is unproven"
  );
});

test("a resume of a DIFFERENT/unknown session id stays protected", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: null })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: "some-other-session",
      sessionId: S
    }),
    false
  );
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: null })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: null
    }),
    false
  );
});

test("a FRESH attempt (no resume) is never 'proven' by this rule", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: null })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: null,
      sessionId: null
    }),
    false,
    "a fresh session needs no provenance; this rule only governs resumed attempts"
  );
});

test("an explicit CURRENT effort is never 'proven' as a default", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: M, effort: null })],
      currentModel: M,
      currentEffort: "high",
      resumedFrom: S,
      sessionId: S
    }),
    false
  );
});

test("a DIFFERENT model's explicit effort does not block this model's default (cross-model fallback/return)", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [attempt({ generation: 0, model: OTHER, effort: "high" })],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    true,
    "another model's explicit level is never proof for this model"
  );
});

test("a prior explicit effort for this model from ANY generation still protects", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [
        attempt({ generation: 0, model: M, effort: null }),
        attempt({ generation: 1, model: M, effort: "low" })
      ],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    false
  );
});

test("a prior null effort for this model does not block the default", () => {
  assert.equal(
    isModelDefaultEffortProven({
      priorAttempts: [
        attempt({ generation: 0, model: M, effort: null }),
        attempt({ generation: 1, model: M, effort: null })
      ],
      currentModel: M,
      currentEffort: null,
      resumedFrom: S,
      sessionId: S
    }),
    true
  );
});
