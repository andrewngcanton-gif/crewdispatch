// approval.ts — the provider-neutral INTERACTIVE PROVIDER APPROVAL channel.
//
// A running provider turn may demand an explicit human decision before it
// continues (today: WorkBuddy ACP `session/request_permission`). CrewDispatch used
// to be strictly non-interactive and declined every such request. This module
// defines the ONE bounded, display-safe protocol that lets the local Hub answer
// it instead:
//
//   bridge (owns the provider connection)        Hub / Dashboard (the only UI)
//   --------------------------------------       ---------------------------
//   writes ONE pending request file       <---   reads the job's pendingApproval
//   polls for the decision file           <---   claims ONE decision file (`wx`)
//   replies to the SAME JSON-RPC request
//
// Files are generation+request scoped under `<root>/approval/`:
//
//   <jobId>.gen-<g>.<requestToken>.request.json    (bridge, atomic replace)
//   <jobId>.gen-<g>.<requestToken>.decision.json   (Hub, exclusive claim)
//
// The exclusive `wx` claim makes a decision consumable exactly once: two tabs
// or duplicate POSTs race for the same file and exactly one wins; every later
// caller reads the winner's decision back (a stable "already resolved" answer).
//
// The request and the decision carry ONLY stable, display-safe fields: identity
// (job/generation/request), provider id, the provider's own option ids/kinds/
// labels, timestamps, and ONE bounded provider-neutral operation detail.
//
// The operation detail is the SINGLE, deliberately narrow exception to the old
// "no command text at all" rule: a human cannot make an informed decision about
// an approval without seeing WHAT the provider asked to run. It is extracted
// field by field from the provider's own request (`command`, `description`,
// `file_path`/`path`, `cwd`, title/text) — never copied wholesale — then
// bounded, stripped of control sequences and redacted for obvious credentials.
// Prompt text, environment dumps, arbitrary provider payloads, stack traces and
// secrets still never enter this protocol, the job record, the Hub API or the
// UI, and displayed content is only ever rendered as plain text — never
// executed and never assigned as HTML.
//
// The same module is imported by the provider bridge (a child process), the job
// worker and the Hub server, so the path/format/validation rules cannot drift.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clearHubEndpoint,
  readHubEndpoint,
  writeHubEndpoint,
  type HubEndpointRecord
} from "../hub/endpoint";

export const APPROVAL_PROTOCOL_VERSION = 1;
/** Bounded at every edge: a provider publishes a handful of choices, never more. */
export const APPROVAL_OPTION_MAX = 8;
export const APPROVAL_ID_CAP = 64;
export const APPROVAL_LABEL_CAP = 64;
export const APPROVAL_KIND_CAP = 32;
export const APPROVAL_SUMMARY_CAP = 160;
/**
 * Bound on the provider-neutral operation detail carried with an approval.
 * Larger than a label because a real command line (or a path list) is long, yet
 * small enough that the durable record, the Hub JSON and the UI stay bounded.
 */
export const APPROVAL_DETAIL_CAP = 600;
/**
 * How many separately supplied arguments an approval detail may carry. Bounded
 * like every other detail field: the durable record, the Hub JSON and the UI
 * must stay small, and a provider that publishes more than a human could read
 * is marked truncated instead of copied.
 */
export const APPROVAL_ARGS_MAX = 32;
/**
 * Sanity bound applied BEFORE any control-stripping/redaction regex runs on a
 * provider string. The display bound (`APPROVAL_DETAIL_CAP`) is far smaller, so
 * an oversized value is still truthfully marked truncated; this only stops a
 * hostile or broken provider from forcing regex work over an unbounded string.
 */
export const APPROVAL_DETAIL_SCAN_CAP = 8192;
/** Entries of a provider `args` list that are examined before truncation is marked. */
const APPROVAL_ARGS_SCAN_MAX = 64;
/**
 * How long one pending approval may wait before the bridge gives up and keeps
 * the historical safe decline. Bounded on purpose: an unattended job must not
 * hang forever on a question nobody can answer.
 *
 * ONE HOUR by default: host acceptance is slow and a human may need to reach
 * the Dashboard long after the gate opened. This is the SHARED default for both
 * first-release providers (WorkBuddy AI and Command Code), so it applies
 * whenever a bridge constructs the channel without an explicit per-channel
 * `timeoutMs` override. It is a bounded interactive GATE wait only — never a
 * task wall-clock timeout, and unrelated to a provider's own command caps or
 * the ACP request/control budgets, which keep their own values.
 */
export const APPROVAL_DEFAULT_TIMEOUT_MS = 60 * 60_000;
/** Bridge poll cadence while waiting for a decision. */
export const APPROVAL_POLL_MS = 400;
/** The Hub route probe budget (a dead Hub must not stall the decline path). */
export const APPROVAL_HUB_PROBE_TIMEOUT_MS = 1500;

/** The three provider-published decision classes CrewDispatch can name plainly. */
export type ApprovalDecisionKind = "allow_once" | "allow_always" | "reject_once";

export interface ApprovalOption {
  /** The provider's own option id — echoed back verbatim in the ACP reply. */
  id: string;
  /** The provider's own kind token (e.g. allow_once / allow_always / reject_once). */
  kind: string;
  /**
   * The provider's own label. It is the PREFERRED display text for every kind,
   * including the recognised decision classes: same-kind options may carry
   * distinct provider labels (several `allow_once` choices with different
   * scope statements), and the UI must keep those choices distinguishable. The
   * canonical kind wording is only a fallback for an option with no usable
   * label; normalization substitutes the option id in that case.
   */
  label: string;
}

/**
 * The provider-neutral, display-safe description of the operation the provider
 * asked to run. Every field is optional; `null` means the provider published
 * nothing usable for it. `command` (with any separately supplied `args`) is
 * preferred over `description` when both exist — the ACTUAL operation beats a
 * human paraphrase — and the UI shows the missing-detail message only when
 * every field is null.
 */
export interface ApprovalDetail {
  /** The actual operation (usually a command line), preserved as readable text. */
  command: string | null;
  /**
   * The provider's separately supplied arguments, one display-safe entry per
   * argument, when it published them as a list instead of inside `command`
   * (the ACP `shell_command` tool accepts both forms). Each entry is its own
   * sanitized token — the argv boundaries are never re-joined into an invented
   * shell command line, and ordinary whitespace (leading/trailing spaces, tabs,
   * newlines) is preserved EXACTLY. An empty string is a valid argument and is
   * kept verbatim; an entry is never dropped without the honest `truncated`
   * mark. Null when the provider published no separate arguments.
   */
  args: string[] | null;
  /** The provider's own short description, when it published no command. */
  description: string | null;
  /** A file path the operation targets, when published. */
  path: string | null;
  /** The working directory the operation runs in, when published. */
  cwd: string | null;
  /** The provider's own title/text for the operation, when published. */
  title: string | null;
  /**
   * The provider's own approval GATE token, when it published one on the wire
   * (e.g. the ACP `codebuddy.ai/approvalKind`). Never guessed: null when the
   * provider supplied none.
   */
  gate: string | null;
  /**
   * The provider's own approval REASON/category token, when it published one on
   * the wire (e.g. the ACP `codebuddy.ai/approvalCategory`). Never a guessed
   * risk classification.
   */
  reason: string | null;
  /** Honest mark: the text was shortened to fit the bound. */
  truncated: boolean;
  /** Honest mark: an obvious credential was replaced with `<redacted>`. */
  redacted: boolean;
}

/**
 * One bounded, display-safe pending approval. This is BOTH the file payload and
 * the provider-neutral `pendingApproval` field a running job record carries, so
 * the Hub/UI never parse a provider payload to render a decision.
 */
export interface PendingApproval {
  version: number;
  kind: "tool_approval";
  /** Canonical provider id that requested the approval (e.g. "workbuddy-ai"). */
  provider: string;
  jobId: string;
  generation: number;
  /** The provider's JSON-RPC request id (bounded, never used as a raw path). */
  requestId: string;
  /** The provider's bounded tool-name token, or null (never the tool input). */
  toolName: string | null;
  /** An optional bounded one-line summary; null when the provider published none. */
  summary: string | null;
  /** The bounded, sanitized operation detail, or null when none was published. */
  detail: ApprovalDetail | null;
  options: ApprovalOption[];
  createdAt: string;
  expiresAt: string;
}

/** The ONE claimed decision for a pending approval (first write wins). */
export interface ApprovalDecision {
  version: number;
  jobId: string;
  generation: number;
  requestId: string;
  optionId: string;
  /** The provider's own kind of the chosen option (canonicalized when provable). */
  kind: string;
  decidedAt: string;
  /** Which surface resolved it (stable token, e.g. "hub"). */
  by: string;
}

/**
 * The Hub's advertised local approval route (written by startHub on listen).
 * `instance_id` / `build_id` / `version` / `root_id` are the ownership identity
 * added by the current-Hub contract; they are optional so a legacy record still
 * reads.
 */
export interface HubApprovalEndpoint {
  port: number;
  pid: number;
  at: string;
  instance_id?: string;
  build_id?: string | null;
  version?: string | null;
  root_id?: string;
}

// ---------------------------------------------------------------------------
// Bounded sanitizers
// ---------------------------------------------------------------------------

/** One-line, control-character-free, bounded text; null when nothing remains. */
export function safeApprovalText(value: unknown, cap: number): string | null {
  if (typeof value !== "string") return null;
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length <= cap ? oneLine : oneLine.slice(0, cap);
}

/** A bounded identifier token ([A-Za-z0-9._-], no leading dot/dash). */
export function safeApprovalToken(value: unknown, cap: number = APPROVAL_ID_CAP): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > cap) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) || text.includes("..")) return null;
  return text;
}

/**
 * An obvious credential in a command line. Three shapes are recognised, all of
 * which join a credential KEYWORD to a value: `KEYWORD=…`/`KEYWORD: …`
 * (`token=…`, `Authorization: Bearer …`), a CLI-flag form
 * (`--password …`, `--api-key …`), and a quoted value (`password "…"`). Plain
 * prose is left alone because a bare `KEYWORD value` with no `:`, `=`, dash or
 * quotes is not a credential.
 */
const APPROVAL_CREDENTIAL_KEYWORDS =
  "authorization|proxy-authorization|token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret";
/** `KEYWORD=value` / `KEYWORD: value` (with an optional auth scheme). */
const APPROVAL_CREDENTIAL_RE = new RegExp(
  `\\b(${APPROVAL_CREDENTIAL_KEYWORDS})\\b(\\s*[:=]\\s*)(?:(?:Bearer|Basic|Token|Digest)\\s+)?("[^"\\n]*"|'[^'\\n]*'|[^\\s,;]+)`,
  "gi"
);
/** A whitespace-separated CLI flag credential: `--password …`, `-api-key …`. */
const APPROVAL_FLAG_CREDENTIAL_RE = new RegExp(
  `(--?(?:${APPROVAL_CREDENTIAL_KEYWORDS})\\b[ \\t]+)(?:(?:Bearer|Basic|Token|Digest)[ \\t]+)?("[^"\\n]*"|'[^'\\n]*'|[^\\s,;]+)`,
  "gi"
);
/** A quoted value directly after its keyword with no `:`/`=`: `password "…"`. */
const APPROVAL_QUOTED_CREDENTIAL_RE = new RegExp(
  `\\b(${APPROVAL_CREDENTIAL_KEYWORDS})\\b([ \\t]+)("[^"\\n]*"|'[^'\\n]*')`,
  "gi"
);
/** A standalone `Bearer <token>` with no credential keyword beside it. */
const APPROVAL_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * A bare CLI credential flag as its OWN argv element (`--api-key`, `-token`).
 * A provider may supply the flag and its value as two separate arguments; the
 * value is then the NEXT element and must be redacted exactly as the
 * whitespace-joined form would be.
 */
const APPROVAL_BARE_FLAG_RE = new RegExp(`^--?(?:${APPROVAL_CREDENTIAL_KEYWORDS})$`, "i");

/** Replace obvious credentials with `<redacted>`, reporting whether any changed. */
function redactApprovalSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text.replace(APPROVAL_CREDENTIAL_RE, (_match, keyword: string, separator: string) => {
    redacted = true;
    return `${keyword}${separator}<redacted>`;
  });
  out = out.replace(APPROVAL_FLAG_CREDENTIAL_RE, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}<redacted>`;
  });
  out = out.replace(APPROVAL_QUOTED_CREDENTIAL_RE, (_match, keyword: string, separator: string) => {
    redacted = true;
    return `${keyword}${separator}<redacted>`;
  });
  out = out.replace(APPROVAL_BEARER_RE, () => {
    redacted = true;
    return "Bearer <redacted>";
  });
  return { text: out, redacted };
}

/**
 * Bounded, display-safe operation text. Unlike `safeApprovalText` this KEEPS
 * newlines and tabs, so a multiline command or a list of paths stays readable
 * instead of collapsing into one long line. ANSI/OSC/CSI escape sequences and
 * the remaining C0/C1 control bytes are removed, obvious credentials are
 * redacted, and the result is capped with an honest `truncated` mark.
 *
 * Two properties are deliberate:
 *
 *  - A value above the sanity scan bound is cut to that bound FIRST. The cut is
 *    tracked SEPARATELY and OR-ed into the final mark, so the truncation stays
 *    truthful even when cleanup/redaction leaves a short or empty remainder
 *    (another detail field can still keep the object usable).
 *  - `preserveWhitespace` keeps ordinary whitespace byte-exact (leading/trailing
 *    spaces, tabs, trailing spaces before a newline, consecutive newlines).
 *    It is used ONLY for separately supplied argv entries, where the exact
 *    value is the point; the control/credential protection and the bounds are
 *    the SAME shared code in both modes.
 */
function safeApprovalDetailText(
  value: unknown,
  cap: number,
  options: { preserveWhitespace?: boolean } = {}
): { text: string | null; truncated: boolean; redacted: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false, redacted: false };
  const scanCut = value.length > APPROVAL_DETAIL_SCAN_CAP;
  const bounded = scanCut ? value.slice(0, APPROVAL_DETAIL_SCAN_CAP) : value;
  let text = bounded
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (!options.preserveWhitespace) {
    text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (!text) return { text: null, truncated: scanCut, redacted: false };
  const { text: clean, redacted } = redactApprovalSecrets(text);
  const truncated = scanCut || clean.length > cap;
  return { text: truncated ? clean.slice(0, cap) : clean, truncated, redacted };
}

/**
 * The provider's separately supplied argument list (`rawInput.args` on the ACP
 * wire). Each element is sanitized as its OWN token with the shared control
 * removal, credential redaction and bounds, but with ordinary whitespace
 * preserved EXACTLY — an argument is the value the provider will pass, so
 * trimming or collapsing it would misrepresent argv. An empty string is a valid
 * known argument and is kept verbatim (never marked truncated, never a reason
 * to stop); whitespace-only entries are kept the same way. An element that
 * cannot be displayed at all (a non-string, or a non-empty string with nothing
 * left after control removal) stops the list instead of being skipped, so the
 * shown entries are always a truthful prefix of the real argv. A single string
 * is accepted as a one-element list because the provider's own wire accepts
 * both forms.
 */
function safeApprovalArgs(value: unknown): { args: string[] | null; truncated: boolean; redacted: boolean } {
  const listed = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!listed || listed.length === 0) return { args: null, truncated: false, redacted: false };
  const args: string[] = [];
  let truncated = listed.length > APPROVAL_ARGS_SCAN_MAX;
  let redacted = false;
  let total = 0;
  const scanMax = Math.min(listed.length, APPROVAL_ARGS_SCAN_MAX);
  for (let index = 0; index < scanMax; index += 1) {
    const entry = listed[index];
    // An element CrewDispatch cannot display is never skipped over: the list
    // stops at the last truthful argv position and the detail is marked
    // truncated, so what remains is always a PREFIX of the real argv and can
    // never imply a different argument order.
    if (typeof entry !== "string") {
      truncated = true;
      break;
    }
    // An EMPTY argument is real, known argv data — the shared sanitizer reads
    // an empty string as "nothing usable" for its other fields, so the args
    // path preserves this one case explicitly instead of routing it through.
    const clean =
      entry === ""
        ? { text: "", truncated: false, redacted: false }
        : safeApprovalDetailText(entry, APPROVAL_DETAIL_CAP, { preserveWhitespace: true });
    if (clean.text === null) {
      truncated = true;
      break;
    }
    if (clean.truncated) truncated = true;
    if (clean.redacted) redacted = true;
    if (args.length >= APPROVAL_ARGS_MAX || total + clean.text.length > APPROVAL_DETAIL_CAP) {
      truncated = true;
      break;
    }
    args.push(clean.text);
    total += clean.text.length;
  }
  // A credential may be split across two argv elements (`--api-key`, `value`).
  // Each element was sanitized alone, so the value after a bare credential flag
  // is redacted here — the same protection the joined command line gets.
  for (let index = 0; index < args.length - 1; index += 1) {
    if (APPROVAL_BARE_FLAG_RE.test(args[index]!) && args[index + 1] !== "<redacted>") {
      args[index + 1] = "<redacted>";
      redacted = true;
    }
  }
  return { args: args.length ? args : null, truncated, redacted };
}

/**
 * Normalize ONE provider-neutral operation detail. Returns null when nothing
 * usable was published, so the UI can say so honestly instead of rendering an
 * empty box. Idempotent: re-normalizing an already-sanitized detail keeps its
 * `truncated`/`redacted` marks instead of clearing them.
 */
export function sanitizeApprovalDetail(value: unknown): ApprovalDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const command = safeApprovalDetailText(raw.command, APPROVAL_DETAIL_CAP);
  const args = safeApprovalArgs(raw.args);
  const description = safeApprovalDetailText(raw.description, APPROVAL_DETAIL_CAP);
  const filePath = safeApprovalDetailText(raw.path, APPROVAL_DETAIL_CAP);
  const cwd = safeApprovalDetailText(raw.cwd, APPROVAL_DETAIL_CAP);
  const title = safeApprovalDetailText(raw.title, APPROVAL_DETAIL_CAP);
  // Gate/reason are short provider tokens (an approval kind/category), so they
  // get the label bound rather than the command bound. A guessed value is never
  // fabricated here: an absent field stays null.
  const gate = safeApprovalDetailText(raw.gate, APPROVAL_LABEL_CAP);
  const reason = safeApprovalDetailText(raw.reason, APPROVAL_LABEL_CAP);
  const usable = command.text || args.args || description.text || filePath.text || cwd.text || title.text || gate.text || reason.text;
  if (!usable) return null;
  return {
    command: command.text,
    args: args.args,
    description: description.text,
    path: filePath.text,
    cwd: cwd.text,
    title: title.text,
    gate: gate.text,
    reason: reason.text,
    truncated:
      command.truncated ||
      args.truncated ||
      description.truncated ||
      filePath.truncated ||
      cwd.truncated ||
      title.truncated ||
      gate.truncated ||
      reason.truncated ||
      raw.truncated === true,
    redacted:
      command.redacted ||
      args.redacted ||
      description.redacted ||
      filePath.redacted ||
      cwd.redacted ||
      title.redacted ||
      gate.redacted ||
      reason.redacted ||
      raw.redacted === true
  };
}

/**
 * The filesystem token of one request id. A safe id is used as-is; anything
 * else (a long or exotic provider id) becomes a stable hash prefix, so the
 * token can never contain a separator or escape the approval directory. Both
 * the bridge and the Hub derive it from the same request id.
 */
export function approvalFileToken(requestId: string): string {
  const safe = safeApprovalToken(requestId, APPROVAL_ID_CAP);
  if (safe) return safe;
  return crypto.createHash("sha1").update(String(requestId)).digest("hex").slice(0, 16);
}

/**
 * The canonical decision class of a provider-published option kind, or null
 * when the provider published a kind CrewDispatch cannot name plainly. The REPLY
 * always uses the provider's own `optionId`; this classification only labels
 * the choice for the UI and the durable decision record.
 */
export function canonicalApprovalKind(kind: unknown): ApprovalDecisionKind | null {
  const token = typeof kind === "string" ? kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (token === "allow_once") return "allow_once";
  if (token === "allow_always") return "allow_always";
  if (token === "reject_once" || token === "reject" || token === "reject_always" || token === "deny" || token === "deny_once") {
    return "reject_once";
  }
  return null;
}

/**
 * The bounded, provider-neutral OUTCOME of one interactive approval request, as
 * the bridge PROVED it (canonical `approval_outcome`).
 *
 * A provider turn can pause on an approval gate and then continue without the
 * gated operation. Before this token existed the durable result collapsed every
 * such interruption into `finish_reason=permission_denied`, so a run whose
 * approval route was unavailable or whose request expired could be read as a
 * human refusal — and a completed turn was presented as an unqualified success.
 * The token distinguishes exactly the causes the bridge actually observes:
 *
 *   - `rejected`       — the user selected one of the provider's OWN reject
 *                        options (a real human decision, never inferred);
 *   - `expired`        — the request reached its deadline with no decision;
 *   - `no_route`       — no live interactive approval route existed (no Hub /
 *                        the route probe failed);
 *   - `no_allow_option`— the provider's request published no allow choice, so
 *                        no interactive decision could be offered;
 *   - `publish_failed` — the request could not be published (a local protocol
 *                        or filesystem failure);
 *   - `cancelled`      — the wait was abandoned before a decision (the prompt
 *                        turn ended, or the bridge was torn down).
 *
 * The token is DIAGNOSTIC evidence about the approval gate, never a second
 * failure classification: it never changes a provider turn's status, and a
 * later normal completion keeps its own outcome.
 */
export type ApprovalOutcome = "rejected" | "expired" | "no_route" | "no_allow_option" | "publish_failed" | "cancelled";

const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set([
  "rejected",
  "expired",
  "no_route",
  "no_allow_option",
  "publish_failed",
  "cancelled"
]);

/**
 * A bounded, display-safe approval outcome token, or null.
 *
 * Only the exact canonical tokens are accepted: an unknown value (a corrupt
 * record, or a token a newer build wrote) is dropped rather than displayed as
 * a fabricated cause.
 */
export function safeApprovalOutcome(value: unknown): ApprovalOutcome | null {
  return typeof value === "string" && APPROVAL_OUTCOMES.has(value) ? (value as ApprovalOutcome) : null;
}

// ---------------------------------------------------------------------------
// Normalization (shared by the durable record reader and the stream parser)
// ---------------------------------------------------------------------------

function normalizeOption(raw: unknown): ApprovalOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = safeApprovalToken(o.id, APPROVAL_ID_CAP);
  if (!id) return null;
  const kind = safeApprovalText(o.kind, APPROVAL_KIND_CAP) ?? "unknown";
  const label = safeApprovalText(o.label, APPROVAL_LABEL_CAP) ?? id;
  return { id, kind, label };
}

/**
 * Strictly normalize a pending approval from durable/stream JSON. Any missing
 * or malformed identity field yields null: a half-understood approval is never
 * presented as actionable.
 */
export function normalizePendingApproval(raw: unknown): PendingApproval | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "tool_approval") return null;
  const provider = safeApprovalToken(r.provider, APPROVAL_ID_CAP);
  const jobId = safeApprovalToken(r.jobId, 128);
  const generation = typeof r.generation === "number" && Number.isInteger(r.generation) && r.generation >= 0 ? r.generation : null;
  const requestId = safeApprovalText(r.requestId, 128);
  const createdAt = typeof r.createdAt === "string" && Number.isFinite(Date.parse(r.createdAt)) ? r.createdAt : null;
  const expiresAt = typeof r.expiresAt === "string" && Number.isFinite(Date.parse(r.expiresAt)) ? r.expiresAt : null;
  if (!provider || !jobId || generation == null || !requestId || !createdAt || !expiresAt) return null;
  const options: ApprovalOption[] = [];
  if (Array.isArray(r.options)) {
    for (const entry of r.options) {
      const option = normalizeOption(entry);
      if (option && !options.some((o) => o.id === option.id)) options.push(option);
      if (options.length >= APPROVAL_OPTION_MAX) break;
    }
  }
  if (!options.length) return null;
  return {
    version: APPROVAL_PROTOCOL_VERSION,
    kind: "tool_approval",
    provider,
    jobId,
    generation,
    requestId,
    toolName: safeApprovalText(r.toolName, APPROVAL_ID_CAP),
    summary: safeApprovalText(r.summary, APPROVAL_SUMMARY_CAP),
    detail: sanitizeApprovalDetail(r.detail),
    options,
    createdAt,
    expiresAt
  };
}

/** The stable identity tuple of one pending approval. */
export function pendingApprovalKey(approval: Pick<PendingApproval, "jobId" | "generation" | "requestId">): string {
  return `${approval.jobId}|${approval.generation}|${approval.requestId}`;
}

function normalizeDecision(raw: unknown): ApprovalDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const jobId = safeApprovalToken(d.jobId, 128);
  const generation = typeof d.generation === "number" && Number.isInteger(d.generation) && d.generation >= 0 ? d.generation : null;
  const requestId = safeApprovalText(d.requestId, 128);
  const optionId = safeApprovalToken(d.optionId, APPROVAL_ID_CAP);
  const decidedAt = typeof d.decidedAt === "string" && Number.isFinite(Date.parse(d.decidedAt)) ? d.decidedAt : null;
  if (!jobId || generation == null || !requestId || !optionId || !decidedAt) return null;
  return {
    version: APPROVAL_PROTOCOL_VERSION,
    jobId,
    generation,
    requestId,
    optionId,
    kind: safeApprovalText(d.kind, APPROVAL_KIND_CAP) ?? "unknown",
    decidedAt,
    by: safeApprovalText(d.by, 32) ?? "unknown"
  };
}

// ---------------------------------------------------------------------------
// Bounded file protocol
// ---------------------------------------------------------------------------

function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Directory of the interactive-approval request/decision files. */
export function approvalDir(root: string): string {
  return path.join(root, "approval");
}

function approvalJobToken(jobId: string): string {
  const safe = safeApprovalToken(jobId, 128);
  if (!safe) throw new Error(`unsafe approval job id: ${JSON.stringify(jobId)}`);
  return safe;
}

function approvalGeneration(generation: number): number {
  return Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

function approvalBase(root: string, jobId: string, generation: number, requestId: string): string {
  const file = path.join(
    approvalDir(root),
    `${approvalJobToken(jobId)}.gen-${approvalGeneration(generation)}.${approvalFileToken(requestId)}`
  );
  if (!insideRoot(root, file)) throw new Error("approval path escapes the CrewDispatch data root");
  return file;
}

export function approvalRequestPath(root: string, jobId: string, generation: number, requestId: string): string {
  return `${approvalBase(root, jobId, generation, requestId)}.request.json`;
}

export function approvalDecisionPath(root: string, jobId: string, generation: number, requestId: string): string {
  return `${approvalBase(root, jobId, generation, requestId)}.decision.json`;
}

function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync is best-effort on some filesystems */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Write the ONE pending request for a job generation (atomic replace). */
export function writePendingApproval(root: string, approval: PendingApproval): PendingApproval {
  const normalized = normalizePendingApproval(approval);
  if (!normalized) throw new Error("refusing to write an invalid pending approval");
  atomicWrite(approvalRequestPath(root, normalized.jobId, normalized.generation, normalized.requestId), JSON.stringify(normalized));
  return normalized;
}

/** Read the pending request for the exact identity tuple, or null. */
export function readPendingApproval(root: string, jobId: string, generation: number, requestId: string): PendingApproval | null {
  const approval = normalizePendingApproval(readJson(approvalRequestPath(root, jobId, generation, requestId)));
  if (!approval) return null;
  return approval.jobId === jobId && approval.generation === approvalGeneration(generation) && approval.requestId === requestId
    ? approval
    : null;
}

export function clearPendingApproval(root: string, jobId: string, generation: number, requestId: string): void {
  try {
    fs.rmSync(approvalRequestPath(root, jobId, generation, requestId), { force: true });
  } catch {
    /* best effort */
  }
}

export function readApprovalDecision(root: string, jobId: string, generation: number, requestId: string): ApprovalDecision | null {
  const decision = normalizeDecision(readJson(approvalDecisionPath(root, jobId, generation, requestId)));
  if (!decision) return null;
  return decision.jobId === jobId && decision.generation === approvalGeneration(generation) && decision.requestId === requestId
    ? decision
    : null;
}

/**
 * Claim the ONE decision for a pending approval with an exclusive create. The
 * first caller wins; every later caller gets `claimed: false` plus the winning
 * decision (when it is readable) so it can answer with a stable
 * "already resolved" result instead of resolving twice.
 */
export function claimApprovalDecision(root: string, decision: ApprovalDecision): { claimed: boolean; existing: ApprovalDecision | null } {
  const normalized = normalizeDecision(decision);
  if (!normalized) throw new Error("refusing to claim an invalid approval decision");
  const file = approvalDecisionPath(root, normalized.jobId, normalized.generation, normalized.requestId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(normalized), "utf8");
      try {
        fs.fsyncSync(fd);
      } catch {
        /* best effort */
      }
    } finally {
      fs.closeSync(fd);
    }
    return { claimed: true, existing: normalized };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    return { claimed: false, existing: readApprovalDecision(root, normalized.jobId, normalized.generation, normalized.requestId) };
  }
}

// ---------------------------------------------------------------------------
// Hub approval-route discovery
// ---------------------------------------------------------------------------

/**
 * Advertise THIS Hub's real listening port for approval resolution. The record
 * is the ONE canonical `<root>/hub/endpoint.json` owned by `src/hub/endpoint.ts`
 * — it also carries the ownership identity (instance/build/version/root), so the
 * approval route and the current-Hub contract can never disagree about who owns
 * the data root. The provider bridge discovers it from the data root (the same
 * root both processes resolve), so a Hub started with `--port 0`, a custom port
 * or the default all remain discoverable without a second port-resolution path.
 */
export function writeHubApprovalEndpoint(
  root: string,
  endpoint: {
    port: number;
    pid: number;
    instanceId?: string;
    buildId?: string | null;
    version?: string | null;
    rootId?: string;
  },
  now: () => Date = () => new Date()
): void {
  writeHubEndpoint(root, {
    port: endpoint.port,
    pid: endpoint.pid,
    instanceId: endpoint.instanceId,
    buildId: endpoint.buildId,
    version: endpoint.version,
    rootId: endpoint.rootId,
    at: now().toISOString()
  });
}

/** Remove the endpoint marker only when it still belongs to `pid`. */
export function clearHubApprovalEndpoint(root: string, pid: number): void {
  clearHubEndpoint(root, { pid });
}

export function readHubApprovalEndpoint(root: string): HubApprovalEndpoint | null {
  const record: HubEndpointRecord | null = readHubEndpoint(root);
  if (!record) return null;
  return {
    port: record.port,
    pid: record.pid,
    at: record.at,
    instance_id: record.instance_id || undefined,
    build_id: record.build_id,
    version: record.version,
    root_id: record.root_id || undefined
  };
}

/** Accept only a loopback http URL (never a remote or non-http target). */
export function loopbackApprovalUrl(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]" && url.hostname !== "::1") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

/**
 * Is an interactive approval route actually available? Only a live CrewDispatch Hub
 * that identifies itself on its own loopback ping endpoint counts — anything
 * else (no Hub, a foreign listener, a dead process) keeps the historical safe
 * decline.
 */
export async function probeHubApprovalRoute(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url}/api/ping`, { signal: AbortSignal.timeout(APPROVAL_HUB_PROBE_TIMEOUT_MS) });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    return body?.ok === true && body?.service === "jobquay";
  } catch {
    return false;
  }
}

/**
 * Resolve the interactive Hub route: an explicit `JOBQUAY_HUB_URL` (test /
 * embedding seam) wins, else the Hub's own advertised endpoint marker, and
 * only when the target answers as a live CrewDispatch Hub.
 */
export async function resolveApprovalHubUrl(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const explicit = loopbackApprovalUrl(env.JOBQUAY_HUB_URL);
  const endpoint = readHubApprovalEndpoint(root);
  const url = explicit ?? (endpoint ? `http://127.0.0.1:${endpoint.port}` : null);
  if (!url) return null;
  return (await probeHubApprovalRoute(url, fetchImpl)) ? url : null;
}
