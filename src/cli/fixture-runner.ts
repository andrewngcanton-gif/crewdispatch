// fixture-runner.ts — TEST-ONLY executable seam.
//
// When the operator passes `--fixture <path>`, the job service drives a
// controlled Node executable instead of the official CLI. The fixture is given
// the task on STDIN and MAY receive `--resume <sessionId>`, exactly like the
// real CLI. Its stdout is folded through the SAME production stream parser and
// its exit code through the SAME production exit classifier, so a fixture
// exercises the whole pipeline except the provider binary itself.
//
// This is never used in production: the default runner is the accepted Command
// Code adapter. It exists so success / follow-up / segment-boundary behaviour can
// be verified when no dedicated test credential is available (see
// the real-vs-fixture regression contract).
import { createCommandCodeState, parseCommandCodeRecord, normalizeUsage } from "../providers/command-code/stream";
import { classifyCommandCodeExit } from "../providers/command-code/exit";
import { effortForModelSource, selectModel, selectModelChain, selectModelChainFromIntent } from "../config/select";
import type { CatalogEvidence } from "../config/select";
import type { ProviderAdapter, StreamState, UsageSnapshot } from "../providers/provider";
import type { AttemptContext, BuiltAttempt, JobRunner, ModelChainResolution, ModelResolution } from "../jobs/runner";
import nodePath from "node:path";

export const FIXTURE_DEFAULT_MODEL = "fixture/controlled";

/**
 * The default fixture catalog: no CLI catalog exists, so no model can be
 * PROVEN and the in-flight boundary switch never arms a boundary for it.
 */
const UNAVAILABLE_FIXTURE_CATALOG: CatalogEvidence = { ok: false, source: "unavailable", models: [], defaultModel: null };

/**
 * TEST-ONLY catalog seam. A fixture normally stands in for the provider
 * PROCESS only and has no catalog, so a configured downgrade candidate can
 * never be proven and the fallback chain stays single-candidate. A regression
 * that must exercise the REAL chain advance (for example the WorkBuddy
 * missing-finish quota) needs the fixture to declare the catalog it stands in
 * for.
 *
 * Two channels exist because the runner is constructed in two places:
 *   - an explicit constructor argument (in-process `runWorker` tests);
 *   - `JOBQUAY_TEST_FIXTURE_CATALOG` in the fixture environment, for the real
 *     MCP -> daemon -> worker path, where the worker process constructs the
 *     runner and cannot receive a constructor argument. The value is a JSON
 *     object `{ok, source, models, defaultModel}`; anything malformed is
 *     ignored (the fixture then behaves exactly as before).
 *
 * Neither channel is reachable in production: the fixture runner itself is a
 * TEST-ONLY executable seam (see the module header).
 */
export function fixtureCatalogFromEnv(env: NodeJS.ProcessEnv): CatalogEvidence | null {
  const raw = typeof env.JOBQUAY_TEST_FIXTURE_CATALOG === "string" ? env.JOBQUAY_TEST_FIXTURE_CATALOG.trim() : "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const source = typeof parsed.source === "string" ? parsed.source.trim() : "";
    const models = Array.isArray(parsed.models)
      ? parsed.models.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim())
      : [];
    if (parsed.ok !== true || !source || models.length === 0) return null;
    const defaultModel = typeof parsed.defaultModel === "string" && parsed.defaultModel.trim() ? parsed.defaultModel.trim() : null;
    return { ok: true, source: source as CatalogEvidence["source"], models, defaultModel };
  } catch {
    return null;
  }
}

/**
 * The TEST-ONLY fixture runner.
 *
 * Without `adapter` it drives the accepted Command Code parser/classifier
 * exactly as before. An optional provider adapter lets a regression exercise
 * ANOTHER provider's adapter (e.g. WorkBuddy AI's ACP terminal semantics)
 * through the SAME job service, spawn seam and durable-state path. The
 * optional `catalog` (or the environment seam above) lets a regression declare
 * the catalog the fixture stands in for so the REAL downgrade chain can be
 * proven.
 */
export function createFixtureRunner(
  fixturePath: string,
  env: NodeJS.ProcessEnv,
  adapter?: ProviderAdapter,
  catalog?: CatalogEvidence | null
): JobRunner {
  if (!fixturePath || !fixturePath.trim()) {
    throw new Error("fixture runner requires a non-empty fixture path");
  }
  const path = fixturePath.trim();
  const catalogEvidence = catalog ?? fixtureCatalogFromEnv(env) ?? UNAVAILABLE_FIXTURE_CATALOG;
  return {
    kind: "fixture",
    // The declared fixture catalog (or the honest unavailable default).
    catalog: catalogEvidence,

    async resolveModel({ explicit, config, now, explicitEffort }): Promise<ModelResolution> {
      // Model selection runs against the declared fixture catalog: configured
      // ids are used as written and are honestly NOT claimed to be verified
      // unless the fixture declared a reliable catalog. This mirrors the
      // production priority order.
      const selection = selectModel({
        explicitModel: explicit,
        config,
        now,
        catalog: catalogEvidence,
        cliDefaultModel: FIXTURE_DEFAULT_MODEL
      });
      if (selection.ok) {
        const effort = explicitEffort !== undefined
          ? (typeof explicitEffort === "string" && explicitEffort.trim() ? explicitEffort.trim() : null)
          : effortForModelSource(config, selection.source, selection.model);
        return { ok: true, model: selection.model, source: selection.source, effort, explicitModel: selection.explicitModel, code: null, error: null };
      }
      return {
        ok: false,
        model: null,
        source: selection.source,
        effort: null,
        explicitModel: selection.explicitModel,
        code: selection.source === "none" ? "model_unavailable" : "model_stale",
        error: selection.error
      };
    },

    async resolveChain({ explicit, config, now, explicitEffort, frozen }): Promise<ModelChainResolution> {
      // The chain is validated against the declared fixture catalog. Without a
      // reliable declaration no downgrade candidate can be PROVEN available:
      // the chain is the single primary and any configured fallback is honestly
      // reported as unverifiable (never called, never substituted). A job that
      // carries the dispatch-time INTENT validates that intent instead of
      // re-reading the config, exactly like the production runner.
      const selection = frozen
        ? selectModelChainFromIntent(frozen, catalogEvidence, explicit, FIXTURE_DEFAULT_MODEL)
        : selectModelChain({
            explicitModel: explicit,
            config,
            now,
            catalog: catalogEvidence,
            cliDefaultModel: FIXTURE_DEFAULT_MODEL,
            explicitEffort
          });
      return {
        ok: selection.ok,
        chain: selection.chain,
        explicitModel: selection.explicitModel,
        code: selection.ok ? null : selection.source === "none" ? "model_unavailable" : "model_stale",
        error: selection.error,
        diagnostics: selection.diagnostics
      };
    },

    buildAttempt(ctx: AttemptContext): BuiltAttempt {
      // `--model <id>` mirrors the production argv's model placement so a fixture
      // child can observe which model the runner actually selected.
      const args = [path, "--model", ctx.model];
      if (ctx.permissionMode) args.push("--permission-mode", ctx.permissionMode);
      if (ctx.effort) args.push("--effort", ctx.effort);
      if (ctx.resumeSessionId) args.push("--resume", ctx.resumeSessionId);
      const launchArgs =
        process.platform === "darwin"
          ? [nodePath.join(__dirname, "fixture-process-wrapper.js"), ...args]
          : args;
      return {
        ok: true,
        file: process.execPath,
        args: launchArgs,
        windowsVerbatimArguments: false,
        shellShim: null,
        cwd: ctx.cwd,
        env
      };
    },

    createState(): StreamState {
      return adapter ? adapter.createStreamState() : createCommandCodeState();
    },
    parseLine(line, state, observedAtMs) {
      if (adapter) adapter.parseStreamLine(line, state, observedAtMs);
      else parseCommandCodeRecord(line, state as ReturnType<typeof createCommandCodeState>);
    },
    normalizeUsage(state): UsageSnapshot {
      return adapter ? adapter.normalizeUsage(state) : normalizeUsage(state as ReturnType<typeof createCommandCodeState>);
    },
    classifyExit(code) {
      return adapter ? adapter.classifyExit(code) : classifyCommandCodeExit(code);
    }
  };
}
