import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultWorkBuddyAiConfig,
  loadWorkBuddyAiConfigResult,
  updateWorkBuddyAiConfig,
  workBuddyAiConfigPatchFromSnake,
  workBuddyAiRuntimeConfig
} from "../../config/workbuddy-ai";
import { ConfigError } from "../../config/schema";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-config-"));
}

test("WorkBuddy AI config is provider-local and has no time scheduling fields", () => {
  const config = defaultWorkBuddyAiConfig();
  assert.equal(config.defaultModel, "deepseek-v4.1-flash");
  assert.equal(config.rateLimitFallbackModel, "hy3");
  assert.equal(config.permissionMode, "full-access", "WorkBuddy AI defaults to full-access (skips interactive permission checks)");
  assert.deepEqual(Object.keys(config).sort(), [
    "cliPath",
    "configVersion",
    "defaultEffort",
    "defaultModel",
    "permissionMode",
    "rateLimitFallbackEffort",
    "rateLimitFallbackModel"
  ]);
  const runtime = workBuddyAiRuntimeConfig({
    ...config,
    defaultModel: "hy4-preview-f",
    rateLimitFallbackModel: "hy3",
    permissionMode: "plan",
    defaultEffort: "max"
  });
  assert.equal(runtime.defaultModel, "hy4-preview-f");
  assert.equal(runtime.rateLimitFallbackModel, "hy3");
  assert.deepEqual(runtime.timeSlots, []);
  assert.equal(runtime.inFlightSwitch, false);
});

test("WorkBuddy AI config persists ordinary provider settings atomically", () => {
  const root = tmpRoot();
  try {
    const patch = workBuddyAiConfigPatchFromSnake({
      default_model: "hy4-preview-f",
      rate_limit_fallback_model: "hy3",
      permission_mode: "plan",
      default_effort: "max",
      rate_limit_fallback_effort: "low"
    });
    const saved = updateWorkBuddyAiConfig(root, patch).config;
    assert.equal(saved.defaultModel, "hy4-preview-f");
    assert.equal(saved.rateLimitFallbackModel, "hy3");
    assert.equal(saved.defaultEffort, "max");
    assert.equal(saved.rateLimitFallbackEffort, "low");

    const loaded = loadWorkBuddyAiConfigResult(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.present, true);
    assert.equal(loaded.config.defaultModel, "hy4-preview-f");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkBuddy AI config defaults the permission mode to full-access on load", () => {
  // A stored file that predates the permission field keeps the product default.
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, "providers"), { recursive: true });
    fs.writeFileSync(path.join(root, "providers", "workbuddy-ai.json"), JSON.stringify({ defaultModel: "hy4-preview-f" }), "utf8");
    const loaded = loadWorkBuddyAiConfigResult(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.permissionMode, "full-access");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // A missing file also defaults to full-access.
  const empty = tmpRoot();
  try {
    const fresh = loadWorkBuddyAiConfigResult(empty);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.config.permissionMode, "full-access");
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("WorkBuddy AI config rejects time slots and clock switching", () => {
  assert.throws(
    () => workBuddyAiConfigPatchFromSnake({ time_slots: [] }),
    (e: unknown) => e instanceof ConfigError && e.code === "config_unknown_field"
  );
  assert.throws(
    () => workBuddyAiConfigPatchFromSnake({ in_flight_switch: true }),
    (e: unknown) => e instanceof ConfigError && e.code === "config_unknown_field"
  );
});

test("WorkBuddy AI changing a selection's model resets ONLY that selection's effort (unless supplied)", () => {
  const root = tmpRoot();
  try {
    updateWorkBuddyAiConfig(root, {
      defaultModel: "deepseek-v4.1-flash",
      defaultEffort: "high",
      rateLimitFallbackModel: "hy3",
      rateLimitFallbackEffort: "low"
    });

    const changedDefault = updateWorkBuddyAiConfig(root, { defaultModel: "gpt-5.5" }).config;
    assert.equal(changedDefault.defaultEffort, null, "the default-model change clears its own effort");
    assert.equal(changedDefault.rateLimitFallbackEffort, "low", "the fallback effort is independent and untouched");

    updateWorkBuddyAiConfig(root, { defaultEffort: "high" });
    const changedFallback = updateWorkBuddyAiConfig(root, { rateLimitFallbackModel: "hy4-preview-f" }).config;
    assert.equal(changedFallback.rateLimitFallbackEffort, null, "the fallback-model change clears its own effort");
    assert.equal(changedFallback.defaultEffort, "high", "the default effort is independent and untouched");

    const replaced = updateWorkBuddyAiConfig(root, { defaultModel: "hy3", defaultEffort: "max" }).config;
    assert.equal(replaced.defaultEffort, "max", "an explicit replacement in the same patch is kept");

    const sameModel = updateWorkBuddyAiConfig(root, { defaultModel: "hy3" }).config;
    assert.equal(sameModel.defaultEffort, "max", "an unchanged model keeps its effort");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
