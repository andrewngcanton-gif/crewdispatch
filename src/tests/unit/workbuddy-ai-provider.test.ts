import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkBuddyAiAdapter,
  isWorkBuddyRoutingPresetOnlyCatalog,
  parseWorkBuddyAiHelpModels,
  parseWorkBuddyAiPermissionModes,
  parseWorkBuddyAiControlCatalog,
  parseWorkBuddyAiProductSnapshot,
  readWorkBuddyAiPresentation,
  resolveWorkBuddyAiCli,
  workBuddyAiProfileEnv
} from "../../providers/workbuddy-ai/index";

function countToken(argv: readonly string[], token: string): number {
  return argv.filter((a) => a === token).length;
}

test("WorkBuddy AI profile selector is isolated and case-insensitive", () => {
  const base = {
    PATH: "C:\\tools",
    CodeBuddy_Config_Dir: "C:\\wrong",
    KEEP_ME: "yes"
  } as NodeJS.ProcessEnv;
  const env = workBuddyAiProfileEnv(base);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.CodeBuddy_Config_Dir, undefined);
  const expectedConfigDir = path.join(require("node:os").homedir(), ".workbuddy-ai");
  assert.equal(env.CODEBUDDY_CONFIG_DIR, expectedConfigDir);
  assert.equal(env.WORKBUDDY_CONFIG_DIR, expectedConfigDir);
  assert.equal(env.CODEBUDDY_FORCE_HEADLESS_BUNDLE, "1");
  assert.equal(env.CODEBUDDY_FORCE_LITE_WB_BUNDLE, "1", "new lite-wb bundles are preferred when the launcher supports them");
  assert.equal(base.CodeBuddy_Config_Dir, "C:\\wrong", "parent env must not be mutated");
});

test("WorkBuddy AI never falls back to a domestic codebuddy on PATH", () => {
  const r = resolveWorkBuddyAiCli({
    env: { PATH: "C:\\fake" } as NodeJS.ProcessEnv,
    platform: "win32",
    autoDiscover: true,
    exists: () => false
  });
  assert.equal(r.ok, false);
  assert.equal(r.provider, "workbuddy-ai");
});

test("WorkBuddy AI explicit CLI env wins", () => {
  const r = resolveWorkBuddyAiCli({
    env: { JOBQUAY_WORKBUDDY_AI_CLI_PATH: "C:\\ai\\codebuddy" } as NodeJS.ProcessEnv,
    platform: "win32",
    exists: () => false
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, "C:\\ai\\codebuddy");
  assert.equal(r.source, "env-path");
});

test("WorkBuddy AI discovers the real macOS app bundle CLI layout without duplicating Resources", () => {
  const expected = path.join("/Applications", "WorkBuddy AI.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  const r = resolveWorkBuddyAiCli({
    env: {} as NodeJS.ProcessEnv,
    platform: "darwin",
    exists: (candidate) => candidate === expected
  });
  assert.equal(r.ok, true);
  assert.equal(r.path, expected);
  assert.equal(r.source, "discovered");
});

test("WorkBuddy AI parses the public help model choices", () => {
  const models = parseWorkBuddyAiHelpModels(
    "  --model <model> Model. Currently supported: (fast-model, balanced-model, primary-model, deep-model)\n"
  );
  assert.deepEqual(models, ["fast-model", "balanced-model", "primary-model", "deep-model"]);
});


test("WorkBuddy routing presets are never mistaken for a complete explicit-model catalog", () => {
  assert.equal(isWorkBuddyRoutingPresetOnlyCatalog(["fast-model", "balanced-model", "primary-model", "deep-model"]), true);
  assert.equal(isWorkBuddyRoutingPresetOnlyCatalog(["default-model", "fast-model", "balanced-model", "primary-model", "deep-model"]), true);
  assert.equal(isWorkBuddyRoutingPresetOnlyCatalog(["fast-model", "deepseek-v4.1-flash"]), false);
  assert.equal(isWorkBuddyRoutingPresetOnlyCatalog([]), false);
});


test("WorkBuddy AI parses its resolved product snapshot using the cli agent allowlist", () => {
  const parsed = parseWorkBuddyAiProductSnapshot({
    models: [
      { id: "default-model", name: "Auto", credits: "" },
      { id: "hy4-preview-f", name: "Hy4 preview", credits: "x0.00" },
      { id: "hy3", name: "Hy3", credits: "x0.00 credits" },
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00" },
      { id: "image-only", name: "Image only", credits: "x0.00" }
    ],
    agents: [{
      name: "cli",
      models: ["default-model", "hy4-preview-f", "hy3", "deepseek-v4.1-flash"]
    }]
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.models, ["default-model", "hy4-preview-f", "hy3", "deepseek-v4.1-flash"]);
  assert.equal(parsed.modelMeta["hy4-preview-f"]?.free, true);
  assert.equal(parsed.modelMeta["hy3"]?.credits, "x0.00 credits");
  assert.equal(parsed.modelMeta["deepseek-v4.1-flash"]?.label, "Deepseek-V4.1-Flash");
  assert.equal(parsed.modelMeta["image-only"], undefined, "models outside the cli agent list are not dispatch choices");
});

test("WorkBuddy AI parses per-model reasoning effort metadata from the snapshot", () => {
  const parsed = parseWorkBuddyAiProductSnapshot({
    models: [
      // The current DeepSeek shape: a default effort and no supported list.
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", credits: "x0.00", reasoning: { effort: "high", summary: "auto" } },
      // An App-published supported list with its own default.
      { id: "glm-5.3", name: "GLM-5.3", credits: "x0.41", reasoning: { canDisableThinking: true, defaultEffort: "high", supportedEfforts: ["low", "high", "max"] } },
      // No reasoning object at all: nothing is claimed for this model.
      { id: "default-model", name: "Auto", credits: "" }
    ],
    agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "glm-5.3", "default-model"] }]
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.modelMeta["deepseek-v4.1-flash"]?.reasoning, {
    app_default_effort: "high",
    supported_efforts: null,
    supported_efforts_source: null
  });
  assert.deepEqual(parsed.modelMeta["glm-5.3"]?.reasoning, {
    app_default_effort: "high",
    supported_efforts: ["low", "high", "max"],
    supported_efforts_source: "official-app"
  });
  assert.equal(parsed.modelMeta["default-model"]?.reasoning, null);
});

test("WorkBuddy AI Free-now follows promotion boundaries instead of stale cached x0 credits", () => {
  const snapshot = {
    models: [
      { id: "hy3", name: "Hy3", credits: "x0.00" },
      { id: "always-free", name: "Always free", credits: "x0.00" }
    ],
    agents: [{ name: "cli", models: ["hy3", "always-free"] }],
    modelPromotions: [{
      id: "hy3-free-trial",
      kind: "discount",
      enabled: true,
      modelIds: ["hy3"],
      badge: { label: "Free now", display: "activeOnly" },
      discount: { factor: 0, discountedCredits: "0x" },
      schedule: {
        timezone: "Asia/Shanghai",
        validFrom: "2026-09-01T00:00:00+08:00",
        validUntil: "2026-09-30T00:00:00+08:00"
      }
    }]
  };

  const before = parseWorkBuddyAiProductSnapshot(snapshot, new Date("2026-09-29T15:59:59Z"));
  assert.ok(before);
  assert.equal(before.modelMeta.hy3?.free, true);
  assert.equal(before.modelMeta["always-free"]?.free, true, "zero-credit models with no promotion remain free");
  assert.equal(before.nextPromotionBoundaryAt, "2026-09-29T16:00:00.000Z");

  const after = parseWorkBuddyAiProductSnapshot(snapshot, new Date("2026-09-29T16:00:00Z"));
  assert.ok(after);
  assert.equal(after.modelMeta.hy3?.free, false, "expired promotion overrides the stale cached x0 row");
  assert.equal(after.modelMeta["always-free"]?.free, true);
  assert.equal(after.nextPromotionBoundaryAt, null);
});

test("WorkBuddy AI parses live get_available_models control metadata", () => {
  const raw = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "jobquay-models",
      response: {
        availableModels: [
          { modelId: "hy4-preview-f", name: "Hy4 preview" },
          { modelId: "hy3", name: "Hy3" },
          { modelId: "glm-5.3-flash", name: "GLM-5.3-Flash" }
        ],
        rawModels: [
          { id: "hy4-preview-f", name: "Hy4 preview", credits: "x0.00 credits", descriptionEn: "free preview" },
          { id: "hy3", name: "Hy3", credits: "x0.00 credits" },
          { id: "glm-5.3-flash", name: "GLM-5.3-Flash", credits: "x0.06 credits" }
        ]
      }
    }
  });
  const parsed = parseWorkBuddyAiControlCatalog(raw);
  assert.ok(parsed);
  assert.deepEqual(parsed.models, ["hy4-preview-f", "hy3", "glm-5.3-flash"]);
  assert.equal(parsed.modelMeta["hy4-preview-f"]?.free, undefined, "x0.00 without promotion evidence is not Free-now");
  assert.equal(parsed.modelMeta.hy3?.free, undefined, "control metadata alone never invents a current promotion");
  assert.equal(parsed.modelMeta["hy3"]?.credits, "x0.00 credits");
  assert.equal(parsed.modelMeta["glm-5.3-flash"]?.label, "GLM-5.3-Flash");
});

test("WorkBuddy model reads prefer a fresh explicit live catalog over an older product snapshot", async () => {
  const liveCatalog = {
    models: ["deepseek-v4.1-flash", "hy3", "gpt-6.1-sol"],
    modelMeta: {},
    nextPromotionBoundaryAt: null
  };
  const snapshotCatalog = {
    models: ["fast-model", "balanced-model", "primary-model", "deep-model"],
    modelMeta: {},
    nextPromotionBoundaryAt: null
  };
  const adapter = createWorkBuddyAiAdapter({
    platform: "linux",
    readLiveCatalog: () => ({ catalog: liveCatalog, raw: "live-current" }),
    readProductSnapshotEvidence: () => ({ catalog: snapshotCatalog, raw: "snapshot-old" })
  });
  const result = await adapter.readModelCatalog({ cliPath: "/fake/workbuddy" });
  assert.equal(result.ok, true);
  assert.equal(result.source, "cli-control-models");
  assert.deepEqual(result.models, liveCatalog.models);
  assert.equal(result.raw, "live-current");
});

test("WorkBuddy routing-preset-only live output falls back to a full provider snapshot instead of declaring DeepSeek/HY absent", async () => {
  const routing = {
    models: ["fast-model", "balanced-model", "primary-model", "deep-model"],
    modelMeta: {},
    nextPromotionBoundaryAt: null
  };
  const snapshot = {
    models: ["default-model", "deepseek-v4.1-flash", "hy3", "gpt-6.1-sol"],
    modelMeta: {},
    nextPromotionBoundaryAt: null
  };
  const adapter = createWorkBuddyAiAdapter({
    platform: "linux",
    readLiveCatalog: () => ({ catalog: routing, raw: "offline-routing-only" }),
    readProductSnapshotEvidence: () => ({ catalog: snapshot, raw: "provider-snapshot" })
  });
  const result = await adapter.readModelCatalog({ cliPath: "/fake/workbuddy" });
  assert.equal(result.ok, true);
  assert.equal(result.source, "workbuddy-product-snapshot");
  assert.ok(result.models.includes("deepseek-v4.1-flash"));
  assert.ok(result.models.includes("hy3"));
  assert.match(String(result.error), /routing presets only/);
});

test("WorkBuddy snapshot metadata never shrinks a fresher accepted live model set", () => {
  const snapshotRaw = JSON.stringify({
    models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek", credits: "x0.00" }],
    agents: [{ name: "cli", models: ["deepseek-v4.1-flash"] }]
  });
  const presented = readWorkBuddyAiPresentation(
    "/fake/workbuddy",
    ["deepseek-v4.1-flash", "new-live-model"],
    snapshotRaw
  );
  assert.deepEqual(presented.offeredModels, ["deepseek-v4.1-flash", "new-live-model"]);
  assert.equal(presented.modelMeta["deepseek-v4.1-flash"]?.label, "DeepSeek");
});

test("WorkBuddy AI presentation prefers live control catalog over product presets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-live-presentation-"));
  try {
    const cliDir = path.join(root, "cli");
    const binDir = path.join(cliDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "product.json"), JSON.stringify({
      models: [{ id: "fast-model", name: "Fast", credits: "x0.34 credits" }],
      agents: [{ name: "cli", models: ["fast-model"] }]
    }));
    const liveRaw = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "jobquay-models",
        response: {
          availableModels: [{ modelId: "hy4-preview-f", name: "Hy4 preview" }, { modelId: "hy3", name: "Hy3" }],
          rawModels: [
            { id: "hy4-preview-f", name: "Hy4 preview", credits: "x0.00 credits" },
            { id: "hy3", name: "Hy3", credits: "x0.00 credits" }
          ]
        }
      }
    });
    const presented = readWorkBuddyAiPresentation(
      path.join(binDir, "codebuddy"),
      ["hy4-preview-f", "hy3"],
      liveRaw
    );
    assert.deepEqual(presented.offeredModels, ["hy4-preview-f", "hy3"]);
    assert.equal(presented.modelMeta["hy4-preview-f"]?.credits, "x0.00 credits");
    assert.equal(presented.modelMeta["hy4-preview-f"]?.free, undefined, "fallback control data may show price but not a guessed Free-now badge");
    assert.equal(presented.modelMeta.hy3?.free, undefined);
    assert.equal(presented.source, "cli get_available_models");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkBuddy AI dropdown presentation follows the installed product.json cli agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-presentation-"));
  try {
    const cliDir = path.join(root, "cli");
    const binDir = path.join(cliDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "product.json"), JSON.stringify({
      models: [
        { id: "fast-model", name: "Fast", credits: "x0.34 credits" },
        { id: "balanced-model", name: "Balanced", credits: "x0.59 credits" },
        { id: "primary-model", name: "Primary", credits: "x1.70 credits" },
        { id: "deep-model", name: "Deep", credits: "x2.20 credits" },
        { id: "app-only", name: "App only", credits: "x9.99 credits" }
      ],
      agents: [{ name: "cli", models: ["fast-model", "balanced-model", "primary-model", "deep-model", "app-only"] }]
    }));
    const presented = readWorkBuddyAiPresentation(
      path.join(binDir, "codebuddy"),
      ["fast-model", "balanced-model", "primary-model", "deep-model"]
    );
    assert.deepEqual(presented.offeredModels, ["fast-model", "balanced-model", "primary-model", "deep-model"]);
    assert.equal(presented.modelMeta["fast-model"]?.label, "Fast");
    assert.equal(presented.modelMeta["primary-model"]?.credits, "x1.70 credits");
    assert.equal(presented.modelMeta["deep-model"]?.credits, "x2.20 credits");
    assert.equal(presented.modelMeta["app-only"], undefined, "presentation-only ids never become accepted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkBuddy AI exposes native Full Access only for its recognized permission vocabulary", () => {
  // The installed CLI's `--permission-mode` Choices line does NOT list
  // `fullAccess`, but its recognized `bypassPermissions` vocabulary and native
  // process/session contract support the public Full Access choice.
  const help = [
    "Usage: codebuddy [options]",
    "  --permission-mode <mode>  Default permission mode (TUI, --serve Web, ACP). Choices: acceptEdits, bypassPermissions, default, plan, dontAsk, auto.",
    "  -y, --dangerously-skip-permissions  Bypass permission prompts"
  ].join("\n");
  const modes = parseWorkBuddyAiPermissionModes(help);
  assert.ok(modes.includes("full-access"), "native Full Access is offered");
  assert.ok(modes.includes("yolo"), "bypassPermissions maps to the public yolo id");
  assert.ok(modes.includes("dont-ask"));
  assert.equal(modes.includes("fullAccess"), false, "the CLI token is never the public id");
  assert.deepEqual(
    parseWorkBuddyAiPermissionModes("  --permission-mode <mode>  Choices: default, plan."),
    ["default", "plan"],
    "an unrelated mode list does not imply WorkBuddy Full Access"
  );
  // No mode line at all => the caller keeps its conservative fallback.
  assert.deepEqual(parseWorkBuddyAiPermissionModes("no permission line here"), []);
});

test("WorkBuddy AI permission vocabulary maps into the Windows and macOS Desktop bridge", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const adapter = createWorkBuddyAiAdapter({ platform });
    for (const [input, expected] of [
      ["plan", "plan"],
      ["default", "default"],
      ["accept-edits", "acceptEdits"],
      ["yolo", "bypassPermissions"],
      ["dont-ask", "dontAsk"],
      ["auto", "auto"],
      ["full-access", "fullAccess"]
    ] as const) {
      const r = adapter.buildRunPlan({
        cliPath: platform === "win32" ? "C:\\tools\\codebuddy.exe" : "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
        model: "primary-model",
        permissionMode: input,
        publishedPermissionModes: [input],
        effort: null,
        platform
      });
      assert.ok(r.ok, input + "/" + platform);
      const i = r.argv.indexOf("--permission");
      assert.equal(r.argv[i + 1], expected);
      assert.equal(r.plan.file, process.execPath);
      assert.match(r.plan.args[0] ?? "", /desktop-bridge\.js$/);
      const pi = r.plan.args.indexOf("--permission");
      assert.equal(r.plan.args[pi + 1], expected);
      assert.equal(r.plan.args.includes("--skip-onboarding"), false);
    }
  }
});
test("WorkBuddy AI Desktop bridge preserves validated effort and resume tokens on Windows and macOS", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const adapter = createWorkBuddyAiAdapter({ platform });
    const r = adapter.buildRunPlan({
      cliPath: platform === "win32" ? "C:\\tools\\codebuddy.exe" : "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
      model: "deepseek-v4.1-flash",
      permissionMode: "yolo",
      publishedPermissionModes: ["yolo"],
      effort: "high",
      effortSupported: true,
      resumeSessionId: "wb-session-123",
      platform
    });
    assert.ok(r.ok);
    assert.equal(r.argv[r.argv.indexOf("--effort") + 1], "high");
    assert.equal(r.argv[r.argv.indexOf("--resume") + 1], "wb-session-123");
    assert.equal(r.argv[r.argv.indexOf("--permission") + 1], "bypassPermissions");
  }
});

test("WorkBuddy AI native out-of-tree lifecycle hooks are enabled on Windows and macOS only", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const adapter = createWorkBuddyAiAdapter({ platform });
    assert.equal(typeof adapter.cancelTurn, "function", platform);
    assert.equal(typeof adapter.turnSlotKey, "function", platform);
    assert.equal(typeof adapter.maintainResources, "function", platform);
  }
  const linux = createWorkBuddyAiAdapter({ platform: "linux" });
  assert.equal(linux.cancelTurn, undefined);
  assert.equal(linux.turnSlotKey, undefined);
  assert.equal(linux.maintainResources, undefined);
});
test("WorkBuddy AI never injects Command Code's print-mode bypass flag for any mode", () => {
  // WorkBuddy AI's own native modes already select the confirmation behaviour
  // (`bypassPermissions` for yolo, `fullAccess` for Full Access). CrewDispatch
  // must NOT stack Command Code's independent print-mode `--dangerously-skip-permissions`
  // gate on top: that was the superseded second-gate behaviour.
  const adapter = createWorkBuddyAiAdapter();
  for (const permissionMode of ["plan", "default", "accept-edits", "yolo", "dont-ask", "auto", "full-access"]) {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const r = adapter.buildRunPlan({
        cliPath: platform === "win32" ? "C:\\tools\\codebuddy.exe" : "/opt/tools/codebuddy",
        model: "primary-model",
        permissionMode,
        publishedPermissionModes: [permissionMode],
        effort: null,
        platform
      });
      assert.ok(r.ok, `${permissionMode}/${platform}`);
      assert.equal(countToken(r.argv, "--dangerously-skip-permissions"), 0, `${permissionMode}/${platform} argv must not skip permissions`);
      assert.equal(countToken(r.plan.args, "--dangerously-skip-permissions"), 0, `${permissionMode}/${platform} spawn plan must not skip permissions`);
    }
  }
});

test("WorkBuddy AI maps its native Full Access mode to the `fullAccess` CLI token", () => {
  const adapter = createWorkBuddyAiAdapter();
  // Windows Desktop bridge path.
  const win = adapter.buildRunPlan({
    cliPath: "C:\\tools\\codebuddy.exe",
    model: "primary-model",
    permissionMode: "full-access",
    publishedPermissionModes: ["full-access"],
    effort: null,
    platform: "win32"
  });
  assert.ok(win.ok);
  assert.equal(win.argv[win.argv.indexOf("--permission") + 1], "fullAccess");
  // macOS uses the same authenticated Desktop bridge vocabulary.
  const mac = createWorkBuddyAiAdapter({ platform: "darwin" }).buildRunPlan({
    cliPath: "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
    model: "primary-model",
    permissionMode: "full-access",
    publishedPermissionModes: ["full-access"],
    effort: null,
    platform: "darwin"
  });
  assert.ok(mac.ok);
  assert.equal(mac.argv[mac.argv.indexOf("--permission") + 1], "fullAccess");
  assert.match(mac.plan.args[0] ?? "", /desktop-bridge\.js$/);
  // Non-Windows direct-CLI path carries the same token and no extra flag.
  const linux = adapter.buildRunPlan({
    cliPath: "/opt/tools/codebuddy",
    model: "primary-model",
    permissionMode: "full-access",
    publishedPermissionModes: ["full-access"],
    effort: null,
    platform: "linux"
  });
  assert.ok(linux.ok);
  assert.equal(linux.argv[linux.argv.indexOf("--permission-mode") + 1], "fullAccess");
  assert.equal(countToken(linux.argv, "--dangerously-skip-permissions"), 0);
});

test("WorkBuddy AI rejects an unknown permission mode instead of falling through to a bypass", () => {
  const adapter = createWorkBuddyAiAdapter();
  for (const bogus of ["fullAccess", "yolo-bypass", ""]) {
    const r = adapter.buildRunPlan({
      cliPath: "C:\\tools\\codebuddy.exe",
      model: "primary-model",
      permissionMode: bogus,
      publishedPermissionModes: [bogus],
      effort: null,
      platform: "win32"
    });
    assert.equal(r.ok, false, `"${bogus}" must be rejected`);
    if (!r.ok) assert.match(r.error, /invalid WorkBuddy AI permission mode/);
  }
});
