// runner.ts — the small seam that lets the job service drive either the REAL
// accepted Command Code adapter (production) or a controlled executable fixture
// (tests only).
//
// Production uses ONLY the accepted batch-1 adapter for argv, spawn plan, stream
// parser, usage normalisation and exit classification — this module adds no
// provider behaviour of its own. The fixture runner (src/cli/fixture-runner.ts)
// reuses the SAME production stream parser and exit classifier, so a fixture
// exercises the real pipeline except for the executable itself.
//
// The production runner does NOT isolate the CLI profile: it launches the
// user-installed official CLI in the JOB'S requested cwd with the owning
// process's runtime environment, so the user's own official login/account is
// used. A disposable isolated profile is a TEST concern, created at the harness
// boundary (see src/cli/run-isolation.ts).
import fs from "node:fs";
import type {
  CapabilityProbeResult,
  ExitClassification,
  ModelCatalogResult,
  ProviderAdapter,
  StreamState,
  UsageSnapshot
} from "../providers/provider";
import { effortForModelSource, selectModel, selectModelChain, selectModelChainFromIntent } from "../config/select";
import type { CatalogEvidence, ModelDiagnostic } from "../config/select";
import type { CrewDispatchConfig } from "../config/schema";
import { SESSION_TOKEN_RE } from "../providers/command-code/argv";
import { WORKBUDDY_AI_PROVIDER } from "../providers/workbuddy-ai/index";
import type { AcceptedModelIntent, JobRecord, ModelSource, RunnerKind } from "./types";

/** Canonical provider ids the job service can dispatch. */
export const COMMAND_CODE_PROVIDER = "command-code";
export { WORKBUDDY_AI_PROVIDER };

/** Whether a raw CLI session id may be persisted / resumed. */
export function isValidSessionIdFor(_provider: string, id: unknown): boolean {
  return typeof id === "string" && !!id && SESSION_TOKEN_RE.test(id);
}

/** Everything one attempt needs to build its spawn plan. */
export interface AttemptContext {
  jobId: string;
  generation: number;
  prompt: string;
  model: string;
  permissionMode: string;
  effort: string | null;
  /**
   * Proven model-default effort provenance for a RESUMED attempt: true only
   * when the worker can prove this job never selected an explicit effort for
   * THIS model on the owned session it resumes (see `RunPlanInput`).
   */
  effortDefaultProven?: boolean;
  /** Session id to `--resume` (null for a fresh first attempt). */
  resumeSessionId: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BuiltAttempt =
  | { ok: true; file: string; args: string[]; windowsVerbatimArguments: boolean; shellShim: string | null; cwd: string; env: NodeJS.ProcessEnv }
  | { ok: false; error: string };

/**
 * Validate the cwd a job asked for. The PRODUCT launches the official CLI in the
 * caller's requested workspace, so a missing/non-directory cwd is an honest
 * pre-spawn error, never a silent fallback to a disposable directory.
 */
export function validateAttemptCwd(cwd: unknown): { ok: true; cwd: string } | { ok: false; error: string } {
  const value = typeof cwd === "string" ? cwd.trim() : "";
  if (!value) return { ok: false, error: "The job is missing its working directory (cwd), so the official CLI cannot be started." };
  let isDir = false;
  try {
    isDir = fs.statSync(value).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { ok: false, error: `The job working directory does not exist or is not a directory: ${value}` };
  return { ok: true, cwd: value };
}

export interface ModelResolveInput {
  /** The per-job explicit override (null when the caller did not specify one). */
  explicit: string | null;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The persisted CrewDispatch config (default model, time slots, ...). */
  config: CrewDispatchConfig;
  /** The instant the slots are evaluated against (local wall clock). */
  now: Date;
  /**
   * The per-job EXPLICIT effort for the primary candidate only: `undefined` =
   * not supplied (the resolved source's configured effort applies), `null` =
   * explicit provider/model default. Later fallback candidates always use their
   * OWN configured effort.
   */
  explicitEffort?: string | null;
  /**
   * The model/effort INTENT frozen at dispatch (v11). When present the resolver
   * VALIDATES it against the CLI's own catalog instead of re-reading the live
   * config, so a Settings edit made while the job was queued cannot change the
   * accepted model/effort pair. Absent/null for a legacy record, which resolves
   * from the current config exactly as before.
   */
  frozen?: AcceptedModelIntent | null;
}

export interface ModelResolution {
  ok: boolean;
  model: string | null;
  /** Where the model came from (persisted on the job). */
  source: ModelSource | null;
  /** The reasoning effort the primary resolved to (null = provider/model default). */
  effort: string | null;
  /** The explicit override seen (echoed so the caller can persist it). */
  explicitModel: string | null;
  /** Stable failure code when `ok === false` (`model_stale` / `model_unavailable`). */
  code: string | null;
  error: string | null;
}

/** One candidate of the rate-limit downgrade chain (see config/select.ts). */
export interface ModelCandidate {
  model: string;
  source: ModelSource;
  /** The candidate's own reasoning effort; null = the provider/model default. */
  effort: string | null;
}

export interface ModelChainResolution {
  ok: boolean;
  /** Ordered, canonical-id-deduped candidates (primary first), at most 3. */
  chain: ModelCandidate[];
  explicitModel: string | null;
  /** Stable failure code when `ok === false` (`model_stale` / `model_unavailable`). */
  code: string | null;
  error: string | null;
  diagnostics: ModelDiagnostic[];
}

export interface JobRunner {
  readonly kind: RunnerKind;
  /**
   * The CLI catalog evidence this runner was built with. The in-flight boundary
   * switch uses it to PROVE a target model before it ever restarts a generation
   * (an unreliable catalog yields no boundary at all).
   */
  readonly catalog: CatalogEvidence;
  /** Resolve the model to use (never invents an id when the catalog is unavailable). */
  resolveModel(input: ModelResolveInput): Promise<ModelResolution>;
  /**
   * Resolve the ordered rate-limit downgrade CANDIDATE CHAIN (primary, then the
   * configured default, then the configured final fallback). Only the primary is
   * ever dispatched first; the rest are reached one at a time, at most once
   * each, and ONLY after a clear model rate limit.
   */
  resolveChain(input: ModelResolveInput): Promise<ModelChainResolution>;
  buildAttempt(ctx: AttemptContext): BuiltAttempt;
  createState(): StreamState;
  parseLine(line: string, state: StreamState, observedAtMs?: number): void;
  normalizeUsage(state: StreamState): UsageSnapshot;
  classifyExit(code: unknown): ExitClassification;
  /** Optional close-boundary hook for a provider that needs final stream reconciliation. */
  finalizeOnExit?(state: StreamState, exitCode: number | null): void;
  /** True when exit code 8 is the CLI's own resumable internal segment boundary. */
  exit8IsSegment?: boolean;
}

export interface RunnerBuildContext {
  job: JobRecord;
  root: string;
  env: NodeJS.ProcessEnv;
  cliPath: string | null;
}

export type CreateRunner = (ctx: RunnerBuildContext) => Promise<JobRunner>;

export interface CommandCodeRunnerInput {
  adapter: ProviderAdapter;
  cliPath: string;
  capabilities: CapabilityProbeResult;
  catalog: ModelCatalogResult;
  runnerKind?: RunnerKind;
  /**
   * The CrewDispatch data root this attempt runs under, when the caller knows it. It
   * is passed to the provider's run plan so a provider that can pause for an
   * interactive user decision can bind its pending request to the exact
   * job+generation (WorkBuddy's Desktop bridge). Null/absent means no
   * interactive route exists and the provider stays non-interactive.
   */
  dataRoot?: string | null;
  attemptEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /**
   * RELIABLE per-model reasoning-effort lists (model id → published levels),
   * gathered from the provider's own local metadata during this run's setup.
   * Used ONLY to refuse an incompatible model+effort before a process starts:
   * a model absent from this map has no reliable evidence, so its requested
   * effort is passed through exactly as before. Never persisted, never used to
   * rewrite the saved configuration.
   */
  effortsByModel?: Readonly<Record<string, readonly string[]>> | null;
}

/**
 * The production runner. Argv, spawn plan, stream parsing, usage and exit
 * classification all come straight from the accepted adapter.
 *
 * The runner is deliberately STATELESS about cwd/env: every attempt supplies
 * them from the job record and the owning process's runtime environment, so the
 * product launches the user-installed official CLI in the requested workspace
 * with the caller's own login — never in a per-job isolation tree.
 */
export function createCommandCodeRunner(input: CommandCodeRunnerInput): JobRunner {
  const { adapter, cliPath, capabilities, catalog } = input;
  // Command Code trusts its own --list-models evidence. WorkBuddy AI trusts
  // its own resolved Product Configuration snapshot first, then its bundled
  // read-only get_available_models / --help fallbacks; none of those sources
  // weaken the Command Code path.
  const acceptedSource =
    catalog.source === "cli-list-models" ||
    (input.runnerKind === "workbuddy-ai" &&
      (catalog.source === "workbuddy-product-snapshot" ||
        catalog.source === "cli-control-models" ||
        catalog.source === "cli-help-models"));
  const commandCatalog: CatalogEvidence = {
    ok: catalog.ok && acceptedSource,
    source: acceptedSource ? catalog.source : "unavailable",
    models: acceptedSource ? [...catalog.models] : [],
    defaultModel: acceptedSource ? catalog.defaultModel : null
  };
  return {
    kind: input.runnerKind ?? "command-code",
    catalog: commandCatalog,
    // Command Code's own internal segment boundary (exit 8 / `max_turns`).
    exit8IsSegment: true,

    async resolveModel({ explicit, config, now, explicitEffort }): Promise<ModelResolution> {
      if (input.runnerKind === "workbuddy-ai" && !commandCatalog.ok) {
        const explicitModel = typeof explicit === "string" && explicit.trim() ? explicit.trim() : null;
        return {
          ok: false,
          model: null,
          source: explicitModel ? "explicit" : config.defaultModel ? "config-default" : "none",
          effort: null,
          explicitModel,
          code: "catalog_unavailable",
          error: "Cannot read the model catalog published by the official WorkBuddy AI CLI, so the configured model cannot be proven available."
        };
      }
      // The decision itself is the PURE shared `selectModel`: explicit override >
      // enabled time slot (top-to-bottom, cross-midnight aware) > configured
      // default > the CLI catalog's own default. A configured id that is not in a
      // RELIABLE CLI catalog is reported as stale and never substituted.
      const selection = selectModel({
        explicitModel: explicit,
        config,
        now,
        catalog: commandCatalog
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
      if (input.runnerKind === "workbuddy-ai" && !commandCatalog.ok) {
        return {
          ok: false,
          chain: [],
          explicitModel: typeof explicit === "string" && explicit.trim() ? explicit.trim() : null,
          code: "catalog_unavailable",
          error: "Cannot read the model catalog published by the official WorkBuddy AI CLI, so the configured model cannot be proven available.",
          diagnostics: []
        };
      }
      // A fresh job validates the model/effort INTENT frozen at dispatch (so a
      // Settings edit made while it was queued cannot change the accepted pair);
      // a legacy record without one resolves from the current config. Either way
      // the primary keeps the existing selection and the configured default /
      // final fallback are appended ONLY when the installed CLI's own public
      // catalog proves the exact id (a stale/unverifiable candidate is never
      // called and never substituted).
      const selection = frozen
        ? selectModelChainFromIntent(frozen, commandCatalog, explicit)
        : selectModelChain({
            explicitModel: explicit,
            config,
            now,
            catalog: commandCatalog,
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

    buildAttempt(ctx): BuiltAttempt {
      const cwd = validateAttemptCwd(ctx.cwd);
      if (!cwd.ok) return { ok: false, error: cwd.error };
      const plan = adapter.buildRunPlan({
        cliPath,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        publishedPermissionModes: capabilities.permissionModes,
        resumeSessionId: ctx.resumeSessionId,
        effort: ctx.effort,
        effortSupported: capabilities.supportsEffort,
        // The SELECTED model's own published levels, when this run's setup read
        // reliable per-model evidence. `--effort` is not a global enum, so a
        // level the model does not publish is refused HERE — before the spawn
        // plan exists — instead of failing on the CLI's first line.
        supportedEfforts: input.effortsByModel?.[ctx.model] ?? null,
        // The worker's proven model-default provenance for a resumed attempt.
        // Absent/false keeps the provider's resumed-session guard fully strict.
        effortDefaultProven: ctx.effortDefaultProven === true,
        // The owning attempt identity, so a provider with an interactive
        // approval transport can bind its pending request to this exact
        // job+generation (never a later one).
        attempt: input.dataRoot ? { jobId: ctx.jobId, generation: ctx.generation, dataRoot: input.dataRoot } : null
      });
      if (!plan.ok) return { ok: false, error: `Run plan build failed (${plan.stage}): ${plan.error}` };
      return {
        ok: true,
        file: plan.plan.file,
        args: plan.plan.args,
        windowsVerbatimArguments: plan.plan.windowsVerbatimArguments,
        shellShim: plan.plan.shellShim,
        cwd: cwd.cwd,
        env: input.attemptEnv ? input.attemptEnv(ctx.env) : ctx.env
      };
    },

    createState() {
      return adapter.createStreamState();
    },
    parseLine(line, state, observedAtMs) {
      adapter.parseStreamLine(line, state, observedAtMs);
    },
    normalizeUsage(state) {
      return adapter.normalizeUsage(state);
    },
    classifyExit(code) {
      return adapter.classifyExit(code);
    }
  };
}
