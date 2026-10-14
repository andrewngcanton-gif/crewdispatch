// server.ts — the CrewDispatch local HTTP backend for provider-neutral session views.
//
// It is the READ/control surface that the (future) Hub UI talks to. It is
// deliberately NOT a task-creation surface: new jobs are created ONLY through
// the MCP entry (src/mcp/**). This server can:
//
//   * list jobs with stable pagination (and show a single job's session view:
//     the original task, the follow-up user messages, the latest model/usage
//     and the displayable assistant content — or an explicit "missing");
//   * stream a job's transcript incrementally (bounded cursor; reasoning is
//     passed through ONLY when the official CLI really emitted it — never
//     fabricated);
//   * drive a follow-up on the SAME logical job/session (terminal only) through
//     the independent local daemon/broker, and explicit cancel through the
//     durable process-tree control path;
//   * read/write the existing Command Code settings (the same config.json schema
//     and whitelist the MCP entry uses) and the new global UI settings (page
//     size + diagnostics retention);
//   * run the diagnostics cleanup (terminal job groups only) and report its
//     persistent audit.
//
// Security (loopback Hub + independently owned local daemon):
//   * binds 127.0.0.1 ONLY — never exposed off-host;
//   * WRITE requests (POST/PUT) accept JSON only and are same-origin only: a
//     present `Origin` that is not the hub's own origin (scheme://host) is
//     rejected with 403. There is NO permissive CORS (`Access-Control-Allow-
//     Origin: *` is never set);
//   * request bodies are size-capped and parsed as JSON (a bad body is a 400/413);
//   * every job id is validated with `safeId` and every derived path is asserted
//     to stay INSIDE the data root, so a crafted id can never escape it.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import {
  assertInside,
  listJobs,
  loadJob,
  logPath,
  resolveDataRoot,
  safeId
} from "../jobs/store";
import { loadAssistantMessagesInfo, loadUserMessagesInfo } from "../jobs/messages";
import { getStatus, requestCancel } from "../jobs/service";
import { reconcileAll } from "../jobs/reconcile";
import { continueJobViaDaemon, JobDaemonError } from "../daemon/client";
import { deliverTerminalNotification } from "../mcp/notify";
import { ConfigError } from "../config/schema";
import {
  COMMAND_CODE_SETTINGS_ID,
  WORKBUDDY_AI_SETTINGS_ID,
  getDefaultSettingsReads
} from "../config/settings-registry";
import type { ProviderSettingsReads } from "../config/settings-reads";
import {
  JOBS_PAGE_SIZE_OPTIONS,
  loadGlobalSettings,
  updateGlobalSettings
} from "../config/global";
import { enforceRetention, readCleanupAudit, type RetentionRunResult } from "./retention";
import { snapshotHubBuild, type HubBuildIdentity } from "./identity";
import {
  clearHubEndpoint,
  dataRootId,
  newHubInstanceId,
  probeHubOwner,
  readHubEndpoint,
  retireHubEndpoint,
  writeHubEndpoint,
  type HubEndpointRecord
} from "./endpoint";
import {
  canonicalApprovalKind,
  claimApprovalDecision,
  readApprovalDecision,
  safeApprovalToken,
  type ApprovalDecision,
  type PendingApproval
} from "../jobs/approval";
import { HUB_HTML } from "../ui/page";

const API_PREFIX = "/api";

/** Hard cap on any write body (JSON config is small). */
const MAX_BODY_BYTES = 256 * 1024;
/** Default / maximum entries returned by one /log batch. */
const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 200;
/** Hard per-request disk-read cap for the incremental NDJSON reader. */
const LOG_MAX_READ_BYTES = 256 * 1024;
/** A single NDJSON record above this size is skipped without exposing its bytes. */
const LOG_MAX_LINE_BYTES = 64 * 1024;
/** Allowed page sizes (0 = unlimited). */
const PAGE_SIZE_OPTIONS: ReadonlyArray<number> = [20, 50, 100, 200, 0];

/**
 * The provider-settings routes. Both providers share ONE always-fresh read
 * path; only the provider id differs, and every provider-specific read/write
 * lives behind the provider definition in the settings registry.
 */
const SETTINGS_ROUTES: ReadonlyMap<string, string> = new Map([
  [`${API_PREFIX}/settings`, COMMAND_CODE_SETTINGS_ID],
  [`${API_PREFIX}/providers/workbuddy-ai/settings`, WORKBUDDY_AI_SETTINGS_ID]
]);

/**
 * The OPTIONAL capability-phase route. Command Code's capability evidence
 * (`--version` / `--help`) is the only Settings read that spawns the CLI, so it
 * is served as its own later request: the Hub UI renders the model list and
 * Free-now from the process-free catalog phase first, then patches the
 * permission modes / effort in when this route answers. A provider with no
 * capability phase is a 404 here — never an empty "no modes" claim.
 */
const SETTINGS_CAPABILITY_ROUTES: ReadonlyMap<string, string> = new Map([
  [`${API_PREFIX}/settings/capabilities`, COMMAND_CODE_SETTINGS_ID]
]);

function settingsProviderForPath(pathname: string): string | null {
  return SETTINGS_ROUTES.get(pathname) ?? null;
}

function settingsCapabilityProviderForPath(pathname: string): string | null {
  return SETTINGS_CAPABILITY_ROUTES.get(pathname) ?? null;
}

export interface HubOptions {
  /** CrewDispatch data root (resolved from JOBQUAY_DATA_ROOT when omitted). */
  root?: string;
  /** Listen port (default 30080). */
  port?: number;
  /** Bind host — ALWAYS loopback for this product. */
  host?: string;
  /** Override the controlled fixture / CLI path (test seam, else env). */
  fixturePath?: string | null;
  cliPath?: string | null;
  /** Environment used for provider discovery/probes (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Shared provider-settings read path (test/embedding seam). Defaults to the
   * process-wide instance shared by every Hub.
   */
  settingsReads?: ProviderSettingsReads;
  /**
   * Path to the built browser client bundle (test/embedding seam; defaults to
   * the bundled `dist/ui/client.js`). The file is read EXACTLY ONCE when the
   * handler is created and that snapshot is served for the handler's whole
   * lifetime, so the client JS can never be swapped under a live process.
   */
  clientAssetPath?: string;
  /**
   * Build root whose `dist/` defines this Hub's build identity (test/embedding
   * seam; defaults to the installation this Hub was built in). Like the client
   * asset, the identity is snapshotted ONCE when the handler is created: a
   * rebuild on disk must never change what a LIVE process reports.
   */
  identityRoot?: string;
  /**
   * The pre-computed build identity for this Hub (test/embedding seam). When
   * given, the handler and the endpoint record share ONE snapshot instead of
   * each recomputing it.
   */
  identity?: HubBuildIdentity;
  /**
   * Random per-Hub-instance ownership token. Defaults to a fresh token; the
   * endpoint record and the self-check both key on it, so two Hubs started from
   * the same process are still distinct owners.
   */
  instanceId?: string;
  /**
   * Invoked when a caller asks this Hub to exit so a rebuilt Hub can take the
   * port (`POST /api/hub/shutdown`). `startHub` wires the real process exit; an
   * embedded Hub that leaves it unset answers 503 `shutdown_unavailable`
   * instead of ever exiting.
   */
  onShutdownRequest?: () => void;
}

export interface HubHandle {
  server: http.Server;
  port: number;
  root: string;
}

/** Resolve the controlled fixture / CLI path the same way the MCP entry does. */
function fixtureFromEnv(env: NodeJS.ProcessEnv): { fixturePath: string | null; cliPath: string | null } {
  const fixturePath =
    typeof env.JOBQUAY_TEST_FIXTURE === "string" && env.JOBQUAY_TEST_FIXTURE.trim()
      ? env.JOBQUAY_TEST_FIXTURE.trim()
      : null;
  const cliPath =
    typeof env.JOBQUAY_CLI_PATH === "string" && env.JOBQUAY_CLI_PATH.trim() ? env.JOBQUAY_CLI_PATH.trim() : null;
  return { fixturePath, cliPath };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

/**
 * Send a JSON response and run `after` only once those bytes are flushed to the
 * socket. The Hub's shutdown route needs this: the answer must reach the
 * caller before the process disappears.
 */
function sendJsonThen(res: http.ServerResponse, code: number, obj: unknown, after: () => void): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body, () => {
    setImmediate(after);
  });
}

function readBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; code: number; message: string }> {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.toLowerCase().includes("application/json")) {
    return Promise.resolve({ ok: false, code: 415, message: "write requests must use Content-Type: application/json" });
  }
  return new Promise((resolve) => {
    let size = 0;
    let data = "";
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        resolve({ ok: false, code: 413, message: "request body too large" });
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (aborted) return;
      if (!data) {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(data) });
      } catch {
        resolve({ ok: false, code: 400, message: "invalid JSON body" });
      }
    });
    req.on("error", () => {
      if (!aborted) resolve({ ok: false, code: 400, message: "request error" });
    });
  });
}

/**
 * True for a loopback host. We deliberately NEVER trust the client-supplied
 * `Host` header to decide what origin is "our own" — that is exactly the
 * DNS-rebinding / forged-Host hole: an attacker sets `Host: evil.example` and
 * `Origin: http://evil.example`, the two match, and the old guard waved it
 * through. Instead the authoritative origin is derived from the address the
 * server actually bound to (loopback + the real port).
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  if (net.isIP(h) !== 4) return false;
  return Number(h.split(".")[0]) === 127;
}

function parseAuthority(authority: string): URL | null {
  try {
    const u = new URL(`http://${authority}`);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Reject a foreign or malformed Host on EVERY route, including reads and UI
 * assets. Without this, DNS rebinding could read local jobs through a hostile
 * hostname even though writes were origin-guarded.
 */
function assertLocalHost(req: http.IncomingMessage, bind: { host: string; port: number }): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || !hostHeader.length) return false;
  const host = parseAuthority(hostHeader);
  return host != null && isLoopbackHost(host.hostname) && (host.port || "80") === String(bind.port);
}

/**
 * Same-origin guard for writes.
 *
 * The check is anchored on the SERVER-AUTHORITATIVE bind address (loopback host
 * + the real listening port), never on the client-provided `Host`. A present
 * `Origin` must parse to an `http(s)` URL whose host is a loopback address AND
 * whose port equals the port we actually bound — otherwise the write is cross-
 * origin and rejected (403). A forged `Host: evil.example` + `Origin:
 * http://evil.example` is rejected because `evil.example` is not loopback, even
 * though Host and Origin match each other. An absent `Origin` (a same-origin
 * `fetch`, a non-browser client, or a server-to-server call) is allowed.
 *
 * Every route has already passed assertLocalHost before this check.
 */
function assertSameOrigin(req: http.IncomingMessage, bind: { host: string; port: number }): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  // The Hub serves plain HTTP, so HTTPS is not the same origin even when the
  // host and port happen to match.
  if (u.protocol !== "http:") return false;
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return false;
  const portStr = u.port || "80";
  if (portStr !== String(bind.port)) return false;
  if (!isLoopbackHost(u.hostname)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Hub views
// ---------------------------------------------------------------------------

function hubJobSummary(root: string, job: ReturnType<typeof loadJob>): Record<string, unknown> {
  if (!job) return {};
  const history = loadUserMessagesInfo(root, job.id);
  const displayTitle = history.complete ? history.messages[0]?.text.split("\n")[0]?.trim().slice(0, 160) ?? null : null;
  return {
    job_id: job.id,
    display_title: displayTitle,
    status: job.status,
    generation: job.generation,
    provider: job.provider,
    model: job.model,
    model_source: job.modelSource,
    created_at: job.createdAt,
    finished_at: job.finishedAt,
    usage: job.usage,
    cancel_requested: job.cancelIntent.requested === true,
    approval_state: hubApprovalState(root, job)
  };
}

function hubApprovalState(root: string, job: ReturnType<typeof loadJob>): "waiting" | "submitted" | "expired" | null {
  const pending = job?.status === "running" ? job.pendingApproval : null;
  if (!pending || pending.jobId !== job!.id || pending.generation !== job!.generation) return null;
  if (readApprovalDecision(root, pending.jobId, pending.generation, pending.requestId)) return "submitted";
  return Date.parse(pending.expiresAt) > Date.now() ? "waiting" : "expired";
}

function hubCompactResult(job: ReturnType<typeof loadJob>): Record<string, unknown> | null {
  const r = job?.result;
  if (!r) return null;
  return {
    ok: r.ok === true,
    subtype: r.subtype,
    kind: r.kind,
    exit_code: typeof r.exitCode === "number" ? r.exitCode : null,
    stop_reason: r.stopReason,
    // The bounded provider finish reason (JQ-20261001-23), display-safe by the
    // provider boundary; null for records persisted before it existed.
    finish_reason: r.finishReason ?? null,
    // The provider's bounded, display-safe terminal error detail
    // (JQ-20261001-24), sanitized by the provider boundary; null before it
    // existed.
    error_detail: r.errorDetail ?? null,
    // Why an interactive approval gate on this turn did not proceed (canonical
    // `approval_outcome`): a real rejection / an expiry / a missing route / an
    // abandoned wait. It lets the Dashboard explain a completed turn whose
    // gated operation never ran without reading any provider prose; null for
    // records persisted before it existed.
    approval_outcome: r.approvalOutcome ?? null,
    final_text: r.finalText,
    fallback_eligible: r.fallbackEligible === true
  };
}

/**
 * The Hub's provider-neutral view of one pending approval. The durable record
 * stores camelCase fields; the Hub API speaks snake_case like every other view.
 * Only the bounded, display-safe fields are mapped — never a provider payload.
 * The operation detail was already bounded and credential-redacted by the
 * shared approval boundary; it is copied field by field, never re-serialized.
 */
function hubPendingApproval(pending: PendingApproval | null): Record<string, unknown> | null {
  if (!pending) return null;
  return {
    version: pending.version,
    kind: pending.kind,
    provider: pending.provider,
    job_id: pending.jobId,
    generation: pending.generation,
    request_id: pending.requestId,
    tool_name: pending.toolName,
    summary: pending.summary,
    detail: pending.detail
      ? {
          command: pending.detail.command,
          args: pending.detail.args,
          description: pending.detail.description,
          path: pending.detail.path,
          cwd: pending.detail.cwd,
          title: pending.detail.title,
          gate: pending.detail.gate,
          reason: pending.detail.reason,
          truncated: pending.detail.truncated,
          redacted: pending.detail.redacted
        }
      : null,
    options: pending.options.map((option) => ({ id: option.id, kind: option.kind, label: option.label })),
    created_at: pending.createdAt,
    expires_at: pending.expiresAt
  };
}

/** The pending approval a RUNNING job may expose; never one of a settled job. */
function hubRunningApproval(job: ReturnType<typeof loadJob>): Record<string, unknown> | null {
  return job && job.status === "running" ? hubPendingApproval(job.pendingApproval) : null;
}

function hubJobDetail(root: string, job: ReturnType<typeof loadJob>): Record<string, unknown> {
  if (!job) return {};
  const history = loadUserMessagesInfo(root, job.id);
  const messages = history.messages;
  const assistantHistory = loadAssistantMessagesInfo(root, job.id);
  const original = history.complete ? messages[0]?.text ?? null : null;
  const followUps = messages.filter((m) => m.generation > 0).map((m) => ({ generation: m.generation, text: m.text, at: m.at }));
  const result = hubCompactResult(job);
  const finalText = result && typeof (result as Record<string, unknown>).final_text === "string"
    ? ((result as Record<string, unknown>).final_text as string)
    : null;
  return {
    job_id: job.id,
    status: job.status,
    generation: job.generation,
    provider: job.provider,
    model: job.model,
    model_source: job.modelSource,
    explicit_model: job.explicitModel,
    model_chain: job.modelChain,
    effort: job.effort,
    created_at: job.createdAt,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    stop_reason: job.stopReason,
    // The bounded provider finish reason (JQ-20261001-23): it lets the browser
    // distinguish a provider content filter from an explicit refusal without
    // serving any raw provider payload. Null before it existed.
    finish_reason: job.finishReason ?? null,
    // The provider's bounded, display-safe terminal diagnostic (JQ-20261001-24);
    // refinement only, never a second classification. Null before it existed.
    error_detail: job.errorDetail ?? null,
    // The bounded approval outcome token of the terminal result (canonical
    // `approval_outcome`): why an interactive approval gate did not proceed.
    // Evidence only — it never changes the job status or the failure class.
    approval_outcome: job.approvalOutcome ?? null,
    failure_kind: job.failureKind,
    // The Hub session view: the ORIGINAL first task and every later follow-up.
    task: original,
    history_available: history.complete,
    history_reason: history.complete ? null : history.reason ?? "original_message_missing",
    follow_ups: followUps,
    user_messages: messages.map((m) => ({ generation: m.generation, text: m.text, at: m.at, source: m.source ?? null })),
    assistant_messages: assistantHistory.messages.map((m) => ({ generation: m.generation, text: m.text, at: m.at })),
    usage: job.usage,
    result,
    // The displayable assistant content, or an explicit "missing" flag. We
    // never FABRICATE assistant text — it is exactly the recorded final_text.
    assistant_content: finalText,
    assistant_missing: finalText == null,
    cancel_requested: job.cancelIntent.requested === true,
    // The provider-neutral pending approval of a RUNNING provider turn, or
    // null. It is bounded and display-safe (see jobs/approval.ts): identity,
    // provider, the provider's own option ids/kinds/labels and an expiry —
    // never a tool input, command, prompt or raw provider payload.
    pending_approval: hubRunningApproval(job),
    attempts: job.attempts.slice(-20).map((a) => ({
      generation: a.generation,
      model: a.model,
      model_source: a.modelSource,
      // The effort this attempt ACTUALLY ran with (null = provider/model default).
      effort: a.effort,
      exit_code: a.exitCode,
      kind: a.kind,
      rate_limited: a.rateLimited === true
    })),
    notify: { kind: job.notifyTarget.kind, source: job.notifyTarget.source }
  };
}

function parsePageQuery(rawLimit: string | null, rawOffset: string | null):
  | { ok: true; limit: number | null; offset: number }
  | { ok: false; error: string } {
  let limit: number | null = 50; // default page size
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit.trim())) return { ok: false, error: `limit must be a non-negative integer (got ${JSON.stringify(rawLimit)})` };
    const n = Number(rawLimit.trim());
    if (!Number.isSafeInteger(n)) return { ok: false, error: `limit is out of range (got ${JSON.stringify(rawLimit)})` };
    if (n === 0) limit = null; // 0 = unlimited
    else if (PAGE_SIZE_OPTIONS.includes(n)) limit = n;
    else return { ok: false, error: `limit must be one of ${PAGE_SIZE_OPTIONS.join("/")} (0 = unlimited)` };
  }
  let offset = 0;
  if (rawOffset !== null) {
    if (!/^\d+$/.test(rawOffset.trim())) return { ok: false, error: `offset must be a non-negative integer (got ${JSON.stringify(rawOffset)})` };
    offset = Number(rawOffset.trim());
    if (!Number.isSafeInteger(offset)) return { ok: false, error: `offset is out of range (got ${JSON.stringify(rawOffset)})` };
  }
  return { ok: true, limit, offset };
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

/** The UI client bundle, coupled to ONE handler at creation time. */
type UiClientAsset = { ok: true; script: Buffer } | { ok: false; message: string };

/**
 * Read the browser client bundle EXACTLY ONCE, at handler creation.
 *
 * The asset and the API handlers must always belong to the SAME build: an old
 * process that re-read `dist/ui/client.js` on every request would serve a NEW
 * client bundle from OLD API handlers after a rebuild — the exact settings-
 * envelope incoherence this coupling prevents. A missing asset is reported
 * honestly on every request and is NEVER healed by a later build appearing on
 * disk while the process is alive; the Hub must be restarted to pick it up.
 */
function loadUiClientAsset(opts: HubOptions): UiClientAsset {
  const file = opts.clientAssetPath ?? path.join(__dirname, "..", "ui", "client.js");
  try {
    return { ok: true, script: fs.readFileSync(file) };
  } catch {
    return {
      ok: false,
      message: "The UI client asset was unavailable when this Hub started; run npm.cmd run build and restart the Hub."
    };
  }
}

/** The build identity for a Hub: the caller's snapshot, else the build on disk. */
function hubBuildIdentity(opts: HubOptions): HubBuildIdentity {
  return (
    opts.identity ??
    snapshotHubBuild({
      root: opts.identityRoot ? path.resolve(opts.identityRoot) : path.resolve(__dirname, "..", "..")
    })
  );
}

/**
 * One Hub's view of whether it still owns the data root. A Hub is SUPERSEDED
 * once the durable endpoint names a DIFFERENT instance for the SAME root and
 * that EXACT instance is proven live (a CrewDispatch ping that confirms both
 * the recorded root fingerprint and the recorded instance id). The record is
 * re-read on every request (a tiny file); only the identity proof is cached, so
 * ownership moves are seen immediately while the loopback probe stays bounded.
 * When the recorded owner is gone — or the recorded port is answered by a
 * DIFFERENT instance (a replacement that reused the port) — the live Hub
 * re-claims the endpoint so a stale record can never disable it or make it
 * redirect to itself.
 */
function createOwnershipGuard(options: {
  root: string;
  instanceId: string;
  self: () => { port: number; buildId: string | null; version: string | null };
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}): { supersededBy: () => Promise<HubEndpointRecord | null> } {
  const rootId = dataRootId(options.root);
  const ttlMs = options.ttlMs ?? 500;
  let cachedInstance = "";
  let cachedAt = 0;
  let cachedVerdict: HubEndpointRecord | null = null;
  return {
    async supersededBy(): Promise<HubEndpointRecord | null> {
      const record = readHubEndpoint(options.root);
      if (!record || !record.instance_id || record.instance_id === options.instanceId) return null;
      if (record.root_id && record.root_id !== rootId) return null;
      const now = Date.now();
      if (cachedInstance === record.instance_id && now - cachedAt < ttlMs) return cachedVerdict;
      const self = options.self();
      const live = await probeHubOwner(record, options.fetchImpl ?? fetch);
      // A record naming THIS Hub's own port can never justify a redirect: the
      // only listener that may answer there is this process itself (a later
      // replacement would answer with its own instance id and fail the identity
      // proof above), and redirecting to the same origin is a self-loop that
      // also drops the approval deep-link query. Such a record is a stale
      // identity to reconcile, never an owner to defer to.
      const superseded = live && record.port !== self.port;
      cachedInstance = record.instance_id;
      cachedAt = now;
      cachedVerdict = superseded ? record : null;
      if (!superseded) {
        try {
          writeHubEndpoint(options.root, {
            port: self.port,
            pid: process.pid,
            instanceId: options.instanceId,
            buildId: self.buildId,
            version: self.version,
            rootId
          });
        } catch {
          /* best effort: without the re-claim the endpoint stays stale */
        }
      }
      return cachedVerdict;
    }
  };
}

/**
 * Answer a request to a Hub that no longer owns this data root. Page
 * navigations redirect to the current Hub; API/asset reads get an explicit
 * `hub_superseded` response. Either way an already-open tab can never keep
 * showing the superseded UI silently.
 *
 * The redirect carries the original query string, so an approval deep link
 * (`/ui?job=…&generation=…&request=…`) survives the ownership move and still
 * opens the exact intended job on the current Hub. The target is always the
 * RECORDED OTHER owner; this function is never called with the requesting
 * Hub's own port (see createOwnershipGuard), so it can never redirect to self.
 */
function sendSuperseded(res: http.ServerResponse, pathname: string, ownerPort: number, search = ""): void {
  const current = `http://127.0.0.1:${ownerPort}`;
  res.setHeader("X-JobQuay-Hub", "superseded");
  res.setHeader("X-JobQuay-Current-Endpoint", current);
  res.setHeader("Cache-Control", "no-store");
  if (pathname === "/" || pathname === "/ui" || pathname === "/ui/") {
    // `search` comes from a WHATWG-parsed URL (control characters removed /
    // percent-encoded); bound it anyway so a pathological query can never turn
    // into an unbounded response header.
    const query = search && search.startsWith("?") && search.length <= 2048 ? search : "";
    res.writeHead(302, { Location: `${current}/ui${query}` });
    res.end();
    return;
  }
  sendJson(res, 409, {
    ok: false,
    error: "hub_superseded",
    message: "This CrewDispatch Hub has been superseded by the current Hub for this data root. Reload the Dashboard.",
    current_endpoint: current,
    current_port: ownerPort
  });
}

export function createHubHandler(
  opts: HubOptions,
  bind: { host: string; port: number } = { host: "127.0.0.1", port: 30080 }
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const env = opts.env ?? process.env;
  const root = resolveDataRoot(opts.root, env);
  const settingsReads = opts.settingsReads ?? getDefaultSettingsReads();
  const { fixturePath, cliPath } = fixtureFromEnv(env);
  const effectiveFixture = opts.fixturePath !== undefined ? opts.fixturePath : fixturePath;
  const effectiveCli = opts.cliPath !== undefined ? opts.cliPath : cliPath;
  const instanceId = opts.instanceId ?? newHubInstanceId();
  // Snapshot the client asset NOW: this process serves ONE coherent API + UI
  // revision for its whole lifetime (never a later build's JS under earlier
  // handlers, and never a mid-process switch after a missing asset).
  const uiClient = loadUiClientAsset(opts);
  // Snapshot the build identity for the same reason: an OLD Hub must keep
  // reporting the OLD build it actually loaded, so a launcher can never mistake
  // it for a freshly rebuilt one.
  const identity: HubBuildIdentity = hubBuildIdentity(opts);
  const ownership = createOwnershipGuard({
    root,
    instanceId,
    self: () => ({ port: bind.port, buildId: identity.buildId, version: identity.version })
  });

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const method = req.method ?? "GET";
    try {
      // The listener binds loopback, and all routes also reject a foreign Host
      // so a browser cannot read local jobs through a DNS-rebound domain.
      if (!assertLocalHost(req, bind)) {
        sendJson(res, 403, { error: "host_rejected", message: "Non-local Host rejected." });
        return;
      }
      // ---- current-Hub ownership guard ----
      //
      // Once a DIFFERENT live Hub owns this data root's endpoint, this process
      // must stop serving the superseded UI/API to an already-open tab. The
      // health probe stays truthful (the launcher reads it) and the shutdown
      // route stays available (so this process can still be retired).
      if (p !== `${API_PREFIX}/ping` && p !== `${API_PREFIX}/hub/shutdown`) {
        const owner = await ownership.supersededBy();
        if (owner) {
          sendSuperseded(res, p, owner.port, url.search);
          return;
        }
      }
      if ((p === "/" || p === "/ui" || p === "/ui/") && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(HUB_HTML);
        return;
      }
      if (p === "/ui/client.js" && method === "GET") {
        // Serve the snapshot taken at handler creation — never the mutable
        // build output. `no-store` keeps the browser from caching, but the
        // bytes always belong to THIS process's build revision.
        if (!uiClient.ok) {
          sendJson(res, 503, { error: "ui_build_missing", message: uiClient.message });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store"
        });
        res.end(uiClient.script);
        return;
      }
      if (!p.startsWith(API_PREFIX)) {
        sendJson(res, 404, { error: "not_found", path: p });
        return;
      }

      // ---- health ----
      if (p === `${API_PREFIX}/ping` && method === "GET") {
        // The identity is the startup snapshot, never a re-read of the mutable
        // build output: a live process answers for the build it really loaded.
        sendJson(res, 200, {
          ok: true,
          service: "jobquay",
          version: identity.version,
          build_id: identity.buildId,
          instance_id: instanceId,
          pid: process.pid,
          root_id: dataRootId(root),
          ts: Date.now()
        });
        return;
      }

      // ---- build-aware handover (restart so a rebuilt Hub can bind) ----
      //
      // The launcher sends this only to a listener it just probed as a CrewDispatch
      // Hub whose version/build_id differ from the build on disk. Like the other
      // local write routes it is loopback-only and same-origin guarded (a
      // cross-origin browser request is rejected with 403).
      if (p === `${API_PREFIX}/hub/shutdown` && method === "POST") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const requestShutdown = opts.onShutdownRequest;
        if (!requestShutdown) {
          sendJson(res, 503, {
            error: "shutdown_unavailable",
            message: "This Hub was not started as a replaceable background process; stop it manually instead."
          });
          return;
        }
        sendJsonThen(res, 200, { ok: true, service: "jobquay", build_id: identity.buildId, exiting: true }, requestShutdown);
        return;
      }

      // ---- global settings (page size + diagnostics retention) ----
      if (p === `${API_PREFIX}/global-settings` && method === "GET") {
        const g = loadGlobalSettings(root);
        sendJson(res, 200, {
          ok: true,
          jobs_page_size: g.settings.jobs_page_size,
          diag_retention_days: g.settings.diag_retention_days,
          diag_max_total_bytes: g.settings.diag_max_total_bytes,
          jobs_page_size_options: [...JOBS_PAGE_SIZE_OPTIONS]
        });
        return;
      }
      if (p === `${API_PREFIX}/global-settings` && method === "PUT") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code, { error: body.code === 413 ? "body_too_large" : body.code === 415 ? "bad_content_type" : "bad_json", message: body.message });
          return;
        }
        try {
          const saved = updateGlobalSettings(root, body.value);
          // A settings save is a NATURAL retention entry point: apply the new
          // policy immediately (best-effort; never fails the save).
          try {
            enforceRetention(root);
          } catch {
            /* best-effort */
          }
          sendJson(res, 200, {
            ok: true,
            jobs_page_size: saved.jobs_page_size,
            diag_retention_days: saved.diag_retention_days,
            diag_max_total_bytes: saved.diag_max_total_bytes,
            jobs_page_size_options: [...JOBS_PAGE_SIZE_OPTIONS]
          });
        } catch (e) {
          if (e instanceof Error && "code" in e) {
            const ge = e as { code: string; message: string };
            sendJson(res, 400, { error: ge.code, message: ge.message });
          } else {
            sendJson(res, 400, { error: "global_write_failed", message: String((e as Error)?.message || e) });
          }
        }
        return;
      }

      // ---- provider settings (ONE shared always-fresh read path for both providers).
      //
      // GET  <route>            -> fresh COMPLETE probe, raw view (MCP-compatible).
      // GET  <route>?fresh=1    -> fresh CATALOG-phase probe with provenance
      //                            (billing_verified); the Hub UI reads only
      //                            this form. It performs no CLI process, so a
      //                            cold or hung `--version`/`--help` cannot
      //                            delay the model list or Free-now. Concurrent
      //                            identical reads join one underlying probe; a
      //                            completed read is never replayed.
      // GET  <route>/capabilities?fresh=1
      //                         -> the separate CAPABILITY phase (the only part
      //                            that spawns the CLI), patched into the form
      //                            when it answers.
      // PUT  <route>            -> persist the patch, then detach any in-flight
      //                            pre-save probe (BOTH phases) so post-save
      //                            state always comes from post-save reads.
      const settingsCapabilityProviderId = settingsCapabilityProviderForPath(p);
      if (settingsCapabilityProviderId && method === "GET") {
        const fresh = await settingsReads.readCapabilitiesFresh(settingsCapabilityProviderId, root, env);
        if (!fresh) {
          sendJson(res, 404, {
            error: "capabilities_unsupported",
            message: `Provider ${settingsCapabilityProviderId} publishes no separate capability phase.`
          });
          return;
        }
        if (!fresh.result.ok) {
          sendJson(res, 200, {
            ok: false,
            code: fresh.result.code,
            message: fresh.result.message,
            field: fresh.result.field,
            config_present: fresh.result.raw != null
          });
          return;
        }
        sendJson(res, 200, { ok: true, patch: fresh.result.view, freshness: fresh.freshness });
        return;
      }
      const settingsProviderId = settingsProviderForPath(p);
      if (settingsProviderId && method === "GET") {
        const envelope = url.searchParams.get("fresh") === "1";
        // The envelope form is the Hub UI: it asks for the process-free catalog
        // phase so the form renders promptly. The raw form stays COMPLETE, so
        // MCP and other non-UI readers keep the full evidence they always had.
        const fresh = await settingsReads.readFresh(settingsProviderId, root, env, envelope ? "catalog" : "full");
        if (!fresh.result.ok) {
          sendJson(res, 200, {
            ok: false,
            code: fresh.result.code,
            message: fresh.result.message,
            field: fresh.result.field,
            config_present: fresh.result.raw != null
          });
          return;
        }
        if (envelope) {
          sendJson(res, 200, { ok: true, view: fresh.result.view, freshness: fresh.freshness });
          return;
        }
        sendJson(res, 200, fresh.result.view);
        return;
      }
      if (settingsProviderId && method === "PUT") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code, { error: body.code === 413 ? "body_too_large" : body.code === 415 ? "bad_content_type" : "bad_json", message: body.message });
          return;
        }
        try {
          const config = settingsReads.definition(settingsProviderId).applyPatch(root, body.value as Record<string, unknown>);
          // A save is a NATURAL invalidation point: a probe that started before
          // it is detached, so the next read starts a genuinely post-save probe.
          settingsReads.invalidate(settingsProviderId, root);
          sendJson(res, 200, { ok: true, config });
        } catch (e) {
          if (e instanceof ConfigError) sendJson(res, 400, { error: e.code, message: e.message, field: e.field });
          else sendJson(res, 400, { error: "config_write_failed", message: String((e as Error)?.message || e) });
        }
        return;
      }

      // ---- diagnostics cleanup + audit ----
      if (p === `${API_PREFIX}/diagnostics/cleanup` && method === "POST") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const result: RetentionRunResult = enforceRetention(root);
        sendJson(res, 200, { ok: true, ...result, audit: readCleanupAudit(root).totals });
        return;
      }
      if (p === `${API_PREFIX}/diagnostics/audit` && method === "GET") {
        sendJson(res, 200, { ok: true, audit: readCleanupAudit(root) });
        return;
      }

      // Reconcile stale dead-owner records at the read boundary so the Hub can
      // never keep presenting a dead worker as "running / Tool running" forever.
      // Terminal delivery is generation-claimed/idempotent, so racing the daemon's
      // periodic reconciliation cannot duplicate a wake.
      const reconcileForHubRead = async (): Promise<void> => {
        const swept = reconcileAll(root);
        for (const changed of swept.changed) {
          if (!["done", "error", "cancelled", "interrupted"].includes(changed.status)) continue;
          try {
            await deliverTerminalNotification(root, changed.id, {}, { generation: changed.generation, by: "hub-reconcile" });
          } catch {
            // Delivery diagnostics are persisted independently; reads must stay usable.
          }
        }
      };

      // ---- jobs list (pagination) ----
      if (p === `${API_PREFIX}/jobs` && method === "GET") {
        const parsed = parsePageQuery(url.searchParams.get("limit"), url.searchParams.get("offset"));
        if (!parsed.ok) {
          sendJson(res, 400, { error: "bad_pagination", message: parsed.error });
          return;
        }
        await reconcileForHubRead();
        // Newest first (stable total order over the durable createdAt).
        const all = listJobs(root).jobs.slice().reverse();
        const total = all.length;
        const { limit, offset } = parsed;
        const page = limit == null ? all.slice(offset) : all.slice(offset, offset + limit);
        sendJson(res, 200, {
          jobs: page.map((job) => hubJobSummary(root, job)),
          // Global approval visibility must not depend on the current page.
          pending_approvals: all.filter((job) => hubApprovalState(root, job) === "waiting").map((job) => ({
            ...hubJobSummary(root, job),
            request_id: job.pendingApproval!.requestId,
            tool_name: job.pendingApproval!.toolName,
            expires_at: job.pendingApproval!.expiresAt
          })),
          total,
          offset,
          limit: limit ?? 0,
          has_more: limit == null ? false : offset + page.length < total
        });
        return;
      }

      // ---- job creation is NOT a Hub capability: only the MCP entry creates jobs. ----
      if (p === `${API_PREFIX}/jobs` && (method === "POST" || method === "PUT" || method === "DELETE")) {
        sendJson(res, 404, {
          error: "not_supported",
          message: "Tasks can only be created through the MCP entry (crewdispatch_spawn); the Hub offers no task-creation path."
        });
        return;
      }

      // ---- job detail / log / follow-up / cancel ----
      const detailRe = new RegExp(`^${API_PREFIX}/jobs/([^/]+)$`);
      const logRe = new RegExp(`^${API_PREFIX}/jobs/([^/]+)/log$`);
      const followRe = new RegExp(`^${API_PREFIX}/jobs/([^/]+)/follow-up$`);
      const cancelRe = new RegExp(`^${API_PREFIX}/jobs/([^/]+)/cancel$`);
      const approvalRe = new RegExp(`^${API_PREFIX}/jobs/([^/]+)/approval$`);

      // /log (GET) — must be matched before the bare detail (no trailing slash).
      const logM = p.match(logRe);
      if (logM && method === "GET") {
        const id = safeIdOrNull(logM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: logM[1] });
          return;
        }
        const job = getStatus(root, id);
        if (!job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        const log = readLogBatch(root, id, {
          cursor: url.searchParams.get("cursor"),
          limit: url.searchParams.get("limit"),
          includeReasoning: url.searchParams.get("include_reasoning"),
          activity: url.searchParams.get("activity"),
          scope: url.searchParams.get("scope"),
          currentGeneration: job.generation
        });
        sendJson(res, 200, {
          ok: true,
          id,
          status: job.status,
          terminal: job.status === "done" || job.status === "error" || job.status === "cancelled" || job.status === "interrupted",
          entries: log.entries,
          cursor: log.cursor,
          drained: log.drained,
          limit: log.limit,
          read_bytes: log.readBytes,
          pending: log.pending,
          ...(log.cursorError ? { cursor_error: log.cursorError } : {})
        });
        return;
      }

      const followM = p.match(followRe);
      if (followM && method === "POST") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const id = safeIdOrNull(followM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: followM[1] });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code, { error: body.code === 413 ? "body_too_large" : body.code === 415 ? "bad_content_type" : "bad_json", message: body.message });
          return;
        }
        const message = typeof (body.value as Record<string, unknown>).message === "string"
          ? ((body.value as Record<string, unknown>).message as string).trim()
          : "";
        if (!message) {
          sendJson(res, 400, { error: "missing_message", message: "follow-up requires a message field." });
          return;
        }
        const job = getStatus(root, id);
        if (!job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        try {
          const continuation = await continueJobViaDaemon(root, {
            jobId: id,
            task: message,
            fixturePath: effectiveFixture,
            cliPath: effectiveCli,
            env: { ...env, CREWDISPATCH_DATA_ROOT: root, JOBQUAY_DATA_ROOT: root },
            messageSource: "dashboard"
          });
          sendJson(res, 200, {
            ok: true,
            job_id: continuation.job.id,
            status: continuation.job.status,
            generation: continuation.job.generation
          });
        } catch (e) {
          const code = e instanceof JobDaemonError ? e.code : "continuation_failed";
          const status = code === "job_not_terminal" || code === "job_transition_busy" || code === "workspace_busy" || code === "not_found" || code === "no_session" || code === "old_tree_unconfirmed"
            ? 409
            : code === "message_history_write_failed" || code === "continuation_persist_failed" || code.startsWith("daemon_")
              ? 503
              : 400;
          sendJson(res, status, { ok: false, code, error: String((e as Error)?.message || e) });
        }
        return;
      }

      const cancelM = p.match(cancelRe);
      if (cancelM && method === "POST") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const id = safeIdOrNull(cancelM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: cancelM[1] });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code, { error: body.code === 413 ? "body_too_large" : body.code === 415 ? "bad_content_type" : "bad_json", message: body.message });
          return;
        }
        const waitRaw = (body.value as Record<string, unknown>).wait_seconds;
        let waitMs = 5000;
        if (waitRaw != null) {
          const n = Number(waitRaw);
          if (!Number.isFinite(n) || n < 0 || n > 60) {
            sendJson(res, 400, { error: "invalid_wait_seconds", message: "wait_seconds must be a number between 0..60." });
            return;
          }
          waitMs = Math.round(n * 1000);
        }
        const result = await requestCancel(root, id, { by: "hub", waitMs, notify: {} });
        if (!result.job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          job_id: result.job.id,
          status: result.job.status,
          cancelled: result.job.status === "cancelled",
          kill: { scope: result.kill.scope, confirmed: result.kill.confirmed, pid: result.kill.pid },
          finalized_by: result.finalizedBy,
          provider_cancel: result.providerCancel
        });
        return;
      }

      // ---- interactive provider approval (read + resolve) ----
      //
      // Provider-neutral by design: the Hub serves and resolves whatever the
      // job record's bounded `pendingApproval` describes. WorkBuddy is the only
      // producer today; a future provider with equivalent semantics reuses the
      // same two routes with no Hub change. The decision is claimed with an
      // exclusive create, so two tabs / duplicate POSTs can never resolve the
      // same approval twice — the first write wins and every later caller gets
      // a stable already-resolved (or stale) answer.
      const approvalM = p.match(approvalRe);
      if (approvalM && method === "GET") {
        const id = safeIdOrNull(approvalM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: approvalM[1] });
          return;
        }
        const job = getStatus(root, id);
        if (!job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          job_id: id,
          status: job.status,
          generation: job.generation,
          pending_approval: hubRunningApproval(job)
        });
        return;
      }
      if (approvalM && method === "POST") {
        if (!assertSameOrigin(req, bind)) {
          sendJson(res, 403, { error: "cross_origin_rejected", message: "Cross-origin write rejected." });
          return;
        }
        const id = safeIdOrNull(approvalM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: approvalM[1] });
          return;
        }
        const body = await readBody(req);
        if (!body.ok) {
          sendJson(res, body.code, { error: body.code === 413 ? "body_too_large" : body.code === 415 ? "bad_content_type" : "bad_json", message: body.message });
          return;
        }
        const optionRaw = (body.value as Record<string, unknown>).option_id;
        const optionId = typeof optionRaw === "string" ? optionRaw.trim() : "";
        if (!optionId || optionId.length > 64) {
          sendJson(res, 400, { error: "invalid_option_id", message: "approval resolution requires one provider-published option_id." });
          return;
        }
        const generation = (body.value as Record<string, unknown>).generation;
        const requestId = (body.value as Record<string, unknown>).request_id;
        if (!Number.isSafeInteger(generation) || (generation as number) < 0 || typeof requestId !== "string" || safeApprovalToken(requestId) !== requestId) {
          sendJson(res, 400, { error: "invalid_approval_identity", message: "Approval requires the generation and request_id shown on the card." });
          return;
        }
        const job = getStatus(root, id);
        if (!job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        // A retry for the exact old identity may read its winner, even after
        // consumption; it must never claim the current replacement request.
        const previous = readApprovalDecision(root, id, generation as number, requestId);
        if (previous) {
          sendJson(res, 200, { ok: true, status: "already_resolved", job_id: id,
            generation, request_id: requestId, option_id: previous.optionId, kind: previous.kind, by: previous.by });
          return;
        }
        const pending = job.status === "running" ? job.pendingApproval : null;
        if (!pending) {
          sendJson(res, 409, { ok: false, code: "no_pending_approval", job_id: id, message: "This session has no pending provider approval." });
          return;
        }
        if (job.generation !== generation || pending.generation !== generation || pending.jobId !== id || pending.requestId !== requestId) {
          sendJson(res, 409, { ok: false, code: "stale_approval", job_id: id, message: "This approval was replaced. Review the current request before choosing." });
          return;
        }
        if (!(Date.parse(pending.expiresAt) > Date.now())) {
          sendJson(res, 409, { ok: false, code: "approval_expired", job_id: id, message: "This approval expired without a decision. No choice was submitted." });
          return;
        }
        const option = pending.options.find((entry) => entry.id === optionId);
        if (!option) {
          sendJson(res, 400, { ok: false, code: "unknown_option", job_id: id, message: "The provider did not publish this approval option." });
          return;
        }
        const decision: ApprovalDecision = {
          version: 1,
          jobId: id,
          generation: job.generation,
          requestId: pending.requestId,
          optionId: option.id,
          kind: canonicalApprovalKind(option.kind) ?? option.kind,
          decidedAt: new Date().toISOString(),
          by: "hub"
        };
        const claim = claimApprovalDecision(root, decision);
        const existing = claim.existing;
        if (!claim.claimed) {
          if (
            existing &&
            existing.jobId === id &&
            existing.generation === job.generation &&
            existing.requestId === pending.requestId
          ) {
            // A duplicate/late answer to an already-resolved request: stable,
            // idempotent and never a second resolution.
            sendJson(res, 200, {
              ok: true,
              status: "already_resolved",
              job_id: id,
              generation: job.generation,
              request_id: pending.requestId,
              option_id: existing.optionId,
              kind: existing.kind,
              by: existing.by
            });
            return;
          }
          sendJson(res, 409, { ok: false, code: "stale_approval", job_id: id, message: "The pending approval was already resolved or superseded." });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          status: "resolved",
          job_id: id,
          generation: job.generation,
          request_id: pending.requestId,
          option_id: decision.optionId,
          kind: decision.kind
        });
        return;
      }

      const detailM = p.match(detailRe);
      if (detailM && method === "GET") {
        const id = safeIdOrNull(detailM[1] ?? "");
        if (!id) {
          sendJson(res, 400, { error: "invalid_job_id", id: detailM[1] });
          return;
        }
        const job = getStatus(root, id);
        if (!job) {
          sendJson(res, 404, { error: "not_found", id });
          return;
        }
        sendJson(res, 200, hubJobDetail(root, job));
        return;
      }

      sendJson(res, 404, { error: "not_found", path: p });
    } catch (e) {
      sendJson(res, 500, { error: String((e as Error)?.message || e) });
    }
  };
}

/** Validate a job id from the URL (safeId throws on anything unsafe). */
function safeIdOrNull(id: string): string | null {
  try {
    return safeId(id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Incremental, bounded, READ-ONLY log reader (no reasoning leakage / fabrication)
// ---------------------------------------------------------------------------

/**
 * Keys whose values are the official CLI's private "thinking" content. These must
 * be REMOVED from the default (hidden) response and only ever SURFACED when the
 * caller explicitly asks for reasoning — never invented.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set(["reasoning", "thinking"]);

/** Deep-strip any reasoning/thinking content at ANY depth.
 *
 * Command Code has two shapes in current releases:
 * - object fields named reasoning/thinking;
 * - streaming event objects whose type is thinking_delta / thinking_end and whose
 *   private text lives under generic keys such as delta/text.
 *
 * The latter must be redacted too when reasoning is not explicitly requested.
 */
function stripReasoning(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripReasoning);
  if (obj && typeof obj === "object") {
    const source = obj as Record<string, unknown>;
    const objectType = typeof source.type === "string" ? source.type.toLowerCase() : "";
    const thinkingPayload = objectType === "thinking" || objectType.startsWith("thinking_");
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) continue;
      if (thinkingPayload && (lower === "delta" || lower === "text" || lower === "content")) continue;
      out[k] = stripReasoning(v);
    }
    return out;
  }
  return obj;
}

/**
 * Collect every real reasoning/thinking string the official CLI actually emitted,
 * including current streaming thinking_delta/thinking_end shapes. Used only when
 * the caller opted in; nothing is synthesized.
 */
function collectReasoning(obj: unknown): unknown[] {
  const found: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e);
      return;
    }
    if (v && typeof v === "object") {
      const source = v as Record<string, unknown>;
      const objectType = typeof source.type === "string" ? source.type.toLowerCase() : "";
      const thinkingPayload = objectType === "thinking" || objectType.startsWith("thinking_");
      for (const [k, val] of Object.entries(source)) {
        const lower = k.toLowerCase();
        if (
          val != null &&
          val !== "" &&
          (SECRET_KEYS.has(lower) || (thinkingPayload && (lower === "delta" || lower === "text")))
        ) {
          found.push(val);
        } else {
          walk(val);
        }
      }
    }
  };
  walk(obj);
  return found;
}

/** Event records that are token/snapshot noise in the human Live activity view. */
function skipActivityRecord(parsed: unknown, includeReasoning: boolean): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "event" || !record.event || typeof record.event !== "object") return false;
  const event = record.event as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "thinking_delta" || type === "thinking_start" || type === "text_delta" || type === "message_update" || type === "message_start") {
    return true;
  }
  // The canonical provider-neutral usage event is a METRIC notification (the
  // ACP runtime publishes it repeatedly during one turn) and is rendered by the
  // shared job-header usage formatter, not as one activity row per update.
  if (type === "usage") return true;
  // With reasoning hidden, the complete thinking block itself is not useful as an
  // empty "thinking_end" marker and must not leak its text.
  if (type === "thinking_end" && !includeReasoning) return true;
  return false;
}

const runStartOffsetCache = new Map<string, number>();

/**
 * Resolve the byte offset of one logical CrewDispatch run (generation) without
 * replaying the whole transcript through the HTTP client. Command Code emits
 * one compact run_start event at each fresh/resumed CLI run, which aligns with
 * CrewDispatch's generation boundary. Generation 0 is always byte 0.
 *
 * The offset is cached per data-root/job/generation. Logs are append-only while
 * a job is active, so an accepted run's start offset does not move.
 */
function generationRunStartOffset(root: string, id: string, generation: number, fd: number, size: number): number {
  if (generation <= 0 || size <= 0) return 0;
  const key = `${root}\u0000${id}\u0000${generation}`;
  const cached = runStartOffsetCache.get(key);
  if (cached !== undefined && cached <= size) return cached;

  const chunkSize = 1024 * 1024;
  let position = 0;
  let carry = Buffer.alloc(0);
  let carryOffset = 0;
  let seen = -1;

  const inspectLine = (line: Buffer, lineOffset: number): number | null => {
    if (line.length === 0 || line.length > LOG_MAX_LINE_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return null;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "event"
    ) {
      const event = (parsed as Record<string, unknown>).event;
      if (event && typeof event === "object" && (event as Record<string, unknown>).type === "run_start") {
        seen += 1;
        if (seen === generation) return lineOffset;
      }
    }
    return null;
  };

  while (position < size) {
    const length = Math.min(chunkSize, size - position);
    const chunk = Buffer.allocUnsafe(length);
    const nread = fs.readSync(fd, chunk, 0, length, position);
    if (nread <= 0) break;
    const piece = chunk.subarray(0, nread);
    const baseOffset = carry.length > 0 ? carryOffset : position;
    const data = carry.length > 0 ? Buffer.concat([carry, piece]) : piece;
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline < 0) break;
      const found = inspectLine(data.subarray(start, newline), baseOffset + start);
      if (found !== null) {
        runStartOffsetCache.set(key, found);
        return found;
      }
      start = newline + 1;
    }
    carry = data.subarray(start);
    carryOffset = baseOffset + start;
    if (carry.length > LOG_MAX_LINE_BYTES) {
      // The current record cannot be a valid run_start line. Keep no unbounded
      // carry; resume after its newline arrives in a later chunk.
      carry = Buffer.alloc(0);
      carryOffset = position + nread;
    }
    position += nread;
  }

  if (carry.length > 0) {
    const found = inspectLine(carry, carryOffset);
    if (found !== null) {
      runStartOffsetCache.set(key, found);
      return found;
    }
  }
  return 0;
}

function readLogBatch(
  root: string,
  id: string,
  q: { cursor: string | null; limit: string | null; includeReasoning: string | null; activity: string | null; scope: string | null; currentGeneration: number }
): {
  entries: Array<Record<string, unknown>>;
  cursor: string;
  drained: boolean;
  limit: number;
  readBytes: number;
  pending: boolean;
  cursorError?: string;
} {
  // logPath already applies safeId + assertInside.
  const file = logPath(root, id);
  let limit = LOG_DEFAULT_LIMIT;
  if (q.limit !== null && q.limit !== "") {
    const n = Number(q.limit);
    if (Number.isInteger(n) && n > 0) limit = Math.min(n, LOG_MAX_LIMIT);
  }

  let offset = 0;
  let discarding = false;
  let cursorError: string | undefined;
  if (q.cursor !== null && q.cursor !== "") {
    const match = /^(d:)?(0|[1-9]\d*)$/.exec(q.cursor);
    const n = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(n)) {
      cursorError = "invalid_cursor_reset_to_start";
    } else {
      offset = n;
      discarding = Boolean(match[1]);
    }
  }

  const includeReasoning = q.includeReasoning === "true" || q.includeReasoning === "1";
  const activity = q.activity === "true" || q.activity === "1";
  const entries: Array<Record<string, unknown>> = [];
  let readBytes = 0;
  let pending = false;
  let drained = false;
  const reset = (reason: string): {
    entries: Array<Record<string, unknown>>;
    cursor: string;
    drained: boolean;
    limit: number;
    readBytes: number;
    pending: boolean;
    cursorError?: string;
  } => ({ entries: [], cursor: "0", drained: false, limit, readBytes, pending: false, cursorError: reason });
  if (cursorError) return reset(cursorError);

  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { entries, cursor: String(offset), drained: true, limit, readBytes, pending: false, ...(cursorError ? { cursorError } : {}) };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if ((q.cursor === null || q.cursor === "" || q.cursor === "0") && q.scope === "current") {
      offset = generationRunStartOffset(root, id, q.currentGeneration, fd, size);
      discarding = false;
    }
    if (offset > size) return reset("cursor_out_of_range_reset_to_start");
    // Ordinary cursors must identify a record boundary. A discard cursor must
    // remain inside a line. The one-byte probe is included in the same strict
    // disk-read budget as the batch buffer.
    if (discarding && offset === 0) return reset("invalid_discard_cursor_reset_to_start");
    if (offset > 0) {
      const previous = Buffer.allocUnsafe(1);
      const n = fs.readSync(fd, previous, 0, 1, offset - 1);
      readBytes += n;
      if (n !== 1) return reset("cursor_out_of_range_reset_to_start");
      if (!discarding && previous[0] !== 0x0a) return reset("cursor_not_at_record_boundary_reset_to_start");
      if (discarding && previous[0] === 0x0a) return reset("invalid_discard_cursor_reset_to_start");
    }
    const maxBatchBuffer = LOG_MAX_READ_BYTES - readBytes;
    if (maxBatchBuffer <= 0) {
      return { entries, cursor: discarding ? `d:${offset}` : String(offset), drained: false, limit, readBytes, pending: false, ...(cursorError ? { cursorError } : {}) };
    }
    const buffer = Buffer.allocUnsafe(Math.min(maxBatchBuffer, Math.max(0, size - offset)));
    const nread = buffer.length > 0 ? fs.readSync(fd, buffer, 0, buffer.length, offset) : 0;
    readBytes += nread;
    const data = buffer.subarray(0, nread);
    let consumed = 0;

    while (consumed < data.length && entries.length < limit) {
      if (discarding) {
        const newline = data.indexOf(0x0a, consumed);
        if (newline < 0) {
          consumed = data.length;
          // Only an unterminated line at the CURRENT snapshot end is truly
          // pending. Hitting the bounded read-window edge while more bytes are
          // already on disk must remain immediately pageable.
          pending = offset + data.length >= size;
          break;
        }
        consumed = newline + 1;
        discarding = false;
        // The oversized-line diagnostic was emitted when discard mode began.
        // Continue at the next complete record, if this bounded read has more.
        continue;
      }

      const newline = data.indexOf(0x0a, consumed);
      if (newline < 0) {
        const tailBytes = data.length - consumed;
        const atSnapshotEnd = offset + data.length >= size;
        if (tailBytes > LOG_MAX_LINE_BYTES) {
          entries.push({ offset: offset + consumed, error: "line_too_large" });
          consumed = data.length;
          discarding = true;
          pending = atSnapshotEnd;
        } else {
          // Keep an incomplete tail at its record start. It is "pending" only
          // when this bounded read reached the current file end; if more bytes
          // already exist, the caller can page again immediately from the same
          // record boundary without waiting for a future append.
          pending = atSnapshotEnd && tailBytes > 0;
        }
        break;
      }

      const lineLength = newline - consumed;
      const lineOffset = offset + consumed;
      const nextConsumed = newline + 1;
      if (lineLength > LOG_MAX_LINE_BYTES) {
        entries.push({ offset: lineOffset, error: "line_too_large" });
        consumed = nextConsumed;
        continue;
      }

      const raw = data.toString("utf8", consumed, newline);
      consumed = nextConsumed;
      if (!raw) continue;
      const entry: Record<string, unknown> = { offset: lineOffset };
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        if (activity && skipActivityRecord(parsed, includeReasoning)) continue;
        // The default response recursively strips reasoning fields and current
        // streaming thinking payloads. Opt-in exposes only values the CLI emitted.
        entry.data = includeReasoning ? parsed : stripReasoning(parsed);
        if (includeReasoning) {
          const event =
            (parsed as Record<string, unknown>).type === "event" &&
            (parsed as Record<string, unknown>).event &&
            typeof (parsed as Record<string, unknown>).event === "object"
              ? ((parsed as Record<string, unknown>).event as Record<string, unknown>)
              : null;
          const eventType = event && typeof event.type === "string" ? event.type : null;
          // In compact activity mode, message_end repeats the same thinking block
          // already emitted by thinking_end. Keep its assistant text, not duplicate
          // the reasoning block.
          const reasoning = activity && eventType === "message_end" ? [] : collectReasoning(parsed);
          if (reasoning.length) entry.reasoning = reasoning;
        }
      } else {
        // Unparseable output cannot be safely redacted or selectively exposed,
        // even with opt-in. Never echo raw bytes from parse failures.
        entry.unparsed = true;
      }
      entries.push(entry);
    }

    const cursorOffset = offset + consumed;
    const reachedSnapshotEnd = cursorOffset >= size;
    // A partial line or a currently unterminated oversized line may become
    // complete after a later append, so it is never called drained.
    drained = reachedSnapshotEnd && !pending && !discarding;
    if (!drained && cursorOffset < size && entries.length >= limit) pending = false;
    return {
      entries,
      cursor: discarding ? `d:${cursorOffset}` : String(cursorOffset),
      drained,
      limit,
      readBytes,
      pending: pending || (discarding && reachedSnapshotEnd),
      ...(cursorError ? { cursorError } : {})
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/** Start the hub HTTP server (binds 127.0.0.1 only). */
export function startHub(opts: HubOptions = {}): HubHandle {
  const requestedHost = opts.host ?? "127.0.0.1";
  if (!isLoopbackHost(requestedHost)) {
    throw new Error("Hub host must be a loopback address; it always binds to 127.0.0.1.");
  }
  // Bind the literal IPv4 loopback address even when the caller used localhost
  // or ::1; host name resolution must never choose a non-loopback interface.
  const host = "127.0.0.1";
  const port = opts.port ?? 30080;
  const env = opts.env ?? process.env;
  const root = resolveDataRoot(opts.root, env);
  // Make sure the directory skeleton exists; the message-history side-car and
  // global-settings file are created on demand by their own writers.
  ensureRootSkeleton(root);
  const bind = { host, port };
  // ONE instance token for this Hub: the endpoint record and the self-check both
  // key on it, so ownership is never confused by a shared PID (two Hubs started
  // from the same process still get distinct tokens).
  const instanceId = opts.instanceId ?? newHubInstanceId();
  const identity = hubBuildIdentity(opts);
  // A restart request ends this process gracefully: close the listener and let
  // the event loop drain, with a hard bound so a wedged socket can never keep a
  // replaced Hub alive.
  const requestShutdown = opts.onShutdownRequest ?? (() => {
    try {
      server.closeAllConnections?.();
    } catch {
      /* older runtimes have no closeAllConnections */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
  const handler = createHubHandler({ ...opts, instanceId, identity, onShutdownRequest: requestShutdown }, bind);
  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      try {
        sendJson(res, 500, { error: String((e as Error)?.message || e) });
      } catch {
        /* response already sent / socket closed */
      }
    });
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (address && typeof address === "object") bind.port = address.port;
    // Claim the ONE durable current-endpoint record for this data root. It
    // carries the ownership identity (instance/build/version/root fingerprint)
    // the self-check and the approval bridge both rely on; the provider bridge
    // still has to prove a live CrewDispatch Hub before any approval is offered.
    try {
      writeHubEndpoint(root, {
        port: bind.port,
        pid: process.pid,
        instanceId,
        buildId: identity.buildId,
        version: identity.version,
        rootId: dataRootId(root)
      });
    } catch {
      /* best effort: without it the bridge declines as before */
    }
    console.error(`[jobquay-hub] listening on http://${host}:${bind.port}${API_PREFIX} (root=${root})`);
    // Startup NEVER probes provider settings: a provider CLI is spawned only
    // when a settings request actually asks for one.
  });
  // Release the endpoint only when it is still OURS (matched by instance id, so
  // a newer Hub's record is never cleared by an older process shutting down).
  server.once("close", () => {
    try {
      clearHubEndpoint(root, { instanceId });
    } catch {
      /* best effort */
    }
  });
  return {
    server,
    get port() {
      const address = server.address();
      return address && typeof address === "object" ? address.port : port;
    },
    root
  };
}

function ensureRootSkeleton(root: string): void {
  // Mirrors store.ensureRoot without the terminal dirs we don't need here.
  for (const dir of [root, path.join(root, "jobs"), path.join(root, "logs")]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best-effort */
    }
  }
  // Sanity: keep the resolved root honest.
  assertInside(root, path.join(root, "jobs"));
}

/** Read `--flag value` from a CLI argv; null when absent or empty. */
function hubCliArg(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return null;
  const value = argv[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * CLI entry — `node dist/hub/server.js [--port <n>] [--root <dir>]`.
 *
 * The explicit flags exist for the durable Windows launch: a Hub created
 * through the WMI provider host does NOT inherit the launcher's environment
 * block (see src/runtime/durable-launch.ts), so the port and the data root must
 * travel as argv. Environment resolution stays the default and keeps its
 * documented precedence when no flag is given.
 */
export function main(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): HubHandle {
  const port = Number(hubCliArg(argv, "--port") ?? env.HUB_PORT ?? env.PORT ?? 30080);
  const root = resolveDataRoot(hubCliArg(argv, "--root") ?? undefined, env);
  const startedAtMs = Date.now();
  // Capture the PREVIOUS owner BEFORE startHub claims the endpoint, so a Hub
  // left running on another loopback port for the SAME data root can be retired
  // once this one is up. A foreign listener (or another root's Hub) is never
  // touched: retirement re-proves a live same-root CrewDispatch Hub first.
  const previous = readHubEndpoint(root);
  const handle = startHub({ root, port, host: "127.0.0.1" });
  handle.server.once("listening", () => {
    void retireHubEndpoint(previous, {
      currentPort: handle.port,
      root,
      startedAtMs
    }).catch(() => undefined);
  });
  // A settings save / startup is a natural retention entry point: best-effort.
  try {
    enforceRetention(handle.root);
  } catch {
    /* best-effort */
  }
  return handle;
}

if (require.main === module) {
  main();
}
