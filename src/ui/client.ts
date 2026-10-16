// Strict browser TypeScript for the local CrewDispatch Hub. No framework, remote
// assets, task-creation action or provider-specific private API.
type Json = Record<string, unknown>;
type JobSummary = {
  job_id: string;
  status: string;
  generation: number;
  provider: string;
  model: string | null;
  created_at: string;
  finished_at?: string | null;
  display_title?: string | null;
  approval_state?: "waiting" | "submitted" | "expired" | null;
  usage?: Json;
};
/** The bounded terminal outcome the Hub serves (hubCompactResult): display-safe fields only. */
type CompactResultView = {
  ok?: boolean;
  subtype?: string | null;
  kind?: string | null;
  exit_code?: number | null;
  stop_reason?: string | null;
  /** The bounded provider finish reason, or null (JQ-20261001-23). */
  finish_reason?: string | null;
  /** The provider's bounded, display-safe terminal error detail, or null (JQ-20261001-24). */
  error_detail?: string | null;
  /**
   * Why an interactive approval gate on this turn did not proceed (canonical
   * `approval_outcome`), or null when the result carries no such evidence.
   * Bounded tokens only (`rejected` / `expired` / `no_route` /
   * `no_allow_option` / `publish_failed` / `cancelled`).
   */
  approval_outcome?: string | null;
  final_text?: string | null;
  fallback_eligible?: boolean;
};
type JobDetail = JobSummary & {
  task: string | null;
  history_available: boolean;
  history_reason: string | null;
  user_messages: Array<{ generation: number; text: string; at: string; source?: string | null }>;
  assistant_messages: Array<{ generation: number; text: string; at: string }>;
  assistant_content: string | null;
  assistant_missing: boolean;
  started_at?: string | null;
  finished_at: string | null;
  effort?: string | null;
  model_chain?: string[];
  /** Stable durable terminal classification; the raw durable error/stderr is never served. */
  stop_reason?: string | null;
  /** The bounded provider finish reason, or null (JQ-20261001-23). */
  finish_reason?: string | null;
  /** The provider's bounded, display-safe terminal error detail, or null (JQ-20261001-24). */
  error_detail?: string | null;
  /** The terminal result's bounded approval outcome token, or null (see jobs/approval.ts). */
  approval_outcome?: string | null;
  failure_kind?: string | null;
  result?: CompactResultView | null;
  attempts?: Array<{ generation: number; model: string | null; model_source: string | null; effort?: string | null; exit_code: number | null; kind: string | null; rate_limited?: boolean }>;
  /** The bounded pending provider approval of a running turn, or null. */
  pending_approval?: PendingApprovalView | null;
  notify?: { kind?: string | null; source?: string | null };
};
type LogEntry = { offset?: number; data?: Json; reasoning?: unknown[]; error?: string; unparsed?: boolean };
type LogBatch = { entries: LogEntry[]; cursor: string; drained: boolean; pending: boolean; cursor_error?: string };
/**
 * The provider-neutral pending approval a running provider turn is waiting on
 * (see jobs/approval.ts). Bounded and display-safe by the provider boundary and
 * the durable record: identity, provider, the provider's OWN option
 * ids/kinds/labels, timestamps, and ONE bounded operation detail (the actual
 * command / description / path the provider asked to run). Prompt text,
 * environment dumps, raw provider payloads and unredacted secrets are never
 * carried, and every displayed string is rendered as text — never as HTML.
 */
type ApprovalOptionView = { id?: string; kind?: string; label?: string };
type ApprovalDetailView = {
  command?: string | null;
  /** The provider's separately supplied arguments, one entry per argument. */
  args?: string[] | null;
  description?: string | null;
  path?: string | null;
  cwd?: string | null;
  title?: string | null;
  gate?: string | null;
  reason?: string | null;
  truncated?: boolean;
  redacted?: boolean;
};
type PendingApprovalView = {
  version?: number;
  kind?: string;
  provider?: string;
  job_id?: string;
  generation?: number;
  request_id?: string;
  tool_name?: string | null;
  summary?: string | null;
  detail?: ApprovalDetailView | null;
  options?: ApprovalOptionView[];
  created_at?: string;
  expires_at?: string | null;
};
type PendingApprovalSummary = JobSummary & { request_id: string; tool_name: string | null; expires_at: string };
type JobsPage = { jobs: JobSummary[]; total: number; has_more: boolean; pending_approvals?: PendingApprovalSummary[] };
type SettingsConfig = {
  cli_path: string | null;
  default_model: string | null;
  rate_limit_fallback_model: string | null;
  permission_mode: string;
  default_effort: string | null;
  rate_limit_fallback_effort: string | null;
};
type SettingsView = {
  ok: true;
  config: SettingsConfig;
  cli: { available: boolean; path: string | null; source: string; source_label: string; version: string | null; error: string | null };
  catalog: {
    available: boolean;
    source: string;
    reliable: boolean;
    count: number;
    models: string[];
    default_model: string | null;
    refreshed_at: string | null;
    error: string | null;
  };
  /**
   * Display metadata from the SAME installed-package read as the model list.
   * `efforts` is the model's OWN published reasoning-effort list (absent = the
   * installed package published none for it: "unknown", not "none").
   */
  model_meta: Record<string, { free?: boolean; efforts?: string[] }>;
  /**
   * `checked === false` means the capability phase has not answered yet: the
   * empty mode list / `supports_effort:false` are placeholders, NOT evidence.
   */
  capabilities: { supports_effort: boolean; permission_modes: string[]; checked?: boolean };
  effective: { model: string | null; source: string; slot_index: number | null; at: string };
  diagnostics: Array<{ field: string; value: string; code: string; message: string }>;
  features: { note: string; rate_limit_fallback_active: boolean; in_flight_switch_active: boolean };
};
type InvalidSettingsView = { ok: false; code: string; message: string; field: string | null; config_present: boolean };
type WorkBuddySettingsConfig = {
  cli_path: string | null;
  default_model: string | null;
  rate_limit_fallback_model: string | null;
  permission_mode: string;
  default_effort: string | null;
  rate_limit_fallback_effort: string | null;
};
/**
 * Model-specific reasoning-effort evidence published by the WorkBuddy Official
 * App snapshot (plus the DS-only installed Command Code catalog fallback).
 * `supported_efforts` values are RAW effort tokens; the labels derived from
 * `app_default_effort` / `supported_efforts_source` are display-only.
 */
type WorkBuddyReasoningMeta = {
  app_default_effort: string | null;
  supported_efforts: string[] | null;
  supported_efforts_source: "official-app" | "command-code" | null;
};
type WorkBuddySettingsView = {
  ok: true;
  config: WorkBuddySettingsConfig;
  cli: { available: boolean; path: string | null; source: string; source_label: string; version: string | null; error: string | null };
  catalog: {
    available: boolean;
    source: string;
    reliable: boolean;
    count: number;
    models: string[];
    default_model: string | null;
    refreshed_at: string | null;
    error: string | null;
  };
  offered_models: string[];
  model_meta: Record<string, { label: string; credits: string | null; free?: boolean; description_en?: string | null; description_zh?: string | null; reasoning?: WorkBuddyReasoningMeta | null }>;
  promotion_next_boundary_at: string | null;
  capabilities: { supports_effort: boolean; permission_modes: string[] };
  effective: { model: string | null; source: string; at: string };
  diagnostics: Array<{ field: string; value: string; code: string; message: string }>;
  features: { note: string; rate_limit_fallback_active: boolean; time_scheduling_active: false };
};
type SettingsProvider = "command-code" | "workbuddy-ai";
/**
 * Provenance of a settings response. `billing_verified` is the ONLY signal
 * that free/price metadata may be treated as current: the Hub sets it only
 * when the served view was produced by a real provider probe in this response.
 */
type SettingsFreshness = {
  provider: string;
  source: "probe";
  verified_at: string | null;
  billing_verified: boolean;
};
/** Fresh envelope: the result of a real provider read (deduped per provider/root). */
type SettingsFreshEnvelope<TView> = {
  ok: true;
  view: TView;
  freshness: SettingsFreshness;
};

/**
 * Later Command Code capability patch. The installed package still owns the
 * fast model list; this phase also observes the CLI's current default model for
 * display without persisting it as an explicit selection.
 */
type SettingsCapabilityPatchEnvelope = {
  ok: true;
  patch: {
    cli: { available: boolean; version: string | null; error: string | null; checked: true };
    capabilities: { supports_effort: boolean; permission_modes: string[]; checked: true };
    catalog: SettingsView["catalog"] | null;
    model_meta: Record<string, { free?: boolean }> | null;
    observed_default_model: string | null;
  };
  freshness: SettingsFreshness;
};
type GlobalSettingsView = {
  jobs_page_size: number;
  diag_retention_days: number;
  diag_max_total_bytes: number;
  jobs_page_size_options?: number[];
};

const GIB = 1024 ** 3;
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Permission-mode note copy. Each note explains the SELECTED mode's behavior in
// plain English; the WorkBuddy notes stay honest about its high-risk approval
// ask and its repeated-action guard instead of reusing Command Code's yolo
// wording. A mode with no known semantics gets the generic provider-rules note.
const STANDARD_PERMISSION_NOTE = "May request permission to edit files or run commands.";
const PLAN_PERMISSION_NOTE = "Suggests changes without editing project files.";
const ACCEPT_EDITS_PERMISSION_NOTE = "Auto-approves normal edits; commands may need approval.";
const COMMAND_CODE_YOLO_NOTE = "Skips routine approvals; explicit rules and safety checks still apply.";
const WORKBUDDY_YOLO_NOTE = "Runs most actions automatically; risky commands may need approval.";
const WORKBUDDY_FULL_ACCESS_NOTE = "Skips permission checks; repeated actions may still pause the task.";
const PROVIDER_RULES_PERMISSION_NOTE = "Provider rules apply; approvals may pause the task.";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const ui = {
  jobs: el<HTMLDivElement>("jobs"),
  loadMore: el<HTMLButtonElement>("loadMore"),
  refreshJobs: el<HTMLButtonElement>("refreshJobs"),
  navJobs: el<HTMLButtonElement>("navJobs"),
  navSettings: el<HTMLButtonElement>("navSettings"),
  consoleView: el<HTMLDivElement>("consoleView"),
  settingsView: el<HTMLElement>("settingsView"),
  settingsProvider: el<HTMLSelectElement>("settingsProvider"),
  commandCodeCard: el<HTMLElement>("commandCodeSettingsCard"),
  cliInfo: el<HTMLDivElement>("cliInfo"),
  permissionMode: el<HTMLSelectElement>("permissionMode"),
  defaultEffort: el<HTMLSelectElement>("defaultEffort"),
  fallbackEffort: el<HTMLSelectElement>("fallbackEffort"),
  defaultModel: el<HTMLSelectElement>("defaultModel"),
  fallbackModel: el<HTMLSelectElement>("fallbackModel"),
  yoloWarning: el<HTMLDivElement>("yoloWarning"),
  catalogInfo: el<HTMLDivElement>("catalogInfo"),
  effectiveInfo: el<HTMLDivElement>("effectiveInfo"),
  modelIssues: el<HTMLDivElement>("modelIssues"),
  saveSettings: el<HTMLButtonElement>("saveSettings"),
  settingsMessage: el<HTMLElement>("settingsMessage"),
  wbCard: el<HTMLElement>("workBuddySettingsCard"),
  wbCliInfo: el<HTMLDivElement>("wbCliInfo"),
  wbPermissionMode: el<HTMLSelectElement>("wbPermissionMode"),
  wbDefaultEffort: el<HTMLSelectElement>("wbDefaultEffort"),
  wbFallbackEffort: el<HTMLSelectElement>("wbFallbackEffort"),
  wbDefaultModel: el<HTMLSelectElement>("wbDefaultModel"),
  wbFallbackModel: el<HTMLSelectElement>("wbFallbackModel"),
  wbYoloWarning: el<HTMLDivElement>("wbYoloWarning"),
  wbCatalogInfo: el<HTMLDivElement>("wbCatalogInfo"),
  wbEffectiveInfo: el<HTMLDivElement>("wbEffectiveInfo"),
  wbModelIssues: el<HTMLDivElement>("wbModelIssues"),
  wbSaveSettings: el<HTMLButtonElement>("wbSaveSettings"),
  wbSettingsMessage: el<HTMLElement>("wbSettingsMessage"),
  pageSize: el<HTMLSelectElement>("pageSize"),
  retentionDays: el<HTMLInputElement>("retentionDays"),
  retentionGb: el<HTMLInputElement>("retentionGb"),
  saveGlobal: el<HTMLButtonElement>("saveGlobal"),
  globalMessage: el<HTMLElement>("globalMessage"),
  title: el<HTMLElement>("jobTitle"),
  status: el<HTMLElement>("jobStatus"),
  runtime: el<HTMLElement>("jobRuntime"),
  provider: el<HTMLElement>("jobProvider"),
  model: el<HTMLElement>("jobModel"),
  jobEffort: el<HTMLElement>("jobEffort"),
  fallback: el<HTMLElement>("jobFallback"),
  usage: el<HTMLElement>("jobUsage"),
  conversation: el<HTMLElement>("conversation"),
  composer: el<HTMLFormElement>("composer"),
  followupText: el<HTMLTextAreaElement>("followupText"),
  sendFollowup: el<HTMLButtonElement>("sendFollowup"),
  cancel: el<HTMLButtonElement>("cancelJob"),
  pendingApprovals: el<HTMLElement>("pendingApprovals"),
  pendingApprovalCount: el<HTMLElement>("pendingApprovalCount"),
  pendingApprovalList: el<HTMLElement>("pendingApprovalList"),
  approvalIdentity: el<HTMLElement>("approvalIdentity"),
  approvalTaskJob: el<HTMLElement>("approvalTaskJob"),
  approvalTaskProvider: el<HTMLElement>("approvalTaskProvider"),
  approvalCard: el<HTMLElement>("approvalCard"),
  approvalTitle: el<HTMLElement>("approvalTitle"),
  approvalMeta: el<HTMLElement>("approvalMeta"),
  approvalDetail: el<HTMLElement>("approvalDetail"),
  approvalActions: el<HTMLElement>("approvalActions"),
  log: el<HTMLDivElement>("log"),
  autoFollow: el<HTMLInputElement>("autoFollow"),
  showReasoning: el<HTMLInputElement>("showReasoning"),
  splitter: el<HTMLDivElement>("splitter"),
  live: el<HTMLElement>("live"),
  liveStatus: el<HTMLElement>("liveStatus"),
  statusbar: el<HTMLElement>("statusbar")
};

const state = {
  jobs: [] as JobSummary[],
  pendingApprovals: [] as PendingApprovalSummary[],
  pendingApprovalsKey: "",
  /** Every job id this session has folded into the read state (frontier scan). */
  knownIds: new Set<string>(),
  loaded: 0,
  total: 0,
  firstPage: 50,
  openId: null as string | null,
  detail: null as JobDetail | null,
  logCursor: "0",
  logBusy: false,
  refreshing: false,
  view: "jobs" as "jobs" | "settings",
  /** The visible outcome identity of the last rendered conversation (status|generation|text|notice). */
  lastConversationKey: "",
  /**
   * The ONE approval decision this tab has submitted and whose resolution the
   * Hub has not yet confirmed (request identity + chosen option). It keeps the
   * buttons disabled immediately and is cleared as soon as the pending
   * approval disappears from the polled detail.
   */
  approvalSubmit: null as { jobId: string; requestId: string; generation: number; optionId: string } | null,
  /** The request identity of the currently rendered approval card (DOM reuse). */
  approvalRenderKey: ""
};

const settingsState: {
  view: SettingsView | null;
  draft: SettingsConfig | null;
  freshness: SettingsFreshness | null;
  loadPromise: Promise<void> | null;
  /** Monotonic client read generation; a save supersedes any pre-save read. */
  generation: number;
  dirty: boolean;
  /** A fresh provider read is in flight: the simple loading state is shown. */
  loading: boolean;
  readError: string | null;
  busy: boolean;
} = { view: null, draft: null, freshness: null, loadPromise: null, generation: 0, dirty: false, loading: false, readError: null, busy: false };
const workBuddySettingsState: {
  view: WorkBuddySettingsView | null;
  draft: WorkBuddySettingsConfig | null;
  freshness: SettingsFreshness | null;
  loadPromise: Promise<void> | null;
  /** Monotonic client read generation; a save supersedes any pre-save read. */
  generation: number;
  dirty: boolean;
  loading: boolean;
  readError: string | null;
  busy: boolean;
} = { view: null, draft: null, freshness: null, loadPromise: null, generation: 0, dirty: false, loading: false, readError: null, busy: false };
let selectedSettingsProvider: SettingsProvider = "command-code";
let workBuddyPromotionTimer: number | null = null;
const WORKBUDDY_PROMOTION_TIMER_MAX_MS = 2_147_000_000;
const globalState: {
  value: GlobalSettingsView | null;
  loadPromise: Promise<void> | null;
  loaded: boolean;
  dirty: boolean;
  loading: boolean;
  busy: boolean;
} = { value: null, loadPromise: null, loaded: false, dirty: false, loading: false, busy: false };

ui.saveSettings.disabled = true;
ui.wbSaveSettings.disabled = true;
ui.saveGlobal.disabled = true;

function setStatus(message: string, error = false): void {
  ui.statusbar.textContent = message;
  ui.statusbar.classList.toggle("error", error);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }
  });
  const body = (await response.json()) as T & { error?: string; message?: string; field?: string | null; current_endpoint?: string };
  if (!response.ok || body.error) {
    // The data root's Hub moved: this process is superseded. Follow the current
    // loopback endpoint instead of leaving the tab on a stale UI.
    if (body.error === "hub_superseded" && typeof body.current_endpoint === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(body.current_endpoint)) {
      window.location.replace(`${body.current_endpoint}/ui`);
    }
    const detail = body.message || body.error || `HTTP ${response.status}`;
    throw new Error(body.field ? body.field + ": " + detail : detail);
  }
  return body;
}

function localDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const n = Date.parse(iso);
  return Number.isFinite(n) ? new Date(n).toLocaleString("en-US") : iso;
}

function empty(parent: HTMLElement): void { parent.replaceChildren(); }

function message(parent: HTMLElement, text: string, className = "empty"): void {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  parent.appendChild(div);
}

function titleFor(job: JobSummary): string {
  return job.display_title?.trim() || job.job_id;
}

function providerLabel(provider: string): string {
  if (provider === "command-code") return "Command Code";
  if (provider === "workbuddy-ai") return "WorkBuddy AI";
  return "Unknown provider";
}

// ---------------------------------------------------------------------------
// Sidebar read/unread state — browser-local presentation state only
// ---------------------------------------------------------------------------
//
// A job's "terminal revision" is the stable identity of its CURRENT terminal
// result: generation + terminal status + finished_at. Running/tool/log activity
// has no revision, so it can never become unread. The store maps a job id to
// the revision this browser has already seen; the ONE unread predicate is a
// revision that exists and differs from the stored one. The store lives in
// localStorage (in-memory fallback when storage is unavailable) — never a
// backend endpoint, durable job field, cookie or remote store.

const READ_STATE_STORAGE_KEY = "jobquay.read-state";
const READ_STATE_VERSION = 1;
/** Bounded store: at most this many job entries are kept (oldest pruned first). */
const READ_STATE_MAX_ENTRIES = 5000;

const readState: { initialized: boolean; read: Record<string, string> } = { initialized: false, read: {} };
let readStateStorageBroken = false;

/** The stable identity of a job's CURRENT terminal result, or null while busy. */
function terminalRevision(job: { status: string; generation: number; finished_at?: string | null }): string | null {
  if (!isTerminal(job.status)) return null;
  return `${job.generation}|${job.status}|${job.finished_at ?? ""}`;
}

/** The ONE read/unread decision: an existing revision the store has not seen. */
function isUnreadRevision(revision: string | null, readRevision: string | undefined): boolean {
  return revision !== null && readRevision !== revision;
}

function isUnreadJob(job: JobSummary): boolean {
  return isUnreadRevision(terminalRevision(job), readState.read[job.job_id]);
}

/**
 * Load the versioned read-state store. A missing, corrupt or version-mismatched
 * value is treated as "no store yet" so the migration baseline still runs; a
 * THROWING storage keeps the in-memory store and never breaks the page.
 */
function loadReadState(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(READ_STATE_STORAGE_KEY);
  } catch {
    readStateStorageBroken = true; // storage unavailable: in-memory only
    return;
  }
  if (!raw) return;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return; // corrupt value: keep the empty in-memory store (rewritten on next persist)
  }
  if (!parsed || typeof parsed !== "object") return;
  const candidate = parsed as { version?: unknown; initialized?: unknown; read?: unknown };
  if (candidate.version !== READ_STATE_VERSION || !candidate.read || typeof candidate.read !== "object") return;
  const read: Record<string, string> = {};
  let count = 0;
  for (const [jobId, revision] of Object.entries(candidate.read as Record<string, unknown>)) {
    if (typeof revision !== "string" || count >= READ_STATE_MAX_ENTRIES) continue;
    read[jobId] = revision;
    count += 1;
  }
  readState.read = read;
  readState.initialized = candidate.initialized === true;
}

function persistReadState(): void {
  if (readStateStorageBroken) return;
  try {
    window.localStorage.setItem(READ_STATE_STORAGE_KEY, JSON.stringify({
      version: READ_STATE_VERSION,
      initialized: readState.initialized,
      read: readState.read
    }));
  } catch {
    readStateStorageBroken = true; // quota/security failure: keep working in memory
  }
}

/** Keep the store bounded; the least recently written entries are dropped. */
function pruneReadState(): void {
  const keys = Object.keys(readState.read);
  const excess = keys.length - READ_STATE_MAX_ENTRIES;
  for (let index = 0; index < excess; index += 1) {
    const key = keys[index];
    if (key !== undefined) delete readState.read[key];
  }
}

/** Mark one terminal revision read. Returns true when the stored state changed. */
function markRevisionRead(jobId: string, revision: string): boolean {
  if (readState.read[jobId] === revision) return false;
  delete readState.read[jobId];
  readState.read[jobId] = revision; // re-insert last: key order is the pruning recency
  pruneReadState();
  persistReadState();
  return true;
}

/**
 * Fold one API page of summaries into the read state.
 *
 * Migration: the FIRST successful page after this feature exists baselines the
 * currently visible terminal results as read, so history never lights up.
 *
 * Afterwards only genuinely NEW results stay unread:
 *   - `older` pages (Load more) are historical by definition and are baselined
 *     on first encounter;
 *   - a `top` page baselines only what sits at or below the first already-known
 *     id (e.g. page-size growth), while the never-seen frontier above it is a
 *     real arrival whose terminal revision must stay unread.
 * Baselining never overwrites an existing entry, so an unread follow-up result
 * is not silently marked read by re-encountering its row.
 */
function noteJobsForReadState(jobs: JobSummary[], mode: "top" | "older"): void {
  let changed = false;
  const baselineRead = (job: JobSummary): void => {
    // A job this session already saw owns its state in the store: re-seeing a
    // row must never overwrite an unread revision.
    if (state.knownIds.has(job.job_id)) return;
    const revision = terminalRevision(job);
    if (revision === null || job.job_id in readState.read) return;
    delete readState.read[job.job_id];
    readState.read[job.job_id] = revision;
    changed = true;
  };
  if (!readState.initialized) {
    readState.initialized = true;
    changed = true;
    for (const job of jobs) baselineRead(job);
  } else if (mode === "older") {
    for (const job of jobs) baselineRead(job);
  } else {
    let frontier = true;
    for (const job of jobs) {
      if (frontier && state.knownIds.has(job.job_id)) frontier = false;
      if (!frontier) baselineRead(job);
    }
  }
  for (const job of jobs) state.knownIds.add(job.job_id);
  if (changed) {
    pruneReadState();
    persistReadState();
  }
}

/**
 * The global pending-approval list. The rows are rebuilt only when the waiting
 * set itself changes (a rebuild would drop keyboard focus), while the CURRENT
 * row marking is applied on EVERY render: selecting another task must move the
 * marker even when the pending list itself did not change.
 */
function renderPendingApprovals(): void {
  const pending = state.pendingApprovals;
  ui.pendingApprovals.classList.toggle("hidden", pending.length === 0);
  ui.pendingApprovalCount.textContent = `Waiting for approval: ${pending.length}`;
  const key = JSON.stringify(pending.map((job) => [job.job_id, job.generation, job.request_id, job.display_title, job.tool_name]));
  if (state.pendingApprovalsKey !== key) {
    state.pendingApprovalsKey = key;
    empty(ui.pendingApprovalList);
    for (const job of pending) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.jobId = job.job_id;
      button.textContent = `${titleFor(job)} · ${providerLabel(job.provider)} · Run ${job.generation + 1} · ${job.tool_name || "Tool action"} · ${job.job_id}`;
      button.addEventListener("click", () => { void openJob(job.job_id); });
      ui.pendingApprovalList.appendChild(button);
    }
  }
  for (const node of Array.from(ui.pendingApprovalList.querySelectorAll<HTMLButtonElement>("button[data-job-id]"))) {
    node.setAttribute("aria-current", String(node.dataset.jobId === state.openId));
  }
}

function renderJobs(): void {
  renderPendingApprovals();
  empty(ui.jobs);
  if (!state.jobs.length) message(ui.jobs, "No tasks yet. New tasks are dispatched through the CrewDispatch MCP.");
  for (const job of state.jobs) {
    const unread = isUnreadJob(job);
    const button = document.createElement("button");
    button.type = "button";
    button.className = unread ? "job unread" : "job";
    button.dataset.jobId = job.job_id;
    button.setAttribute("aria-current", String(job.job_id === state.openId));
    const title = document.createElement("span");
    title.className = "job-title";
    if (unread) {
      const dot = document.createElement("span");
      dot.className = "job-unread-dot";
      dot.setAttribute("aria-hidden", "true");
      title.append(dot);
    }
    title.append(titleFor(job));
    const meta = document.createElement("span");
    meta.className = "job-meta";
    const status = document.createElement("span");
    const waiting = state.pendingApprovals.some((entry) => entry.job_id === job.job_id);
    status.textContent = waiting ? "Approval required" : job.approval_state === "expired" ? "Approval expired" : job.status;
    if (waiting || job.approval_state === "expired") status.className = "job-approval";
    const provider = document.createElement("span");
    provider.className = "job-provider";
    provider.textContent = providerLabel(job.provider);
    provider.setAttribute("aria-label", `Provider: ${provider.textContent}`);
    const at = document.createElement("span");
    at.className = "job-time";
    at.textContent = localDate(job.created_at);
    meta.append(status, at, provider);
    button.append(title, meta);
    if (unread) {
      const accessible = document.createElement("span");
      accessible.className = "sr-only";
      accessible.textContent = "Unread result";
      button.append(accessible);
    }
    button.addEventListener("click", () => { void openJob(job.job_id); });
    ui.jobs.appendChild(button);
  }
  const hasMore = state.loaded < state.total && state.firstPage !== 0;
  ui.loadMore.classList.toggle("hidden", !hasMore);
}

async function loadJobs(reset: boolean): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  ui.refreshJobs.disabled = true;
  try {
    const offset = reset ? 0 : state.loaded;
    const limit = reset ? state.firstPage : 50;
    const page = await api<JobsPage>(`/api/jobs?offset=${offset}&limit=${limit}`);
    state.pendingApprovals = page.pending_approvals ?? [];
    noteJobsForReadState(page.jobs, reset ? "top" : "older");
    if (reset) state.jobs = page.jobs;
    else state.jobs.push(...page.jobs);
    state.loaded = state.jobs.length;
    state.total = page.total;
    renderJobs();
    setStatus(`Showing ${state.loaded} / ${state.total} tasks`);
  } catch (error) {
    setStatus(`Failed to load sessions: ${String(error)}`, true);
  } finally {
    state.refreshing = false;
    ui.refreshJobs.disabled = false;
  }
}

async function refreshJobsList(): Promise<void> {
  if (state.refreshing) return;
  try {
    const limit = state.firstPage;
    const page = await api<JobsPage>(`/api/jobs?offset=0&limit=${limit}`);
    state.pendingApprovals = page.pending_approvals ?? [];
    noteJobsForReadState(page.jobs, "top");
    if (limit === 0 || state.loaded <= limit) {
      state.jobs = page.jobs;
    } else {
      const freshIds = new Set(page.jobs.map((job) => job.job_id));
      const retained = state.jobs.filter((job) => !freshIds.has(job.job_id));
      const targetCount = Math.min(page.total, Math.max(state.loaded, page.jobs.length));
      state.jobs = [...page.jobs, ...retained].slice(0, targetCount);
    }
    state.loaded = state.jobs.length;
    state.total = page.total;
    renderJobs();
  } catch {
    // Silent local refresh: keep the last visible list. Manual Refresh reports errors.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function showLines(target: HTMLElement, lines: string[]): void {
  target.replaceChildren();
  for (const line of lines) {
    const item = document.createElement("div");
    item.textContent = line;
    target.appendChild(item);
  }
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

/**
 * The plain-English note for the SELECTED permission mode of one provider.
 * WorkBuddy's native `default` is its visible `standard` choice, and its `yolo`
 * / `full-access` behave differently from Command Code's `yolo`. A mode with no
 * known semantics (a saved advanced value) gets the honest generic note instead
 * of an invented claim.
 */
function permissionNoteFor(provider: SettingsProvider, mode: string): string {
  if (provider === "workbuddy-ai") {
    if (mode === "default") return STANDARD_PERMISSION_NOTE;
    if (mode === "plan") return PLAN_PERMISSION_NOTE;
    if (mode === "accept-edits") return ACCEPT_EDITS_PERMISSION_NOTE;
    if (mode === "yolo") return WORKBUDDY_YOLO_NOTE;
    if (mode === "full-access") return WORKBUDDY_FULL_ACCESS_NOTE;
    return PROVIDER_RULES_PERMISSION_NOTE;
  }
  if (mode === "standard") return STANDARD_PERMISSION_NOTE;
  if (mode === "plan") return PLAN_PERMISSION_NOTE;
  if (mode === "accept-edits") return ACCEPT_EDITS_PERMISSION_NOTE;
  if (mode === "yolo") return COMMAND_CODE_YOLO_NOTE;
  return PROVIDER_RULES_PERMISSION_NOTE;
}

/** The two fixed inline Permission notes the fit pass owns (one per provider card). */
const permissionNotes: readonly HTMLElement[] = [ui.yoloWarning, ui.wbYoloWarning];
const PERMISSION_NOTE_FONT = "13px";
const PERMISSION_NOTE_FONT_COMPACT = "12px";

/**
 * The two-step non-wrapping fit for one Permission note: 13px, reduced to 12px
 * only when the CURRENT text actually overflows its row. At 12px any remaining
 * overflow is the single-line ellipsis — it never shrinks further. A hidden or
 * zero-width note cannot overflow, is skipped and carries no tooltip. The note
 * is a flex item whose width is the row's remaining space, so changing its
 * font-size never changes the width that triggered the fit: no feedback loop,
 * no animation.
 *
 * The native title is decided HERE, from the FINAL 13/12px size: it carries the
 * complete text only while the visible text is REALLY truncated, so a note that
 * fits at either size (and every hidden/zero-width state) has no title.
 * Widening or choosing shorter text therefore always clears a stale tooltip.
 */
function fitPermissionNote(note: HTMLElement): void {
  if (note.classList.contains("hidden") || note.clientWidth === 0) {
    note.title = "";
    return;
  }
  note.style.fontSize = PERMISSION_NOTE_FONT;
  if (note.scrollWidth > note.clientWidth) note.style.fontSize = PERMISSION_NOTE_FONT_COMPACT;
  note.title = note.scrollWidth > note.clientWidth ? note.textContent ?? "" : "";
}

function fitPermissionNotes(): void {
  for (const note of permissionNotes) fitPermissionNote(note);
}

// ONE observer for the two fixed notes: viewport/panel resizes and
// hidden -> visible transitions re-run the two-step fit. The elements are
// never re-created and the observer is installed exactly once, so repeated
// renders cannot accumulate observers.
const permissionNoteObserver = new ResizeObserver(() => fitPermissionNotes());
for (const note of permissionNotes) permissionNoteObserver.observe(note);

/** Always-visible Permission note: what the selected mode does for THIS provider. */
function renderPermissionNote(element: HTMLElement, provider: SettingsProvider, mode: string): void {
  // The full explanation always stays the textContent; the fit below decides —
  // AFTER the final 13/12px size — whether the native title may carry it (only
  // while the text is actually truncated by the ellipsis).
  element.textContent = permissionNoteFor(provider, mode);
  element.classList.remove("hidden");
  fitPermissionNote(element);
}

/**
 * The WorkBuddy permission modes offered as normal dropdown choices, in
 * display order. WorkBuddy also publishes advanced `dont-ask` / `auto` modes;
 * those stay out of the normal choices, and a saved advanced value is kept
 * visible as a clearly labeled current-config item instead of being overwritten.
 */
const WORKBUDDY_NORMAL_PERMISSION_MODES: readonly string[] = ["default", "plan", "accept-edits", "yolo", "full-access"];

/**
 * The readable label for one published permission-mode id. WorkBuddy AI's
 * native `default` renders as `standard` and `full-access` as `Full Access`;
 * every other id is already the stable public vocabulary and renders as-is.
 */
function permissionModeLabel(mode: string): string {
  if (mode === "default") return "standard";
  if (mode === "full-access") return "Full Access";
  return mode;
}

/** Disable every control of a provider card (used while loading / unavailable). */
function lockProviderCard(card: HTMLElement): void {
  card.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((control) => {
    control.disabled = true;
  });
}

/** Remove any previously rendered choices from the provider form selects. */
function clearProviderFormSelects(selects: HTMLSelectElement[]): void {
  for (const select of selects) select.replaceChildren();
}

// The shared first-read message. It is shown only when this browser has no usable
// provider view yet; later provider verification stays behind the known form.
// The wording deliberately avoids provider-specific timing promises.
const PROVIDER_INITIAL_LOADING_MESSAGE = "Loading configuration… First load may take a moment.";
const COMMAND_CODE_LOADING_MESSAGE = PROVIDER_INITIAL_LOADING_MESSAGE;
const WORKBUDDY_LOADING_MESSAGE = PROVIDER_INITIAL_LOADING_MESSAGE;

/**
 * The ONE initial loading rendering for a provider card. It is shown only when
 * no usable provider view exists yet; later fresh reads keep the known form.
 *
 * For Command Code this covers only the process-free CATALOG phase, so it
 * clears in milliseconds even when the CLI is cold or hung. The slow capability
 * phase is NOT part of this state: it runs after the form is rendered and
 * reports itself on the permission/effort controls.
 *
 * WorkBuddy AI's first-read line stays at normal weight, so it
 * carries a provider-specific modifier instead of weakening the shared
 * `.settings-status > div:first-child` style (weight 650) that non-loading
 * status/error copy also relies on.
 */
function renderProviderLoadingState(
  info: HTMLElement,
  catalog: HTMLElement,
  effective: HTMLElement,
  provider: SettingsProvider
): void {
  showLines(info, [provider === "command-code" ? COMMAND_CODE_LOADING_MESSAGE : WORKBUDDY_LOADING_MESSAGE]);
  info.classList.remove("hidden", "warning");
  info.classList.add("loading");
  info.classList.toggle("wb-loading", provider === "workbuddy-ai");
  catalog.classList.add("hidden");
  effective.classList.add("hidden");
}

function settingsModelChoices(): string[] {
  const view = settingsState.view;
  return view?.catalog.reliable ? [...new Set(view.catalog.models)] : [];
}

/**
 * Free-now is BILLING metadata: it may only be presented from freshly verified
 * evidence (`billing_verified`). A response that was not produced by a real
 * provider read never carries a Free-now label or free-first styling.
 */
function commandCodeBillingVerified(): boolean {
  return settingsState.freshness?.billing_verified === true;
}

function workBuddyBillingVerified(): boolean {
  return workBuddySettingsState.freshness?.billing_verified === true;
}

/**
 * THE ONE provider-neutral free-first ordering for the model dropdowns.
 *
 * Free-now is billing metadata, so it may only re-order the display list when
 * the freshness envelope says the evidence was just verified
 * (`billing_verified === true`) AND the model's CURRENT provider evidence
 * (`model_meta[id].free === true`) says free. Without that proof (unverified
 * or failed evidence) the list is returned exactly as the provider/catalog
 * delivered it, so expired pricing can never move a model to the front. The
 * partition is STABLE: free models keep their relative provider order,
 * non-free models keep theirs. Nothing is inferred from model ids, names,
 * credits text, descriptions, historical values or remembered provider
 * behaviour — only the current flags above are read.
 */
function stableFreeFirstOrder(
  models: readonly string[],
  meta: Readonly<Record<string, { free?: boolean }>> | null | undefined,
  billingVerified: boolean
): string[] {
  if (!billingVerified) return [...models];
  const free: string[] = [];
  const rest: string[] = [];
  for (const model of models) {
    if (meta?.[model]?.free === true) free.push(model);
    else rest.push(model);
  }
  return [...free, ...rest];
}

function markSettingsDirty(): void {
  settingsState.dirty = true;
  ui.saveSettings.disabled = settingsControlsLocked() || !settingsState.dirty;
  if (!settingsState.busy) ui.settingsMessage.textContent = "Unsaved Command Code settings changes.";
}

function markGlobalDirty(): void {
  globalState.dirty = true;
  updateGlobalControlState();
  if (!globalState.busy) ui.globalMessage.textContent = "Unsaved global settings changes.";
}

function settingsControlsLocked(): boolean {
  return settingsState.busy || settingsState.loading || settingsState.readError !== null;
}

function updateGlobalControlState(): void {
  const disabled = globalState.busy || globalState.loading || !globalState.loaded;
  for (const control of [ui.pageSize, ui.retentionDays, ui.retentionGb]) control.disabled = disabled;
  ui.saveGlobal.disabled = disabled || !globalState.dirty;
}

function fillModelSelect(
  select: HTMLSelectElement,
  current: string | null,
  emptyLabel: string,
  purpose: "optional" | "slot"
): void {
  const view = settingsState.view;
  const billingVerified = commandCodeBillingVerified();
  // Same shared freshness-gated ordering as WorkBuddy AI: only freshly
  // verified free evidence may move models to the front.
  const models = stableFreeFirstOrder(settingsModelChoices(), view?.model_meta, billingVerified);
  select.replaceChildren();
  if (emptyLabel) select.appendChild(makeOption("", emptyLabel));
  for (const model of models) {
    const free = billingVerified && view?.model_meta?.[model]?.free === true;
    const option = makeOption(model, free ? model + " · Free now" : model);
    if (free) option.style.fontWeight = "700";
    select.appendChild(option);
  }
  if (current && !models.includes(current)) {
    const reason = view?.catalog.reliable ? "not in the current official catalog" : "catalog unavailable, kept from the current configuration";
    const free = billingVerified && view?.model_meta?.[current]?.free === true;
    const option = makeOption(current, (free ? current + " · Free now" : current) + " (current config; " + reason + ")");
    if (free) option.style.fontWeight = "700";
    select.appendChild(option);
  }
  select.value = current ?? "";
  select.disabled = settingsControlsLocked() || (purpose === "slot" && (!view?.catalog.reliable || models.length === 0));
}

/**
 * Whether the capability phase has answered. An ABSENT flag means "checked"
 * (the complete read always checks), so only an explicit `checked:false` — the
 * catalog-phase read — is treated as still pending.
 */
function commandCodeCapabilityChecked(): boolean {
  return settingsState.view?.capabilities.checked !== false;
}

function fillPermissionMode(): void {
  const view = settingsState.view;
  const draft = settingsState.draft;
  if (!view || !draft) return;
  if (!commandCodeCapabilityChecked()) {
    // Capability evidence is pending: the mode list is a placeholder, NOT a
    // claim. Show ONLY the configured mode with a plain label, disabled —
    // no transient "check in progress / value kept" suffix.
    ui.permissionMode.replaceChildren(makeOption(draft.permission_mode, draft.permission_mode));
    ui.permissionMode.value = draft.permission_mode;
    ui.permissionMode.disabled = true;
    return;
  }
  const modes = [...new Set(view.capabilities.permission_modes)];
  ui.permissionMode.replaceChildren();
  for (const mode of modes) ui.permissionMode.appendChild(makeOption(mode, mode));
  if (!modes.includes(draft.permission_mode)) {
    // Keep the configured value visible and selected with a plain label: the
    // published list does not contain it. A failed/empty capability result is
    // reported by the card's higher-level status line, not on this control.
    ui.permissionMode.appendChild(makeOption(draft.permission_mode, draft.permission_mode));
  }
  ui.permissionMode.value = draft.permission_mode;
  ui.permissionMode.disabled = settingsControlsLocked() || modes.length === 0;
}

/**
 * The reasoning-effort levels the SELECTED default model's own published
 * metadata proves, or null when the installed package published no list for it.
 *
 * This is the SAME already-loaded `model_meta` the model dropdown renders from,
 * so switching the default model updates the Reasoning options locally — with no
 * extra CLI probe and no extra read.
 */
function commandCodeModelEfforts(model: string | null): string[] | null {
  if (!model) return null;
  const efforts = settingsState.view?.model_meta?.[model]?.efforts;
  return efforts && efforts.length ? [...efforts] : null;
}

/**
 * True when the selected model's OWN published list can vouch for `effort`.
 * A model the installed package publishes no list for makes no per-model claim,
 * so the configured value is kept (no evidence is never "unsupported").
 */
function commandCodeEffortSupportedByModel(effort: string | null, model: string | null): boolean {
  if (!effort) return false;
  const list = commandCodeModelEfforts(model);
  return list ? list.includes(effort) : true;
}

/**
 * The effort kept when a selection's MODEL changes: the saved effort for that
 * selection, but ONLY while the newly selected model is the very model that
 * saved effort belongs to and that model's own evidence still supports it.
 * Every other new model resets the effort to null (provider/model default) —
 * an effort saved for model A is never carried onto model B.
 */
function scopedSavedEffort(
  savedModel: string | null,
  savedEffort: string | null,
  newModel: string | null,
  supported: (effort: string, model: string | null) => boolean
): string | null {
  if (!newModel || !savedEffort || savedModel !== newModel) return null;
  return supported(savedEffort, newModel) ? savedEffort : null;
}

/**
 * Fill ONE Command Code reasoning select. The options follow the model THAT
 * SELECT currently points at (the default model or the fallback model), from
 * the SAME already-loaded `model_meta` — no extra CLI probe. A saved value the
 * model's own published list does not contain is kept visible and selected.
 */
function fillCommandCodeEffortSelect(select: HTMLSelectElement, model: string | null, current: string | null): void {
  const view = settingsState.view;
  if (!view) return;
  if (!commandCodeCapabilityChecked()) {
    // Same pending contract as Permission: ONLY the configured value (or the
    // provider-default representation of an unset effort), plain, disabled.
    select.replaceChildren(makeOption(current ?? "", current ?? "Unspecified (Provider default)"));
    select.value = current ?? "";
    select.disabled = true;
    return;
  }
  const modelEfforts = commandCodeModelEfforts(model);
  select.replaceChildren(makeOption("", "Unspecified (Provider default)"));
  if (view.capabilities.supports_effort) {
    // The selected model's OWN published list when the installed package
    // publishes one. A model with no published list keeps the CLI's level
    // vocabulary: no evidence is never presented as "unsupported".
    for (const effort of modelEfforts ?? EFFORT_LEVELS) select.appendChild(makeOption(effort, effort));
  }
  if (current && !Array.from(select.options).some((option) => option.value === current)) {
    // The saved value is ALWAYS kept visible and selected — never silently
    // rewritten or dropped, even when this model's list does not contain it.
    select.appendChild(makeOption(current, current));
  }
  select.value = current ?? "";
  select.disabled = settingsControlsLocked() || !view.capabilities.supports_effort;
}

/** Fill BOTH Command Code reasoning selects (default model + fallback model). */
function fillCommandCodeEfforts(): void {
  const draft = settingsState.draft;
  if (!draft) return;
  fillCommandCodeEffortSelect(ui.defaultEffort, ui.defaultModel.value || draft.default_model, draft.default_effort);
  fillCommandCodeEffortSelect(ui.fallbackEffort, ui.fallbackModel.value || draft.rate_limit_fallback_model, draft.rate_limit_fallback_effort);
}

function renderSettings(): void {
  const view = settingsState.view;
  const draft = settingsState.draft;
  if (settingsState.loading) {
    // Only the first read has no usable form to keep on screen. Later refreshes
    // keep the current form visible and never return to this loading state.
    renderProviderLoadingState(ui.cliInfo, ui.catalogInfo, ui.effectiveInfo, "command-code");
    ui.yoloWarning.classList.add("hidden");
    ui.modelIssues.replaceChildren();
    ui.modelIssues.classList.add("hidden");
    clearProviderFormSelects([ui.permissionMode, ui.defaultEffort, ui.fallbackEffort, ui.defaultModel, ui.fallbackModel]);
    ui.defaultModel.title = "";
    ui.fallbackModel.title = "";
    ui.saveSettings.disabled = true;
    lockProviderCard(ui.commandCodeCard);
    return;
  }
  for (const item of [ui.cliInfo, ui.catalogInfo, ui.effectiveInfo]) item.classList.remove("loading");
  if (settingsState.readError !== null) {
    // An unreadable provider is shown as unavailable: the form is not rendered
    // from any earlier read.
    ui.cliInfo.classList.remove("hidden");
    ui.cliInfo.classList.add("warning");
    showLines(ui.cliInfo, ["Settings unavailable", "See the message below for details."]);
    clearProviderFormSelects([ui.permissionMode, ui.defaultEffort, ui.fallbackEffort, ui.defaultModel, ui.fallbackModel]);
    ui.defaultModel.title = "";
    ui.fallbackModel.title = "";
    ui.saveSettings.disabled = true;
    lockProviderCard(ui.commandCodeCard);
    return;
  }
  if (!view || !draft) {
    ui.saveSettings.disabled = true;
    lockProviderCard(ui.commandCodeCard);
    return;
  }
  fillPermissionMode();
  // The model selects come FIRST: each Reasoning select's options follow the
  // model THAT select points at, so both model lists must already be in place.
  const visibleDefaultModel = draft.default_model ?? view.catalog.default_model;
  fillModelSelect(
    ui.defaultModel,
    visibleDefaultModel,
    visibleDefaultModel ? "" : "Unknown",
    "optional"
  );
  fillModelSelect(ui.fallbackModel, draft.rate_limit_fallback_model, "No rate-limit final fallback", "optional");
  fillCommandCodeEfforts();
  renderPermissionNote(ui.yoloWarning, "command-code", draft.permission_mode);
  ui.saveSettings.disabled = settingsControlsLocked() || !settingsState.dirty;

  const cliProblem = !view.cli.available || !!view.cli.error;
  ui.cliInfo.classList.toggle("hidden", !cliProblem);
  if (cliProblem) {
    // The model list may be perfectly usable from the installed package while
    // the CLI's capability probe is unavailable: say exactly which part failed.
    const cliLines = [view.cli.available ? "Command Code capability check failed." : "Command Code is unavailable."];
    if (view.cli.error) cliLines.push(view.cli.error);
    showLines(ui.cliInfo, cliLines);
    ui.cliInfo.classList.add("warning");
  } else {
    ui.cliInfo.classList.remove("warning");
  }

  const catalogProblem = !view.catalog.reliable || !!view.catalog.error;
  ui.catalogInfo.classList.toggle("hidden", !catalogProblem);
  if (catalogProblem) {
    const catalogLines = ["Model list unavailable or could not be verified."];
    if (view.catalog.error) catalogLines.push(view.catalog.error);
    else catalogLines.push("Saved model choices are kept until the model list is available again.");
    showLines(ui.catalogInfo, catalogLines);
    ui.catalogInfo.classList.add("warning");
  } else {
    ui.catalogInfo.classList.remove("warning");
    ui.catalogInfo.replaceChildren();
  }
  // The installed package's shipped model reference is version-local, not a
  // live billing check. That limitation stays available as a secondary tooltip
  // on the model selects instead of a permanent informational row; the warning
  // above remains the primary surface when the catalog fails.
  const catalogProvenance = view.catalog.source === "installed-package-reference"
    ? "Model list and Free now come from the installed Command Code package's own shipped model reference (version-local metadata; not a live billing guarantee)."
    : "";
  ui.defaultModel.title = catalogProvenance;
  ui.fallbackModel.title = catalogProvenance;

  // The selected Default model already communicates the normal route. Keep the
  // technical effective/source details out of the ordinary settings UI.
  ui.effectiveInfo.classList.add("hidden");

  ui.modelIssues.replaceChildren();
  for (const issue of view.diagnostics) {
    const item = document.createElement("div");
    item.textContent = issue.field + ": " + issue.message + (issue.value ? " (configured value: " + issue.value + ")" : "");
    ui.modelIssues.appendChild(item);
  }
  ui.modelIssues.classList.toggle("hidden", view.diagnostics.length === 0);
}

// ---------------------------------------------------------------------------
// The ONE provider-settings fresh loader (shared by both providers)
// ---------------------------------------------------------------------------
//
// Opening Settings, switching provider and the post-save refresh all perform a
// real provider read: the simple loading state is shown while the read is in
// flight, and the provider form is only rendered from that read's response.

interface ProviderSettingsLoad<TView, TConfig> {
  path: string;
  state: {
    view: TView | null;
    draft: TConfig | null;
    freshness: SettingsFreshness | null;
    loadPromise: Promise<void> | null;
    generation: number;
    dirty: boolean;
    loading: boolean;
    readError: string | null;
    busy: boolean;
  };
  dirtyMessage: string;
  applyView(view: TView, freshness: SettingsFreshness | null, preserveDraft: boolean): void;
  render(): void;
  setMessage(text: string): void;
  markInvalid(response: InvalidSettingsView): void;
  markUnavailable(detail: string): void;
  /**
   * OPTIONAL second phase for providers whose read splits into a process-free
   * part and a CLI part. It runs only AFTER `view` has been applied and the
   * form rendered, and the loader never waits for it: the model list and
   * Free-now are already on screen, so a cold or hung CLI cannot delay them.
   * `isCurrent()` is false once a newer read or a save owns the view, in which
   * case the follow-up must discard its result.
   */
  followUp?(view: TView, isCurrent: () => boolean): Promise<void>;
}

function loadProviderSettingsFresh<TView, TConfig>(load: ProviderSettingsLoad<TView, TConfig>): Promise<void> {
  const state = load.state;
  if (state.loadPromise) return state.loadPromise;
  const generation = ++state.generation;
  const hadUsableView = state.view !== null && state.draft !== null;
  // A previous failure must not block a new explicit attempt. Once a provider
  // has a usable view, a refresh is deliberately silent: keep the current form
  // on screen instead of blanking it behind another loading state.
  state.readError = null;
  state.loading = !hadUsableView;
  if (hadUsableView && state.freshness) {
    // Keep the known model/config form visible, but do not keep presenting
    // time-sensitive Free-now evidence as freshly verified during the refresh.
    state.freshness = { ...state.freshness, billing_verified: false };
  }
  load.setMessage("");
  load.render();
  let pending: { view: TView; isCurrent: () => boolean } | null = null;
  const base = (async () => {
    try {
      const fresh = await api<SettingsFreshEnvelope<TView> | InvalidSettingsView>(`${load.path}?fresh=1`);
      if (generation !== state.generation) return;
      if (!fresh.ok) {
        if (hadUsableView) load.setMessage("Refresh failed.");
        else load.markInvalid(fresh);
        return;
      }
      // A save owns the view while it is in flight: its own fresh re-read is
      // the authoritative replacement, so a read that started before the save
      // must not overwrite it afterwards.
      if (state.busy) return;
      load.applyView(fresh.view, fresh.freshness, true);
      load.setMessage(state.dirty ? load.dirtyMessage : "");
      const applied = state.view ?? fresh.view;
      pending = {
        view: applied,
        isCurrent: () => generation === state.generation && state.view === applied && !state.busy
      };
    } catch (error) {
      if (generation !== state.generation) return;
      if (hadUsableView) load.setMessage("Refresh failed.");
      else load.markUnavailable(errorMessage(error));
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        load.render();
      }
    }
  })();
  state.loadPromise = base.then(() => {
    // The form is rendered at this point. The follow-up is deliberately NOT
    // awaited: it owns its own errors, so a failing capability read can never
    // become an unhandled rejection or leave the form stuck in a loading state.
    if (!pending || !load.followUp) return;
    const { view, isCurrent } = pending;
    void load.followUp(view, isCurrent).catch((error: unknown) => {
      if (isCurrent()) load.setMessage("Capability check failed: " + errorMessage(error));
    });
  });
  const handle = state.loadPromise;
  return handle.finally(() => {
    // Only clear the handle if it is still OURS: a newer load may have replaced it.
    if (state.loadPromise === handle) state.loadPromise = null;
  });
}

function applySettingsView(view: SettingsView, freshness: SettingsFreshness | null, preserveDraft = false): void {
  const keepDraft = preserveDraft && settingsState.dirty && settingsState.draft ? settingsState.draft : null;
  const previousView = settingsState.view;
  const previousObservedDefault = previousView?.catalog.default_model ?? null;
  const withObservedDefault = !view.config.default_model && !view.catalog.default_model && previousObservedDefault
    ? { ...view, catalog: { ...view.catalog, default_model: previousObservedDefault } }
    : view;
  // A background catalog refresh is not evidence that known CLI capabilities
  // disappeared. Keep the last confirmed controls usable until the fresh
  // capability phase replaces them; only the very first load has to wait.
  const nextView = preserveDraft
    && withObservedDefault.capabilities.checked === false
    && previousView !== null
    && previousView.capabilities.checked !== false
    ? { ...withObservedDefault, capabilities: previousView.capabilities }
    : withObservedDefault;
  settingsState.view = nextView;
  settingsState.draft = keepDraft ?? { ...view.config };
  settingsState.freshness = freshness;
  if (!keepDraft) settingsState.dirty = false;
  settingsState.readError = null;
  renderSettings();
}

function loadSettings(): Promise<void> {
  return loadProviderSettingsFresh<SettingsView, SettingsConfig>({
    path: "/api/settings",
    state: settingsState,
    dirtyMessage: "Unsaved Command Code settings changes.",
    applyView: (view, freshness, preserveDraft) => applySettingsView(view, freshness, preserveDraft),
    render: renderSettings,
    setMessage: (text) => { ui.settingsMessage.textContent = text; },
    markInvalid: (response) => {
      const field = response.field ? " · field: " + response.field : "";
      settingsState.readError = response.code + field;
      ui.settingsMessage.textContent =
        "Invalid configuration (" + response.code + field + "): " + response.message + " The stored configuration is unchanged and saving is disabled; fix the configuration file and reopen this page to retry.";
    },
    markUnavailable: (detail) => {
      settingsState.readError = detail;
      ui.settingsMessage.textContent = "Failed to read settings: " + detail + " Saving is disabled; reopen this page to retry.";
    },
    // Command Code's capability evidence (`--version` / `--help`) needs the CLI
    // process, so it is a SEPARATE later read: the model list and Free-now are
    // already rendered by the time this runs. It only ever patches capability
    // fields (and the fallback catalog when the fast phase had none).
    followUp: (view, isCurrent) => fetchSettingsCapabilities(view, isCurrent)
  });
}

/**
 * Read Command Code's capability phase and patch it into the rendered view.
 * Shared by the normal load follow-up and the post-save refresh so both
 * generation paths end up with the same honest evidence.
 */
async function fetchSettingsCapabilities(view: SettingsView, isCurrent: () => boolean): Promise<void> {
  const fresh = await api<SettingsCapabilityPatchEnvelope | InvalidSettingsView>("/api/settings/capabilities?fresh=1");
  // An invalid-config response is reported by the next full load, not here.
  if (!fresh.ok || !isCurrent()) return;
  applySettingsCapabilityPatch(fresh.patch);
}

/** Fire-and-forget capability follow-up that owns its own failure reporting. */
function runSettingsCapabilityFollowUp(view: SettingsView): void {
  void fetchSettingsCapabilities(view, () => settingsState.view === view && !settingsState.busy).catch((error: unknown) => {
    if (settingsState.view === view) ui.settingsMessage.textContent = "Capability check failed: " + errorMessage(error);
  });
}

/**
 * Patch the capability phase into the already-rendered view. It replaces ONLY
 * the capability-owned fields, so the user's in-progress draft and every other
 * value from the catalog phase are preserved. The catalog/meta are replaced
 * only when the capability phase actually carries them (the `--list-models`
 * fallback), so an installed-package catalog is never overwritten.
 */
function applySettingsCapabilityPatch(patch: SettingsCapabilityPatchEnvelope["patch"]): void {
  const view = settingsState.view;
  if (!view) return;
  const catalog = patch.catalog ?? {
    ...view.catalog,
    default_model: patch.observed_default_model ?? view.catalog.default_model
  };
  settingsState.view = {
    ...view,
    cli: { ...view.cli, version: patch.cli.version, error: patch.cli.error },
    capabilities: patch.capabilities,
    catalog,
    model_meta: patch.model_meta ?? view.model_meta
  };
  renderSettings();
}

async function saveSettings(): Promise<void> {
  const view = settingsState.view;
  const draft = settingsState.draft;
  if (settingsState.busy || settingsState.readError || !settingsState.dirty || !view || !draft) return;
  const payload: SettingsConfig = {
    cli_path: draft.cli_path,
    default_model: ui.defaultModel.value || draft.default_model,
    rate_limit_fallback_model: ui.fallbackModel.value || null,
    permission_mode: view.capabilities.permission_modes.length ? ui.permissionMode.value || draft.permission_mode : draft.permission_mode,
    default_effort: view.capabilities.supports_effort ? ui.defaultEffort.value || null : draft.default_effort,
    rate_limit_fallback_effort: view.capabilities.supports_effort ? ui.fallbackEffort.value || null : draft.rate_limit_fallback_effort
  };
  // A save supersedes any read that started before it. The persisted response
  // is enough to release the UI; provider verification continues in background.
  settingsState.generation += 1;
  settingsState.loadPromise = null;
  settingsState.loading = false;
  settingsState.busy = true;
  ui.settingsMessage.textContent = "Saving…";
  ui.commandCodeCard.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((control) => {
    control.disabled = true;
  });
  let saved = false;
  try {
    const response = await api<{ ok: boolean; config: SettingsConfig }>("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    settingsState.view = { ...view, config: response.config };
    settingsState.draft = { ...response.config };
    settingsState.dirty = false;
    settingsState.readError = null;
    ui.settingsMessage.textContent = "";
    saved = true;
  } catch (error) {
    ui.settingsMessage.textContent = "Save failed: " + errorMessage(error);
  } finally {
    settingsState.busy = false;
    renderSettings();
  }
  if (saved) void loadSettings();
}

function workBuddyControlsLocked(): boolean {
  return workBuddySettingsState.busy || workBuddySettingsState.loading || workBuddySettingsState.readError !== null;
}

function markWorkBuddySettingsDirty(): void {
  workBuddySettingsState.dirty = true;
  ui.wbSaveSettings.disabled = workBuddyControlsLocked() || !workBuddySettingsState.dirty;
  if (!workBuddySettingsState.busy) ui.wbSettingsMessage.textContent = "Unsaved WorkBuddy AI settings changes.";
}

function workBuddyPromotionBoundaryMs(): number | null {
  const raw = workBuddySettingsState.view?.promotion_next_boundary_at;
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function workBuddyPromotionRefreshAllowed(): boolean {
  return state.view === "settings" &&
    selectedSettingsProvider === "workbuddy-ai" &&
    !workBuddySettingsState.loading &&
    !workBuddySettingsState.busy;
}

function refreshWorkBuddyPromotionIfDue(): void {
  const boundary = workBuddyPromotionBoundaryMs();
  if (boundary == null || Date.now() + 250 < boundary || !workBuddyPromotionRefreshAllowed()) return;
  // A boundary crossing always triggers a FRESH provider read; the boundary
  // time itself is never treated as pricing evidence.
  void loadWorkBuddySettings();
}

function scheduleWorkBuddyPromotionRefresh(): void {
  if (workBuddyPromotionTimer != null) {
    window.clearTimeout(workBuddyPromotionTimer);
    workBuddyPromotionTimer = null;
  }
  const boundary = workBuddyPromotionBoundaryMs();
  if (boundary == null) return;
  const remaining = boundary - Date.now();
  if (remaining <= 250) {
    refreshWorkBuddyPromotionIfDue();
    return;
  }
  workBuddyPromotionTimer = window.setTimeout(() => {
    workBuddyPromotionTimer = null;
    const currentBoundary = workBuddyPromotionBoundaryMs();
    if (currentBoundary != null && Date.now() + 250 < currentBoundary) {
      scheduleWorkBuddyPromotionRefresh();
      return;
    }
    refreshWorkBuddyPromotionIfDue();
  }, Math.min(Math.max(remaining, 1000), WORKBUDDY_PROMOTION_TIMER_MAX_MS));
}

function workBuddyModelLabel(model: string): string {
  const meta = workBuddySettingsState.view?.model_meta?.[model];
  if (!meta) return model;
  // Free-now and credit text are BILLING metadata: they only render from
  // freshly verified evidence. A view whose freshness is not billing-verified
  // shows the plain model name.
  const billingVerified = workBuddyBillingVerified();
  if (billingVerified && meta.free) return meta.label + " · Free now";
  return billingVerified && meta.credits ? meta.label + " · " + meta.credits : meta.label;
}

function fillWorkBuddyModelSelect(select: HTMLSelectElement, current: string | null, emptyLabel: string): void {
  const view = workBuddySettingsState.view;
  const billingVerified = workBuddyBillingVerified();
  const offered = view?.catalog.reliable
    ? [...new Set(view.offered_models.length ? view.offered_models : view.catalog.models)]
    : [];
  // Same shared freshness-gated ordering as Command Code: only freshly
  // verified free evidence may move models to the front; unverified evidence
  // keeps the provider/catalog order.
  const models = stableFreeFirstOrder(offered, view?.model_meta, billingVerified);
  select.replaceChildren(makeOption("", emptyLabel));
  for (const model of models) {
    const option = makeOption(model, workBuddyModelLabel(model));
    if (billingVerified && view?.model_meta?.[model]?.free) option.style.fontWeight = "700";
    select.appendChild(option);
  }
  if (current && !models.includes(current)) {
    const accepted = !!view?.catalog.models.includes(current);
    const reason = accepted
      ? "current config; valid but not normally shown by the WorkBuddy App"
      : view?.catalog.reliable
        ? "not in the current official catalog"
        : "catalog unavailable, kept from the current configuration";
    const option = makeOption(current, workBuddyModelLabel(current) + " (" + reason + ")");
    if (billingVerified && view?.model_meta?.[current]?.free) option.style.fontWeight = "700";
    select.appendChild(option);
  }
  select.value = current ?? "";
  select.style.fontWeight = "400";
  select.disabled = workBuddyControlsLocked();
}

/** The published reasoning evidence for `model`, if known. */
function workBuddyModelReasoning(model: string | null): WorkBuddyReasoningMeta | null {
  const view = workBuddySettingsState.view;
  if (!view || !model) return null;
  return view.model_meta?.[model]?.reasoning ?? null;
}

/**
 * The display label of one reasoning-effort option. Option VALUES stay the RAW
 * effort tokens; only this label carries the Official App provenance.
 */
function workBuddyEffortOptionLabel(effort: string, reasoning: WorkBuddyReasoningMeta | null): string {
  if (reasoning?.app_default_effort === effort) return effort + " (Official App default)";
  if (reasoning?.supported_efforts_source === "command-code") return effort + " (Not shown in Official App)";
  return effort;
}

/**
 * True when the selected model's OWN reasoning evidence can vouch for
 * `effort`. A model with an explicit published list accepts exactly that
 * vocabulary; a model that publishes only the App default proves exactly that
 * one value. A model with no model-specific evidence makes no per-model claim:
 * the provider CLI's `--effort` capability stays the source of truth there
 * (the unchanged legacy branch).
 */
function workBuddyEffortSupportedByModel(effort: string | null, model: string | null): boolean {
  if (!effort) return false;
  const reasoning = workBuddyModelReasoning(model);
  if (reasoning?.supported_efforts?.length) return reasoning.supported_efforts.includes(effort);
  if (reasoning?.app_default_effort) return reasoning.app_default_effort === effort;
  return true;
}

/**
 * The persisted effort for ONE WorkBuddy selection, scoped to the model it was
 * saved with: it only counts while the newly selected model IS that model and
 * its own evidence still supports the value. Every other model resets to
 * Unspecified/Provider default instead of inheriting another model's effort.
 */
function workBuddyScopedSavedEffort(savedModel: string | null, savedEffort: string | null, newModel: string | null): string | null {
  return scopedSavedEffort(savedModel, savedEffort, newModel, workBuddyEffortSupportedByModel);
}

/**
 * One honest line when a persisted effort is not a value the selected model
 * proves: the select shows Unspecified (Provider default) instead of offering
 * the unsupported value as a choice. Storage stays untouched until the user
 * saves; saving the shown form persists the reset. Each selection is reported
 * independently.
 */
function workBuddyEffortResetNotices(): string[] {
  const draft = workBuddySettingsState.draft;
  if (!draft) return [];
  const notices: string[] = [];
  if (draft.default_effort && !workBuddyEffortSupportedByModel(draft.default_effort, draft.default_model)) {
    notices.push("Saved default-model reasoning effort \"" + draft.default_effort + "\" is not supported by the selected default model; the dropdown shows Unspecified (Provider default), and saving will clear it.");
  }
  if (draft.rate_limit_fallback_effort && !workBuddyEffortSupportedByModel(draft.rate_limit_fallback_effort, draft.rate_limit_fallback_model)) {
    notices.push("Saved fallback-model reasoning effort \"" + draft.rate_limit_fallback_effort + "\" is not supported by the selected rate-limit fallback model; the dropdown shows Unspecified (Provider default), and saving will clear it.");
  }
  return notices;
}

/** True when ONE selection's Reasoning select is backed by real evidence (model or CLI). */
function workBuddyEffortControlsActive(model: string | null): boolean {
  const view = workBuddySettingsState.view;
  return !!view && (!!workBuddyModelReasoning(model) || view.capabilities.supports_effort);
}

/**
 * The WorkBuddy Reasoning options are MODEL-SPECIFIC, and each selection (the
 * default model and the rate-limit fallback model) has its OWN select whose
 * options follow the model THAT select points at:
 *   * an Official App published supported list (or the DS-only Command Code
 *     fallback list) is offered exactly as published;
 *   * when only the App's own default effort is known, ONLY that default is
 *     offered — never the CLI's full vocabulary;
 *   * a saved effort is selected only while the selected model's own evidence
 *     supports it: an unsupported value (e.g. another model's `max`) is never
 *     appended as an option and never masquerades as a current choice. The
 *     card carries a small honest reset note instead.
 * Only a model the App describes with no effort evidence at all keeps the
 * previous CLI `--effort` capability list.
 */
function fillWorkBuddyEffortSelect(select: HTMLSelectElement, model: string | null, saved: string | null): void {
  const view = workBuddySettingsState.view;
  const reasoning = workBuddyModelReasoning(model);
  const supported = reasoning?.supported_efforts?.length ? [...reasoning.supported_efforts] : null;
  const selected = saved && workBuddyEffortSupportedByModel(saved, model) ? saved : null;
  const locked = workBuddyControlsLocked();
  select.replaceChildren();

  if (supported) {
    // Published model-specific options: offer exactly them, with provenance.
    for (const effort of supported) select.appendChild(makeOption(effort, workBuddyEffortOptionLabel(effort, reasoning)));
    if (!selected) select.prepend(makeOption("", "Unspecified (Provider default)"));
    select.value = selected ?? "";
    select.disabled = locked;
    return;
  }

  if (reasoning) {
    // Only the App's own default effort is proven for this model: never widen
    // it to the CLI's vocabulary, and never offer an unsupported saved value.
    if (!selected) select.appendChild(makeOption("", "Unspecified (Provider default)"));
    if (reasoning.app_default_effort) {
      select.appendChild(makeOption(reasoning.app_default_effort, workBuddyEffortOptionLabel(reasoning.app_default_effort, reasoning)));
    }
    select.value = selected ?? "";
    select.disabled = locked;
    return;
  }

  // No model-specific App evidence for the selected model: the CLI's own
  // `--effort` capability remains the source of truth (unchanged behavior).
  select.appendChild(makeOption("", "Unspecified (Provider default)"));
  if (view?.capabilities.supports_effort) {
    for (const effort of EFFORT_LEVELS) select.appendChild(makeOption(effort, effort));
  }
  if (saved && !Array.from(select.options).some((option) => option.value === saved)) {
    select.appendChild(makeOption(saved, saved));
  }
  select.value = saved ?? "";
  select.disabled = locked || !view?.capabilities.supports_effort;
}

/** Fill BOTH WorkBuddy reasoning selects (default model + fallback model). */
function fillWorkBuddyEfforts(): void {
  const draft = workBuddySettingsState.draft;
  if (!draft) return;
  fillWorkBuddyEffortSelect(ui.wbDefaultEffort, ui.wbDefaultModel.value || draft.default_model, draft.default_effort);
  fillWorkBuddyEffortSelect(ui.wbFallbackEffort, ui.wbFallbackModel.value || draft.rate_limit_fallback_model, draft.rate_limit_fallback_effort);
}

function renderWorkBuddySettings(): void {
  const view = workBuddySettingsState.view;
  const draft = workBuddySettingsState.draft;
  if (workBuddySettingsState.loading) {
    // Only the first read has no usable form to keep on screen. Later refreshes
    // keep the current WorkBuddy form visible instead of blanking it.
    renderProviderLoadingState(ui.wbCliInfo, ui.wbCatalogInfo, ui.wbEffectiveInfo, "workbuddy-ai");
    ui.wbYoloWarning.classList.add("hidden");
    ui.wbModelIssues.replaceChildren();
    ui.wbModelIssues.classList.add("hidden");
    clearProviderFormSelects([ui.wbPermissionMode, ui.wbDefaultEffort, ui.wbFallbackEffort, ui.wbDefaultModel, ui.wbFallbackModel]);
    ui.wbSaveSettings.disabled = true;
    lockProviderCard(ui.wbCard);
    return;
  }
  for (const item of [ui.wbCliInfo, ui.wbCatalogInfo, ui.wbEffectiveInfo]) item.classList.remove("loading", "wb-loading");
  if (workBuddySettingsState.readError !== null) {
    ui.wbCliInfo.classList.remove("hidden");
    ui.wbCliInfo.classList.add("warning");
    showLines(ui.wbCliInfo, ["WorkBuddy AI settings unavailable", "See the message below for details."]);
    clearProviderFormSelects([ui.wbPermissionMode, ui.wbDefaultEffort, ui.wbFallbackEffort, ui.wbDefaultModel, ui.wbFallbackModel]);
    ui.wbSaveSettings.disabled = true;
    lockProviderCard(ui.wbCard);
    return;
  }
  if (!view || !draft) {
    ui.wbSaveSettings.disabled = true;
    lockProviderCard(ui.wbCard);
    return;
  }

  // The normal choices are the supported values from the fixed public order;
  // WorkBuddy's advanced dont-ask/auto modes are never normal choices.
  const published = new Set(view.capabilities.permission_modes);
  const modes = WORKBUDDY_NORMAL_PERMISSION_MODES.filter((mode) => published.has(mode));
  ui.wbPermissionMode.replaceChildren();
  for (const mode of modes) ui.wbPermissionMode.appendChild(makeOption(mode, permissionModeLabel(mode)));
  if (!modes.includes(draft.permission_mode)) {
    // Keep the configured value visible and selected. A value the provider
    // publishes but the normal list hides (advanced dont-ask/auto) stays a
    // non-selectable current-config item, so opening Settings never silently
    // overwrites it; an unpublished value keeps the capability-unconfirmed
    // wording.
    const option = makeOption(
      draft.permission_mode,
      permissionModeLabel(draft.permission_mode) +
        (published.has(draft.permission_mode) ? " (current config; advanced value not normally shown)" : " (current config; capability unconfirmed)")
    );
    option.disabled = true;
    ui.wbPermissionMode.appendChild(option);
  }
  ui.wbPermissionMode.value = draft.permission_mode;
  ui.wbPermissionMode.disabled = workBuddyControlsLocked() || modes.length === 0;

  // The model selects come FIRST: each Reasoning select's options follow the
  // model THAT select points at, so both model lists must already be in place.
  fillWorkBuddyModelSelect(ui.wbDefaultModel, draft.default_model, "No default model");
  fillWorkBuddyModelSelect(ui.wbFallbackModel, draft.rate_limit_fallback_model, "No rate-limit final fallback");
  fillWorkBuddyEfforts();
  renderPermissionNote(ui.wbYoloWarning, "workbuddy-ai", draft.permission_mode);
  ui.wbSaveSettings.disabled = workBuddyControlsLocked() || !workBuddySettingsState.dirty;

  const cliProblem = !view.cli.available || !!view.cli.error;
  ui.wbCliInfo.classList.toggle("hidden", !cliProblem);
  if (cliProblem) {
    const cliLines = ["WorkBuddy AI is unavailable."];
    if (view.cli.error) cliLines.push(view.cli.error);
    showLines(ui.wbCliInfo, cliLines);
    ui.wbCliInfo.classList.add("warning");
  } else {
    ui.wbCliInfo.classList.remove("warning");
  }

  const catalogProblem = !view.catalog.reliable || view.catalog.models.length === 0;
  ui.wbCatalogInfo.classList.toggle("hidden", !catalogProblem);
  if (catalogProblem) {
    showLines(ui.wbCatalogInfo, ["WorkBuddy AI model list unavailable."]);
    ui.wbCatalogInfo.classList.add("warning");
  } else {
    ui.wbCatalogInfo.classList.remove("warning");
    ui.wbCatalogInfo.replaceChildren();
  }

  // Default/fallback selections are the user-facing route. Do not expose the
  // internal verification/source status during normal operation.
  ui.wbEffectiveInfo.classList.add("hidden");

  const effortResetNotices = workBuddyEffortResetNotices();
  ui.wbModelIssues.replaceChildren();
  for (const issue of view.diagnostics) {
    const item = document.createElement("div");
    item.textContent = issue.field + ": " + issue.message + (issue.value ? " (configured value: " + issue.value + ")" : "");
    ui.wbModelIssues.appendChild(item);
  }
  for (const notice of effortResetNotices) {
    const item = document.createElement("div");
    item.textContent = notice;
    ui.wbModelIssues.appendChild(item);
  }
  ui.wbModelIssues.classList.toggle("hidden", view.diagnostics.length === 0 && effortResetNotices.length === 0);
}

function applyWorkBuddySettingsView(view: WorkBuddySettingsView, freshness: SettingsFreshness | null, preserveDraft = false): void {
  const keepDraft = preserveDraft && workBuddySettingsState.dirty && workBuddySettingsState.draft
    ? workBuddySettingsState.draft
    : null;
  workBuddySettingsState.view = view;
  workBuddySettingsState.draft = keepDraft ?? { ...view.config };
  workBuddySettingsState.freshness = freshness;
  if (!keepDraft) workBuddySettingsState.dirty = false;
  workBuddySettingsState.readError = null;
  renderWorkBuddySettings();
  scheduleWorkBuddyPromotionRefresh();
}

function loadWorkBuddySettings(): Promise<void> {
  return loadProviderSettingsFresh<WorkBuddySettingsView, WorkBuddySettingsConfig>({
    path: "/api/providers/workbuddy-ai/settings",
    state: workBuddySettingsState,
    dirtyMessage: "Unsaved WorkBuddy AI settings changes.",
    applyView: (view, freshness, preserveDraft) => applyWorkBuddySettingsView(view, freshness, preserveDraft),
    render: renderWorkBuddySettings,
    setMessage: (text) => { ui.wbSettingsMessage.textContent = text; },
    markInvalid: (response) => {
      const field = response.field ? " · field: " + response.field : "";
      workBuddySettingsState.readError = response.code + field;
      ui.wbSettingsMessage.textContent =
        "Invalid WorkBuddy AI configuration (" + response.code + field + "): " + response.message + " Saving is disabled.";
    },
    markUnavailable: (detail) => {
      workBuddySettingsState.readError = detail;
      ui.wbSettingsMessage.textContent = "Failed to read WorkBuddy AI settings: " + detail;
    }
  });
}

async function saveWorkBuddySettings(): Promise<void> {
  const view = workBuddySettingsState.view;
  const draft = workBuddySettingsState.draft;
  if (workBuddySettingsState.busy || workBuddySettingsState.readError || !workBuddySettingsState.dirty || !view || !draft) return;
  const payload: WorkBuddySettingsConfig = {
    cli_path: draft.cli_path,
    default_model: ui.wbDefaultModel.value || null,
    rate_limit_fallback_model: ui.wbFallbackModel.value || null,
    permission_mode: view.capabilities.permission_modes.length ? ui.wbPermissionMode.value || draft.permission_mode : draft.permission_mode,
    default_effort: workBuddyEffortControlsActive(ui.wbDefaultModel.value || draft.default_model)
      ? ui.wbDefaultEffort.value || null
      : draft.default_effort,
    rate_limit_fallback_effort: workBuddyEffortControlsActive(ui.wbFallbackModel.value || draft.rate_limit_fallback_model)
      ? ui.wbFallbackEffort.value || null
      : draft.rate_limit_fallback_effort
  };
  // WorkBuddy's provider re-read can take longer than the config write itself.
  // Finish Saving as soon as the write succeeds and verify in the background.
  workBuddySettingsState.generation += 1;
  workBuddySettingsState.loadPromise = null;
  workBuddySettingsState.loading = false;
  workBuddySettingsState.busy = true;
  ui.wbSettingsMessage.textContent = "Saving…";
  ui.wbCard.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((control) => {
    control.disabled = true;
  });
  let saved = false;
  try {
    const response = await api<{ ok: boolean; config: WorkBuddySettingsConfig }>("/api/providers/workbuddy-ai/settings", { method: "PUT", body: JSON.stringify(payload) });
    workBuddySettingsState.view = { ...view, config: response.config };
    workBuddySettingsState.draft = { ...response.config };
    workBuddySettingsState.dirty = false;
    workBuddySettingsState.readError = null;
    ui.wbSettingsMessage.textContent = "";
    saved = true;
  } catch (error) {
    ui.wbSettingsMessage.textContent = "Save failed: " + errorMessage(error);
  } finally {
    workBuddySettingsState.busy = false;
    renderWorkBuddySettings();
  }
  if (saved) void loadWorkBuddySettings();
}

function renderSelectedProviderSettings(): void {
  ui.settingsProvider.value = selectedSettingsProvider;
  ui.commandCodeCard.classList.toggle("hidden", selectedSettingsProvider !== "command-code");
  ui.wbCard.classList.toggle("hidden", selectedSettingsProvider !== "workbuddy-ai");
  // Render the selected provider's current usable state immediately. A later
  // refresh may replace it, but normal viewing never blanks a known form.
  if (selectedSettingsProvider === "command-code") renderSettings();
  else renderWorkBuddySettings();
}

function loadSelectedProviderSettings(): void {
  if (selectedSettingsProvider === "command-code") {
    void loadSettings();
  } else if (selectedSettingsProvider === "workbuddy-ai") {
    void loadWorkBuddySettings();
  }
}

function applyGlobalSettings(value: GlobalSettingsView): void {
  globalState.value = value;
  globalState.loaded = true;
  globalState.dirty = false;
  state.firstPage = value.jobs_page_size;
  ui.pageSize.value = String(value.jobs_page_size);
  ui.retentionDays.value = String(value.diag_retention_days);
  ui.retentionGb.value = String(value.diag_max_total_bytes / GIB);
  updateGlobalControlState();
}

function loadGlobalSettings(force = false): Promise<void> {
  if (globalState.loadPromise) return globalState.loadPromise;
  if (globalState.loaded && (!force || globalState.dirty)) return Promise.resolve();
  ui.globalMessage.textContent = "Reading global settings…";
  globalState.loading = true;
  updateGlobalControlState();
  globalState.loadPromise = (async () => {
    try {
      const value = await api<GlobalSettingsView>("/api/global-settings");
      applyGlobalSettings(value);
      ui.globalMessage.textContent = "";
    } catch (error) {
      ui.globalMessage.textContent = "Failed to read global settings: " + errorMessage(error);
      setStatus("Global settings unavailable: " + errorMessage(error), true);
    } finally {
      globalState.loading = false;
      globalState.loadPromise = null;
      updateGlobalControlState();
    }
  })();
  return globalState.loadPromise;
}

async function saveGlobalSettings(): Promise<void> {
  if (globalState.busy || !globalState.loaded || !globalState.dirty) return;
  const pageSize = Number(ui.pageSize.value);
  const retentionDaysText = ui.retentionDays.value.trim();
  const retentionGbText = ui.retentionGb.value.trim();
  const retentionDays = Number(retentionDaysText);
  const retentionGb = Number(retentionGbText);
  const bytes = Math.round(retentionGb * GIB);
  if (
    !Number.isInteger(pageSize) ||
    !retentionDaysText ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 0 ||
    !retentionGbText ||
    !Number.isFinite(retentionGb) ||
    retentionGb < 0 ||
    !Number.isSafeInteger(bytes)
  ) {
    ui.globalMessage.textContent = "Save failed: check the page size, the non-negative integer retention days and the GB size cap.";
    return;
  }
  const payload = { jobs_page_size: pageSize, diag_retention_days: retentionDays, diag_max_total_bytes: bytes };
  globalState.busy = true;
  ui.globalMessage.textContent = "Saving…";
  updateGlobalControlState();
  let submitted = false;
  try {
    await api<GlobalSettingsView>("/api/global-settings", { method: "PUT", body: JSON.stringify(payload) });
    submitted = true;
    const refreshed = await api<GlobalSettingsView>("/api/global-settings");
    applyGlobalSettings(refreshed);
    await loadJobs(true);
    ui.globalMessage.textContent = "";
  } catch (error) {
    ui.globalMessage.textContent = (submitted ? "Settings were submitted, but re-reading failed: " : "Save failed: ") + errorMessage(error);
  } finally {
    globalState.busy = false;
    updateGlobalControlState();
  }
}

function appendBubble(role: "user" | "assistant", text: string, label?: string): void {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = label || (role === "user" ? "You" : "Assistant");
  const content = document.createElement("div");
  content.textContent = text;
  bubble.append(who, content);
  ui.conversation.appendChild(bubble);
}

/**
 * The compact display label of a proven approval outcome, or "" when the token
 * is absent/unknown.
 *
 * It reads ONLY the bounded canonical token (see jobs/approval.ts), never
 * prose. The compact status-line suffix uses it; the unavailable sub-causes
 * share one compact label there and the conversation notice names the exact
 * sub-cause.
 */
function approvalOutcomeStatusLabel(outcome: string): string {
  switch (outcome) {
    case "rejected": return "approval rejected";
    case "expired": return "approval expired";
    case "cancelled": return "approval cancelled";
    case "no_route":
    case "no_allow_option":
    case "publish_failed":
      return "approval unavailable";
    default: return "";
  }
}

/**
 * The ONE sentence of a proven approval outcome (see `terminalErrorNotice`).
 *
 * `completed` is true only for a job whose provider turn really completed: the
 * sentence then leads with the finished turn. On a failed run it leads with the
 * interruption itself. Both end by stating plainly that the gated operation did
 * not run: neither form claims the operation happened, and neither invents a
 * human decision the evidence does not prove.
 */
function approvalOutcomeNotice(outcome: string, provider: string, completed: boolean): string {
  // The gated operation did not run in BOTH forms; only the lead-in differs, so
  // a completed turn is never dressed up as a stopped one (or vice versa).
  const tail = "so that operation did not run";
  switch (outcome) {
    case "rejected":
      return completed
        ? `${provider} completed its turn after its approval request for a tool action was rejected, ${tail}.`
        : `${provider}'s approval request for a tool action was rejected, ${tail}.`;
    case "expired":
      return completed
        ? `${provider} completed its turn after an approval request expired before a decision, ${tail}.`
        : `${provider} stopped after an approval request expired before a decision was made, ${tail}.`;
    case "no_route":
      return completed
        ? `${provider} completed its turn without an interactive approval route, ${tail}.`
        : `No interactive approval route was available for ${provider}'s tool action, ${tail}.`;
    case "no_allow_option":
      return completed
        ? `${provider} completed its turn after an approval request that offered no approval option, ${tail}.`
        : `The approval request for ${provider}'s tool action offered no approval option, ${tail}.`;
    case "publish_failed":
      return completed
        ? `${provider} completed its turn after its approval request could not be published, ${tail}.`
        : `The approval request for ${provider}'s tool action could not be published, ${tail}.`;
    case "cancelled":
      return completed
        ? `${provider} completed its turn after its approval request was cancelled before a decision, ${tail}.`
        : `${provider}'s approval request was cancelled before a decision was made, ${tail}.`;
    default:
      return "";
  }
}

/**
 * The ONE display mapping of a terminal non-success job onto a short, plain
 * English conversation notice (JQ-20261001-22).
 *
 * It reads ONLY stable durable classification fields — `failure_kind`,
 * `stop_reason`, the bounded terminal result's own classification and the
 * bounded approval-outcome token — never the raw durable error text or CLI
 * stderr, so arbitrary output can never reach the UI. The notice is
 * presentation metadata, never assistant content: it is rendered as a notice,
 * not as an assistant bubble.
 *
 * A `done` job normally produces no notice, so a normal result-less completion
 * keeps the historical `No assistant result was recorded` line. The ONE
 * exception is a completed turn that durable evidence proves ended with an
 * unresolved approval interruption (the approval-outcome token, or the
 * provider's own `permission_denied` finish reason when no token was recorded):
 * it must explain that the gated operation did not run instead of reading as an
 * unqualified success. Provider refusal is matched BEFORE any rate-limit token,
 * so a refusal can never be presented as a rate limit (and rate-limit display
 * stays with the existing Rate limit/Fallback line).
 *
 * The bounded provider finish reason (JQ-20261001-23) refines ONLY the
 * refusal wording: `content_filter` says the provider content filter blocked
 * the response and `refusal` says the model explicitly refused. A record
 * without a finish reason (any historical refusal) keeps the generic refusal
 * wording exactly.
 *
 * The provider's bounded terminal error detail (JQ-20261001-24) is appended as
 * `Provider detail: …` to those refusal notices (and to the model-service
 * error notice) when durable state carries one. It is the provider boundary's
 * already-sanitized single-line diagnostic (`error_detail`): a refinement
 * only — it never selects or overrides the classification above.
 *
 * A declined interactive provider approval gate (JQ-20261001-25) is its own
 * cause: it is matched BEFORE the cancelled branch so the preserved
 * `stop_reason=cancelled` can never present it as a cancellation. The
 * approval-outcome token then splits the causes the gate actually proved: a
 * REAL rejection, an expiry, a missing/unofferable route or an abandoned wait.
 * Each is matched after the primary classifications (refusal / model error /
 * rate limit / cancellation / …) so rate-limit and cancellation evidence keeps
 * its precedence, and a rejection is never reported as the non-interactive
 * decline (or vice versa).
 */
function terminalErrorNotice(detail: JobDetail): string {
  const terminal = detail.status === "error" || detail.status === "cancelled" || detail.status === "interrupted";
  const provider = providerLabel(detail.provider);
  const run = detail.generation + 1;
  const result = detail.result ?? null;
  const codes = [detail.failure_kind, detail.stop_reason, result?.kind, result?.stop_reason]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const proves = (...candidates: string[]): boolean => candidates.some((candidate) => codes.includes(candidate));
  const finishReasons = [detail.finish_reason, result?.finish_reason]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const causedByFinishReason = (...candidates: string[]): boolean =>
    candidates.some((candidate) => finishReasons.includes(candidate));
  const providerDetail = [detail.error_detail, result?.error_detail]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const withDetail = (notice: string): string => (providerDetail ? `${notice} Provider detail: ${providerDetail}` : notice);
  const approvalOutcome = [detail.approval_outcome, result?.approval_outcome]
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;

  // A COMPLETED turn gets a notice only when durable evidence proves an
  // unresolved approval interruption: the canonical approval-outcome token, or
  // the provider's own denied-tool refinement when no token was recorded (a
  // record persisted before the token existed). Anything else keeps the
  // historical "done ⇒ no notice" behavior.
  const completedInterruption =
    detail.status === "done" && (approvalOutcome !== null || causedByFinishReason("permission_denied"));
  if (!terminal && !completedInterruption) return "";

  // Refusal is matched first, so a refusal attempt can never surface as a rate
  // limit.
  if (proves("provider_refusal", "refusal")) {
    if (causedByFinishReason("content_filter")) {
      return withDetail(`${provider} blocked this request with its content filter, so no assistant result was produced.`);
    }
    if (causedByFinishReason("refusal")) {
      return withDetail(`${provider} explicitly refused this request, so no assistant result was produced.`);
    }
    return withDetail(`${provider} refused this request, so no assistant result was produced.`);
  }
  // The provider's own model service ended the response with an error
  // (finish_reason=error); it is named specifically instead of collapsing to
  // the generic failure wording (JQ-20261001-24).
  if (proves("provider_model_error")) {
    return withDetail(`${provider}'s model service ended the run with an error, so no assistant result was produced.`);
  }
  // JQ-20261001-26: an interactive approval WAS published, but the deadline
  // passed before any decision was made and the bridge proved it. Distinct from
  // a declined gate (below) and from a cancellation.
  if (proves("provider_approval_expired")) {
    return `${provider} waited for an interactive approval that expired before a decision was made, so the run stopped.`;
  }
  // The approval request was REJECTED by a real human decision (the bridge's
  // own selected-reject answer). Matched before the declined-gate branch, whose
  // wording must keep naming only the no-interactive-route case.
  if (proves("provider_approval_rejected")) {
    return approvalOutcomeNotice("rejected", provider, false);
  }
  // JQ-20261001-25: WorkBuddy demanded an interactive approval for its own
  // high-risk/safety-sensitive tool gate and CrewDispatch, being non-interactive,
  // could only decline it. This is a permission interruption, NEVER a
  // cancellation — it is matched BEFORE the cancelled branch, which would
  // otherwise win on the preserved stop_reason=cancelled.
  if (proves("provider_permission_required")) {
    return `${provider} required approval for a high-risk/safety-sensitive tool action, and CrewDispatch is non-interactive, so the run stopped.`;
  }
  if (detail.status === "cancelled" || proves("provider_cancelled", "cancelled", "canceled")) {
    return `Run ${run} was cancelled before an assistant result was recorded.`;
  }
  if (detail.status === "interrupted" || proves("cli_interrupted")) {
    return `Run ${run} was interrupted before an assistant result was recorded.`;
  }
  if (proves("cli_rate_limited", "rate_limit", "rate_limit_without_session")) {
    return "The provider rate limit was reached, so no assistant result was produced.";
  }
  if (proves("cli_auth_error", "auth")) {
    return `${provider} could not authenticate this run, so no assistant result was produced.`;
  }
  if (proves("cli_permission_error", "permission")) {
    return `${provider} denied permission for this run, so no assistant result was produced.`;
  }
  if (proves("cli_quota_exhausted", "insufficient_credits")) {
    return `${provider} model credits are exhausted, so no assistant result was produced.`;
  }
  // Nothing in the primary classification proves a cause: a FINAL rate-limited
  // attempt is itself durable proof that the run ended on the rate limit. The
  // approval-outcome branch is deliberately BELOW this line: a rate limit keeps
  // its precedence over an approval interruption that happened beside it.
  if (lastAttempt?.rate_limited === true) {
    return "The provider rate limit was reached, so no assistant result was produced.";
  }
  // The turn's proven approval outcome: a real rejection, an expiry, a missing
  // or unofferable approval route, or an abandoned wait. Only a bounded token
  // reaches here — never prose — and the wording differs for a COMPLETED turn
  // (the provider still finished its turn; the gated operation did not run).
  if (approvalOutcome) {
    const notice = approvalOutcomeNotice(approvalOutcome, provider, detail.status === "done");
    if (notice) return notice;
  }
  // Durable evidence proves a denied tool approval but not WHY: a record
  // persisted before the approval-outcome token existed, or a provider-side
  // denial. Say exactly that — never a qualified success and never an invented
  // human decision.
  if (causedByFinishReason("permission_denied") || proves("permission_denied")) {
    return detail.status === "done"
      ? `${provider} completed its turn after a tool approval was denied, so the operation that required approval did not run.`
      : `${provider} stopped after a tool approval was denied, so the operation that required approval did not run.`;
  }
  return `Run ${run} ended with an error before an assistant result was recorded.`;
}

function userMessageBaseLabel(message: { generation: number; source?: string | null }, detail: JobDetail): string {
  const source = message.source ?? (message.generation === 0 ? detail.notify?.kind : null);
  switch (source) {
    case "codex":
    case "codex_thread": return "You / Codex";
    case "claude":
    case "claude_session": return "You / Claude";
    case "dashboard": return "You / Dashboard";
    case "callback": return "You / External caller";
    default: return "You";
  }
}

function renderConversation(detail: JobDetail): void {
  empty(ui.conversation);
  if (!detail.history_available) {
    message(ui.conversation, "The first-message history of this old session is unavailable; the current task text is never presented as the first message.", "notice");
  }
  const assistantByGeneration = new Map(detail.assistant_messages.map((m) => [m.generation, m]));
  for (const m of detail.user_messages) {
    const who = userMessageBaseLabel(m, detail);
    appendBubble("user", m.text, m.generation === 0 ? `${who} · first task` : `${who} · follow-up ${m.generation}`);
    const reply = assistantByGeneration.get(m.generation);
    if (reply) appendBubble("assistant", reply.text, `${providerLabel(detail.provider)} · response ${m.generation + 1}`);
  }
  if (detail.assistant_messages.length === 0 && detail.assistant_content) {
    message(ui.conversation, "Earlier assistant replies are unavailable for this older session; showing the latest recorded result.", "notice");
    appendBubble("assistant", detail.assistant_content, `${providerLabel(detail.provider)} · Latest result`);
  } else if (!detail.assistant_content && detail.user_messages.length) {
    if (isBusy(detail.status)) {
      message(ui.conversation, `${providerLabel(detail.provider)} is still working on Run ${detail.generation + 1}. The final response will appear when it finishes.`, "notice");
    } else {
      const terminalNotice = terminalErrorNotice(detail);
      message(
        ui.conversation,
        terminalNotice || `No assistant result was recorded for Run ${detail.generation + 1}.`,
        terminalNotice ? "notice" : "empty"
      );
    }
  } else if (!detail.user_messages.length && detail.history_available) {
    message(ui.conversation, "No messages yet.");
  }
  // A completed run that still has an assistant result normally shows no
  // notice, so a normal completion stays unannotated. The ONE exception is a
  // turn whose durable evidence proves an unresolved approval interruption
  // (the bounded approval-outcome token, or the provider's own denied-tool
  // refinement): the result is kept, but the notice explains that the gated
  // operation did not run instead of letting the turn read as an unqualified
  // success. Runs without assistant content render the notice in the branches
  // above instead.
  if (detail.assistant_content) {
    const terminalNotice = terminalErrorNotice(detail);
    if (terminalNotice) message(ui.conversation, terminalNotice, "notice");
  }
  // A terminal cause stays visible even when the first-message history side-car
  // is missing: the durable reason does not depend on the conversation history.
  if (!detail.assistant_content && !detail.user_messages.length && !detail.history_available) {
    const terminalNotice = terminalErrorNotice(detail);
    if (terminalNotice) message(ui.conversation, terminalNotice, "notice");
  }
  ui.conversation.scrollTop = ui.conversation.scrollHeight;
}

function formatMetric(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * THE ONE shared usage renderer of the Hub UI.
 *
 * It reads ONLY the canonical provider-neutral usage fields (JobUsage /
 * UsageSnapshot) and never branches on a provider id: the same canonical
 * payload renders identically for Command Code, WorkBuddy AI or any future
 * provider. A metric that was not reported stays absent (never "0").
 *
 * Context occupancy/window stay in the canonical telemetry (persistence,
 * API and MCP payloads keep serving them) but are intentionally NOT presented
 * in the Dashboard UI: no visible text and no hover title.
 */
function formatUsage(usage?: Json): { text: string; title: string } {
  if (!usage) return { text: "", title: "" };
  const input = typeof usage.tokensIn === "number" ? usage.tokensIn : null;
  const output = typeof usage.tokensOut === "number" ? usage.tokensOut : null;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : null;
  const cacheMiss = typeof usage.cacheMiss === "number" ? usage.cacheMiss : null;
  const cacheCreation = typeof usage.cacheCreation === "number" ? usage.cacheCreation : null;
  const toolCalls = typeof usage.toolCalls === "number" ? usage.toolCalls : null;
  const credits = typeof usage.credits === "number" ? usage.credits : null;
  const cost = typeof usage.totalCostUsd === "number" ? usage.totalCostUsd : null;
  // PAIRED decode metrics: both fields describe the same set of completed
  // provider responses under the canonical telemetry contract. The rate is rendered
  // ONLY when the paired numerator and denominator are both present and
  // positive; total tokensOut and lone decodeSeconds can never produce a
  // Decode line (no fallback to unpaired totals, no raw-seconds display).
  const decodeTokens = typeof usage.decodeTokens === "number" && usage.decodeTokens > 0 ? usage.decodeTokens : null;
  const decodeSeconds = typeof usage.decodeSeconds === "number" && usage.decodeSeconds > 0 ? usage.decodeSeconds : null;

  const parts: string[] = [];
  if (input != null) parts.push(`Input ${formatMetric(input)}`);
  if (output != null) parts.push(`Output ${formatMetric(output)}`);
  // Current canonical events carry cacheMiss when the provider proves the
  // input/cache relation. Older persisted WorkBuddy records predate that field
  // but still carry the same proven inclusive input + cache-read counters.
  // Use input only as a read-only legacy denominator when cacheMiss is absent;
  // never mutate/persist a synthetic miss count.
  const cacheTotal = cacheRead != null
    ? cacheMiss != null
      ? cacheRead + cacheMiss
      : input != null && input >= cacheRead
        ? input
        : null
    : null;
  if (cacheRead != null && cacheTotal != null && cacheTotal > 0) {
    parts.push(`Cache ${((cacheRead / cacheTotal) * 100).toFixed(1)}%`);
  }
  if (toolCalls != null) parts.push(`Tools ${formatMetric(toolCalls)}`);
  if (decodeTokens != null && decodeSeconds != null) {
    parts.push(`Decode ${(decodeTokens / decodeSeconds).toFixed(1)} tok/s`);
  }
  if (credits != null) parts.push(`Credits ${formatMetric(credits)}`);
  if (cost != null) parts.push(`Cost $${cost.toFixed(4)}`);

  const detail: string[] = [];
  if (cacheRead != null) detail.push(`cache hit ${formatMetric(cacheRead)}`);
  if (cacheMiss != null) detail.push(`cache miss ${formatMetric(cacheMiss)}`);
  if (cacheCreation != null) detail.push(`cache write ${formatMetric(cacheCreation)}`);
  if (decodeTokens != null && decodeSeconds != null) detail.push(`paired decode ${formatMetric(decodeTokens)} tokens / ${decodeSeconds.toFixed(2)}s`);
  return { text: parts.join(" · "), title: detail.join(" · ") };
}

/**
 * THE ONE deterministic compact duration formatter (pure, no clock access).
 * Floors to whole seconds so a value never rounds up past its unit boundary.
 * Examples: 8s · 2m 14s · 1h 03m · 1d 2h.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Provider-neutral session Runtime metric for the opened job view.
 *
 * Runtime is the wall-clock span of the WHOLE session — every follow-up
 * generation belongs to the same session — measured from `started_at`, which
 * CrewDispatch only sets on the queued → running transition, so queue wait is
 * never counted:
 *   - no started_at (queued / never started) → nothing is shown;
 *   - running/busy → now − started_at (recomputed on the existing refresh);
 *   - terminal → finished_at − started_at when finished_at exists, otherwise
 *     nothing is shown (no fabricated end time);
 *   - malformed timestamps or a negative span → omitted, never clamped into
 *     a misleading value.
 *
 * Pure over its inputs (no clock access), so the shipped function can be
 * exercised directly by the duration formatter tests.
 */
function runtimeText(
  status: string,
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
  nowMs: number
): string {
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(started)) return "";
  const terminal = ["done", "error", "cancelled", "interrupted"].includes(status);
  const busy = ["queued", "running", "orphaned"].includes(status);
  let endMs: number;
  if (terminal) {
    const finished = typeof finishedAt === "string" ? Date.parse(finishedAt) : NaN;
    if (!Number.isFinite(finished)) return "";
    endMs = finished;
  } else if (busy) {
    endMs = nowMs;
  } else {
    return "";
  }
  const span = endMs - started;
  if (span < 0) return "";
  return `Runtime ${formatDuration(span)}`;
}

function formatFallback(detail: JobDetail): string {
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  if (!attempts.some((a) => a.rate_limited === true)) return "";
  const models: string[] = [];
  for (const attempt of attempts) {
    if (!attempt.model) continue;
    if (models[models.length - 1] !== attempt.model) models.push(attempt.model);
  }
  if (models.length > 1) return `Fallback: ${models.join(" → ")}`;
  return models.length === 1 ? `Rate limit: ${models[0]}` : "Rate limit fallback attempted";
}

function isTerminal(status: string): boolean { return ["done", "error", "cancelled", "interrupted"].includes(status); }
function isBusy(status: string): boolean { return ["queued", "running", "orphaned"].includes(status); }

/** The normalized decision class of one provider-published option kind, or "". */
function approvalKindToken(option: ApprovalOptionView): string {
  const kind = typeof option.kind === "string" ? option.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (kind === "allow_once" || kind === "allow_always") return kind;
  // A provider may publish BOTH a one-time and a persistent rejection (the
  // Command Code ACP CLI publishes reject_once and reject_always side by side);
  // collapsing them to one class would render two different provider options
  // with the same label, so the persistent rejection keeps its own class.
  if (kind === "reject_always") return "reject_always";
  if (kind === "reject_once" || kind === "reject" || kind === "deny" || kind === "deny_once") return "reject_once";
  return "";
}

/**
 * The display label of ONE provider-published approval option.
 *
 * The provider's own sanitized label IS the meaning of a choice, so it is
 * preferred for every option — including the four recognised kinds. A planning
 * question may publish several same-kind options whose labels differ (three
 * `allow_once` choices with different scope statements, as observed on the
 * Command Code ACP wire); replacing those labels with one canonical phrase
 * would render the choices indistinguishable even though the submitted option
 * ids differ. The readable canonical-kind wording is therefore only a FALLBACK
 * for an option whose label carries no usable display text — the durable
 * normalization substitutes the option id when the provider published no label
 * — and an unknown kind keeps the provider's own label/id fallback. The value
 * sent back is always the provider's own option id; the canonical kind still
 * drives styling and reply semantics.
 */
function approvalOptionLabel(option: ApprovalOptionView): string {
  const kind = approvalKindToken(option);
  const canonical =
    kind === "allow_once" ? "Allow once"
    : kind === "allow_always" ? "Always allow"
    : kind === "reject_once" ? "Reject"
    : kind === "reject_always" ? "Always reject"
    : "";
  const label = typeof option.label === "string" ? option.label.trim() : "";
  const id = typeof option.id === "string" ? option.id.trim() : "";
  // A label equal to the option id is the durable boundary's substitution for
  // a missing/unsafe provider label, not meaningful display text.
  if (label && label !== id) return label;
  return canonical || label || id || "Option";
}

function approvalOptionClass(option: ApprovalOptionView): string {
  const kind = approvalKindToken(option);
  if (kind === "allow_once") return "button primary";
  if (kind === "reject_once" || kind === "reject_always") return "button danger";
  return "button";
}

/**
 * Render the operation detail of a pending approval as PLAIN TEXT.
 *
 * Every value comes from the bounded, already-credential-redacted durable
 * record and is assigned with `textContent` only, so a provider can never inject
 * markup or script. The actual command (when published) is preferred over the
 * provider's paraphrase; the block is height-bounded and scrollable, so a very
 * long command can never push the decision buttons out of reach. When the
 * provider published nothing usable, the card says so explicitly instead of
 * showing an empty box.
 */
function approvalDetailNode(pending: PendingApprovalView): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "approval-op";
  const detail = pending.detail && typeof pending.detail === "object" ? pending.detail : null;
  const text = (value: unknown): string => (typeof value === "string" && value.trim() ? value.trim() : "");
  const command = text(detail?.command);
  // The provider's separately supplied argv, one entry per argument. Rendered
  // as its own block per argument so an argument's whitespace survives and the
  // boundaries are structural — the UI never invents a joined shell command.
  // An EMPTY entry is real argv data and is kept (never filtered out); it is
  // shown as an explicit notation because an empty box would be unreadable.
  const args = Array.isArray(detail?.args) ? detail.args.filter((arg): arg is string => typeof arg === "string") : [];
  const description = text(detail?.description);
  const path = text(detail?.path);
  const cwd = text(detail?.cwd);
  const title = text(detail?.title);
  const gate = text(detail?.gate);
  const reason = text(detail?.reason);
  if (!command && !args.length && !description && !path && !cwd && !title && !gate && !reason) {
    const note = document.createElement("p");
    note.className = "approval-op-missing";
    note.textContent = "Operation details were not provided by the provider.";
    wrap.appendChild(note);
    return wrap;
  }
  const addRow = (label: string, value: string, code: boolean): void => {
    const row = document.createElement("div");
    row.className = "approval-op-row";
    const name = document.createElement("span");
    name.className = "approval-op-label";
    name.textContent = label;
    const body = document.createElement(code ? "pre" : "span");
    body.className = code ? "approval-op-code" : "approval-op-value";
    body.textContent = value;
    row.append(name, body);
    wrap.appendChild(row);
  };
  if (command) addRow("Command", command, true);
  if (args.length) {
    const row = document.createElement("div");
    row.className = "approval-op-row";
    const name = document.createElement("span");
    name.className = "approval-op-label";
    name.textContent = args.length === 1 ? "Argument" : "Arguments";
    const body = document.createElement("div");
    body.className = "approval-op-args";
    for (const arg of args) {
      const item = document.createElement("pre");
      item.className = "approval-op-code";
      if (arg.length === 0) {
        // Display notation for a real, known EMPTY argument: an empty box would
        // hide that the argv position exists at all.
        item.classList.add("approval-op-empty");
        item.textContent = "(empty argument)";
      } else {
        item.textContent = arg;
      }
      body.appendChild(item);
    }
    row.append(name, body);
    wrap.appendChild(row);
  }
  if (description) addRow("Description", description, false);
  if (path) addRow("Path", path, true);
  if (cwd) addRow("Working directory", cwd, true);
  // The title is a fallback only: it adds nothing beside a real command.
  if (!command && !description && title) addRow("Operation", title, false);
  // The provider's OWN gate/reason tokens, shown only when it actually
  // published them on the wire — never a guessed risk classification.
  if (gate) addRow("Gate", gate, false);
  if (reason) addRow("Reason", reason, false);
  const marks: string[] = [];
  if (detail?.truncated) marks.push("the text was shortened to fit the display limit");
  if (detail?.redacted) marks.push("obvious credentials were redacted");
  if (marks.length) {
    const note = document.createElement("p");
    note.className = "approval-op-note";
    note.textContent = `Note: ${marks.join("; ")}.`;
    wrap.appendChild(note);
  }
  return wrap;
}

/**
 * Render the provider-neutral approval card of the OPEN session.
 *
 * The card is visible only while the polled detail carries a bounded
 * `pending_approval`. Buttons are rebuilt only when the request identity
 * changes (so the 2.5s refresh cannot drop focus or re-enable a submitted
 * choice), and they are disabled IMMEDIATELY once this tab submits a decision.
 * A stale card — another tab resolved it, the request expired, the job left
 * `running` — disappears on the next poll instead of staying clickable.
 */
function renderApproval(detail: JobDetail): void {
  const pending = detail.status === "running" ? detail.pending_approval ?? null : null;
  const requestId = pending && typeof pending.request_id === "string" ? pending.request_id : "";
  if (!pending || !requestId) {
    ui.approvalCard.classList.add("hidden");
    ui.approvalCard.classList.remove("resolved");
    if (state.approvalRenderKey) {
      state.approvalRenderKey = "";
      state.approvalSubmit = null;
      empty(ui.approvalActions);
    }
    return;
  }
  const generation = typeof pending.generation === "number" ? pending.generation : detail.generation;
  const options = Array.isArray(pending.options)
    ? pending.options.filter((option): option is ApprovalOptionView => !!option && typeof option.id === "string" && !!option.id)
    : [];
  const submitted = state.approvalSubmit && state.approvalSubmit.jobId === detail.job_id && state.approvalSubmit.requestId === requestId && state.approvalSubmit.generation === generation
    ? state.approvalSubmit
    : null;
  if (!submitted) state.approvalSubmit = null;
  const expires = Date.parse(pending.expires_at ?? "");
  const expired = !Number.isFinite(expires) || expires <= Date.now();
  const chosen = submitted ? options.find((option) => option.id === submitted.optionId) : null;
  const tool = typeof pending.tool_name === "string" && pending.tool_name.trim() ? pending.tool_name.trim() : "a tool action";
  ui.approvalCard.classList.remove("hidden");
  ui.approvalCard.classList.toggle("resolved", submitted !== null);
  ui.approvalTitle.textContent = submitted ? "Decision sent" : expired ? "Approval expired" : `Approval required: ${tool}`;
  ui.approvalMeta.textContent = `${providerLabel(detail.provider)} · Run ${generation + 1} · ${detail.job_id}`;
  // The dedicated identity area: the task display name (bounded) PLUS the
  // durable job id and provider/run on their own readable line, so two similar
  // or clipped task titles can never be mistaken for one another.
  ui.approvalIdentity.textContent = detail.task?.split("\n")[0]?.trim().slice(0, 160) || titleFor(detail);
  ui.approvalTaskJob.textContent = `Job ${detail.job_id}`;
  ui.approvalTaskProvider.textContent = `${providerLabel(detail.provider)} · Run ${generation + 1}`;
  empty(ui.approvalDetail);
  if (submitted) {
    const line = document.createElement("p");
    line.className = "approval-detail-line";
    line.textContent = `${chosen ? approvalOptionLabel(chosen) : submitted.optionId} was submitted; waiting for the provider to continue this run.`;
    ui.approvalDetail.appendChild(line);
  } else {
    const intro = document.createElement("p");
    intro.className = "approval-detail-line";
    intro.textContent = expired
      ? "The approval deadline has passed. This request can no longer be answered."
      : `Waiting for your decision · Expires in ${Math.max(1, Math.ceil((expires - Date.now()) / 1000))} seconds.`;
    ui.approvalDetail.appendChild(intro);
    ui.approvalDetail.appendChild(approvalDetailNode(pending));
  }
  const key = `${detail.job_id}|${requestId}|${generation}|${options.map((option) => option.id).join(",")}`;
  if (state.approvalRenderKey !== key) {
    state.approvalRenderKey = key;
    empty(ui.approvalActions);
    if (!options.length) {
      message(ui.approvalActions, "The provider published no selectable options.", "approval-detail");
    } else {
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = approvalOptionClass(option);
        button.textContent = approvalOptionLabel(option);
        button.dataset.optionId = option.id;
        button.addEventListener("click", () => { void resolveApproval(pending, option); });
        ui.approvalActions.appendChild(button);
      }
    }
  }
  // Applied on EVERY render: a submitted decision stays visibly disabled even
  // when the polled detail arrives again before the provider consumes it.
  for (const node of Array.from(ui.approvalActions.querySelectorAll<HTMLButtonElement>("button"))) {
    node.disabled = submitted !== null || expired;
  }
}

/**
 * Send ONE decision for the CURRENT pending approval. The chosen value is the
 * provider's own option id; the Hub claims it exactly once, and any duplicate
 * or stale answer comes back as a stable already-resolved/stale result.
 */
async function resolveApproval(pending: PendingApprovalView, option: ApprovalOptionView): Promise<void> {
  const id = pending.job_id;
  const requestId = typeof pending.request_id === "string" ? pending.request_id : "";
  if (!id || id !== state.openId || !state.detail || state.detail.job_id !== id || state.approvalSubmit || !requestId || typeof option.id !== "string" || !option.id) return;
  if (!(Date.parse(pending.expires_at ?? "") > Date.now())) return;
  const generation = typeof pending.generation === "number" ? pending.generation : state.detail.generation;
  const submission = { jobId: id, requestId, generation, optionId: option.id };
  state.approvalSubmit = submission;
  // Disable/replace the buttons IMMEDIATELY: a stale double click must never
  // send two decisions.
  renderApproval(state.detail);
  try {
    const result = await api<{ status: string }>(`/api/jobs/${encodeURIComponent(id)}/approval`, {
      method: "POST",
      body: JSON.stringify({ generation, request_id: requestId, option_id: option.id })
    });
    if (state.openId === id) setStatus(result.status === "already_resolved"
      ? "This approval was already resolved."
      : `Approval submitted: ${approvalOptionLabel(option)}`);
  } catch (error) {
    if (state.approvalSubmit === submission) {
      setStatus(`Approval failed: ${String(error)}`, true);
      state.approvalSubmit = null;
      state.approvalRenderKey = "";
    }
  }
  // Refresh only the CURRENT selection and the global list. The open task is
  // intentionally retained: answering one approval never selects another job,
  // and a later request of this same job appears through the normal refresh.
  await Promise.all([refreshOpenJob(), refreshJobsList()]);
}

function renderDetail(detail: JobDetail, forceConversation = false): void {
  state.detail = detail;
  const summary = state.jobs.find((job) => job.job_id === detail.job_id);
  let listChanged = false;
  if (summary && (summary.status !== detail.status || summary.generation !== detail.generation || summary.model !== detail.model || (summary.finished_at ?? null) !== (detail.finished_at ?? null))) {
    summary.status = detail.status;
    summary.generation = detail.generation;
    summary.model = detail.model;
    summary.finished_at = detail.finished_at;
    listChanged = true;
  }
  // Successfully rendering the detail of a terminal result is what marks its
  // CURRENT revision read: an open job never shows an unread dot for a result
  // the user is already looking at (a failed refresh marks nothing).
  const revision = terminalRevision(detail);
  if (revision !== null && markRevisionRead(detail.job_id, revision)) listChanged = true;
  if (listChanged) renderJobs();
  const title = detail.task?.split("\n")[0]?.trim() || titleFor(detail);
  ui.title.textContent = title;
  // The compact approval-cause suffix: a proven approval outcome stays visible
  // in the status area too, so a completed turn whose gated operation did not
  // run is never presented as an unqualified success even when its assistant
  // text is shown below. Only the bounded token is read — never prose.
  const approvalCause = approvalOutcomeStatusLabel(
    [detail.approval_outcome, detail.result?.approval_outcome]
      .find((value): value is string => typeof value === "string" && value.length > 0) ?? ""
  );
  ui.status.textContent = `Status: ${detail.status} · Run ${detail.generation + 1}${approvalCause ? ` · ${approvalCause}` : ""}`;
  // The running Runtime value advances on the existing refresh cadence: this
  // render runs from the 2.5s Hub refresh, so no extra timer/poll loop exists.
  ui.runtime.textContent = runtimeText(detail.status, detail.started_at, detail.finished_at, Date.now());
  ui.provider.textContent = `Provider: ${providerLabel(detail.provider)}`;
  ui.model.textContent = detail.model ? `Model: ${detail.model}` : "Model: not reported by the CLI";
  ui.jobEffort.textContent = detail.effort ? `Reasoning: ${detail.effort}` : "";
  ui.fallback.textContent = formatFallback(detail);
  const usage = formatUsage(detail.usage);
  ui.usage.textContent = usage.text;
  ui.usage.title = usage.title;
  const terminal = isTerminal(detail.status);
  const busy = isBusy(detail.status);
  ui.cancel.classList.toggle("hidden", !busy);
  renderApproval(detail);

  // Keep the follow-up composer visible while a run is active so the
  // user can see that conversation will continue here, but disable submission
  // until the current provider turn is terminal. This is clearer than making
  // the composer disappear and avoids concurrent follow-ups to one session.
  ui.composer.classList.remove("hidden");
  ui.followupText.disabled = !terminal;
  ui.sendFollowup.disabled = !terminal;
  ui.followupText.placeholder = terminal
    ? "Send a follow-up message to the same task…"
    : `Run ${detail.generation + 1} is running; follow-up will be available when it finishes.`;

  // Live activity is part of every opened task, including running follow-up
  // runs. Defensively remove stale hidden state when switching/reloading
  // a session so the log panel never disappears with the composer state.
  ui.splitter.classList.remove("hidden");
  ui.live.classList.remove("hidden");

  const result = detail.assistant_content || "";
  const notice = terminalErrorNotice(detail);
  // The conversation re-renders whenever its visible outcome changes: the
  // assistant text, the generation, the terminal-error notice, or the status
  // transition itself (a still-working Run 1 must not keep saying it is
  // working after it has ended without a result).
  const conversationKey = `${detail.status}|${detail.generation}|${result}|${notice}`;
  if (forceConversation || state.lastConversationKey !== conversationKey) renderConversation(detail);
  state.lastConversationKey = conversationKey;
}

function previewValue(value: unknown, max = 1200): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== undefined) {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  text = text.trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is Json => !!item && typeof item === "object")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function usageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const usage = value as Json;
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number") parts.push(`in ${usage.inputTokens}`);
  if (typeof usage.outputTokens === "number") parts.push(`out ${usage.outputTokens}`);
  if (typeof usage.cacheReadTokens === "number") parts.push(`cache ${usage.cacheReadTokens}`);
  if (typeof usage.cacheWriteTokens === "number" && usage.cacheWriteTokens) parts.push(`cache-write ${usage.cacheWriteTokens}`);
  return parts.join(" · ");
}

/**
 * The bounded terminal reason of a NON-SUCCESS log result record for the
 * compact activity row (JQ-20261001-22): the provider's own stop reason when
 * present, else the stable error code. Success records are untouched, and raw
 * output is never included.
 */
function terminalResultReason(rec: Json): string {
  if (rec.subtype !== "error" && rec.is_error !== true) return "";
  const stop = typeof rec.stop_reason === "string" ? rec.stop_reason.trim() : "";
  if (stop) return stop;
  const error = rec.error && typeof rec.error === "object" ? rec.error as Json : null;
  return error && typeof error.code === "string" ? error.code.trim() : "";
}

function describeRecord(rec: Json): string {
  const type = typeof rec.type === "string" ? rec.type : "record";
  if (type === "result") {
    const result = rec.result;
    const value = typeof result === "string" ? result : typeof rec.subtype === "string" ? rec.subtype : "(no value)";
    const reason = terminalResultReason(rec);
    return `Result · ${previewValue(value)}${reason ? ` · ${reason}` : ""}`;
  }
  if (type === "assistant") {
    const msg = rec.message as Json | undefined;
    const text = contentText(msg?.content) || (typeof rec.content === "string" ? rec.content : "");
    if (text) return `Assistant · ${previewValue(text)}`;
  }
  // The provider-neutral interactive-approval record (jobs/approval.ts): only
  // the bounded tool name and the resolved decision are ever shown — never the
  // request payload.
  if (type === "approval") {
    const phase = typeof rec.phase === "string" ? rec.phase : "";
    const approval = rec.approval && typeof rec.approval === "object" ? rec.approval as Json : null;
    if (phase === "pending") {
      const tool = approval && typeof approval.tool_name === "string" && approval.tool_name ? approval.tool_name : "a tool action";
      return `Approval · ${tool} · waiting for a decision`;
    }
    return `Approval · ${typeof rec.decision === "string" ? rec.decision : "resolved"}`;
  }
  if (type === "event") {
    const event = rec.event as Json | undefined;
    const eventType = typeof event?.type === "string" ? event.type : "running";
    if (!event) return `Event · ${eventType}`;
    if (eventType === "run_start") return `Run started${typeof event.sessionId === "string" ? ` · ${event.sessionId}` : ""}`;
    if (eventType === "run_end") {
      const result = event.result && typeof event.result === "object" ? event.result as Json : undefined;
      const stop = typeof result?.stopReason === "string" ? result.stopReason : "";
      const turns = typeof result?.turnCount === "number" ? ` · turns ${result.turnCount}` : "";
      return `Run finished${stop ? ` · ${stop}` : ""}${turns}`;
    }
    if (eventType === "turn_start") return `Turn ${typeof event.turnNumber === "number" ? event.turnNumber : "?"} · started`;
    if (eventType === "turn_end") {
      const usage = usageText(event.usage);
      return `Turn ${typeof event.turnNumber === "number" ? event.turnNumber : "?"} · ended${usage ? ` · ${usage}` : ""}`;
    }
    if (eventType === "model_request_start") return `Model request · ${typeof event.model === "string" ? event.model : "unknown model"}`;
    if (eventType === "model_request_end") {
      const usage = usageText(event.usage);
      const stop = typeof event.stopReason === "string" ? event.stopReason : "";
      return `Model response · ${typeof event.model === "string" ? event.model : "unknown model"}${stop ? ` · ${stop}` : ""}${usage ? ` · ${usage}` : ""}`;
    }
    if (eventType === "thinking_end") return "Reasoning block complete";
    if (eventType === "message_end") {
      const text = contentText(event.content);
      return text ? `Assistant · ${previewValue(text)}` : "Assistant message complete";
    }
    if (eventType === "tool_queued") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const input = previewValue(event.input, 900);
      return `Tool queued · ${name}${input ? ` · ${input}` : ""}`;
    }
    if (eventType === "tool_running") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      return `Tool running · ${name}`;
    }
    if (eventType === "tool_update") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const partial = Array.isArray(event.partial) ? contentText(event.partial) : previewValue(event.partial, 900);
      return `Tool update · ${name}${partial ? ` · ${previewValue(partial, 900)}` : ""}`;
    }
    if (eventType === "tool_completed") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const result = Array.isArray(event.result) ? contentText(event.result) : previewValue(event.result, 1200);
      // `status` is the shared vocabulary's optional completion outcome; a
      // provider that reports a failed tool is shown as failed, not completed.
      const label = typeof event.status === "string" && event.status.toLowerCase() === "failed" ? "Tool failed" : "Tool completed";
      return `${label} · ${name}${result ? ` · ${previewValue(result)}` : ""}`;
    }
    if (eventType === "tool_hook_blocked") {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const reason = typeof event.hookOutput === "string" ? event.hookOutput : "";
      return `Tool blocked · ${name}${reason ? ` · ${previewValue(reason)}` : ""}`;
    }
    if (eventType === "model_trace") return `Model trace · ${typeof event.traceId === "string" ? event.traceId : "recorded"}`;
    return `Event · ${eventType}`;
  }
  return type;
}

function appendLogEntry(entry: LogEntry): void {
  const line = document.createElement("div");
  line.className = "log-entry";
  if (entry.data) line.textContent = describeRecord(entry.data);
  else if (entry.error) line.textContent = `Diagnostic · ${entry.error}`;
  else if (entry.unparsed) line.textContent = "Diagnostic · unparsed CLI output hidden";
  else line.textContent = "Record";
  ui.log.appendChild(line);
  if (ui.showReasoning.checked && Array.isArray(entry.reasoning)) {
    for (const value of entry.reasoning) {
      const reason = document.createElement("div");
      reason.className = "log-entry reason";
      reason.textContent = `Reasoning · ${typeof value === "string" ? value : JSON.stringify(value)}`;
      ui.log.appendChild(reason);
    }
  }
  while (ui.log.children.length > 1000) ui.log.firstChild?.remove();
}

/**
 * A provider process can disappear between tool_running and tool_completed
 * (host crash/restart is the important case). The durable log must remain
 * append-only, but the live UI must not claim forever that a dead tool is still
 * running once the job itself is known orphaned/terminal.
 */
function settleVisibleToolRows(status: string | null | undefined): void {
  if (!status) return;
  const orphaned = status === "orphaned";
  const terminal = isTerminal(status);
  if (!orphaned && !terminal) return;
  const replacement = orphaned ? "Tool stalled ·" : "Tool interrupted ·";
  for (const node of Array.from(ui.log.querySelectorAll<HTMLElement>(".log-entry"))) {
    const text = node.textContent ?? "";
    if (!text.startsWith("Tool running ·")) continue;
    node.textContent = replacement + text.slice("Tool running ·".length);
  }
}

async function loadLog(): Promise<void> {
  if (!state.openId || state.logBusy) return;
  state.logBusy = true;
  const id = state.openId;
  try {
    const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 44;
    let sawEntry = false;
    let addedEntries = 0;
    ui.liveStatus.textContent = "Loading…";
    // Compact activity mode skips token/snapshot noise server-side. Read a bounded
    // handful of local pages per refresh so an existing large transcript catches
    // up quickly without turning one browser tick into an unbounded disk scan.
    for (let page = 0; page < 8; page += 1) {
      const before = state.logCursor;
      const batch = await api<LogBatch>(`/api/jobs/${encodeURIComponent(id)}/log?cursor=${encodeURIComponent(before)}&limit=200&activity=1&scope=current&include_reasoning=${ui.showReasoning.checked}`);
      if (state.openId !== id) return;
      if (batch.cursor_error) {
        state.logCursor = "0";
        empty(ui.log);
        message(ui.log, `Log cursor was reset: ${batch.cursor_error}`, "log-entry");
        return;
      }
      if (before === "0" && !ui.log.querySelector(".log-entry")) empty(ui.log);
      for (const entry of batch.entries) appendLogEntry(entry);
      addedEntries += batch.entries.length;
      sawEntry ||= batch.entries.length > 0;
      state.logCursor = batch.cursor;
      if (batch.drained || batch.pending || batch.cursor === before) break;
    }
    settleVisibleToolRows(state.detail?.status);
    if (!sawEntry && !ui.log.children.length) message(ui.log, "No log entries yet");
    const visibleEntries = ui.log.querySelectorAll(".log-entry").length;
    ui.liveStatus.textContent = visibleEntries > 0
      ? `${visibleEntries} event${visibleEntries === 1 ? "" : "s"}${state.detail && isBusy(state.detail.status) ? " · live" : ""}`
      : (addedEntries > 0 ? `${addedEntries} events loaded` : "No events yet");
    if (ui.autoFollow.checked && nearBottom) ui.log.scrollTop = ui.log.scrollHeight;
  } catch (error) {
    ui.liveStatus.textContent = "Log error";
    setStatus(`Failed to read log: ${String(error)}`, true);
  } finally { state.logBusy = false; }
}

/**
 * The ONE Dashboard deep link an approval notification carries:
 * `/ui?job=<id>&generation=<n>&request=<id>`. Only the job id selects a
 * session (it works even when that job is beyond the loaded page); the
 * optional generation/request identify the approval the link was built for so
 * the page can say honestly when that request is no longer pending. A GET never
 * submits a decision, never auto-approves and never changes focus beyond
 * opening the exact job.
 */
function approvalDeepLink(): { jobId: string; generation: number | null; requestId: string | null } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const jobId = (params.get("job") ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId) || jobId.includes("..")) return null;
    const generationRaw = (params.get("generation") ?? "").trim();
    const generation = /^\d{1,9}$/.test(generationRaw) ? Number(generationRaw) : null;
    const requestId = (params.get("request") ?? "").trim();
    return { jobId, generation, requestId: requestId || null };
  } catch {
    return null;
  }
}

async function openJob(id: string): Promise<void> {
  state.openId = id;
  state.logCursor = "0";
  state.lastConversationKey = "";
  // The previous session's approval card/decision must never bleed into the
  // newly opened one; the fresh detail re-renders it from scratch.
  state.approvalSubmit = null;
  state.approvalRenderKey = "";
  empty(ui.approvalActions);
  ui.approvalCard.classList.add("hidden");
  ui.approvalCard.classList.remove("resolved");
  empty(ui.log);
  ui.liveStatus.textContent = "Loading…";
  message(ui.log, "Reading log…");
  renderJobs();
  showView("jobs");
  try {
    const detail = await api<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
    if (state.openId !== id) return;
    renderDetail(detail, true);
    setStatus(`Opened ${id}`);
    await loadLog();
  } catch (error) { setStatus(`Failed to open task: ${String(error)}`, true); }
}

async function refreshOpenJob(): Promise<void> {
  if (!state.openId || state.view !== "jobs") return;
  const id = state.openId;
  try {
    const detail = await api<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`);
    if (state.openId !== id) return;
    renderDetail(detail);
    await loadLog();
  } catch (error) { setStatus(`Failed to refresh task: ${String(error)}`, true); }
}

async function cancelOpenJob(): Promise<void> {
  if (!state.openId || !state.detail || !isBusy(state.detail.status)) return;
  ui.cancel.disabled = true;
  try {
    const result = await api<{ status: string }>(`/api/jobs/${encodeURIComponent(state.openId)}/cancel`, { method: "POST", body: "{}" });
    setStatus(`Cancel request result: ${result.status}`);
    await refreshOpenJob();
  } catch (error) { setStatus(`Cancel failed: ${String(error)}`, true); }
  finally { ui.cancel.disabled = false; }
}

async function sendFollowup(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const id = state.openId;
  const messageText = ui.followupText.value.trim();
  if (!id || !state.detail || !isTerminal(state.detail.status) || !messageText) return;
  ui.sendFollowup.disabled = true;
  try {
    const accepted = await api<{ job_id: string; generation: number }>(`/api/jobs/${encodeURIComponent(id)}/follow-up`, { method: "POST", body: JSON.stringify({ message: messageText }) });
    ui.followupText.value = "";
    setStatus(`Follow-up added to the same task: Run ${accepted.generation + 1}`);
    await refreshOpenJob();
    await loadJobs(true);
  } catch (error) { setStatus(`Send failed: ${String(error)}`, true); }
  finally { ui.sendFollowup.disabled = false; }
}

function showView(view: "jobs" | "settings"): void {
  state.view = view;
  ui.consoleView.classList.toggle("hidden", view !== "jobs");
  ui.settingsView.classList.toggle("hidden", view !== "settings");
  ui.navJobs.setAttribute("aria-selected", String(view === "jobs"));
  ui.navSettings.setAttribute("aria-selected", String(view === "settings"));
}

function installSplitter(): void {
  let startY = 0;
  let startHeight = 0;
  ui.splitter.addEventListener("pointerdown", (event) => {
    startY = event.clientY;
    startHeight = ui.live.getBoundingClientRect().height;
    ui.splitter.setPointerCapture(event.pointerId);
  });
  ui.splitter.addEventListener("pointermove", (event) => {
    if (!ui.splitter.hasPointerCapture(event.pointerId)) return;
    const max = Math.max(100, Math.min(window.innerHeight * .65, window.innerHeight - 230));
    ui.live.style.height = `${Math.max(100, Math.min(max, startHeight + startY - event.clientY))}px`;
  });
  ui.splitter.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current = ui.live.getBoundingClientRect().height;
    ui.live.style.height = `${Math.max(100, Math.min(window.innerHeight * .65, current + (event.key === "ArrowUp" ? 20 : -20)))}px`;
  });
}

ui.refreshJobs.addEventListener("click", () => { void loadJobs(true); });
ui.loadMore.addEventListener("click", () => { void loadJobs(false); });
ui.navJobs.addEventListener("click", () => showView("jobs"));
ui.navSettings.addEventListener("click", () => {
  const entering = state.view !== "settings";
  showView("settings");
  if (entering) {
    renderSelectedProviderSettings();
    // Refresh in the background. If this provider was already read, the existing
    // form stays visible and interactive while the new read runs.
    loadSelectedProviderSettings();
    void loadGlobalSettings(true);
  }
});
ui.settingsProvider.addEventListener("change", () => {
  const value = ui.settingsProvider.value as SettingsProvider;
  selectedSettingsProvider = value === "workbuddy-ai" ? value : "command-code";
  renderSelectedProviderSettings();
  // Refresh in the background without blanking an already-known provider form.
  loadSelectedProviderSettings();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshWorkBuddyPromotionIfDue();
});
window.addEventListener("focus", refreshWorkBuddyPromotionIfDue);
window.addEventListener("pageshow", refreshWorkBuddyPromotionIfDue);
window.setInterval(refreshWorkBuddyPromotionIfDue, 60_000);
ui.permissionMode.addEventListener("change", () => {
  const view = settingsState.view;
  if (view && settingsState.draft && view.capabilities.permission_modes.includes(ui.permissionMode.value)) {
    settingsState.draft.permission_mode = ui.permissionMode.value;
  }
  if (settingsState.draft) renderPermissionNote(ui.yoloWarning, "command-code", settingsState.draft.permission_mode);
  markSettingsDirty();
});
ui.defaultEffort.addEventListener("change", () => {
  if (settingsState.view?.capabilities.supports_effort && settingsState.draft) {
    settingsState.draft.default_effort = ui.defaultEffort.value || null;
    markSettingsDirty();
  }
});
ui.fallbackEffort.addEventListener("change", () => {
  if (settingsState.view?.capabilities.supports_effort && settingsState.draft) {
    settingsState.draft.rate_limit_fallback_effort = ui.fallbackEffort.value || null;
    markSettingsDirty();
  }
});
ui.defaultModel.addEventListener("change", () => {
  const view = settingsState.view;
  const draft = settingsState.draft;
  if (draft) {
    draft.default_model = ui.defaultModel.value || null;
    // Changing THIS selection's model resets ONLY its own effort: an effort
    // saved for the previous model is never carried onto the new one. The
    // fallback model's effort is untouched.
    draft.default_effort = scopedSavedEffort(
      view?.config.default_model ?? view?.catalog.default_model ?? null,
      view?.config.default_effort ?? null,
      draft.default_model,
      commandCodeEffortSupportedByModel
    );
  }
  // Reasoning follows the newly selected model IMMEDIATELY, from the metadata
  // already on screen — no provider read and no CLI probe is triggered here.
  fillCommandCodeEfforts();
  markSettingsDirty();
});
ui.fallbackModel.addEventListener("change", () => {
  const view = settingsState.view;
  const draft = settingsState.draft;
  if (draft) {
    draft.rate_limit_fallback_model = ui.fallbackModel.value || null;
    draft.rate_limit_fallback_effort = scopedSavedEffort(
      view?.config.rate_limit_fallback_model ?? null,
      view?.config.rate_limit_fallback_effort ?? null,
      draft.rate_limit_fallback_model,
      commandCodeEffortSupportedByModel
    );
  }
  fillCommandCodeEfforts();
  markSettingsDirty();
});
ui.wbPermissionMode.addEventListener("change", () => {
  const view = workBuddySettingsState.view;
  if (view && workBuddySettingsState.draft && view.capabilities.permission_modes.includes(ui.wbPermissionMode.value)) {
    workBuddySettingsState.draft.permission_mode = ui.wbPermissionMode.value;
  }
  if (workBuddySettingsState.draft) renderPermissionNote(ui.wbYoloWarning, "workbuddy-ai", workBuddySettingsState.draft.permission_mode);
  markWorkBuddySettingsDirty();
});
ui.wbDefaultEffort.addEventListener("change", () => {
  const draft = workBuddySettingsState.draft;
  if (draft && workBuddyEffortControlsActive(ui.wbDefaultModel.value || draft.default_model)) {
    draft.default_effort = ui.wbDefaultEffort.value || null;
    // Re-render so an honest reset notice disappears as soon as the user picks
    // a value the selected model supports.
    renderWorkBuddySettings();
    markWorkBuddySettingsDirty();
  }
});
ui.wbFallbackEffort.addEventListener("change", () => {
  const draft = workBuddySettingsState.draft;
  if (draft && workBuddyEffortControlsActive(ui.wbFallbackModel.value || draft.rate_limit_fallback_model)) {
    draft.rate_limit_fallback_effort = ui.wbFallbackEffort.value || null;
    renderWorkBuddySettings();
    markWorkBuddySettingsDirty();
  }
});
ui.wbDefaultModel.addEventListener("change", () => {
  const view = workBuddySettingsState.view;
  const draft = workBuddySettingsState.draft;
  if (draft) {
    draft.default_model = ui.wbDefaultModel.value || null;
    // Cross-model switch: never carry the previous model's effort. Only the
    // persisted effort explicitly scoped to (and still supported by) the newly
    // selected model is kept; everything else resets to Unspecified/Provider
    // default. The FALLBACK selection's own effort is untouched.
    draft.default_effort = workBuddyScopedSavedEffort(
      view?.config.default_model ?? null,
      view?.config.default_effort ?? null,
      draft.default_model
    );
  }
  // The Reasoning options are model-specific: recompute the card from the
  // metadata already loaded with this view (options and any reset notice).
  renderWorkBuddySettings();
  markWorkBuddySettingsDirty();
});
ui.wbFallbackModel.addEventListener("change", () => {
  const view = workBuddySettingsState.view;
  const draft = workBuddySettingsState.draft;
  if (draft) {
    draft.rate_limit_fallback_model = ui.wbFallbackModel.value || null;
    draft.rate_limit_fallback_effort = workBuddyScopedSavedEffort(
      view?.config.rate_limit_fallback_model ?? null,
      view?.config.rate_limit_fallback_effort ?? null,
      draft.rate_limit_fallback_model
    );
  }
  renderWorkBuddySettings();
  markWorkBuddySettingsDirty();
});
ui.wbSaveSettings.addEventListener("click", () => { void saveWorkBuddySettings(); });
ui.pageSize.addEventListener("change", markGlobalDirty);
ui.retentionDays.addEventListener("input", markGlobalDirty);
ui.retentionGb.addEventListener("input", markGlobalDirty);
ui.saveSettings.addEventListener("click", () => { void saveSettings(); });
ui.saveGlobal.addEventListener("click", () => { void saveGlobalSettings(); });
ui.cancel.addEventListener("click", () => { void cancelOpenJob(); });
ui.composer.addEventListener("submit", (event) => { void sendFollowup(event); });
ui.followupText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || event.isComposing) return;
  event.preventDefault();
  if (!ui.sendFollowup.disabled) ui.composer.requestSubmit();
});
ui.showReasoning.addEventListener("change", () => { state.logCursor = "0"; empty(ui.log); void loadLog(); });
renderSelectedProviderSettings();
installSplitter();

(async () => {
  loadReadState();
  await loadGlobalSettings();
  await loadJobs(true);
  // A notification deep link opens the exact intended job, even when it is
  // beyond the loaded page. The existing 2.5s refresh then renders that job's
  // ACTUAL current/expired approval state; nothing is approved here. When the
  // linked request is no longer pending, say so instead of pretending the link
  // still points at a live decision.
  const deepLink = approvalDeepLink();
  if (deepLink) {
    await openJob(deepLink.jobId);
    const opened = state.detail && state.openId === deepLink.jobId && state.detail.job_id === deepLink.jobId ? state.detail : null;
    if (opened && (deepLink.requestId !== null || deepLink.generation !== null)) {
      const pending = opened.pending_approval ?? null;
      const matches = pending !== null
        && (deepLink.requestId === null || pending.request_id === deepLink.requestId)
        && (deepLink.generation === null || pending.generation === deepLink.generation);
      if (!matches) setStatus("This approval is no longer pending; showing the task's current state.");
    }
  }
})();
window.setInterval(() => {
  void refreshOpenJob();
  void refreshJobsList();
}, 2500); // local Hub refresh only; never a Codex/cloud agent poll
