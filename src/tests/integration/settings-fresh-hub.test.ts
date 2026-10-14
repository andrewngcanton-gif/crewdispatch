// settings-fresh-hub.test.ts — the settings read contract at the REAL Hub HTTP
// surface: no startup prewarm, always-fresh provider reads, concurrent-probe
// dedup, save invalidation and billing-safety provenance.
//
// Two layers of evidence:
//   * injected provider definitions (controlled promises) pin the exact read
//     orchestration without touching a CLI;
//   * a real fake-CLI layer proves the production worker-backed probe path:
//     the Hub listens without spawning anything, and a settings request runs
//     the requested provider's synchronous CLI probe off the main thread.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle } from "../../hub/server";
import {
  ProviderSettingsReads,
  type SettingsProbeResult,
  type SettingsProviderDefinition
} from "../../config/settings-reads";
import { resetDefaultSettingsReadsForTests } from "../../config/settings-registry";
import { commandCodeSettingsView } from "../helpers/settings-fixtures";
import {
  readInvocationArgs,
  writeFakeCommandCodeCli,
  writeInstalledCommandCodePackage
} from "../helpers/command-code-package-fixture";

// ---------------------------------------------------------------------------
// Controlled provider definitions (no CLI involved)
// ---------------------------------------------------------------------------

interface ControlledProbe {
  definition: SettingsProviderDefinition<any>;
  calls: number;
  patches: Array<Record<string, unknown>>;
  settleAt(index: number, result: SettingsProbeResult<any>): void;
  pendingCount(): number;
}

function controlledProvider(id: string, patchResult?: () => unknown): ControlledProbe {
  const pending: Array<{ resolve: (result: SettingsProbeResult<any>) => void }> = [];
  const probe: ControlledProbe = {
    calls: 0,
    patches: [],
    definition: {
      id,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          probe.calls += 1;
          pending.push({ resolve });
        }),
      applyPatch: (_root, patch) => {
        probe.patches.push(patch);
        return patchResult ? patchResult() : { default_model: patch.default_model ?? null };
      }
    },
    settleAt(index, result) {
      const slot = pending[index];
      if (!slot) throw new Error(`no pending probe for ${id} at index ${index}`);
      slot.resolve(result);
    },
    pendingCount() {
      return pending.length;
    }
  };
  return probe;
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TestHub {
  hub: HubHandle;
  url: string;
  stop(): Promise<void>;
}

async function startTestHub(options: {
  root: string;
  settingsReads?: ProviderSettingsReads;
  env?: NodeJS.ProcessEnv;
}): Promise<TestHub> {
  const hub = startHub({
    root: options.root,
    host: "127.0.0.1",
    port: 0,
    settingsReads: options.settingsReads,
    env: options.env
  });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("listening", () => resolve());
    hub.server.once("error", reject);
  });
  return {
    hub,
    url: `http://127.0.0.1:${hub.port}`,
    async stop() {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
    }
  };
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

function tmpRoot(name: string): { dir: string; root: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-fresh-${name}-`));
  return { dir, root: path.join(dir, "root") };
}

// ---------------------------------------------------------------------------
// A — no startup prewarm: the request is what triggers the first probe
// ---------------------------------------------------------------------------

test("Hub: startup never probes provider settings — the first read is triggered by a real request", { timeout: 60000 }, async () => {
  const { dir, root } = tmpRoot("startup");
  const cc = controlledProvider("command-code");
  const wb = controlledProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);
  const server = await startTestHub({ root, settingsReads: reads });
  try {
    const ping = await getJson(`${server.url}/api/ping`);
    assert.equal(ping.body.ok, true);
    // Give any erroneous background probe a chance to appear.
    await sleep(300);
    assert.equal(cc.calls, 0, "Hub startup must not probe Command Code settings");
    assert.equal(wb.calls, 0, "Hub startup must not probe WorkBuddy AI settings");
    assert.equal(reads.inflight("command-code", root), false);
    assert.equal(reads.inflight("workbuddy-ai", root), false);

    const requested = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 1, 5000, "the requested Command Code probe");
    assert.equal(wb.calls, 0, "only the requested provider is probed");
    cc.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["m/one"] }) });
    const envelope = await requested;
    assert.equal(envelope.body.ok, true);
    assert.deepEqual(envelope.body.view.catalog.models, ["m/one"]);
    assert.equal(envelope.body.freshness.source, "probe");
    assert.equal(envelope.body.freshness.billing_verified, true);
    assert.ok(envelope.body.freshness.verified_at, "the response carries its verification time");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — every read is fresh; concurrent identical reads dedupe onto one probe
// ---------------------------------------------------------------------------

test("Hub: concurrent fresh requests for one provider share ONE probe, and a later request probes again (freshness is not a cache)", { timeout: 60000 }, async () => {
  const { dir, root } = tmpRoot("dedup");
  const cc = controlledProvider("command-code");
  const reads = new ProviderSettingsReads([cc.definition]);
  const server = await startTestHub({ root, settingsReads: reads });
  try {
    const requests = Array.from({ length: 6 }, () => getJson(`${server.url}/api/settings?fresh=1`));
    await waitFor(() => cc.calls === 1, 5000, "the shared probe");
    await sleep(150); // give every request a chance to arrive and join
    assert.equal(cc.calls, 1, "no duplicate CLI/catalog probe was launched");
    cc.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["m/dedup"] }) });
    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.body.ok, true);
      assert.deepEqual(response.body.view.catalog.models, ["m/dedup"]);
      assert.equal(response.body.freshness.billing_verified, true);
    }

    // A completed read is never replayed: the next request runs a new probe.
    const later = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 2, 5000, "the second probe");
    cc.settleAt(1, { ok: true, view: commandCodeSettingsView({ models: ["m/second"] }) });
    const second = await later;
    assert.deepEqual(second.body.view.catalog.models, ["m/second"], "the later response is the new probe's own evidence");

    // The raw (MCP-compatible) route stays available and fresh as well.
    const plain = getJson(`${server.url}/api/settings`);
    await waitFor(() => cc.calls === 3, 5000, "the plain read probe");
    cc.settleAt(2, { ok: true, view: commandCodeSettingsView({ models: ["m/plain"] }) });
    const plainBody = await plain;
    assert.equal(plainBody.body.ok, true);
    assert.deepEqual(plainBody.body.catalog.models, ["m/plain"], "the plain route returns the raw fresh view");
    assert.equal("freshness" in plainBody.body, false, "the raw route stays byte-compatible with the MCP view");
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C — a failed read is never billing-certified; the next read retries fresh
// ---------------------------------------------------------------------------

test("Hub: a failed provider read is reported honestly and never carries billing evidence; the next read retries with a new probe", { timeout: 60000 }, async () => {
  const { dir, root } = tmpRoot("failure");
  const cc = controlledProvider("command-code");
  const reads = new ProviderSettingsReads([cc.definition]);
  const server = await startTestHub({ root, settingsReads: reads });
  try {
    const first = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 1, 5000, "the failing probe");
    cc.settleAt(0, { ok: false, code: "config_invalid", message: "bad config", field: "default_model", raw: "{oops" });
    const failed = await first;
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.code, "config_invalid");
    assert.equal("freshness" in failed.body, false, "a failed read carries no freshness claim at all");

    const second = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 2, 5000, "the retry probe");
    cc.settleAt(1, {
      ok: true,
      view: commandCodeSettingsView({ models: ["m/free", "m/paid"], freeModels: ["m/free"] })
    });
    const fresh = await second;
    assert.equal(fresh.body.ok, true);
    assert.equal(fresh.body.freshness.billing_verified, true, "only real probe evidence is billing-verified");
    assert.equal(fresh.body.view.model_meta["m/free"].free, true);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D — saving detaches a pre-save probe; the post-save read is a real new probe
// ---------------------------------------------------------------------------

test("Hub: saving provider settings detaches any pre-save probe, and the post-save read returns post-save data", { timeout: 60000 }, async () => {
  const { dir, root } = tmpRoot("save");
  const cc = controlledProvider("command-code", () => ({
    cli_path: null,
    default_model: "m/saved",
    rate_limit_fallback_model: null,
    permission_mode: "yolo",
    default_effort: null,
    rate_limit_fallback_effort: null,
    time_slots: [],
    in_flight_switch: false
  }));
  const reads = new ProviderSettingsReads([cc.definition]);
  const server = await startTestHub({ root, settingsReads: reads });
  try {
    const preSave = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 1, 5000, "the pre-save probe");

    const saved = await fetch(`${server.url}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_model: "m/saved" })
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(cc.patches, [{ default_model: "m/saved" }], "the provider definition persisted the patch");

    const postSave = getJson(`${server.url}/api/settings?fresh=1`);
    await waitFor(() => cc.calls === 2, 5000, "the post-save probe");
    cc.settleAt(1, {
      ok: true,
      view: commandCodeSettingsView({ models: ["m/saved"], defaultModel: "m/saved" })
    });
    const after = await postSave;
    assert.equal(after.body.ok, true);
    assert.equal(after.body.view.config.default_model, "m/saved", "the post-save response is the post-save probe's own evidence");

    // The detached pre-save probe still settles for its original caller only.
    cc.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["m/pre-save"] }) });
    const before = await preSave;
    assert.deepEqual(before.body.view.catalog.models, ["m/pre-save"]);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E (real path) — provider CLIs are spawned only by a settings request, and
// the production worker-backed probe never blocks the Hub
// ---------------------------------------------------------------------------

const FAKE_CLI_JS = [
  'const fs = require("node:fs");',
  "const args = process.argv.slice(2);",
  'const state = JSON.parse(fs.readFileSync(process.env.FAKE_CLI_STATE, "utf8"));',
  "function logInvocation() {",
  '  if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ script: process.argv[1], argv: args }) + "\\n");',
  "}",
  "function sleep(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* slow CLI */ } }",
  "logInvocation();",
  'if (args.includes("--version")) { sleep(state.delayMs); process.stdout.write("9.9.9-slow\\n"); process.exit(0); }',
  'if (args.includes("--help")) {',
  "  sleep(state.delayMs);",
  '  process.stdout.write("Usage: fake-cli [options]\\n  --model <id>  Model to use\\n  --permission-mode <mode>  Set permission mode (Choices: plan, acceptEdits, yolo, dontAsk, auto)\\n  --effort <level>  Reasoning effort (minimal, low, medium, high)\\n");',
  "  process.exit(0);",
  "}",
  'if (args.includes("--list-models")) {',
  "  sleep(state.delayMs);",
  '  process.stdout.write("Available models · 2 models\\n\\nfake/model-a   FREE   First fake model (default)\\nfake/model-b   Second fake model\\n");',
  "  process.exit(0);",
  "}",
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });',
  'process.stdin.on("end", () => { process.exit(0); });'
].join("\n");

function writeFakeCli(dir: string, name: string): string {
  const js = path.join(dir, `${name}-cli.js`);
  fs.writeFileSync(js, FAKE_CLI_JS, "utf8");
  if (process.platform === "win32") {
    const cmd = path.join(dir, `${name}-cli.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0${name}-cli.js" %*\r\n`, "utf8");
    return cmd;
  }
  const sh = path.join(dir, `${name}-cli`);
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "$(dirname "$0")/${name}-cli.js" "$@"\n`, "utf8");
  fs.chmodSync(sh, 0o755);
  return sh;
}

test("Hub: no provider CLI is spawned at startup; a settings request runs the worker-backed probe while other requests stay responsive", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-fresh-real-"));
  const root = path.join(dir, "root");
  const ccCli = writeFakeCli(dir, "cc");
  const wbCli = writeFakeCli(dir, "wb");
  const stateFile = path.join(dir, "cli-state.json");
  const invocationLog = path.join(dir, "invocations.jsonl");
  fs.writeFileSync(stateFile, JSON.stringify({ delayMs: 2500 }), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: ccCli,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    JOBQUAY_WORKBUDDY_AI_CLI_PATH: wbCli,
    FAKE_CLI_STATE: stateFile,
    FAKE_CLI_LOG: invocationLog
  };
  const server = await startTestHub({ root, env });
  try {
    // Startup must be silent: no provider CLI may be spawned just to warm
    // anything, and the Hub answers health requests immediately.
    await sleep(500);
    assert.equal(fs.existsSync(invocationLog), false, "Hub startup must not spawn a provider CLI");
    const pingBefore = await getJson(`${server.url}/api/ping`);
    assert.equal(pingBefore.body.ok, true);

    // The CATALOG phase — the request that fills the model dropdown — spawns
    // NOTHING: it answers from the config and the installed package alone, so a
    // cold or hung CLI cannot delay the model list.
    const catalogStartedAt = Date.now();
    const catalog = await getJson(`${server.url}/api/settings?fresh=1`);
    const catalogMs = Date.now() - catalogStartedAt;
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.ok, true);
    assert.equal(catalog.body.view.cli.available, true, "the CLI is still resolved and reported");
    assert.equal(catalog.body.view.cli.path, ccCli);
    assert.equal(catalog.body.freshness.billing_verified, true);
    assert.equal(catalog.body.view.capabilities.checked, false, "capability evidence is not claimed before it is read");
    assert.ok(catalogMs < 2000, `the model list must not wait for the CLI (took ${catalogMs}ms)`);
    assert.equal(fs.existsSync(invocationLog), false, "the model-list request spawned no CLI process at all");

    // The CAPABILITY phase is the one that runs the requested provider's CLI
    // probe, and it runs OFF the main thread: the Hub keeps answering while the
    // delayed synchronous probe is still running.
    const requested = getJson(`${server.url}/api/settings/capabilities?fresh=1`);
    await waitFor(
      () => fs.existsSync(invocationLog) && fs.readFileSync(invocationLog, "utf8").length > 0,
      20000,
      "the requested CLI invocation"
    );
    const pingStartedAt = Date.now();
    const ping = await getJson(`${server.url}/api/ping`);
    const pingMs = Date.now() - pingStartedAt;
    assert.equal(ping.body.ok, true);
    assert.ok(pingMs < 2000, `the ping answered in ${pingMs}ms while the delayed probe was still running`);

    const envelope = await requested;
    assert.equal(envelope.status, 200);
    assert.equal(envelope.body.ok, true);
    assert.equal(envelope.body.patch.capabilities.checked, true, "the capability phase reports real evidence");
    assert.equal(envelope.body.patch.cli.available, true, "the capability phase carries real CLI evidence");
    assert.equal(envelope.body.patch.cli.version, "9.9.9-slow");
    assert.equal(envelope.body.freshness.billing_verified, true);
    assert.ok(envelope.body.freshness.verified_at, "the fresh response records its verification time");
    // This CLI has no installed-package reference, so the capability phase also
    // carries the CLI's own `--list-models` fallback catalog.
    assert.equal(envelope.body.patch.catalog?.source, "cli-list-models");
    assert.ok(
      envelope.body.patch.catalog?.models?.includes("fake/model-a"),
      `the fallback catalog reaches the dropdown (got ${JSON.stringify(envelope.body.patch.catalog?.models)})`
    );
    assert.equal(
      envelope.body.patch.model_meta?.["fake/model-a"]?.free,
      true,
      "a fresh probe may carry the CLI's own FREE evidence for presentation"
    );

    // Only the requested provider's CLI ran.
    const logged = fs
      .readFileSync(invocationLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { script?: string; argv?: string[] });
    assert.ok(logged.length > 0, "the Command Code CLI really ran");
    assert.ok(
      logged.every((entry) => String(entry.script).includes("cc-cli.js")),
      `only the requested provider's CLI may run (got ${JSON.stringify(logged.map((entry) => entry.script))})`
    );
  } finally {
    await server.stop();
    resetDefaultSettingsReadsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F (real path) — the INSTALLED PACKAGE supplies the model list + Free now while
// a slow capability probe runs; `--list-models` is never needed
// ---------------------------------------------------------------------------

test("Hub: the installed Command Code package populates the model list and Free now without waiting for --list-models", { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-fresh-installed-"));
  const root = path.join(dir, "root");
  const prefixDir = path.join(dir, "npm-prefix");
  fs.mkdirSync(prefixDir, { recursive: true });
  // A real installed-package layout: the shim sits beside node_modules/command-code.
  writeInstalledCommandCodePackage(prefixDir);
  // The CLI answers the PUBLIC probes SLOWLY (deliberately: a cold/hung CLI is
  // the exact defect this guards) and does not implement --list-models at all.
  const PROBE_DELAY_MS = 4000;
  const fake = writeFakeCommandCodeCli(prefixDir, { name: "cmdc", probeDelayMs: PROBE_DELAY_MS, listModels: null });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_COMMAND_CODE_CLI_PATH: fake.shim,
    JOBQUAY_CLI_AUTODISCOVER: "false",
    FAKE_CLI_LOG: fake.log
  };
  const server = await startTestHub({ root, env });
  try {
    // ---- Phase A: the catalog read. NO injected budget: the production
    // default (10s per probe / 20s budget) is in force, so returning promptly
    // here can only be because this phase never waits for the probe.
    const fastStartedAt = Date.now();
    const response = await getJson(`${server.url}/api/settings?fresh=1`);
    const fastElapsedMs = Date.now() - fastStartedAt;
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const view = response.body.view;

    assert.equal(view.catalog.source, "installed-package-reference", "the catalog comes from the installed package");
    assert.equal(view.catalog.reliable, true);
    assert.ok(
      view.catalog.models.includes("stealth/space-bunny-alpha"),
      `the installed reference supplies the model list (got ${JSON.stringify(view.catalog.models.slice(0, 3))})`
    );
    assert.equal(view.model_meta["stealth/pixel-canary"]?.free, true, "an id without 'free' is free by the package's own $0 rates");
    assert.equal(view.model_meta["deepseek/deepseek-v4-pro"]?.free, false, "a paid row is not marked free");
    assert.equal(view.catalog.error, null, "the model list is not an error state even when the CLI probe is slow");
    assert.equal(response.body.freshness.billing_verified, true, "the catalog phase is a real read, so Free now is verified");
    assert.ok(
      fastElapsedMs < PROBE_DELAY_MS,
      `the model list must NOT wait for the capability probe: took ${fastElapsedMs}ms while the probe needs >=${PROBE_DELAY_MS}ms`
    );
    // The capability evidence is honestly reported as NOT YET CHECKED.
    assert.equal(view.capabilities.checked, false, "the fast phase must not claim capability evidence it did not gather");
    assert.equal(view.cli.version, null);
    assert.equal(
      readInvocationArgs(fake.log).length,
      0,
      "the catalog phase spawned no CLI process at all"
    );

    // ---- Phase B: the separate capability read. Same production defaults.
    const capsStartedAt = Date.now();
    const caps = await getJson(`${server.url}/api/settings/capabilities?fresh=1`);
    const capsElapsedMs = Date.now() - capsStartedAt;
    assert.equal(caps.status, 200);
    assert.equal(caps.body.ok, true);
    assert.equal(caps.body.patch.capabilities.checked, true, "the capability phase reports real evidence");
    assert.equal(caps.body.patch.cli.version, "9.9.9-fake", "the version still comes from the CLI itself");
    assert.ok(caps.body.patch.capabilities.permission_modes.includes("yolo"), "permission modes still come from the CLI's own help");
    assert.equal(caps.body.patch.catalog, null, "an installed-package catalog is never re-published or overridden by the capability phase");
    assert.ok(
      capsElapsedMs >= PROBE_DELAY_MS,
      `the capability phase really ran the slow probe (took ${capsElapsedMs}ms)`
    );

    const argvs = readInvocationArgs(fake.log).map((argv) => argv.join(" "));
    assert.ok(argvs.some((line) => line.includes("--version")), "the capability probe really ran");
    assert.ok(argvs.some((line) => line.includes("--help")), "the capability probe really ran");
    assert.equal(
      argvs.some((line) => line.includes("--list-models")),
      false,
      "the model dropdown never waits for cmdc --list-models"
    );
    console.log(
      `[settings-installed-package] catalog in ${fastElapsedMs}ms (no CLI process); capability evidence in ${capsElapsedMs}ms; CLI probes: ${JSON.stringify(argvs)}`
    );
  } finally {
    await server.stop();
    resetDefaultSettingsReadsForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
