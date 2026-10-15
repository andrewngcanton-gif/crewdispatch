// server.ts — the CrewDispatch stdio MCP entry (M1 batch 3).
//
// Built on the OFFICIAL MCP TypeScript SDK v2 (`@modelcontextprotocol/server`
// 2.1.0 + its `/stdio` entry + `zod` v4) — chosen because it is the current
// stable official line, it ships a CommonJS build that compiles under this
// repo's existing `module: commonjs` / TS 5.9 tsconfig WITHOUT changing the
// accepted business layer, and its stdio entry performs the real MCP handshake
// and negotiates the protocol version with the client (including older clients)
// instead of a hand-rolled JSON-RPC loop that could miss handshake/protocol
// compatibility; the public architecture contract keeps this alias explicit.
//
// The dispatch tools expose Command Code (default) and WorkBuddy AI. Their
// provider settings remain separate. The data root is CrewDispatch's own
// (`JOBQUAY_DATA_ROOT` or the product default).
//
// stdout is the JSON-RPC channel: all diagnostics go to stderr.
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { JobStoreError } from "../jobs/store";
import {
  cancelJob,
  followUpJob,
  jobResult,
  jobStatus,
  runJob,
  settingsGet,
  settingsUpdate,
  spawnJob,
  toolError,
  type ToolDeps,
  type ToolResult
} from "./tools";

export const SERVER_NAME = "crewdispatch";
export const SERVER_VERSION = "0.1.6";

const THREAD_ID_DESC =
  "Codex thread id to wake on completion. Read your own $CODEX_THREAD_ID ONCE in a local no-LLM shell and pass it here: a long-running MCP server does not reliably inherit it, and a client disconnect must not lose the wake. Must be a valid Codex session UUID or session name. Wake priority is callback_url > Claude session/binding > codex_thread_id > CODEX_THREAD_ID env fallback.";

const CLAUDE_BINDING_COMMON =
  "Optional local Claude Code caller binding for THIS conversation. Pass the opaque value from the CrewDispatch SessionStart binding line shown in this conversation — never a socket address, an authentication token or an id read from another session. The binding is resolved by the CrewDispatch worker from its private local store; a missing/stale binding is a truthful delivery failure, not a fallback to a different conversation. Wake priority is callback_url > Claude session/binding > codex_thread_id > CODEX_THREAD_ID env fallback; competing explicit caller identities are rejected.";
const CLAUDE_SESSION_DESC = `claude_session_id: the session identity form. ${CLAUDE_BINDING_COMMON}`;
const CLAUDE_BINDING_DESC = `claude_binding_id: the registered binding reference form (use it when the binding line shows one). ${CLAUDE_BINDING_COMMON}`;

const CALLBACK_DESC =
  "Optional http(s) URL (e.g. a loopback listener). If set, the short terminal body {job_id, status} is POSTed here exactly once per terminal generation. Takes priority over codex_thread_id and Claude session bindings.";

const PERMISSION_MODE_DESC =
  "Omit unless the user chooses a permission mode; saved provider settings apply. For standard mode, Command Code uses `standard` (`default` is accepted); WorkBuddy AI uses `default`. Honor other requested modes supported by the CLI. The provider decides when tool execution needs human approval.";

// Provider-neutral framing for the two first-release provider routes. Omitting
// `provider` preserves the Command Code default; WorkBuddy AI is explicit.
const PROVIDER_DESC =
  "Optional provider of the coding-agent CLI to drive. `command-code` is the DEFAULT. `workbuddy-ai` drives the user-installed international WorkBuddy AI CLI with its isolated CODEBUDDY_CONFIG_DIR profile. Omit to use Command Code. " +
  "When `provider` is `command-code` (default) the saved Command Code settings apply. " +
  "When `provider` is `workbuddy-ai`, an explicit `model` overrides its saved provider default; otherwise the WorkBuddy AI default model saved in the local Hub Settings is used. CrewDispatch probes and launches the same isolated WorkBuddy AI profile and deliberately never falls back to the domestic codebuddy executable on PATH. WorkBuddy AI has its own default/fallback/permission/effort settings, but no time slots or in-flight clock switching.";

const PACKET_DESC =
  "The task text, passed to the SELECTED PROVIDER's official CLI VERBATIM (no prefix, no parent history, no credential, no boilerplate is added). Send a compact, EVIDENCE-LED task packet: " +
  "(1) objective, the workspace cwd, and the specific files/functions or subsystem the worker owns — state that other work may coexist and must not be reverted; " +
  "(2) directly observed failure evidence and the relevant production call path (if either is unknown, say so and assign INVESTIGATION rather than a guess); " +
  "(3) required user-visible behavior, invariants, compatibility and safety limits, including what external state may and may not change; " +
  "(4) a finite acceptance matrix matched to the REAL boundary (pure-logic tests for pure logic; a real separate process/entry for process, persistence or notification behavior), including cleanup of test processes and disposable data; " +
  "(5) a short final report format separating IMPLEMENTATION from ACCEPTANCE, with exact commands, external evidence and remaining gaps. " +
  "Never include the parent conversation, a whole-repo search, credentials, real transcripts or oversized logs. Do NOT pad a simple task to fill the template.";

const SETTINGS_HINT =
  "(Command Code only — applies when provider=command-code, the default. It does NOT apply to provider=workbuddy-ai.) " +
  "When `model` is omitted, the model is chosen ONCE at job startup from the saved CrewDispatch settings: explicit per-job model > the first enabled time slot matching the local time (top-to-bottom priority, cross-midnight aware) > the configured default model > the official CLI catalog default. " +
  "A rate-limit DOWNGRADE chain is built from primary > configured default model > configured final fallback model (canonical-id deduped, max 3). ONLY a clear model rate limit (official exit code 5) advances it — one candidate at a time, at most once each, resuming the SAME job/session with a short internal recovery prompt (never the full task again). Auth (3), permission (4), insufficient credits (10), network, unknown and a user cancel never downgrade. " +
  "The in-flight time-slot switch IS active under its conditions: when the toggle is ON, the job has no explicit model, a reliable official catalog and a resumable session, a RUNNING job is moved to the new model at a configured time-slot boundary — CrewDispatch safely stops the old CLI tree (exit confirmed) and resumes the SAME job/session in a new generation. When OFF, or the switch cannot be safely proven (no recorded session, a stale model, an unreliable catalog, or the old tree not confirmed stopped), it does NOT switch and the job keeps its current model.";

const WAKE_HINT =
  "On a terminal completion a notification is ATTEMPTED once (see notify); collect the result exactly ONCE with crewdispatch_result and do NOT poll status in a loop. " +
  "ALWAYS pass the caller identity for THIS conversation explicitly: Codex clients read $CODEX_THREAD_ID ONCE in a local no-LLM shell and pass codex_thread_id (a long-running MCP server does not reliably inherit it); Claude Code clients pass the claude_session_id or claude_binding_id from the CrewDispatch SessionStart binding line shown in this conversation. " +
  "Wake priority is callback_url > Claude session/binding > codex_thread_id > CODEX_THREAD_ID env fallback.";

/** Build the MCP server instance; `deps` carries the data root and test seams. */
export function createCrewDispatchServer(deps: ToolDeps = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const guard = async (fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (e) {
      // A storage-level refusal carries its OWN stable code (e.g.
      // `schema_too_new` for a job record written by a NEWER build): surface it
      // verbatim instead of flattening a diagnosable rollback boundary into
      // `internal_error`. The message is the refusal text; no stack is exposed.
      if (e instanceof JobStoreError) return toolError(e.code, e.message);
      return toolError("internal_error", String((e as Error)?.message || e));
    }
  };

  server.registerTool(
    "crewdispatch_spawn",
    {
      title: "Dispatch a long-running coding-agent job (async)",
      description:
        "Dispatch a task asynchronously and return a stable job id immediately. The MCP client submits to CrewDispatch's independent local daemon/broker, which owns the worker; therefore a closed MCP request, an ended Codex/Claude client process or a caller timeout does not cancel accepted work — only crewdispatch_cancel does. On the first accepted CrewDispatch dispatch for this data root, the response also contains dashboard_hint; surface that hint to the user once when present and do not invent or repeat it when absent. " +
        PROVIDER_DESC +
        " " +
        SETTINGS_HINT +
        " " +
        PACKET_DESC +
        " " +
        WAKE_HINT,
      inputSchema: z.object({
        task: z.string().describe("The evidence-led task packet, passed to the selected provider's CLI verbatim."),
        cwd: z.string().describe("Absolute workspace directory the worker owns."),
        provider: z.enum(["command-code", "workbuddy-ai"]).optional().describe("Optional provider: `command-code` (default) or `workbuddy-ai` (international WorkBuddy AI CLI with isolated profile). WorkBuddy AI may use its saved provider default model."),
        model: z.string().optional().describe("Optional explicit model id. For provider=command-code it overrides the saved default. For provider=workbuddy-ai it overrides the saved WorkBuddy AI default; when omitted, that provider default must be configured and verified against the isolated WorkBuddy AI CLI catalog."),
        permission_mode: z.string().optional().describe(PERMISSION_MODE_DESC),
        effort: z.string().nullable().optional().describe("Optional reasoning effort for the INITIAL selected model only (Command Code or WorkBuddy AI, only when the selected CLI advertises --effort). Omit it to use the configured effort that belongs to the resolved model; pass null for the model's own provider default. A later configured rate-limit fallback candidate always uses ITS OWN configured effort."),
        codex_thread_id: z.string().optional().describe(THREAD_ID_DESC),
        claude_session_id: z.string().optional().describe(CLAUDE_SESSION_DESC),
        claude_binding_id: z.string().optional().describe(CLAUDE_BINDING_DESC),
        callback_url: z.string().optional().describe(CALLBACK_DESC),
        client_run_id: z.string().optional().describe("Optional caller-side run correlation id (opaque: CrewDispatch does not interpret, store or echo it). An external driver passes its own run id here so a rollout scanner can attribute this exact spawn to one run when several runs share a Codex thread.")
      })
    },
    async (args) => guard(() => spawnJob(args, deps))
  );

  server.registerTool(
    "crewdispatch_status",
    {
      title: "Job status (one job or a bounded list)",
      description:
        "With `id`: the bounded status of one job. Without `id`: a bounded list of all known jobs (ids + statuses only). Reads the durable local store; never polls the network.",
      inputSchema: z.object({ id: z.string().optional().describe("Job id from crewdispatch_spawn.") })
    },
    async (args) => guard(() => jobStatus(args, deps))
  );

  server.registerTool(
    "crewdispatch_result",
    {
      title: "Collect a job result once",
      description:
        "One-shot compact result for a job: the bounded terminal result when the job is settled, otherwise its current status. Call this exactly once after a completion wake — do not poll it in a loop. A TERMINAL result carries a short `continuation_hint` advisory naming the same job id: a defect in the SAME objective defaults to crewdispatch_follow_up on that job with a precise repair packet, while crewdispatch_spawn is for an independent new objective. When an external controller owns acceptance, only its explicit repair instruction permits a follow-up. The advisory adds no automatic dispatch, continuation or retry; the existing terminal-wake recovery in crewdispatch_result is unchanged.",
      inputSchema: z.object({ id: z.string().describe("Job id from crewdispatch_spawn.") })
    },
    async (args) => guard(() => jobResult(args, deps))
  );

  server.registerTool(
    "crewdispatch_follow_up",
    {
      title: "Continue the same job/session",
      description:
        "Send a follow-up message to an already-terminal job. It continues the SAME logical job and provider session (`--resume`) as a new generation — the job id is unchanged and the generation advances. This is the default action when acceptance finds defects in the SAME objective (send a precise repair packet); use crewdispatch_spawn only for an independent new objective. When an external controller owns acceptance, only its explicit repair instruction permits a follow-up. Only a terminal job can be continued.",
      inputSchema: z.object({
        id: z.string().describe("Job id from crewdispatch_spawn."),
        message: z.string().describe("The follow-up instruction, passed to the CLI verbatim."),
        codex_thread_id: z.string().optional().describe(THREAD_ID_DESC),
        claude_session_id: z.string().optional().describe(CLAUDE_SESSION_DESC),
        claude_binding_id: z.string().optional().describe(CLAUDE_BINDING_DESC),
        callback_url: z.string().optional().describe(CALLBACK_DESC)
      })
    },
    async (args) => guard(() => followUpJob(args, deps))
  );

  server.registerTool(
    "crewdispatch_cancel",
    {
      title: "Cancel a job (explicit)",
      description:
        "Explicitly cancel a queued or running job. This is the ONLY action that terminates a running job early; it kills the CrewDispatch-managed CLI process tree and reports exactly what the OS confirmed. Idempotent: a terminal job is returned unchanged.",
      inputSchema: z.object({
        id: z.string().describe("Job id from crewdispatch_spawn."),
        wait_seconds: z.number().optional().describe("How long to wait for the owner to finalise (0..60; default 5).")
      })
    },
    async (args) => guard(() => cancelJob(args, deps))
  );

  server.registerTool(
    "crewdispatch_run",
    {
      title: "Dispatch and wait (short tasks only)",
      description:
        "Dispatch a task and wait locally up to wait_seconds for a terminal result — intended for SHORT tasks only. On timeout (or if this request is abandoned) it returns the current status and the detached job KEEPS RUNNING; it never cancels accepted work. The first accepted CrewDispatch dispatch for this data root may include dashboard_hint; surface it once when present. " +
        PROVIDER_DESC +
        " " +
        SETTINGS_HINT +
        " " +
        PACKET_DESC,
      inputSchema: z.object({
        task: z.string().describe("The evidence-led task packet, passed to the selected provider's CLI verbatim."),
        cwd: z.string().describe("Absolute workspace directory the worker owns."),
        provider: z.enum(["command-code", "workbuddy-ai"]).optional().describe("Optional provider: `command-code` (default) or `workbuddy-ai`. WorkBuddy AI may use its saved provider default model."),
        model: z.string().optional().describe("Optional explicit model id. For provider=command-code it overrides the saved default; for provider=workbuddy-ai it overrides the saved provider default, which is used when this field is omitted."),
        permission_mode: z.string().optional().describe(PERMISSION_MODE_DESC),
        effort: z.string().nullable().optional().describe("Optional reasoning effort for the INITIAL selected model only, when supported. Omit it for the configured effort of the resolved model; null = the model's own provider default."),
        wait_seconds: z.number().optional().describe("Bounded local wait (0..120; default 30)."),
        codex_thread_id: z.string().optional().describe(THREAD_ID_DESC),
        claude_session_id: z.string().optional().describe(CLAUDE_SESSION_DESC),
        claude_binding_id: z.string().optional().describe(CLAUDE_BINDING_DESC),
        callback_url: z.string().optional().describe(CALLBACK_DESC)
      })
    },
    async (args) => guard(() => runJob(args, deps))
  );

  server.registerTool(
    "crewdispatch_settings_get",
    {
      title: "Read CrewDispatch settings and CLI/catalog status",
      description:
        "Read the saved CrewDispatch Command Code configuration (default model and its own reasoning effort, permission mode, optional CLI path override, and the rate-limit fallback model with its OWN reasoning effort) together with the official CLI status, model catalog source/list/refresh time/default, the model effective right now, and stale configured model ids. " +
        "Time-of-day model schedules and in-flight clock-boundary switching are currently disabled for every provider; legacy persisted schedule fields are ignored by runtime selection and are not exposed as active settings. " +
        "The rate-limit fallback remains active: a clear exit-5 model rate limit advances primary > configured default > configured final fallback on the same job/session. " +
        "WorkBuddy AI has a separate provider configuration in the local Hub Settings.",
      inputSchema: z.object({})
    },
    async (args) => guard(() => settingsGet(args, deps))
  );

  server.registerTool(
    "crewdispatch_settings_update",
    {
      title: "Update CrewDispatch settings",
      description:
        "Update the saved CrewDispatch Command Code configuration. Only the listed fields are current settings; time-of-day schedules and in-flight clock-boundary switching are disabled for every provider. " +
        "The default model and the rate-limit fallback model each carry their OWN reasoning effort (`default_effort` / `rate_limit_fallback_effort`); null/blank = that model's provider default. Changing a selection's model resets ONLY that selection's effort to null unless the SAME update supplies a replacement. " +
        "An invalid value is REJECTED with a stable error code and the stored file is left untouched; a stored file that is already invalid is never silently repaired or overwritten. Configured model ids are validated against the installed CLI catalog when it is available; a stale id is reported, never silently replaced. " +
        "`rate_limit_fallback_model` remains ACTIVE: on a clear exit-5 model rate limit the job advances primary > configured default > this final fallback on the SAME job/session, at most once per candidate, each with its OWN configured effort. " +
        "WorkBuddy AI has a separate provider configuration in the local Hub Settings.",
      // NOTE: a plain `z.object` STRIPS unknown keys before the handler runs, so
      // an unsupported field would be silently dropped and the call would wrongly
      // report success. `z.looseObject` keeps unknown keys so the handler can
      // REJECT them explicitly (see `configPatchFromSnake`).
      inputSchema: z.looseObject({
        cli_path: z.string().nullable().optional().describe("Optional ABSOLUTE path to the official CLI executable (a relative path is rejected; null = discover on PATH)."),
        default_model: z.string().nullable().optional().describe("Default model id; null = use the CLI catalog default. Changing it resets default_effort to null unless default_effort is supplied in the same call."),
        rate_limit_fallback_model: z.string().nullable().optional().describe("Final rate-limit fallback id. ACTIVE: only a clear exit-5 model rate limit advances the chain to it, resuming the same job/session. Must be a valid CLI catalog id or it is never called (reported as stale). Changing it resets rate_limit_fallback_effort to null unless that field is supplied in the same call."),
        permission_mode: z.string().optional().describe("Saved default permission mode for a Command Code job that does not specify one. `standard` is the canonical public value; its documented synonym `default` is accepted and stored as `standard`. Omit to leave the saved mode unchanged."),
        default_effort: z.string().nullable().optional().describe("Reasoning effort for the default model; null/blank = that model's provider default (no --effort)."),
        rate_limit_fallback_effort: z.string().nullable().optional().describe("Reasoning effort for the rate-limit fallback model; null/blank = that model's provider default.")
      })
    },
    async (args) => guard(() => settingsUpdate(args, deps))
  );

  return server;
}

/** @deprecated Use createCrewDispatchServer. */
export const createJobQuayServer = createCrewDispatchServer;

/** Keep old callers working while tools/list exposes only the new names. */
class LegacyToolNameTransport extends StdioServerTransport {
  override async start(): Promise<void> {
    const receive = this.onmessage;
    this.onmessage = (message) => {
      if ("method" in message && message.method === "tools/call" &&
          message.params && typeof message.params.name === "string" &&
          /^jobquay_(spawn|status|result|follow_up|cancel|run|settings_get|settings_update)$/.test(message.params.name)) {
        receive?.({ ...message, params: { ...message.params, name: message.params.name.replace(/^jobquay_/, "crewdispatch_") } });
      } else {
        receive?.(message);
      }
    };
    await super.start();
  }
}

/** Assemble tool deps from the environment (test seams are env-only, never schema). */
export function depsFromEnv(env: NodeJS.ProcessEnv): ToolDeps {
  const fixture = typeof env.JOBQUAY_TEST_FIXTURE === "string" && env.JOBQUAY_TEST_FIXTURE.trim() ? env.JOBQUAY_TEST_FIXTURE.trim() : null;
  const cliPath = typeof env.JOBQUAY_CLI_PATH === "string" && env.JOBQUAY_CLI_PATH.trim() ? env.JOBQUAY_CLI_PATH.trim() : null;
  return { env, fixturePath: fixture, cliPath };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const deps = depsFromEnv(env);
  serveStdio(() => createCrewDispatchServer(deps), { transport: new LegacyToolNameTransport() });
  console.error(`[crewdispatch] MCP server listening on stdio (data root via JOBQUAY_DATA_ROOT)`);
}

if (require.main === module) {
  main();
}
