// config-settings.test.ts — the settings READ view: CLI/catalog provenance,
// first-release effective model selection, stale-id diagnostics, honest unavailable
// states and a save→reload consistency check. Legacy scheduling fields may remain
// persisted for backward compatibility but are forced off in the runtime/settings
// view. The provider adapter is injected, so no real CLI is touched here.
//
// The installed-package section (bottom) pins the Command Code catalog contract:
// the model list and Free-now labels come from the CURRENTLY INSTALLED package's
// own shipped reference (a bounded local file read), and a slow/failed
// capability probe can neither block nor erase them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityProbeResult, ModelCatalogResult, ProviderAdapter, StreamState } from "../../providers/provider";
import { configPath, updateConfig } from "../../config/schema";
import { readSettings, readSettingsCapabilities } from "../../config/settings";
import {
  writeCommandCodeShim,
  writeInstalledCommandCodePackage
} from "../helpers/command-code-package-fixture";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-"));
}

/** A platform-absolute fake CLI path (cliPath is validated as absolute per platform). */
const FAKE_CLI = process.platform === "win32" ? "C:\\tools\\cmdc.cmd" : "/opt/tools/cmdc";

const CAPS: CapabilityProbeResult = {
  ok: true,
  cliPath: "fake-cmdc",
  version: "9.9.9-fake",
  helpText: null,
  supportsEffort: true,
  permissionModes: ["plan", "accept-edits", "yolo"],
  errors: []
};
const CATALOG: ModelCatalogResult = {
  ok: true,
  source: "cli-list-models",
  models: ["m/a", "m/b", "m/c"],
  defaultModel: "m/a",
  freeModels: ["m/b"],
  raw: null,
  error: null
};

function fakeAdapter(opts: { resolved: boolean; catalog?: ModelCatalogResult } = { resolved: true }): ProviderAdapter {
  return {
    id: "command-code",
    displayName: "Command Code",
    resolveCli: () =>
      opts.resolved
        ? { ok: true, provider: "command-code", path: FAKE_CLI, source: "config-path" }
        : { ok: false, provider: "command-code", path: null, source: "missing", reason: "CLI not found" },
    async probeCapabilities() {
      return CAPS;
    },
    async readModelCatalog() {
      return opts.catalog ?? CATALOG;
    },
    buildRunPlan: () => ({ ok: false, stage: "argv", error: "unused" }),
    createStreamState: () => ({}) as unknown as StreamState,
    parseStreamLine: (_line: string, state: StreamState) => state,
    normalizeUsage: () => ({}) as never,
    classifyExit: () => ({ kind: "success", failureKind: null, stopReason: null, fatal: false, fallback: false })
  };
}

test("the settings view reports config, CLI source, catalog provenance and the effective model", async () => {
  const root = tmpRoot();
  try {
    updateConfig(root, {
      cliPath: FAKE_CLI,
      defaultModel: "m/c",
      rateLimitFallbackModel: "m/b",
      timeSlots: [{ start: "08:00", end: "12:00", model: "m/b", enabled: true }],
      permissionMode: "accept-edits",
      defaultEffort: "high",
      rateLimitFallbackEffort: "low",
      inFlightSwitch: true
    });
    const result = await readSettings(root, { adapter: fakeAdapter(), env: {}, now: () => new Date(2026, 8, 24, 9, 0, 0) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const v = result.view;
    assert.equal(v.config.cli_path, FAKE_CLI);
    assert.equal(v.config.default_model, "m/c");
    assert.equal(v.config.permission_mode, "accept-edits");
    assert.equal(v.config.default_effort, "high");
    assert.equal(v.config.rate_limit_fallback_effort, "low");
    assert.equal(v.config.in_flight_switch, false);
    assert.deepEqual(v.config.time_slots, []);

    assert.equal(v.cli.available, true);
    assert.equal(v.cli.path, FAKE_CLI);
    assert.equal(v.cli.source, "config-path");
    assert.equal(v.cli.version, "9.9.9-fake");
    assert.equal(v.catalog.available, true);
    assert.equal(v.catalog.source, "cli-list-models");
    assert.equal(v.catalog.reliable, true);
    assert.equal(v.catalog.default_model, "m/a");
    // The ordered model id list is exposed for a dynamic dropdown.
    assert.deepEqual(v.catalog.models, ["m/a", "m/b", "m/c"]);
    assert.equal(v.model_meta["m/a"]?.free, false);
    assert.equal(v.model_meta["m/b"]?.free, true);
    assert.equal(v.model_meta["m/c"]?.free, false);
    assert.equal(v.catalog.count, v.catalog.models.length);
    assert.match(String(v.catalog.refreshed_at), /^\d{4}-\d{2}-\d{2}T/);

    // First release ignores persisted time slots and uses the configured default.
    assert.equal(v.effective.model, "m/c");
    assert.equal(v.effective.source, "config-default");
    assert.equal(v.effective.slot_index, null);
    assert.deepEqual(v.diagnostics, []);
    assert.equal(v.features.rate_limit_fallback_active, true);
    assert.equal(v.features.in_flight_switch_active, false);
    assert.match(v.features.note, /disabled for every provider/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable CLI/catalog is reported honestly (never a hard-coded model list)", async () => {
  const root = tmpRoot();
  try {
    const result = await readSettings(root, { adapter: fakeAdapter({ resolved: false }), env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.cli.available, false);
    assert.equal(result.view.cli.path, null);
    assert.equal(result.view.cli.source, "missing");
    assert.equal(result.view.catalog.available, false);
    assert.equal(result.view.catalog.reliable, false);
    assert.equal(result.view.catalog.count, 0);
    // An unavailable catalog is NOT a refresh: empty list, null refresh time.
    assert.deepEqual(result.view.catalog.models, []);
    assert.deepEqual(result.view.model_meta, {});
    assert.equal(result.view.catalog.refreshed_at, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reliable catalog that lacks the configured model reports it stale (no substitution)", async () => {
  const root = tmpRoot();
  try {
    updateConfig(root, { defaultModel: "m/zzz" });
    const result = await readSettings(root, { adapter: fakeAdapter(), env: {}, now: () => new Date(2026, 8, 24, 20, 0, 0) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.effective.model, null, "a stale winning model is not silently replaced");
    assert.ok(result.view.diagnostics.some((d) => d.code === "model_stale" && d.value === "m/zzz"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid config file is reported with a stable code and left untouched", async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(configPath(root), JSON.stringify({ permissionMode: "root" }), "utf8");
    const before = fs.readFileSync(configPath(root), "utf8");
    const result = await readSettings(root, { adapter: fakeAdapter(), env: {} });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "config_invalid_permission_mode");
    assert.equal(result.field, "permissionMode");
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the native standard permission mode saved through the config path is what the settings view reads back", async () => {
  const root = tmpRoot();
  try {
    const saved = updateConfig(root, { permissionMode: "standard" });
    assert.equal(saved.config.permissionMode, "standard");
    const result = await readSettings(root, { adapter: fakeAdapter(), env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.config.permission_mode, "standard", "a saved native standard is read back, not repaired to another mode");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a default permission mode saved through the settings path exposes the canonical standard", async () => {
  const root = tmpRoot();
  try {
    // The documented synonym is accepted by the real save path and the view
    // (what the Settings form renders and sends) exposes the canonical value.
    const saved = updateConfig(root, { permissionMode: "default" });
    assert.equal(saved.config.permissionMode, "standard");
    const result = await readSettings(root, { adapter: fakeAdapter(), env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.config.permission_mode, "standard", "the synonym is normalized, never exposed verbatim");
    assert.equal(JSON.parse(fs.readFileSync(configPath(root), "utf8")).permissionMode, "standard", "the stored value is canonical");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("save then reload yields an identical settings view (persistence consistency)", async () => {
  const root = tmpRoot();
  try {
    const saved = updateConfig(root, {
      defaultModel: "m/c",
      defaultEffort: "low",
      timeSlots: [{ start: "22:00", end: "06:00", model: "m/b", enabled: true }]
    });
    const first = await readSettings(root, { adapter: fakeAdapter(), env: {}, now: () => new Date(2026, 8, 24, 23, 30, 0) });
    const second = await readSettings(root, { adapter: fakeAdapter(), env: {}, now: () => new Date(2026, 8, 24, 23, 30, 0) });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.view.config, second.view.config);
    assert.deepEqual(first.view.config, {
      cli_path: null,
      default_model: saved.config.defaultModel,
      rate_limit_fallback_model: null,
      permission_mode: "yolo",
      default_effort: "low",
      rate_limit_fallback_effort: null,
      time_slots: [],
      in_flight_switch: false
    });
    assert.equal(first.view.effective.model, "m/c");
    assert.equal(first.view.effective.source, "config-default");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The installed-package catalog (Command Code): local, prompt, probe-independent
// ---------------------------------------------------------------------------

interface InstalledFixture {
  dir: string;
  prefixDir: string;
  shim: string;
  packageRoot: string;
  cleanup: () => void;
}

function installedFixture(): InstalledFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-installed-"));
  const prefixDir = path.join(dir, "prefix");
  fs.mkdirSync(prefixDir, { recursive: true });
  const pkg = writeInstalledCommandCodePackage(prefixDir);
  const shim = writeCommandCodeShim(prefixDir);
  return { dir, prefixDir, shim, packageRoot: pkg.packageRoot, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** An adapter whose CLI resolves to the fixture shim; probes are scripted. */
function installedAdapter(
  fixture: InstalledFixture,
  script: {
    capabilities?: () => Promise<CapabilityProbeResult>;
    catalog?: () => Promise<ModelCatalogResult>;
    onCatalogCall?: () => void;
  } = {}
): ProviderAdapter {
  const base = fakeAdapter();
  return {
    ...base,
    resolveCli: () => ({ ok: true, provider: "command-code", path: fixture.shim, source: "config-path" }),
    probeCapabilities: script.capabilities ?? base.probeCapabilities,
    readModelCatalog: () => {
      script.onCatalogCall?.();
      return script.catalog ? script.catalog() : base.readModelCatalog({ cliPath: fixture.shim });
    }
  };
}

const INSTALLED_CAPS: CapabilityProbeResult = {
  ok: true,
  cliPath: "installed-cmdc",
  version: "1.72.4",
  helpText: null,
  supportsEffort: true,
  permissionModes: ["plan", "accept-edits", "yolo"],
  errors: []
};

test("the installed package's own reference supplies the model list and Free now without --list-models", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    let catalogCalls = 0;
    const adapter = installedAdapter(fixture, {
      capabilities: async () => INSTALLED_CAPS,
      onCatalogCall: () => {
        catalogCalls += 1;
      }
    });
    updateConfig(root, { cliPath: fixture.shim, defaultModel: "stealth/space-bunny-alpha" });
    const result = await readSettings(root, { adapter, env: {}, now: () => new Date(2026, 9, 1, 12, 0, 0) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const v = result.view;

    assert.equal(v.catalog.source, "installed-package-reference");
    assert.equal(v.catalog.reliable, true, "the installed package's own shipped reference is reliable catalog evidence");
    assert.equal(v.catalog.available, true);
    assert.equal(v.catalog.count, v.catalog.models.length);
    assert.ok(v.catalog.models.includes("stealth/space-bunny-alpha"));
    assert.ok(v.catalog.models.includes("stealth/pixel-canary"));
    assert.equal(v.catalog.default_model, null, "the shipped reference publishes no default model");
    assert.match(String(v.catalog.refreshed_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(v.catalog.error, null);
    assert.equal(catalogCalls, 0, "the normal path never runs cmdc --list-models");

    // Free evidence comes from the rows whose advertised rates are all $0 — the
    // stealth ids contain no "free" substring and must still be free.
    assert.equal(v.model_meta["stealth/space-bunny-alpha"]?.free, true);
    assert.equal(v.model_meta["stealth/pixel-canary"]?.free, true);
    assert.equal(v.model_meta["poolside/laguna-s-2.1-free"]?.free, true);
    assert.equal(v.model_meta["deepseek/deepseek-v4-pro"]?.free, false, "a paid row is proven not free");

    // Per-model reasoning effort comes from the SAME installed-package read: the
    // reference's own `Efforts` column, per row. It is what the Reasoning
    // dropdown follows and what a run is validated against before spawning.
    assert.deepEqual(
      v.model_meta["deepseek/deepseek-v4.1-flash"]?.efforts,
      ["low", "high", "max"],
      "the model's own published levels are exposed in model_meta"
    );
    assert.deepEqual(v.model_meta["stealth/pixel-canary"]?.efforts, ["low", "medium", "xhigh"]);
    assert.equal(
      v.model_meta["poolside/laguna-s-2.1-free"]?.efforts,
      undefined,
      "a row that publishes no efforts claims none"
    );

    // Capability evidence still comes from the CLI's own help.
    assert.equal(v.capabilities.supports_effort, true);
    assert.deepEqual(v.capabilities.permission_modes, ["plan", "accept-edits", "yolo"]);
    assert.equal(v.cli.version, "1.72.4");
    assert.equal(v.cli.error, null);
    assert.equal(v.effective.model, "stealth/space-bunny-alpha");
    assert.deepEqual(v.diagnostics, [], "an id from the installed reference is not stale");
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a slow capability probe can neither block nor erase the installed model list", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    let resolveProbe: (result: CapabilityProbeResult) => void = () => undefined;
    const adapter = installedAdapter(fixture, {
      capabilities: () =>
        new Promise<CapabilityProbeResult>((resolve) => {
          resolveProbe = resolve;
        })
    });
    updateConfig(root, { cliPath: fixture.shim });
    const startedAt = Date.now();
    const result = await readSettings(root, { adapter, env: {}, capabilityBudgetMs: 60 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const v = result.view;

    assert.ok(elapsedMs < 5000, `the read must not wait for the hung capability probe (took ${elapsedMs}ms)`);
    assert.equal(v.catalog.source, "installed-package-reference");
    assert.equal(v.catalog.reliable, true, "the model list survives a slow capability probe");
    assert.ok(v.catalog.models.length > 0, "the dropdown is populated from the installed package");
    assert.equal(v.model_meta["stealth/pixel-canary"]?.free, true, "Free now survives a slow capability probe");
    assert.deepEqual(v.capabilities.permission_modes, [], "unconfirmed capability is reported honestly");
    assert.equal(v.capabilities.supports_effort, false, "effort is never claimed without published evidence");
    assert.match(String(v.cli.error), /settings budget/, "the timeout is reported as the reason");

    // A late probe answer never retroactively changes the served view.
    resolveProbe(INSTALLED_CAPS);
    assert.deepEqual(v.capabilities.permission_modes, []);
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The two-phase split: the catalog phase is a DIFFERENT READ, not a budget
// ---------------------------------------------------------------------------

// The defect this guards: the model dropdown could not render until the single
// settings response returned, and that response awaited the capability probe on
// its 20s production-default budget. No injected budget here — the production
// defaults are in force, so the only way this test can pass quickly is if the
// catalog phase never touches the probe at all.
test("the catalog phase populates the model list without ever starting the capability probe (production-default timing)", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    let probeCalls = 0;
    const adapter = installedAdapter(fixture, {
      capabilities: () => {
        probeCalls += 1;
        // Never settles: only the production-default budget could end it, and
        // the catalog phase must not wait for that.
        return new Promise<CapabilityProbeResult>(() => undefined);
      }
    });
    updateConfig(root, { cliPath: fixture.shim });
    const startedAt = Date.now();
    const result = await readSettings(root, { adapter, env: {}, phase: "catalog" });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const v = result.view;

    assert.ok(elapsedMs < 2000, `the catalog phase must return promptly (took ${elapsedMs}ms)`);
    assert.equal(probeCalls, 0, "the catalog phase must never even start the capability probe");
    assert.equal(v.catalog.source, "installed-package-reference");
    assert.equal(v.catalog.reliable, true);
    assert.ok(v.catalog.models.length > 0, "the dropdown is populated from the installed package");
    assert.equal(v.model_meta["stealth/pixel-canary"]?.free, true, "Free now is available in the catalog phase");
    assert.equal(v.capabilities.checked, false, "the catalog phase reports capability evidence as NOT CHECKED");
    assert.deepEqual(v.capabilities.permission_modes, [], "no mode is invented before the CLI is asked");
    assert.equal(v.cli.version, null, "no version is claimed before the CLI is asked");
    assert.equal(v.cli.error, null, "an unchecked capability is not reported as a failure");
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the capability phase reports the CLI's own evidence and never re-publishes an installed catalog", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    const adapter = installedAdapter(fixture, { capabilities: async () => INSTALLED_CAPS });
    updateConfig(root, { cliPath: fixture.shim });
    const result = await readSettingsCapabilities(root, { adapter, env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.patch.capabilities.checked, true);
    assert.equal(result.patch.capabilities.supports_effort, true);
    assert.deepEqual(result.patch.capabilities.permission_modes, INSTALLED_CAPS.permissionModes);
    assert.equal(result.patch.cli.version, "1.72.4");
    assert.equal(result.patch.cli.error, null);
    assert.equal(result.patch.catalog, null, "an installed-package catalog is not re-published by the capability phase");
    assert.equal(result.patch.model_meta, null, "the installed Free-now evidence is not re-derived here");
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the capability phase carries the --list-models fallback only when the installed reference is unusable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-caps-fallback-"));
  const root = tmpRoot();
  try {
    // A plain fake CLI with no Command Code package around it.
    const cli = process.platform === "win32" ? path.join(dir, "plain-cli.cmd") : path.join(dir, "plain-cli");
    fs.writeFileSync(cli, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
    const adapter = fakeAdapter();
    updateConfig(root, { cliPath: cli });
    const result = await readSettingsCapabilities(root, { adapter, env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.patch.capabilities.checked, true);
    assert.equal(result.patch.catalog?.source, "cli-list-models", "the CLI catalog remains the documented fallback");
    assert.deepEqual(result.patch.catalog?.models, ["m/a", "m/b", "m/c"]);
    assert.equal(result.patch.model_meta?.["m/b"]?.free, true, "the fallback keeps the CLI's own FREE evidence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed capability probe keeps the installed model list and reports the failure honestly", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    const adapter = installedAdapter(fixture, {
      capabilities: async () => ({
        ok: false,
        cliPath: "installed-cmdc",
        version: null,
        helpText: null,
        supportsEffort: false,
        permissionModes: [],
        errors: ["--version probe failed: exit 1"]
      })
    });
    updateConfig(root, { cliPath: fixture.shim, permissionMode: "yolo" });
    const result = await readSettings(root, { adapter, env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.cli.available, true, "the package/CLI is present even when the probe failed");
    assert.equal(result.view.cli.version, null);
    assert.match(String(result.view.cli.error), /--version probe failed/);
    assert.equal(result.view.catalog.reliable, true);
    assert.ok(result.view.catalog.models.includes("stealth/space-bunny-alpha"), "the model list does not disappear");
    assert.equal(result.view.model_meta["stealth/space-bunny-alpha"]?.free, true);
    assert.equal(result.view.config.permission_mode, "yolo", "the configured permission mode is preserved for the run path");
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rejecting capability probe is reported as unconfirmed instead of failing the read", async () => {
  const fixture = installedFixture();
  const root = tmpRoot();
  try {
    const adapter = installedAdapter(fixture, {
      capabilities: async () => {
        throw new Error("probe worker exploded");
      }
    });
    updateConfig(root, { cliPath: fixture.shim });
    const result = await readSettings(root, { adapter, env: {} });
    assert.equal(result.ok, true, "an unexpected probe failure must not erase the settings view");
    if (!result.ok) return;
    assert.match(String(result.view.cli.error), /probe worker exploded/);
    assert.equal(result.view.catalog.source, "installed-package-reference");
    assert.ok(result.view.catalog.models.length > 0);
  } finally {
    fixture.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("without an installed package the CLI's own --list-models remains the catalog source", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-nopkg-"));
  const root = tmpRoot();
  try {
    // A plain fake CLI with no Command Code package around it.
    const cli = process.platform === "win32" ? path.join(dir, "plain-cli.cmd") : path.join(dir, "plain-cli");
    fs.writeFileSync(cli, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", "utf8");
    const adapter = fakeAdapter();
    updateConfig(root, { cliPath: cli });
    const result = await readSettings(root, { adapter, env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.catalog.source, "cli-list-models", "the CLI catalog is the documented fallback");
    assert.equal(result.view.catalog.reliable, true);
    assert.deepEqual(result.view.catalog.models, ["m/a", "m/b", "m/c"]);
    assert.equal(result.view.catalog.default_model, "m/a");
    assert.equal(result.view.model_meta["m/b"]?.free, true, "the fallback keeps the CLI's own FREE evidence");
    assert.equal(result.view.model_meta["m/a"]?.free, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unparseable installed reference falls back to --list-models instead of guessing Free", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-badref-"));
  const root = tmpRoot();
  try {
    const prefixDir = path.join(dir, "prefix");
    fs.mkdirSync(prefixDir, { recursive: true });
    writeInstalledCommandCodePackage(prefixDir, { modelsText: "not a models table\n" });
    const shim = writeCommandCodeShim(prefixDir);
    const adapter = installedAdapter({ dir, prefixDir, shim, packageRoot: prefixDir, cleanup: () => undefined });
    updateConfig(root, { cliPath: shim });
    const result = await readSettings(root, { adapter, env: {} });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.view.catalog.source, "cli-list-models");
    assert.deepEqual(result.view.catalog.models, ["m/a", "m/b", "m/c"]);
    assert.equal(result.view.model_meta["m/b"]?.free, true, "no Free claim comes from the unparseable local file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
