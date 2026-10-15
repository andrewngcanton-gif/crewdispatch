import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkBuddyAiSettings, updateWorkBuddyAiConfig } from "../../config/workbuddy-ai";
import { createWorkBuddyAiAdapter, type WorkBuddyAiControlCatalog } from "../../providers/workbuddy-ai/index";

function catalog(models: string[]): WorkBuddyAiControlCatalog {
  return { models, modelMeta: {}, nextPromotionBoundaryAt: null };
}

const CAPS = {
  ok: true,
  cliPath: "fake-workbuddy",
  version: "9.9.9-fake",
  helpText: "--permission-mode <mode> Choices: default, plan, bypassPermissions.",
  supportsEffort: true,
  permissionModes: ["default", "plan", "yolo"],
  errors: []
};

test("WorkBuddy Settings recovers from routing-only startup evidence and never marks configured DeepSeek/HY stale", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-wb-settings-recovery-"));
  const cliPath = process.platform === "win32" ? "C:\\fake\\workbuddy.exe" : "/fake/workbuddy";
  try {
    updateWorkBuddyAiConfig(root, {
      cliPath,
      defaultModel: "deepseek-v4.1-flash",
      rateLimitFallbackModel: "hy3"
    });
    const routingOnly = catalog(["fast-model", "balanced-model", "primary-model", "deep-model"]);
    const fullSnapshot = catalog(["default-model", "deepseek-v4.1-flash", "hy3", "gpt-6.1-sol"]);
    let online = false;
    const production = createWorkBuddyAiAdapter({
      platform: process.platform,
      readLiveCatalog: () => online
        ? { catalog: catalog(["deepseek-v4.1-flash", "hy3", "gpt-6.1-sol", "new-live-model"]), raw: JSON.stringify({ models: [], agents: [] }) }
        : { catalog: routingOnly, raw: "routing-only" },
      readProductSnapshotEvidence: () => ({
        catalog: fullSnapshot,
        raw: JSON.stringify({
          models: [
            { id: "default-model", name: "Auto" },
            { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
            { id: "hy3", name: "HY3" },
            { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }
          ],
          agents: [{ name: "cli", models: fullSnapshot.models }]
        })
      })
    });
    const adapter = { ...production, probeCapabilities: async () => CAPS };

    const offline = await readWorkBuddyAiSettings(root, { adapter, env: {} });
    assert.equal(offline.ok, true);
    if (!offline.ok) return;
    assert.equal(offline.view.catalog.source, "workbuddy-product-snapshot");
    assert.ok(offline.view.catalog.models.includes("deepseek-v4.1-flash"));
    assert.ok(offline.view.catalog.models.includes("hy3"));
    assert.deepEqual(offline.view.diagnostics, [], "routing presets never turn the configured explicit models stale");
    assert.equal(offline.view.effective.model, "deepseek-v4.1-flash");

    online = true;
    const recovered = await readWorkBuddyAiSettings(root, { adapter, env: {} });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.view.catalog.source, "cli-control-models", "the later fresh read retries live provider evidence");
    assert.ok(recovered.view.catalog.models.includes("new-live-model"), "a recovered live catalog replaces the older snapshot set");
    assert.deepEqual(recovered.view.diagnostics, []);
    assert.equal(recovered.view.effective.model, "deepseek-v4.1-flash");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
