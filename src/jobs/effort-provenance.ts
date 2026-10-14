// effort-provenance.ts — the pure rule that decides whether a null
// (model-default) reasoning effort on a RESUMED attempt may be accepted as the
// provider's OWN resolved default value, or must stay protected as a possible
// remembered explicit level.
//
// WHY: a provider session can report a CONCRETE effort value for a model even
// when the product never selected one — the provider simply resolves the model
// default to a level (Command Code ACP 1.74.1 reports `medium` for
// `stealth/space-bunny-alpha`). A resumed-session guard that treats EVERY
// concrete value as a remembered explicit level therefore falsely rejects a
// legitimate model-default continuation. The distinction is PROVENANCE, which
// only the caller that owns the durable attempt history can decide.
//
// The rule is deliberately conservative. A null/default request is accepted as
// the provider default ONLY when ALL of these hold:
//   * it RESUMES this job's OWN recorded session (a fresh attempt creates a
//     clean session; an unknown/external session has no provenance);
//   * the job has a proven FRESH origin (a generation-0 attempt) — only then is
//     the recorded session provably the one this job created; and
//   * NO prior attempt ever requested an EXPLICIT effort for THIS model on this
//     session — a different model's explicit level is never proof for this one.
//
// Any missing/negative fact keeps the request protected, so a genuinely earlier
// explicit effort (same model) or an unknown external session is still refused
// by the provider's resumed-session guard rather than silently inherited.

/** The minimal per-attempt facts the rule needs (a subset of `JobAttempt`). */
export interface EffortProvenanceAttempt {
  generation: number;
  model: string | null;
  effort: string | null;
}

export interface EffortProvenanceInput {
  /** The job's attempts BEFORE the current one (the current attempt EXCLUDED). */
  priorAttempts: readonly EffortProvenanceAttempt[];
  /** The model the current attempt runs. */
  currentModel: string;
  /** The current attempt's requested effort (null = the model/provider default). */
  currentEffort: string | null;
  /** The session the current attempt resumes (null for a fresh attempt). */
  resumedFrom: string | null;
  /** The job's own recorded provider session id, or null when none is known. */
  sessionId: string | null;
}

/**
 * True ONLY when a null/model-default effort on a resumed attempt may be
 * accepted as the provider's own resolved default (see the module header).
 */
export function isModelDefaultEffortProven(input: EffortProvenanceInput): boolean {
  // An explicit request is set/verified directly; only a null request needs this.
  if (input.currentEffort != null) return false;
  // Only a RESUME of THIS job's own recorded session can inherit a remembered
  // value. A fresh attempt (resumedFrom null) creates a clean session; a resume
  // with no/other known session id has no provenance.
  if (input.resumedFrom == null || input.resumedFrom !== input.sessionId) return false;
  // A proven fresh origin: the job created its session with a generation-0
  // (session/new) attempt. Without it the session's origin is unknown.
  if (!input.priorAttempts.some((attempt) => attempt.generation === 0)) return false;
  // A prior EXPLICIT effort for THIS model may be remembered by the provider, so
  // the null request must not silently inherit it. Another model's explicit
  // level is never proof for this model.
  if (input.priorAttempts.some((attempt) => attempt.model === input.currentModel && attempt.effort != null)) return false;
  return true;
}
