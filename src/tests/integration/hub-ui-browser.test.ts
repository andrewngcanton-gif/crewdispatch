// hub-ui-browser.test.ts — EXECUTABLE browser regression for the Hub UI.
//
// The static UI test (hub-http-mcp.test.ts) only regex-matches the served
// client script. This test drives a REAL headless browser (Chrome/Edge over the
// DevTools Protocol) against an isolated temporary Hub/data root and proves the
// three user-visible contracts end to end:
//
//   1. With the Jobs page ALREADY OPEN, a job created afterwards through the
//      real service entry becomes visible in the sidebar automatically — no
//      reload, no Refresh click — within one 2.5s polling cycle.
//   2. The Permission note is contextual in a real render: the selected mode's
//      own plain-English note (Command Code yolo's run-unattended note, plan's
//      review-the-approach note), never one vague caution shared by unrelated
//      modes. T7c covers the provider-specific WorkBuddy notes.
//   3. A normalized WorkBuddy ACP transcript renders as a COMPACT activity view
//      in the real page: one Assistant row per spoken segment, tool rows BY
//      NAME (including a failed tool), no token-level rows, no hidden reasoning.
//   4. The shared provider-settings contract: only a provider's first usable
//      read shows the ONE normal-weight loading message. Later reopen/switch-back
//      reads keep the known form visible, withdraw stale Free-now emphasis until
//      fresh evidence lands, release Saving at persistence, and ignore stale
//      pre-save responses. A data-driven gate runs this universal behavior for
//      every production-registered provider; feature profiles add two-phase,
//      Reasoning, billing and recommended-Permission assertions. Command Code's
//      read is two phases, so its first-load line remains visible while capability
//      evidence is pending even after the model list renders (T6).
//   5. The canonical telemetry contract at the UI boundary: ONE provider-neutral
//      payload renders identically under two provider ids, context occupancy is
//      NOT presented even when the payload carries the gauges, Decode is
//      rendered ONLY from a paired numerator/denominator (never from unpaired
//      totals), and the session Runtime is a provider-neutral wall-clock span
//      that advances while running and freezes once terminal.
//   6. Each Permission dropdown keeps ONE width while capability/settings data
//      is still arriving (row 46): the real bounding width is identical in the
//      loading, capability-pending and ready states for BOTH providers at a
//      normal and a narrow viewport, with the single-line note/tooltip contract
//      and no page-level horizontal overflow.
//
// The browser is disposable (temp --user-data-dir); the Hub binds an ephemeral
// loopback port over a temp root; no live Hub, user data or CLI profile is
// touched. If no Chromium browser is available the test SKIPS and says so
// instead of pretending to have runtime proof.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { startHub, type HubHandle } from "../../hub/server";
import { createJobRecord, startJob } from "../../jobs/service";
import { appendLog, listJobs, loadJob, logPath, saveJob } from "../../jobs/store";
import { approvalDecisionPath, sanitizeApprovalDetail } from "../../jobs/approval";
import { appendAssistantMessageOrThrow, appendUserMessageOrThrow } from "../../jobs/messages";
import { emptyUsage, type JobAttempt, type JobRecord, type JobStatus } from "../../jobs/types";
import { configPath, updateConfig } from "../../config/schema";
import { updateGlobalSettings } from "../../config/global";
import { ProviderSettingsReads, type SettingsProbeResult, type SettingsProviderDefinition } from "../../config/settings-reads";
import { killProcessTree } from "../../runtime/process";
import { commandCodeSettingsView, workBuddyAiSettingsView } from "../helpers/settings-fixtures";
import { readInvocationArgs, writeFakeCommandCodeCli, writeInstalledCommandCodePackage } from "../helpers/command-code-package-fixture";
import {
  SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES,
  type SettingsUiContractBrowserFixture
} from "../helpers/settings-ui-contract-fixtures";
import {
  DEFAULT_SETTINGS_PROVIDER_IDS,
  defaultSettingsProviders,
  resetDefaultSettingsReadsForTests,
  type DefaultSettingsProviderId,
  type SettingsUiContractProfile
} from "../../config/settings-registry";
import { CcAcpNormalizer } from "../../providers/command-code/acp-normalizer";
import {
  ACP_FIXTURE_ANSWER,
  ACP_FIXTURE_ANSWER_TAIL,
  ACP_FIXTURE_THOUGHT,
  acpFixtureRunLines
} from "../helpers/acp-workbuddy-fixture";

// Permission-note markers used to wait for the real render, and the exact
// production note texts for direct equality assertions in T7c.
const CC_YOLO_NOTE_MARKER = "Skips routine approvals";
const PLAN_NOTE_MARKER = "Suggests changes without editing project files";
const STANDARD_NOTE_TEXT = "May request permission to edit files or run commands.";
const PLAN_NOTE_TEXT = "Suggests changes without editing project files.";
const ACCEPT_EDITS_NOTE_TEXT = "Auto-approves normal edits; commands may need approval.";
const COMMAND_CODE_YOLO_NOTE_TEXT = "Recommended. Skips routine approvals; explicit rules and safety checks still apply.";
const WORKBUDDY_YOLO_NOTE_TEXT = "Runs most actions automatically; risky commands may need approval.";
const WORKBUDDY_FULL_ACCESS_NOTE_TEXT = "Recommended. Skips permission checks; repeated actions may still pause the task.";
const PROVIDER_RULES_NOTE_TEXT = "Provider rules apply; approvals may pause the task.";
const POLL_CYCLE_MS = 2500;
const WORKBUDDY_MODEL = "deepseek-v4.1-flash";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChromium(): string | null {
  const candidates = [
    process.env.JOBQUAY_TEST_BROWSER,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore an unreadable candidate */
    }
  }
  return null;
}

/**
 * Chrome publishes DevToolsActivePort the moment it starts listening, but on
 * Windows it may still hold the file open for a few more milliseconds, so the
 * read is retried instead of racing a raw readFileSync (EBUSY).
 */
async function readDevToolsActivePort(file: string, timeoutMs: number): Promise<string> {
  const startupTimeoutMs = process.platform === "darwin" && process.arch === "x64" ? Math.max(timeoutMs, 60_000) : timeoutMs;
  const deadline = Date.now() + startupTimeoutMs;
  for (;;) {
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.trim().length > 0) return text;
    } catch {
      /* not written yet, or still locked by the browser process */
    }
    if (Date.now() > deadline) throw new Error(`timed out reading ${file}`);
    await sleep(75);
  }
}

async function waitForJson(url: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(75);
  }
}

interface Cdp {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  close(): void;
}

async function connectCdp(wsUrl: string): Promise<Cdp> {
  const WS = (globalThis as { WebSocket?: new (url: string) => any }).WebSocket;
  if (typeof WS !== "function") throw new Error("this Node build has no global WebSocket; cannot drive the browser");
  const ws = new WS(wsUrl);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let seq = 0;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("DevTools websocket failed to open")));
  });
  ws.addEventListener("message", (event: { data: unknown }) => {
    let message: any;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const slot = pending.get(message.id);
      pending.delete(message.id);
      if (!slot) return;
      if (message.error) slot.reject(new Error(String(message.error.message ?? "CDP error")));
      else slot.resolve(message.result);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}

interface PageHandle {
  sessionId: string;
  evaluate(expression: string): Promise<any>;
  goto(url: string): Promise<void>;
}

async function newPage(cdp: Cdp, url: string): Promise<PageHandle> {
  const created: any = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached: any = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sessionId: string = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression: string): Promise<any> => {
    const result: any = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? "unknown"}`);
    }
    return result.result ? result.result.value : undefined;
  };
  const goto = async (target: string): Promise<void> => {
    await cdp.send("Page.navigate", { url: target }, sessionId);
    await waitForPage(evaluate, () => `document.readyState === "complete"`, 15000, "document ready");
  };
  await goto(url);
  return { sessionId, evaluate, goto };
}

async function waitForPage(
  evaluate: (expression: string) => Promise<any>,
  condition: () => string,
  timeoutMs: number,
  label: string
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate(condition());
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

async function waitForHubUrl(handle: HubHandle): Promise<string> {
  const base = `http://127.0.0.1:${handle.port}`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      // `limit` must be one of the Hub's allowed page sizes (20/50/100/200/0).
      const response = await fetch(`${base}/api/jobs?offset=0&limit=20`);
      if (response.status > 0) return base;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error("hub did not accept requests in time");
    await sleep(50);
  }
}

/** The exact loading copy the shipped client renders per provider. */
const PROVIDER_INITIAL_LOADING_MESSAGE = "Loading configuration… First load may take a moment.";
const COMMAND_CODE_LOADING_MESSAGE = PROVIDER_INITIAL_LOADING_MESSAGE;
const WORKBUDDY_LOADING_MESSAGE = PROVIDER_INITIAL_LOADING_MESSAGE;

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

/**
 * Real DOM/computed-layout evidence for one inline Permission note: the note,
 * its dropdown and the explicit label share one horizontal row, and the note
 * is plain (non-warning-card) non-wrapping text whose complete explanation
 * stays in textContent and in its native title.
 */
async function permissionNoteState(page: PageHandle, noteId: string, selectId: string): Promise<any> {
  return page.evaluate(`(() => {
    const note = document.getElementById(${JSON.stringify(noteId)});
    const select = document.getElementById(${JSON.stringify(selectId)});
    const label = document.querySelector('label[for="' + select.id + '"]');
    const style = getComputedStyle(note);
    const noteBox = note.getBoundingClientRect();
    const selectBox = select.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const sameRow = (a, b) => a.top < b.bottom && b.top < a.bottom;
    return {
      fontSize: style.fontSize,
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      overflow: style.overflow,
      background: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      paddingLeft: style.paddingLeft,
      text: note.textContent || "",
      title: note.title || "",
      clientWidth: note.clientWidth,
      scrollWidth: note.scrollWidth,
      height: noteBox.height,
      noteLeft: noteBox.left,
      selectRight: selectBox.right,
      sameRowAsSelect: sameRow(noteBox, selectBox),
      sameRowAsLabel: sameRow(labelBox, selectBox) && sameRow(noteBox, labelBox)
    };
  })()`);
}

/** Apply an explicit viewport and wait until the page reports it. */
async function setViewport(cdp: Cdp, page: PageHandle, width: number, height: number): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, page.sessionId);
  await waitForPage(page.evaluate, () => `window.innerWidth === ${width}`, 15000, `viewport ${width}x${height}`);
}

/**
 * Drive the inline Permission row to a width where the CURRENT note overflows
 * at 13px but fits at 12px, computed from the note's own measured TEXT widths
 * (a text Range, so no font metric or layout constant is assumed), and wait
 * for the shipped two-step fit to settle there. Used to prove the 12px step
 * adds no tooltip when the text is not actually truncated.
 */
async function placeNoteAtIntermediateFit(cdp: Cdp, page: PageHandle, noteId: string, selectId: string): Promise<any> {
  const widths = await page.evaluate(`(() => {
    const note = document.getElementById(${JSON.stringify(noteId)});
    const original = note.style.fontSize;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(note);
      return Math.ceil(range.getBoundingClientRect().width);
    };
    note.style.fontSize = "13px";
    const width13 = measure();
    note.style.fontSize = "12px";
    const width12 = measure();
    note.style.fontSize = original;
    return { width13, width12, target: Math.ceil((width13 + width12) / 2) };
  })()`);
  if (!(widths.width13 > widths.width12)) {
    throw new Error(`${noteId}: the text is not narrower at 12px (${widths.width13} vs ${widths.width12})`);
  }
  let viewport = 1200;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await setViewport(cdp, page, Math.max(768, viewport), 900);
    const width = (await page.evaluate(`document.getElementById(${JSON.stringify(noteId)}).clientWidth`)) as number;
    if (width === widths.target) break;
    viewport += widths.target - width;
  }
  await waitForPage(
    page.evaluate,
    () => `(() => {
      const note = document.getElementById(${JSON.stringify(noteId)});
      return getComputedStyle(note).fontSize === "12px" && note.scrollWidth <= note.clientWidth && note.title === "";
    })()`,
    15000,
    `the intermediate fitting 12px ${noteId} without a tooltip`
  );
  return permissionNoteState(page, noteId, selectId);
}

interface ControlledSettingsProbe {
  definition: SettingsProviderDefinition<any>;
  calls: number;
  settleAt(index: number, result: SettingsProbeResult<any>): void;
  pendingCount(): number;
}

/** A settings provider whose reads stay pending until the test settles that exact call. */
function controlledSettingsProvider(id: string): ControlledSettingsProbe {
  const pending: Array<(result: SettingsProbeResult<any>) => void> = [];
  const probe: ControlledSettingsProbe = {
    calls: 0,
    definition: {
      id,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          probe.calls += 1;
          pending.push(resolve);
        }),
      applyPatch: () => ({})
    },
    settleAt(index, result) {
      const settle = pending[index];
      if (!settle) throw new Error(`no pending ${id} probe at index ${index}`);
      settle(result);
    },
    pendingCount: () => pending.length
  };
  return probe;
}

interface ControlledTwoPhaseProbe {
  definition: SettingsProviderDefinition<any>;
  catalogCalls: number;
  capabilityCalls: number;
  /** Every snake_case patch a save submitted, in order. */
  savedPatches: Array<Record<string, unknown>>;
  settleCatalog(index: number, result: SettingsProbeResult<any>): void;
  settleCapabilities(index: number, result: SettingsProbeResult<any>): void;
}

/**
 * A TWO-PHASE settings provider whose catalog read and capability read are each
 * held pending until the test settles that exact call, so a pending window
 * lasts exactly as long as the test wants it to. `applyPatch` records the
 * submitted snake_case patch, making a save's payload observable.
 */
function controlledTwoPhaseSettingsProvider(id: string, initialConfig: Record<string, unknown>): ControlledTwoPhaseProbe {
  const catalogPending: Array<(result: SettingsProbeResult<any>) => void> = [];
  const capabilityPending: Array<(result: SettingsProbeResult<any>) => void> = [];
  const config: Record<string, unknown> = { ...initialConfig };
  const probe: ControlledTwoPhaseProbe = {
    catalogCalls: 0,
    capabilityCalls: 0,
    savedPatches: [],
    definition: {
      id,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          probe.catalogCalls += 1;
          catalogPending.push(resolve);
        }),
      readCapabilities: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          probe.capabilityCalls += 1;
          capabilityPending.push(resolve);
        }),
      applyPatch: (_root, patch) => {
        probe.savedPatches.push(patch);
        Object.assign(config, patch);
        return { ...config };
      }
    },
    settleCatalog(index, result) {
      const settle = catalogPending[index];
      if (!settle) throw new Error(`no pending ${id} catalog probe at index ${index}`);
      settle(result);
    },
    settleCapabilities(index, result) {
      const settle = capabilityPending[index];
      if (!settle) throw new Error(`no pending ${id} capability probe at index ${index}`);
      settle(result);
    }
  };
  return probe;
}

interface ControlledContractSettingsProbe {
  definition: SettingsProviderDefinition<any>;
  config: Record<string, unknown>;
  readCalls: number;
  capabilityCalls: number;
  savedPatches: Array<Record<string, unknown>>;
  settleRead(index: number, result: SettingsProbeResult<any>): void;
  settleCapability(index: number, result: SettingsProbeResult<any>): void;
}

/**
 * Provider-neutral controllable backend for the universal Settings contract.
 * Every registered provider gets one of these through its executable fixture;
 * the browser therefore exercises the SAME lifecycle while provider-specific
 * view shapes/selectors stay in the fixture adapter.
 */
function controlledContractSettingsProvider(
  fixture: SettingsUiContractBrowserFixture,
  profile: SettingsUiContractProfile
): ControlledContractSettingsProbe {
  const readPending: Array<(result: SettingsProbeResult<any>) => void> = [];
  const capabilityPending: Array<(result: SettingsProbeResult<any>) => void> = [];
  const seed = fixture.buildView({}, 1, profile.readStrategy === "catalog-capabilities");
  const config: Record<string, unknown> = { ...seed.config };
  const probe: ControlledContractSettingsProbe = {
    config,
    readCalls: 0,
    capabilityCalls: 0,
    savedPatches: [],
    definition: {
      id: fixture.providerId,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          probe.readCalls += 1;
          readPending.push(resolve);
        }),
      ...(profile.readStrategy === "catalog-capabilities"
        ? {
            readCapabilities: () =>
              new Promise<SettingsProbeResult<any>>((resolve) => {
                probe.capabilityCalls += 1;
                capabilityPending.push(resolve);
              })
          }
        : {}),
      applyPatch: (_root, patch) => {
        probe.savedPatches.push({ ...patch });
        Object.assign(config, patch);
        return { ...config };
      }
    },
    settleRead(index, result) {
      const settle = readPending[index];
      if (!settle) throw new Error(`no pending ${fixture.providerId} contract read at index ${index}`);
      settle(result);
    },
    settleCapability(index, result) {
      const settle = capabilityPending[index];
      if (!settle) throw new Error(`no pending ${fixture.providerId} contract capability read at index ${index}`);
      settle(result);
    }
  };
  return probe;
}

test("an already-open Hub Jobs page shows a newly created session within one polling cycle", { timeout: 120000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-browser-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const project = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    // This scenario verifies browser polling/activity/permission rendering, not
    // the operator's real provider installations. Keep the settings probe
    // deterministic under the concurrent full suite: do not discover a real
    // Command Code CLI (the Hub never probes one at startup anyway).
    hub = startHub({
      root,
      host: "127.0.0.1",
      port: 0,
      env: { ...process.env, JOBQUAY_CLI_AUTODISCOVER: "false" }
    });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    // A disposable headless browser on an ephemeral DevTools port.
    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    // 1) Open the Jobs page FIRST and let its initial list load settle.
    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "") || document.querySelectorAll("#jobs button.job").length > 0`,
      15000,
      "initial job list load"
    );
    assert.equal(await page.evaluate(`document.querySelectorAll("#jobs button.job").length`), 0, "sidebar starts empty");
    assert.equal(await page.evaluate(`document.title`), "CrewDispatch · Local sessions");
    assert.equal(await page.evaluate(`document.querySelector(".brand h1").textContent`), "CrewDispatch");
    // A page-reload tripwire: if the client reloaded, this marker would vanish.
    await page.evaluate(`window.__jobquayNoReload = "kept"`);

    // 2) Create a job through the real service entry AFTER the page is open.
    //    A deliberately missing worker persists a real terminal record without
    //    launching a CLI or spending quota (same pattern as the Hub HTTP test).
    const missingWorker = path.join(dir, "worker-must-not-run.js");
    const taskTitle = "BROWSER_REFRESH_MARKER";
    const startedAt = Date.now();
    assert.throws(
      () => startJob({ root, cwd: project, task: taskTitle, provider: "command-code", workerScript: missingWorker, env: process.env }),
      (error: any) => error?.code === "worker_missing"
    );
    const created = listJobs(root).jobs.find((job) => job.task === taskTitle);
    assert.ok(created, "the job record was persisted by the real service entry");
    const jobId = created!.id;

    // 3) No reload, no Refresh click: the sidebar must pick it up on its own.
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#jobs button.job")).some((b) => b.dataset.jobId === ${JSON.stringify(jobId)})`,
      8000,
      "newly created session in the sidebar"
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      elapsedMs < POLL_CYCLE_MS + 2500,
      `the new session appeared within one ${POLL_CYCLE_MS}ms cycle plus slack (took ${elapsedMs}ms)`
    );
    assert.equal(await page.evaluate(`window.__jobquayNoReload`), "kept", "the page was never reloaded");
    const sidebarTitle = await page.evaluate(
      `document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}] .job-title').textContent`
    );
    assert.equal(sidebarTitle, taskTitle, "the sidebar renders the created session title");

    // Caller provenance is local presentation metadata, not provider prompt text.
    // A Claude-originated dispatch must never inherit the old hard-coded Codex label.
    const claudeTaskTitle = "CLAUDE_CALLER_LABEL_MARKER";
    assert.throws(
      () => startJob({
        root,
        cwd: project,
        task: claudeTaskTitle,
        provider: "command-code",
        workerScript: missingWorker,
        env: process.env,
        notifyTarget: {
          kind: "claude_session",
          callbackUrl: null,
          codexThreadId: null,
          claudeSessionId: "claude-ui-session",
          claudeBindingId: null,
          source: "claude_session_id"
        }
      }),
      (error: any) => error?.code === "worker_missing"
    );
    const claudeJob = listJobs(root).jobs.find((job) => job.task === claudeTaskTitle);
    assert.ok(claudeJob, "the Claude-originated fixture job was persisted");
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#jobs button.job")).some((b) => b.dataset.jobId === ${JSON.stringify(claudeJob!.id)})`,
      8000,
      "Claude-originated session in the sidebar"
    );
    await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(claudeJob!.id)}]').click()`);
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("conversation").textContent || "").includes(${JSON.stringify(claudeTaskTitle)})`,
      15000,
      "Claude-originated conversation"
    );
    const claudeWho = await page.evaluate(`document.querySelector("#conversation .bubble.user .who")?.textContent || ""`);
    assert.equal(claudeWho, "You / Claude · first task", "Claude dispatches are labelled Claude, never Codex");
    const claudeDetail = await fetch(`${hubUrl}/api/jobs/${claudeJob!.id}`).then((response) => response.json()) as any;
    assert.equal(claudeDetail.user_messages[0].source, "claude", "Hub exposes bounded local caller provenance for the first message");
    console.log(
      `[hub-ui-browser] EV1 sidebar: job ${jobId} appeared ${elapsedMs}ms after creation ` +
        `(poll cycle ${POLL_CYCLE_MS}ms), page reloaded = false, title=${JSON.stringify(sidebarTitle)}`
    );

    // 4) A normalized WorkBuddy ACP transcript must render as a COMPACT, readable
    //    activity view: the raw streamed chunks of a turn collapse into one
    //    Assistant row per spoken segment and tool rows keep their protocol name.
    const workBuddyLog = path.join(root, "logs", `${jobId}.ndjson`);
    fs.mkdirSync(path.dirname(workBuddyLog), { recursive: true });
    fs.writeFileSync(workBuddyLog, acpFixtureRunLines(WORKBUDDY_MODEL).join("\n") + "\n", "utf8");
    await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]').click()`);
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("log").textContent || "").includes("Tool queued · read_file")`,
      20000,
      "WorkBuddy activity rows"
    );
    const renderedLog = String(await page.evaluate(`document.getElementById("log").innerText`));
    const assistantRows = renderedLog.split("\n").filter((line) => line.startsWith("Assistant · "));
    assert.deepEqual(
      assistantRows,
      [`Assistant · ${ACP_FIXTURE_ANSWER}`, `Assistant · ${ACP_FIXTURE_ANSWER_TAIL}`],
      "one readable Assistant row per spoken segment, never one row per streamed chunk"
    );
    assert.equal(renderedLog.includes("text_delta"), false, "no token-level rows in the compact view");
    assert.equal(renderedLog.includes("message_start"), false, "no message bookkeeping rows in the compact view");
    assert.equal(renderedLog.includes("tool_use"), false, "no bare tool_use row");
    assert.ok(renderedLog.includes("Tool queued · read_file"), "a tool row names the tool");
    assert.ok(renderedLog.includes("Tool update · search_code"), "a still-unfinished tool reports one aggregated progress row");
    assert.ok(renderedLog.includes("Tool completed · read_file"), "a completed tool keeps the tool name");
    assert.ok(renderedLog.includes("Tool failed · execute"), "an ACP failed tool renders as failed, not completed");
    assert.equal(renderedLog.includes(ACP_FIXTURE_THOUGHT), false, "hidden reasoning never renders by default");
    console.log(
      `[hub-ui-browser] EV1b workbuddy activity (${assistantRows.length} assistant rows): ` +
        JSON.stringify(renderedLog.split("\n").slice(0, 10))
    );

    // EV1c: Command Code reasoning must traverse the PRODUCTION normalizer ->
    // durable log -> compact Hub API -> browser. Do not hand-invent a
    // thinking_end fixture here: that was exactly how the 2026-10-07 regression
    // escaped. The real normalizer must create the complete block from ACP
    // agent_thought_chunk frames.
    const ccRecords: Record<string, unknown>[] = [];
    const ccNormalizer = new CcAcpNormalizer({ freshSession: true, emit: (record) => ccRecords.push(record) });
    ccNormalizer.markPromptStarted();
    ccNormalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "COMMAND_CODE_BROWSER_REASONING_A " } });
    ccNormalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "B" } });
    ccNormalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "browser answer" } });
    ccNormalizer.handlePromptResult({ stopReason: "end_turn" });
    fs.writeFileSync(
      workBuddyLog,
      [
        JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "cc-browser-reasoning" } }),
        ...ccRecords.map((record) => JSON.stringify(record)),
        JSON.stringify({ type: "result", subtype: "success", result: "browser answer", session_id: "cc-browser-reasoning", stop_reason: "end_turn" })
      ].join("\n") + "\n",
      "utf8"
    );
    const ccApiHidden = await fetch(`${hubUrl}/api/jobs/${jobId}/log?limit=1000&activity=1&scope=current&include_reasoning=false`).then((response) => response.json()) as any;
    assert.equal(JSON.stringify(ccApiHidden).includes("COMMAND_CODE_BROWSER_REASONING_A"), false, "Command Code reasoning is private by default at the Hub boundary");
    const ccApiVisible = await fetch(`${hubUrl}/api/jobs/${jobId}/log?limit=1000&activity=1&scope=current&include_reasoning=true`).then((response) => response.json()) as any;
    assert.ok(
      ccApiVisible.entries.some((entry: any) => entry.data?.event?.type === "thinking_end" && entry.reasoning?.includes("COMMAND_CODE_BROWSER_REASONING_A B")),
      "production Command Code normalization produces the complete reasoning row required by compact activity"
    );
    await page.evaluate(`(() => {
      const box = document.getElementById("showReasoning");
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("log").textContent || "").includes("Reasoning · COMMAND_CODE_BROWSER_REASONING_A B")`,
      15000,
      "Command Code reasoning in the real Dashboard"
    );
    const ccRenderedLog = String(await page.evaluate(`document.getElementById("log").innerText`));
    assert.equal(
      ccRenderedLog.split("\n").filter((line) => line === "Reasoning · COMMAND_CODE_BROWSER_REASONING_A B").length,
      1,
      "one contiguous Command Code reasoning block renders exactly once"
    );
    assert.equal(ccRenderedLog.includes("thinking_delta"), false, "the real Dashboard never renders token-level thought chunk noise");
    await page.evaluate(`(() => {
      const box = document.getElementById("showReasoning");
      box.checked = false;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    console.log("[hub-ui-browser] EV1c command-code reasoning: production normalizer -> Hub -> browser PASS");

    // 5) Permission note in a real render — yolo (the default) shows Command
    // Code's own yolo note, not a generic caution shared with other modes.
    // Entering Settings runs the real backend settings probe (the same probe the
    // loading-state test measures; it can take well over 10s under load). Wait
    // for that probe to finish — the shared loading class on the provider card
    // clears — before asserting the note, instead of racing a fixed 15s bound.
    const waitForSettingsProbe = (): Promise<void> =>
      waitForPage(
        page.evaluate,
        () => `!document.getElementById("cliInfo").classList.contains("loading")`,
        60000,
        "real settings probe"
      );
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForSettingsProbe();
    await waitForPage(
      page.evaluate,
      () => `(() => { const el = document.getElementById("yoloWarning"); return !el.classList.contains("hidden") && (el.textContent || "").includes(${JSON.stringify(CC_YOLO_NOTE_MARKER)}); })()`,
      15000,
      "Command Code yolo note"
    );
    const yoloDraft = await page.evaluate(`document.getElementById("permissionMode").value`);
    assert.equal(yoloDraft, "yolo", "the Permission control reflects the yolo default");
    const yoloNote = await page.evaluate(`document.getElementById("yoloWarning").textContent`);
    assert.equal(String(yoloNote), COMMAND_CODE_YOLO_NOTE_TEXT, "the yolo selection shows Command Code's own yolo note");
    console.log(`[hub-ui-browser] EV2 yolo note (permission=${yoloDraft}): ${JSON.stringify(yoloNote)}`);

    // EV2b: the inline note layout contract in the real render. Wide: 13px,
    // no clipping and NO tooltip. Intermediate: a 13px overflow steps down to
    // 12px and still has no tooltip, because nothing is truncated. Constrained:
    // 12px with a real single-line ellipsis, whose full text IS in the tooltip,
    // and no page-level horizontal overflow. Widened again: 13px and the
    // tooltip is removed.
    await setViewport(cdp, page, 1600, 900);
    await waitForPage(
      page.evaluate,
      () => `getComputedStyle(document.getElementById("yoloWarning")).fontSize === "13px"`,
      15000,
      "the wide 13px Command Code note"
    );
    const wideNote = await permissionNoteState(page, "yoloWarning", "permissionMode");
    assert.equal(wideNote.fontSize, "13px", "the note renders at 13px when the full text fits");
    assert.equal(
      wideNote.scrollWidth <= wideNote.clientWidth,
      true,
      `the wide note does not clip (scrollWidth=${wideNote.scrollWidth}, clientWidth=${wideNote.clientWidth})`
    );
    assert.equal(wideNote.whiteSpace, "nowrap", "the note never wraps");
    assert.equal(wideNote.textOverflow, "ellipsis", "overflow is expressed as a single-line ellipsis");
    assert.equal(wideNote.overflow, "hidden", "the note clips instead of widening the row");
    assert.equal(wideNote.background, "rgba(0, 0, 0, 0)", "no warning-card background on the note");
    assert.equal(wideNote.borderTopWidth, "0px", "no warning-card border on the note");
    assert.equal(wideNote.paddingLeft, "0px", "no warning-card padding on the note");
    assert.equal(wideNote.sameRowAsSelect && wideNote.sameRowAsLabel, true, "label, dropdown and note share one horizontal row");
    assert.ok(
      wideNote.noteLeft >= wideNote.selectRight - 1,
      `the note follows the dropdown on the same row (noteLeft=${wideNote.noteLeft}, selectRight=${wideNote.selectRight})`
    );
    assert.equal(wideNote.height < 30, true, "the note stays single-line at the wide width");
    assert.equal(wideNote.text, COMMAND_CODE_YOLO_NOTE_TEXT, "the full explanation stays the textContent");
    assert.equal(wideNote.title, "", "a note that fits at 13px has no extra tooltip");

    // An intermediate width where the SAME text overflows at 13px but fits at
    // 12px: the step-down applies and the tooltip stays absent because nothing
    // is truncated.
    const intermediateNote = await placeNoteAtIntermediateFit(cdp, page, "yoloWarning", "permissionMode");
    assert.equal(intermediateNote.fontSize, "12px", "the 13px overflow steps the note down to 12px");
    assert.equal(
      intermediateNote.scrollWidth <= intermediateNote.clientWidth,
      true,
      `the intermediate note fits at 12px (scrollWidth=${intermediateNote.scrollWidth}, clientWidth=${intermediateNote.clientWidth})`
    );
    assert.equal(intermediateNote.title, "", "a note that fits after the 12px step has no extra tooltip");
    assert.equal(intermediateNote.text, COMMAND_CODE_YOLO_NOTE_TEXT, "the full explanation stays the textContent");

    await setViewport(cdp, page, 640, 480);
    await waitForPage(
      page.evaluate,
      () => `(() => {
        const el = document.getElementById("yoloWarning");
        return getComputedStyle(el).fontSize === "12px"
          && el.scrollWidth > el.clientWidth
          && el.title === ${JSON.stringify(COMMAND_CODE_YOLO_NOTE_TEXT)};
      })()`,
      15000,
      "the constrained 12px Command Code note with its clipped tooltip"
    );
    const narrowNote = await permissionNoteState(page, "yoloWarning", "permissionMode");
    assert.equal(narrowNote.fontSize, "12px", "an overflowing note steps down to 12px, never further");
    assert.equal(
      narrowNote.scrollWidth > narrowNote.clientWidth,
      true,
      `the remaining overflow is a real ellipsis (scrollWidth=${narrowNote.scrollWidth}, clientWidth=${narrowNote.clientWidth})`
    );
    assert.equal(narrowNote.whiteSpace, "nowrap", "the constrained note still never wraps");
    assert.equal(narrowNote.height < 30, true, "the constrained note stays single-line");
    assert.equal(narrowNote.text, COMMAND_CODE_YOLO_NOTE_TEXT, "clipping never slices the textContent");
    assert.equal(narrowNote.title, COMMAND_CODE_YOLO_NOTE_TEXT, "the complete current text stays in the title while clipped");
    assert.equal(narrowNote.sameRowAsSelect && narrowNote.sameRowAsLabel, true, "the constrained row keeps label, dropdown and note together");
    assert.equal(
      await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
      true,
      "the constrained row never stretches the page horizontally"
    );

    await setViewport(cdp, page, 1600, 900);
    await waitForPage(
      page.evaluate,
      () => `getComputedStyle(document.getElementById("yoloWarning")).fontSize === "13px"`,
      15000,
      "the restored 13px Command Code note"
    );
    const restoredNote = await permissionNoteState(page, "yoloWarning", "permissionMode");
    assert.equal(restoredNote.fontSize, "13px", "widening restores 13px once the text fits again");
    assert.equal(restoredNote.scrollWidth <= restoredNote.clientWidth, true, "the restored note no longer clips");
    assert.equal(restoredNote.title, "", "widening removes the tooltip once the note fits again");
    console.log(
      `[hub-ui-browser] EV2b inline note layout (CC): wide 13px/no-tooltip, intermediate 12px fit/no-tooltip, ` +
        `constrained 12px/ellipsis/tooltip, restored 13px/no-tooltip — ` +
        `row=${wideNote.sameRowAsSelect && narrowNote.sameRowAsLabel}, background=${wideNote.background}, title=${JSON.stringify(restoredNote.title)}`
    );

    // 6) Switch the stored mode to plan and reload: the SAME element must now
    //    explain plan specifically, not repeat the yolo or a generic caution.
    updateConfig(root, { permissionMode: "plan" });
    await page.goto(`${hubUrl}/ui`);
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForSettingsProbe();
    await waitForPage(
      page.evaluate,
      () => `(() => { const el = document.getElementById("yoloWarning"); return !el.classList.contains("hidden") && (el.textContent || "").includes(${JSON.stringify(PLAN_NOTE_MARKER)}); })()`,
      15000,
      "plan note"
    );
    const noteText = await page.evaluate(`document.getElementById("yoloWarning").textContent`);
    assert.equal(String(noteText), PLAN_NOTE_TEXT, "the plan selection shows the plan note");
    assert.doesNotMatch(String(noteText), /Skips routine approvals/, "the yolo note is replaced for plan");
    // The plan note fits at the wide viewport: the mode change must leave no
    // tooltip (and must clear any stale clipped-note tooltip).
    await setViewport(cdp, page, 1600, 900);
    await waitForPage(
      page.evaluate,
      () => `(() => { const el = document.getElementById("yoloWarning"); return getComputedStyle(el).fontSize === "13px" && el.title === ""; })()`,
      15000,
      "the fitting plan note without a tooltip"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").title`),
      "",
      "a mode change whose note fits at 13px leaves no tooltip"
    );
    console.log(`[hub-ui-browser] EV3 plan note (permission=plan): ${JSON.stringify(noteText)}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      // Let Chrome release its profile handles before the temp dir is removed.
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    // Best-effort, bounded cleanup: a Windows profile handle may linger briefly.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

test("Settings refreshes providers without blanking an already-loaded form", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-settings-fresh-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  // Deterministic provider definitions behind the REAL Hub routes, each read
  // controlled by the test: the browser drives the shipped client + Hub read
  // path without depending on a machine-installed CLI, and every read is
  // counted so "every Settings open / provider switch reads again" is
  // observable end to end.
  const cc = controlledSettingsProvider("command-code");
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    const providerCardState = async (infoId: string): Promise<{ visible: boolean; loading: boolean; text: string }> =>
      page.evaluate(`(() => {
        const el = document.getElementById(${JSON.stringify(infoId)});
        return {
          visible: !el.classList.contains("hidden") && getComputedStyle(el).display !== "none",
          loading: el.classList.contains("loading"),
          text: el.innerText || ""
        };
      })()`);

    const optionTexts = (selectId: string): Promise<string[]> =>
      page.evaluate(
        `Array.from(document.getElementById(${JSON.stringify(selectId)}).options).map((option) => option.textContent || "")`
      );

    /** Only the real model options (the empty-value placeholder is excluded). */
    const modelOptionTexts = (selectId: string): Promise<string[]> =>
      page.evaluate(
        `Array.from(document.getElementById(${JSON.stringify(selectId)}).options).filter((option) => option.value !== "").map((option) => option.textContent || "")`
      );

    const settingSelectOptionCount = (selectId: string): Promise<number> =>
      page.evaluate(`document.getElementById(${JSON.stringify(selectId)}).options.length`);

    const waitForLoadingMessage = (infoId: string, message: string): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => { const el = document.getElementById(${JSON.stringify(infoId)}); return el.classList.contains("loading") && (el.innerText || "").includes(${JSON.stringify(message)}); })()`,
        20000,
        `${message} loading state`
      );

    const assertLoadingCleared = async (infoId: string, message: string): Promise<void> => {
      const state = await providerCardState(infoId);
      assert.equal(state.loading, false, `${infoId}: the loading class is removed once the fresh read settles`);
      // A hidden element's innerText falls back to textContent, so only a
      // VISIBLE loading line would still be a user-visible loading state.
      assert.equal(
        state.visible && String(state.text).includes(message),
        false,
        `${infoId}: no visible loading copy after the load (visible=${state.visible}, text=${JSON.stringify(state.text)})`
      );
    };

    /**
     * The WorkBuddy AI first-read state: exactly the shared configuration line at
     * normal weight (400), measured from the computed style of the VISIBLE
     * line while the provider read is still pending.
     */
    const assertWorkBuddyLoadingPresentation = async (): Promise<void> => {
      const lines = await page.evaluate(
        `Array.from(document.getElementById("wbCliInfo").children).map((el) => el.textContent || "")`
      );
      assert.deepEqual(lines, [WORKBUDDY_LOADING_MESSAGE], "WorkBuddy AI shows exactly the first-load configuration message");
      assert.doesNotMatch(String(lines[0]), /5[–-]20/, "WorkBuddy AI must not claim a 5–20 second bound");
      assert.equal(
        await page.evaluate(`getComputedStyle(document.getElementById("wbCliInfo").firstElementChild).fontWeight`),
        "400",
        "the visible WorkBuddy loading text has normal font weight"
      );
    };

    /** Command Code uses the same first-load copy and normal-weight styling as WorkBuddy AI. */
    const assertCommandCodeLoadingPresentation = async (): Promise<void> => {
      const lines = await page.evaluate(
        `Array.from(document.getElementById("cliInfo").children).map((el) => el.textContent || "")`
      );
      assert.deepEqual(lines, [COMMAND_CODE_LOADING_MESSAGE], "Command Code keeps its own single loading message");
      assert.equal(
        await page.evaluate(`getComputedStyle(document.getElementById("cliInfo").firstElementChild).fontWeight`),
        "400",
        "Command Code's visible loading text has the same normal font weight as WorkBuddy AI"
      );
    };

    /** The user-visible provider-card copy must never expose cache/SWR jargon. */
    const assertNoCardJargon = async (label: string): Promise<void> => {
      const text = await page.evaluate(
        `(document.getElementById("cliInfo").innerText || "") + "\\n" + (document.getElementById("settingsMessage").innerText || "")`
      );
      assert.doesNotMatch(String(text), /stale|revalidat|cached?|Updating…/i, `${label}: no cache/stale/updating jargon (${JSON.stringify(String(text).slice(0, 200))})`);
    };

    const selectProvider = async (provider: "command-code" | "workbuddy-ai"): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("settingsProvider");
        select.value = ${JSON.stringify(provider)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };

    // --- Path 1: entering Settings (first load) shows exactly ONE concise
    //     loading message and no provider form until the fresh read returns. ---
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForLoadingMessage("cliInfo", COMMAND_CODE_LOADING_MESSAGE);
    await assertCommandCodeLoadingPresentation();
    assert.equal(await page.evaluate(`document.getElementById("defaultModel").disabled`), true, "the model selector is locked while loading");
    assert.equal(await page.evaluate(`document.getElementById("fallbackModel").disabled`), true, "the fallback selector is locked while loading");
    assert.equal(await page.evaluate(`document.getElementById("saveSettings").disabled`), true, "saving is locked while loading");
    assert.equal(await settingSelectOptionCount("defaultModel"), 0, "no model list is rendered while loading");
    assert.equal(
      await page.evaluate(`document.getElementById("settingsMessage").innerText`),
      "",
      "no divergent ad-hoc loading text next to the shared loading state"
    );
    await assertNoCardJargon("first Settings open");
    await waitFor(() => cc.calls === 1, 10000, "the first Command Code read");
    assert.equal(wb.calls, 0, "entering Settings only reads the selected provider");
    cc.settleAt(0, {
      ok: true,
      view: commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"], freeModels: ["cc/model-b"] })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("defaultModel").disabled`, 60000, "Command Code controls after the fresh load");
    await assertLoadingCleared("cliInfo", COMMAND_CODE_LOADING_MESSAGE);
    assert.equal(cc.calls, 1, "the Settings open ran exactly one fresh provider read");
    const ccFreshOptions = await optionTexts("defaultModel");
    assert.ok(
      ccFreshOptions.includes("cc/model-b · Free now"),
      `fresh evidence restores the Free-now label (got ${JSON.stringify(ccFreshOptions)})`
    );
    console.log("[hub-ui-settings-fresh] EV1 first Settings open: one simple loading message, then one fresh read restored Free-now");

    // --- Path 2: switching provider performs a fresh WorkBuddy AI read with its
    //     own concise message (no unfounded 5–20s claim). ---
    await selectProvider("workbuddy-ai");
    await waitForLoadingMessage("wbCliInfo", WORKBUDDY_LOADING_MESSAGE);
    await assertWorkBuddyLoadingPresentation();
    assert.equal(await page.evaluate(`document.getElementById("wbDefaultModel").disabled`), true, "the WorkBuddy model selector is locked while loading");
    await waitFor(() => wb.calls === 1, 10000, "the first WorkBuddy read");
    assert.equal(cc.calls, 1, "switching away does not start a new Command Code read");
    wb.settleAt(0, {
      ok: true,
      view: workBuddyAiSettingsView({
        models: ["deepseek-v4.1-flash", "hy3"],
        offeredModels: ["deepseek-v4.1-flash", "hy3"],
        meta: {
          "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", credits: "x0", free: true },
          hy3: { label: "HY3", credits: "x1.5", free: false }
        }
      })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 60000, "WorkBuddy AI controls after the fresh load");
    await assertLoadingCleared("wbCliInfo", WORKBUDDY_LOADING_MESSAGE);
    assert.equal(
      await page.evaluate(`document.getElementById("wbCliInfo").classList.contains("wb-loading")`),
      false,
      "the WorkBuddy-only loading modifier is removed once the fresh read settles, so non-loading status copy keeps its shared styling"
    );
    assert.equal(wb.calls, 1, "the provider switch ran exactly one fresh WorkBuddy read");
    const wbFreshOptions = await optionTexts("wbDefaultModel");
    assert.ok(
      wbFreshOptions.includes("DeepSeek V4.1 Flash · Free now"),
      `fresh WorkBuddy evidence restores its Free-now label (got ${JSON.stringify(wbFreshOptions)})`
    );
    console.log("[hub-ui-settings-fresh] EV2 provider switch: simple loading, then fresh WorkBuddy evidence");

    // --- Path 3: switching BACK to a provider loaded earlier in this session
    //     refreshes in the background but keeps the known form on screen. ---
    await selectProvider("command-code");
    assert.equal(
      await page.evaluate(`document.getElementById("cliInfo").classList.contains("loading")`),
      false,
      "switch-back: an already-loaded provider never returns to a loading card"
    );
    assert.equal(await page.evaluate(`document.getElementById("defaultModel").disabled`), false, "switch-back: the known model selector remains interactive");
    assert.deepEqual(
      await modelOptionTexts("defaultModel"),
      ["cc/model-a", "cc/model-b"],
      "switch-back: the known model list remains visible while stale Free-now emphasis is withheld during refresh"
    );
    await waitFor(() => cc.calls === 2, 10000, "the second Command Code read");
    cc.settleAt(1, {
      ok: true,
      // Current evidence only: cc/model-a is free NOW; cc/model-b is not.
      view: commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"], freeModels: ["cc/model-a"] })
    });
    await waitForPage(
      page.evaluate,
      () =>
        `(() => {
          const options = Array.from(document.getElementById("defaultModel").options).map((option) => option.textContent || "");
          return options.includes(${JSON.stringify("cc/model-a · Free now")}) && !options.some((text) => String(text).includes("cc/model-b · Free now"));
        })()`,
      60000,
      "the fresh Command Code replacement"
    );
    const ccReplaced = await modelOptionTexts("defaultModel");
    assert.deepEqual(ccReplaced, ["cc/model-a · Free now", "cc/model-b"], "fresh evidence replaces the temporary unverified presentation");
    console.log("[hub-ui-settings-fresh] EV3 switch-back: known form stayed visible while a fresh read replaced its billing evidence");

    // --- Path 4: an already-loaded provider keeps its current form even when a
    //     background refresh fails; only a short refresh failure is surfaced. ---
    await selectProvider("workbuddy-ai");
    assert.equal(await page.evaluate(`document.getElementById("wbCliInfo").classList.contains("loading")`), false, "WorkBuddy switch-back never blanks the known form");
    assert.ok((await modelOptionTexts("wbDefaultModel")).length > 0, "the known WorkBuddy model list stays visible during refresh");
    await waitFor(() => wb.calls === 2, 10000, "the second WorkBuddy read");
    wb.settleAt(1, { ok: true, view: workBuddyAiSettingsView({ models: ["hy3"], offeredModels: ["hy3"] }) });
    await waitForPage(page.evaluate, () => `Array.from(document.getElementById("wbDefaultModel").options).some((option) => option.value === "hy3")`, 60000, "the refreshed WorkBuddy view");

    await selectProvider("command-code");
    assert.equal(await page.evaluate(`document.getElementById("cliInfo").classList.contains("loading")`), false, "Command Code stays visible while its refresh runs");
    const beforeFailure = await modelOptionTexts("defaultModel");
    await waitFor(() => cc.calls === 3, 10000, "the failing Command Code read");
    cc.settleAt(2, { ok: false, code: "config_invalid", message: "Injected invalid configuration", field: "default_model", raw: "{oops" });
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("settingsMessage").innerText || "").includes("Refresh failed.")`,
      20000,
      "the short failed-refresh message"
    );
    assert.equal(await page.evaluate(`document.getElementById("defaultModel").disabled`), false, "a failed background refresh does not lock the current model selector");
    assert.deepEqual(await modelOptionTexts("defaultModel"), beforeFailure, "a failed background refresh keeps the current model list");
    await assertNoCardJargon("failed background refresh");
    console.log("[hub-ui-settings-fresh] EV4 failed background refresh: current form retained, short failure only");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});


test("every registered provider satisfies the universal Settings UI contract", { timeout: 360000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const productionDefinitions = new Map(
    defaultSettingsProviders().map((definition) => [definition.id as DefaultSettingsProviderId, definition])
  );

  for (const providerId of DEFAULT_SETTINGS_PROVIDER_IDS) {
    const fixture: SettingsUiContractBrowserFixture = SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES[providerId];
    const production = productionDefinitions.get(providerId);
    assert.ok(production, `${providerId}: production Settings definition exists`);
    const profile = production.uiContract;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-ui-contract-${providerId}-`));
    const root = path.join(dir, "root");
    const userDataDir = path.join(dir, "chrome-profile");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    const probes = new Map<DefaultSettingsProviderId, ControlledContractSettingsProbe>();
    for (const id of DEFAULT_SETTINGS_PROVIDER_IDS) {
      const registered = productionDefinitions.get(id);
      assert.ok(registered, `${id}: production definition exists for contract setup`);
      probes.set(id, controlledContractSettingsProvider(SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES[id], registered.uiContract));
    }
    const reads = new ProviderSettingsReads([...probes.values()].map((probe) => probe.definition));
    const probe = probes.get(providerId)!;

    let hub: HubHandle | null = null;
    let chrome: ChildProcess | null = null;
    let cdp: Cdp | null = null;
    try {
      hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
      await new Promise<void>((resolve, reject) => {
        hub!.server.once("listening", () => resolve());
        hub!.server.once("error", reject);
      });
      const hubUrl = await waitForHubUrl(hub);

      chrome = spawn(
        browserPath,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--remote-debugging-port=0",
          `--user-data-dir=${userDataDir}`,
          "about:blank"
        ],
        { stdio: "ignore", windowsHide: true }
      );
      const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
      const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
      assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, `${providerId}: DevTools port was published`);
      const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
      cdp = await connectCdp(String(version.webSocketDebuggerUrl));

      const page = await newPage(cdp, `${hubUrl}/ui`);
      await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, `${providerId}: page ready`);
      await waitForPage(
        page.evaluate,
        () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
        15000,
        `${providerId}: initial job list load`
      );

      await page.evaluate(`document.getElementById("navSettings").click()`);
      const optionExists = await page.evaluate(
        `Array.from(document.getElementById("settingsProvider").options).some((option) => option.value === ${JSON.stringify(providerId)})`
      );
      assert.equal(optionExists, true, `${providerId}: the production Settings provider selector exposes every registered provider`);
      if (providerId !== "command-code") {
        await page.evaluate(`(() => {
          const select = document.getElementById("settingsProvider");
          select.value = ${JSON.stringify(providerId)};
          select.dispatchEvent(new Event("change"));
        })()`);
      }
      assert.equal(
        await page.evaluate(`document.getElementById("settingsProvider").value`),
        providerId,
        `${providerId}: selecting the registered provider does not fall back to another provider`
      );

      await waitFor(() => probe.readCalls === 1, 15000, `${providerId}: first contract read`);
      await waitForPage(
        page.evaluate,
        () => `(() => {
          const el = document.getElementById(${JSON.stringify(fixture.infoId)});
          return el.classList.contains("loading")
            && (el.innerText || "").includes(${JSON.stringify(PROVIDER_INITIAL_LOADING_MESSAGE)});
        })()`,
        15000,
        `${providerId}: first-load feedback`
      );
      assert.equal(
        await page.evaluate(`getComputedStyle(document.getElementById(${JSON.stringify(fixture.infoId)}).firstElementChild).fontWeight`),
        "400",
        `${providerId}: first-load feedback uses the shared normal font weight`
      );

      const oldConfig = { ...probe.config };
      probe.settleRead(0, {
        ok: true,
        view: fixture.buildView({ ...probe.config }, 1, profile.readStrategy === "catalog-capabilities")
      });

      if (profile.readStrategy === "catalog-capabilities") {
        await waitFor(() => probe.capabilityCalls === 1, 15000, `${providerId}: initial capability read`);
        assert.equal(
          await page.evaluate(`document.getElementById(${JSON.stringify(fixture.infoId)}).classList.contains("loading")`),
          true,
          `${providerId}: first-load feedback stays visible through initial capability discovery`
        );
        assert.ok(fixture.buildCapabilityPatch, `${providerId}: two-phase contract fixture publishes a capability patch`);
        probe.settleCapability(0, { ok: true, view: fixture.buildCapabilityPatch!({ ...probe.config }) });
      }

      await waitForPage(
        page.evaluate,
        () => `(() => {
          const info = document.getElementById(${JSON.stringify(fixture.infoId)});
          const model = document.getElementById(${JSON.stringify(fixture.modelSelectId)});
          return !info.classList.contains("loading") && !model.disabled && model.options.length > 0;
        })()`,
        30000,
        `${providerId}: first usable Settings view`
      );

      if (profile.billingPromotions) {
        assert.equal(
          await page.evaluate(`Array.from(document.getElementById(${JSON.stringify(fixture.modelSelectId)}).options).some((option) => /Free now/.test(option.textContent || ""))`),
          true,
          `${providerId}: fresh billing evidence can produce current Free-now presentation`
        );
      }

      if (profile.modelSpecificReasoning) {
        assert.ok(fixture.reasoning && fixture.defaultEffortId, `${providerId}: model-specific Reasoning fixture is complete`);
        const reasoning = fixture.reasoning;
        const effortId = fixture.defaultEffortId;
        await waitForPage(
          page.evaluate,
          () => `(() => {
            const select = document.getElementById(${JSON.stringify(effortId)});
            return !select.disabled && Array.from(select.options).some((option) => option.value === ${JSON.stringify(reasoning.primaryOnlyEffort)});
          })()`,
          15000,
          `${providerId}: primary-model Reasoning options`
        );
        await page.evaluate(`(() => {
          const select = document.getElementById(${JSON.stringify(fixture.modelSelectId)});
          select.value = ${JSON.stringify(reasoning.secondaryModel)};
          select.dispatchEvent(new Event("change"));
        })()`);
        await waitForPage(
          page.evaluate,
          () => `(() => {
            const select = document.getElementById(${JSON.stringify(effortId)});
            const values = Array.from(select.options).map((option) => option.value).filter(Boolean);
            return !values.includes(${JSON.stringify(reasoning.primaryOnlyEffort)})
              && ${JSON.stringify(reasoning.secondaryEfforts)}.every((value) => values.includes(value));
          })()`,
          15000,
          `${providerId}: secondary-model Reasoning options`
        );
        assert.notEqual(
          await page.evaluate(`document.getElementById(${JSON.stringify(effortId)}).value`),
          reasoning.primaryOnlyEffort,
          `${providerId}: an incompatible effort is never carried across a model switch`
        );
        await page.evaluate(`(() => {
          const select = document.getElementById(${JSON.stringify(fixture.modelSelectId)});
          select.value = ${JSON.stringify(reasoning.primaryModel)};
          select.dispatchEvent(new Event("change"));
        })()`);
      }
      const originalPermission = String(probe.config.permission_mode ?? "");
      if (profile.recommendedPermissionMode) {
        const recommendedExists = await page.evaluate(
          `Array.from(document.getElementById(${JSON.stringify(fixture.permissionSelectId)}).options).some((option) => option.value === ${JSON.stringify(profile.recommendedPermissionMode)})`
        );
        assert.equal(recommendedExists, true, `${providerId}: the recommended Permission mode is a real selectable provider mode`);
        await page.evaluate(`(() => {
          const select = document.getElementById(${JSON.stringify(fixture.permissionSelectId)});
          select.value = ${JSON.stringify(profile.recommendedPermissionMode)};
          select.dispatchEvent(new Event("change"));
        })()`);
        assert.match(
          String(await page.evaluate(`document.getElementById(${JSON.stringify(fixture.permissionNoteId)}).textContent || ""`)),
          /^Recommended\./,
          `${providerId}: the registry's recommended Permission mode is visibly explained as Recommended`
        );
        await page.evaluate(`(() => {
          const select = document.getElementById(${JSON.stringify(fixture.permissionSelectId)});
          select.value = ${JSON.stringify(originalPermission)};
          select.dispatchEvent(new Event("change"));
        })()`);
      }

      // A later Settings open must start a fresh read WITHOUT blanking the known form.
      await page.evaluate(`document.getElementById("navJobs").click(); document.getElementById("navSettings").click()`);
      await waitFor(() => probe.readCalls === 2, 15000, `${providerId}: background refresh read`);
      assert.equal(
        await page.evaluate(`document.getElementById(${JSON.stringify(fixture.infoId)}).classList.contains("loading")`),
        false,
        `${providerId}: reopening an already-loaded provider never returns to provider-level loading`
      );
      assert.equal(
        await page.evaluate(`document.getElementById(${JSON.stringify(fixture.modelSelectId)}).disabled`),
        false,
        `${providerId}: the known model selector stays usable during background refresh`
      );
      assert.ok(
        (await page.evaluate(`Array.from(document.getElementById(${JSON.stringify(fixture.modelSelectId)}).options).filter((option) => option.value !== "").length`)) > 0,
        `${providerId}: the known model list stays visible during background refresh`
      );
      if (profile.billingPromotions) {
        await waitForPage(
          page.evaluate,
          () => `!Array.from(document.getElementById(${JSON.stringify(fixture.modelSelectId)}).options).some((option) => /Free now/.test(option.textContent || ""))`,
          15000,
          `${providerId}: stale Free-now emphasis is withheld while refresh is pending`
        );
      }

      // Save while the pre-save refresh is still pending. The write must release
      // the UI immediately and start a NEW post-save verification read.
      await page.evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(fixture.permissionSelectId)});
        select.value = ${JSON.stringify(fixture.alternatePermissionMode)};
        select.dispatchEvent(new Event("change"));
      })()`);
      await waitForPage(
        page.evaluate,
        () => `document.getElementById(${JSON.stringify(fixture.saveButtonId)}).disabled === false`,
        15000,
        `${providerId}: Save enabled for contract mutation`
      );
      await page.evaluate(`document.getElementById(${JSON.stringify(fixture.saveButtonId)}).click()`);
      await waitFor(
        () => probe.savedPatches.length === 1 && probe.readCalls === 3,
        30000,
        `${providerId}: persistence plus post-save verification read`
      );
      assert.notEqual(
        String(await page.evaluate(`document.getElementById(${JSON.stringify(fixture.messageId)}).innerText || ""`)),
        "Saving…",
        `${providerId}: visible Saving ends at persistence instead of provider verification`
      );
      assert.equal(
        await page.evaluate(`document.getElementById(${JSON.stringify(fixture.permissionSelectId)}).disabled`),
        false,
        `${providerId}: known Permission stays usable while post-save verification is pending`
      );
      assert.equal(
        await page.evaluate(`document.getElementById(${JSON.stringify(fixture.permissionSelectId)}).value`),
        fixture.alternatePermissionMode,
        `${providerId}: the persisted Permission is immediately visible`
      );

      // Now release the OLD pre-save response. The generation guard must ignore it.
      probe.settleRead(1, {
        ok: true,
        view: fixture.buildView(oldConfig, 2, profile.readStrategy === "catalog-capabilities")
      });
      await sleep(150);
      assert.equal(
        await page.evaluate(`document.getElementById(${JSON.stringify(fixture.permissionSelectId)}).value`),
        fixture.alternatePermissionMode,
        `${providerId}: a stale pre-save response cannot overwrite the persisted view`
      );

      // Finally release the authoritative post-save verification.
      probe.settleRead(2, {
        ok: true,
        view: fixture.buildView({ ...probe.config }, 3, profile.readStrategy === "catalog-capabilities")
      });
      if (profile.readStrategy === "catalog-capabilities") {
        await waitFor(() => probe.capabilityCalls === 2, 15000, `${providerId}: post-save capability verification`);
        probe.settleCapability(1, { ok: true, view: fixture.buildCapabilityPatch!({ ...probe.config }) });
      }
      await waitForPage(
        page.evaluate,
        () => `(() => {
          const model = document.getElementById(${JSON.stringify(fixture.modelSelectId)});
          const permission = document.getElementById(${JSON.stringify(fixture.permissionSelectId)});
          return !model.disabled
            && !permission.disabled
            && permission.value === ${JSON.stringify(fixture.alternatePermissionMode)};
        })()`,
        30000,
        `${providerId}: final post-save verified Settings view`
      );

      console.log(
        `[settings-ui-contract] ${providerId}: first-load + background refresh + save/stale-response contract PASS`
      );
    } finally {
      if (cdp) cdp.close();
      if (chrome) {
        if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
        try {
          chrome.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        await new Promise<void>((resolve) => {
          if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
          const timer = setTimeout(resolve, 4000);
          chrome!.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (hub) {
        hub.server.closeAllConnections?.();
        await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
      }
      for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T4 — freshly verified free models lead the Settings model dropdowns
// ---------------------------------------------------------------------------

/**
 * The T4 acceptance in a REAL browser against the SHIPPED client script:
 *   A/B — the pure shared ordering helper itself (fresh partition, unverified no-op);
 *   C/D — both providers' dropdowns: freshly verified free rows lead (labeled +
 *         bold), and every switch-back loads fresh evidence that replaces the
 *         earlier view (no remembered Free-now);
 *   E   — a promotion boundary triggers a real fresh read, and expired
 *         promotion evidence no longer drives front placement;
 *   F   — the configured selection survives every reorder and read cycle;
 *   req8— a configured model outside the catalog stays appended, not hoisted.
 */
test("freshly verified free models lead both Settings model dropdowns; expired or unverified evidence never does (T4)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-free-first-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const cc = controlledSettingsProvider("command-code");
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    const modelOptions = async (selectId: string): Promise<Array<{ value: string; text: string; bold: boolean }>> => {
      const all = (await page.evaluate(
        `Array.from(document.getElementById(${JSON.stringify(selectId)}).options).map((option) => ({ value: option.value, text: option.textContent || "", bold: option.style.fontWeight === "700" }))`
      )) as Array<{ value: string; text: string; bold: boolean }>;
      return all.filter((option) => option.value !== "");
    };
    const selectedValue = (selectId: string): Promise<string> =>
      page.evaluate(`document.getElementById(${JSON.stringify(selectId)}).value`);
    const selectProvider = async (provider: "command-code" | "workbuddy-ai"): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("settingsProvider");
        select.value = ${JSON.stringify(provider)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };

    // --- A + B: the pure shared helper as shipped in the served script. ---
    const partition = await page.evaluate(
      `stableFreeFirstOrder(["paidA","freeA","paidB","freeB"], { paidA:{free:false}, freeA:{free:true}, paidB:{free:false}, freeB:{free:true} }, true)`
    );
    assert.deepEqual(
      partition,
      ["freeA", "freeB", "paidA", "paidB"],
      "A: fresh verified free models lead, stable within both groups"
    );
    const stable = await page.evaluate(
      `stableFreeFirstOrder(["p1","f1","p2","f2","p3"], { p1:{free:false}, f1:{free:true}, p2:{free:false}, f2:{free:true}, p3:{free:false} }, true)`
    );
    assert.deepEqual(stable, ["f1", "f2", "p1", "p2", "p3"], "A: the partition is stable within each group");
    const unverified = await page.evaluate(
      `stableFreeFirstOrder(["paidA","freeA","paidB","freeB"], { paidA:{free:true}, freeA:{free:true}, paidB:{free:true}, freeB:{free:true} }, false)`
    );
    assert.deepEqual(
      unverified,
      ["paidA", "freeA", "paidB", "freeB"],
      "B: billing_verified=false keeps the original order even when stale metadata still claims free"
    );
    console.log("[hub-ui-free-first] EV-A/B shipped stableFreeFirstOrder: fresh partition + stale no-op verified in the real page");

    // --- C (fresh): Command Code free-first from freshly verified evidence. ---
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForPage(page.evaluate, () => `document.getElementById("cliInfo").classList.contains("loading")`, 20000, "the Command Code loading state");
    await waitFor(() => cc.calls === 1, 30000, "the first Command Code read");
    cc.settleAt(0, {
      ok: true,
      view: commandCodeSettingsView({
        models: ["paid/a", "free/a", "paid/b", "free/b"],
        freeModels: ["free/a", "free/b"],
        defaultModel: "paid/a"
      })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("defaultModel").disabled`, 60000, "Command Code controls after the fresh load");
    const ccFresh = await modelOptions("defaultModel");
    assert.deepEqual(
      ccFresh.map((option) => option.value),
      ["free/a", "free/b", "paid/a", "paid/b"],
      "C: freshly verified free models lead the Command Code dropdown, provider order kept inside each group"
    );
    assert.deepEqual(ccFresh.map((option) => option.text), ["free/a · Free now", "free/b · Free now", "paid/a", "paid/b"]);
    assert.deepEqual(ccFresh.map((option) => option.bold), [true, true, false, false], "the existing Free-now emphasis is kept");
    assert.equal(await selectedValue("defaultModel"), "paid/a", "F: the configured selection survives the free-first reorder");

    // --- D (fresh): WorkBuddy free-first from current promotion evidence. ---
    await selectProvider("workbuddy-ai");
    await waitForPage(page.evaluate, () => `document.getElementById("wbCliInfo").classList.contains("loading")`, 20000, "the WorkBuddy loading state");
    await waitFor(() => wb.calls === 1, 30000, "the first WorkBuddy read");
    wb.settleAt(0, {
      ok: true,
      view: workBuddyAiSettingsView({
        models: ["hy3", "deepseek-v4.1-flash"],
        offeredModels: ["hy3", "deepseek-v4.1-flash"],
        meta: {
          hy3: { label: "HY3", free: false },
          "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", free: true }
        },
        defaultModel: "hy3"
      })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 60000, "WorkBuddy controls after the fresh load");
    const wbFresh = await modelOptions("wbDefaultModel");
    assert.deepEqual(
      wbFresh.map((option) => option.value),
      ["deepseek-v4.1-flash", "hy3"],
      "D: the freshly promoted free model leads even though the offered order lists it second"
    );
    assert.deepEqual(wbFresh.map((option) => option.text), ["DeepSeek V4.1 Flash · Free now", "HY3"]);
    assert.deepEqual(wbFresh.map((option) => option.bold), [true, false]);
    assert.equal(await selectedValue("wbDefaultModel"), "hy3", "F: the configured WorkBuddy selection survives the reorder");
    console.log("[hub-ui-free-first] EV-C/D fresh verified free rows lead both dropdowns (labeled + bold), configured selection kept");

    // --- C (fresh switch-back): every switch-back still performs a NEW fresh
    //     read, but the known form stays visible. Billing labels are withheld
    //     during the refresh so old Free-now evidence is never presented as fresh. ---
    await selectProvider("command-code");
    assert.equal(await page.evaluate(`document.getElementById("cliInfo").classList.contains("loading")`), false, "C: switch-back never blanks the known Command Code form");
    const ccRefreshing = await modelOptions("defaultModel");
    assert.deepEqual(
      ccRefreshing.map((option) => option.value),
      ["paid/a", "free/a", "paid/b", "free/b"],
      "C: the known model list stays visible in catalog order while fresh billing evidence is pending"
    );
    assert.equal(ccRefreshing.some((option) => option.text.includes("Free now")), false, "C: stale Free-now labels are withheld during refresh");
    await waitFor(() => cc.calls === 2, 30000, "the second Command Code read");
    cc.settleAt(1, {
      ok: true,
      view: commandCodeSettingsView({
        models: ["paid/a", "free/a", "paid/b", "free/b"],
        freeModels: ["paid/b"],
        defaultModel: "paid/a"
      })
    });
    await waitForPage(page.evaluate, () => `Array.from(document.getElementById("defaultModel").options).some((option) => (option.textContent || "").includes("paid/b · Free now"))`, 20000, "the fresh Command Code replacement");
    const ccReplaced = await modelOptions("defaultModel");
    assert.deepEqual(
      ccReplaced.map((option) => option.value),
      ["paid/b", "paid/a", "free/a", "free/b"],
      "C: fresh free-first uses the CURRENT evidence only (paid/b), never remembered flags"
    );
    assert.equal(ccReplaced.filter((option) => option.text.includes("Free now")).length, 1, "only the currently free row is labeled");
    assert.equal(ccReplaced.find((option) => option.value === "paid/b")?.bold, true, "the current free row keeps the bold emphasis");
    assert.equal(ccReplaced.find((option) => option.value === "free/a")?.text, "free/a", "a no-longer-free row loses its label");
    assert.equal(await selectedValue("defaultModel"), "paid/a", "F: the configured selection survives the fresh replacement");
    console.log("[hub-ui-free-first] EV-C switch-back: known form stayed visible; current fresh evidence replaced its billing labels");

    // --- D (fresh reload + promotion boundary): the refresh is silent and the
    //     expired promotion must not stay at the front. ---
    await selectProvider("workbuddy-ai");
    assert.equal(await page.evaluate(`document.getElementById("wbCliInfo").classList.contains("loading")`), false, "D: switch-back never blanks the known WorkBuddy form");
    assert.equal((await modelOptions("wbDefaultModel")).some((option) => option.text.includes("Free now")), false, "D: old WorkBuddy Free-now evidence is withheld while refreshing");
    await waitFor(() => wb.calls === 2, 30000, "the second WorkBuddy read");    wb.settleAt(1, {
      ok: true,
      view: workBuddyAiSettingsView({
        models: ["hy3", "deepseek-v4.1-flash"],
        offeredModels: ["hy3", "deepseek-v4.1-flash"],
        meta: {
          hy3: { label: "HY3", free: false },
          "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", free: true }
        },
        defaultModel: "hy3",
        // The promotion expires soon: the client must trigger a REAL fresh
        // read when this boundary passes.
        nextPromotionBoundaryAt: new Date(Date.now() + 1500).toISOString()
      })
    });
    await waitForPage(page.evaluate, () => `Array.from(document.getElementById("wbDefaultModel").options).some((option) => (option.textContent || "").includes("DeepSeek V4.1 Flash · Free now"))`, 20000, "the fresh WorkBuddy view");
    const wbRenewed = await modelOptions("wbDefaultModel");
    assert.deepEqual(
      wbRenewed.map((option) => option.value),
      ["deepseek-v4.1-flash", "hy3"],
      "D: the fresh read restores current free-first ordering"
    );
    assert.equal(wbRenewed.find((option) => option.value === "deepseek-v4.1-flash")?.text, "DeepSeek V4.1 Flash · Free now");

    // --- E: the promotion boundary triggers a fresh read, and the expired
    //     promotion must not stay at the front. ---
    await waitFor(() => wb.calls === 3, 30000, "the promotion-boundary read");
    assert.equal(await page.evaluate(`document.getElementById("wbCliInfo").classList.contains("loading")`), false, "E: the promotion-boundary refresh keeps the WorkBuddy form visible");
    assert.equal((await modelOptions("wbDefaultModel")).some((option) => option.text.includes("Free now")), false, "E: expired/unverified promotion evidence is removed immediately while the refresh is pending");
    wb.settleAt(2, {
      ok: true,
      view: workBuddyAiSettingsView({
        models: ["hy3", "deepseek-v4.1-flash", "qwen/q"],
        offeredModels: ["hy3", "deepseek-v4.1-flash", "qwen/q"],
        meta: {
          hy3: { label: "HY3", free: false },
          "deepseek-v4.1-flash": { label: "DeepSeek V4.1 Flash", free: false },
          "qwen/q": { label: "QWEN Q", free: false }
        },
        defaultModel: "hy3",
        nextPromotionBoundaryAt: null
      })
    });
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.getElementById("wbDefaultModel").options).some((option) => option.value === ${JSON.stringify("qwen/q")}) && !document.getElementById("wbCliInfo").classList.contains("loading")`,
      20000,
      "the expired-promotion fresh view"
    );
    const wbExpired = await modelOptions("wbDefaultModel");
    assert.deepEqual(
      wbExpired.map((option) => option.value),
      ["hy3", "deepseek-v4.1-flash", "qwen/q"],
      "E: after the boundary read, the expired promotion no longer drives front placement"
    );
    assert.equal(wbExpired.some((option) => option.text.includes("Free now")), false, "E: an expired promotion carries no Free-now label");
    assert.equal(await selectedValue("wbDefaultModel"), "hy3", "F: the configured WorkBuddy selection survives the promotion-boundary cycle");
    console.log("[hub-ui-free-first] EV-E promotion boundary fresh read: expired promotion dropped from the front");

    // --- req8: a configured model outside the display list stays appended. ---
    await selectProvider("command-code");
    assert.equal(await page.evaluate(`document.getElementById("cliInfo").classList.contains("loading")`), false, "req8: switching to a known Command Code view stays immediate");
    await waitFor(() => cc.calls === 3, 30000, "the third Command Code read");
    cc.settleAt(2, {
      ok: true,
      view: commandCodeSettingsView({
        models: ["paid/a", "free/a", "paid/b", "free/b"],
        freeModels: ["free/a"],
        defaultModel: "legacy/model-x",
        extraMeta: { "legacy/model-x": { free: true } }
      })
    });
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.getElementById("defaultModel").options).some((option) => option.value === ${JSON.stringify("legacy/model-x")}) && !document.getElementById("cliInfo").classList.contains("loading")`,
      20000,
      "the configured model outside the catalog"
    );
    const ccAppended = await modelOptions("defaultModel");
    assert.deepEqual(
      ccAppended.map((option) => option.value),
      ["free/a", "paid/a", "paid/b", "free/b", "legacy/model-x"],
      "req8: a configured current model outside the display list stays appended after the ordered list, even with fresh free evidence"
    );
    assert.equal(
      ccAppended[4]?.text,
      "legacy/model-x · Free now (current config; not in the current official catalog)",
      "req8: the appended row keeps its existing safety label"
    );
    assert.equal(await selectedValue("defaultModel"), "legacy/model-x", "req8/F: the configured selection is preserved, never silently replaced");
    console.log("[hub-ui-free-first] EV-req8 configured model outside the catalog appended + selected, not hoisted");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T6 — the model dropdown never waits for the capability probe
// ---------------------------------------------------------------------------

/**
 * THE PROMPTNESS REGRESSION, driven end to end in a real browser against the
 * REAL production read path (real settings registry, real worker-backed probe,
 * real installed-package discovery, PRODUCTION-DEFAULT timing — no injected
 * budget).
 *
 * The defect it guards: the Settings card rendered ONLY its loading state until
 * the single `?fresh=1` response returned, and that response awaited the
 * capability probe on its 20s default budget. A cold or hung `--version` /
 * `--help` therefore delayed the model dropdown by up to ~20s.
 *
 * The contract now: the catalog phase answers from the installed package with
 * NO CLI process, so the model options (and their Free-now labels) appear while
 * the probe is still running; the capability evidence arrives later and is
 * patched in.
 */
test("the installed-package model list renders while the capability probe is still hanging (T6, production-default timing)", { timeout: 300000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  // Well beyond any plausible prompt render, and comfortably inside the
  // production capability budget: if the dropdown waited for the probe at all,
  // this test would fail.
  const PROBE_DELAY_MS = 8000;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-settings-prompt-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const prefixDir = path.join(dir, "npm-prefix");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(prefixDir, { recursive: true });

  // A real installed-package layout plus a deliberately SLOW CLI. No injected
  // provider definition: the Hub uses the production registry and the real
  // worker-backed probe, so the production 10s/20s bounds are the ones in force.
  writeInstalledCommandCodePackage(prefixDir);
  const fake = writeFakeCommandCodeCli(prefixDir, { name: "cmdc", probeDelayMs: PROBE_DELAY_MS, listModels: null });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: fake.shim,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    FAKE_CLI_LOG: fake.log
  };

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, env });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    const modelOptions = (): Promise<string[]> =>
      page.evaluate(
        `Array.from(document.getElementById("defaultModel").options).filter((option) => option.value !== "").map((option) => option.textContent || "")`
      );
    /** One settings select's full option surface, its current selection and disabled state. */
    const selectState = (id: string): Promise<{ values: string[]; texts: string[]; selected: string; disabled: boolean }> =>
      page.evaluate(
        `(() => {
          const select = document.getElementById(${JSON.stringify(id)});
          return {
            values: Array.from(select.options).map((option) => option.value || ""),
            texts: Array.from(select.options).map((option) => option.textContent || ""),
            selected: select.value || "",
            disabled: select.disabled
          };
        })()`
      );
    /**
     * The unambiguous "the capability phase has landed" signal: the effort
     * control is enabled only from real `supports_effort` evidence, so it stays
     * disabled while the evidence is pending.
     */
    const effortEnabled = (): Promise<boolean> =>
      page.evaluate(`document.getElementById("defaultEffort").disabled === false`);

    // ---- Open Settings and time the model dropdown. ----
    const openedAt = Date.now();
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.getElementById("defaultModel").options).filter((option) => option.value !== "").length > 0`,
      60000,
      "the model dropdown to populate"
    );
    const dropdownMs = Date.now() - openedAt;

    assert.ok(
      dropdownMs < PROBE_DELAY_MS,
      `the model dropdown must not wait for the capability probe: it rendered in ${dropdownMs}ms while the probe needs >=${PROBE_DELAY_MS}ms`
    );

    const options = await modelOptions();
    assert.ok(
      options.some((text) => text.includes("stealth/space-bunny-alpha")),
      `the installed package's model list is on screen (got ${JSON.stringify(options.slice(0, 3))}…)`
    );
    assert.ok(
      options.some((text) => text.includes("stealth/pixel-canary") && text.includes("Free now")),
      `an id without 'free' carries the Free-now label from the package's own $0 rates (got ${JSON.stringify(options.slice(0, 3))}…)`
    );
    assert.ok(
      options.every((text) => !text.includes("catalog unavailable")),
      "the dropdown is not an unavailable state while the probe is still running"
    );

    // At this instant the capability evidence genuinely has NOT landed (the
    // probe needs >= PROBE_DELAY_MS), so the honest pending presentation must
    // be visible: ONLY the configured values, plain labels, both controls
    // disabled — never a fabricated "the CLI has no modes" claim and never a
    // transient "check in progress" suffix on the value.
    const firstLoadStatus = await page.evaluate(`(() => {
      const el = document.getElementById("cliInfo");
      return { text: el.textContent || "", hidden: el.classList.contains("hidden"), loading: el.classList.contains("loading") };
    })()`);
    assert.equal(firstLoadStatus.hidden, false, "Command Code keeps visible first-load feedback while initial capability evidence is pending");
    assert.equal(firstLoadStatus.loading, true, "Command Code first-load feedback keeps the loading spinner while capability evidence is pending");
    assert.match(firstLoadStatus.text, /Loading configuration.*First load may take a moment/, "Command Code uses the same concise first-load message as WorkBuddy AI");
    assert.equal(
      await effortEnabled(),
      false,
      "effort stays disabled while the capability evidence is pending"
    );
    const pendingPermission = await selectState("permissionMode");
    assert.deepEqual(
      pendingPermission.texts,
      ["yolo"],
      "the Permission select shows ONLY the configured mode with a plain label while capability is pending"
    );
    assert.equal(pendingPermission.disabled, true, "the Permission select is disabled while capability is pending");
    const pendingEffort = await selectState("defaultEffort");
    assert.deepEqual(
      pendingEffort.texts,
      ["Unspecified (Provider default)"],
      "the Reasoning select shows ONLY the configured provider-default value while capability is pending"
    );
    assert.equal(pendingEffort.disabled, true, "the Reasoning select is disabled while capability is pending");
    console.log(
      `[hub-ui-settings-prompt] EV1 the installed-package model list (${options.length} options, Free-now included) rendered in ${dropdownMs}ms while the capability probe was still hanging; Permission/Reasoning stayed plain (${JSON.stringify(pendingPermission.texts)} / ${JSON.stringify(pendingEffort.texts)}) and disabled`
    );

    // ---- The capability evidence arrives LATER and is patched in. ----
    await waitForPage(page.evaluate, () => `document.getElementById("defaultEffort").disabled === false`, 120000, "the capability evidence to be patched in");
    const capsElapsedMs = Date.now() - openedAt;
    assert.ok(
      capsElapsedMs >= PROBE_DELAY_MS,
      `the capability phase really ran the slow probe (evidence landed ${capsElapsedMs}ms after opening)`
    );
    const recoveredPermission = await selectState("permissionMode");
    assert.deepEqual(
      recoveredPermission.values.sort(),
      ["accept-edits", "plan", "yolo"],
      "the CLI's own permission modes are patched in from the capability phase"
    );
    assert.equal(recoveredPermission.selected, "yolo", "the configured mode stays selected after evidence arrives");
    assert.equal(recoveredPermission.disabled, false, "the Permission select recovers editability from capability evidence");
    const recoveredEffort = await selectState("defaultEffort");
    assert.ok(
      recoveredEffort.values.includes("") && recoveredEffort.values.includes("max"),
      `the reasoning choices are restored from capability evidence (got ${JSON.stringify(recoveredEffort.values)})`
    );
    assert.equal(recoveredEffort.disabled, false, "the Reasoning select recovers editability from capability evidence");
    const recoveredStatus = await page.evaluate(`(() => {
      const el = document.getElementById("cliInfo");
      return { hidden: el.classList.contains("hidden"), loading: el.classList.contains("loading") };
    })()`);
    assert.equal(recoveredStatus.loading, false, "the Command Code loading indicator clears when initial capability evidence arrives");
    assert.equal(recoveredStatus.hidden, true, "healthy Command Code capability evidence leaves no permanent status row");
    // The capability patch must not have disturbed the catalog it was patched into.
    const afterCaps = await modelOptions();
    assert.ok(
      afterCaps.some((text) => text.includes("stealth/space-bunny-alpha")),
      "patching capability evidence leaves the installed model list intact"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("defaultModel").disabled`),
      false,
      "the model dropdown stays usable throughout"
    );
    console.log(
      `[hub-ui-settings-prompt] EV2 the CLI's own permission modes were patched in ${capsElapsedMs}ms after opening (${JSON.stringify(recoveredPermission.values)}), without disturbing the model list`
    );

    // ---- POST-SAVE: once capability evidence is known, the background catalog
    //      + capability verification must not disable the controls again. Saving
    //      ends at the successful config write, not when the slow probe finishes. ----
    await page.evaluate(`(() => {
      const select = document.getElementById("defaultModel");
      select.value = "stealth/space-bunny-alpha";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitForPage(page.evaluate, () => `document.getElementById("saveSettings").disabled === false`, 15000, "the Save button after a model change");
    await page.evaluate(`document.getElementById("saveSettings").click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("settingsMessage").innerText !== "Saving…" && document.getElementById("defaultEffort").disabled === false`,
      15000,
      "the saved form to unlock before the slow post-save capability probe finishes"
    );
    const postSavePermission = await selectState("permissionMode");
    const postSaveEffort = await selectState("defaultEffort");
    assert.equal(postSavePermission.disabled, false, "post-save background verification keeps Permission editable");
    assert.deepEqual(postSavePermission.values.sort(), ["accept-edits", "plan", "yolo"], "known Permission choices remain available during post-save verification");
    assert.equal(postSaveEffort.disabled, false, "post-save background verification keeps Reasoning editable");
    assert.equal(
      await page.evaluate(`document.getElementById("defaultModel").value`),
      "stealth/space-bunny-alpha",
      "the saved model stays visible while the post-save provider verification runs"
    );
    console.log(
      "[hub-ui-settings-prompt] EV3 post-save: Saving finished immediately after persistence and known Permission/Reasoning stayed usable during background verification"
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    resetDefaultSettingsReadsForTests();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T6b — the pending capability presentation across open / switch / save
// ---------------------------------------------------------------------------

/**
 * The DETERMINISTIC delayed-capability regression beside T6's production-timing
 * proof: both Command Code phases are test-controlled, so every pending window
 * lasts exactly as long as this test holds it. Against the SHIPPED client
 * script it proves:
 *
 *   - OPEN / PROVIDER SWITCH / POST-SAVE: while `capabilities.checked === false`
 *     the Permission and Reasoning selects show ONLY the configured values with
 *     plain labels and are disabled — never "capability check in progress",
 *     "capability unconfirmed" or "existing value kept" copy on the controls;
 *   - SAVE SEMANTICS: saving while capability evidence is pending submits the
 *     configured draft values, never the placeholder capability lists; the
 *     default-model and fallback-model Reasoning selections are independent,
 *     so editing the fallback model leaves the default-model effort untouched;
 *   - RECOVERY: patching in real capability evidence restores the supported
 *     choices and normal editability, with the configured value still selected;
 *   - PERSISTENT FAILURE: a capability phase that answers with a probe error
 *     keeps the plain/disabled presentation and is surfaced by the EXISTING
 *     higher-level status line, not through control copy.
 */
test("Command Code first capability read blocks controls, but later refreshes keep known Permission/Reasoning usable", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-capability-pending-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const CONFIGURED_PERMISSION_MODE = "default";
  const CONFIGURED_EFFORT = "max";
  /** A catalog-phase view: real model list, placeholder (NOT checked) capabilities. */
  const pendingCatalogView = (defaultModel: string, fallbackModel: string | null = null) => {
    const view = commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"], defaultModel });
    view.config.permission_mode = CONFIGURED_PERMISSION_MODE;
    view.config.default_effort = CONFIGURED_EFFORT;
    view.config.rate_limit_fallback_model = fallbackModel;
    view.capabilities = { supports_effort: false, permission_modes: [], checked: false };
    return view;
  };
  const capabilityPatch = (modes: string[], supportsEffort: boolean) => ({
    cli: { available: true, version: "9.9.9-test", error: null, checked: true as const },
    capabilities: { supports_effort: supportsEffort, permission_modes: modes, checked: true as const },
    catalog: null,
    model_meta: null
  });
  const FAILED_CAPABILITY_PATCH = {
    cli: {
      available: true,
      version: null,
      error: "the capability probe did not answer within the 20000 ms settings budget; permission modes and reasoning effort stay unconfirmed",
      checked: true as const
    },
    capabilities: { supports_effort: false, permission_modes: [], checked: true as const },
    catalog: null,
    model_meta: null
  };

  const cc = controlledTwoPhaseSettingsProvider("command-code", {
    cli_path: null,
    default_model: "cc/model-a",
    rate_limit_fallback_model: null,
    permission_mode: CONFIGURED_PERMISSION_MODE,
    default_effort: CONFIGURED_EFFORT,
    rate_limit_fallback_effort: null
  });
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    /** One settings select's full option surface, its current selection and disabled state. */
    const selectState = (id: string): Promise<{ values: string[]; texts: string[]; selected: string; disabled: boolean }> =>
      page.evaluate(
        `(() => {
          const select = document.getElementById(${JSON.stringify(id)});
          return {
            values: Array.from(select.options).map((option) => option.value || ""),
            texts: Array.from(select.options).map((option) => option.textContent || ""),
            selected: select.value || "",
            disabled: select.disabled
          };
        })()`
      );
    const selectProvider = async (provider: "command-code" | "workbuddy-ai"): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("settingsProvider");
        select.value = ${JSON.stringify(provider)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };
    /** The plain/disabled pending state: one option each, both controls disabled. */
    const waitForPendingPresentation = (): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => {
            const permission = document.getElementById("permissionMode");
            const defaultEffort = document.getElementById("defaultEffort");
            const fallbackEffort = document.getElementById("fallbackEffort");
            return permission.disabled && permission.options.length === 1
              && defaultEffort.disabled && defaultEffort.options.length === 1
              && fallbackEffort.disabled && fallbackEffort.options.length === 1;
          })()`,
        30000,
        "the plain/disabled pending capability presentation"
      );
    const waitForRecovery = (): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => {
            const permission = document.getElementById("permissionMode");
            const defaultEffort = document.getElementById("defaultEffort");
            const fallbackEffort = document.getElementById("fallbackEffort");
            return !permission.disabled && permission.options.length >= 4 && !defaultEffort.disabled && !fallbackEffort.disabled;
          })()`,
        30000,
        "the capability evidence to restore the choices"
      );
    const assertPendingPresentation = async (label: string): Promise<void> => {
      const permission = await selectState("permissionMode");
      assert.deepEqual(
        permission.texts,
        [CONFIGURED_PERMISSION_MODE],
        `${label}: Permission shows ONLY the configured mode with a plain label while pending`
      );
      assert.equal(permission.disabled, true, `${label}: Permission is disabled while pending`);
      const defaultEffort = await selectState("defaultEffort");
      assert.deepEqual(
        defaultEffort.texts,
        [CONFIGURED_EFFORT],
        `${label}: default-model Reasoning shows ONLY the configured effort with a plain label while pending`
      );
      assert.equal(defaultEffort.disabled, true, `${label}: default-model Reasoning is disabled while pending`);
      const fallbackEffort = await selectState("fallbackEffort");
      assert.deepEqual(
        fallbackEffort.texts,
        ["Unspecified (Provider default)"],
        `${label}: fallback-model Reasoning shows ONLY its own configured (unset) value, plain, while pending`
      );
      assert.equal(fallbackEffort.disabled, true, `${label}: fallback-model Reasoning is disabled while pending`);
      assert.doesNotMatch(
        [...permission.texts, ...defaultEffort.texts, ...fallbackEffort.texts].join(" | "),
        /capability|unconfirmed|existing value|check in progress/i,
        `${label}: no transient technical capability copy on the controls`
      );
    };
    const setSelectValue = async (id: string, value: string): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event("change"));
      })()`);
      await waitForPage(page.evaluate, () => `document.getElementById("saveSettings").disabled === false`, 15000, "the Save button after a settings change");
    };
    const setFallbackModel = (model: string): Promise<void> => setSelectValue("fallbackModel", model);

    // ---- 1) INITIAL OPEN: catalog phase answers, capability phase is held. ----
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitFor(() => cc.catalogCalls === 1, 10000, "the initial Command Code catalog read");
    cc.settleCatalog(0, { ok: true, view: pendingCatalogView("cc/model-a") });
    await waitForPendingPresentation();
    await assertPendingPresentation("initial open");
    await waitFor(() => cc.capabilityCalls === 1, 10000, "the initial capability read");
    cc.settleCapabilities(0, { ok: true, view: capabilityPatch(["plan", "accept-edits", "yolo"], true) });
    await waitForRecovery();
    const openedPermission = await selectState("permissionMode");
    assert.equal(openedPermission.selected, CONFIGURED_PERMISSION_MODE, "the configured mode stays selected after the initial open evidence");
    assert.ok(
      openedPermission.values.includes(CONFIGURED_PERMISSION_MODE),
      "the configured mode outside the published list stays available, plain"
    );
    const openedEffort = await selectState("defaultEffort");
    assert.equal(openedEffort.selected, CONFIGURED_EFFORT, "the configured default-model effort stays selected after the initial open evidence");
    console.log(
      `[hub-ui-capability-pending] EV1 initial open: plain/disabled pending, then real choices restored (${JSON.stringify(openedPermission.values)})`
    );

    // ---- 2) PROVIDER SWITCH-BACK: once capability evidence has been learned,
    //         a later catalog refresh must NOT disable Permission/Reasoning.
    //         The fresh capability phase replaces the known evidence when it
    //         arrives, but the controls stay usable while that happens. ----
    await selectProvider("workbuddy-ai");
    await waitFor(() => wb.calls === 1, 10000, "the WorkBuddy read");
    wb.settleAt(0, {
      ok: true,
      view: workBuddyAiSettingsView({ models: ["deepseek-v4.1-flash"], offeredModels: ["deepseek-v4.1-flash"] })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 30000, "the WorkBuddy form");

    await selectProvider("command-code");
    await waitFor(() => cc.catalogCalls === 2, 10000, "the switch-back catalog read");
    cc.settleCatalog(1, { ok: true, view: pendingCatalogView("cc/model-a") });
    await waitForRecovery();
    assert.equal((await selectState("defaultEffort")).disabled, false, "provider switch-back keeps Reasoning selectable while fresh capability evidence is pending");
    assert.equal((await selectState("permissionMode")).disabled, false, "provider switch-back keeps Permission selectable while fresh capability evidence is pending");

    // Editing the FALLBACK model (not the default one) proves the two
    // Reasoning selections are independent: the default-model effort must
    // survive a fallback edit untouched, while the fallback's own effort
    // follows its own (here unset) configuration.
    await setFallbackModel("cc/model-b");
    await page.evaluate(`document.getElementById("saveSettings").click()`);
    await waitFor(() => cc.savedPatches.length === 1, 10000, "the save PUT");
    const pendingSavePatch = cc.savedPatches[0];
    if (!pendingSavePatch) assert.fail("the save PUT was not recorded");
    assert.equal(
      pendingSavePatch.permission_mode,
      CONFIGURED_PERMISSION_MODE,
      "a save during background capability refresh submits the current permission mode"
    );
    assert.equal(
      pendingSavePatch.default_effort,
      CONFIGURED_EFFORT,
      "a save during background capability refresh submits the current default-model effort, undisturbed by the fallback edit"
    );
    assert.equal(pendingSavePatch.rate_limit_fallback_model, "cc/model-b", "the edited fallback model is submitted");
    assert.equal(pendingSavePatch.default_model, "cc/model-a", "the untouched default model is submitted unchanged");

    await waitForPage(
      page.evaluate,
      () => `document.getElementById("settingsMessage").innerText !== "Saving…" && document.getElementById("defaultEffort").disabled === false`,
      15000,
      "Saving to finish before provider verification completes"
    );
    await waitFor(() => cc.catalogCalls === 3, 10000, "the post-save catalog read");
    assert.equal((await selectState("defaultEffort")).disabled, false, "post-save provider verification does not hold the Reasoning control locked");
    cc.settleCatalog(2, { ok: true, view: pendingCatalogView("cc/model-a", "cc/model-b") });
    await waitForRecovery();

    // The pre-save capability read (index 1) was detached by the save; settling
    // it now must not disturb the view. The post-save capability read (index 2)
    // is the one that restores the choices.
    cc.settleCapabilities(1, { ok: true, view: capabilityPatch(["plan", "accept-edits", "yolo"], true) });
    await waitFor(() => cc.capabilityCalls === 3, 10000, "the post-save capability read");
    cc.settleCapabilities(2, { ok: true, view: capabilityPatch(["plan", "accept-edits", "yolo"], true) });
    await waitForRecovery();
    assert.equal(
      await page.evaluate(`document.getElementById("fallbackModel").value`),
      "cc/model-b",
      "the saved fallback model stays selected after the post-save capability evidence"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("defaultModel").value`),
      "cc/model-a",
      "the untouched default model stays selected after the post-save capability evidence"
    );
    console.log(
      "[hub-ui-capability-pending] EV2 switch-back + post-save: known controls stayed usable while fresh verification ran"
    );

    // ---- 3) PERSISTENT FAILURE: the capability phase answers with a probe
    //         error; the controls stay plain/disabled and the EXISTING
    //         higher-level status line carries the failure. ----
    await setFallbackModel("");
    await page.evaluate(`document.getElementById("saveSettings").click()`);
    await waitFor(() => cc.catalogCalls === 4, 10000, "the failed-capability post-save catalog read");
    cc.settleCatalog(3, { ok: true, view: pendingCatalogView("cc/model-a", null) });
    await waitForRecovery();
    await waitFor(() => cc.capabilityCalls === 4, 10000, "the failed capability read");
    cc.settleCapabilities(3, { ok: true, view: FAILED_CAPABILITY_PATCH });
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("cliInfo").innerText || "").includes("Command Code capability check failed.")`,
      30000,
      "the existing higher-level capability failure status"
    );
    const failureStatus = String(await page.evaluate(`document.getElementById("cliInfo").innerText`));
    assert.match(failureStatus, /capability probe did not answer/, "the higher-level status carries the real failure detail");
    const failedPermission = await selectState("permissionMode");
    assert.deepEqual(failedPermission.texts, [CONFIGURED_PERMISSION_MODE], "a failed capability phase keeps the configured mode, plain");
    assert.equal(failedPermission.disabled, true, "a failed capability phase leaves Permission disabled");
    const failedEffort = await selectState("defaultEffort");
    assert.deepEqual(
      failedEffort.texts,
      ["Unspecified (Provider default)", CONFIGURED_EFFORT],
      "a failed capability phase keeps the configured default-model effort, plain"
    );
    assert.equal(failedEffort.disabled, true, "a failed capability phase leaves default-model Reasoning disabled");
    assert.doesNotMatch(
      [...failedPermission.texts, ...failedEffort.texts].join(" | "),
      /capability|unconfirmed|existing value|check in progress/i,
      "a persistent capability failure never becomes transient control copy"
    );
    assert.doesNotMatch(
      String(await page.evaluate(`document.getElementById("settingsMessage").innerText`)),
      /capability|unconfirmed|existing value/i,
      "the save/status message is not polluted with capability copy"
    );
    console.log(
      `[hub-ui-capability-pending] EV3 persistent failure: status line reports it (${JSON.stringify(failureStatus.split("\n")[0])}); controls stayed plain/disabled`
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Row 46 — the Permission dropdown keeps ONE width while data is still arriving
// ---------------------------------------------------------------------------

/**
 * The reported defect: the Permission dropdown was sized from whatever option
 * list happened to be on screen — an empty select while the fresh read ran,
 * then ONLY the configured mode while Command Code's capability phase was
 * pending — so it visibly jumped to its final, wider width once the real
 * choices arrived. Both providers share the same row, so both are measured
 * here in the real browser at a fixed viewport: the bounding width must be
 * IDENTICAL in the loading, the capability-pending and the ready state, at a
 * normal and a narrow viewport. The note/tooltip contract, the intended hidden
 * state of the non-selected provider card and the absence of page-level
 * horizontal overflow are asserted beside it.
 */
test("Permission dropdown width is identical before and after capability/settings readiness for both providers (row 46)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-permission-width-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  // Screenshots are disposable evidence under the OS temp dir, NOT test data
  // inside the workspace; the paths are logged by the test.
  const evidenceDir = path.join(os.tmpdir(), "jobquay-permission-width-evidence");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const CONFIGURED_PERMISSION_MODE = "yolo";
  const WB_CONFIGURED_PERMISSION_MODE = "plan";
  const CC_READY_MODES = ["plan", "accept-edits", "yolo"];
  /** A catalog-phase view: real model list, placeholder (NOT checked) capabilities. */
  const pendingCatalogView = () => {
    const view = commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"], defaultModel: "cc/model-a" });
    view.config.permission_mode = CONFIGURED_PERMISSION_MODE;
    view.capabilities = { supports_effort: false, permission_modes: [], checked: false };
    return view;
  };
  const capabilityPatch = () => ({
    cli: { available: true, version: "9.9.9-test", error: null, checked: true as const },
    capabilities: { supports_effort: true, permission_modes: CC_READY_MODES, checked: true as const },
    catalog: null,
    model_meta: null
  });
  /** The complete WorkBuddy view: all seven native modes, five normal choices. */
  const workBuddyView = () => {
    const view = workBuddyAiSettingsView({ models: ["deepseek-v4.1-flash", "hy3"], offeredModels: ["deepseek-v4.1-flash", "hy3"] });
    view.config.permission_mode = WB_CONFIGURED_PERMISSION_MODE;
    view.capabilities.permission_modes = ["default", "plan", "accept-edits", "yolo", "dont-ask", "auto", "full-access"];
    return view;
  };

  const cc = controlledTwoPhaseSettingsProvider("command-code", {
    cli_path: null,
    default_model: "cc/model-a",
    rate_limit_fallback_model: null,
    permission_mode: CONFIGURED_PERMISSION_MODE,
    default_effort: null,
    rate_limit_fallback_effort: null
  });
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));
    const browser = cdp;

    const page = await newPage(browser, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    /** One Permission dropdown's real box width plus the state that explains it. */
    const widthState = (id: string): Promise<{ width: number; options: number; disabled: boolean; selected: string; visible: boolean }> =>
      page.evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        const box = select.getBoundingClientRect();
        return {
          width: box.width,
          options: select.options.length,
          disabled: select.disabled,
          selected: select.value || "",
          visible: box.width > 0 && box.height > 0 && !!select.offsetParent
        };
      })()`);
    const measured: Array<{ state: string; width: number; options: number }> = [];
    const measure = async (state: string, id: string) => {
      const value = await widthState(id);
      measured.push({ state, width: value.width, options: value.options });
      return value;
    };
    const assertSameWidth = (label: string, before: { width: number; options: number }, after: { width: number; options: number }): void => {
      assert.equal(
        Math.abs(before.width - after.width) <= 0.5,
        true,
        `${label}: the Permission dropdown width must not change when the option list changes (${before.width}px with ${before.options} option(s) -> ${after.width}px with ${after.options} option(s))`
      );
    };
    const screenshot = async (name: string, scrollId: string): Promise<void> => {
      await page.evaluate(`document.getElementById(${JSON.stringify(scrollId)}).scrollIntoView({ block: "start" })`);
      const shot: any = await browser.send("Page.captureScreenshot", { format: "png" }, page.sessionId);
      const file = path.join(evidenceDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`[hub-ui-permission-width] screenshot ${file}`);
    };
    const selectProvider = async (provider: "command-code" | "workbuddy-ai"): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("settingsProvider");
        select.value = ${JSON.stringify(provider)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };
    const waitForCcPending = (): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => {
            const select = document.getElementById("permissionMode");
            return select.disabled && select.options.length === 1 && select.value === ${JSON.stringify(CONFIGURED_PERMISSION_MODE)};
          })()`,
        30000,
        "the capability-pending Permission presentation"
      );
    const waitForCcReady = (): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => {
            const select = document.getElementById("permissionMode");
            return !select.disabled && select.options.length === ${CC_READY_MODES.length};
          })()`,
        30000,
        "the real Command Code Permission choices"
      );
    const waitForWbReady = (): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => {
            const select = document.getElementById("wbPermissionMode");
            return !select.disabled && select.options.length === 5 && select.value === ${JSON.stringify(WB_CONFIGURED_PERMISSION_MODE)};
          })()`,
        30000,
        "the real WorkBuddy Permission choices"
      );
    /** The single-line note contract that must survive the width fix. */
    const assertNoteContract = async (label: string, noteId: string, selectId: string, expectedText: string): Promise<any> => {
      const note = await permissionNoteState(page, noteId, selectId);
      assert.equal(note.whiteSpace, "nowrap", `${label}: the note never wraps`);
      assert.equal(note.height < 30, true, `${label}: the note stays single-line`);
      assert.equal(note.text, expectedText, `${label}: the complete note stays the textContent`);
      assert.equal(note.sameRowAsSelect && note.sameRowAsLabel, true, `${label}: label, dropdown and note share one row`);
      if (note.scrollWidth > note.clientWidth) {
        assert.equal(note.fontSize, "12px", `${label}: a truncated note uses the 12px step`);
        assert.equal(note.title, expectedText, `${label}: the truncated note carries the full text as its tooltip`);
      } else {
        assert.equal(note.fontSize, "13px", `${label}: a note that fits stays at 13px`);
        assert.equal(note.title, "", `${label}: a note that fits carries no tooltip`);
      }
      return note;
    };

    // ---- Normal viewport: CC loading -> capability-pending -> ready. ----
    await setViewport(browser, page, 1280, 900);
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitFor(() => cc.catalogCalls === 1, 10000, "the Command Code catalog read");
    const ccLoading = await measure("cc loading (catalog read in flight)", "permissionMode");
    assert.equal(ccLoading.options, 0, "the loading form holds no Permission choices yet");
    assert.equal(ccLoading.disabled, true, "the loading Permission control is locked");
    assert.equal(ccLoading.visible, true, "the Command Code form is visible (locked) while its fresh read runs");
    await screenshot("cc-loading-1280", "commandCodeSettingsCard");

    cc.settleCatalog(0, { ok: true, view: pendingCatalogView() });
    await waitForCcPending();
    const ccPending = await measure("cc capability pending (configured mode only)", "permissionMode");
    assert.equal(ccPending.disabled, true, "the pending Permission control stays locked");
    await screenshot("cc-pending-1280", "commandCodeSettingsCard");

    cc.settleCapabilities(0, { ok: true, view: capabilityPatch() });
    await waitForCcReady();
    const ccReady = await measure("cc ready (published modes)", "permissionMode");
    await screenshot("cc-ready-1280", "commandCodeSettingsCard");
    console.log(
      `[hub-ui-permission-width] EV1 CC 1280px: loading=${ccLoading.width}px/${ccLoading.options} option(s), ` +
        `pending=${ccPending.width}px/${ccPending.options} option(s), ready=${ccReady.width}px/${ccReady.options} option(s)`
    );
    assertSameWidth("Command Code at 1280px", ccLoading, ccPending);
    assertSameWidth("Command Code at 1280px", ccPending, ccReady);
    assert.equal(ccReady.selected, CONFIGURED_PERMISSION_MODE, "the configured mode stays selected once the choices arrive");

    // The non-selected provider's form is INTENTIONALLY hidden while Command
    // Code is read: no layout box, so no width contract can apply to it here.
    const wbHidden = await page.evaluate(`(() => {
      const card = document.getElementById("workBuddySettingsCard");
      const box = document.getElementById("wbPermissionMode").getBoundingClientRect();
      return { cardHidden: card.classList.contains("hidden"), width: box.width, height: box.height };
    })()`);
    assert.equal(wbHidden.cardHidden, true, "the WorkBuddy card is intentionally hidden while Command Code is the selected provider");
    assert.equal(
      wbHidden.width === 0 && wbHidden.height === 0,
      true,
      `the hidden WorkBuddy Permission dropdown has no layout box (${wbHidden.width}x${wbHidden.height})`
    );

    // ---- Normal viewport: WB loading -> ready (the reported WB analogue). ----
    await selectProvider("workbuddy-ai");
    await waitFor(() => wb.calls === 1, 10000, "the WorkBuddy settings read");
    const wbLoading = await measure("wb loading (fresh read in flight)", "wbPermissionMode");
    assert.equal(wbLoading.options, 0, "the WorkBuddy loading form holds no Permission choices yet");
    assert.equal(wbLoading.disabled, true, "the WorkBuddy loading Permission control is locked");
    assert.equal(wbLoading.visible, true, "the WorkBuddy form is visible (locked) while its fresh read runs");
    await screenshot("wb-loading-1280", "workBuddySettingsCard");

    wb.settleAt(0, { ok: true, view: workBuddyView() });
    await waitForWbReady();
    const wbReady = await measure("wb ready (published modes)", "wbPermissionMode");
    await screenshot("wb-ready-1280", "workBuddySettingsCard");
    const wbLabels = (await page.evaluate(`Array.from(document.getElementById("wbPermissionMode").options).map((o) => o.textContent)`)) as string[];
    console.log(
      `[hub-ui-permission-width] EV2 WB 1280px: loading=${wbLoading.width}px/${wbLoading.options} option(s), ` +
        `ready=${wbReady.width}px/${wbReady.options} option(s), labels=${JSON.stringify(wbLabels)}`
    );
    assertSameWidth("WorkBuddy at 1280px", wbLoading, wbReady);
    assert.ok(wbLabels.includes("Full Access"), "the ready WorkBuddy list keeps the Full Access label");

    // ---- Narrow viewport: both providers are already loaded. Fresh switch-back
    //      reads keep the known Permission choices usable while replacing evidence. ----
    await setViewport(browser, page, 640, 480);
    await selectProvider("command-code");
    await waitFor(() => cc.catalogCalls === 2, 10000, "the narrow switch-back catalog read");
    const ccNarrowRefreshing = await measure("cc background refresh (640px)", "permissionMode");
    assert.equal(ccNarrowRefreshing.options, CC_READY_MODES.length, "the narrow switch-back keeps the known Command Code Permission choices");
    assert.equal(ccNarrowRefreshing.disabled, false, "the narrow switch-back keeps Command Code Permission usable");
    assert.equal(ccNarrowRefreshing.visible, true, "the known narrow Command Code form remains visible during refresh");
    assert.equal(await page.evaluate(`document.getElementById("cliInfo").classList.contains("loading")`), false, "the narrow Command Code switch-back never returns to provider-level loading");
    cc.settleCatalog(1, { ok: true, view: pendingCatalogView() });
    await waitFor(() => cc.capabilityCalls === 2, 10000, "the narrow capability refresh");
    await waitForCcReady();
    const ccNarrowPending = await measure("cc catalog replaced / capability refreshing (640px)", "permissionMode");
    assert.equal(ccNarrowPending.disabled, false, "known Command Code Permission stays usable while fresh capability evidence is pending");
    cc.settleCapabilities(1, { ok: true, view: capabilityPatch() });
    await waitForCcReady();
    const ccNarrowReady = await measure("cc ready (640px)", "permissionMode");
    await screenshot("cc-ready-640", "commandCodeSettingsCard");
    console.log(
      `[hub-ui-permission-width] EV3 CC 640px: refreshing=${ccNarrowRefreshing.width}px/${ccNarrowRefreshing.options} option(s), ` +
        `pending=${ccNarrowPending.width}px/${ccNarrowPending.options} option(s), ready=${ccNarrowReady.width}px/${ccNarrowReady.options} option(s)`
    );
    assertSameWidth("Command Code at 640px", ccNarrowRefreshing, ccNarrowPending);
    assertSameWidth("Command Code at 640px", ccNarrowPending, ccNarrowReady);
    await assertNoteContract("Command Code at 640px", "yoloWarning", "permissionMode", COMMAND_CODE_YOLO_NOTE_TEXT);
    assert.equal(
      await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
      true,
      "the 640px Command Code Permission row never stretches the page horizontally"
    );

    await selectProvider("workbuddy-ai");
    await waitFor(() => wb.calls === 2, 10000, "the narrow WorkBuddy read");
    const wbNarrowRefreshing = await measure("wb background refresh (640px)", "wbPermissionMode");
    assert.equal(wbNarrowRefreshing.options, 5, "the narrow WorkBuddy switch-back keeps the known Permission choices");
    assert.equal(wbNarrowRefreshing.disabled, false, "the narrow WorkBuddy switch-back keeps Permission usable");
    assert.equal(wbNarrowRefreshing.visible, true, "the known narrow WorkBuddy form remains visible during refresh");
    assert.equal(await page.evaluate(`document.getElementById("wbCliInfo").classList.contains("loading")`), false, "the narrow WorkBuddy switch-back never returns to provider-level loading");
    wb.settleAt(1, { ok: true, view: workBuddyView() });
    await waitForWbReady();
    const wbNarrowReady = await measure("wb ready (640px)", "wbPermissionMode");
    await screenshot("wb-ready-640", "workBuddySettingsCard");
    console.log(
      `[hub-ui-permission-width] EV4 WB 640px: refreshing=${wbNarrowRefreshing.width}px/${wbNarrowRefreshing.options} option(s), ` +
        `ready=${wbNarrowReady.width}px/${wbNarrowReady.options} option(s)`
    );
    assertSameWidth("WorkBuddy at 640px", wbNarrowRefreshing, wbNarrowReady);
    await assertNoteContract("WorkBuddy at 640px", "wbYoloWarning", "wbPermissionMode", PLAN_NOTE_TEXT);
    assert.equal(
      await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
      true,
      "the 640px WorkBuddy Permission row never stretches the page horizontally"
    );
    console.log(`[hub-ui-permission-width] EV5 measured widths: ${measured.map((m) => `${m.state}=${m.width}px`).join(", ")}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The canonical telemetry contract at the UI boundary
// ---------------------------------------------------------------------------

/**
 * ONE canonical JobUsage payload rendered under TWO different provider ids.
 *
 * This is the provider-independence contract: the shared usage renderer reads
 * only the canonical fields, so the metric text and tooltip must be BYTE
 * IDENTICAL for both providers (only the provider label may differ). It is
 * exercised in the real page so it proves the shipped `formatUsage`, not a
 * re-implementation of it in the test.
 */
test("the shared usage renderer is provider-independent for one canonical JobUsage payload", { timeout: 180000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-usage-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const project = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    // The canonical payload carries BOTH additive metrics and the context
    // gauges; `totalCostUsd` is deliberately absent (unavailable) so the test
    // also proves an unreported metric renders nothing at all. The context
    // gauges stay in the PAYLOAD on purpose: the Dashboard must not present
    // them even when the canonical telemetry really carries them. `tokensOut`
    // (90) deliberately EXCEEDS the paired `decodeTokens` (40): the total
    // covers responses whose output was never timed, so the old formula
    // (total tokensOut / decodeSeconds = 45.0 tok/s) must never be rendered —
    // only the paired 40 / 2 = 20.0 tok/s.
    const canonicalUsage = {
      tokensIn: 1234,
      tokensOut: 90,
      toolCalls: 3,
      cacheRead: 300,
      cacheMiss: 100,
      cacheCreation: 25,
      credits: 0.5,
      totalCostUsd: null,
      decodeTokens: 40,
      decodeSeconds: 2,
      contextUsed: 1200,
      contextWindow: 200000
    };
    const created = (["command-code", "workbuddy-ai"] as const).map((provider) => {
      const job = createJobRecord({
        task: `USAGE_CONTRACT_${provider}`,
        cwd: project,
        provider,
        model: "canonical-model"
      });
      job.status = "done";
      job.usage = { ...canonicalUsage };
      saveJob(root, job);
      return job;
    });
    // Two records whose payload does NOT contain a paired decode sample:
    // seconds without the response's own token count, and paired tokens
    // without an interval. The old formula (total tokensOut / decodeSeconds)
    // would have rendered "Decode 45.0 tok/s" for the first; the paired
    // contract must omit Decode entirely instead of guessing a rate.
    const unpairedSeconds = createJobRecord({
      task: "USAGE_CONTRACT_UNPAIRED_SECONDS",
      cwd: project,
      provider: "workbuddy-ai",
      model: "canonical-model"
    });
    unpairedSeconds.status = "done";
    unpairedSeconds.usage = { ...canonicalUsage, decodeTokens: null };
    saveJob(root, unpairedSeconds);
    const unpairedTokens = createJobRecord({
      task: "USAGE_CONTRACT_UNPAIRED_TOKENS",
      cwd: project,
      provider: "command-code",
      model: "canonical-model"
    });
    unpairedTokens.status = "done";
    unpairedTokens.usage = { ...canonicalUsage, decodeSeconds: null };
    saveJob(root, unpairedTokens);
    // Historical WorkBuddy record from before cacheMiss was mapped: input and
    // cacheRead are persisted, cacheMiss is absent. The shared renderer should
    // restore the old hit-rate display from the inclusive input denominator
    // without rewriting the stored telemetry.
    const legacyCache = createJobRecord({
      task: "USAGE_CONTRACT_LEGACY_CACHE",
      cwd: project,
      provider: "workbuddy-ai",
      model: "canonical-model"
    });
    legacyCache.status = "done";
    legacyCache.usage = {
      ...canonicalUsage,
      tokensIn: 1000,
      cacheRead: 900,
      cacheMiss: null,
      decodeTokens: null,
      decodeSeconds: null
    };
    saveJob(root, legacyCache);
    // A WorkBuddy job whose canonical usage now reflects the provider's real
    // prompt-cache evidence (non-zero prompt_cache_hit_tokens /
    // prompt_cache_miss_tokens that used to be shadowed by zero placeholder
    // aliases). The ONE shared provider-neutral renderer must show the
    // weighted non-zero percentage from the corrected totals — there is no
    // WorkBuddy-specific branch in the Dashboard.
    const correctedCache = createJobRecord({
      task: "USAGE_CONTRACT_CORRECTED_CACHE",
      cwd: project,
      provider: "workbuddy-ai",
      model: "canonical-model"
    });
    correctedCache.status = "done";
    correctedCache.usage = {
      ...canonicalUsage,
      tokensIn: 28795,
      cacheRead: 3584,
      cacheMiss: 25211,
      decodeTokens: null,
      decodeSeconds: null
    };
    saveJob(root, correctedCache);
    // The pinned dsh aggregate acceptance vector (92,651 output tokens over
    // 342.433 s of first-token → assembled-message spans): the shared renderer
    // must divide exactly these dsh-exact paired totals — 270.6 tok/s — and
    // never the run's total tokensOut.
    const pinnedDshDecode = createJobRecord({
      task: "USAGE_CONTRACT_PINNED_DSH_DECODE",
      cwd: project,
      provider: "workbuddy-ai",
      model: "canonical-model"
    });
    pinnedDshDecode.status = "done";
    pinnedDshDecode.usage = {
      ...canonicalUsage,
      decodeTokens: 92_651,
      decodeSeconds: 342.433
    };
    saveJob(root, pinnedDshDecode);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#jobs button.job")).some((b) => b.dataset.jobId === ${JSON.stringify(created[1]!.id)})`,
      15000,
      "both canonical usage sessions in the sidebar"
    );

    const readUsage = async (jobId: string) => {
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]').click()`);
      // Wait for the DETAIL to really be this job before reading: the previous
      // job's usage text is still on screen until the new response renders. A
      // synthetic record has no user-message history, so its title is its id.
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(jobId)} && (document.getElementById("jobUsage").textContent || "").length > 0`,
        15000,
        `usage text of ${jobId}`
      );
      return await page.evaluate(`({
        text: document.getElementById("jobUsage").textContent,
        title: document.getElementById("jobUsage").title,
        provider: document.getElementById("jobProvider").textContent
      })`) as { text: string; title: string; provider: string };
    };

    const commandCode = await readUsage(created[0]!.id);
    const workBuddy = await readUsage(created[1]!.id);

    assert.notEqual(commandCode.provider, workBuddy.provider, "the two records really are different providers");
    assert.equal(commandCode.text, workBuddy.text, "the metric text must not depend on the provider id");
    assert.equal(commandCode.title, workBuddy.title, "the tooltip must not depend on the provider id");
    assert.equal(
      commandCode.text,
      "Input 1,234 · Output 90 · Cache 75.0% · Tools 3 · Decode 20.0 tok/s · Credits 0.5",
      "every canonical metric renders from the canonical payload alone, and Decode divides the PAIRED numerator only"
    );
    assert.equal(
      commandCode.title,
      "cache hit 300 · cache miss 100 · cache write 25 · paired decode 40 tokens / 2.00s"
    );
    // Context stays in the canonical payload (the API/MCP keep serving it) but
    // is not presented in the Dashboard UI: no visible text, no hover title.
    assert.equal(commandCode.text.includes("Context"), false, "context occupancy is not rendered");
    assert.equal(commandCode.title.includes("context"), false, "context occupancy is not in the tooltip either");
    assert.equal(commandCode.text.includes("Cost"), false, "an unavailable metric renders nothing (never 0)");

    // Without a paired numerator/denominator the Decode metric is OMITTED —
    // the renderer never falls back to total tokensOut or to raw seconds.
    const unpairedSecondsUsage = await readUsage(unpairedSeconds.id);
    assert.equal(
      unpairedSecondsUsage.text,
      "Input 1,234 · Output 90 · Cache 75.0% · Tools 3 · Credits 0.5",
      "decode seconds without the response's own token count produce no rate"
    );
    const unpairedTokensUsage = await readUsage(unpairedTokens.id);
    assert.equal(
      unpairedTokensUsage.text,
      "Input 1,234 · Output 90 · Cache 75.0% · Tools 3 · Credits 0.5",
      "paired tokens without a paired interval produce no rate"
    );
    const legacyCacheUsage = await readUsage(legacyCache.id);
    assert.equal(
      legacyCacheUsage.text,
      "Input 1,000 · Output 90 · Cache 90.0% · Tools 3 · Credits 0.5",
      "historical WorkBuddy records with input+cacheRead but no cacheMiss regain the cache-hit percentage"
    );
    assert.equal(
      legacyCacheUsage.title.includes("cache miss"),
      false,
      "the UI may recover the percentage but must not fabricate a persisted/tooltip cache-miss measurement"
    );
    const correctedCacheUsage = await readUsage(correctedCache.id);
    assert.equal(
      correctedCacheUsage.text,
      "Input 28,795 · Output 90 · Cache 12.4% · Tools 3 · Credits 0.5",
      "corrected WorkBuddy prompt-cache totals render a non-zero WEIGHTED cache percentage through the one shared renderer"
    );
    assert.equal(
      correctedCacheUsage.title,
      "cache hit 3,584 · cache miss 25,211 · cache write 25",
      "the tooltip carries the corrected canonical counters, still provider-neutral"
    );
    const pinnedDshUsage = await readUsage(pinnedDshDecode.id);
    assert.equal(
      pinnedDshUsage.text,
      "Input 1,234 · Output 90 · Cache 75.0% · Tools 3 · Decode 270.6 tok/s · Credits 0.5",
      "the pinned dsh aggregate vector renders as the corrected ratio of sums (92,651 / 342.433)"
    );
    assert.equal(
      pinnedDshUsage.title,
      "cache hit 300 · cache miss 100 · cache write 25 · paired decode 92,651 tokens / 342.43s",
      "the tooltip shows the dsh-exact paired totals in the canonical fields"
    );
    console.log(
      `[hub-ui-browser] EV7 provider-independent usage (${commandCode.provider} vs ${workBuddy.provider}): ${JSON.stringify(commandCode.text)}`
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Session Runtime — provider-neutral wall clock in the real page
// ---------------------------------------------------------------------------

/**
 * The session Runtime contract in a REAL browser against the SHIPPED client:
 *   - a running session shows now − started_at and ADVANCES on the existing
 *     2.5s refresh cadence (no new timer);
 *   - a terminal session shows finished_at − started_at and never grows;
 *   - absent started_at (queued), a terminal record with no finished_at,
 *     malformed timestamps and negative spans all render NOTHING;
 *   - the metric is provider-neutral: the same span renders identically for
 *     Command Code and WorkBuddy records.
 */
test("the session Runtime is a provider-neutral wall clock that advances while running and freezes when terminal", { timeout: 180000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-runtime-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const project = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    const makeJob = (provider: string, status: JobStatus, startedAt: string | null, finishedAt: string | null) => {
      const job = createJobRecord({ task: `RUNTIME_CONTRACT_${provider}_${status}`, cwd: project, provider, model: "canonical-model" });
      job.status = status;
      job.startedAt = startedAt;
      job.finishedAt = finishedAt;
      saveJob(root, job);
      return job;
    };
    // Started 2m 14s ago: the rendered value must be ≥ 2m 14s and must grow
    // across refresh cycles while the record stays "running".
    const running = makeJob("command-code", "running", new Date(Date.now() - 134_000).toISOString(), null);
    // A finished session: 1h 03m 20s of wall time, rendered compactly.
    const done = makeJob("workbuddy-ai", "done", "2026-01-01T00:00:00.000Z", "2026-01-01T01:03:20.000Z");
    // Cases that must render NOTHING.
    const neverStarted = makeJob("command-code", "queued", null, null);
    const openEnd = makeJob("workbuddy-ai", "done", "2026-01-01T00:00:00.000Z", null);
    const malformed = makeJob("command-code", "running", "not-a-date", null);
    // A host-crash shape: the durable log ended at tool_running, but the owner
    // and its CLI tree are gone. Hub read reconciliation must make the job
    // interrupted and the live UI must not keep claiming the tool is running.
    const deadOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const deadOwnerPid = deadOwner.pid;
    assert.ok(deadOwnerPid);
    await new Promise<void>((resolve) => deadOwner.once("exit", () => resolve()));
    const staleTool = makeJob(
      "workbuddy-ai",
      "running",
      new Date(Date.now() - 60_000).toISOString(),
      null
    );
    staleTool.owner = `jobquay-${deadOwnerPid}-browser-host-restart`;
    staleTool.ownerPid = deadOwnerPid!;
    staleTool.heartbeatAt = new Date(Date.now() - 60_000).toISOString();
    staleTool.childPid = null;
    saveJob(root, staleTool);
    appendLog(
      root,
      staleTool.id,
      JSON.stringify({ type: "event", event: { type: "tool_running", toolCallId: "stale-grep", toolName: "Grep" } })
    );

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#jobs button.job")).some((b) => b.dataset.jobId === ${JSON.stringify(running.id)})`,
      15000,
      "the runtime sessions in the sidebar"
    );

    const readRuntime = async (jobId: string): Promise<string> => {
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]').click()`);
      // Wait for the DETAIL to really be this job before reading: the previous
      // job's runtime text is still on screen until the new response renders.
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(jobId)}`,
        15000,
        `detail of ${jobId}`
      );
      return (await page.evaluate(`document.getElementById("jobRuntime").textContent || ""`)) as string;
    };
    const parseSeconds = (text: string): number => {
      const match = /^Runtime (\d+)m (\d+)s$/.exec(text);
      assert.ok(match, `running runtime renders the compact minutes form, got ${JSON.stringify(text)}`);
      return Number(match![1]) * 60 + Number(match![2]);
    };

    const first = await readRuntime(running.id);
    const firstSeconds = parseSeconds(first);
    assert.ok(firstSeconds >= 134, `the running span covers the elapsed wall time (got ${first})`);
    // One refresh cycle later the SAME open session shows a strictly larger
    // value WITHOUT another click: the existing 2.5s refresh loop re-renders
    // the Runtime, so no extra timer or poll loop exists.
    await sleep(POLL_CYCLE_MS + 1000);
    const second = (await page.evaluate(`document.getElementById("jobRuntime").textContent || ""`)) as string;
    assert.ok(
      parseSeconds(second) > firstSeconds,
      `a running Runtime advances across refresh cycles (${first} -> ${second})`
    );

    const doneFirst = await readRuntime(done.id);
    assert.equal(doneFirst, "Runtime 1h 03m", "a terminal session renders finished_at − started_at compactly");
    await sleep(POLL_CYCLE_MS + 1000);
    const doneSecond = await readRuntime(done.id);
    assert.equal(doneSecond, doneFirst, "a terminal Runtime is frozen, never grows with the clock");

    assert.equal(await readRuntime(neverStarted.id), "", "a never-started session shows no Runtime");
    assert.equal(await readRuntime(openEnd.id), "", "a terminal record without finished_at shows no Runtime");
    assert.equal(await readRuntime(malformed.id), "", "a malformed started_at shows no Runtime");
    await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(staleTool.id)}]').click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(staleTool.id)}`,
      15000,
      "stale host-restart job detail"
    );
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#log .log-entry")).some((n) => (n.textContent || "").includes("Tool interrupted · Grep"))`,
      15000,
      "stale tool row to stop claiming it is running"
    );
    const staleLogText = (await page.evaluate(`document.getElementById("log").textContent || ""`)) as string;
    assert.equal(staleLogText.includes("Tool running · Grep"), false, "terminal reconciliation clears the false live-tool label");
    console.log(
      `[hub-ui-browser] EV8 session Runtime (running ${first} -> ${second}; terminal ${doneFirst}; absent cases omitted)`
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T5 — sidebar read/unread state
// ---------------------------------------------------------------------------

/**
 * The T5 acceptance in a REAL browser against the SHIPPED client script:
 *   A — the pure terminal-revision / read-state helpers: the same terminal
 *       revision read, a later generation's terminal revision unread, running
 *       activity never unread;
 *   B — the first-load migration baseline leaves the visible history read;
 *   C — a result that becomes terminal while another job is open turns the row
 *       unread with no reload (running activity alone never does);
 *   D — a successful open clears unread and a page reload keeps it read;
 *   E — a follow-up completion while the job is closed turns unread again,
 *       while a completion rendered on the currently open job is read;
 *   F — Load more baselines historical rows read and the list keeps the
 *       existing newest-first order with no duplicates;
 *   G — corrupt or throwing localStorage never breaks the page.
 */
test("the sidebar marks only new terminal results unread, browser-local and reload-safe (T5)", { timeout: 300000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-unread-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const project = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const STORAGE_KEY = "jobquay.read-state";
  const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
  // Deterministic, strictly increasing createdAt values so the newest-first
  // order (and therefore pagination) is fully reproducible.
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const nextAt = (): string => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  const makeJob = (task: string, status: string, generation = 0): JobRecord => {
    const at = nextAt();
    const job = createJobRecord({ task, cwd: project, provider: "command-code" }, () => new Date(at));
    job.status = status as JobRecord["status"];
    job.generation = generation;
    job.finishedAt = TERMINAL.has(status) ? nextAt() : null;
    return saveJob(root, job, () => new Date(at));
  };
  /** Persist a real transition on disk (what a worker would write). */
  const transition = (id: string, status: string, generation: number): string => {
    const job = loadJob(root, id);
    assert.ok(job, `job ${id} exists on disk`);
    job.status = status as JobRecord["status"];
    job.generation = generation;
    job.finishedAt = TERMINAL.has(status) ? nextAt() : null;
    saveJob(root, job, () => new Date(clock));
    return job.finishedAt ?? "";
  };

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    // A 20-row first page makes Load more real; 27 historical terminal jobs
    // exist BEFORE the browser ever opens the page.
    updateGlobalSettings(root, { jobs_page_size: 20 });
    const history = Array.from({ length: 27 }, (_, index) => makeJob(`HIST_${String(index + 1).padStart(2, "0")}`, "done"));
    const anotherId = history[history.length - 1]!.id;

    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `Array.from(document.querySelectorAll("#jobs button.job")).length === 20`,
      15000,
      "the first job page"
    );
    await page.evaluate(`window.__jobquayNoReload = "kept"`);

    const rowIds = (): Promise<string[]> =>
      page.evaluate(`Array.from(document.querySelectorAll("#jobs button.job")).map((b) => b.dataset.jobId)`);
    const rowUnread = (jobId: string): Promise<boolean> =>
      page.evaluate(
        `!!document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]')?.classList.contains("unread")`
      );
    const waitForRow = (jobId: string, label: string): Promise<any> =>
      waitForPage(
        page.evaluate,
        () => `!!document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]')`,
        10000,
        label
      );
    const waitForUnread = (jobId: string, unread: boolean, label: string): Promise<any> =>
      waitForPage(
        page.evaluate,
        () =>
          `(() => { const b = document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]'); return !!b && b.classList.contains("unread") === ${unread}; })()`,
        15000,
        label
      );
    /** The COMPUTED weight of one row's title (the typography contract). */
    const titleWeight = (jobId: string): Promise<string> =>
      page.evaluate(
        `getComputedStyle(document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}] .job-title')).fontWeight`
      );
    const openJob = async (jobId: string): Promise<void> => {
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]').click()`);
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(jobId)}`,
        15000,
        `the detail of ${jobId}`
      );
    };
    const reload = async (): Promise<void> => {
      await page.goto(`${hubUrl}/ui`);
      await waitForPage(
        page.evaluate,
        () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
        15000,
        "the job list after a reload"
      );
    };
    const storedRead = (): Promise<Record<string, string>> =>
      page.evaluate(
        `(() => { try { const parsed = JSON.parse(window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || "null"); return parsed && parsed.read ? parsed.read : {}; } catch { return {}; } })()`
      );
    const apiIds = async (offset: number, limit: number): Promise<string[]> => {
      const response = await fetch(`${hubUrl}/api/jobs?offset=${offset}&limit=${limit}`);
      const body = (await response.json()) as { jobs: Array<{ job_id: string }> };
      return body.jobs.map((job) => job.job_id);
    };

    // --- A: the pure shipped helpers. ---
    const helper = await page.evaluate(`(() => {
      const rev0 = terminalRevision({ status: "done", generation: 0, finished_at: "T0" });
      const rev1 = terminalRevision({ status: "done", generation: 1, finished_at: "T1" });
      return {
        rev0,
        rev1,
        runningRevision: terminalRevision({ status: "running", generation: 3, finished_at: null }),
        orphanedRevision: terminalRevision({ status: "orphaned", generation: 3, finished_at: null }),
        sameRead: isUnreadRevision(rev0, rev0),
        newGeneration: isUnreadRevision(rev1, rev0),
        newResultSameGeneration: isUnreadRevision(terminalRevision({ status: "done", generation: 0, finished_at: "T2" }), "0|done|T0"),
        firstEver: isUnreadRevision(rev0, undefined),
        runningNever: isUnreadRevision(terminalRevision({ status: "running", generation: 0, finished_at: null }), undefined),
        cancelledTerminal: terminalRevision({ status: "cancelled", generation: 2, finished_at: "T" }) !== null,
        interruptedTerminal: terminalRevision({ status: "interrupted", generation: 2, finished_at: "T" }) !== null,
        errorRevision: terminalRevision({ status: "error", generation: 4, finished_at: "T" })
      };
    })()`) as Record<string, unknown>;
    assert.equal(helper.rev0, "0|done|T0", "A: the revision identity is generation + terminal status + finished_at");
    assert.equal(helper.errorRevision, "4|error|T");
    assert.equal(helper.sameRead, false, "A: the same terminal revision already read stays read");
    assert.equal(helper.newGeneration, true, "A: a later generation's terminal revision is unread");
    assert.equal(helper.newResultSameGeneration, true, "A: a new terminal result identity is unread even at the same generation");
    assert.equal(helper.firstEver, true, "A: a terminal revision the store never saw is unread");
    assert.equal(helper.runningNever, false, "A: running activity is never unread");
    assert.equal(helper.runningRevision, null, "A: running has no terminal revision");
    assert.equal(helper.orphanedRevision, null, "A: orphaned is not a terminal result");
    assert.equal(helper.cancelledTerminal, true, "A: cancelled is terminal");
    assert.equal(helper.interruptedTerminal, true, "A: interrupted is terminal");
    console.log("[hub-ui-unread] EV-A shipped helpers: same revision read, new generation/result unread, running never unread");

    // --- B: the migration baseline leaves the visible history read. ---
    const firstPage = await apiIds(0, 20);
    assert.deepEqual(await rowIds(), firstPage, "B: the first page renders the newest-first API order");
    assert.equal(
      await page.evaluate(`document.querySelectorAll("#jobs button.job.unread").length`),
      0,
      "B: no historical terminal row becomes unread on the first load"
    );
    const storedAfterMigration = await storedRead();
    assert.equal(
      Object.keys(storedAfterMigration).length,
      20,
      "B: the migration baseline records exactly the visible terminal page as read"
    );
    const summaries = await (await fetch(`${hubUrl}/api/jobs?offset=0&limit=20`)).json() as {
      jobs: Array<{ job_id: string; generation: number; status: string; finished_at: string | null }>;
    };
    for (const summary of summaries.jobs) {
      assert.equal(
        storedAfterMigration[summary.job_id],
        `${summary.generation}|${summary.status}|${summary.finished_at ?? ""}`,
        `B: the baselined revision of ${summary.job_id} is the summary's generation|status|finished_at`
      );
    }
    console.log(`[hub-ui-unread] EV-B migration baseline: ${Object.keys(storedAfterMigration).length} visible terminal rows read, 0 unread`);

    // --- C: a result becoming terminal while another job is open. ---
    const marker = makeJob("UNREAD_MARKER", "running");
    await waitForRow(marker.id, "the new running row");
    assert.equal(await rowUnread(marker.id), false, "C: a newly visible running job is not unread");
    await openJob(anotherId);
    assert.equal(
      await page.evaluate(`!!document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(marker.id)}] .job-unread-dot')`),
      false,
      "C: no dot while the result is still running"
    );
    transition(marker.id, "done", 0);
    await waitForUnread(marker.id, true, "C: the new terminal result turns unread");
    assert.equal(await page.evaluate(`window.__jobquayNoReload`), "kept", "C: the unread marker appeared without any page reload");
    const markerUi = await page.evaluate(`(() => {
      const b = document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(marker.id)}]');
      const dot = b.querySelector(".job-unread-dot");
      const sr = b.querySelector(".sr-only");
      return {
        dot: !!dot,
        dotHidden: !!dot && dot.getAttribute("aria-hidden") === "true",
        srText: b.textContent.includes("Unread result"),
        srPosition: sr ? getComputedStyle(sr).position : null,
        ariaCurrent: b.getAttribute("aria-current"),
        weight: getComputedStyle(b.querySelector(".job-title")).fontWeight,
        readWeight: getComputedStyle(document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(anotherId)}] .job-title')).fontWeight,
        readHasDot: !!document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(anotherId)}] .job-unread-dot')
      };
    })()`) as Record<string, unknown>;
    assert.equal(markerUi.dot, true, "C: the unread row shows the small dot");
    assert.equal(markerUi.dotHidden, true, "C: the visual dot is aria-hidden");
    assert.equal(markerUi.srText, true, "C: screen readers get an explicit unread text");
    assert.equal(markerUi.srPosition, "absolute", "C: the unread text is visually hidden (sr-only)");
    assert.equal(markerUi.ariaCurrent, "false", "C: the unread row is not the selected row");
    assert.equal(markerUi.weight, "700", "C: only the unread title is bold");
    assert.equal(markerUi.readWeight, "400", "C: a read/seen row keeps the normal title weight");
    assert.equal(markerUi.readHasDot, false, "C: a read row has no dot");
    console.log("[hub-ui-unread] EV-C running -> terminal while another job open: dot + sr-only text, no reload");

    // Manual Refresh must preserve the unread state: the fold never re-baselines
    // a row this session already saw.
    await page.evaluate(`document.getElementById("refreshJobs").click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("refreshJobs").disabled === false`,
      15000,
      "the manual refresh to settle"
    );
    assert.equal(await rowUnread(marker.id), true, "C: a manual Refresh preserves unread");
    assert.equal((await storedRead())[marker.id], undefined, "C: the manual Refresh does not baseline the unread row");

    // --- D: opening clears unread; a reload keeps it read. ---
    await openJob(marker.id);
    await waitForUnread(marker.id, false, "D: opening the unread job clears it");
    assert.equal(await titleWeight(marker.id), "400", "D: the opened (read) title returns to the normal weight");
    const markerRevision = await page.evaluate(
      `JSON.parse(window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).read[${JSON.stringify(marker.id)}]`
    );
    assert.match(String(markerRevision), /^0\|done\|/, "D: opening marked the CURRENT terminal revision read");
    await reload();
    assert.equal(await rowUnread(marker.id), false, "D: the read state survives a page reload");
    assert.equal(await titleWeight(marker.id), "400", "D: a reloaded read title stays at the normal weight");
    assert.equal(
      await page.evaluate(`document.querySelectorAll("#jobs button.job.unread").length`),
      0,
      "D: the reload does not light up any other row"
    );
    console.log("[hub-ui-unread] EV-D open clears unread; reload keeps it read");

    // A manual Refresh also keeps the read state.
    await page.evaluate(`document.getElementById("refreshJobs").click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("refreshJobs").disabled === false`,
      15000,
      "the manual refresh after the reload"
    );
    assert.equal(await rowUnread(marker.id), false, "D: a manual Refresh preserves the read state");

    // --- E: follow-up generation completion while closed / while open. ---
    await openJob(anotherId);
    const gen1Finished = transition(marker.id, "done", 1);
    await waitForUnread(marker.id, true, "E: the follow-up completion while closed turns unread again");
    await openJob(marker.id);
    await waitForUnread(marker.id, false, "E: opening the follow-up result marks it read");
    assert.equal(
      await page.evaluate(`JSON.parse(window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).read[${JSON.stringify(marker.id)}]`),
      `1|done|${gen1Finished}`,
      "E: the store now holds the generation-1 terminal revision"
    );
    // Generation 2 completes while the job IS open: the detail refresh renders
    // it, so it is read automatically.
    const gen2Finished = transition(marker.id, "done", 2);
    await waitForPage(
      page.evaluate,
      () =>
        `(() => { const text = document.getElementById("jobStatus").textContent || ""; return text.includes("Run 3") && text.includes("done"); })()`,
      15000,
      "E: the open detail refreshed to the generation-2 terminal result"
    );
    assert.equal(await rowUnread(marker.id), false, "E: a completion rendered on the open job is read automatically");
    assert.equal(
      await page.evaluate(`JSON.parse(window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).read[${JSON.stringify(marker.id)}]`),
      `2|done|${gen2Finished}`,
      "E: the open job's CURRENT terminal revision is what gets marked read"
    );
    console.log("[hub-ui-unread] EV-E follow-up closed => unread, follow-up on the open job => read");

    // --- F: Load more must not mark historical rows unread. ---
    const beforeIds = await rowIds();
    await page.evaluate(`document.getElementById("loadMore").click()`);
    await waitForPage(
      page.evaluate,
      () => `document.querySelectorAll("#jobs button.job").length > ${beforeIds.length}`,
      15000,
      "the older page"
    );
    const afterIds = await rowIds();
    const knownBefore = new Set(beforeIds);
    const newlyLoaded = afterIds.filter((id) => !knownBefore.has(id));
    assert.ok(newlyLoaded.length > 0, "F: Load more really loaded older rows");
    const unreadNewlyLoaded = await page.evaluate(
      `Array.from(document.querySelectorAll("#jobs button.job.unread")).map((b) => b.dataset.jobId).filter((id) => ${JSON.stringify(newlyLoaded)}.includes(id)).length`
    );
    assert.equal(unreadNewlyLoaded, 0, "F: historical rows are baselined read on first encounter");
    assert.equal(new Set(afterIds).size, afterIds.length, "F: no duplicate entries after pagination");
    assert.deepEqual(afterIds, [...(await apiIds(0, 20)), ...(await apiIds(20, 50))], "F: the list keeps the existing newest-first order");
    console.log(`[hub-ui-unread] EV-F Load more: ${newlyLoaded.length} historical rows loaded read, order + uniqueness intact`);

    // --- G1: a corrupt store never breaks the page. ---
    await page.evaluate(`window.localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, "{ this is not json")`);
    await reload();
    assert.ok((await rowIds()).length > 0, "G: a corrupt store still renders the sidebar");
    assert.equal(
      await page.evaluate(`document.querySelectorAll("#jobs button.job.unread").length`),
      0,
      "G: the corrupt store falls back to a fresh migration baseline"
    );
    assert.equal(
      await page.evaluate(`JSON.parse(window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).version`),
      1,
      "G: the corrupt value was replaced by a clean versioned store"
    );
    const afterCorrupt = makeJob("AFTER_CORRUPT_MARKER", "running");
    await waitForRow(afterCorrupt.id, "the running row after corruption");
    await openJob(anotherId);
    transition(afterCorrupt.id, "done", 0);
    await waitForUnread(afterCorrupt.id, true, "G: a new terminal result still turns unread after corruption");
    console.log("[hub-ui-unread] EV-G1 corrupt store: page + feature keep working, store rewritten");

    // --- G2: throwing localStorage never breaks the page. ---
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: `Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled by test"); } });` },
      page.sessionId
    );
    await reload();
    assert.ok((await rowIds()).length > 0, "G: the sidebar renders with unavailable storage");
    assert.equal(
      await page.evaluate(`document.querySelectorAll("#jobs button.job.unread").length`),
      0,
      "G: unavailable storage still applies the in-memory migration baseline"
    );
    const noStorageMarker = makeJob("NO_STORAGE_MARKER", "running");
    await waitForRow(noStorageMarker.id, "the running row with unavailable storage");
    await openJob(anotherId);
    transition(noStorageMarker.id, "done", 0);
    await waitForUnread(noStorageMarker.id, true, "G: unread still works in memory without storage");
    console.log("[hub-ui-unread] EV-G2 throwing localStorage: page + feature keep working in memory");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T7 — WorkBuddy model-specific Reasoning: strict scoping across model switches
// ---------------------------------------------------------------------------

/**
 * The defect this guards (JQ-20261001-27): the WorkBuddy Reasoning dropdown
 * appended the previous model's saved effort to the newly selected model's
 * options, e.g. DeepSeek's saved `max` reappeared under GPT as
 * `max (Saved setting; not supported by Official App)`. Reasoning is strictly
 * model-specific: a cross-model switch shows ONLY the newly selected model's
 * published values plus Unspecified (Provider default), while the persisted
 * setting scoped to the original model survives a switch back to that model.
 */
test("WorkBuddy Reasoning is strictly model-specific across model switches and keeps the same-model saved max", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-wb-effort-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const cc = controlledSettingsProvider("command-code");
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    // Drive the REAL WorkBuddy card through the Hub's own settings read path.
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await page.evaluate(`(() => {
      const select = document.getElementById("settingsProvider");
      select.value = "workbuddy-ai";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(() => wb.calls === 1, 15000, "the WorkBuddy settings read");

    const effortState = (): Promise<{ value: string; options: Array<{ value: string; label: string }> }> =>
      page.evaluate(`(() => {
        const select = document.getElementById("wbDefaultEffort");
        return {
          value: select.value,
          options: Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent || "" }))
        };
      })()`);

    const selectDefaultModel = async (model: string): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("wbDefaultModel");
        select.value = ${JSON.stringify(model)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };

    const wbView = workBuddyAiSettingsView({
      models: [WORKBUDDY_MODEL, "gpt-5.5", "gemini-3.5-flash"],
      offeredModels: [WORKBUDDY_MODEL, "gpt-5.5", "gemini-3.5-flash"],
      meta: {
        // The current DeepSeek evidence: the Official App publishes only its
        // default effort; the same model id's installed Command Code list
        // supplies the fallback options.
        [WORKBUDDY_MODEL]: {
          label: "DeepSeek V4.1 Flash",
          credits: "x0",
          reasoning: { app_default_effort: "high", supported_efforts: ["low", "high", "max"], supported_efforts_source: "command-code" }
        },
        "gpt-5.5": {
          label: "GPT-5.5",
          reasoning: { app_default_effort: "high", supported_efforts: ["low", "medium", "high", "xhigh"], supported_efforts_source: "official-app" }
        },
        "gemini-3.5-flash": {
          label: "Gemini 3.5 Flash",
          reasoning: { app_default_effort: "medium", supported_efforts: null, supported_efforts_source: null }
        }
      },
      effort: "max"
    });
    wbView.catalog.error = "WorkBuddy live model query returned routing presets only; using provider snapshot.";
    wb.settleAt(0, { ok: true, view: wbView });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 60000, "the WorkBuddy controls");
    await waitForPage(page.evaluate, () => `document.getElementById("wbDefaultEffort").options.length === 3`, 20000, "the model-specific Reasoning options");
    assert.equal(
      await page.evaluate(`document.getElementById("wbCatalogInfo").classList.contains("hidden")`),
      true,
      "a reliable provider snapshot stays quiet even when live-read fallback detail is retained internally"
    );

    const ds = await effortState();
    assert.deepEqual(
      ds.options,
      [
        { value: "low", label: "low (Not shown in Official App)" },
        { value: "high", label: "high (Official App default)" },
        { value: "max", label: "max (Not shown in Official App)" }
      ],
      "the DS Reasoning dropdown renders exactly the approved labels with RAW option values"
    );
    assert.equal(ds.value, "max", "the saved WorkBuddy effort=max stays selected (never silently downgraded to high)");
    assert.equal(
      await page.evaluate(`document.getElementById("wbModelIssues").classList.contains("hidden")`),
      true,
      "a same-model supported saved effort renders no reset notice"
    );
    console.log(`[hub-ui-wb-effort] EV1 DS Reasoning: ${JSON.stringify(ds)}`);

    // Switching to another model shows ONLY that model's own published values
    // plus Unspecified (Provider default): DeepSeek's saved max is never
    // carried over or relabeled as a GPT choice.
    await selectDefaultModel("gpt-5.5");
    const gpt = await effortState();
    assert.deepEqual(
      gpt.options.map((option) => option.value),
      ["", "low", "medium", "high", "xhigh"],
      "the GPT Reasoning select offers exactly GPT's own values plus Unspecified"
    );
    assert.equal(gpt.options.find((option) => option.value === "high")?.label, "high (Official App default)");
    assert.equal(gpt.value, "", "a cross-model switch resets Reasoning to Unspecified/Provider default");
    assert.equal(gpt.options.some((option) => option.value === "max"), false, "DeepSeek's saved max does not leak into GPT's option list");
    assert.equal(gpt.options.some((option) => option.label.includes("Saved setting")), false, "no unproven saved value masquerades as a GPT choice");
    assert.equal(
      gpt.options.some((option) => option.label.includes("Not shown in Official App")),
      false,
      "an App-published supported list never renders the fallback provenance label"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("wbModelIssues").classList.contains("hidden")`),
      true,
      "the cross-model reset is normal behavior, not a warning"
    );
    assert.equal(wb.calls, 1, "changing the default model recomputes Reasoning from already-loaded metadata, with no extra provider read");

    // Switching back to the model the persisted setting belongs to restores
    // ONLY that model's own values, with the saved effort selected again.
    await selectDefaultModel(WORKBUDDY_MODEL);
    const dsAgain = await effortState();
    assert.deepEqual(
      dsAgain.options.map((option) => option.value),
      ["low", "high", "max"],
      "the DS option list is restored with no GPT-only values"
    );
    assert.equal(dsAgain.options.find((option) => option.value === "high")?.label, "high (Official App default)");
    assert.equal(dsAgain.value, "max", "the same-model saved max is restored and selected");
    assert.equal(
      dsAgain.options.some((option) => ["medium", "xhigh"].includes(option.value)),
      false,
      "GPT's vocabulary never leaks back into DS"
    );
    assert.equal(wb.calls, 1, "the whole DS -> GPT -> DS round-trip stays local");

    // A model with only an App default never receives a widened list, and the
    // previous model's saved effort is not presented as a Gemini choice either.
    await selectDefaultModel("gemini-3.5-flash");
    const gemini = await effortState();
    assert.deepEqual(gemini.options.map((option) => option.value), ["", "medium"], "only Unspecified plus the App default for an unrelated model");
    assert.equal(gemini.options[1]?.label, "medium (Official App default)");
    assert.equal(gemini.value, "", "the cross-model saved max is not presented as a Gemini choice");
    assert.equal(gemini.options.some((option) => option.value === "max"), false, "no leaked DS max under a default-only model");
    assert.equal(wb.calls, 1, "still exactly one WorkBuddy read for the whole interaction");
    console.log(
      `[hub-ui-wb-effort] EV2 model-specific options: gpt-5.5=${JSON.stringify(gpt.options.map((option) => option.label))} ` +
        `ds-restored=${JSON.stringify(dsAgain.options.map((option) => option.label))} ` +
        `gemini-3.5-flash=${JSON.stringify(gemini.options.map((option) => option.label))}`
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T7 — Command Code Reasoning follows the selected default model
// ---------------------------------------------------------------------------

/**
 * The defect this guards: Command Code's Reasoning dropdown offered the whole
 * static level vocabulary (including `xhigh`) for EVERY model, while the
 * installed package publishes each model's own list — deepseek/deepseek-v4.1-flash
 * accepts exactly low, high, max, and a run sent with `xhigh` died on its first
 * line.
 *
 * The contract: the options follow the SELECTED default model's own published
 * metadata, switching the model re-derives them from the metadata already on
 * screen (no further provider read, no CLI probe), and because each selection's
 * effort is scoped to its own model, switching to a DIFFERENT model resets this
 * selection's effort to the provider default while switching back to the saved
 * model restores the saved effort.
 */
test("Command Code Reasoning offers exactly the selected model's own efforts and switches locally (T7)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const DEEPSEEK = "deepseek/deepseek-v4.1-flash";
  const CANARY = "stealth/pixel-canary";

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-cc-effort-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  // The installed package's own rows: DeepSeek publishes low/high/max, the
  // stealth row publishes low/medium/xhigh. The saved default-model effort is
  // `max`; the fallback selection has no saved effort of its own.
  const probe = controlledTwoPhaseSettingsProvider("command-code", {
    cli_path: null,
    default_model: null,
    rate_limit_fallback_model: null,
    permission_mode: "yolo",
    default_effort: "max",
    rate_limit_fallback_effort: null
  });
  const reads = new ProviderSettingsReads([probe.definition]);
  const view = commandCodeSettingsView({
    models: [DEEPSEEK, CANARY],
    defaultModel: DEEPSEEK,
    extraMeta: {
      [DEEPSEEK]: { efforts: ["low", "high", "max"] },
      [CANARY]: { efforts: ["low", "medium", "xhigh"] }
    }
  });
  view.config.default_model = null;
  view.config.default_effort = "max";
  view.catalog.default_model = null;
  view.effective.model = null;

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    const waitForProbe = async (count: () => number, what: string): Promise<void> => {
      const deadline = Date.now() + 30000;
      while (count() < 1) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
      }
    };
    const effortState = async (): Promise<{ values: string[]; texts: string[]; value: string; disabled: boolean }> =>
      page.evaluate(`(() => {
        const select = document.getElementById("defaultEffort");
        return {
          values: Array.from(select.options).map((option) => option.value),
          texts: Array.from(select.options).map((option) => option.textContent || ""),
          value: select.value,
          disabled: select.disabled
        };
      })()`);
    const selectDefaultModel = async (model: string): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("defaultModel");
        select.value = ${JSON.stringify(model)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };

    // ---- Open Settings: the CATALOG phase answers first, then capability. ----
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForProbe(() => probe.catalogCalls, "the catalog read");
    probe.settleCatalog(0, { ok: true, view });
    await waitForProbe(() => probe.capabilityCalls, "the capability read");
    probe.settleCapabilities(0, {
      ok: true,
      view: {
        cli: { available: true, version: "9.9.9-fake", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null,
        observed_default_model: DEEPSEEK
      }
    });
    await waitForPage(page.evaluate, () => `document.getElementById("defaultEffort").disabled === false`, 30000, "the Reasoning control");
    assert.equal(
      await page.evaluate(`document.getElementById("defaultModel").value`),
      DEEPSEEK,
      "the fresh CLI default is shown directly as the selected model"
    );
    assert.equal(
      await page.evaluate(`Array.from(document.getElementById("defaultModel").options).some((option) => /CLI default/i.test(option.textContent || ""))`),
      false,
      "the model dropdown exposes only real model choices, never the internal CLI-default state"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").textContent`),
      COMMAND_CODE_YOLO_NOTE_TEXT,
      "Command Code yolo keeps the shared Recommended guidance in the contract test"
    );

    // ---- The SELECTED model's own list, and nothing else. ----
    const deepseek = await effortState();
    assert.deepEqual(
      deepseek.values,
      ["", "low", "high", "max"],
      "deepseek/deepseek-v4.1-flash offers exactly its own published levels plus the provider default"
    );
    assert.ok(!deepseek.values.includes("xhigh"), "xhigh is NOT offered for a model that does not publish it");
    assert.equal(deepseek.value, "max", "the saved effort stays selected");
    assert.ok(
      deepseek.texts.every((text) => !text.includes("xhigh")),
      "no option claims xhigh for this model"
    );
    console.log(`[hub-ui-cc-effort] EV1 ${DEEPSEEK} Reasoning: ${JSON.stringify(deepseek.values)}`);

    // ---- Save from an internally-unset default: the REAL displayed model is
    //      persisted, and the post-save catalog/capability refresh never turns
    //      the model control into a loading placeholder. ----
    await page.evaluate(`(() => {
      const select = document.getElementById("permissionMode");
      select.value = "plan";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitForPage(page.evaluate, () => `document.getElementById("saveSettings").disabled === false`, 15000, "Save after the permission change");
    await page.evaluate(`document.getElementById("saveSettings").click()`);
    await waitForProbe(() => probe.savedPatches.length, "the save PUT");
    assert.equal(probe.savedPatches[0]?.default_model, DEEPSEEK, "Save persists the real model displayed in the dropdown, never an internal null/CLI-default state");
    assert.equal(await page.evaluate(`document.getElementById("defaultModel").value`), DEEPSEEK, "the real model remains visible while the post-save refresh is pending");
    assert.equal(
      await page.evaluate(`Array.from(document.getElementById("defaultModel").options).some((option) => /loading/i.test(option.textContent || ""))`),
      false,
      "Save never replaces the model dropdown with loading copy"
    );
    await waitForProbe(() => probe.catalogCalls >= 2 ? 1 : 0, "the post-save catalog read");
    const postSaveView = commandCodeSettingsView({
      models: [DEEPSEEK, CANARY],
      defaultModel: DEEPSEEK,
      extraMeta: {
        [DEEPSEEK]: { efforts: ["low", "high", "max"] },
        [CANARY]: { efforts: ["low", "medium", "xhigh"] }
      }
    });
    postSaveView.config.permission_mode = "plan";
    postSaveView.config.default_effort = "max";
    probe.settleCatalog(1, { ok: true, view: postSaveView });
    await waitForProbe(() => probe.capabilityCalls >= 2 ? 1 : 0, "the post-save capability read");
    probe.settleCapabilities(1, {
      ok: true,
      view: {
        cli: { available: true, version: "9.9.9-fake", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null,
        observed_default_model: DEEPSEEK
      }
    });
    await waitForPage(page.evaluate, () => `document.getElementById("defaultEffort").disabled === false && document.getElementById("defaultModel").value === ${JSON.stringify(DEEPSEEK)}`, 30000, "the saved model after post-save refresh");
    assert.equal(
      await page.evaluate(`Array.from(document.getElementById("defaultModel").options).some((option) => /loading|CLI default/i.test(option.textContent || ""))`),
      false,
      "the post-save model list contains only real model choices"
    );
    console.log(`[hub-ui-cc-effort] EV1b save: ${DEEPSEEK} stayed visible and was persisted through the post-save refresh`);

    // ---- Switching the model re-derives the options LOCALLY, and resets THIS
    //      selection's effort (scoped to its own model) to the provider default. ----
    await selectDefaultModel(CANARY);
    const canary = await effortState();
    assert.deepEqual(
      canary.values,
      ["", "low", "medium", "xhigh"],
      "the newly selected model's own list is used, with no effort carried over from the previous model"
    );
    assert.equal(canary.value, "", "switching to a different model resets this selection's effort to the provider default");
    assert.equal(probe.catalogCalls, 2, "switching the default model performs NO further provider read after the explicit save refresh");
    assert.equal(probe.capabilityCalls, 2, "switching the default model performs NO further CLI capability probe after the explicit save refresh");
    console.log(`[hub-ui-cc-effort] EV2 ${CANARY} Reasoning: ${JSON.stringify(canary.values)} (effort reset to provider default)`);

    // ---- Switching back to the SAVED model restores the first model's own
    //      list and the effort saved for it. ----
    await selectDefaultModel(DEEPSEEK);
    const back = await effortState();
    assert.deepEqual(back.values, ["", "low", "high", "max"], "the options follow the selection in both directions");
    assert.equal(back.value, "max", "returning to the saved model restores the effort saved for that model");
    assert.equal(probe.catalogCalls, 2, "the only provider reads are the initial read and the explicit post-save refresh");
    assert.equal(probe.capabilityCalls, 2, "the only capability reads are the initial read and the explicit post-save refresh");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T7b — the two Command Code Reasoning selects are independent
// ---------------------------------------------------------------------------

/**
 * Both Reasoning selects exist at once and each follows the model THAT select
 * points at: the default-model select uses the default model's own published
 * levels, the fallback-model select uses the fallback model's own. The two
 * efforts are independent — changing the fallback model resets ONLY the
 * fallback effort and leaves the default effort untouched, and vice versa.
 */
test("Command Code default and rate-limit-fallback Reasoning selects are independent (T7b)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const DEEPSEEK = "deepseek/deepseek-v4.1-flash"; // publishes low/high/max
  const CANARY = "stealth/pixel-canary"; // publishes low/medium/xhigh

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-cc-effort-independent-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const probe = controlledTwoPhaseSettingsProvider("command-code", {
    cli_path: null,
    default_model: DEEPSEEK,
    rate_limit_fallback_model: CANARY,
    permission_mode: "yolo",
    default_effort: "high",
    rate_limit_fallback_effort: "medium"
  });
  const reads = new ProviderSettingsReads([probe.definition]);
  const view = commandCodeSettingsView({
    models: [DEEPSEEK, CANARY],
    defaultModel: DEEPSEEK,
    extraMeta: {
      [DEEPSEEK]: { efforts: ["low", "high", "max"] },
      [CANARY]: { efforts: ["low", "medium", "xhigh"] }
    }
  });
  view.config.default_model = DEEPSEEK;
  view.config.rate_limit_fallback_model = CANARY;
  view.config.default_effort = "high";
  view.config.rate_limit_fallback_effort = "medium";

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `/Showing/.test(document.getElementById("statusbar").textContent || "")`,
      15000,
      "initial job list load"
    );

    const selectState = (id: string): Promise<{ values: string[]; value: string }> =>
      page.evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        return { values: Array.from(select.options).map((option) => option.value), value: select.value };
      })()`);
    const setValue = async (id: string, value: string): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };
    const waitForProbe = async (count: () => number, what: string): Promise<void> => {
      const deadline = Date.now() + 30000;
      while (count() < 1) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
      }
    };

    // ---- Open Settings: catalog phase, then capability. ----
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForProbe(() => probe.catalogCalls, "the catalog read");
    probe.settleCatalog(0, { ok: true, view });
    await waitForProbe(() => probe.capabilityCalls, "the capability read");
    probe.settleCapabilities(0, {
      ok: true,
      view: {
        cli: { available: true, version: "9.9.9-fake", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null
      }
    });
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("defaultEffort").disabled === false && document.getElementById("fallbackEffort").disabled === false`,
      30000,
      "both Reasoning controls"
    );

    // ---- Each select follows ITS OWN model. ----
    const def = await selectState("defaultEffort");
    assert.deepEqual(def.values, ["", "low", "high", "max"], "the default-model select offers DeepSeek's own levels");
    assert.equal(def.value, "high", "the default-model effort is selected");
    const fb = await selectState("fallbackEffort");
    assert.deepEqual(fb.values, ["", "low", "medium", "xhigh"], "the fallback-model select offers the canary's own levels");
    assert.equal(fb.value, "medium", "the fallback-model effort is selected independently");
    console.log(`[hub-ui-cc-effort-independent] EV1 default=${JSON.stringify(def.values)} fallback=${JSON.stringify(fb.values)}`);

    // ---- Changing the FALLBACK model resets ONLY the fallback effort. ----
    await setValue("fallbackModel", DEEPSEEK);
    const fbAfter = await selectState("fallbackEffort");
    assert.deepEqual(fbAfter.values, ["", "low", "high", "max"], "the fallback select now follows DeepSeek");
    assert.equal(fbAfter.value, "", "the fallback effort resets to the provider default on its own model change");
    const defAfter = await selectState("defaultEffort");
    assert.deepEqual(defAfter.values, ["", "low", "high", "max"], "the default select is unchanged");
    assert.equal(defAfter.value, "high", "the default effort is untouched by the fallback model change");

    // ---- Changing the DEFAULT model resets ONLY the default effort. ----
    await setValue("defaultModel", CANARY);
    const defAfter2 = await selectState("defaultEffort");
    assert.deepEqual(defAfter2.values, ["", "low", "medium", "xhigh"], "the default select now follows the canary");
    assert.equal(defAfter2.value, "", "the default effort resets on its own model change");
    const fbAfter2 = await selectState("fallbackEffort");
    assert.equal(fbAfter2.value, "", "the fallback effort is unaffected by the default model change");

    assert.equal(probe.catalogCalls, 1, "the whole interaction performs NO further provider read");
    assert.equal(probe.capabilityCalls, 1, "the whole interaction performs NO further CLI capability probe");
    console.log("[hub-ui-cc-effort-independent] EV2 cross-model edits stay local and independent");

    // Save both independently selected efforts, let the real post-save read
    // return the submitted config, then leave and reopen Settings for another
    // fresh read. The visible values must come back as the saved pairs.
    await setValue("defaultModel", DEEPSEEK);
    await setValue("fallbackModel", CANARY);
    await setValue("defaultEffort", "high");
    await setValue("fallbackEffort", "medium");
    await waitForPage(page.evaluate, () => `document.getElementById("saveSettings").disabled === false`, 15000, "independent reasoning save");
    await page.evaluate(`document.getElementById("saveSettings").click()`);
    await waitFor(() => probe.savedPatches.length === 1 && probe.catalogCalls === 2, 30000, "the Command Code save and post-save read");
    const saved = probe.savedPatches[0]!;
    assert.equal(saved.default_effort, "high");
    assert.equal(saved.rate_limit_fallback_effort, "medium");
    assert.equal(saved.default_model, DEEPSEEK);
    assert.equal(saved.rate_limit_fallback_model, CANARY);
    Object.assign(view.config, saved);
    probe.settleCatalog(1, { ok: true, view });
    await waitFor(() => probe.capabilityCalls === 2, 15000, "post-save Command Code capability read");
    probe.settleCapabilities(1, {
      ok: true,
      view: {
        cli: { available: true, version: "9.9.9-fake", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null
      }
    });
    await waitForPage(page.evaluate, () => `document.getElementById("fallbackEffort").value === "medium"`, 30000, "post-save fallback effort");

    await page.evaluate(`document.getElementById("navJobs").click(); document.getElementById("navSettings").click()`);
    await waitFor(() => probe.catalogCalls === 3, 15000, "the reopened Command Code settings read");
    probe.settleCatalog(2, { ok: true, view });
    await waitFor(() => probe.capabilityCalls === 3, 15000, "the reopened Command Code capability read");
    probe.settleCapabilities(2, {
      ok: true,
      view: {
        cli: { available: true, version: "9.9.9-fake", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null
      }
    });
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("defaultEffort").value === "high" && document.getElementById("fallbackEffort").value === "medium"`,
      30000,
      "both persisted Command Code efforts after reopening Settings"
    );
    assert.equal(await page.evaluate(`document.getElementById("defaultModel").value`), DEEPSEEK);
    assert.equal(await page.evaluate(`document.getElementById("fallbackModel").value`), CANARY);
    console.log("[hub-ui-cc-effort-independent] EV3 default and fallback reasoning save and reopen independently");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T7c — WorkBuddy native Full Access and both reasoning fields survive reopen
// ---------------------------------------------------------------------------

test("WorkBuddy Full Access and default/fallback Reasoning save and reopen from a fresh provider read (T7c)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const MAIN = "wb/model-main";
  const FALLBACK = "wb/model-fallback";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-wb-settings-reopen-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const cc = controlledSettingsProvider("command-code");
  const wb = controlledTwoPhaseSettingsProvider("workbuddy-ai", {
    cli_path: null,
    default_model: MAIN,
    rate_limit_fallback_model: FALLBACK,
    permission_mode: "plan",
    default_effort: "high",
    rate_limit_fallback_effort: "medium"
  });
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);
  const view = workBuddyAiSettingsView({
    models: [MAIN, FALLBACK],
    offeredModels: [MAIN, FALLBACK],
    defaultModel: MAIN,
    effort: "high",
    fallbackEffort: "medium",
    meta: {
      [MAIN]: {
        label: "Main model",
        reasoning: { app_default_effort: "high", supported_efforts: ["low", "high", "max"], supported_efforts_source: "official-app" }
      },
      [FALLBACK]: {
        label: "Fallback model",
        reasoning: { app_default_effort: "medium", supported_efforts: ["low", "medium", "xhigh"], supported_efforts_source: "official-app" }
      }
    }
  });
  Object.assign(view.config, {
    default_model: MAIN,
    rate_limit_fallback_model: FALLBACK,
    permission_mode: "plan",
    default_effort: "high",
    rate_limit_fallback_effort: "medium"
  });
  // This mirrors the recognized WorkBuddy permission vocabulary: all seven
  // native modes — including Full Access, whose `fullAccess` token is not in
  // help's Choices line — are published by fresh provider data.
  view.capabilities.permission_modes = ["default", "plan", "accept-edits", "yolo", "dont-ask", "auto", "full-access"];

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await page.evaluate(`document.getElementById("navSettings").click()`);
    // Opening Settings starts a Command Code read; settle it now so the switch
    // below is deterministic, and the later switch-back starts a FRESH read
    // instead of joining this one.
    await waitFor(() => cc.calls === 1, 15000, "the initial Command Code settings read");
    cc.settleAt(0, { ok: true, view: commandCodeSettingsView() });
    await page.evaluate(`(() => {
      const select = document.getElementById("settingsProvider");
      select.value = "workbuddy-ai";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(() => wb.catalogCalls === 1, 15000, "the initial WorkBuddy settings read");
    wb.settleCatalog(0, { ok: true, view });
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("wbPermissionMode").disabled && !document.getElementById("wbFallbackEffort").disabled`,
      30000,
      "WorkBuddy Permission and Reasoning controls"
    );

    const initial = await page.evaluate(`(() => ({
      permission: Array.from(document.getElementById("wbPermissionMode").options).map((o) => ({value:o.value,label:o.textContent})),
      defaultEffort: document.getElementById("wbDefaultEffort").value,
      fallbackEffort: document.getElementById("wbFallbackEffort").value,
      checkboxes: document.querySelectorAll("#wbCard input[type=checkbox]").length
    }))()`);
    assert.deepEqual(
      initial.permission,
      [
        { value: "default", label: "standard" },
        { value: "plan", label: "plan" },
        { value: "accept-edits", label: "accept-edits" },
        { value: "yolo", label: "yolo" },
        { value: "full-access", label: "Full Access" }
      ],
      "the normal WorkBuddy Permission dropdown offers exactly the five supported values in order"
    );
    assert.ok(
      !initial.permission.some((option: { value: string }) => option.value === "dont-ask" || option.value === "auto"),
      "the advanced dont-ask/auto modes stay out of the normal Permission choices"
    );
    assert.equal(initial.defaultEffort, "high");
    assert.equal(initial.fallbackEffort, "medium");
    assert.equal(initial.checkboxes, 0, "Full Access is a choice in the existing Permission dropdown, with no checkbox");

    // The initial plan selection explains plan, not a generic caution.
    const planNote = await page.evaluate(`document.getElementById("wbYoloWarning").textContent`);
    assert.equal(planNote, PLAN_NOTE_TEXT, "the initial WorkBuddy plan selection shows the plan note");

    // The same inline layout contract for WorkBuddy AI: same row as the
    // dropdown, plain non-wrapping text; 13px when it fits, 12px + single-line
    // ellipsis when constrained, 13px restored after widening. The native title
    // carries the complete explanation ONLY while the final text is really
    // truncated — a fitting note (at 13px or after the 12px step) has none.
    await setViewport(cdp, page, 1600, 900);
    await waitForPage(
      page.evaluate,
      () => `getComputedStyle(document.getElementById("wbYoloWarning")).fontSize === "13px"`,
      15000,
      "the wide 13px WorkBuddy note"
    );
    const wbWideNote = await permissionNoteState(page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(wbWideNote.fontSize, "13px", "the WorkBuddy note renders at 13px when the full text fits");
    assert.equal(
      wbWideNote.scrollWidth <= wbWideNote.clientWidth,
      true,
      `the wide WorkBuddy note does not clip (scrollWidth=${wbWideNote.scrollWidth}, clientWidth=${wbWideNote.clientWidth})`
    );
    assert.equal(wbWideNote.whiteSpace, "nowrap", "the WorkBuddy note never wraps");
    assert.equal(wbWideNote.textOverflow, "ellipsis", "overflow is expressed as a single-line ellipsis");
    assert.equal(wbWideNote.background, "rgba(0, 0, 0, 0)", "no warning-card background on the WorkBuddy note");
    assert.equal(wbWideNote.borderTopWidth, "0px", "no warning-card border on the WorkBuddy note");
    assert.equal(wbWideNote.paddingLeft, "0px", "no warning-card padding on the WorkBuddy note");
    assert.equal(wbWideNote.sameRowAsSelect && wbWideNote.sameRowAsLabel, true, "label, dropdown and note share one horizontal row");
    assert.equal(wbWideNote.text, PLAN_NOTE_TEXT, "the full WorkBuddy explanation stays the textContent");
    assert.equal(wbWideNote.title, "", "a WorkBuddy note that fits at 13px has no extra tooltip");

    // An intermediate width (computed from the note's own text widths) where
    // the plan note overflows at 13px but fits at 12px: the step-down applies
    // and the tooltip stays absent because nothing is truncated.
    const wbIntermediateNote = await placeNoteAtIntermediateFit(cdp, page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(wbIntermediateNote.fontSize, "12px", "the overflowing plan note steps down to 12px");
    assert.equal(
      wbIntermediateNote.scrollWidth <= wbIntermediateNote.clientWidth,
      true,
      `the intermediate WorkBuddy note fits at 12px (scrollWidth=${wbIntermediateNote.scrollWidth}, clientWidth=${wbIntermediateNote.clientWidth})`
    );
    assert.equal(wbIntermediateNote.title, "", "a WorkBuddy note that fits after the 12px step has no extra tooltip");
    assert.equal(wbIntermediateNote.text, PLAN_NOTE_TEXT, "the full plan text stays the textContent");

    // While a LONGER mode's text is truncated at the same width, changing the
    // mode updates the tooltip to the new complete text...
    await page.evaluate(`(() => {
      const select = document.getElementById("wbPermissionMode");
      select.value = "full-access";
      select.dispatchEvent(new Event("change"));
    })()`);
    const clippedFullAccess = await permissionNoteState(page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(clippedFullAccess.fontSize, "12px", "the longer Full Access note stays at 12px at this width");
    assert.equal(
      clippedFullAccess.scrollWidth > clippedFullAccess.clientWidth,
      true,
      `the Full Access note is genuinely truncated here (scrollWidth=${clippedFullAccess.scrollWidth}, clientWidth=${clippedFullAccess.clientWidth})`
    );
    assert.equal(
      clippedFullAccess.title,
      WORKBUDDY_FULL_ACCESS_NOTE_TEXT,
      "changing the mode while clipped updates the tooltip to the new complete text"
    );

    // ...and a mode whose text fits again removes the tooltip on ITS change.
    await page.evaluate(`(() => {
      const select = document.getElementById("wbPermissionMode");
      select.value = "plan";
      select.dispatchEvent(new Event("change"));
    })()`);
    const refittedPlan = await permissionNoteState(page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(refittedPlan.fontSize, "12px", "the shorter plan note steps back to its fitting 12px size");
    assert.equal(refittedPlan.scrollWidth <= refittedPlan.clientWidth, true, "the plan note fits again at this width");
    assert.equal(refittedPlan.title, "", "a mode change whose text fits removes the tooltip");

    await setViewport(cdp, page, 640, 480);
    await waitForPage(
      page.evaluate,
      () => `(() => {
        const el = document.getElementById("wbYoloWarning");
        return getComputedStyle(el).fontSize === "12px"
          && el.scrollWidth > el.clientWidth
          && el.title === ${JSON.stringify(PLAN_NOTE_TEXT)};
      })()`,
      15000,
      "the constrained 12px WorkBuddy note with its clipped tooltip"
    );
    const wbNarrowNote = await permissionNoteState(page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(wbNarrowNote.fontSize, "12px", "an overflowing WorkBuddy note steps down to 12px");
    assert.equal(
      wbNarrowNote.scrollWidth > wbNarrowNote.clientWidth,
      true,
      `the remaining WorkBuddy overflow is a real ellipsis (scrollWidth=${wbNarrowNote.scrollWidth}, clientWidth=${wbNarrowNote.clientWidth})`
    );
    assert.equal(wbNarrowNote.height < 30, true, "the constrained WorkBuddy note stays single-line");
    assert.equal(wbNarrowNote.text, PLAN_NOTE_TEXT, "clipping never slices the WorkBuddy textContent");
    assert.equal(wbNarrowNote.title, PLAN_NOTE_TEXT, "the complete WorkBuddy note stays in the title while clipped");
    assert.equal(wbNarrowNote.sameRowAsSelect && wbNarrowNote.sameRowAsLabel, true, "the constrained WorkBuddy row keeps label, dropdown and note together");
    assert.equal(
      await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
      true,
      "the constrained WorkBuddy row never stretches the page horizontally"
    );

    await setViewport(cdp, page, 1600, 900);
    await waitForPage(
      page.evaluate,
      () => `getComputedStyle(document.getElementById("wbYoloWarning")).fontSize === "13px"`,
      15000,
      "the restored 13px WorkBuddy note"
    );
    const wbRestoredNote = await permissionNoteState(page, "wbYoloWarning", "wbPermissionMode");
    assert.equal(wbRestoredNote.fontSize, "13px", "widening restores the WorkBuddy note to 13px once the text fits");
    assert.equal(wbRestoredNote.scrollWidth <= wbRestoredNote.clientWidth, true, "the restored WorkBuddy note no longer clips");
    assert.equal(wbRestoredNote.title, "", "widening removes the WorkBuddy tooltip once the note fits again");
    console.log(
      `[hub-ui-wb-settings-reopen] EV3 inline note layout (WB): wide 13px/no-tooltip, intermediate 12px fit/no-tooltip, ` +
        `constrained 12px/ellipsis/tooltip, restored 13px/no-tooltip — ` +
        `row=${wbWideNote.sameRowAsSelect && wbNarrowNote.sameRowAsLabel}, background=${wbWideNote.background}, title=${JSON.stringify(wbRestoredNote.title)}`
    );

    // Every normal choice explains itself: accept-edits keeps its own note.
    await page.evaluate(`(() => {
      const select = document.getElementById("wbPermissionMode");
      select.value = "accept-edits";
      select.dispatchEvent(new Event("change"));
    })()`);
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").textContent`),
      ACCEPT_EDITS_NOTE_TEXT,
      "WorkBuddy accept-edits explains its own behavior"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").title`),
      "",
      "the fitting accept-edits note at the wide viewport has no tooltip"
    );

    // Choosing the standard label persists WorkBuddy's native `default` value.
    await page.evaluate(`(() => {
      const select = document.getElementById("wbPermissionMode");
      select.value = "default";
      select.dispatchEvent(new Event("change"));
    })()`);
    const standardNote = await page.evaluate(`document.getElementById("wbYoloWarning").textContent`);
    assert.equal(standardNote, STANDARD_NOTE_TEXT, "WorkBuddy standard (native default) shows the standard note");
    await waitForPage(page.evaluate, () => `document.getElementById("wbSaveSettings").disabled === false`, 15000, "the Save button after choosing standard");
    await page.evaluate(`document.getElementById("wbSaveSettings").click()`);
    await waitFor(() => wb.savedPatches.length === 1 && wb.catalogCalls === 2, 30000, "the standard save and its background provider read");
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("wbSettingsMessage").innerText !== "Saving…" && !document.getElementById("wbPermissionMode").disabled`,
      15000,
      "WorkBuddy Saving to finish before its background provider read settles"
    );
    const standardSaved = wb.savedPatches[0]!;
    assert.equal(standardSaved.permission_mode, "default", "choosing standard persists WorkBuddy's native default value");
    assert.equal(standardSaved.default_effort, "high", "the standard save keeps the configured default-model effort");
    assert.equal(standardSaved.rate_limit_fallback_effort, "medium", "the standard save keeps the configured fallback-model effort");
    Object.assign(view.config, standardSaved);
    wb.settleCatalog(1, { ok: true, view });
    // The persisted value is already usable before the provider re-read answers;
    // the fresh response only verifies and replaces provider evidence.
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("wbPermissionMode").disabled && document.getElementById("wbPermissionMode").value === "default" && document.getElementById("wbPermissionMode").options[0].textContent === "standard"`,
      30000,
      "the saved standard selection after the fresh provider read"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").textContent`),
      STANDARD_NOTE_TEXT,
      "the fresh read re-renders the standard note for the saved default value"
    );

    await page.evaluate(`(() => {
      const set = (id, value) => { const e = document.getElementById(id); e.value = value; e.dispatchEvent(new Event("change")); };
      set("wbPermissionMode", "full-access");
      set("wbDefaultEffort", "max");
      set("wbFallbackEffort", "low");
    })()`);
    const fullAccessNote = String(await page.evaluate(`document.getElementById("wbYoloWarning").textContent`));
    assert.equal(fullAccessNote, WORKBUDDY_FULL_ACCESS_NOTE_TEXT, "Full Access explains its high-risk and repeated-action behavior");
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").title`),
      "",
      "the fitting Full Access note at the wide viewport has no tooltip"
    );
    await waitForPage(page.evaluate, () => `document.getElementById("wbSaveSettings").disabled === false`, 15000, "the WorkBuddy settings Save button");
    await page.evaluate(`document.getElementById("wbSaveSettings").click()`);
    await waitFor(() => wb.savedPatches.length === 2 && wb.catalogCalls === 3, 30000, "the WorkBuddy save and its fresh provider read");
    const saved = wb.savedPatches[1]!;
    assert.equal(saved.permission_mode, "full-access");
    assert.equal(saved.default_effort, "max");
    assert.equal(saved.rate_limit_fallback_effort, "low");
    assert.equal(saved.default_model, MAIN);
    assert.equal(saved.rate_limit_fallback_model, FALLBACK);
    Object.assign(view.config, saved);
    wb.settleCatalog(2, { ok: true, view });
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("wbPermissionMode").disabled && document.getElementById("wbPermissionMode").value === "full-access" && document.getElementById("wbDefaultEffort").value === "max" && document.getElementById("wbFallbackEffort").value === "low"`,
      30000,
      "the post-save native mode and independent efforts"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").textContent`),
      WORKBUDDY_FULL_ACCESS_NOTE_TEXT,
      "the fresh read keeps the Full Access note"
    );

    await page.evaluate(`document.getElementById("navJobs").click(); document.getElementById("navSettings").click()`);
    await waitFor(() => wb.catalogCalls === 4, 15000, "the reopened WorkBuddy settings read");
    wb.settleCatalog(3, { ok: true, view });
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("wbPermissionMode").disabled && document.getElementById("wbPermissionMode").value === "full-access" && document.getElementById("wbDefaultEffort").value === "max" && document.getElementById("wbFallbackEffort").value === "low"`,
      30000,
      "the saved WorkBuddy values after reopening Settings"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("wbYoloWarning").textContent`),
      WORKBUDDY_FULL_ACCESS_NOTE_TEXT,
      "the reopened Full Access selection keeps its note"
    );

    // An unsaved yolo selection must immediately show WorkBuddy's OWN yolo
    // note, distinct from Full Access, and must not submit a patch.
    await page.evaluate(`(() => {
      const select = document.getElementById("wbPermissionMode");
      select.value = "yolo";
      select.dispatchEvent(new Event("change"));
    })()`);
    const workBuddyYoloNote = String(await page.evaluate(`document.getElementById("wbYoloWarning").textContent`));
    assert.equal(workBuddyYoloNote, WORKBUDDY_YOLO_NOTE_TEXT, "WorkBuddy yolo states its high-risk approval ask honestly");
    assert.doesNotMatch(workBuddyYoloNote, /Recommended/i, "WorkBuddy yolo stays distinct from the recommended Full Access mode");
    assert.match(fullAccessNote, /^Recommended\./, "WorkBuddy Full Access is visibly marked as the recommended mode");
    assert.notEqual(workBuddyYoloNote, fullAccessNote, "WorkBuddy yolo and Full Access are explained as distinct behaviors");
    assert.equal(wb.savedPatches.length, 2, "the yolo preview was not saved");
    console.log(
      "[hub-ui-wb-settings-reopen] EV2 notes: " +
        `plan=${JSON.stringify(planNote)} standard=${JSON.stringify(standardNote)} ` +
        `yolo=${JSON.stringify(workBuddyYoloNote)} full-access=${JSON.stringify(fullAccessNote)}`
    );

    // ---- The same shared note renderer follows Command Code's modes too. ----
    // Switching back starts a FRESH Command Code read (the initial one was
    // settled before the first switch), publishing the installed help's own
    // `standard` vocabulary plus `dont-ask` as an advanced mode.
    const ccView = commandCodeSettingsView();
    ccView.config.permission_mode = "standard";
    ccView.capabilities.permission_modes = ["standard", "plan", "accept-edits", "yolo", "dont-ask"];
    await page.evaluate(`(() => {
      const select = document.getElementById("settingsProvider");
      select.value = "command-code";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(() => cc.calls === 2, 15000, "the Command Code read after switching back");
    cc.settleAt(1, { ok: true, view: ccView });
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("permissionMode").value === "standard" && !document.getElementById("permissionMode").disabled`,
      30000,
      "the Command Code form with the standard selection"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").textContent`),
      STANDARD_NOTE_TEXT,
      "Command Code standard maps to the standard note"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").title`),
      "",
      "the fitting Command Code standard note after the provider switch has no tooltip"
    );
    await page.evaluate(`(() => {
      const select = document.getElementById("permissionMode");
      select.value = "accept-edits";
      select.dispatchEvent(new Event("change"));
    })()`);
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").textContent`),
      ACCEPT_EDITS_NOTE_TEXT,
      "Command Code accept-edits shows its own note"
    );
    await page.evaluate(`(() => {
      const select = document.getElementById("permissionMode");
      select.value = "dont-ask";
      select.dispatchEvent(new Event("change"));
    })()`);
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").textContent`),
      PROVIDER_RULES_NOTE_TEXT,
      "a mode with no defined semantics keeps the honest generic note"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("yoloWarning").title`),
      "",
      "the fitting generic advanced-mode note has no tooltip"
    );

    assert.equal(await page.evaluate(`document.querySelectorAll("#wbCard input[type=checkbox]").length`), 0);
    console.log("[hub-ui-wb-settings-reopen] EV1 native Full Access + independent reasoning saved and restored by a fresh read");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T7 — WorkBuddy legacy saved effort incompatible with the selected model
// ---------------------------------------------------------------------------

/**
 * The honest reset rule behind JQ-20261001-27: a persisted (legacy) effort the
 * currently selected model does not support stays in storage, but the Reasoning
 * dropdown does NOT append it as a choice and does not select it — it shows
 * Unspecified (Provider default) plus a small reset notice, and saving the
 * shown form persists that reset.
 */
test("WorkBuddy legacy saved effort unsupported by the selected model never masquerades as a current Reasoning option", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-wb-effort-legacy-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const cc = controlledSettingsProvider("command-code");
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    await page.evaluate(`document.getElementById("navSettings").click()`);
    await page.evaluate(`(() => {
      const select = document.getElementById("settingsProvider");
      select.value = "workbuddy-ai";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(() => wb.calls === 1, 15000, "the WorkBuddy settings read");

    wb.settleAt(0, {
      ok: true,
      view: workBuddyAiSettingsView({
        models: [WORKBUDDY_MODEL, "gpt-5.5"],
        offeredModels: [WORKBUDDY_MODEL, "gpt-5.5"],
        meta: {
          [WORKBUDDY_MODEL]: {
            label: "DeepSeek V4.1 Flash",
            reasoning: { app_default_effort: "high", supported_efforts: ["low", "high", "max"], supported_efforts_source: "command-code" }
          },
          "gpt-5.5": {
            label: "GPT-5.5",
            reasoning: { app_default_effort: "high", supported_efforts: ["low", "medium", "high", "xhigh"], supported_efforts_source: "official-app" }
          }
        },
        // Legacy shape: the stored global effort (`max`) came from an earlier
        // DeepSeek configuration while the stored default model is GPT now.
        defaultModel: "gpt-5.5",
        effort: "max"
      })
    });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 60000, "the WorkBuddy controls");
    await waitForPage(page.evaluate, () => `document.getElementById("wbDefaultEffort").options.length === 5`, 20000, "the selected model's Reasoning options");

    const legacy = await page.evaluate(`(() => {
      const select = document.getElementById("wbDefaultEffort");
      const issues = document.getElementById("wbModelIssues");
      return {
        value: select.value,
        options: Array.from(select.options).map((option) => ({ value: option.value, label: option.textContent || "" })),
        issuesHidden: issues.classList.contains("hidden"),
        issuesText: issues.textContent || ""
      };
    })()`);
    assert.deepEqual(
      legacy.options.map((option: { value: string }) => option.value),
      ["", "low", "medium", "high", "xhigh"],
      "only the selected model's published vocabulary plus Unspecified is offered"
    );
    assert.equal(legacy.value, "", "the unsupported legacy effort does not masquerade as a current choice");
    assert.equal(legacy.options.some((option: { value: string }) => option.value === "max"), false, "the persisted cross-model max is not an option");
    assert.equal(legacy.options.some((option: { label: string }) => option.label.includes("Saved setting")), false, "no saved-setting option is fabricated for the selected model");
    assert.equal(legacy.issuesHidden, false, "the reset is presented honestly instead of silently");
    assert.match(legacy.issuesText, /Saved default-model reasoning effort "max" is not supported by the selected default model/);
    assert.match(legacy.issuesText, /saving will clear it/);
    assert.equal(wb.calls, 1, "the honest presentation needs no extra provider read");
    console.log(`[hub-ui-wb-effort-legacy] EV1 legacy max under GPT: ${JSON.stringify(legacy)}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T9 — Command Code installed-package provenance surface (JQ-20261001-28)
// ---------------------------------------------------------------------------

/**
 * The defect this guards (JQ-20261001-28): ordinary Command Code Settings
 * permanently showed the installed-package provenance sentence. The limitation
 * is now a secondary tooltip on the model selects while the catalog-health
 * state stays a warning row: a healthy catalog shows no permanent provenance
 * row, and a failed catalog still warns.
 */
test("Command Code installed-package provenance is a model-select tooltip, not a permanent Settings row; failures still warn", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-cc-provenance-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const cc = controlledSettingsProvider("command-code");
  const wb = controlledSettingsProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, settingsReads: reads });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    const selectProvider = async (provider: "command-code" | "workbuddy-ai"): Promise<void> => {
      await page.evaluate(`(() => {
        const select = document.getElementById("settingsProvider");
        select.value = ${JSON.stringify(provider)};
        select.dispatchEvent(new Event("change"));
      })()`);
    };

    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitFor(() => cc.calls === 1, 10000, "the first Command Code read");

    const healthyView = commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"], freeModels: ["cc/model-b"] });
    healthyView.catalog.source = "installed-package-reference";
    cc.settleAt(0, { ok: true, view: healthyView });
    await waitForPage(page.evaluate, () => `!document.getElementById("defaultModel").disabled`, 60000, "the Command Code controls");

    const healthy = await page.evaluate(`(() => {
      const info = document.getElementById("catalogInfo");
      return {
        hidden: info.classList.contains("hidden"),
        warning: info.classList.contains("warning"),
        text: info.textContent || "",
        defaultTitle: document.getElementById("defaultModel").title,
        fallbackTitle: document.getElementById("fallbackModel").title,
        options: Array.from(document.getElementById("defaultModel").options).map((option) => option.textContent || "")
      };
    })()`);
    assert.equal(healthy.hidden, true, "a healthy installed-package catalog shows no permanent provenance row");
    assert.doesNotMatch(healthy.text, /installed Command Code package/, "the removed row carries no relocated provenance text");
    assert.equal(healthy.warning, false, "the healthy catalog row stays non-warning");
    assert.match(healthy.defaultTitle, /installed Command Code package's own shipped model reference/);
    assert.match(healthy.defaultTitle, /not a live billing guarantee/);
    assert.equal(healthy.fallbackTitle, healthy.defaultTitle, "both model selects carry the secondary provenance tooltip");
    assert.ok(
      healthy.options.includes("cc/model-b · Free now"),
      `Free-now labels are unchanged (got ${JSON.stringify(healthy.options)})`
    );
    console.log("[hub-ui-cc-provenance] EV1 healthy installed-package catalog: no permanent row, tooltip provenance kept");

    // A provider round-trip proves the failure state still warns.
    await selectProvider("workbuddy-ai");
    await waitFor(() => wb.calls === 1, 10000, "the WorkBuddy read");
    wb.settleAt(0, { ok: true, view: workBuddyAiSettingsView({ models: ["hy3"], offeredModels: ["hy3"] }) });
    await waitForPage(page.evaluate, () => `!document.getElementById("wbDefaultModel").disabled`, 60000, "the WorkBuddy controls");

    await selectProvider("command-code");
    await waitFor(() => cc.calls === 2, 10000, "the second Command Code read");
    const failingView = commandCodeSettingsView({ models: ["cc/model-a", "cc/model-b"] });
    failingView.catalog.available = false;
    failingView.catalog.reliable = false;
    failingView.catalog.error = "Injected catalog failure";
    cc.settleAt(1, { ok: true, view: failingView });
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("catalogInfo").classList.contains("hidden")`,
      60000,
      "the catalog failure warning"
    );

    const failure = await page.evaluate(`(() => {
      const info = document.getElementById("catalogInfo");
      return {
        warning: info.classList.contains("warning"),
        text: info.innerText || "",
        defaultTitle: document.getElementById("defaultModel").title
      };
    })()`);
    assert.equal(failure.warning, true, "an unreliable catalog keeps the warning styling");
    assert.match(failure.text, /Model list unavailable or could not be verified\./);
    assert.match(failure.text, /Injected catalog failure/);
    assert.equal(failure.defaultTitle, "", "the healthy-provenance tooltip is cleared in the failure state");
    console.log(`[hub-ui-cc-provenance] EV2 catalog failure still warns: ${JSON.stringify(failure.text)}`);
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// T9 — terminal error semantics in the conversation view (JQ-20261001-22)
// ---------------------------------------------------------------------------

/**
 * The defect: a terminal job with no assistant text collapsed the conversation
 * panel to the generic `No assistant result was recorded` line, hiding the
 * concrete durable cause. The live shape is `job-mupcezb5-huccj9`:
 * status=error, failure_kind=provider_refusal, stop_reason=refusal,
 * rateLimited=false, finalText=null — the user must see that WorkBuddy AI
 * refused the request.
 *
 * Contract proven here against the SHIPPED client in a real browser:
 *   A — the exact refusal shape renders a clear refusal notice and never the
 *       generic no-result line, as UI metadata (no fabricated assistant
 *       bubble), with the raw durable error text neither served by the Hub nor
 *       rendered;
 *   A3 — JQ-20261001-23: within the SAME provider_refusal classification, a
 *       bounded `content_filter` finish reason renders the content-filter
 *       notice and an explicit `refusal` renders the explicit-refusal notice,
 *       while the finish-reason-less historical refusal above stays generic;
 *   B — a rate-limited job keeps its existing `Rate limit:` line and is never
 *       presented as a refusal;
 *   C — a generic terminal error renders an honest generic notice;
 *   D — cancelled / interrupted each render their own cause;
 *   E — successful and plain done/no-result sessions keep their historical
 *       rendering;
 *   F — a session that ends while OPEN switches from "still working" to the
 *       notice on the existing refresh cadence;
 *   G — the compact Live activity result row names the terminal reason.
 */
test("terminal errors show their durable cause in the conversation instead of only the generic no-result line (JQ-20261001-22)", { timeout: 180000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-terminal-error-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const project = path.join(dir, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const MODEL = "deepseek-v4.1-flash";
  const SESSION_ID = "01a0ecaf-aa3e-799c-90ea-7680e8184d7e";
  const REFUSAL_MESSAGE = "WorkBuddy AI refused this request (stop_reason=refusal); no task result was produced.";
  const EXPECTED_REFUSAL_NOTICE = "WorkBuddy AI refused this request, so no assistant result was produced.";
  // JQ-20261001-23: the provider finish reason distinguishes the two refusals
  // the runtime collapses into the same ACP stop reason.
  const EXPECTED_CONTENT_FILTER_NOTICE = "WorkBuddy AI blocked this request with its content filter, so no assistant result was produced.";
  const EXPECTED_EXPLICIT_REFUSAL_NOTICE = "WorkBuddy AI explicitly refused this request, so no assistant result was produced.";
  // JQ-20261001-24: the provider's bounded terminal detail is appended as a
  // refinement; the classification wording above stays authoritative.
  const PROVIDER_DETAIL = "Model service error: upstream content policy";
  const EXPECTED_CONTENT_FILTER_DETAIL_NOTICE = `${EXPECTED_CONTENT_FILTER_NOTICE} Provider detail: ${PROVIDER_DETAIL}`;
  const EXPECTED_MODEL_ERROR_NOTICE = "WorkBuddy AI's model service ended the run with an error, so no assistant result was produced.";
  // JQ-20261001-25: the declined interactive approval gate is a permission
  // interruption, never a cancellation.
  const EXPECTED_PERMISSION_REQUIRED_NOTICE =
    "WorkBuddy AI required approval for a high-risk/safety-sensitive tool action, and CrewDispatch is non-interactive, so the run stopped.";
  const EXPECTED_RATE_LIMIT_NOTICE = "The provider rate limit was reached, so no assistant result was produced.";
  const EXPECTED_GENERIC_NOTICE = "Run 1 ended with an error before an assistant result was recorded.";
  // The approval-interruption follow-up: a COMPLETED turn whose gated operation
  // never ran must say so under BOTH providers, and the distinct stopped causes
  // are named without ever inventing a human decision.
  const EXPECTED_COMPLETED_REJECTION_NOTICE =
    "Command Code completed its turn after its approval request for a tool action was rejected, so that operation did not run.";
  const EXPECTED_COMPLETED_EXPIRY_NOTICE =
    "WorkBuddy AI completed its turn after an approval request expired before a decision, so that operation did not run.";
  const EXPECTED_STOPPED_REJECTION_NOTICE =
    "WorkBuddy AI's approval request for a tool action was rejected, so that operation did not run.";
  const EXPECTED_LEGACY_DENIED_NOTICE =
    "Command Code completed its turn after a tool approval was denied, so the operation that required approval did not run.";
  const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

  const attempt = (overrides: Partial<JobAttempt>): JobAttempt => ({
    generation: 0,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: null,
    kind: null,
    failureKind: null,
    segment: false,
    resumedFrom: null,
    model: null,
    modelSource: null,
    effort: null,
    rateLimited: false,
    switched: false,
    switchToModel: null,
    usage: emptyUsage(),
    ...overrides
  });

  interface TerminalFixture {
    task: string;
    provider: string;
    status: JobStatus;
    failureKind?: string | null;
    stopReason?: string | null;
    finishReason?: string | null;
    /** The provider's already-sanitized bounded terminal detail (JQ-20261001-24). */
    errorDetail?: string | null;
    /** The turn's proven approval outcome token (canonical `approval_outcome`). */
    approvalOutcome?: string | null;
    result?: JobRecord["result"];
    attempts?: JobAttempt[];
    assistantText?: string;
    /** false = persist ONLY the job record (no first-message history side-car). */
    withHistory?: boolean;
  }
  const makeTerminalJob = (options: TerminalFixture): JobRecord => {
    const at = new Date().toISOString();
    const job = createJobRecord({ task: options.task, cwd: project, provider: options.provider, model: MODEL });
    job.status = options.status;
    job.startedAt = at;
    job.finishedAt = TERMINAL.has(options.status) ? at : null;
    job.failureKind = options.failureKind ?? null;
    job.stopReason = options.stopReason ?? null;
    job.finishReason = options.finishReason ?? null;
    job.errorDetail = options.errorDetail ?? null;
    job.approvalOutcome = options.approvalOutcome ?? null;
    job.result = options.result ?? null;
    job.attempts = options.attempts ?? [];
    saveJob(root, job);
    if (options.withHistory !== false) appendUserMessageOrThrow(root, job.id, { generation: 0, text: options.task, at });
    if (options.assistantText) appendAssistantMessageOrThrow(root, job.id, { generation: 0, text: options.assistantText, at });
    return job;
  };

  // The exact live shape of JQ-20261001-22 / job-mupcezb5-huccj9.
  const refusal = makeTerminalJob({
    task: "REFUSAL_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_refusal",
    stopReason: "refusal",
    result: { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 11, kind: "provider_refusal", failureKind: "provider_refusal", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });
  // Its real terminal log record: the ACP bridge's classified failure record.
  fs.mkdirSync(path.dirname(logPath(root, refusal.id)), { recursive: true });
  fs.writeFileSync(
    logPath(root, refusal.id),
    [
      JSON.stringify({ type: "init", session_id: SESSION_ID, model: MODEL }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        stop_reason: "refusal",
        result: null,
        error: { code: "provider_refusal", message: REFUSAL_MESSAGE },
        session_id: SESSION_ID,
        model: MODEL
      })
    ].join("\n") + "\n",
    "utf8"
  );

  // The same refusal shape persisted WITHOUT the message-history side-car: the
  // durable cause must stay visible on its own (a fixture may record only the
  // job record).
  const refusalNoHistory = makeTerminalJob({
    task: "REFUSAL_NO_HISTORY_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_refusal",
    stopReason: "refusal",
    result: { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 11, kind: "provider_refusal", failureKind: "provider_refusal", rateLimited: false, model: MODEL, modelSource: "explicit" })],
    withHistory: false
  });

  // JQ-20261001-23: BOTH are the same stable provider_refusal classification;
  // only the bounded provider finish reason tells them apart.
  const contentFilter = makeTerminalJob({
    task: "CONTENT_FILTER_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_refusal",
    stopReason: "refusal",
    finishReason: "content_filter",
    result: { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finishReason: "content_filter", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 11, kind: "provider_refusal", failureKind: "provider_refusal", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });
  const explicitRefusal = makeTerminalJob({
    task: "EXPLICIT_REFUSAL_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_refusal",
    stopReason: "refusal",
    finishReason: "refusal",
    result: { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finishReason: "refusal", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 11, kind: "provider_refusal", failureKind: "provider_refusal", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });

  // JQ-20261001-24: the same stable provider_refusal + content_filter shape,
  // now with the provider's bounded, already-sanitized terminal diagnostic
  // (`_meta["codebuddy.ai/errorMessage"]` reduced by the bridge). The detail
  // refines the notice; it never changes the classification.
  const refusalDetailJob = makeTerminalJob({
    task: "REFUSAL_DETAIL_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_refusal",
    stopReason: "refusal",
    finishReason: "content_filter",
    errorDetail: PROVIDER_DETAIL,
    result: { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finishReason: "content_filter", errorDetail: PROVIDER_DETAIL, finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 11, kind: "provider_refusal", failureKind: "provider_refusal", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });
  fs.mkdirSync(path.dirname(logPath(root, refusalDetailJob.id)), { recursive: true });
  fs.writeFileSync(
    logPath(root, refusalDetailJob.id),
    [
      JSON.stringify({ type: "init", session_id: SESSION_ID, model: MODEL }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        stop_reason: "refusal",
        finish_reason: "content_filter",
        error_detail: PROVIDER_DETAIL,
        result: null,
        error: { code: "provider_refusal", message: REFUSAL_MESSAGE },
        session_id: SESSION_ID,
        model: MODEL
      })
    ].join("\n") + "\n",
    "utf8"
  );

  // JQ-20261001-24: the installed runtime REJECTS session/prompt as a JSON-RPC
  // error when its model stream ends with finish_reason=error; the bridge
  // classifies it as provider_model_error instead of collapsing to bridge_error.
  const modelError = makeTerminalJob({
    task: "MODEL_ERROR_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_model_error",
    stopReason: "provider_model_error",
    finishReason: "error",
    result: { ok: false, subtype: "error", kind: "provider_model_error", exitCode: 16, stopReason: "provider_model_error", finishReason: "error", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 16, kind: "provider_model_error", failureKind: "provider_model_error", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });

  // JQ-20261001-25: WorkBuddy required an interactive approval for its own
  // high-risk tool gate; CrewDispatch, being non-interactive, declined it, and the
  // runtime completed the turn `stopReason=cancelled, finishReason=tool_calls`.
  // The durable classification must be the permission interruption, never the
  // preserved cancel reasons.
  const permissionRequired = makeTerminalJob({
    task: "PERMISSION_REQUIRED_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_permission_required",
    stopReason: "cancelled",
    finishReason: "tool_calls",
    result: { ok: false, subtype: "error", kind: "provider_permission_required", exitCode: 17, stopReason: "cancelled", finishReason: "tool_calls", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 17, kind: "provider_permission_required", failureKind: "provider_permission_required", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });

  const rateLimited = makeTerminalJob({
    task: "RATE_LIMIT_MARKER",
    provider: "command-code",
    status: "error",
    failureKind: "cli_rate_limited",
    stopReason: "cli_rate_limited",
    result: { ok: false, subtype: "error", kind: "rate_limit", exitCode: 5, stopReason: "cli_rate_limited", finalText: null, fallbackEligible: true },
    attempts: [attempt({ exitCode: 5, kind: "rate_limit", failureKind: "cli_rate_limited", rateLimited: true, model: "cc/model-a", modelSource: "slot" })]
  });
  const generic = makeTerminalJob({
    task: "GENERIC_FAILURE_MARKER",
    provider: "command-code",
    status: "error",
    failureKind: "unknown",
    stopReason: "cli_nonzero",
    result: { ok: false, subtype: "error", kind: "unknown", exitCode: 1, stopReason: "cli_nonzero", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 1, kind: "unknown", failureKind: "unknown", rateLimited: false, model: "cc/model-a", modelSource: "slot" })]
  });
  const cancelled = makeTerminalJob({
    task: "CANCELLED_MARKER",
    provider: "command-code",
    status: "cancelled",
    stopReason: "cancelled",
    attempts: [attempt({ kind: "interrupted", rateLimited: false, model: "cc/model-a", modelSource: "slot" })]
  });
  const interrupted = makeTerminalJob({
    task: "INTERRUPTED_MARKER",
    provider: "workbuddy-ai",
    status: "interrupted",
    failureKind: "owner_lost",
    stopReason: "owner_lost",
    attempts: [attempt({ model: MODEL, modelSource: "explicit" })]
  });
  const success = makeTerminalJob({
    task: "SUCCESS_MARKER",
    provider: "command-code",
    status: "done",
    stopReason: "end_turn",
    result: { ok: true, subtype: "success", kind: "success", exitCode: 0, stopReason: "end_turn", finalText: "SUCCESS_MARKER", fallbackEligible: false },
    attempts: [attempt({ exitCode: 0, kind: "success", rateLimited: false, model: "cc/model-a", modelSource: "slot" })],
    assistantText: "SUCCESS_MARKER"
  });
  const noResult = makeTerminalJob({
    task: "DONE_NO_RESULT_MARKER",
    provider: "workbuddy-ai",
    status: "done",
    stopReason: "end_turn",
    result: { ok: true, subtype: "success", kind: "success", exitCode: 0, stopReason: "end_turn", finalText: null, fallbackEligible: false },
    attempts: [attempt({ exitCode: 0, kind: "success", rateLimited: false, model: MODEL, modelSource: "explicit" })]
  });
  // Starts running and ends in a refusal WHILE the session is open.
  const liveRefusal = makeTerminalJob({
    task: "LIVE_REFUSAL_MARKER",
    provider: "workbuddy-ai",
    status: "running",
    attempts: [attempt({ model: MODEL, modelSource: "explicit" })]
  });

  // The approval-interruption follow-up. The production defect: the provider
  // turn COMPLETED (end_turn) while the gated operation was rejected, and the
  // result read as an unqualified success. Both providers must now explain the
  // interruption in the conversation AND in the compact status area.
  const completedRejection = makeTerminalJob({
    task: "COMPLETED_REJECTION_MARKER",
    provider: "command-code",
    status: "done",
    stopReason: "end_turn",
    finishReason: "permission_denied",
    approvalOutcome: "rejected",
    result: {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      finishReason: "permission_denied",
      approvalOutcome: "rejected",
      finalText: "The edit was not applied.",
      fallbackEligible: false
    },
    attempts: [attempt({ exitCode: 0, kind: "success", rateLimited: false, model: "cc/model-a", modelSource: "slot" })],
    assistantText: "The edit was not applied."
  });
  const completedExpiry = makeTerminalJob({
    task: "COMPLETED_EXPIRY_MARKER",
    provider: "workbuddy-ai",
    status: "done",
    stopReason: "end_turn",
    approvalOutcome: "expired",
    result: {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      approvalOutcome: "expired",
      finalText: "I could not run the command.",
      fallbackEligible: false
    },
    attempts: [attempt({ exitCode: 0, kind: "success", rateLimited: false, model: MODEL, modelSource: "explicit" })],
    assistantText: "I could not run the command."
  });
  // The distinct STOPPED rejection classification (WorkBuddy exit 19).
  const rejectedStopped = makeTerminalJob({
    task: "REJECTED_STOPPED_MARKER",
    provider: "workbuddy-ai",
    status: "error",
    failureKind: "provider_approval_rejected",
    stopReason: "cancelled",
    finishReason: "tool_calls",
    approvalOutcome: "rejected",
    result: {
      ok: false,
      subtype: "error",
      kind: "provider_approval_rejected",
      exitCode: 19,
      stopReason: "cancelled",
      finishReason: "tool_calls",
      approvalOutcome: "rejected",
      finalText: null,
      fallbackEligible: false
    },
    attempts: [
      attempt({
        exitCode: 19,
        kind: "provider_approval_rejected",
        failureKind: "provider_approval_rejected",
        rateLimited: false,
        model: MODEL,
        modelSource: "explicit"
      })
    ]
  });
  // Durable evidence proves a denied tool but not WHY (a record persisted
  // before the token existed): the completed turn says exactly that.
  const legacyDenied = makeTerminalJob({
    task: "LEGACY_DENIED_MARKER",
    provider: "command-code",
    status: "done",
    stopReason: "end_turn",
    finishReason: "permission_denied",
    result: {
      ok: true,
      subtype: "success",
      kind: "success",
      exitCode: 0,
      stopReason: "end_turn",
      finishReason: "permission_denied",
      finalText: "Denied.",
      fallbackEligible: false
    },
    attempts: [attempt({ exitCode: 0, kind: "success", rateLimited: false, model: "cc/model-a", modelSource: "slot" })],
    assistantText: "Denied."
  });
  // Precedence fixtures: a rate limit and a user cancellation keep their own
  // notices even when an approval token is present beside them.
  const rateLimitWithApproval = makeTerminalJob({
    task: "RATE_LIMIT_WITH_APPROVAL_MARKER",
    provider: "command-code",
    status: "error",
    failureKind: "cli_rate_limited",
    stopReason: "cli_rate_limited",
    approvalOutcome: "no_route",
    result: {
      ok: false,
      subtype: "error",
      kind: "rate_limit",
      exitCode: 5,
      stopReason: "cli_rate_limited",
      approvalOutcome: "no_route",
      finalText: null,
      fallbackEligible: true
    },
    attempts: [attempt({ exitCode: 5, kind: "rate_limit", failureKind: "cli_rate_limited", rateLimited: true, model: "cc/model-a", modelSource: "slot" })]
  });
  const cancelledWithToken = makeTerminalJob({
    task: "CANCELLED_WITH_TOKEN_MARKER",
    provider: "command-code",
    status: "cancelled",
    stopReason: "cancelled",
    approvalOutcome: "cancelled",
    attempts: [attempt({ kind: "interrupted", rateLimited: false, model: "cc/model-a", modelSource: "slot" })]
  });

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    // --- A(api): the Hub detail carries the stable classification for the
    //     refusal shape and never the raw durable error/stderr text. ---
    const refusalDetail = (await (await fetch(`${hubUrl}/api/jobs/${refusal.id}`)).json()) as any;
    assert.equal(refusalDetail.status, "error");
    assert.equal(refusalDetail.failure_kind, "provider_refusal", "the durable failure kind reaches the browser view");
    assert.equal(refusalDetail.stop_reason, "refusal", "the provider's own stop reason reaches the browser view");
    assert.equal(refusalDetail.result.kind, "provider_refusal");
    assert.equal(refusalDetail.result.stop_reason, "refusal");
    assert.equal(refusalDetail.result.final_text, null, "the refusal really has no assistant final text");
    assert.equal(refusalDetail.assistant_content, null);
    assert.equal(refusalDetail.attempts[0].rate_limited, false, "the live refusal is not a rate-limit attempt");
    assert.equal("error" in refusalDetail, false, "the raw durable error/stderr text is not served to the browser");
    assert.equal(refusalDetail.finish_reason, null, "the historical refusal carries no finish reason; the generic notice path applies");

    // JQ-20261001-23: the same stable classification, told apart ONLY by the
    // bounded provider finish reason — served display-safe on the job and result.
    const contentFilterDetail = (await (await fetch(`${hubUrl}/api/jobs/${contentFilter.id}`)).json()) as any;
    assert.equal(contentFilterDetail.status, "error");
    assert.equal(contentFilterDetail.failure_kind, "provider_refusal", "content_filter keeps the stable shared classification");
    assert.equal(contentFilterDetail.stop_reason, "refusal", "the raw stop reason is served intact");
    assert.equal(contentFilterDetail.finish_reason, "content_filter", "the provider finish reason is served display-safe");
    assert.equal(contentFilterDetail.result.finish_reason, "content_filter");
    assert.equal(contentFilterDetail.assistant_content, null);
    assert.equal("error" in contentFilterDetail, false, "no raw provider payload/stderr is served");

    const explicitRefusalDetail = (await (await fetch(`${hubUrl}/api/jobs/${explicitRefusal.id}`)).json()) as any;
    assert.equal(explicitRefusalDetail.failure_kind, "provider_refusal");
    assert.equal(explicitRefusalDetail.stop_reason, "refusal");
    assert.equal(explicitRefusalDetail.finish_reason, "refusal", "an explicit refusal keeps its own finish reason");
    assert.equal(explicitRefusalDetail.result.finish_reason, "refusal");
    assert.equal("error" in explicitRefusalDetail, false);
    assert.equal(explicitRefusalDetail.error_detail, null, "a record without a provider detail keeps null");

    // JQ-20261001-24: the already-sanitized provider detail is served on the job
    // and the result, while the raw durable error text is still never served.
    const refusalDetailApi = (await (await fetch(`${hubUrl}/api/jobs/${refusalDetailJob.id}`)).json()) as any;
    assert.equal(refusalDetailApi.failure_kind, "provider_refusal", "the detail never changes the classification");
    assert.equal(refusalDetailApi.stop_reason, "refusal");
    assert.equal(refusalDetailApi.finish_reason, "content_filter");
    assert.equal(refusalDetailApi.error_detail, PROVIDER_DETAIL, "the bounded provider detail is served display-safe");
    assert.equal(refusalDetailApi.result.error_detail, PROVIDER_DETAIL);
    assert.equal("error" in refusalDetailApi, false, "the raw durable error/stderr text is still never served");

    // The model-service rejection (finish_reason=error) keeps its own stable
    // classification and the proven finish reason.
    const modelErrorDetail = (await (await fetch(`${hubUrl}/api/jobs/${modelError.id}`)).json()) as any;
    assert.equal(modelErrorDetail.failure_kind, "provider_model_error", "a model-service error is not served as a generic bridge error");
    assert.equal(modelErrorDetail.stop_reason, "provider_model_error");
    assert.equal(modelErrorDetail.finish_reason, "error");
    assert.equal(modelErrorDetail.result.finish_reason, "error");
    assert.equal(modelErrorDetail.attempts[0].rate_limited, false, "a model error is not a rate limit");
    assert.equal("error" in modelErrorDetail, false);

    // The approval-outcome token is served display-safe on the job AND the
    // compact result for BOTH providers, and stays null where no evidence was
    // ever recorded (a legacy record is never back-filled).
    const completedRejectionApi = (await (await fetch(`${hubUrl}/api/jobs/${completedRejection.id}`)).json()) as any;
    assert.equal(completedRejectionApi.status, "done", "the completed turn keeps its status semantics");
    assert.equal(completedRejectionApi.approval_outcome, "rejected", "the job-level token reaches the browser view");
    assert.equal(completedRejectionApi.result.approval_outcome, "rejected");
    assert.equal(completedRejectionApi.finish_reason, "permission_denied", "the provider's own denial evidence stays served");
    assert.equal("error" in completedRejectionApi, false, "no raw payload is served");
    const completedExpiryApi = (await (await fetch(`${hubUrl}/api/jobs/${completedExpiry.id}`)).json()) as any;
    assert.equal(completedExpiryApi.status, "done");
    assert.equal(completedExpiryApi.approval_outcome, "expired");
    assert.equal(completedExpiryApi.result.approval_outcome, "expired");
    const rejectedStoppedApi = (await (await fetch(`${hubUrl}/api/jobs/${rejectedStopped.id}`)).json()) as any;
    assert.equal(rejectedStoppedApi.status, "error");
    assert.equal(rejectedStoppedApi.failure_kind, "provider_approval_rejected", "the distinct rejection classification is served");
    assert.equal(rejectedStoppedApi.approval_outcome, "rejected");
    assert.equal(rejectedStoppedApi.result.kind, "provider_approval_rejected");
    assert.equal(rejectedStoppedApi.result.approval_outcome, "rejected");
    const legacyDeniedApi = (await (await fetch(`${hubUrl}/api/jobs/${legacyDenied.id}`)).json()) as any;
    assert.equal(legacyDeniedApi.approval_outcome, null, "a record persisted before the token existed keeps null");
    assert.equal(legacyDeniedApi.result.approval_outcome ?? null, null, "and the result is never back-filled either");
    assert.equal(legacyDeniedApi.finish_reason, "permission_denied", "its durable denial evidence is still served");

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `document.querySelectorAll("#jobs button.job").length >= 20`,
      15000,
      "the terminal-error fixtures in the sidebar"
    );

    const openAndRead = async (job: JobRecord, title = job.task): Promise<{ text: string; notices: string[]; assistantBubbles: number; fallback: string; status: string }> => {
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(job.id)}]').click()`);
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(title)}`,
        15000,
        `detail of ${title}`
      );
      return (await page.evaluate(`(() => {
        const conversation = document.getElementById("conversation");
        return {
          text: conversation.innerText || "",
          notices: Array.from(conversation.querySelectorAll(".notice")).map((node) => node.textContent || ""),
          assistantBubbles: conversation.querySelectorAll(".bubble.assistant").length,
          fallback: document.getElementById("jobFallback").textContent || "",
          status: document.getElementById("jobStatus").textContent || ""
        };
      })()`)) as { text: string; notices: string[]; assistantBubbles: number; fallback: string; status: string };
    };

    // The shipped mapping itself: precedence and the final-attempt rate-limit
    // proof, exercised directly against the served client script.
    const mapping = (await page.evaluate(`(() => ({
      refusal: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", result: { kind: "provider_refusal", stop_reason: "refusal" }, attempts: [{ rate_limited: false }] }),
      refusalWithRateLimitFlag: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", result: null, attempts: [{ rate_limited: true }] }),
      contentFilter: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter", result: { kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter" }, attempts: [{ rate_limited: false }] }),
      contentFilterByResultOnly: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", result: { kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter" }, attempts: [] }),
      contentFilterWithRateLimitFlag: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter", result: null, attempts: [{ rate_limited: true }] }),
      explicitRefusal: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", finish_reason: "refusal", result: { kind: "provider_refusal", stop_reason: "refusal", finish_reason: "refusal" }, attempts: [] }),
      contentFilterWithDetail: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter", error_detail: "Model service error: upstream content policy", result: { kind: "provider_refusal", stop_reason: "refusal", finish_reason: "content_filter" }, attempts: [] }),
      detailNeverOverridesCause: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_refusal", stop_reason: "refusal", finish_reason: "refusal", error_detail: "Model service error: upstream content policy", result: null, attempts: [] }),
      modelError: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_model_error", stop_reason: "provider_model_error", finish_reason: "error", result: { kind: "provider_model_error", stop_reason: "provider_model_error", finish_reason: "error" }, attempts: [] }),
      permissionRequired: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_permission_required", stop_reason: "cancelled", finish_reason: "tool_calls", result: { kind: "provider_permission_required", stop_reason: "cancelled", finish_reason: "tool_calls" }, attempts: [] }),
      permissionRequiredWithRateLimitFlag: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_permission_required", stop_reason: "cancelled", finish_reason: "tool_calls", result: null, attempts: [{ rate_limited: true }] }),
      plainCancelledWithToolCalls: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_cancelled", stop_reason: "cancelled", finish_reason: "tool_calls", result: { kind: "provider_cancelled", stop_reason: "cancelled", finish_reason: "tool_calls" }, attempts: [] }),
      rateLimitByAttempt: terminalErrorNotice({ status: "error", generation: 1, provider: "command-code", failure_kind: null, stop_reason: null, result: null, attempts: [{ rate_limited: false }, { rate_limited: true }] }),
      rateLimitByEarlierAttemptOnly: terminalErrorNotice({ status: "error", generation: 1, provider: "command-code", failure_kind: null, stop_reason: null, result: null, attempts: [{ rate_limited: true }, { rate_limited: false }] }),
      explicitCodeBeatsAttempt: terminalErrorNotice({ status: "error", generation: 0, provider: "command-code", failure_kind: "cli_auth_error", stop_reason: "cli_auth_error", result: null, attempts: [{ rate_limited: true }] }),
      done: terminalErrorNotice({ status: "done", generation: 0, provider: "command-code", failure_kind: null, stop_reason: "end_turn", result: { kind: "success" }, attempts: [] }),
      // The approval-interruption follow-up: a COMPLETED turn that still
      // carries a proven unresolved approval outcome explains it; a plain
      // completion keeps "". The token is read from the job and the result.
      completedRejection: terminalErrorNotice({ status: "done", generation: 0, provider: "command-code", finish_reason: "permission_denied", approval_outcome: "rejected", result: { kind: "success", finish_reason: "permission_denied", approval_outcome: "rejected" }, attempts: [] }),
      completedRejectionJobTokenOnly: terminalErrorNotice({ status: "done", generation: 0, provider: "command-code", approval_outcome: "rejected", result: { kind: "success" }, attempts: [] }),
      completedRejectionResultTokenOnly: terminalErrorNotice({ status: "done", generation: 0, provider: "command-code", result: { kind: "success", approval_outcome: "rejected" }, attempts: [] }),
      completedExpiry: terminalErrorNotice({ status: "done", generation: 0, provider: "workbuddy-ai", approval_outcome: "expired", result: { kind: "success", approval_outcome: "expired" }, attempts: [] }),
      completedNoRoute: terminalErrorNotice({ status: "done", generation: 0, provider: "workbuddy-ai", approval_outcome: "no_route", result: { kind: "success" }, attempts: [] }),
      completedNoAllowOption: terminalErrorNotice({ status: "done", generation: 0, provider: "workbuddy-ai", approval_outcome: "no_allow_option", result: { kind: "success" }, attempts: [] }),
      completedPublishFailed: terminalErrorNotice({ status: "done", generation: 0, provider: "workbuddy-ai", approval_outcome: "publish_failed", result: { kind: "success" }, attempts: [] }),
      completedCancelledToken: terminalErrorNotice({ status: "done", generation: 0, provider: "workbuddy-ai", approval_outcome: "cancelled", result: { kind: "success" }, attempts: [] }),
      rejectedStopped: terminalErrorNotice({ status: "error", generation: 0, provider: "workbuddy-ai", failure_kind: "provider_approval_rejected", stop_reason: "cancelled", finish_reason: "tool_calls", approval_outcome: "rejected", result: { kind: "provider_approval_rejected", stop_reason: "cancelled", finish_reason: "tool_calls", approval_outcome: "rejected" }, attempts: [] }),
      legacyDenied: terminalErrorNotice({ status: "done", generation: 0, provider: "command-code", finish_reason: "permission_denied", result: { kind: "success", finish_reason: "permission_denied" }, attempts: [] }),
      rateLimitWithApproval: terminalErrorNotice({ status: "error", generation: 0, provider: "command-code", failure_kind: "cli_rate_limited", stop_reason: "cli_rate_limited", approval_outcome: "no_route", result: { kind: "rate_limit", approval_outcome: "no_route" }, attempts: [] }),
      cancelledWithToken: terminalErrorNotice({ status: "cancelled", generation: 0, provider: "command-code", approval_outcome: "cancelled", result: { kind: "success" }, attempts: [] })
    }))()`)) as Record<string, unknown>;
    assert.equal(mapping.refusal, EXPECTED_REFUSAL_NOTICE);
    assert.equal(mapping.refusalWithRateLimitFlag, EXPECTED_REFUSAL_NOTICE, "refusal precedence holds even beside a rate-limited attempt flag");
    assert.equal(mapping.contentFilter, EXPECTED_CONTENT_FILTER_NOTICE, "content_filter is named, never collapsed to a generic refusal");
    assert.equal(mapping.contentFilterByResultOnly, EXPECTED_CONTENT_FILTER_NOTICE, "the result-level finish reason is honored too");
    assert.equal(mapping.contentFilterWithRateLimitFlag, EXPECTED_CONTENT_FILTER_NOTICE, "content_filter precedence holds beside a rate-limited attempt flag");
    assert.equal(mapping.explicitRefusal, EXPECTED_EXPLICIT_REFUSAL_NOTICE, "an explicit refusal says so");
    assert.equal(mapping.contentFilterWithDetail, EXPECTED_CONTENT_FILTER_DETAIL_NOTICE, "the bounded provider detail refines the content-filter notice");
    assert.equal(mapping.detailNeverOverridesCause, `WorkBuddy AI explicitly refused this request, so no assistant result was produced. Provider detail: Model service error: upstream content policy`, "the detail refines, but the finish reason still selects the cause");
    assert.equal(mapping.modelError, EXPECTED_MODEL_ERROR_NOTICE, "a model-service error is named specifically, never as a generic failure");
    assert.equal(mapping.permissionRequired, EXPECTED_PERMISSION_REQUIRED_NOTICE, "a declined high-risk approval gate is named as a permission interruption");
    assert.equal(mapping.permissionRequiredWithRateLimitFlag, EXPECTED_PERMISSION_REQUIRED_NOTICE, "the permission interruption outranks an unrelated rate-limited attempt flag");
    assert.notEqual(mapping.permissionRequired, mapping.plainCancelledWithToolCalls, "the preserved cancel reasons can never make it read as a cancellation");
    assert.notEqual(mapping.permissionRequired, mapping.refusal, "a permission interruption is distinct from a refusal");
    assert.notEqual(mapping.permissionRequired, mapping.rateLimitByAttempt, "a permission interruption is distinct from a rate limit");
    assert.notEqual(mapping.permissionRequired, mapping.modelError, "a permission interruption is distinct from a model error");
    assert.equal(mapping.plainCancelledWithToolCalls, "Run 1 was cancelled before an assistant result was recorded.", "a plain provider cancellation keeps its existing wording");
    assert.equal(mapping.rateLimitByAttempt, EXPECTED_RATE_LIMIT_NOTICE, "a final rate-limited attempt proves the cause when no code is present");
    assert.equal(mapping.rateLimitByEarlierAttemptOnly, "Run 2 ended with an error before an assistant result was recorded.", "an earlier rate-limited attempt alone never claims the terminal failure was a rate limit");
    assert.equal(mapping.explicitCodeBeatsAttempt, "Command Code could not authenticate this run, so no assistant result was produced.", "an explicit failure code outranks a rate-limited attempt flag");
    assert.equal(mapping.done, "", "a done job never produces the notice");
    assert.equal(mapping.completedRejection, EXPECTED_COMPLETED_REJECTION_NOTICE, "a completed turn with a proven rejection explains that the gated operation did not run");
    assert.equal(mapping.completedRejectionJobTokenOnly, EXPECTED_COMPLETED_REJECTION_NOTICE, "the job-level token alone proves the interruption");
    assert.equal(mapping.completedRejectionResultTokenOnly, EXPECTED_COMPLETED_REJECTION_NOTICE, "the result-level token alone proves the interruption");
    assert.equal(mapping.completedExpiry, EXPECTED_COMPLETED_EXPIRY_NOTICE, "a completed turn whose approval expired says so");
    assert.equal(mapping.completedNoRoute, "WorkBuddy AI completed its turn without an interactive approval route, so that operation did not run.");
    assert.equal(mapping.completedNoAllowOption, "WorkBuddy AI completed its turn after an approval request that offered no approval option, so that operation did not run.");
    assert.equal(mapping.completedPublishFailed, "WorkBuddy AI completed its turn after its approval request could not be published, so that operation did not run.");
    assert.equal(mapping.completedCancelledToken, "WorkBuddy AI completed its turn after its approval request was cancelled before a decision, so that operation did not run.");
    assert.equal(mapping.rejectedStopped, EXPECTED_STOPPED_REJECTION_NOTICE, "a stopped turn names the real rejection");
    assert.notEqual(mapping.rejectedStopped, EXPECTED_PERMISSION_REQUIRED_NOTICE, "a real rejection is never reported as the non-interactive decline");
    assert.equal(mapping.legacyDenied, EXPECTED_LEGACY_DENIED_NOTICE, "a denied tool without a proven cause says exactly that");
    assert.notEqual(mapping.legacyDenied, EXPECTED_COMPLETED_REJECTION_NOTICE, "missing evidence never invents a human rejection");
    assert.equal(mapping.rateLimitWithApproval, EXPECTED_RATE_LIMIT_NOTICE, "rate-limit evidence keeps its precedence over a side approval token");
    assert.equal(mapping.cancelledWithToken, "Run 1 was cancelled before an assistant result was recorded.", "a user cancellation keeps its precedence over a side approval token");
    console.log("[hub-ui-terminal-error] EV-0 shipped mapping: precedence + final-attempt rate-limit proof + approval-interruption causes");

    // --- A: the refusal shape renders the concrete cause. ---
    const refusalView = await openAndRead(refusal);
    assert.deepEqual(refusalView.notices, [EXPECTED_REFUSAL_NOTICE], "the refusal reason is the visible conversation notice");
    assert.equal(refusalView.text.includes("No assistant result was recorded"), false, "the generic line is replaced, not merely accompanied");
    assert.equal(refusalView.assistantBubbles, 0, "the notice is UI metadata, never a fabricated assistant bubble");
    assert.equal(refusalView.fallback, "", "a provider refusal is never presented as a rate limit");
    assert.doesNotMatch(refusalView.text, /evidence|failure[_ ]kind|stop_reason|stderr|exit code/i, "no internal jargon or raw stderr reaches the user");
    console.log(`[hub-ui-terminal-error] EV-A refusal: ${JSON.stringify(refusalView.notices[0])}`);

    // --- G: the compact Live activity result row names the terminal reason. ---
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("log").innerText || "").includes("Result · error · refusal")`,
      15000,
      "the compact refusal result row"
    );
    const refusalLog = String(await page.evaluate(`document.getElementById("log").innerText`));
    assert.equal(refusalLog.includes(REFUSAL_MESSAGE), false, "the compact row never dumps the raw provider message");
    console.log("[hub-ui-terminal-error] EV-G live activity: Result · error · refusal");

    // A refusal persisted without the history side-car still names the cause.
    const noHistoryView = await openAndRead(refusalNoHistory, refusalNoHistory.id);
    assert.ok(noHistoryView.notices.includes(EXPECTED_REFUSAL_NOTICE), "the refusal reason is visible even without the history side-car");
    assert.equal(noHistoryView.text.includes("No assistant result was recorded"), false, "no generic no-result line is shown either");
    console.log("[hub-ui-terminal-error] EV-A2 refusal without history side-car still names the cause");

    // --- A3/A4 (JQ-20261001-23): content_filter and explicit refusal render
    //     DISTINCT notices under the same stable provider_refusal, while the
    //     no-finishReason historical refusal above stays generic. ---
    const contentFilterView = await openAndRead(contentFilter);
    assert.deepEqual(contentFilterView.notices, [EXPECTED_CONTENT_FILTER_NOTICE], "the content filter is named specifically");
    assert.equal(contentFilterView.text.includes(EXPECTED_REFUSAL_NOTICE), false, "a content filter is never collapsed to the generic refusal wording");
    assert.equal(contentFilterView.assistantBubbles, 0, "the notice is UI metadata, never a fabricated assistant bubble");
    assert.doesNotMatch(contentFilterView.text, /evidence|failure[_ ]kind|stop_reason|stderr|exit code/i, "no internal jargon or raw stderr reaches the user");
    console.log(`[hub-ui-terminal-error] EV-A3 content filter: ${JSON.stringify(contentFilterView.notices[0])}`);

    const explicitRefusalView = await openAndRead(explicitRefusal);
    assert.deepEqual(explicitRefusalView.notices, [EXPECTED_EXPLICIT_REFUSAL_NOTICE], "an explicit refusal says exactly that");
    assert.equal(explicitRefusalView.text.includes(EXPECTED_REFUSAL_NOTICE), false, "an explicit refusal is not collapsed to generic wording");
    assert.equal(explicitRefusalView.assistantBubbles, 0);
    console.log(`[hub-ui-terminal-error] EV-A4 explicit refusal: ${JSON.stringify(explicitRefusalView.notices[0])}`);

    // --- A5/A6 (JQ-20261001-24): the bounded provider detail refines the
    //     refusal notice, and the model-service rejection is named. Neither
    //     exposes internal payloads, jargon or raw stderr. ---
    const refusalDetailView = await openAndRead(refusalDetailJob);
    assert.deepEqual(refusalDetailView.notices, [EXPECTED_CONTENT_FILTER_DETAIL_NOTICE], "the safe provider detail is appended to the authoritative content-filter cause");
    assert.equal(refusalDetailView.text.includes(EXPECTED_CONTENT_FILTER_NOTICE), true, "the classification wording stays the base sentence");
    assert.equal(refusalDetailView.assistantBubbles, 0, "the refined notice is still UI metadata, never a fabricated assistant bubble");
    assert.equal(refusalDetailView.text.includes("internal-must-not-leak"), false, "no provider data payload can reach the UI");
    assert.doesNotMatch(refusalDetailView.text, /evidence|failure[_ ]kind|stop_reason|stderr|exit code/i, "no internal jargon or raw stderr reaches the user");
    console.log(`[hub-ui-terminal-error] EV-A5 refusal detail: ${JSON.stringify(refusalDetailView.notices[0])}`);

    const modelErrorView = await openAndRead(modelError);
    assert.deepEqual(modelErrorView.notices, [EXPECTED_MODEL_ERROR_NOTICE], "the model-service error is named, never collapsed to the generic failure wording");
    assert.equal(modelErrorView.fallback, "", "a model error is never presented as a rate limit");
    assert.equal(/refus|rate limit/i.test(modelErrorView.text), false, "a model-service error claims neither refusal nor rate limit");
    assert.equal(modelErrorView.assistantBubbles, 0);
    console.log(`[hub-ui-terminal-error] EV-A6 model service error: ${JSON.stringify(modelErrorView.notices[0])}`);

    // --- A7 (JQ-20261001-25): a declined high-risk approval gate is a
    //     permission interruption, never a cancellation, and never any other
    //     cause. ---
    const permissionRequiredView = await openAndRead(permissionRequired);
    assert.deepEqual(permissionRequiredView.notices, [EXPECTED_PERMISSION_REQUIRED_NOTICE], "the approval gate is named, never presented as a cancellation");
    assert.equal(/refus|rate limit|explicitly refused|content filter|model service/i.test(permissionRequiredView.text), false, "the permission interruption claims no other cause");
    assert.equal(permissionRequiredView.text.includes("was cancelled"), false, "it never reads as a user/CrewDispatch cancellation");
    assert.equal(permissionRequiredView.assistantBubbles, 0, "the notice is UI metadata, never a fabricated assistant bubble");
    assert.doesNotMatch(permissionRequiredView.text, /evidence|failure[_ ]kind|stop_reason|stderr|exit code/i, "no internal jargon or raw stderr reaches the user");
    console.log(`[hub-ui-terminal-error] EV-A7 permission interruption: ${JSON.stringify(permissionRequiredView.notices[0])}`);

    // --- B: rate limit keeps its own line and is never confused with refusal. ---
    const rateLimitView = await openAndRead(rateLimited);
    assert.equal(rateLimitView.fallback, "Rate limit: cc/model-a", "the existing Rate limit line is unchanged");
    assert.deepEqual(rateLimitView.notices, [EXPECTED_RATE_LIMIT_NOTICE], "a rate limit is explicitly identified");
    assert.equal(/refus/i.test(rateLimitView.text), false, "a rate limit is never presented as a refusal");
    console.log(`[hub-ui-terminal-error] EV-B rate limit: ${JSON.stringify(rateLimitView.fallback)} / ${JSON.stringify(rateLimitView.notices[0])}`);

    // --- C: a generic terminal error gets an honest generic notice. ---
    const genericView = await openAndRead(generic);
    assert.deepEqual(genericView.notices, [EXPECTED_GENERIC_NOTICE], "an unclassified error is not left as the generic no-result line");
    assert.equal(/refus|rate limit/i.test(genericView.text), false, "a generic failure claims no specific cause");
    console.log(`[hub-ui-terminal-error] EV-C generic: ${JSON.stringify(genericView.notices[0])}`);

    // --- D: cancel and interrupted each render their own cause. ---
    const cancelledView = await openAndRead(cancelled);
    assert.deepEqual(cancelledView.notices, ["Run 1 was cancelled before an assistant result was recorded."]);
    const interruptedView = await openAndRead(interrupted);
    assert.deepEqual(interruptedView.notices, ["Run 1 was interrupted before an assistant result was recorded."]);
    console.log(`[hub-ui-terminal-error] EV-D cancel/interrupted: ${JSON.stringify(cancelledView.notices[0])} / ${JSON.stringify(interruptedView.notices[0])}`);

    // --- E: success and plain done/no-result rendering are unchanged. ---
    const successView = await openAndRead(success);
    assert.deepEqual(successView.notices, [], "a successful result carries no error notice");
    assert.equal(successView.assistantBubbles, 1, "the successful assistant reply is unchanged");
    assert.ok(successView.text.includes("SUCCESS_MARKER"), "the successful text is rendered");
    const noResultView = await openAndRead(noResult);
    assert.deepEqual(noResultView.notices, [], "a normal done job with no text gets no error notice");
    assert.equal(
      noResultView.text.includes("No assistant result was recorded for Run 1."),
      true,
      "the historical done/no-result line is unchanged"
    );
    console.log("[hub-ui-terminal-error] EV-E success + done/no-result rendering unchanged");

    // --- H (approval-interruption follow-up): a COMPLETED turn whose gated
    //     operation did not run is never presented as an unqualified success,
    //     and the proven cause is named for BOTH providers in the conversation
    //     AND the compact status area. The stopped rejection and the
    //     evidence-less legacy denial stay distinct. ---
    const completedRejectionView = await openAndRead(completedRejection);
    assert.deepEqual(completedRejectionView.notices, [EXPECTED_COMPLETED_REJECTION_NOTICE], "the completed rejection is explained, never an unqualified success");
    assert.equal(completedRejectionView.assistantBubbles, 1, "the completed turn's own reply is preserved, not replaced by the notice");
    assert.equal(completedRejectionView.status, "Status: done · Run 1 · approval rejected", "the compact status area names the proven cause");
    assert.equal(/non-interactive|high-risk/i.test(completedRejectionView.text), false, "a real rejection never reads as the non-interactive decline");
    assert.doesNotMatch(completedRejectionView.text, /evidence|failure[_ ]kind|stop_reason|stderr|exit code/i, "no internal jargon or raw stderr reaches the user");
    console.log(`[hub-ui-terminal-error] EV-H completed rejection: ${JSON.stringify(completedRejectionView.notices[0])} / ${JSON.stringify(completedRejectionView.status)}`);

    const completedExpiryView = await openAndRead(completedExpiry);
    assert.deepEqual(completedExpiryView.notices, [EXPECTED_COMPLETED_EXPIRY_NOTICE], "the completed expiry is explained, never an unqualified success");
    assert.equal(completedExpiryView.assistantBubbles, 1, "the completed turn's own reply is preserved");
    assert.equal(completedExpiryView.status, "Status: done · Run 1 · approval expired", "the compact status area names the expiry");
    console.log(`[hub-ui-terminal-error] EV-H completed expiry: ${JSON.stringify(completedExpiryView.notices[0])} / ${JSON.stringify(completedExpiryView.status)}`);

    const rejectedStoppedView = await openAndRead(rejectedStopped);
    assert.deepEqual(rejectedStoppedView.notices, [EXPECTED_STOPPED_REJECTION_NOTICE], "the stopped rejection names the real decision");
    assert.equal(rejectedStoppedView.status, "Status: error · Run 1 · approval rejected");
    assert.equal(/non-interactive|high-risk/i.test(rejectedStoppedView.text), false, "a real rejection is never reported as the non-interactive decline");
    assert.equal(rejectedStoppedView.assistantBubbles, 0, "the notice is UI metadata, never a fabricated assistant bubble");
    console.log(`[hub-ui-terminal-error] EV-H stopped rejection: ${JSON.stringify(rejectedStoppedView.notices[0])}`);

    const legacyDeniedView = await openAndRead(legacyDenied);
    assert.deepEqual(legacyDeniedView.notices, [EXPECTED_LEGACY_DENIED_NOTICE], "missing evidence says exactly that, never an invented human rejection");
    assert.equal(legacyDeniedView.assistantBubbles, 1);
    assert.equal(legacyDeniedView.status, "Status: done · Run 1", "no token means no fabricated compact cause");
    console.log(`[hub-ui-terminal-error] EV-H legacy denial: ${JSON.stringify(legacyDeniedView.notices[0])}`);

    const rateLimitWithApprovalView = await openAndRead(rateLimitWithApproval);
    assert.deepEqual(rateLimitWithApprovalView.notices, [EXPECTED_RATE_LIMIT_NOTICE], "the rate limit keeps its own notice beside a side approval token");
    assert.equal(rateLimitWithApprovalView.fallback, "Rate limit: cc/model-a", "the existing Rate limit line is unchanged");
    assert.equal(rateLimitWithApprovalView.status, "Status: error · Run 1 · approval unavailable", "the proven side cause stays visible in the status area");
    console.log(`[hub-ui-terminal-error] EV-H rate limit precedence: ${JSON.stringify(rateLimitWithApprovalView.notices[0])} / ${JSON.stringify(rateLimitWithApprovalView.status)}`);

    const cancelledWithTokenView = await openAndRead(cancelledWithToken);
    assert.deepEqual(cancelledWithTokenView.notices, ["Run 1 was cancelled before an assistant result was recorded."], "a user cancellation keeps its own wording");
    assert.equal(cancelledWithTokenView.status, "Status: cancelled · Run 1 · approval cancelled");
    console.log(`[hub-ui-terminal-error] EV-H cancellation precedence: ${JSON.stringify(cancelledWithTokenView.notices[0])} / ${JSON.stringify(cancelledWithTokenView.status)}`);

    // --- F: the notice appears when a session ends while OPEN. ---
    await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(liveRefusal.id)}]').click()`);
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("conversation").innerText || "").includes("is still working on Run 1")`,
      15000,
      "the running conversation state"
    );
    const liveRecord = loadJob(root, liveRefusal.id);
    assert.ok(liveRecord, "the live job record exists on disk");
    liveRecord!.status = "error";
    liveRecord!.finishedAt = new Date().toISOString();
    liveRecord!.failureKind = "provider_refusal";
    liveRecord!.stopReason = "refusal";
    liveRecord!.result = { ok: false, subtype: "error", kind: "provider_refusal", exitCode: 11, stopReason: "refusal", finalText: null, fallbackEligible: false };
    saveJob(root, liveRecord!);
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("conversation").innerText || "").includes(${JSON.stringify(EXPECTED_REFUSAL_NOTICE)})`,
      15000,
      "the live refusal notice after the terminal transition"
    );
    assert.equal(
      String(await page.evaluate(`document.getElementById("conversation").innerText`)).includes("is still working"),
      false,
      "the stale still-working line is replaced on the existing refresh cadence"
    );
    console.log("[hub-ui-terminal-error] EV-F live transition: running -> refusal notice without reopening");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// JQ-20261001-26 — interactive provider approval in the active session
// ---------------------------------------------------------------------------

/**
 * A running provider turn that waits for an approval must be answerable from the
 * Dashboard WITHOUT a reload: the card appears on the existing 2.5s refresh, one
 * provider-published button resolves it exactly once, and a second tab (or any
 * stale click) can never resolve the same request again.
 */
test("a pending provider approval appears live and one button resolves it; a second tab cannot re-resolve it (JQ-20261001-26)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-approval-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const approvalFor = (
    jobId: string,
    generation: number,
    detail: NonNullable<JobRecord["pendingApproval"]>["detail"] = null
  ): NonNullable<JobRecord["pendingApproval"]> => ({
    version: 1,
    kind: "tool_approval",
    provider: "workbuddy-ai",
    jobId,
    generation,
    requestId: "31415",
    toolName: "Bash",
    summary: null,
    detail,
    options: [
      { id: "allow_always", kind: "allow_always", label: "Always Allow" },
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });

  const job = createJobRecord({ task: "APPROVAL_LIVE_MARKER", cwd: project, provider: "workbuddy-ai", model: WORKBUDDY_MODEL });
  job.status = "running";
  job.startedAt = new Date().toISOString();
  saveJob(root, job);
  appendUserMessageOrThrow(root, job.id, { generation: 0, text: job.task, at: job.startedAt });

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const openSession = async (page: PageHandle): Promise<void> => {
      await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
      await page.evaluate(`window.__jobquayNoReload = "kept"`);
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(job.id)}]').click()`);
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(job.task)}`,
        15000,
        "the approval session detail"
      );
    };

    const first = await newPage(cdp, `${hubUrl}/ui`);
    const second = await newPage(cdp, `${hubUrl}/ui`);
    await openSession(first);
    await openSession(second);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 360, deviceScaleFactor: 1, mobile: false }, first.sessionId);
    await waitForPage(first.evaluate, () => `window.innerWidth === 640 && window.innerHeight === 360`, 15000, "the narrow approval viewport");

    // The approval appears on the EXISTING refresh cadence, with no reload: the
    // record changes on disk exactly as the worker would persist it.
    const appearedAt = Date.now();
    const runningJob = loadJob(root, job.id)!;
    // 1. A provider that published NO operation detail: the card says so
    // explicitly instead of showing an empty box.
    runningJob.pendingApproval = approvalFor(job.id, runningJob.generation, null);
    saveJob(root, runningJob);
    await waitForPage(
      first.evaluate,
      () => `(() => {
        const card = document.getElementById("approvalCard");
        if (card.classList.contains("hidden")) return false;
        // The provider's OWN published option order AND labels are preserved:
        // the provider published "Always Allow" / "Allow" / "Reject", so the
        // buttons must show exactly those labels (the canonical kind wording is
        // only a fallback when a label carries no usable text).
        const buttons = Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.textContent || "");
        return buttons.join("|") === "Always Allow|Allow|Reject";
      })()`,
      15000,
      "the live approval card with the provider-published choices"
    );
    assert.ok(Date.now() - appearedAt < POLL_CYCLE_MS + 2500, "the approval appeared within one polling cycle");
    assert.match(
      String(await first.evaluate(`document.getElementById("approvalDetail").innerText`)),
      /Operation details were not provided by the provider\./,
      "a missing operation detail is stated honestly"
    );

    // 2. The provider published an operation: the card shows the ACTUAL command
    // and the path as PLAIN TEXT, and the missing-detail line is gone.
    const withDetail = loadJob(root, job.id)!;
    withDetail.pendingApproval = approvalFor(job.id, withDetail.generation, {
      command: 'node jq-asar-extract.cjs "' + "C:/Program Files/WorkBuddy/resources/app.asar/".repeat(16) + 'resources/app.asar"',
      args: null,
      description: "Extract main/*.js and find finishReason",
      path: "C:/Program Files/WorkBuddy/resources/app.asar",
      cwd: "C:/Users/TestUser/AppData/Local/Temp",
      title: null,
      gate: "toolCallLoop",
      reason: "consecutive_same_tool",
      truncated: false,
      redacted: false
    });
    saveJob(root, withDetail);
    await waitForPage(
      first.evaluate,
      () => `(document.getElementById("approvalDetail").innerText || "").includes("jq-asar-extract.cjs")`,
      15000,
      "the operation detail to render"
    );
    assert.equal(await first.evaluate(`window.__jobquayNoReload`), "kept", "the approval card appeared without a reload");

    const cardText = String(await first.evaluate(`document.getElementById("approvalCard").innerText`));
    assert.match(cardText, /Approval required: Bash/);
    assert.match(cardText, /WorkBuddy AI/);
    assert.match(cardText, /jq-asar-extract\.cjs/, "the actual command is shown");
    assert.match(cardText, /WORKING DIRECTORY/i, "the working directory is labelled");
    assert.match(cardText, /C:\/Program Files\/WorkBuddy/, "the target path is shown");
    // The provider's OWN gate/reason tokens (present on the ACP wire) are shown
    // as plain text — never a guessed risk classification.
    assert.match(cardText, /GATE/i, "the provider's gate is labelled");
    assert.match(cardText, /toolCallLoop/, "the provider's own gate token is shown");
    assert.match(cardText, /REASON/i, "the provider's reason is labelled");
    assert.match(cardText, /consecutive_same_tool/, "the provider's own reason token is shown");
    assert.equal(cardText.includes("Operation details were not provided by the provider."), false);
    assert.equal(cardText.includes("rawInput"), false, "no raw provider payload is shown");
    // With a narrow viewport and long provider text, the card's details scroll
    // while every decision remains inside the visible viewport.
    const approvalGeometry = await first.evaluate(`(() => {
      const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      const card = document.getElementById("approvalCard");
      const detail = document.getElementById("approvalDetail");
      const actions = document.getElementById("approvalActions");
      const buttons = Array.from(actions.querySelectorAll("button"));
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        card: rect(card), workspace: rect(card.parentElement),
        detail: { ...rect(detail), clientHeight: detail.clientHeight, scrollHeight: detail.scrollHeight },
        actions: rect(actions),
        buttons: buttons.map(rect)
      };
    })()`);
    assert.equal(
      approvalGeometry.card.top >= 0 && approvalGeometry.card.bottom <= approvalGeometry.viewport.height + 1
        && approvalGeometry.buttons.length === 3
        && approvalGeometry.buttons.every((button: { top: number; bottom: number }) => button.top >= 0 && button.bottom <= approvalGeometry.viewport.height + 1),
      true,
      `the approval card and each decision button stay within the narrow viewport: ${JSON.stringify(approvalGeometry)}`
    );

    // 3. Provider text is rendered as TEXT, never parsed as HTML.
    const injected = loadJob(root, job.id)!;
    injected.pendingApproval = approvalFor(job.id, injected.generation, {
      command: "<img src=x onerror=alert(1)>",
      args: null,
      description: null,
      path: null,
      cwd: null,
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    });
    saveJob(root, injected);
    await waitForPage(
      first.evaluate,
      () => `(document.getElementById("approvalDetail").innerText || "").includes("<img")`,
      15000,
      "the injected command text"
    );
    assert.equal(await first.evaluate(`document.querySelectorAll("#approvalDetail img").length`), 0, "provider text is never parsed as HTML");
    assert.equal(
      await first.evaluate(`document.getElementById("approvalDetail").querySelector(".approval-op-code").textContent`),
      "<img src=x onerror=alert(1)>",
      "the command is shown verbatim as text"
    );

    // 3b. The COMPLETE operation: the installed CLI's structured shell shape
    // carries the executable in `command` and the arguments SEPARATELY. The
    // detail is produced by the SHARED production sanitizer (the same one the
    // provider boundary and the durable record use), so what renders here is
    // exactly what a real approval would carry: one bounded entry per argument
    // — never a re-joined, invented shell command line — with each argument's
    // own whitespace preserved EXACTLY, an empty argument kept as real argv
    // data (rendered as explicit notation, never filtered out), and a
    // credential-like dummy sentinel redacted.
    const expectedArgs = ["wait-for-resume.cjs", "", " padded arg ", "argument with  two spaces", "--api-key", "<redacted>"];
    const completeDetail = sanitizeApprovalDetail({
      command: "node",
      args: ["wait-for-resume.cjs", "", " padded arg ", "argument with  two spaces", "--api-key", "DUMMY_SENTINEL_NOT_A_REAL_SECRET"],
      cwd: project,
      title: "Shell: node"
    });
    assert.ok(completeDetail, "the shared sanitizer accepts the structured shell detail");
    assert.deepEqual(
      completeDetail!.args,
      expectedArgs,
      "the sanitizer keeps argv boundaries, preserves whitespace byte-for-byte, keeps the empty entry and redacts the flag's value"
    );
    const withArgs = loadJob(root, job.id)!;
    withArgs.pendingApproval = approvalFor(job.id, withArgs.generation, completeDetail);
    saveJob(root, withArgs);
    // Persistence -> Hub: the REAL approval route serves the exact same argv,
    // including the empty argument (it is never normalized away).
    const hubApproval = (await (await fetch(`${hubUrl}/api/jobs/${encodeURIComponent(job.id)}/approval`)).json()) as Record<string, unknown>;
    const hubPending = hubApproval.pending_approval as Record<string, unknown> | null;
    assert.deepEqual(
      (hubPending?.detail as Record<string, unknown> | undefined)?.args,
      expectedArgs,
      "the Hub JSON carries the exact argv, including the empty argument"
    );
    await waitForPage(
      first.evaluate,
      () => `document.querySelectorAll("#approvalDetail .approval-op-args pre").length === 6`,
      15000,
      "the separately supplied arguments to render as their own entries"
    );
    assert.deepEqual(
      await first.evaluate(`Array.from(document.querySelectorAll("#approvalDetail .approval-op-args pre")).map((n) => n.textContent)`),
      ["wait-for-resume.cjs", "(empty argument)", " padded arg ", "argument with  two spaces", "--api-key", "<redacted>"],
      "each argument is its own verbatim entry and the empty one is explicit notation, never dropped"
    );
    assert.equal(
      await first.evaluate(`document.querySelectorAll("#approvalDetail .approval-op-args pre.approval-op-empty").length`),
      1,
      "the empty argument carries the explicit empty-argument notation class"
    );
    const argsText = String(await first.evaluate(`document.getElementById("approvalDetail").innerText`));
    // The labels are uppercased by CSS, so match case-insensitively.
    assert.match(argsText, /command[\s\S]*node/i, "the executable is shown");
    assert.match(argsText, /arguments/i, "the argument row is labelled in the plural");
    assert.match(argsText, /wait-for-resume\.cjs/, "the complete operation is visible");
    assert.equal(argsText.includes("DUMMY_SENTINEL_NOT_A_REAL_SECRET"), false, "the credential-like dummy sentinel never reaches the UI");
    assert.match(argsText, /Note: obvious credentials were redacted\./, "the shared sanitizer's redaction mark is rendered honestly");

    // 3c. Truthful truncation: the shared sanitizer shortens an oversized
    // detail and marks it; the UI shows the bounded text AND the honest note.
    const oversizedDetail = sanitizeApprovalDetail({ command: `node ${"x".repeat(2000)}`, args: null });
    assert.equal(oversizedDetail?.truncated, true, "the shared sanitizer marks the oversized command truncated");
    assert.equal(oversizedDetail?.command?.length, 600, "the displayed command is bounded by the shared cap");
    const oversized = loadJob(root, job.id)!;
    oversized.pendingApproval = approvalFor(job.id, oversized.generation, oversizedDetail);
    saveJob(root, oversized);
    await waitForPage(
      first.evaluate,
      () => `(document.getElementById("approvalDetail").innerText || "").includes("the text was shortened to fit the display limit")`,
      15000,
      "the honest truncation note"
    );
    assert.equal(
      String(await first.evaluate(`document.getElementById("approvalDetail").querySelector(".approval-op-code").textContent`)).length,
      600,
      "the rendered command is exactly the shared bound, never silently cut without the note"
    );

    assert.ok(cardText.includes(job.id), "the card identifies its exact task");
    assert.ok(cardText.includes(job.task), "the card shows the task title");
    assert.match(cardText, /Run 1/);
    assert.match(cardText, /Expires in/);

    // Two waiting jobs, including one beyond the loaded page, stay visible
    // while a third unrelated task is open. None of these fixtures runs a CLI.
    const other = createJobRecord({ task: "OTHER_APPROVAL_TASK", cwd: project, provider: "command-code", model: null });
    other.status = "running";
    other.createdAt = "2000-01-01T00:00:00.000Z";
    other.startedAt = new Date().toISOString();
    other.pendingApproval = { ...approvalFor(other.id, 0), provider: "command-code" };
    saveJob(root, other);
    appendUserMessageOrThrow(root, other.id, { generation:0, text:other.task, at:other.startedAt });
    for (let n=0;n<52;n++) {
      const filler = createJobRecord({ task: `PAGE_FILLER_${n}`, cwd:project, provider:"command-code", model:null });
      filler.status="done"; filler.finishedAt=new Date().toISOString(); saveJob(root,filler);
    }
    const third = createJobRecord({ task:"UNRELATED_SELECTED_TASK", cwd:project, provider:"command-code", model:null });
    third.status="done"; third.createdAt=new Date(Date.now()+1000).toISOString(); third.finishedAt=third.createdAt;
    saveJob(root,third);
    appendUserMessageOrThrow(root,third.id,{generation:0,text:third.task,at:third.createdAt});
    await waitForPage(first.evaluate, () => `document.querySelectorAll('#pendingApprovalList button').length === 2 && !!document.querySelector('#jobs button[data-job-id="${third.id}"]')`, 15000, "all waiting approvals");
    assert.equal(await first.evaluate(`document.querySelector('#jobs button[data-job-id="${other.id}"]') === null`),true,"second waiting job is off-page");
    await first.evaluate(`document.querySelector('#jobs button[data-job-id="${third.id}"]').click()`);
    await waitForPage(first.evaluate, () => `document.getElementById('jobTitle').textContent === 'UNRELATED_SELECTED_TASK' && document.getElementById('approvalCard').classList.contains('hidden')`,15000,"third task selected");
    assert.equal(await first.evaluate(`document.getElementById('pendingApprovalCount').textContent`),"Waiting for approval: 2");
    await first.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${other.id}"]').click()`);
    await waitForPage(first.evaluate, () => `document.getElementById('approvalMeta').textContent.includes('${other.id}')`,15000,"global link opens off-page task");
    await first.evaluate(`document.querySelector('#approvalActions button[data-option-id="allow"]').click()`);
    await waitForPage(first.evaluate, () => `document.querySelectorAll('#pendingApprovalList button').length === 1`,15000,"only the unapproved task remains");
    assert.equal(fs.existsSync(approvalDecisionPath(root,job.id,0,"31415")),false,"B approval leaves A unresolved despite same request id");
    assert.equal(JSON.parse(fs.readFileSync(approvalDecisionPath(root,other.id,0,"31415"),'utf8')).optionId,"allow");
    await first.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${job.id}"]').click()`);
    await waitForPage(first.evaluate, () => `document.getElementById('approvalMeta').textContent.includes('${job.id}')`,15000,"return to A");

    // The second tab sees the same pending approval (two browser tabs).
    await waitForPage(
      second.evaluate,
      () => `!document.getElementById("approvalCard").classList.contains("hidden")`,
      15000,
      "the approval card in the second tab"
    );

    // ONE button resolves it; the buttons are disabled IMMEDIATELY. The
    // provider's own "Allow" label is the choice text (never a canonical alias).
    await first.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).find((b) => b.textContent === "Allow").click()`);
    assert.equal(
      await first.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).every((b) => b.disabled)`),
      true,
      "every choice is disabled the moment one is submitted"
    );

    const decisionPath = approvalDecisionPath(root, job.id, runningJob.generation, "31415");
    for (let attempt = 0; attempt < 50 && !fs.existsSync(decisionPath); attempt += 1) await sleep(100);
    assert.ok(fs.existsSync(decisionPath), "the click claimed exactly one decision for the provider's own option id");
    const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as Record<string, unknown>;
    assert.equal(decision.optionId, "allow");
    assert.equal(decision.kind, "allow_once");
    assert.equal(decision.jobId, job.id);

    // A stale click in the second tab (whose card is still visible until the
    // resolution is reflected) can never re-resolve the same request.
    await second.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).find((b) => b.textContent === "Reject").click()`);
    await waitForPage(
      second.evaluate,
      () => `(document.getElementById("statusbar").textContent || "").includes("already resolved")`,
      15000,
      "the second tab's stable already-resolved answer"
    );
    const afterSecondClick = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as Record<string, unknown>;
    assert.equal(afterSecondClick.optionId, "allow", "the first successful resolution still wins");
    assert.equal(afterSecondClick.decidedAt, decision.decidedAt, "the winner's decision was never overwritten");
    assert.equal(await second.evaluate(`window.__jobquayNoReload`), "kept", "the second tab never reloaded either");

    // Once the resolution is reflected (the record no longer carries the
    // approval, exactly as the worker clears it), both cards disappear instead
    // of remaining clickable.
    const settled = loadJob(root, job.id)!;
    settled.pendingApproval = null;
    settled.status = "done";
    settled.finishedAt = new Date().toISOString();
    saveJob(root, settled);
    await waitForPage(
      first.evaluate,
      () => `document.getElementById("approvalCard").classList.contains("hidden")`,
      15000,
      "the first tab's card is retired"
    );
    await waitForPage(
      second.evaluate,
      () => `document.getElementById("approvalCard").classList.contains("hidden")`,
      15000,
      "the second tab's card is retired"
    );
    assert.equal(await second.evaluate(`window.__jobquayNoReload`), "kept", "retirement happened on the polling cadence, without a reload");
    // Keep a reference to the old rendered button, then replace the request
    // on disk. Even a click before the next refresh cannot approve its successor.
    const again=loadJob(root,job.id)!;
    again.status="running"; again.finishedAt=null; again.generation=1;
    again.pendingApproval=approvalFor(job.id,1); saveJob(root,again);
    await waitForPage(first.evaluate, () => `document.getElementById('approvalMeta').textContent.includes('Run 2') && !document.getElementById('approvalCard').classList.contains('hidden')`,15000,"new run approval");
    await first.evaluate(`window.__oldApprovalButton = document.querySelector('#approvalActions button[data-option-id="allow"]')`);
    again.pendingApproval.requestId="31416"; saveJob(root,again);
    await first.evaluate(`window.__oldApprovalButton.click()`);
    await waitForPage(first.evaluate, () => `document.getElementById('statusbar').textContent.includes('Approval failed')`,15000,"stale button rejected");
    assert.equal(fs.existsSync(approvalDecisionPath(root,job.id,1,"31416")),false,"stale click never approves replacement");
    again.pendingApproval.expiresAt=new Date(Date.now()-1000).toISOString(); saveJob(root,again);
    await waitForPage(first.evaluate, () => `document.getElementById('approvalTitle').textContent === 'Approval expired' && Array.from(document.querySelectorAll('#approvalActions button')).every(b => b.disabled)`,15000,"expiry visible and disabled");
    console.log("[hub-ui-approval] EV-1 identity, off-page global visibility, independent decisions, stale replacement and expiry verified in Chromium");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

test("the approval notification deep link opens the exact off-page job with live/stale/expired state and never auto-approves", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-approval-link-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const requestId = "27182";
  const job = createJobRecord({ task: "DEEP_LINK_APPROVAL_MARKER", cwd: project, provider: "workbuddy-ai", model: WORKBUDDY_MODEL });
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.pendingApproval = {
    version: 1,
    kind: "tool_approval",
    provider: "workbuddy-ai",
    jobId: job.id,
    generation: 0,
    requestId,
    toolName: "Bash",
    summary: null,
    detail: {
      command: "node deep-link-check.cjs --confirm",
      args: null,
      description: null,
      path: null,
      cwd: project,
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    },
    options: [
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  saveJob(root, job);
  appendUserMessageOrThrow(root, job.id, { generation: 0, text: job.task, at: job.startedAt });
  // Newer filler jobs push the linked job beyond the first loaded page.
  for (let n = 0; n < 60; n += 1) {
    const filler = createJobRecord({ task: `DEEP_LINK_FILLER_${n}`, cwd: project, provider: "command-code", model: null });
    filler.status = "done";
    filler.finishedAt = new Date().toISOString();
    saveJob(root, filler);
  }

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const decisionPath = approvalDecisionPath(root, job.id, 0, requestId);

    // 1. A STALE request identity in the link still opens the exact job and its
    // ACTUAL current card, and says honestly that the linked request is gone.
    const stale = await newPage(cdp, `${hubUrl}/ui?job=${encodeURIComponent(job.id)}&generation=0&request=000000`);
    await waitForPage(stale.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      stale.evaluate,
      () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(job.task)}`,
      20000,
      "the linked off-page job opened"
    );
    assert.equal(
      await stale.evaluate(`document.querySelector('#jobs button.job[data-job-id="${job.id}"]') === null`),
      true,
      "the linked job is beyond the loaded page"
    );
    assert.equal(
      await stale.evaluate(`!document.getElementById("approvalCard").classList.contains("hidden")`),
      true,
      "the ACTUAL current approval is shown, not the stale identity"
    );
    assert.match(String(await stale.evaluate(`document.getElementById("statusbar").textContent`)), /no longer pending/, "the stale link is reported honestly");
    assert.equal(fs.existsSync(decisionPath), false, "opening a stale link never submits a decision");

    // 2. The EXACT link the notification carries: same job, live card with the
    // provider's own choices, and still no automatic decision.
    const exact = await newPage(cdp, `${hubUrl}/ui?job=${encodeURIComponent(job.id)}&generation=0&request=${requestId}`);
    await waitForPage(
      exact.evaluate,
      () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(job.task)}`,
      20000,
      "the exact deep link opened the job"
    );
    await waitForPage(exact.evaluate, () => `document.getElementById("approvalTitle").textContent === "Approval required: Bash"`, 15000, "the live approval card");
    assert.deepEqual(
      await exact.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.textContent)`),
      ["Allow", "Reject"],
      "the provider's own published labels are offered (never replaced by a canonical alias)"
    );
    assert.match(String(await exact.evaluate(`document.getElementById("approvalDetail").innerText`)), /deep-link-check\.cjs/, "the actual operation is shown");
    assert.equal(
      await exact.evaluate(`!!document.querySelector('#pendingApprovalList button[data-job-id="${job.id}"]')`),
      true,
      "the global waiting list links the same job"
    );
    assert.equal(fs.existsSync(decisionPath), false, "opening the exact link never approves anything");

    // 3. Expiry on disk: the link shows the task's ACTUAL expired state with
    // disabled choices, and still no decision was written.
    const expired = loadJob(root, job.id)!;
    expired.pendingApproval!.expiresAt = new Date(Date.now() - 1000).toISOString();
    saveJob(root, expired);
    await waitForPage(
      exact.evaluate,
      () => `document.getElementById("approvalTitle").textContent === "Approval expired" && Array.from(document.querySelectorAll("#approvalActions button")).every((b) => b.disabled)`,
      15000,
      "the expired actual state"
    );
    assert.equal(fs.existsSync(decisionPath), false, "an expired link never submits a decision");
    console.log("[hub-ui-approval-link] EV: exact/off-page deep link, stale identity, live choices and expiry verified in Chromium without any automatic decision");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Row 47 — the installed CLI's native `standard` permission saves and reopens
// ---------------------------------------------------------------------------

/**
 * The reported defect: selecting Command Code's native `standard` and pressing
 * Save was rejected with `config_invalid_permission_mode`, although the
 * installed CLI publishes `standard` and the launch path already accepts it.
 * Earlier browser coverage missed the persistence break because its provider
 * definition used a FAKE `applyPatch` that echoed the draft straight back.
 *
 * This test therefore uses the REAL production settings path: `startHub`
 * without an injected `settingsReads` -> `getDefaultSettingsReads()` ->
 * `defaultSettingsProviders()`, whose `applyPatch` is
 * `configView(updateConfig(root, configPatchFromSnake(patch)).config)` against a
 * DISPOSABLE data root. Only the capability/catalog probe is a fixture CLI +
 * real installed-package layout (published help: `standard, plan,
 * accept-edits, yolo`). It proves the whole user-visible path: the published
 * `standard` selected -> real Save button -> the on-disk native value is
 * `standard` -> the refreshed form and a reopened Settings form still show
 * `standard`, never silently repaired to another mode.
 */
test("Command Code's native standard permission saves through the real config path and reopens as standard (row 47)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-cc-standard-save-"));
  const root = path.join(dir, "root");
  const userDataDir = path.join(dir, "chrome-profile");
  const prefixDir = path.join(dir, "npm-prefix");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(prefixDir, { recursive: true });
  // A REAL installed-package layout plus a fixture CLI whose own --help
  // publishes the installed native list, including `standard`.
  writeInstalledCommandCodePackage(prefixDir);
  const fake = writeFakeCommandCodeCli(prefixDir, { name: "cmdc", permissionModes: "standard, plan, accept-edits, yolo" });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: fake.shim,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    FAKE_CLI_LOG: fake.log
  };
  // The persisted config points at the fixture CLI. The native standard is NOT
  // pre-seeded: it must arrive through the real Save.
  updateConfig(root, { cliPath: fake.shim, defaultModel: "stealth/space-bunny-alpha" });
  const diskPermissionMode = (): string | null => {
    try {
      return (JSON.parse(fs.readFileSync(configPath(root), "utf8")) as { permissionMode?: string }).permissionMode ?? null;
    } catch {
      return null;
    }
  };
  assert.equal(diskPermissionMode(), "yolo", "the disposable root starts on the product default, not on standard");

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0, env });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await page.evaluate(`document.getElementById("navSettings").click()`);

    // The capability phase runs the fixture CLI's own --help through the real
    // worker-backed probe; the dropdown must offer exactly the published list.
    await waitForPage(
      page.evaluate,
      () =>
        `(() => {
          const select = document.getElementById("permissionMode");
          return !select.disabled && Array.from(select.options).map((o) => o.value).join(",") === "standard,plan,accept-edits,yolo";
        })()`,
      60000,
      "the fixture CLI's published permission modes (including standard)"
    );

    // Select the native standard and press the REAL Save button.
    await page.evaluate(`(() => {
      const select = document.getElementById("permissionMode");
      select.value = "standard";
      select.dispatchEvent(new Event("change"));
    })()`);
    await waitForPage(page.evaluate, () => `document.getElementById("saveSettings").disabled === false`, 15000, "the Save button after choosing standard");
    await page.evaluate(`document.getElementById("saveSettings").click()`);

    // Save success is proven ON DISK through the real updateConfig/validateConfig
    // write — not by the form merely echoing the draft back.
    try {
      await waitFor(() => diskPermissionMode() === "standard", 60000, "the saved native standard on disk");
    } catch (error) {
      const message = String(await page.evaluate(`document.getElementById("settingsMessage").textContent || ""`));
      throw new Error(`${(error as Error).message}; the form said ${JSON.stringify(message)}`);
    }

    // The post-save fresh read re-renders the form; once its own capability
    // follow-up lands the saved native standard is still selected and enabled.
    await waitForPage(
      page.evaluate,
      () =>
        `(() => {
          const select = document.getElementById("permissionMode");
          return !select.disabled && select.value === "standard" && Array.from(select.options).some((o) => o.value === "standard");
        })()`,
      60000,
      "the refreshed form still showing standard"
    );
    assert.equal(String(await page.evaluate(`document.getElementById("settingsMessage").textContent || ""`)), "", "a successful save leaves no failure message");
    assert.equal(
      String(await page.evaluate(`document.getElementById("yoloWarning").textContent || ""`)),
      STANDARD_NOTE_TEXT,
      "the saved standard shows the standard permission note"
    );

    // Reopening Settings performs a genuinely fresh provider read; the stored
    // native standard must come back unchanged.
    await page.evaluate(`document.getElementById("navJobs").click()`);
    await page.evaluate(`document.getElementById("navSettings").click()`);
    await waitForPage(
      page.evaluate,
      () =>
        `(() => {
          const select = document.getElementById("permissionMode");
          return !select.disabled && select.value === "standard";
        })()`,
      60000,
      "the reopened Settings form still showing standard"
    );
    assert.equal(diskPermissionMode(), "standard", "reopening never rewrites the saved native value");

    const argvs = readInvocationArgs(fake.log).map((argv) => argv.join(" "));
    assert.ok(argvs.some((line) => line.includes("--help")), "the published list really came from the fixture CLI's own help probe");
    console.log(
      `[hub-ui-cc-standard-save] EV: published standard selected -> real Save -> on-disk permissionMode=standard -> refreshed and reopened forms still standard; CLI probes: ${JSON.stringify(argvs)}`
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    resetDefaultSettingsReadsForTests();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Command Code ACP approval — provider identity, operation and native options
// ---------------------------------------------------------------------------

/**
 * The Command Code ACP bridge publishes a pending approval with ITS OWN
 * identity and option ids (`allow_once` / `allow_always` / `reject_once` /
 * `reject_always`) and the CLI's own bounded operation detail (the operation
 * title plus the exact target path, and no shell command). This drives the real
 * Hub UI in a real browser and proves the card renders exactly that: the
 * Command Code identity, the operation/path as plain text, the provider's own
 * labels in the provider's own order, and ONE click claiming the provider's own
 * option id.
 */
test("a Command Code ACP approval renders its identity, operation and native options; one click claims its exact option", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-cc-approval-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const notePath = path.join(project, "note.txt");
  const job = createJobRecord({ task: "CC_ACP_APPROVAL_MARKER", cwd: project, provider: "command-code", model: "fixture/model-a" });
  job.status = "running";
  job.startedAt = new Date().toISOString();
  saveJob(root, job);
  appendUserMessageOrThrow(root, job.id, { generation: 0, text: job.task, at: job.startedAt });
  const running = loadJob(root, job.id)!;
  running.pendingApproval = {
    version: 1,
    kind: "tool_approval",
    provider: "command-code",
    jobId: job.id,
    generation: 0,
    requestId: "7777",
    toolName: "edit",
    summary: null,
    detail: {
      title: "Edit: note.txt",
      command: null,
      args: null,
      path: notePath,
      cwd: null,
      description: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    },
    options: [
      { id: "allow_once", kind: "allow_once", label: "Allow once" },
      { id: "allow_always", kind: "allow_always", label: "Always allow" },
      { id: "reject_once", kind: "reject_once", label: "Reject" },
      { id: "reject_always", kind: "reject_always", label: "Always reject" }
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  };
  saveJob(root, running);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");
    await waitForPage(
      page.evaluate,
      () => `Boolean(document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(job.id)}]'))`,
      15000,
      "the Command Code approval job row"
    );
    await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(job.id)}]').click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(job.task)}`,
      15000,
      "the Command Code approval session"
    );

    // The provider's OWN published option order and labels are preserved.
    try {
      await waitForPage(
        page.evaluate,
        () => `(() => {
          const card = document.getElementById("approvalCard");
          if (card.classList.contains("hidden")) return false;
          const buttons = Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.textContent || "");
          return buttons.join("|") === "Allow once|Always allow|Reject|Always reject";
        })()`,
        15000,
        "the Command Code approval card with the CLI's own options"
      );
    } catch (error) {
      const observed = await page.evaluate(`(() => ({
        cardClass: document.getElementById("approvalCard").className,
        title: document.getElementById("approvalTitle").textContent,
        meta: document.getElementById("approvalMeta").textContent,
        detail: document.getElementById("approvalDetail").innerText,
        actions: document.getElementById("approvalActions").innerHTML,
        status: document.getElementById("statusbar").textContent,
        jobStatus: document.getElementById("jobStatus").textContent
      }))()`);
      throw new Error(`${(error as Error).message}; observed ${JSON.stringify(observed)}`);
    }

    const cardText = String(await page.evaluate(`document.getElementById("approvalCard").innerText`));
    assert.match(cardText, /Approval required: edit/, "the CLI's own tool kind is the approval identity");
    assert.match(cardText, /Command Code/, "the provider identity is Command Code");
    assert.match(cardText, /Edit: note\.txt/, "the provider's own operation title is shown");
    assert.match(cardText, /note\.txt/, "the exact target path is shown");
    assert.equal(cardText.includes("rawInput"), false, "no raw provider payload is shown");
    assert.equal(cardText.includes("session/request_permission"), false, "no transport method name is shown");
    assert.ok(cardText.includes(job.id), "the card identifies its exact task");

    // ONE click claims the provider's OWN option id through the real Hub.
    await page.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).find((b) => b.textContent === "Allow once").click()`);
    const decisionPath = approvalDecisionPath(root, job.id, 0, "7777");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(decisionPath)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the Hub decision");
      await sleep(100);
    }
    const decision = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as { optionId: string; requestId: string };
    assert.equal(decision.optionId, "allow_once", "the exact provider option is claimed");
    assert.equal(decision.requestId, "7777");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      try {
        chrome.kill();
      } catch {
        /* best effort */
      }
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// JQ-20261005-01 — two similar waiting approvals keep their exact identity
// ---------------------------------------------------------------------------

/**
 * Two RUNNING jobs with the SAME task title and distinct ids wait for an
 * approval at the same time (WorkBuddy AI and Command Code, so the shared
 * provider-neutral representation is exercised for both providers). The
 * Dashboard must:
 *   - make the current approval's task identity unmistakable: a dedicated
 *     "Approving task" area with the task display name AND the durable job id
 *     plus provider/run on their own readable line;
 *   - mark the selected entry of the global waiting list (aria-current), and
 *     keep that marking correct when the selection changes although the
 *     waiting list itself does not;
 *   - answer ONLY task A's exact generation/request, leave B pending, and
 *     never switch the open task to B;
 *   - show a later request of the SAME open job through the normal refresh.
 * Neither job starts a provider process; the Hub and the browser are disposable.
 */
test("two similar waiting approvals keep distinct identities, the current entry is marked, and answering one never switches the open task (JQ-20261005-01)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-approval-identity-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  // BOTH tasks carry the SAME first line, so only the durable job identity can
  // tell them apart.
  const SHARED_TITLE = "SHARED_APPROVAL_TITLE";
  const pendingFor = (
    jobId: string,
    generation: number,
    provider: "workbuddy-ai" | "command-code",
    requestId: string,
    toolName: string,
    options: Array<{ id: string; kind: string; label: string }>
  ): NonNullable<JobRecord["pendingApproval"]> => ({
    version: 1,
    kind: "tool_approval",
    provider,
    jobId,
    generation,
    requestId,
    toolName,
    summary: null,
    detail: null,
    options,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });

  const jobA = createJobRecord({ task: SHARED_TITLE, cwd: project, provider: "workbuddy-ai", model: WORKBUDDY_MODEL });
  jobA.status = "running";
  jobA.startedAt = new Date().toISOString();
  saveJob(root, jobA);
  appendUserMessageOrThrow(root, jobA.id, { generation: 0, text: SHARED_TITLE, at: jobA.startedAt });

  const jobB = createJobRecord({ task: SHARED_TITLE, cwd: project, provider: "command-code", model: "fixture/model-a" });
  jobB.status = "running";
  jobB.generation = 1; // Run 2: a submitted decision must stay B's own generation
  jobB.startedAt = new Date().toISOString();
  saveJob(root, jobB);
  appendUserMessageOrThrow(root, jobB.id, { generation: 0, text: SHARED_TITLE, at: jobB.startedAt });

  const REQUEST_A = "61001";
  const REQUEST_B = "61002";
  const NEW_REQUEST_A = "61003";
  const WB_OPTIONS = [
    { id: "allow_always", kind: "allow_always", label: "Always Allow" },
    { id: "allow", kind: "allow_once", label: "Allow" },
    { id: "reject", kind: "reject_once", label: "Reject" }
  ];
  const CC_OPTIONS = [
    { id: "allow_once", kind: "allow_once", label: "Allow once" },
    { id: "allow_always", kind: "allow_always", label: "Always allow" },
    { id: "reject_once", kind: "reject_once", label: "Reject" },
    { id: "reject_always", kind: "reject_always", label: "Always reject" }
  ];

  const seedA = loadJob(root, jobA.id)!;
  seedA.pendingApproval = pendingFor(jobA.id, 0, "workbuddy-ai", REQUEST_A, "Bash", WB_OPTIONS);
  saveJob(root, seedA);
  const seedB = loadJob(root, jobB.id)!;
  seedB.pendingApproval = pendingFor(jobB.id, 1, "command-code", REQUEST_B, "edit", CC_OPTIONS);
  saveJob(root, seedB);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    const identity = async (): Promise<any> => page.evaluate(`(() => ({
      label: document.getElementById("approvalTaskLabel").textContent,
      task: document.getElementById("approvalIdentity").textContent,
      job: document.getElementById("approvalTaskJob").textContent,
      provider: document.getElementById("approvalTaskProvider").textContent,
      meta: document.getElementById("approvalMeta").textContent,
      title: document.getElementById("approvalTitle").textContent,
      card: document.getElementById("approvalCard").innerText
    }))()`);
    const pendingMarking = async (): Promise<any> => page.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll("#pendingApprovalList button"));
      const find = (id) => rows.find((row) => row.dataset.jobId === id) || null;
      const read = (node) => node ? {
        current: node.getAttribute("aria-current"),
        background: getComputedStyle(node).backgroundColor,
        border: getComputedStyle(node).borderLeftColor
      } : null;
      return { count: rows.length, a: read(find(${JSON.stringify(jobA.id)})), b: read(find(${JSON.stringify(jobB.id)})) };
    })()`);

    // Both waiting jobs are listed with their EXACT ids, even though the task
    // titles are identical.
    await waitForPage(page.evaluate, () => `document.querySelectorAll('#pendingApprovalList button').length === 2`, 15000, "both waiting approvals");
    const listText = String(await page.evaluate(`document.getElementById("pendingApprovalList").innerText`));
    assert.ok(listText.includes(jobA.id), "the waiting list names task A's exact id");
    assert.ok(listText.includes(jobB.id), "the waiting list names task B's exact id");

    // Select A from the global waiting list.
    await page.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${jobA.id}"]').click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobA.id}`)} && !document.getElementById("approvalCard").classList.contains("hidden")`,
      15000,
      "task A's approval card"
    );

    const cardA = await identity();
    assert.equal(cardA.label, "Approving task", "the card has a dedicated identity label");
    assert.equal(cardA.task, SHARED_TITLE, "the task display name is shown in the identity area");
    assert.equal(cardA.job, `Job ${jobA.id}`, "the durable job id is shown on its own readable line");
    assert.equal(cardA.provider, "WorkBuddy AI · Run 1", "provider and run are shown beside the job id");
    assert.match(cardA.title, /Approval required: Bash/, "the tool stays distinct from the task identity");
    assert.ok(cardA.meta.includes(jobA.id), "the existing meta line still identifies the job");
    assert.ok(cardA.card.includes(SHARED_TITLE), "the identical task title is still shown");
    assert.equal(cardA.card.includes(jobB.id), false, "task B's id never appears on task A's card");

    // The waiting list marks the OPEN task as the current entry, visibly.
    const markedA = await pendingMarking();
    assert.equal(markedA.a.current, "true", "task A's waiting entry is the current one");
    assert.equal(markedA.b.current, "false");
    assert.notEqual(markedA.a.background, markedA.b.background, "the current entry is visibly distinct");
    assert.notEqual(markedA.a.border, markedA.b.border, "the current entry carries the visible selection marker");

    // Changing the selection must move the marker even though the waiting list
    // itself does not change (its rows are intentionally NOT rebuilt).
    await page.evaluate(`window.__pendingRowsBefore = Array.from(document.querySelectorAll("#pendingApprovalList button"))`);
    await page.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${jobB.id}"]').click()`);
    await waitForPage(page.evaluate, () => `document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobB.id}`)}`, 15000, "task B's approval card");
    const sameRows = await page.evaluate(`(() => {
      const before = window.__pendingRowsBefore || [];
      const now = Array.from(document.querySelectorAll("#pendingApprovalList button"));
      return now.length === before.length && now.every((node, index) => node === before[index]);
    })()`);
    assert.equal(sameRows, true, "a selection change did not rebuild the waiting list");
    const markedB = await pendingMarking();
    assert.equal(markedB.a.current, "false");
    assert.equal(markedB.b.current, "true", "the marker follows the selection");
    const cardB = await identity();
    assert.equal(cardB.job, `Job ${jobB.id}`, "the selected task's own identity is rendered");
    assert.equal(cardB.provider, "Command Code · Run 2");
    assert.ok(cardB.card.includes(jobB.id));
    assert.equal(cardB.card.includes(jobA.id), false, "task A's id never appears on task B's card");

    // Narrow/short viewport: the identity area and every decision stay visible.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 360, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await waitForPage(page.evaluate, () => `window.innerWidth === 640 && window.innerHeight === 360`, 15000, "the narrow approval viewport");
    await waitForPage(page.evaluate, () => `document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobB.id}`)}`, 15000, "task B identity in the narrow viewport");
    const narrowGeometry = await page.evaluate(`(() => {
      const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const card = document.getElementById("approvalCard");
      const jobLine = document.getElementById("approvalTaskJob");
      const actions = document.getElementById("approvalActions");
      return {
        viewport: window.innerHeight,
        card: rect(card),
        job: rect(jobLine),
        buttons: Array.from(actions.querySelectorAll("button")).map(rect),
        visible: !card.classList.contains("hidden")
      };
    })()`);
    assert.equal(
      narrowGeometry.visible
        && narrowGeometry.card.top >= 0 && narrowGeometry.card.bottom <= narrowGeometry.viewport + 1
        && narrowGeometry.job.top >= 0 && narrowGeometry.job.bottom <= narrowGeometry.viewport + 1
        && narrowGeometry.buttons.length === 4
        && narrowGeometry.buttons.every((button: { top: number; bottom: number }) => button.top >= 0 && button.bottom <= narrowGeometry.viewport + 1),
      true,
      `the identity line and each decision button stay within the narrow viewport: ${JSON.stringify(narrowGeometry)}`
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, page.sessionId);

    // Back to A and answer ONLY A. The decision must bind A's exact generation
    // and request; B must stay pending.
    await page.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${jobA.id}"]').click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobA.id}`)} && Array.from(document.querySelectorAll("#approvalActions button")).some((b) => b.dataset.optionId === "allow")`,
      15000,
      "task A's decisions"
    );
    await page.evaluate(`document.querySelector('#approvalActions button[data-option-id="allow"]').click()`);
    const decisionA = approvalDecisionPath(root, jobA.id, 0, REQUEST_A);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(decisionA); attempt += 1) await sleep(100);
    assert.ok(fs.existsSync(decisionA), "the click claimed exactly A's decision");
    const decisionAValue = JSON.parse(fs.readFileSync(decisionA, "utf8")) as Record<string, unknown>;
    assert.equal(decisionAValue.jobId, jobA.id);
    assert.equal(decisionAValue.generation, 0);
    assert.equal(decisionAValue.requestId, REQUEST_A);
    assert.equal(decisionAValue.optionId, "allow");
    assert.equal(fs.existsSync(approvalDecisionPath(root, jobB.id, 1, REQUEST_B)), false, "task B's request is untouched by A's decision");

    // Answering A must NOT switch the open task to B, and B must remain the
    // only waiting entry. Wait a full refresh cycle to catch any late jump.
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("approvalTitle").textContent === "Decision sent" && document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobA.id}`)}`,
      15000,
      "A's submitted card"
    );
    await sleep(POLL_CYCLE_MS + 700);
    const afterAnswer = await identity();
    const openAfterAnswer = await page.evaluate(`(() => ({
      aCurrent: document.querySelector('#jobs button[data-job-id="${jobA.id}"]')?.getAttribute("aria-current") || null,
      bCurrent: document.querySelector('#jobs button[data-job-id="${jobB.id}"]')?.getAttribute("aria-current") || null
    }))()`);
    assert.equal(afterAnswer.job, `Job ${jobA.id}`, "the open task stays A after answering");
    assert.equal(afterAnswer.title, "Decision sent");
    assert.equal(afterAnswer.card.includes(jobB.id), false, "B's card never replaced A's after the decision");
    assert.equal(openAfterAnswer.aCurrent, "true", "the session list still marks A as open");
    assert.equal(openAfterAnswer.bCurrent, "false");
    const afterAnswerList = await pendingMarking();
    assert.equal(afterAnswerList.count, 1, "only task B still waits");
    assert.equal(afterAnswerList.a, null);
    assert.equal(afterAnswerList.b.current, "false", "B is waiting but is not the open task");

    // The worker consumes A's decision (clears the pending record): the card is
    // retired and the page STILL does not auto-select the other waiting task.
    const consumedA = loadJob(root, jobA.id)!;
    consumedA.pendingApproval = null;
    saveJob(root, consumedA);
    await waitForPage(page.evaluate, () => `document.getElementById("approvalCard").classList.contains("hidden")`, 15000, "A's card retired");
    await sleep(300);
    assert.equal(
      await page.evaluate(`document.querySelector('#jobs button[data-job-id="${jobA.id}"]')?.getAttribute("aria-current") || null`),
      "true",
      "A stays the open task after its card retires"
    );
    assert.equal(
      await page.evaluate(`document.getElementById("approvalTaskJob").textContent`),
      `Job ${jobA.id}`,
      "the retired card still carries A's identity, never B's"
    );

    // A NEW request on the SAME open job appears through the normal refresh.
    const againA = loadJob(root, jobA.id)!;
    againA.pendingApproval = pendingFor(jobA.id, 0, "workbuddy-ai", NEW_REQUEST_A, "Bash", WB_OPTIONS);
    saveJob(root, againA);
    await waitForPage(
      page.evaluate,
      () => `!document.getElementById("approvalCard").classList.contains("hidden") && document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobA.id}`)}`,
      15000,
      "A's new request"
    );
    const renewed = await identity();
    assert.equal(renewed.job, `Job ${jobA.id}`, "the new request belongs to the same open task");
    assert.equal(renewed.provider, "WorkBuddy AI · Run 1");
    const renewedList = await pendingMarking();
    assert.equal(renewedList.count, 2, "A's new request joins the waiting list again");
    assert.equal(renewedList.a.current, "true");

    // Selecting B renders B's identity and submits ONLY B's exact generation
    // and request; A's new request stays untouched.
    await page.evaluate(`document.querySelector('#pendingApprovalList button[data-job-id="${jobB.id}"]').click()`);
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("approvalTaskJob").textContent === ${JSON.stringify(`Job ${jobB.id}`)} && Array.from(document.querySelectorAll("#approvalActions button")).some((b) => b.dataset.optionId === "allow_once")`,
      15000,
      "task B's decisions"
    );
    const beforeB = await identity();
    assert.equal(beforeB.job, `Job ${jobB.id}`);
    assert.equal(beforeB.provider, "Command Code · Run 2");
    assert.equal(beforeB.card.includes(jobA.id), false);
    await page.evaluate(`document.querySelector('#approvalActions button[data-option-id="allow_once"]').click()`);
    const decisionB = approvalDecisionPath(root, jobB.id, 1, REQUEST_B);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(decisionB); attempt += 1) await sleep(100);
    assert.ok(fs.existsSync(decisionB), "the click claimed exactly B's decision");
    const decisionBValue = JSON.parse(fs.readFileSync(decisionB, "utf8")) as Record<string, unknown>;
    assert.equal(decisionBValue.jobId, jobB.id);
    assert.equal(decisionBValue.generation, 1, "B's own run generation is submitted, never A's");
    assert.equal(decisionBValue.requestId, REQUEST_B);
    assert.equal(decisionBValue.optionId, "allow_once");
    assert.equal(fs.existsSync(approvalDecisionPath(root, jobA.id, 0, NEW_REQUEST_A)), false, "A's new request is untouched by B's decision");
    assert.equal(
      await page.evaluate(`document.querySelector('#jobs button[data-job-id="${jobB.id}"]')?.getAttribute("aria-current") || null`),
      "true",
      "B stays the open task after its own decision"
    );
    console.log("[hub-ui-approval-identity] EV-1 identical titles, readable identity, marked selection, stable open task and per-job decisions verified in Chromium");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// JQ-20261005-56 — every provider option keeps its own distinct display label
// ---------------------------------------------------------------------------

/**
 * A real Command Code ACP planning question published THREE distinct options
 * that all carry `kind=allow_once` with DIFFERENT provider labels. The card
 * used to replace every recognised kind with one canonical phrase, so the three
 * choices rendered as three identical "Allow once" buttons even though the
 * submitted option ids differed — the user could not know what was selected.
 * This drives the real Hub UI in a real browser and proves:
 *   - each provider label is the choice text, in the provider's own order, for
 *     BOTH provider ids (the shared provider-neutral representation);
 *   - clicking the MIDDLE choice persists only its original option id under its
 *     own job/generation/request, and the submission feedback names that same
 *     choice;
 *   - an option with no usable label falls back to the readable canonical kind
 *     wording (or its own id for an unknown kind), HTML-looking text is rendered
 *     as text, and long labels wrap inside the card on a narrow view without any
 *     decision becoming unreachable.
 */
test("three same-kind provider options keep distinct labels, and the middle choice submits only its own id under both providers (JQ-20261005-56)", { timeout: 240000 }, async (t) => {
  const browserPath = findChromium();
  if (!browserPath) {
    t.skip("no Chromium browser (Chrome/Edge) available; runtime browser evidence not produced");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-ui-approval-labels-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  const userDataDir = path.join(dir, "chrome-profile");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  // The EXACT bounded labels the production Command Code ACP planning question
  // published (each already clipped at the provider boundary's label cap). They
  // are shown as-is; missing prose is never reconstructed.
  const OBSERVED = [
    "Eligible-only, recovery disabled (Recommended): Codex records re",
    "Recover only provably-FAILED codex handoffs: Recover a codex_thr",
    "Not in scope at all: Recovery ships for claude_session only; no"
  ] as const;
  const observedOptions = OBSERVED.map((label, index) => ({ id: `option_${index}`, kind: "allow_once", label }));

  const pendingFor = (
    jobId: string,
    generation: number,
    provider: "workbuddy-ai" | "command-code",
    requestId: string,
    options: Array<{ id: string; kind: string; label: string }>
  ): NonNullable<JobRecord["pendingApproval"]> => ({
    version: 1,
    kind: "tool_approval",
    provider,
    jobId,
    generation,
    requestId,
    toolName: "question",
    summary: null,
    detail: null,
    options,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString()
  });

  const REQUEST_A = "56001";
  const REQUEST_B = "56002";
  const REQUEST_SAFE = "56003";

  const jobA = createJobRecord({ task: "DISTINCT_OPTION_LABELS_A", cwd: project, provider: "workbuddy-ai", model: WORKBUDDY_MODEL });
  jobA.status = "running";
  jobA.startedAt = new Date().toISOString();
  saveJob(root, jobA);
  appendUserMessageOrThrow(root, jobA.id, { generation: 0, text: jobA.task, at: jobA.startedAt });

  const jobB = createJobRecord({ task: "DISTINCT_OPTION_LABELS_B", cwd: project, provider: "command-code", model: "fixture/model-a" });
  jobB.status = "running";
  jobB.generation = 1; // Run 2: the submitted decision must stay B's own generation
  jobB.startedAt = new Date().toISOString();
  saveJob(root, jobB);
  appendUserMessageOrThrow(root, jobB.id, { generation: 0, text: jobB.task, at: jobB.startedAt });

  const seedA = loadJob(root, jobA.id)!;
  seedA.pendingApproval = pendingFor(jobA.id, 0, "workbuddy-ai", REQUEST_A, observedOptions);
  saveJob(root, seedA);
  const seedB = loadJob(root, jobB.id)!;
  seedB.pendingApproval = pendingFor(jobB.id, 1, "command-code", REQUEST_B, observedOptions);
  saveJob(root, seedB);

  let hub: HubHandle | null = null;
  let chrome: ChildProcess | null = null;
  let cdp: Cdp | null = null;
  try {
    hub = startHub({ root, host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      hub!.server.once("listening", () => resolve());
      hub!.server.once("error", reject);
    });
    const hubUrl = await waitForHubUrl(hub);

    chrome = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
      ],
      { stdio: "ignore", windowsHide: true }
    );
    const devtoolsPortFile = path.join(userDataDir, "DevToolsActivePort");
    const devtoolsPort = Number((await readDevToolsActivePort(devtoolsPortFile, 20000)).split("\n")[0]);
    assert.ok(Number.isInteger(devtoolsPort) && devtoolsPort > 0, "DevTools port was published");
    const version = await waitForJson(`http://127.0.0.1:${devtoolsPort}/json/version`, 15000);
    cdp = await connectCdp(String(version.webSocketDebuggerUrl));

    const page = await newPage(cdp, `${hubUrl}/ui`);
    await waitForPage(page.evaluate, () => `document.readyState === "complete"`, 15000, "page ready");

    const openJob = async (jobId: string, task: string): Promise<void> => {
      // `document.readyState === complete` only proves the shell loaded; the job
      // list is populated by an async API refresh. On a slower fresh macOS runner
      // clicking immediately can dereference null and surface only a generic CDP
      // `Uncaught`. Wait for the exact row before exercising the real click.
      await waitForPage(
        page.evaluate,
        () => `document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]') != null`,
        15000,
        `job row ${task}`
      );
      await page.evaluate(`document.querySelector('#jobs button.job[data-job-id=${JSON.stringify(jobId)}]').click()`);
      await waitForPage(
        page.evaluate,
        () => `document.getElementById("jobTitle").textContent === ${JSON.stringify(task)} && !document.getElementById("approvalCard").classList.contains("hidden")`,
        15000,
        `the approval session ${task}`
      );
    };
    const waitForButtons = async (expected: readonly string[]): Promise<void> => {
      await waitForPage(
        page.evaluate,
        () => `JSON.stringify(Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.textContent)) === ${JSON.stringify(JSON.stringify(expected))}`,
        15000,
        `the ${expected.length} distinct choice labels`
      );
    };

    // 1. The three same-kind options render their THREE distinct provider
    // labels — never three identical canonical "Allow once" buttons — in the
    // provider's own order with the provider's own ids.
    await openJob(jobA.id, jobA.task);
    await waitForButtons(OBSERVED);
    const labelsA = (await page.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.textContent)`)) as string[];
    assert.equal(new Set(labelsA).size, 3, "three same-kind choices keep three distinct labels");
    assert.equal(labelsA.includes("Allow once"), false, "the canonical kind wording never replaces a distinct provider label");
    assert.deepEqual(
      await page.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).map((b) => b.dataset.optionId)`),
      ["option_0", "option_1", "option_2"],
      "the provider's own option order and ids are preserved"
    );

    // 1b. Narrow/short window: the long labels wrap inside the card and every
    // decision stays reachable (the card scrolls instead of clipping).
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 360, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await waitForPage(page.evaluate, () => `window.innerWidth === 640 && window.innerHeight === 360`, 15000, "the narrow approval viewport");
    const reach = await page.evaluate(`(() => {
      const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      const card = document.getElementById("approvalCard");
      const buttons = Array.from(document.querySelectorAll("#approvalActions button"));
      const results = buttons.map((button) => {
        button.scrollIntoView({ block: "nearest" });
        const box = rect(button);
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        return { text: button.textContent, ...box, wrapped: button.scrollWidth <= button.clientWidth + 1, hit: hit === button || (!!hit && button.contains(hit)) };
      });
      return { viewport: { width: window.innerWidth, height: window.innerHeight }, card: { ...rect(card), overflowY: getComputedStyle(card).overflowY }, results };
    })()`);
    assert.equal(
      reach.card.top >= 0 && reach.card.bottom <= reach.viewport.height + 1 && reach.card.overflowY !== "hidden",
      true,
      `the approval card stays inside the narrow viewport and never clips its content: ${JSON.stringify(reach.card)}`
    );
    assert.equal(reach.results.length, 3, "all three long-label decisions are laid out");
    for (const button of reach.results) {
      assert.equal(
        button.top >= 0 && button.bottom <= reach.viewport.height + 1 && button.left >= 0 && button.right <= reach.viewport.width + 1 && button.wrapped && button.hit,
        true,
        `every long-label decision wraps and stays reachable in the narrow viewport: ${JSON.stringify(button)}`
      );
    }
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, page.sessionId);

    // 2. Cross-provider equivalence: the SAME canonical options under the
    // Command Code id render the same three labels through the shared card.
    await openJob(jobB.id, jobB.task);
    await waitForButtons(OBSERVED);

    // 3. The MIDDLE choice submits only its own option id, under B's own
    // generation/request; A's request stays untouched.
    await page.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).find((b) => b.textContent === ${JSON.stringify(OBSERVED[1])}).click()`);
    const decisionB = approvalDecisionPath(root, jobB.id, 1, REQUEST_B);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(decisionB); attempt += 1) await sleep(100);
    assert.ok(fs.existsSync(decisionB), "the middle choice claimed exactly B's decision");
    const decisionBValue = JSON.parse(fs.readFileSync(decisionB, "utf8")) as Record<string, unknown>;
    assert.equal(decisionBValue.jobId, jobB.id);
    assert.equal(decisionBValue.generation, 1, "B's own run generation is submitted");
    assert.equal(decisionBValue.requestId, REQUEST_B);
    assert.equal(decisionBValue.optionId, "option_1", "the middle provider option id is echoed, never the first option or a canonical kind");
    assert.equal(fs.existsSync(approvalDecisionPath(root, jobA.id, 0, REQUEST_A)), false, "A's request is untouched by B's decision");
    await waitForPage(
      page.evaluate,
      () => `(document.getElementById("statusbar").textContent || "").includes(${JSON.stringify(`Approval submitted: ${OBSERVED[1]}`)})`,
      15000,
      "the submission feedback naming the chosen provider label"
    );

    // 4. The same click on A's middle choice writes only A's own identity, and
    // the submitted card names the chosen provider label.
    await openJob(jobA.id, jobA.task);
    await waitForButtons(OBSERVED);
    await page.evaluate(`Array.from(document.querySelectorAll("#approvalActions button")).find((b) => b.textContent === ${JSON.stringify(OBSERVED[1])}).click()`);
    const decisionA = approvalDecisionPath(root, jobA.id, 0, REQUEST_A);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(decisionA); attempt += 1) await sleep(100);
    assert.ok(fs.existsSync(decisionA), "the middle choice claimed exactly A's decision");
    const decisionAValue = JSON.parse(fs.readFileSync(decisionA, "utf8")) as Record<string, unknown>;
    assert.equal(decisionAValue.jobId, jobA.id);
    assert.equal(decisionAValue.generation, 0);
    assert.equal(decisionAValue.requestId, REQUEST_A);
    assert.equal(decisionAValue.optionId, "option_1");
    assert.equal(
      (JSON.parse(fs.readFileSync(decisionB, "utf8")) as Record<string, unknown>).decidedAt,
      decisionBValue.decidedAt,
      "B's winning decision was never overwritten"
    );
    await waitForPage(
      page.evaluate,
      () => `document.getElementById("approvalTitle").textContent === "Decision sent" && (document.getElementById("approvalDetail").innerText || "").includes(${JSON.stringify(OBSERVED[1])})`,
      15000,
      "the submitted card naming the chosen provider label"
    );

    // 5. Safe fallbacks: no usable label -> readable canonical kind wording for
    // an ordinary allow AND an ordinary reject; an unknown kind -> the
    // provider's own id; HTML-looking text stays TEXT.
    const safeOptions = [
      { id: "html_choice", kind: "allow_once", label: "<img src=x onerror=alert(1)>" },
      { id: "no_label", kind: "allow_once", label: "" },
      { id: "reject_no_label", kind: "reject_once", label: "" },
      { id: "custom_kind", kind: "provider_custom", label: "Custom provider choice" },
      { id: "unknown_no_label", kind: "provider_custom", label: "" },
      { id: "long_token", kind: "allow_once", label: "L".repeat(64) }
    ];
    const withSafe = loadJob(root, jobA.id)!;
    withSafe.pendingApproval = pendingFor(jobA.id, 0, "workbuddy-ai", REQUEST_SAFE, safeOptions);
    saveJob(root, withSafe);
    await waitForButtons(["<img src=x onerror=alert(1)>", "Allow once", "Reject", "Custom provider choice", "unknown_no_label", "L".repeat(64)]);
    assert.equal(await page.evaluate(`document.querySelectorAll("#approvalActions img").length`), 0, "provider label text is never parsed as HTML");
    assert.equal(
      await page.evaluate(`document.querySelector('#approvalActions button[data-option-id="html_choice"]').textContent`),
      "<img src=x onerror=alert(1)>",
      "the HTML-looking label is shown verbatim as text"
    );

    // 5b. Narrow view: the 64-character single-token label wraps inside its
    // button and no choice leaves the viewport or the card.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
    await waitForPage(page.evaluate, () => `window.innerWidth === 420 && window.innerHeight === 900`, 15000, "the narrow long-label viewport");
    const wrap = await page.evaluate(`(() => {
      const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      const card = document.getElementById("approvalCard");
      const buttons = Array.from(document.querySelectorAll("#approvalActions button"));
      const results = buttons.map((button) => {
        button.scrollIntoView({ block: "nearest" });
        const box = rect(button);
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
        return { id: button.dataset.optionId, ...box, clientWidth: button.clientWidth, scrollWidth: button.scrollWidth, clientHeight: button.clientHeight, wrapped: button.scrollWidth <= button.clientWidth + 1, hit: hit === button || (!!hit && button.contains(hit)) };
      });
      return { viewport: { width: window.innerWidth, height: window.innerHeight }, card: rect(card), results };
    })()`);
    const longButton = wrap.results.find((button: { id: string }) => button.id === "long_token");
    const shortButton = wrap.results.find((button: { id: string }) => button.id === "html_choice");
    assert.ok(longButton && shortButton, "the long-token and single-line buttons are both laid out");
    assert.equal(longButton.wrapped, true, "the 64-character label wraps inside its button");
    assert.equal(longButton.clientHeight > shortButton.clientHeight, true, "the long label occupies more than one line");
    assert.equal(
      wrap.results.every((button: { top: number; bottom: number; left: number; right: number; hit: boolean }) =>
        button.top >= 0 && button.bottom <= wrap.viewport.height + 1 && button.left >= 0 && button.right <= wrap.viewport.width + 1 && button.hit),
      true,
      `every decision stays inside the narrow viewport and is clickable: ${JSON.stringify(wrap.results)}`
    );
    assert.equal(
      await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
      true,
      "a long provider label never causes page-level horizontal overflow"
    );
    console.log("[hub-ui-approval-labels] EV-1 three distinct same-kind labels, middle-choice identity under both providers, canonical/unknown fallbacks, HTML-safe and wrapped long labels verified in Chromium");
  } finally {
    if (cdp) cdp.close();
    if (chrome) {
      if (chrome.pid) await killProcessTree(chrome.pid, { graceMs: 1000 }).catch(() => undefined);
      try {
        chrome.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        if (chrome!.exitCode !== null || chrome!.signalCode !== null) return resolve();
        const timer = setTimeout(resolve, 4000);
        chrome!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (hub) {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub!.server.close(() => resolve()));
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});
