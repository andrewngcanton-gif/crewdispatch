// workbuddy-model-effort.test.ts — model-specific reasoning-effort evidence.
//
// Proves the WorkBuddy half of model-specific effort support:
//   * the Official App product snapshot's reasoning metadata (published
//     supported efforts, published default effort, provenance) lands in
//     model_meta with NO new WorkBuddy process/network read;
//   * an App-published supported list is authoritative;
//   * the DS-only fallback reads the SAME model id's effort list from the
//     locally installed Command Code catalog (a real temp package on disk);
//   * unrelated models never receive a Command Code-derived list;
//   * an incompatible model+effort is rejected before the Desktop bridge
//     starts, while a saved `max` is preserved.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyWorkBuddyAiEffortFallback,
  parseWorkBuddyAiReasoning,
  readInstalledCommandCodeModelEfforts,
  resolveWorkBuddyAiSupportedEfforts,
  type WorkBuddyAiEffortCarrier
} from "../../providers/workbuddy-ai/effort";
import {
  createWorkBuddyAiAdapter,
  parseWorkBuddyAiProductSnapshot,
  type WorkBuddyAiControlCatalog
} from "../../providers/workbuddy-ai/index";
import { writeInstalledCommandCodePackage } from "../helpers/command-code-package-fixture";
import type { InstalledCatalogRead, InstalledModelCatalog } from "../../providers/command-code/local-catalog";

const DEEPSEEK = "deepseek-v4.1-flash";

/** The real shape of the current Official App snapshot rows. */
const SNAPSHOT_ROWS: Record<string, unknown> = {
  [DEEPSEEK]: {
    id: DEEPSEEK,
    name: "Deepseek-V4.1-Flash",
    credits: "x0.00",
    supportsReasoning: true,
    onlyReasoning: true,
    // The current App evidence: a default effort, NO supportedEfforts.
    reasoning: { effort: "high", summary: "auto" }
  },
  "glm-5.3": {
    id: "glm-5.3",
    name: "GLM-5.3",
    credits: "x0.41",
    supportsReasoning: true,
    reasoning: { canDisableThinking: true, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high", "max"] }
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    credits: "x1.2",
    supportsReasoning: true,
    reasoning: { canDisableThinking: false, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "medium", "high", "xhigh"] }
  },
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    credits: "x0.1",
    supportsReasoning: true,
    reasoning: { effort: "medium", summary: "auto" }
  },
  "default-model": {
    id: "default-model",
    name: "Auto",
    credits: "",
    supportsReasoning: true
  }
};

function snapshotCatalog(): WorkBuddyAiControlCatalog {
  const parsed = parseWorkBuddyAiProductSnapshot({
    models: Object.values(SNAPSHOT_ROWS),
    agents: [{ name: "cli", models: Object.keys(SNAPSHOT_ROWS) }]
  });
  assert.ok(parsed, "the fixture snapshot must parse");
  return parsed;
}

/** A REAL temp installed Command Code package with the shipped reference shape. */
function withInstalledPackage<T>(fn: (entryPath: string) => T): T {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-effort-cc-"));
  try {
    return fn(writeInstalledCommandCodePackage(prefix).entryPath);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

test("WorkBuddy snapshot reasoning metadata lands in model_meta with provenance", () => {
  const catalog = snapshotCatalog();

  const ds = catalog.modelMeta[DEEPSEEK]?.reasoning;
  assert.deepEqual(ds, {
    app_default_effort: "high",
    supported_efforts: null,
    supported_efforts_source: null
  });

  const glm = catalog.modelMeta["glm-5.3"]?.reasoning;
  assert.deepEqual(glm, {
    app_default_effort: "high",
    supported_efforts: ["low", "high", "max"],
    supported_efforts_source: "official-app"
  });

  assert.equal(catalog.modelMeta["gpt-5.5"]?.reasoning?.supported_efforts?.join(","), "low,medium,high,xhigh");
  assert.equal(catalog.modelMeta["default-model"]?.reasoning, null, "a model the App describes with no effort metadata claims nothing");
});

test("WorkBuddy's resolved product-snapshot shape carries the same reasoning metadata", () => {
  const parsed = parseWorkBuddyAiProductSnapshot({
    type: "workbuddy_product_snapshot",
    models: [DEEPSEEK, "gpt-6-sol"],
    model_meta: {
      [DEEPSEEK]: { label: "Deepseek-V4.1-Flash", credits: "x0.00", reasoning: { effort: "high", summary: "auto" } },
      "gpt-6-sol": { label: "GPT-6 Sol", credits: "x0.9", reasoning: { defaultEffort: "high", supportedEfforts: ["low", "medium", "high", "xhigh"] } }
    }
  });
  assert.ok(parsed);
  assert.equal(parsed.modelMeta[DEEPSEEK]?.reasoning?.app_default_effort, "high");
  assert.equal(parsed.modelMeta[DEEPSEEK]?.reasoning?.supported_efforts, null);
  assert.deepEqual(parsed.modelMeta["gpt-6-sol"]?.reasoning?.supported_efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(parsed.modelMeta["gpt-6-sol"]?.reasoning?.supported_efforts_source, "official-app");
});

test("WorkBuddy reasoning parsing never invents a list from malformed metadata", () => {
  assert.equal(parseWorkBuddyAiReasoning({ summary: "auto" }), null);
  assert.equal(parseWorkBuddyAiReasoning({ supportedEfforts: [] }), null);
  assert.equal(parseWorkBuddyAiReasoning({ supportedEfforts: ["low", 7] }), null, "a partially malformed list is not trusted");
  assert.equal(parseWorkBuddyAiReasoning({ supportedEfforts: "low, high" }), null);
  assert.deepEqual(parseWorkBuddyAiReasoning({ defaultEffort: "HIGH" }), {
    app_default_effort: "high",
    supported_efforts: null,
    supported_efforts_source: null
  });
});

test("WorkBuddy DS fallback reads the SAME model id's effort list from the installed Command Code catalog", () => {
  withInstalledPackage((entryPath) => {
    const readDeps = { resolveCli: () => ({ ok: true, provider: "command-code", path: entryPath, source: "test" }) };
    const efforts = readInstalledCommandCodeModelEfforts(DEEPSEEK, readDeps);
    assert.deepEqual(efforts, ["low", "high", "max"], "the installed reference's own row for the same model id");

    const meta: Record<string, WorkBuddyAiEffortCarrier> = {
      [DEEPSEEK]: snapshotCatalog().modelMeta[DEEPSEEK] ?? {}
    };
    assert.deepEqual(resolveWorkBuddyAiSupportedEfforts(DEEPSEEK, meta, readDeps), {
      supported_efforts: ["low", "high", "max"],
      supported_efforts_source: "command-code"
    });

    applyWorkBuddyAiEffortFallback(meta, readDeps);
    assert.deepEqual(meta[DEEPSEEK]?.reasoning, {
      app_default_effort: "high",
      supported_efforts: ["low", "high", "max"],
      supported_efforts_source: "command-code"
    });
  });
});

test("WorkBuddy DS fallback consumes the live installed-catalog structure (per-model effort map)", () => {
  withInstalledPackage((entryPath) => {
    // The concurrent installed-catalog reader extension publishes the
    // reference's own per-model effort column as a map keyed by the reference
    // id. It is the live structure this fallback consumes; the
    // namespace-qualified key names the same model.
    const installedRead = (effortsByModel: Record<string, string[]>, models: string[]): InstalledCatalogRead => ({
      ok: true,
      packageRoot: path.dirname(entryPath),
      packageJsonPath: path.join(path.dirname(entryPath), "package.json"),
      referencePath: path.join(path.dirname(entryPath), "models.md"),
      catalog: { models, freeModels: [], ratedModels: [...models], effortsByModel } as unknown as InstalledModelCatalog,
      raw: "not a markdown table"
    });
    const resolveCli = () => ({ ok: true as const, provider: "command-code", path: entryPath, source: "test" });

    const efforts = readInstalledCommandCodeModelEfforts(DEEPSEEK, {
      resolveCli,
      readInstalledCatalog: () => installedRead({ [`deepseek/${DEEPSEEK}`]: ["low", "high", "max"] }, [`deepseek/${DEEPSEEK}`])
    });
    assert.deepEqual(efforts, ["low", "high", "max"]);

    // An ambiguous namespace match (two rows ending in the same segment) is
    // no evidence at all.
    const ambiguous = readInstalledCommandCodeModelEfforts(DEEPSEEK, {
      resolveCli,
      readInstalledCatalog: () =>
        installedRead(
          { [`deepseek/${DEEPSEEK}`]: ["low", "high", "max"], [`other/${DEEPSEEK}`]: ["low", "high"] },
          [`deepseek/${DEEPSEEK}`, `other/${DEEPSEEK}`]
        )
    });
    assert.equal(ambiguous, null);
  });
});

test("WorkBuddy never generalizes the Command Code fallback beyond the exact DS model id", () => {
  withInstalledPackage((entryPath) => {
    const readDeps = { resolveCli: () => ({ ok: true, provider: "command-code", path: entryPath, source: "test" }) };
    const meta: Record<string, WorkBuddyAiEffortCarrier> = {
      "kimi-k3": { reasoning: { app_default_effort: "medium", supported_efforts: null, supported_efforts_source: null } },
      "gemini-3.5-flash": { reasoning: { app_default_effort: "medium", supported_efforts: null, supported_efforts_source: null } },
      "gpt-6-sol": { reasoning: { app_default_effort: "high", supported_efforts: null, supported_efforts_source: null } }
    };
    for (const model of Object.keys(meta)) {
      assert.equal(resolveWorkBuddyAiSupportedEfforts(model, meta, readDeps), null, `${model} must not receive a CC-derived list`);
    }
    applyWorkBuddyAiEffortFallback(meta, readDeps);
    for (const model of Object.keys(meta)) {
      assert.equal(meta[model]?.reasoning?.supported_efforts, null, `${model} keeps only its App-published default`);
      assert.equal(meta[model]?.reasoning?.supported_efforts_source, null);
    }
  });
});

test("WorkBuddy DS fallback is not invented when the installed Command Code evidence is unavailable", () => {
  const meta: Record<string, WorkBuddyAiEffortCarrier> = {
    [DEEPSEEK]: { reasoning: { app_default_effort: "high", supported_efforts: null, supported_efforts_source: null } }
  };
  // No Command Code CLI can be resolved: the fallback yields NO list.
  assert.equal(resolveWorkBuddyAiSupportedEfforts(DEEPSEEK, meta, { resolveCli: () => ({ ok: false, provider: "command-code", path: null, source: "missing" }) }), null);
  applyWorkBuddyAiEffortFallback(meta, { resolveCli: () => ({ ok: false, provider: "command-code", path: null, source: "missing" }) });
  assert.equal(meta[DEEPSEEK]?.reasoning?.supported_efforts, null, "no invented DS list without real evidence");
  assert.equal(meta[DEEPSEEK]?.reasoning?.app_default_effort, "high", "only the App-published default remains");
});

test("WorkBuddy Official App supportedEfforts are authoritative over the Command Code fallback", () => {
  withInstalledPackage((entryPath) => {
    const readDeps = { resolveCli: () => ({ ok: true, provider: "command-code", path: entryPath, source: "test" }) };
    const meta: Record<string, WorkBuddyAiEffortCarrier> = {
      "gpt-5.5": snapshotCatalog().modelMeta["gpt-5.5"] ?? {}
    };
    assert.deepEqual(resolveWorkBuddyAiSupportedEfforts("gpt-5.5", meta, readDeps), {
      supported_efforts: ["low", "medium", "high", "xhigh"],
      supported_efforts_source: "official-app"
    });
    applyWorkBuddyAiEffortFallback(meta, readDeps);
    assert.equal(meta["gpt-5.5"]?.reasoning?.supported_efforts_source, "official-app", "an App-published list is never replaced");
  });
});

test("WorkBuddy rejects an incompatible effort before the Desktop bridge starts and preserves max", () => {
  const catalog = snapshotCatalog();
  const adapter = createWorkBuddyAiAdapter({
    env: {},
    readProductSnapshot: () => catalog,
    resolveCli: () => ({ ok: true, provider: "command-code", path: "C:/fake/cmdc.cmd", source: "test" }),
    readInstalledCatalog: () => ({
      ok: true,
      packageRoot: "C:/fake/pkg",
      packageJsonPath: "C:/fake/pkg/package.json",
      referencePath: "C:/fake/pkg/models.md",
      catalog: {
        models: [`deepseek/${DEEPSEEK}`],
        freeModels: [],
        ratedModels: [],
        effortsByModel: { [`deepseek/${DEEPSEEK}`]: ["low", "high", "max"] }
      } as unknown as InstalledModelCatalog,
      raw: ""
    })
  });
  const base = {
    cliPath: "C:\\tools\\codebuddy.exe",
    permissionMode: "yolo",
    publishedPermissionModes: ["yolo"],
    effortSupported: true,
    platform: "win32" as const
  };

  const rejected = adapter.buildRunPlan({ ...base, model: DEEPSEEK, effort: "xhigh" });
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.stage, "argv", "rejection happens while building the run plan, before any process");
  assert.match(rejected.error, /deepseek-v4\.1-flash/);
  assert.match(rejected.error, /"xhigh"/);
  assert.match(rejected.error, /low, high, max/);

  const saved = adapter.buildRunPlan({ ...base, model: DEEPSEEK, effort: "max" });
  assert.ok(saved.ok, "the saved max is accepted");
  if (saved.ok) assert.equal(saved.argv[saved.argv.indexOf("--effort") + 1], "max");

  const appList = adapter.buildRunPlan({ ...base, model: "gpt-5.5", effort: "max" });
  assert.equal(appList.ok, false, "an App-published list is enforced too");
  if (!appList.ok) assert.match(appList.error, /low, medium, high, xhigh/);

  const noEvidence = adapter.buildRunPlan({ ...base, model: "kimi-k3", effort: "xhigh" });
  assert.ok(noEvidence.ok, "no model-specific evidence means no model-specific claim");
});
