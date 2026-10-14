// provider.ts — the MINIMAL internal provider contract of CrewDispatch.
//
// This is intentionally a small internal provider contract, not a provider SDK:
// there is no plugin loader or public extension API. CrewDispatch launches supported
// user-installed CLIs, reads their public output and classifies their exit codes;
// it never becomes a model provider or reads provider credential databases.
import type { PendingApproval } from "../jobs/approval";

/** A resolved official CLI executable (or an explicit "missing" outcome). */
export interface CliResolution {
  ok: boolean;
  /** Canonical provider id, e.g. "command-code". */
  provider: string;
  /** Absolute/verbatim executable, or null when nothing was resolved. */
  path: string | null;
  /** Where the path came from (env-path, config-path, path-cmdc, missing, ...). */
  source: string;
  /** Human-readable reason, present when ok === false. */
  reason?: string;
}

export interface CliResolveInput {
  /** providers["command-code"].cli.path-equivalent configured value. */
  configPath?: string | null;
  /** providers["command-code"].cli.command-equivalent configured value. */
  configCommand?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Allow a bounded PATH lookup when nothing is configured. Default: true. */
  autoDiscover?: boolean;
  /** Injectable existence check (tests). */
  exists?: (p: string) => boolean;
}

/** A shell-free spawn plan. `shell` is ALWAYS false for the real spawn. */
export interface SpawnPlan {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  /** The .cmd/.bat shim being forwarded through %ComSpec%, or null. */
  shellShim: string | null;
}

export interface RunPlanInput {
  cliPath: string;
  model: string;
  permissionMode: string;
  /** Modes published by the installed CLI's own `--help`, when available. */
  publishedPermissionModes?: readonly string[] | null;
  resumeSessionId?: string | null;
  /** Requested effort level (blank/undefined = the CLI default: no flag). */
  effort?: string | null;
  /** True only when the CLI's own public `--help` published `--effort`. */
  effortSupported?: boolean;
  /**
   * The effort levels THIS model's own published metadata proves (e.g. the
   * installed Command Code package's reference row for the selected model, or
   * the provider's product metadata). A non-empty list is authoritative for
   * this model and a level outside it is REJECTED before any process starts;
   * null/absent means no reliable per-model evidence, so the level is passed
   * through unchanged.
   */
  supportedEfforts?: readonly string[] | null;
  /**
   * True ONLY when the caller can PROVE that no explicit reasoning effort has
   * ever been selected for THIS model on the session being resumed, and the
   * current request is the model default. A provider that resolves the model
   * default to a concrete reported value (for example Command Code ACP's
   * per-model effort option) may then treat that value as the provider's OWN
   * resolution of the default instead of a remembered explicit user level.
   * False/absent means the provenance is unproven, so a null/default request
   * must never silently inherit an observed concrete level.
   */
  effortDefaultProven?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
  /**
   * The owning CrewDispatch attempt, when the caller knows it. A provider whose
   * transport can pause for an interactive user decision uses it to bind the
   * pending request to the exact job + generation (today: the WorkBuddy
   * Desktop bridge writes its approval request/decision files under
   * `<dataRoot>/approval/`). Absent means there is no interactive route and
   * the provider keeps its fully non-interactive behavior unchanged.
   */
  attempt?: { jobId: string; generation: number; dataRoot: string } | null;
}

export type RunPlanResult =
  | { ok: true; argv: string[]; plan: SpawnPlan }
  | { ok: false; stage: "argv" | "spawn"; error: string };

/**
 * The input of one read-only CLI probe. `env` REPLACES the child environment and
 * `cwd` is the child working directory, so a caller can run every probe of a
 * request against the same isolated environment (see `src/cli/run-isolation.ts`).
 */
export interface CliProbeInput {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  comSpec?: string;
  cwd?: string;
}

/** One public, read-only probe of the installed CLI (`--version`, `--help`, `--list-models`). */
export interface CapabilityProbeResult {
  ok: boolean;
  cliPath: string;
  version: string | null;
  /** The raw public `--help` text (bounded), kept as the capability evidence. */
  helpText: string | null;
  /** True only when the CLI's own help publishes an `--effort <level>` option. */
  supportsEffort: boolean;
  /** Permission modes the CLI published in its help; empty when unreadable. */
  permissionModes: string[];
  /** Per-probe error text; an honest failure is never downgraded to "unknown". */
  errors: string[];
}

export interface ModelCatalogResult {
  ok: boolean;
  /** CLI command that published ids, or "unavailable" when no catalog was returned. */
  source:
    | "cli-list-models"
    | "cli-help-models"
    | "cli-control-models"
    | "installed-package-reference"
    | "workbuddy-product-snapshot"
    | "unavailable";
  models: string[];
  /** The id the CLI itself marked as default, or null when it published none. */
  defaultModel: string | null;
  /** Model ids whose own published catalog row explicitly marks the price/tag as FREE. */
  freeModels?: string[];
  /** Verbatim (bounded) CLI output, kept as evidence. */
  raw: string | null;
  error: string | null;
}

/**
 * Usage as the CLI reported it. `null` = unavailable, never a fabricated 0.
 *
 * A metric is a number ONLY when the CLI reported it or it is a verifiable
 * computation from reported values; a genuinely reported 0 stays 0. `toolCalls`
 * is shown only when the stream carried tool evidence (an explicit count or at
 * least one tool event) — a run that never mentioned tools reports null.
 *
 * ADDITIVE vs GAUGE (the canonical telemetry contract):
 *   - ADDITIVE metrics (tokensIn, tokensOut, toolCalls, cacheRead, cacheMiss,
 *     cacheCreation, credits, totalCostUsd, decodeTokens, decodeSeconds)
 *     accumulate over a run: each reported observation is a delta or a
 *     per-request value that is added exactly once.
 *   - GAUGE metrics (contextUsed, contextWindow) describe ONE instant — the
 *     latest model request's context occupancy and the model's context window.
 *     A later observation REPLACES an earlier one; a run total must never sum
 *     them (see `totalUsage`).
 *
 * A provider adapter maps its own protocol's usage records onto exactly these
 * fields; the Hub and the shared UI renderer never branch on a provider id.
 */
export interface UsageSnapshot {
  tokensIn: number | null;
  tokensOut: number | null;
  toolCalls: number | null;
  cacheRead: number | null;
  cacheMiss: number | null;
  cacheCreation: number | null;
  credits: number | null;
  totalCostUsd: number | null;
  /**
   * PAIRED decode numerator (the official deepseek-harness `sessionStats`
   * fold): output tokens of completed responses that also proved their own
   * first-token instant AND assembled/final response instant. A response
   * missing any fact contributes nothing; `decodeTokens / decodeSeconds` is
   * therefore a ratio of sums over exactly the same responses — never the
   * run's total `tokensOut` and never an average of per-response rates.
   */
  decodeTokens: number | null;
  /**
   * PAIRED decode denominator: summed seconds from first meaningful non-empty
   * token to the assembled/final response, covering EXACTLY the responses
   * counted by `decodeTokens` — prefill/TTFT and tool execution excluded, the
   * internal reasoning→answer gap included. Never the run's total active
   * model-output time. `null` when no response was paired.
   */
  decodeSeconds: number | null;
  /**
   * GAUGE: tokens occupying the model's context window at the provider's LATEST
   * reported observation (typically the last request's input tokens). `null`
   * when the provider publishes no context-occupancy evidence.
   */
  contextUsed: number | null;
  /**
   * GAUGE: the model's context window size in tokens, as the provider published
   * it. `null` when the provider does not publish a window size.
   */
  contextWindow: number | null;
}

export interface StreamState {
  step: string;
  currentTool: string | null;
  finalResult: string | null;
  lastAssistantText: string | null;
  terminal: boolean;
  resultSubtype: string | null;
  isError: boolean;
  stopReason: string | null;
  /**
   * The provider's more specific terminal cause when its terminal record
   * carried one (canonical `finish_reason`), else null. Diagnostic refinement
   * only: it never changes the stop reason or the failure classification.
   */
  finishReason: string | null;
  /**
   * The provider's bounded, display-safe terminal error detail when its
   * terminal record carried one (canonical `error_detail`), else null. The
   * provider boundary is responsible for sanitization; this is a diagnostic
   * refinement only and never changes the classification or `finishReason`.
   */
  errorDetail: string | null;
  /**
   * The bounded approval outcome token when the turn's terminal record carried
   * one (canonical `approval_outcome`), else null. It says WHY an interactive
   * approval gate did not proceed — a real selected reject option, an expiry,
   * a missing route, or an abandoned wait — so a completed turn whose gated
   * operation never ran is never presented as an unqualified success and a
   * missing route is never reported as a human refusal. Diagnostic evidence
   * only: it never changes the stop reason, the status or the failure class.
   */
  approvalOutcome: string | null;
  model: string | null;
  actualModel: string | null;
  sessionId: string | null;
  errorMsg: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  malformedLines: number;
  unknownLines: number;
  diagTail: string;
  /**
   * The provider-neutral pending approval a running turn is waiting on, or
   * null. A provider whose transport can pause for a user decision (today:
   * WorkBuddy ACP `session/request_permission`) publishes a bounded,
   * display-safe description here; the job service persists it as the job's
   * `pendingApproval` while the job stays honestly `running`. A resolved/
   * expired/abandoned approval is published as `null`, so the state can never
   * outlive the request it describes.
   */
  approval: PendingApproval | null;
}

export interface ExitClassification {
  kind: string;
  failureKind: string | null;
  stopReason: string | null;
  /** Stop immediately: auth / permission / insufficient credits. */
  fatal: boolean;
  /** May advance the model fallback chain: ONLY a real model rate limit. */
  fallback: boolean;
}

/**
 * The one contract a CrewDispatch provider implementation satisfies.
 *
 * Kept deliberately small: discovery/capability probe, model catalog, run plan,
 * stream parsing and exit classification. Spawn/resume/cancel, jobs, MCP, Hub
 * and the installer are later batches.
 */
/**
 * LONG-TURN LIVENESS POLICY
 *
 * A real coding-agent turn has no CrewDispatch wall-clock or idle deadline: it may
 * legitimately run for hours. Only bounded setup/probe/control operations use
 * timeouts. A running turn ends when the provider returns, reports an explicit
 * error/disconnect, or the user cancels it.
 */

// ---------------------------------------------------------------------------
// Provider-owned turn cancellation (JQ-20261006-58)
// ---------------------------------------------------------------------------
//
// Some providers do NOT run the turn inside the process tree CrewDispatch
// spawned. WorkBuddy AI is one: its disposable bridge only opens a control
// connection to the WorkBuddy Desktop sidecar and drives a turn that the
// sidecar-owned ACP RUNTIME executes — the turn's tool processes are children of
// that runtime, never of CrewDispatch's child. Killing CrewDispatch's tree
// therefore stops the bridge, not the work.
//
// So cancellation needs a second, provider-owned route: ask the provider to
// cancel the EXACT session/turn over its own protocol. The protocol lives in the
// provider (this contract only defines the request/answer shape); the generic
// lifecycle (when to ask, what to prove before claiming `cancelled`) stays in
// `src/jobs/provider-cancel.ts` and `src/jobs/service.ts`.

/** One provider-owned turn CrewDispatch wants cancelled. */
export interface ProviderTurnCancelInput {
  provider: string;
  /** The CrewDispatch job that owns the turn. */
  jobId: string;
  /** The CrewDispatch generation that owns the turn. */
  generation: number;
  /**
   * The provider's OWN session id of the EXACT session/turn to cancel (today:
   * the WorkBuddy ACP session id published by the bridge's init record), or null
   * when the provider turn was never established. A provider MUST NOT cancel
   * anything else — no "the whole runtime", no "every session".
   */
  sessionId: string | null;
  cwd: string;
  model: string | null;
  permissionMode: string;
  effort: string | null;
  /** The resolved official CLI path the run used, when it can be resolved. */
  cliPath: string | null;
  /**
   * The CrewDispatch-spawned child of this generation (the disposable bridge),
   * when known. A provider whose cancellation is relayed by that live child
   * (WorkBuddy AI: the runtime routes `session/cancel` only to the connection
   * that owns the in-flight prompt) binds its control handshake to this exact
   * incarnation, so an acknowledgment from any other process can never be
   * accepted as this turn's cancellation.
   */
  childPid: number | null;
  /** Epoch ms this attempt's child was spawned (scopes owned processes). */
  attemptStartedAtMs: number | null;
  /**
   * The CrewDispatch data root. The generic lifecycle owns this directory; a
   * provider control channel bound to a live provider child (WorkBuddy AI's
   * bridge cancel requests) writes its generation-scoped handshake files here
   * and nowhere else.
   */
  dataRoot: string;
}

/** What ONE provider-owned cancellation attempt proved. */
export interface ProviderTurnCancelResult {
  /** Stable route token (evidence), e.g. "workbuddy-acp-session-cancel". */
  route: string | null;
  /**
   * True ONLY when the provider asked its own runtime to cancel the EXACT
   * session/turn identified by `sessionId`. Never true for a broader action.
   */
  requested: boolean;
  /** The exact provider session the cancellation was requested for. */
  sessionId: string | null;
  /**
   * Provider-owned process roots that host THIS turn's work (today: the
   * sidecar's ACP runtime process). Empty when the provider could identify none.
   * It NEVER contains the shared daemon itself.
   */
  ownedRoots: number[];
  /**
   * True ONLY when the exact session/turn cancellation was DELIVERED but the
   * provider could not prove which process root hosts the turn (for example a
   * matched runtime that published no usable PID). Empty `ownedRoots` then means
   * UNKNOWN attribution — NEVER "no owned work" — so the generic lifecycle must
   * retain unresolved evidence and must not claim `cancelled`. Absent/false
   * means an empty `ownedRoots` is the provider's honest "no owned work".
   */
  ownershipUnknown?: boolean;
  /**
   * The provider-scoped key of the shared execution slot this turn occupies
   * (null when the provider has no shared slot / cannot name it). The generic
   * layer uses it to prove no OTHER live CrewDispatch job shares the slot before
   * any owned process is touched.
   */
  slotKey: string | null;
  /**
   * Stable diagnostic code — null on success. Bounded evidence only:
   * "no_provider_session" | "cli_unavailable" | "sidecar_unavailable" |
   * "runtime_not_found" | "cancel_failed" | a provider-scoped token.
   */
  detail: string | null;
}

/** Bounded, injectable seams for a provider cancellation route. */
export interface ProviderCancelDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Disposable temp root for provider control sockets/pid files (tests). */
  tmpDir?: string;
  /** Disposable provider config dir (tests). */
  configDir?: string;
  /** Injectable HTTP transport (tests). */
  fetchImpl?: typeof fetch;
  /** Provider-specific transport override (tests); typed by the provider. */
  transport?: unknown;
  /**
   * Bounded override of a provider control-channel acknowledgment wait (tests /
   * tight boundaries). Only ever SHORTENS a bounded control handshake — it can
   * never extend one beyond the provider's own ceiling.
   */
  cancelAckWaitMs?: number;
}

/**
 * The shared execution slot a turn would occupy, or null.
 *
 * Two turns that share a slot share provider-owned processes. The generic cancel
 * path must never stop a slot's processes while another live CrewDispatch job
 * occupies the same slot.
 */
export interface ProviderTurnSlotInput {
  /** Exact accepted attempt for a provider that gives each attempt a private runtime. */
  jobId?: string;
  generation?: number;
  dataRoot?: string;
  cliPath: string | null;
  permissionMode: string;
  effort: string | null;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}
export interface ProviderResourceMaintenanceInput {
  dataRoot: string;
  /** Terminal attempts with no managed child. The adapter must also prove its native turn settled, or use turnResolved. */
  terminalAttempts: readonly { jobId: string; generation: number; turnResolved?: boolean }[];
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** OPTIONAL bounded native resource cleanup; never changes jobs/results/notifications. */
  maintainResources?(input: ProviderResourceMaintenanceInput): Promise<void>;
  resolveCli(input: CliResolveInput): CliResolution;
  probeCapabilities(input: CliProbeInput): Promise<CapabilityProbeResult>;
  readModelCatalog(input: CliProbeInput): Promise<ModelCatalogResult>;
  buildRunPlan(input: RunPlanInput): RunPlanResult;
  createStreamState(): StreamState;
  parseStreamLine(line: string, state: StreamState, observedAtMs?: number): StreamState;
  normalizeUsage(state: StreamState): UsageSnapshot;
  classifyExit(code: unknown): ExitClassification;
  /**
   * OPTIONAL. Cancel the EXACT provider session/turn whose work runs OUTSIDE the
   * process tree CrewDispatch spawned, and name the provider-owned roots that
   * host it. Absent means the provider runs everything inside the spawned tree,
   * so the ordinary tree kill remains the whole cancellation story.
   *
   * Every wait inside this call is bounded: it is a control handshake, never a
   * wall-clock limit on a real turn.
   */
  cancelTurn?(input: ProviderTurnCancelInput, deps?: ProviderCancelDeps): Promise<ProviderTurnCancelResult>;
  /** OPTIONAL. The shared execution slot a turn would occupy (see above). */
  turnSlotKey?(input: ProviderTurnSlotInput): string | null;
}
