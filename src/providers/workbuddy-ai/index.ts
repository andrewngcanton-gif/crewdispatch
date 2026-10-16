import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CapabilityProbeResult, CliProbeInput, CliResolution, CliResolveInput, ExitClassification, ModelCatalogResult, ProviderAdapter, RunPlanInput, RunPlanResult, StreamState, UsageSnapshot } from "../provider";
import { createCommandCodeAdapter } from "../command-code/index";
import { buildCommandCodeArgv } from "../command-code/argv";
import { buildCommandCodeSpawnPlan } from "../command-code/spawn-plan";
import {
  cancelWorkBuddyTurn,
  connectSidecar,
  workBuddyCliPermissionMode,
  workBuddyTurnSlotKey
} from "./turn-cancel";
import { eligibleRuntimeReceipts, reclaimOwnedRuntimes } from "./runtime-lifecycle";
import { workBuddyDesktopConfigDir } from "./desktop-bridge";
import { applyApprovalStreamLine } from "./approval-channel";
import { safeApprovalOutcome } from "../../jobs/approval";
import { ACP_TERMINAL_EXIT_OUTCOMES, classifyAcpStopReason } from "./acp-normalizer";
import {
  parseWorkBuddyAiReasoning,
  resolveWorkBuddyAiSupportedEfforts,
  type WorkBuddyAiEffortFallbackDeps,
  type WorkBuddyAiReasoningMeta
} from "./effort";

export const WORKBUDDY_AI_PROVIDER = "workbuddy-ai";
export const WORKBUDDY_AI_DISPLAY_NAME = "WorkBuddy AI";
export const WORKBUDDY_AI_CLI_PATH_ENV = "JOBQUAY_WORKBUDDY_AI_CLI_PATH";
export const WORKBUDDY_AI_CLI_COMMAND_ENV = "JOBQUAY_WORKBUDDY_AI_CLI_COMMAND";
export const WORKBUDDY_AI_CONFIG_DIR_ENV = "CODEBUDDY_CONFIG_DIR";
export const WORKBUDDY_AI_FORCE_HEADLESS_ENV = "CODEBUDDY_FORCE_HEADLESS_BUNDLE";
export const WORKBUDDY_AI_FORCE_LITE_ENV = "CODEBUDDY_FORCE_LITE_WB_BUNDLE";
export const WORKBUDDY_AI_NATIVE_CONFIG_DIR_ENV = "WORKBUDDY_CONFIG_DIR";

function workBuddyDesktopRoutePlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

export interface WorkBuddyAiModelMeta {
  label: string;
  credits: string | null;
  free?: boolean;
  description_en?: string | null;
  description_zh?: string | null;
  /**
   * Model-specific reasoning-effort evidence published by the Official App
   * snapshot (plus the DS-only Command Code fallback). Display + pre-launch
   * validation only; null/absent means the App published no effort evidence
   * for this model.
   */
  reasoning?: WorkBuddyAiReasoningMeta | null;
}

export interface WorkBuddyAiPresentation {
  offeredModels: string[];
  modelMeta: Record<string, WorkBuddyAiModelMeta>;
  /** Earliest future WorkBuddy promotion boundary that can change Free-now display. */
  nextPromotionBoundaryAt: string | null;
  source: string | null;
  error: string | null;
}

export interface WorkBuddyAiControlCatalog {
  models: string[];
  modelMeta: Record<string, WorkBuddyAiModelMeta>;
  nextPromotionBoundaryAt: string | null;
}

type WorkBuddyPromotion = Record<string, unknown>;

function zeroCredits(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  return /^x\s*0(?:\.0+)?(?:\s+credits?)?$/i.test(text) || /^0(?:\.0+)?\s*x$/i.test(text);
}

function workBuddyAiModelMeta(value: Record<string, unknown>, id: string): WorkBuddyAiModelMeta {
  const credits = typeof value.credits === "string" && value.credits.trim() ? value.credits.trim() : null;
  return {
    label: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    credits,
    free: credits ? zeroCredits(credits) : undefined,
    description_en: typeof value.descriptionEn === "string" ? value.descriptionEn : null,
    description_zh: typeof value.descriptionZh === "string" ? value.descriptionZh : null,
    reasoning: parseWorkBuddyAiReasoning(value.reasoning)
  };
}

function parseHHmm(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function zonedClock(date: Date, timeZone: unknown): { minuteOfDay: number; secondOfDay: number } {
  let hour = date.getHours();
  let minute = date.getMinutes();
  let second = date.getSeconds();
  if (typeof timeZone === "string" && timeZone.trim()) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).formatToParts(date);
      const part = (type: Intl.DateTimeFormatPartTypes): number =>
        Number(parts.find((item) => item.type === type)?.value ?? "0");
      hour = part("hour") % 24;
      minute = part("minute");
      second = part("second");
    } catch {
      // Invalid/unsupported zone: match WorkBuddy's fallback to the local clock.
    }
  }
  return {
    minuteOfDay: hour * 60 + minute,
    secondOfDay: hour * 3600 + minute * 60 + second + date.getMilliseconds() / 1000
  };
}

function dailyWindowActive(start: number, end: number, current: number): boolean {
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function promotionEnabled(promotion: WorkBuddyPromotion): boolean {
  return promotion.enabled !== false;
}

function promotionActive(promotion: WorkBuddyPromotion, now: Date): boolean {
  if (!promotionEnabled(promotion)) return false;
  const schedule = promotion.schedule && typeof promotion.schedule === "object" && !Array.isArray(promotion.schedule)
    ? promotion.schedule as Record<string, unknown>
    : null;
  const nowMs = now.getTime();
  const from = typeof schedule?.validFrom === "string" ? Date.parse(schedule.validFrom) : Number.NaN;
  if (Number.isFinite(from) && nowMs < from) return false;
  const until = typeof schedule?.validUntil === "string" ? Date.parse(schedule.validUntil) : Number.NaN;
  if (Number.isFinite(until) && nowMs >= until) return false;
  const daily = Array.isArray(schedule?.daily) ? schedule.daily : [];
  if (!daily.length) return true;
  const current = zonedClock(now, schedule?.timezone).minuteOfDay;
  for (const raw of daily) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const window = raw as Record<string, unknown>;
    const start = parseHHmm(window.start);
    const end = parseHHmm(window.end);
    if (start != null && end != null && dailyWindowActive(start, end, current)) return true;
  }
  return false;
}

function promotionIsFree(promotion: WorkBuddyPromotion): boolean {
  if (promotion.kind !== "discount") return false;
  const discount = promotion.discount && typeof promotion.discount === "object" && !Array.isArray(promotion.discount)
    ? promotion.discount as Record<string, unknown>
    : null;
  return discount?.factor === 0 || zeroCredits(discount?.discountedCredits);
}

function promotionModels(promotion: WorkBuddyPromotion, accepted: ReadonlySet<string>): string[] {
  const ids = Array.isArray(promotion.modelIds) ? promotion.modelIds : [];
  return ids.filter((id): id is string => typeof id === "string" && accepted.has(id));
}

function promotionNextBoundaryMs(promotion: WorkBuddyPromotion, now: Date): number | null {
  if (!promotionEnabled(promotion)) return null;
  const schedule = promotion.schedule && typeof promotion.schedule === "object" && !Array.isArray(promotion.schedule)
    ? promotion.schedule as Record<string, unknown>
    : null;
  if (!schedule) return null;
  const nowMs = now.getTime();
  let next: number | null = null;
  const consider = (candidate: number): void => {
    if (candidate > nowMs && (next == null || candidate < next)) next = candidate;
  };
  if (typeof schedule.validFrom === "string") {
    const value = Date.parse(schedule.validFrom);
    if (Number.isFinite(value)) consider(value);
  }
  if (typeof schedule.validUntil === "string") {
    const value = Date.parse(schedule.validUntil);
    if (Number.isFinite(value)) consider(value);
  }
  const daily = Array.isArray(schedule.daily) ? schedule.daily : [];
  if (daily.length) {
    const { secondOfDay } = zonedClock(now, schedule.timezone);
    for (const raw of daily) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const window = raw as Record<string, unknown>;
      for (const boundary of [window.start, window.end]) {
        const minutes = parseHHmm(boundary);
        if (minutes == null) continue;
        let deltaSeconds = minutes * 60 - secondOfDay;
        deltaSeconds = ((deltaSeconds % 86400) + 86400) % 86400;
        if (deltaSeconds === 0) deltaSeconds = 86400;
        consider(nowMs + Math.ceil(deltaSeconds * 1000));
      }
    }
  }
  return next;
}

function applyPromotionFreeState(
  root: Record<string, unknown>,
  models: readonly string[],
  modelMeta: Record<string, WorkBuddyAiModelMeta>,
  now: Date
): string | null {
  const accepted = new Set(models);
  const promotions = Array.isArray(root.modelPromotions)
    ? root.modelPromotions.filter((item): item is WorkBuddyPromotion => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
  const governed = new Set<string>();
  const active = new Set<string>();
  let nextBoundary: number | null = null;

  for (const promotion of promotions) {
    if (!promotionIsFree(promotion) || !promotionEnabled(promotion)) continue;
    const ids = promotionModels(promotion, accepted);
    if (!ids.length) continue;
    for (const id of ids) governed.add(id);
    if (promotionActive(promotion, now)) for (const id of ids) active.add(id);
    const boundary = promotionNextBoundaryMs(promotion, now);
    if (boundary != null && (nextBoundary == null || boundary < nextBoundary)) nextBoundary = boundary;
  }

  // A zero-credit row can be the cached promotional price. If WorkBuddy publishes
  // a free promotion for that model, its schedule owns the Free-now state; after
  // expiry we must not keep showing a stale cached x0 value as free.
  for (const id of governed) {
    const existing = modelMeta[id] ?? { label: id, credits: null };
    modelMeta[id] = { ...existing, free: active.has(id) };
  }
  return nextBoundary == null ? null : new Date(nextBoundary).toISOString();
}

export function parseWorkBuddyAiProductSnapshot(raw: unknown, now: Date = new Date()): WorkBuddyAiControlCatalog | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;

  if (root.type === "workbuddy_product_snapshot") {
    const listed = Array.isArray(root.models) ? root.models : [];
    const models = listed
      .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id))
      .filter((id, index, all) => all.indexOf(id) === index);
    if (!models.length) return null;
    const rawMeta = root.model_meta && typeof root.model_meta === "object" && !Array.isArray(root.model_meta)
      ? root.model_meta as Record<string, unknown>
      : {};
    const modelMeta: Record<string, WorkBuddyAiModelMeta> = {};
    for (const id of models) {
      const meta = rawMeta[id];
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
      const m = meta as Record<string, unknown>;
      const credits = typeof m.credits === "string" && m.credits.trim() ? m.credits.trim() : null;
      modelMeta[id] = {
        label: typeof m.label === "string" && m.label.trim() ? m.label.trim() : id,
        credits,
        free: typeof m.free === "boolean" ? m.free : credits ? zeroCredits(credits) : undefined,
        description_en: typeof m.description_en === "string" ? m.description_en : null,
        description_zh: typeof m.description_zh === "string" ? m.description_zh : null,
        reasoning: parseWorkBuddyAiReasoning(m.reasoning)
      };
    }
    const boundary = typeof root.next_promotion_boundary_at === "string" && Number.isFinite(Date.parse(root.next_promotion_boundary_at))
      ? new Date(Date.parse(root.next_promotion_boundary_at)).toISOString()
      : null;
    return { models, modelMeta, nextPromotionBoundaryAt: boundary };
  }

  const agents = Array.isArray(root.agents) ? root.agents : [];
  const cliAgent = agents.find((entry) => {
    return !!entry && typeof entry === "object" && !Array.isArray(entry) &&
      (entry as Record<string, unknown>).name === "cli";
  }) as Record<string, unknown> | undefined;
  const listed = cliAgent && Array.isArray(cliAgent.models) ? cliAgent.models : [];
  const models = listed
    .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id))
    .filter((id, index, all) => all.indexOf(id) === index);
  if (!models.length) return null;

  const accepted = new Set(models);
  const modelMeta: Record<string, WorkBuddyAiModelMeta> = {};
  const rows = Array.isArray(root.models) ? root.models : [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const m = row as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (!id || !accepted.has(id)) continue;
    modelMeta[id] = workBuddyAiModelMeta(m, id);
  }
  const nextPromotionBoundaryAt = applyPromotionFreeState(root, models, modelMeta, now);
  return { models, modelMeta, nextPromotionBoundaryAt };
}

function workBuddyAiProductSnapshotPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  const profile = workBuddyAiProfileEnv(baseEnv);
  const configDir = profile[WORKBUDDY_AI_CONFIG_DIR_ENV] || path.join(os.homedir(), ".workbuddy-ai");
  return path.join(configDir, "cache", "acc-product-config-v3.json");
}

export function readWorkBuddyAiProductSnapshot(
  baseEnv: NodeJS.ProcessEnv = process.env
): { catalog: WorkBuddyAiControlCatalog; raw: string; path: string } | null {
  const filePath = workBuddyAiProductSnapshotPath(baseEnv);
  if (!existsFile(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseWorkBuddyAiProductSnapshot(raw);
    if (!parsed) return null;
    return { catalog: parsed, raw, path: filePath };
  } catch {
    return null;
  }
}

export function parseWorkBuddyAiControlCatalog(raw: unknown): WorkBuddyAiControlCatalog | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const envelope = JSON.parse(text) as Record<string, unknown>;
      if (envelope.type !== "control_response") continue;
      const response = envelope.response;
      if (!response || typeof response !== "object" || Array.isArray(response)) continue;
      const r = response as Record<string, unknown>;
      if (r.subtype !== "success" || r.request_id !== "jobquay-models") continue;
      const payload = r.response;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
      const p = payload as Record<string, unknown>;
      const available = Array.isArray(p.availableModels) ? p.availableModels : [];
      const rawModels = Array.isArray(p.rawModels) ? p.rawModels : [];
      const models: string[] = [];
      for (const item of available) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const id = typeof (item as Record<string, unknown>).modelId === "string"
          ? String((item as Record<string, unknown>).modelId).trim()
          : "";
        if (id && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) && !models.includes(id)) models.push(id);
      }
      if (!models.length) return null;
      const accepted = new Set(models);
      const modelMeta: Record<string, WorkBuddyAiModelMeta> = {};
      for (const item of rawModels) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const id = typeof value.id === "string" ? value.id.trim() : "";
        if (!id || !accepted.has(id)) continue;
        // This control response has current availability/price metadata but no
        // promotion schedule. A cached x0.00 row alone is not proof that the
        // model is Free-now, so preserve the credits and leave `free` unknown.
        const meta = workBuddyAiModelMeta(value, id);
        modelMeta[id] = { ...meta, free: undefined };
      }
      return { models, modelMeta, nextPromotionBoundaryAt: null };
    } catch {
      // Not the control response line we are looking for.
    }
  }
  return null;
}

const WORKBUDDY_ROUTING_PRESET_IDS = new Set([
  "default-model",
  "fast-model",
  "balanced-model",
  "primary-model",
  "deep-model"
]);

/**
 * Some WorkBuddy startup/offline states publish only the small routing-preset
 * vocabulary instead of the account's explicit model catalog. That response is
 * useful for the App's own routing UI, but it is NOT evidence that every
 * explicit model (for example deepseek-v4.1-flash or hy3) is absent.
 */
export function isWorkBuddyRoutingPresetOnlyCatalog(models: readonly string[]): boolean {
  return models.length > 0 && models.every((id) => WORKBUDDY_ROUTING_PRESET_IDS.has(id));
}

export function parseWorkBuddyAiHelpModels(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  const marker = /currently\s+supported\s*:/i.exec(raw);
  if (!marker) return [];
  let rest = raw.slice(marker.index + marker[0].length).replace(/^[ \t]+/, "");
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close < 0) return [];
    rest = rest.slice(1, close);
  } else {
    const eol = rest.indexOf("\n");
    rest = eol >= 0 ? rest.slice(0, eol) : rest;
  }
  const out: string[] = [];
  for (const piece of rest.split(",")) {
    const id = piece.trim();
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) return [];
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function workBuddyAiProductJsonCandidates(cliPath: string): string[] {
  const dir = path.dirname(cliPath);
  return [...new Set([
    path.resolve(dir, "..", "product.json"),
    path.resolve(dir, "product.json")
  ])];
}

/**
 * The stable public permission vocabulary WorkBuddy AI supports.
 *
 * The `Choices:` line proves the ordinary modes token by token. The WorkBuddy
 * permission vocabulary is recognized by its `bypassPermissions` token; once
 * that provider-specific contract is present, the adapter also exposes native
 * Full Access (`fullAccess`), which the installed bundle accepts as a
 * process/session mode even though help omits it. Arbitrary mode lists do not
 * imply Full Access. Returns [] when no recognized permission vocabulary exists,
 * letting the caller keep its conservative default/plan fallback.
 */
export function parseWorkBuddyAiPermissionModes(help: string): string[] {
  const line = help.split(/\r?\n/).find((x) => x.includes("--permission-mode <mode>") && x.includes("Choices:"));
  const choices = line ? /Choices:\s*([^.]*)/.exec(line)?.[1] ?? "" : "";
  if (!choices) return [];
  const supported: string[] = [];
  if (/\bdefault\b/.test(choices)) supported.push("default");
  if (/\bplan\b/.test(choices)) supported.push("plan");
  if (/\bacceptEdits\b/.test(choices)) supported.push("accept-edits");
  const hasWorkBuddyPermissionVocabulary = /\bbypassPermissions\b/.test(choices);
  if (hasWorkBuddyPermissionVocabulary) supported.push("yolo");
  if (/\bdontAsk\b/.test(choices)) supported.push("dont-ask");
  if (/\bauto\b/.test(choices)) supported.push("auto");
  if (hasWorkBuddyPermissionVocabulary) supported.push("full-access");
  return supported;
}

export function readWorkBuddyAiPresentation(
  cliPath: string,
  acceptedModels: readonly string[],
  liveRaw: string | null = null,
  now: Date = new Date()
): WorkBuddyAiPresentation {
  const accepted = new Set(acceptedModels);
  const snapshot = parseWorkBuddyAiProductSnapshot(liveRaw, now);
  if (snapshot) {
    // `acceptedModels` may come from a fresher live get_available_models read
    // than this cached product snapshot. Keep the LIVE accepted set intact and
    // use the snapshot only to enrich rows it knows (labels, promotion/effort
    // metadata). A new live model must never disappear merely because the cache
    // predates it.
    return {
      offeredModels: [...acceptedModels],
      modelMeta: snapshot.modelMeta,
      nextPromotionBoundaryAt: snapshot.nextPromotionBoundaryAt,
      source: "WorkBuddy product snapshot",
      error: null
    };
  }
  const live = parseWorkBuddyAiControlCatalog(liveRaw);
  if (live) {
    const offeredModels = live.models.filter((id) => accepted.has(id));
    return {
      offeredModels: offeredModels.length ? offeredModels : [...acceptedModels],
      modelMeta: live.modelMeta,
      nextPromotionBoundaryAt: live.nextPromotionBoundaryAt,
      source: "cli get_available_models",
      error: null
    };
  }
  for (const candidate of workBuddyAiProductJsonCandidates(cliPath)) {
    if (!existsFile(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = parseWorkBuddyAiProductSnapshot(raw, now);
      if (!parsed) throw new Error("product.json did not contain a usable cli model list");
      const listed = parsed.models.filter((id) => accepted.has(id));
      const modelMeta: Record<string, WorkBuddyAiModelMeta> = {};
      for (const id of acceptedModels) {
        const meta = parsed.modelMeta[id];
        if (meta) modelMeta[id] = meta;
      }
      return {
        offeredModels: listed.length ? [...new Set(listed)] : [...acceptedModels],
        modelMeta,
        nextPromotionBoundaryAt: parsed.nextPromotionBoundaryAt,
        source: candidate,
        error: null
      };
    } catch (error) {
      return {
        offeredModels: [...acceptedModels],
        modelMeta: {},
        nextPromotionBoundaryAt: null,
        source: candidate,
        error: "WorkBuddy AI product presentation could not be read: " + String((error as Error)?.message || error)
      };
    }
  }
  return {
    offeredModels: [...acceptedModels],
    modelMeta: {},
    nextPromotionBoundaryAt: null,
    source: null,
    error: "WorkBuddy AI product.json was not found next to the resolved CLI; raw CLI ids are shown."
  };
}

function existsFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }

function runReadOnlyCli(
  cliPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform; comSpec?: string; cwd?: string; timeoutMs?: number; input?: string } = {}
): { ok: boolean; stdout: string; stderr: string; error: string | null } {
  let file = cliPath;
  let argv = [...args];
  let windowsVerbatimArguments = false;
  if (/\.(?:c|m)?js$/i.test(cliPath)) {
    file = process.execPath;
    argv = [cliPath, ...args];
  } else {
    const built = buildCommandCodeSpawnPlan({
      cliPath,
      argv: args,
      platform: opts.platform ?? process.platform,
      comSpec: opts.comSpec,
      env
    });
    if (!built.ok) return { ok: false, stdout: "", stderr: "", error: built.error };
    file = built.plan.file;
    argv = [...built.plan.args];
    windowsVerbatimArguments = built.plan.windowsVerbatimArguments;
  }
  try {
    const result = spawnSync(file, argv, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments,
      cwd: opts.cwd || os.tmpdir(),
      env,
      input: opts.input ?? undefined,
      timeout: opts.timeoutMs ?? 45000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const error = result.error
      ? String(result.error.message || result.error)
      : result.status === 0
        ? null
        : "exit " + String(result.status ?? "unknown") + (stderr.trim() ? ": " + stderr.trim().slice(0, 500) : "");
    return { ok: !error, stdout, stderr, error };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: String((error as Error)?.message || error) };
  }
}

function queryAvailableModels(
  cliPath: string,
  env: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform; comSpec?: string; cwd?: string; timeoutMs?: number } = {}
): { catalog: WorkBuddyAiControlCatalog; raw: string } | null {
  const input = JSON.stringify({
    type: "control_request",
    request_id: "jobquay-models",
    request: { subtype: "get_available_models" }
  }) + "\n";
  const result = runReadOnlyCli(
    cliPath,
    ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--no-session-persistence"],
    env,
    { ...opts, input, timeoutMs: opts.timeoutMs ?? 45000 }
  );
  if (!result.ok) return null;
  const catalog = parseWorkBuddyAiControlCatalog(result.stdout);
  return catalog ? { catalog, raw: result.stdout } : null;
}

function readBundledWorkBuddyAiControlCatalog(input: CliProbeInput): { models: string[]; raw: string } | null {
  const env = workBuddyAiProfileEnv(input.env ?? process.env);
  const direct = queryAvailableModels(input.cliPath, env, {
    platform: input.platform ?? process.platform,
    comSpec: input.comSpec,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs
  });
  return direct && direct.catalog.models.length ? { models: direct.catalog.models, raw: direct.raw } : null;
}

function knownCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  const bundledRel = path.join("app.asar.unpacked", "cli", "bin", "codebuddy");
  const winRel = path.join("resources", bundledRel);
  const out: string[] = [];
  const add = (p: string | null | undefined): void => { if (p && !out.includes(p)) out.push(p); };
  if (platform === "win32") {
    add(path.join("D:/winApps/WorkBuddyAI", winRel));
    if (env.LOCALAPPDATA) {
      add(path.join(env.LOCALAPPDATA, "Programs", "WorkBuddyAI", winRel));
      add(path.join(env.LOCALAPPDATA, "Programs", "WorkBuddy AI", winRel));
    }
    add(path.join(home, "AppData", "Local", "Programs", "WorkBuddyAI", winRel));
    add(path.join(home, "AppData", "Local", "Programs", "WorkBuddy AI", winRel));
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      add(path.join(base, "WorkBuddyAI", winRel));
      add(path.join(base, "WorkBuddy AI", winRel));
    }
  } else if (platform === "darwin") {
    for (const app of ["WorkBuddy AI.app", "WorkBuddyAI.app"]) {
      add(path.join("/Applications", app, "Contents", "Resources", bundledRel));
      add(path.join(home, "Applications", app, "Contents", "Resources", bundledRel));
    }
    add(path.join(home, ".local", "share", "workbuddy-ai", winRel));
    add(path.join("/opt", "workbuddy-ai", winRel));
  } else {
    add(path.join(home, ".local", "share", "workbuddy-ai", winRel));
    add(path.join("/opt", "workbuddy-ai", winRel));
    add(path.join("/usr/lib", "workbuddy-ai", winRel));
    add(path.join("/usr/share", "workbuddy-ai", winRel));
  }
  return out;
}

export function workBuddyAiProfileEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const targets = new Set([WORKBUDDY_AI_CONFIG_DIR_ENV, WORKBUDDY_AI_NATIVE_CONFIG_DIR_ENV].map((key) => key.toLowerCase()));
  for (const key of Object.keys(env)) if (targets.has(key.toLowerCase())) delete env[key];
  const configDir = path.join(os.homedir(), ".workbuddy-ai");
  env[WORKBUDDY_AI_CONFIG_DIR_ENV] = configDir;
  env[WORKBUDDY_AI_NATIVE_CONFIG_DIR_ENV] = configDir;
  // WorkBuddy's packaged CLI has used two non-TUI bundle layouts across
  // releases. Older installs ship `codebuddy-headless`; newer installs (for
  // example CLI 2.161.0) may ship only `codebuddy-lite-wb.mjs`. New launchers
  // give FORCE_LITE_WB precedence and older launchers simply ignore that env,
  // so setting BOTH keeps one profile compatible with both generations while
  // still preventing fallback into a missing full TUI bundle.
  env[WORKBUDDY_AI_FORCE_HEADLESS_ENV] = "1";
  env[WORKBUDDY_AI_FORCE_LITE_ENV] = "1";
  return env;
}

export function resolveWorkBuddyAiCli(input: CliResolveInput = {}): CliResolution {
  const env = input.env ?? process.env;
  const envPath = typeof env[WORKBUDDY_AI_CLI_PATH_ENV] === "string" ? String(env[WORKBUDDY_AI_CLI_PATH_ENV]).trim() : "";
  if (envPath) return { ok: true, provider: WORKBUDDY_AI_PROVIDER, path: envPath, source: "env-path" };
  const configPath = typeof input.configPath === "string" ? input.configPath.trim() : "";
  if (configPath) return { ok: true, provider: WORKBUDDY_AI_PROVIDER, path: configPath, source: "config-path" };
  const envCommand = typeof env[WORKBUDDY_AI_CLI_COMMAND_ENV] === "string" ? String(env[WORKBUDDY_AI_CLI_COMMAND_ENV]).trim() : "";
  if (envCommand) return { ok: true, provider: WORKBUDDY_AI_PROVIDER, path: envCommand, source: "env-command" };
  const configCommand = typeof input.configCommand === "string" ? input.configCommand.trim() : "";
  if (configCommand) return { ok: true, provider: WORKBUDDY_AI_PROVIDER, path: configCommand, source: "config-command" };
  if (input.autoDiscover !== false) {
    for (const candidate of knownCandidates(env, input.platform ?? process.platform)) {
      if ((input.exists ?? existsFile)(candidate)) return { ok: true, provider: WORKBUDDY_AI_PROVIDER, path: candidate, source: "discovered" };
    }
  }
  return {
    ok: false, provider: WORKBUDDY_AI_PROVIDER, path: null, source: "missing",
    reason: "WorkBuddy AI CLI is unavailable: configure JOBQUAY_WORKBUDDY_AI_CLI_PATH (or JOBQUAY_WORKBUDDY_AI_CLI_COMMAND) or install WorkBuddy AI in a known location. CrewDispatch deliberately never falls back to the domestic codebuddy executable on PATH."
  };
}

export interface WorkBuddyAiAdapterDeps extends WorkBuddyAiEffortFallbackDeps {
  /** Test seam: the local Official App snapshot reader used by effort evidence. */
  readProductSnapshot?: (env: NodeJS.ProcessEnv) => WorkBuddyAiControlCatalog | null;
  /** Test seam for the live read-only get_available_models control request. */
  readLiveCatalog?: (input: CliProbeInput) => { catalog: WorkBuddyAiControlCatalog; raw: string } | null;
  /** Test seam for the provider-owned cached Product Configuration snapshot. */
  readProductSnapshotEvidence?: (env: NodeJS.ProcessEnv) => { catalog: WorkBuddyAiControlCatalog; raw: string } | null;
  /**
   * Platform whose runner produced the stream/exit codes. Defaults to the real
   * platform: the Desktop bridge (and therefore its terminal exit codes) runs
   * only on Windows; elsewhere the bundled CLI is launched directly.
   */
  platform?: NodeJS.Platform;
}

/**
 * Terminal-state normalization at the WorkBuddy provider boundary.
 *
 * ACP `session/prompt` completion is NOT a successful task result: only a
 * normal `end_turn` stop proves the provider finished the requested task (see
 * the stop-reason table in acp-normalizer.ts, read from the installed ACP
 * schema). The pre-fix bridge stamped EVERY transport completion as
 * `subtype:"success" / is_error:false`, so the observed live record
 * `{subtype:"success", result:null, stop_reason:"refusal", is_error:false}`
 * reached the job service as a success and was persisted `done`.
 *
 * This makes the provider's own stop reason authoritative for the terminal
 * class, so even a recorded/older stream carrying the old success shape can
 * never reach the shared service as a success. The original stop reason stays
 * in `stopReason` (and therefore in durable state), and the provider's message
 * is added only when the stream carried no diagnostic of its own.
 *
 * The stream's own bounded `finishReason` / `errorDetail` are passed through to
 * the SAME classifier the bridge uses, so a recorded/legacy success-shaped
 * record that carries the provider's exact quota diagnostic (with no finish
 * reason — the observed live shape, JQ-20261002-43) normalizes to the shared
 * rate-limit outcome exactly like the bridge's authoritative record. The
 * stream's bounded `approvalOutcome` is passed through the same way, as
 * DIAGNOSTIC evidence only: this defensive path has no remembered
 * per-prompt-turn gate evidence, so the outcome token can never re-classify a
 * success-shaped record by itself — the terminal cause (a proven quota, a
 * refusal, a cancellation, an unknown stop) stands unchanged, and an
 * `end_turn` record can never be overridden by an approval outcome at all, so
 * a legitimate recovery keeps its completion (JQ-20261005-57).
 */
export function normalizeWorkBuddyTerminalState(state: StreamState): StreamState {
  if (!state.terminal || state.isError || state.resultSubtype !== "success") return state;
  const outcome = classifyAcpStopReason(
    state.stopReason,
    state.finishReason,
    null,
    safeApprovalOutcome(state.approvalOutcome),
    state.errorDetail
  );
  if (!outcome.failureKind) return state;
  state.isError = true;
  state.resultSubtype = outcome.failureKind;
  state.errorCode = outcome.failureKind;
  if (!state.errorMsg) state.errorMsg = outcome.message;
  return state;
}

/**
 * The model-specific effort evidence available WITHOUT any WorkBuddy process or
 * network request: the Official App product snapshot CrewDispatch already reads, plus
 * (for the single DeepSeek fallback model) the installed Command Code catalog.
 */
function workBuddyAiModelEffortEvidence(
  model: string,
  deps: WorkBuddyAiAdapterDeps
): { supported_efforts: string[]; supported_efforts_source: "official-app" | "command-code" } | null {
  const env = deps.env ?? process.env;
  let catalog: WorkBuddyAiControlCatalog | null = null;
  try {
    catalog = deps.readProductSnapshot
      ? deps.readProductSnapshot(env)
      : readWorkBuddyAiProductSnapshot(env)?.catalog ?? null;
  } catch {
    catalog = null;
  }
  return resolveWorkBuddyAiSupportedEfforts(model, catalog?.modelMeta ?? null, { ...deps, env });
}

export function createWorkBuddyAiAdapter(deps: WorkBuddyAiAdapterDeps = {}): ProviderAdapter {
  const base = createCommandCodeAdapter();
  const platform = deps.platform ?? process.platform;
  const desktopRoute = workBuddyDesktopRoutePlatform(platform);
  return {
    id: WORKBUDDY_AI_PROVIDER,
    displayName: WORKBUDDY_AI_DISPLAY_NAME,
    maintainResources: desktopRoute ? async (input) => {
      if (!eligibleRuntimeReceipts(input).length) return;
      const sidecar = await connectSidecar(workBuddyDesktopConfigDir(), { platform });
      try { await reclaimOwnedRuntimes(input, sidecar); } finally { sidecar.close(); }
    } : undefined,
    resolveCli: resolveWorkBuddyAiCli,
    async probeCapabilities(input: CliProbeInput): Promise<CapabilityProbeResult> {
      const caps = await base.probeCapabilities({ ...input, env: workBuddyAiProfileEnv(input.env ?? process.env) });
      const published = parseWorkBuddyAiPermissionModes(caps.helpText ?? "");
      return { ...caps, permissionModes: published.length ? published : caps.permissionModes.filter((m) => m === "default" || m === "plan") };
    },
    async readModelCatalog(input: CliProbeInput): Promise<ModelCatalogResult> {
      const isolated = { ...input, env: workBuddyAiProfileEnv(input.env ?? process.env) };

      // FIRST ask the installed WorkBuddy CLI for its CURRENT account-facing
      // model list. Settings/job setup calls this method again for every fresh
      // read/attempt, so recovering network/auth state can recover the catalog
      // without restarting CrewDispatch. A startup/offline response containing
      // only routing presets is deliberately NOT treated as proof that explicit
      // models disappeared.
      const live = deps.readLiveCatalog
        ? deps.readLiveCatalog(isolated)
        : queryAvailableModels(isolated.cliPath, isolated.env ?? process.env, {
            platform: isolated.platform ?? process.platform,
            comSpec: isolated.comSpec,
            cwd: isolated.cwd,
            timeoutMs: isolated.timeoutMs
          });
      if (live && !isWorkBuddyRoutingPresetOnlyCatalog(live.catalog.models)) {
        return {
          ok: true,
          source: "cli-control-models",
          models: live.catalog.models,
          defaultModel: null,
          raw: live.raw,
          error: null
        };
      }

      // Offline/cold-start fallback: WorkBuddy's own atomically written Product
      // Configuration snapshot. It can keep a known configuration usable while
      // the live query is unavailable, but a snapshot that itself contains only
      // routing presets is equally unable to prove explicit-model absence.
      const snapshot = deps.readProductSnapshotEvidence
        ? deps.readProductSnapshotEvidence(isolated.env ?? process.env)
        : readWorkBuddyAiProductSnapshot(isolated.env);
      if (snapshot && !isWorkBuddyRoutingPresetOnlyCatalog(snapshot.catalog.models)) {
        return {
          ok: true,
          source: "workbuddy-product-snapshot",
          models: snapshot.catalog.models,
          defaultModel: null,
          raw: snapshot.raw,
          error: live
            ? "WorkBuddy's live model query returned routing presets only; using the provider-owned cached product snapshot until a later fresh read succeeds."
            : "WorkBuddy's live model query was unavailable; using the provider-owned cached product snapshot until a later fresh read succeeds."
        };
      }

      // Conservative final fallback: the resolved WorkBuddy CLI's public help.
      // The same routing-preset-only shape is NOT an authoritative explicit
      // catalog and must never turn a saved DeepSeek/HY model into model_stale.
      const caps = await base.probeCapabilities(isolated);
      const help = caps.helpText ?? "";
      const published = parseWorkBuddyAiHelpModels(help);
      if (published.length > 0 && !isWorkBuddyRoutingPresetOnlyCatalog(published)) {
        return {
          ok: true,
          source: "cli-help-models",
          models: published,
          defaultModel: null,
          raw: help,
          error: null
        };
      }
      return {
        ok: false,
        source: "unavailable",
        models: [],
        defaultModel: null,
        raw: live?.raw || snapshot?.raw || help || null,
        error: "WorkBuddy AI did not publish a current explicit-model catalog. Routing presets alone are not evidence that configured explicit models are unavailable; a later fresh read will retry the live provider query."
      };
    },
    /**
     * Desktop-authenticated WorkBuddy turns run outside the CrewDispatch child
     * tree on both Windows and macOS. Cancellation and slot attribution therefore
     * use the provider-native route on those platforms. Linux keeps the direct
     * spawned-tree path until a separately proven Desktop boundary exists there.
     */
    cancelTurn: desktopRoute
      ? (input, cancelDeps) => cancelWorkBuddyTurn(input, { ...(cancelDeps ?? {}), platform: cancelDeps?.platform ?? platform })
      : undefined,
    turnSlotKey: desktopRoute
      ? (input) => workBuddyTurnSlotKey({ ...input, platform: input.platform ?? platform })
      : undefined,
    buildRunPlan(input: RunPlanInput): RunPlanResult {
      const requested = typeof input.permissionMode === "string" ? input.permissionMode.trim().toLowerCase() : "";
      const cliMode = workBuddyCliPermissionMode(requested);
      if (!cliMode) return { ok: false, stage: "argv", error: `invalid WorkBuddy AI permission mode: ${JSON.stringify(input.permissionMode)}` };
      // MODEL-SPECIFIC EFFORT GATE: when this model's own published metadata
      // (Official App snapshot, plus the DS-only installed-catalog fallback)
      // proves its supported efforts, an incompatible configured effort is
      // rejected HERE — before the Desktop bridge or its runtime ever starts.
      // With no reliable model-specific evidence the existing capability gate
      // below still applies and nothing is claimed.
      const requestedModel = String(input.model).trim();
      const requestedEffort = typeof input.effort === "string" ? input.effort.trim().toLowerCase() : "";
      if (requestedEffort) {
        const evidence = workBuddyAiModelEffortEvidence(requestedModel, deps);
        if (evidence && !evidence.supported_efforts.includes(requestedEffort)) {
          const source = evidence.supported_efforts_source === "command-code"
            ? "the installed Command Code catalog's list for the same model id"
            : "the Official App model metadata";
          return {
            ok: false,
            stage: "argv",
            error:
              `WorkBuddy AI model ${requestedModel} does not support effort ${JSON.stringify(requestedEffort)} ` +
              `(supported: ${evidence.supported_efforts.join(", ")}, from ${source}). ` +
              `Choose one of the supported efforts or leave the reasoning effort unspecified.`
          };
        }
      }
      // Let the SHARED PURE argv builder validate model, effort and resume
      // tokens with a known-safe canonical mode. This stays a direct call to the
      // pure helper (not the Command Code adapter's buildRunPlan) on purpose:
      // the Command Code adapter now returns its OWN ACP bridge plan, and
      // WorkBuddy must keep its existing transport contract — including the
      // Linux/other direct-CLI argv carrying `--permission-mode` below. On
      // Windows and macOS, actual WorkBuddy jobs do NOT launch the bundled CLI
      // directly: the Desktop app owns authentication and injects it into its
      // sidecar-hosted ACP runtime. The bridge preserves the existing
      // CrewDispatch child-process seam while delegating execution through that
      // authenticated Desktop runtime.
      const built = buildCommandCodeArgv({
        model: input.model,
        permissionMode: "plan",
        publishedPermissionModes: ["plan"],
        resumeSessionId: input.resumeSessionId ?? null,
        effort: input.effort ?? null,
        effortSupported: input.effortSupported,
        supportedEfforts: input.supportedEfforts ?? null
      });
      if (!built.ok) return { ok: false, stage: "argv", error: built.error };

      const runPlatform = input.platform ?? platform;
      if (workBuddyDesktopRoutePlatform(runPlatform)) {
        const bridgePath = path.join(__dirname, "desktop-bridge.js");
        const bridgeArgv = [
          "--cli", input.cliPath,
          "--model", String(input.model).trim(),
          "--permission", cliMode
        ];
        const effortIndex = built.argv.indexOf("--effort");
        const validatedEffort = effortIndex >= 0 ? built.argv[effortIndex + 1] : undefined;
        if (validatedEffort) bridgeArgv.push("--effort", validatedEffort);
        const resumeIndex = built.argv.indexOf("--resume");
        const validatedResume = resumeIndex >= 0 ? built.argv[resumeIndex + 1] : undefined;
        if (validatedResume) bridgeArgv.push("--resume", validatedResume);
        // Bind the bridge's optional interactive approval route to the exact
        // job+generation. Absent identity (a direct/probe invocation) keeps the
        // bridge fully non-interactive.
        if (input.attempt) {
          bridgeArgv.push(
            "--job-id", input.attempt.jobId,
            "--generation", String(input.attempt.generation),
            "--data-root", input.attempt.dataRoot
          );
        }
        return {
          ok: true,
          argv: bridgeArgv,
          plan: {
            file: process.execPath,
            args: [bridgePath, ...bridgeArgv],
            windowsVerbatimArguments: false,
            shellShim: null
          }
        };
      }

      // Linux/other unsupported Desktop platforms keep the existing direct
      // bundled-CLI path. macOS deliberately does NOT use this branch: MAC-50
      // proved the logged-in Desktop auth boundary is distinct from direct CLI auth.
      const argv = [...built.argv];
      const idx = argv.indexOf("--permission-mode");
      if (idx < 0 || idx + 1 >= argv.length) return { ok: false, stage: "argv", error: "WorkBuddy AI permission flag was not built." };
      argv[idx + 1] = cliMode;
      const plan = buildCommandCodeSpawnPlan({
        cliPath: input.cliPath,
        argv,
        platform: runPlatform,
        comSpec: input.comSpec
      });
      if (!plan.ok) return { ok: false, stage: "spawn", error: plan.error };
      return { ok: true, argv, plan: plan.plan };
    },
    createStreamState(): StreamState { return base.createStreamState(); },
    parseStreamLine(line: string, state: StreamState, observedAtMs?: number): StreamState {
      // An interactive-approval record is WorkBuddy transport state, not part of
      // the shared event/terminal grammar: consume it here so the shared parser
      // never counts it as an unknown line.
      if (applyApprovalStreamLine(line, state)) return state;
      return normalizeWorkBuddyTerminalState(base.parseStreamLine(line, state, observedAtMs));
    },
    normalizeUsage(state: StreamState): UsageSnapshot { return base.normalizeUsage(state); },
    classifyExit(code: unknown): ExitClassification {
      // The authenticated Desktop bridge terminates a provider non-completion with
      // its own terminal exit code (see ACP_TERMINAL_EXIT_OUTCOMES). `fatal` and
      // `stopReason` stay false/null on purpose: the shared outcome keeps the
      // provider's ORIGINAL stop reason from the stream. Ordinary refusals are
      // not fallback eligible; the narrowly proven quota shape exits as shared
      // code 5 and deliberately falls through to the base classifier. Other
      // Linux/other direct-CLI platforms do not use this private namespace.
      if (desktopRoute && typeof code === "number" && Number.isFinite(code)) {
        // Keep the provider's raw terminal reason from the stream while reusing
        // the shared rate-limit classification and fallback policy.
        if (code === 5) return { ...base.classifyExit(code), stopReason: null };
        const outcome = ACP_TERMINAL_EXIT_OUTCOMES.get(code);
        if (outcome?.failureKind) {
          return { kind: outcome.failureKind, failureKind: outcome.failureKind, stopReason: null, fatal: false, fallback: false };
        }
      }
      return base.classifyExit(code);
    }
  };
}
