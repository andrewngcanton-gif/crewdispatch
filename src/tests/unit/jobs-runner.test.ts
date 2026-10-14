// jobs-runner.test.ts — the production runner's cwd/env contract.
//
// The production runner must launch the official CLI in the JOB'S requested cwd
// with the caller's runtime environment (so the user's own official login is
// used). It must NOT fall back to any isolation tree, and an invalid cwd must be
// an honest pre-spawn error. These tests pin that contract at the runner seam
// (no child is launched here; the real cwd delivery is covered by
// src/tests/integration/job-harness.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityProbeResult, ModelCatalogResult } from "../../providers/provider";
import { createCommandCodeAdapter } from "../../providers/command-code/index";
import { createCommandCodeRunner, validateAttemptCwd, type AttemptContext } from "../../jobs/runner";
import { defaultConfig } from "../../config/schema";

const CAPABILITIES: CapabilityProbeResult = {
  ok: true,
  cliPath: "fake-cmdc",
  version: "0.0.0-test",
  helpText: null,
  supportsEffort: false,
  permissionModes: ["plan"],
  errors: []
};
const CATALOG: ModelCatalogResult = { ok: true, source: "cli-list-models", models: ["test/model"], defaultModel: "test/model", raw: null, error: null };

function attempt(cwd: string, env: NodeJS.ProcessEnv): AttemptContext {
  return {
    jobId: "job-test",
    generation: 0,
    prompt: "hello",
    model: "test/model",
    permissionMode: "plan",
    effort: null,
    resumeSessionId: null,
    cwd,
    env
  };
}

function runner() {
  return createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: CATALOG
  });
}

test("buildAttempt uses the JOB's requested cwd and the caller environment (no isolation tree)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-"));
  try {
    const env: NodeJS.ProcessEnv = { HOME: path.join(dir, "home"), MARKER: "caller-env" };
    const built = runner().buildAttempt(attempt(dir, env));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.cwd, dir);
    assert.equal(built.env, env);
    assert.equal(built.env.MARKER, "caller-env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAttempt honestly refuses a missing cwd instead of falling back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-"));
  try {
    const built = runner().buildAttempt(attempt(path.join(dir, "does-not-exist"), {}));
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.error, /working directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModel selects from the config (explicit > slot > default) and reports a stale id honestly", async () => {
  const r = runner();
  const cwd = process.cwd();
  const config = {
    ...defaultConfig(),
    defaultModel: "test/model",
    timeSlots: [{ start: "00:00", end: "23:59", model: "test/model", enabled: true }]
  };

  const explicit = await r.resolveModel({ explicit: "test/model", cwd, env: {}, config, now: new Date(2026, 8, 24, 10) });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.source, "explicit");
  assert.equal(explicit.explicitModel, "test/model");

  const slot = await r.resolveModel({ explicit: null, cwd, env: {}, config, now: new Date(2026, 8, 24, 10) });
  assert.equal(slot.ok, true);
  assert.equal(slot.model, "test/model");
  assert.equal(slot.source, "slot");

  const stale = await r.resolveModel({ explicit: null, cwd, env: {}, config: { ...defaultConfig(), defaultModel: "no/such" }, now: new Date(2026, 8, 24, 10) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "model_stale");

  const none = await r.resolveModel({ explicit: null, cwd, env: {}, config: defaultConfig(), now: new Date(2026, 8, 24, 10) });
  assert.equal(none.ok, true, "the CLI catalog default is used when nothing is configured");
  assert.equal(none.model, "test/model");
  assert.equal(none.source, "cli-default");
});

test("validateAttemptCwd accepts a directory and refuses empty / non-directory values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-"));
  try {
    assert.equal(validateAttemptCwd(dir).ok, true);
    assert.equal(validateAttemptCwd("   ").ok, false);
    const file = path.join(dir, "a-file.txt");
    fs.writeFileSync(file, "x");
    assert.equal(validateAttemptCwd(file).ok, false);
    assert.equal(validateAttemptCwd(undefined).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The RUN path deliberately keeps its OWN evidence tier, separate from the
// Settings dropdown's display source.
//
// `installed-package-reference` is the installed package's version-local shipped
// model reference. It is trustworthy enough to POPULATE a dropdown and label a
// free badge, but it is a weaker class of evidence than the CLI's own live
// `--list-models` answer. Letting it authorize a launch would mean a markdown
// file shipped inside a package decides which ids CrewDispatch actually runs — so the
// runner must normalize it to `unavailable` (unverified), exactly as it does for
// any other source it does not accept.
test("the runner never accepts installed-package-reference (a display-only source)", () => {
  const installed: ModelCatalogResult = {
    ok: true,
    source: "installed-package-reference",
    models: ["stealth/space-bunny-alpha", "stealth/pixel-canary"],
    defaultModel: null,
    raw: null,
    error: null
  };
  const cc = createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: installed
  });
  assert.equal(cc.catalog.ok, false, "a package-local display source is not launch evidence");
  assert.equal(cc.catalog.source, "unavailable");
  assert.deepEqual(cc.catalog.models, [], "no id from a display-only source becomes launchable");
  assert.equal(cc.catalog.defaultModel, null);

  // Even a WorkBuddy AI runner does not accept it: the source is Command
  // Code-specific and is never routed through the WorkBuddy AI branch.
  const wbInstalled = createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: installed,
    runnerKind: "workbuddy-ai"
  });
  assert.equal(wbInstalled.catalog.ok, false);
  assert.equal(wbInstalled.catalog.source, "unavailable");
});

// ---------------------------------------------------------------------------
// Model-specific reasoning effort, refused BEFORE any process exists
// ---------------------------------------------------------------------------
//
// The real defect this guards: a run launched deepseek/deepseek-v4.1-flash with
// effort=xhigh while the installed package publishes only low, high, max for
// that model, and the CLI exited immediately with `Unknown effort "xhigh"`.
// `--effort` is not a global enum, so the level is validated against the
// SELECTED model's own published list while the spawn plan is built — a level
// outside it never reaches a child process.

const DS_MODEL = "deepseek/deepseek-v4.1-flash";
const DS_EFFORTS = [DS_MODEL, ["low", "high", "max"]] as const;

function effortRunner(options: { efforts?: Record<string, string[]> | null } = {}) {
  return createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: { ...CAPABILITIES, supportsEffort: true },
    catalog: { ok: true, source: "cli-list-models", models: [DS_MODEL], defaultModel: DS_MODEL, raw: null, error: null },
    effortsByModel: options.efforts === undefined ? { [DS_EFFORTS[0]]: [...DS_EFFORTS[1]] } : options.efforts
  });
}

function effortAttempt(cwd: string, model: string, effort: string | null): AttemptContext {
  return { ...attempt(cwd, {}), model, effort };
}

test("a model+effort the model's own published list does not contain is refused before the spawn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-effort-"));
  try {
    const built = effortRunner().buildAttempt(effortAttempt(dir, DS_MODEL, "xhigh"));
    assert.equal(built.ok, false, "xhigh is not one of deepseek/deepseek-v4.1-flash's published efforts");
    if (built.ok) return;
    assert.match(built.error, /deepseek\/deepseek-v4\.1-flash/, "the error names the model");
    assert.match(built.error, /"xhigh"/, "the error names the requested effort");
    assert.match(built.error, /low, high, max/, "the error names the supported efforts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a supported model+effort still builds the argv, and blank stays the provider default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-effort-"));
  try {
    // A Windows `.cmd` shim is forwarded through cmd.exe, so the CLI argv lives
    // inside the plan's command line; joining the plan args covers both shapes.
    const accepted = effortRunner().buildAttempt(effortAttempt(dir, DS_MODEL, "max"));
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.match(accepted.args.join(" "), /--effort"?\s+"?max/);

    const blank = effortRunner().buildAttempt(effortAttempt(dir, DS_MODEL, null));
    assert.equal(blank.ok, true, "blank keeps its provider-default meaning");
    if (!blank.ok) return;
    assert.doesNotMatch(blank.args.join(" "), /--effort/, "no flag is emitted for a blank effort");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no reliable per-model evidence the requested effort is passed through unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-runner-effort-"));
  try {
    // The installed reference published no list for this model (or could not be
    // read at all): "unknown" must never become "unsupported".
    const unknownModel = effortRunner({ efforts: null }).buildAttempt(effortAttempt(dir, "test/model", "xhigh"));
    assert.equal(unknownModel.ok, true);
    if (!unknownModel.ok) return;
    assert.match(unknownModel.args.join(" "), /--effort"?\s+"?xhigh/);

    const otherModel = effortRunner().buildAttempt(effortAttempt(dir, "test/model", "xhigh"));
    assert.equal(otherModel.ok, true, "another model's list never governs this model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Non-regression for the WorkBuddy AI product-snapshot path: its own sources
// stay accepted on its own branch, and its launch refusal stays honest.
test("WorkBuddy AI's own catalog sources are still accepted by the runner", () => {
  const wbSource: ModelCatalogResult = {
    ok: true,
    source: "workbuddy-product-snapshot",
    models: ["wb/model"],
    defaultModel: "wb/model",
    raw: null,
    error: null
  };
  const wb = createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: wbSource,
    runnerKind: "workbuddy-ai"
  });
  assert.equal(wb.catalog.ok, true);
  assert.equal(wb.catalog.source, "workbuddy-product-snapshot");
  assert.deepEqual(wb.catalog.models, ["wb/model"]);

  // The WorkBuddy-only sources are NOT accepted on the Command Code branch.
  const ccWithWbSource = createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: wbSource
  });
  assert.equal(ccWithWbSource.catalog.ok, false);
  assert.equal(ccWithWbSource.catalog.source, "unavailable");

  // `cli-list-models` is the one SHARED source: it is the live CLI's own answer
  // for either provider, and WorkBuddy AI's own resolver treats it as reliable
  // (src/config/workbuddy-ai.ts), so it stays accepted on both branches.
  const wbWithCcSource = createCommandCodeRunner({
    adapter: createCommandCodeAdapter(),
    cliPath: path.join("C:", "fake", "cmdc.cmd"),
    capabilities: CAPABILITIES,
    catalog: CATALOG,
    runnerKind: "workbuddy-ai"
  });
  assert.equal(wbWithCcSource.catalog.ok, true);
  assert.equal(wbWithCcSource.catalog.source, "cli-list-models");
});
