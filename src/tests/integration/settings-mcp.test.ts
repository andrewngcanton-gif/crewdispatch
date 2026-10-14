// settings-mcp.test.ts — CROSS-PROCESS acceptance of the settings + model
// selection path through the BUILT MCP server (`dist/mcp/server.js`).
//
// It drives the REAL production runner against a CONTROLLED official-CLI fixture
// that speaks the installed Command Code ACP protocol (a real separate child
// process — see tests/helpers/cc-acp-fixture.ts). The production entry launches
// the REAL ACP bridge, which selects the model/effort/permission mode over
// JSON-RPC before prompting. This exercises the real protocol configuration
// (`session/set_model`, `session/set_config_option`, `session/set_mode`), the
// persisted JobRecord `modelSource`, cross-process config persistence and
// stale-id rejection — none of which a mock unit test can prove.
//
// The two simulated local times are driven by the TEST-ONLY `JOBQUAY_TEST_NOW`
// env seam read by the detached worker (never exposed through the tool schema).
// No real CLI profile, credential or notification target is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCliIsolation, type CliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { promptEventsFor, readCcAcpLog, writeCcAcpCmdcFixture } from "../helpers/cc-acp-fixture";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);
const SESSION = "fake-session-settings";

interface Workspace {
  dir: string;
  root: string;
  iso: CliIsolation;
  fakeCli: string;
  log: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function newWorkspace(name: string, nowIso: string): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-settings-${name}-`));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: `iso-${name}-` });
  const cliDir = path.join(dir, "cli");
  fs.mkdirSync(cliDir, { recursive: true });
  // A controlled ACP CLI publishing a 3-model catalog; with no behavior env set
  // every model completes a turn.
  const { shim } = writeCcAcpCmdcFixture(cliDir, {
    models: ["fake/model-a", "fake/model-b", "fake/model-c"],
    defaultModel: "fake/model-a",
    sessionId: SESSION
  });
  const log = path.join(dir, "fake-invocations.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...iso.env,
    JOBQUAY_DATA_ROOT: root,
    JOBQUAY_TEST_NOW: nowIso,
    FAKE_CLI_LOG: log
  };
  return { dir, root, iso, fakeCli: shim, log, env, cleanup: () => McpStdioClient.cleanupWorkspace(root, dir) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

function jobRecord(root: string, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "jobs", `${id}.json`), "utf8")) as Record<string, unknown>;
}

const CONFIG = {
  cli_path: "",
  default_model: "fake/model-c",
  rate_limit_fallback_model: "fake/model-c",
  permission_mode: "accept-edits",
  default_effort: "high",
  rate_limit_fallback_effort: "medium"
};

test("settings persist across an MCP restart; model selection and stale handling run through the built entry", { timeout: 180000 }, async () => {
  const ws = newWorkspace("main", "2026-09-24T09:00:00");
  const sentinel = path.join(ws.iso.cliHome, "jobquay-sandbox-sentinel");
  fs.writeFileSync(sentinel, "settings-mcp-sandbox\n", "utf8");
  const project1 = path.join(ws.iso.root, "project1");
  const project2 = path.join(ws.iso.root, "project2");
  fs.mkdirSync(project1, { recursive: true });
  fs.mkdirSync(project2, { recursive: true });

  let clientA: McpStdioClient | null = null;
  let clientB: McpStdioClient | null = null;
  try {
    // ---- Server A (local time 09:00) ----
    clientA = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
    await clientA.initialize();

    const updated = McpStdioClient.json(
      await clientA.callTool("jobquay_settings_update", { ...CONFIG, cli_path: ws.fakeCli })
    );
    assert.equal(updated.ok, true);
    const cfg = updated.config as Record<string, unknown>;
    assert.equal(cfg.cli_path, ws.fakeCli);
    assert.equal(cfg.default_model, "fake/model-c");
    assert.deepEqual(cfg.time_slots, []);
    assert.equal(cfg.in_flight_switch, false);

    const getA = McpStdioClient.json(await clientA.callTool("jobquay_settings_get", {}));
    assert.equal(getA.ok, true);
    const cli = getA.cli as Record<string, unknown>;
    const catalog = getA.catalog as Record<string, unknown>;
    assert.equal(cli.available, true, "the controlled CLI must be found through the configured path");
    assert.equal(cli.path, ws.fakeCli);
    assert.equal(cli.source, "config-path");
    assert.equal(catalog.source, "cli-list-models");
    assert.equal(catalog.reliable, true);
    assert.equal(catalog.default_model, "fake/model-a");
    assert.deepEqual(catalog.models, ["fake/model-a", "fake/model-b", "fake/model-c"], "the ordered CLI model ids are exposed");
    assert.equal(catalog.count, 3);
    assert.match(String(catalog.refreshed_at), /^\d{4}-\d{2}-\d{2}T/);
    const effective = getA.effective as Record<string, unknown>;
    assert.equal(effective.model, "fake/model-c", "first release uses the configured default; scheduling is disabled");
    assert.equal(effective.source, "config-default");
    assert.equal(effective.slot_index, null);
    assert.deepEqual(getA.diagnostics, [], "every configured id is in the controlled catalog");
    const features = getA.features as Record<string, unknown>;
    assert.equal(features.rate_limit_fallback_active, true);
    assert.equal(features.in_flight_switch_active, false);

    // ---- dispatch with NO model: the configured default is selected at startup ----
    const task1 = "SETTINGS_TASK_ONE — exact bytes\nline two";
    const spawn1 = McpStdioClient.json(await clientA.callTool("jobquay_spawn", { task: task1, cwd: project1 }));
    assert.equal(spawn1.ok, true);
    const id1 = String(spawn1.job_id);
    const done1 = await waitTerminal(clientA, id1);
    assert.equal(done1.status, "done");

    const rec1 = jobRecord(ws.root, id1);
    assert.equal(rec1.model, "fake/model-c");
    assert.equal(rec1.modelSource, "config-default");
    assert.equal(rec1.explicitModel, null);

    const prompt1 = promptEventsFor(ws.log, project1);
    assert.equal(prompt1.length, 1, "the controlled CLI must have recorded exactly one prompt");
    assert.equal(prompt1[0]!.model, "fake/model-c", "the ACP session configured the configured default model");
    assert.equal(prompt1[0]!.effortValue, "high", "the configured default effort reached the provider's own state");
    assert.equal(prompt1[0]!.mode, "auto-accept", "accept-edits maps to the ACP auto-accept mode");
    assert.equal(prompt1[0]!.text, task1, "the task must reach the child verbatim");

    // ---- dispatch WITH an explicit model: never overridden by the slot ----
    const spawn2 = McpStdioClient.json(
      await clientA.callTool("jobquay_spawn", { task: "explicit override", cwd: project2, model: "fake/model-b" })
    );
    const id2 = String(spawn2.job_id);
    const done2 = await waitTerminal(clientA, id2);
    assert.equal(done2.status, "done");
    const rec2 = jobRecord(ws.root, id2);
    assert.equal(rec2.model, "fake/model-b", "the explicit model wins over the configured default");
    assert.equal(rec2.modelSource, "explicit");
    assert.equal(rec2.explicitModel, "fake/model-b");
    assert.equal(promptEventsFor(ws.log, project2)[0]!.model, "fake/model-b");

    await clientA.close();
    clientA = null;

    // ---- Server B: a fresh MCP process reads the SAME persisted settings ----
    clientB = new McpStdioClient(MCP_ENTRY, { ...ws.env, JOBQUAY_TEST_NOW: "2026-09-24T15:00:00" }, ws.dir);
    await clientB.initialize();
    const getB = McpStdioClient.json(await clientB.callTool("jobquay_settings_get", {}));
    assert.equal(getB.ok, true);
    const cfgB = getB.config as Record<string, unknown>;
    assert.equal(cfgB.cli_path, ws.fakeCli, "config survives an MCP process restart");
    assert.equal(cfgB.default_model, "fake/model-c");
    assert.equal(cfgB.permission_mode, "accept-edits");
    assert.equal(cfgB.default_effort, "high");
    assert.equal(cfgB.rate_limit_fallback_effort, "medium");
    assert.equal(cfgB.in_flight_switch, false);
    assert.deepEqual(cfgB.time_slots, []);
    const effB = getB.effective as Record<string, unknown>;
    assert.equal(effB.model, "fake/model-c");
    assert.equal(effB.source, "config-default");
    assert.equal(effB.slot_index, null);

    // ---- a stale configured default is reported and blocks dispatch honestly ----
    const stale = McpStdioClient.json(
      await clientB.callTool("jobquay_settings_update", { default_model: "fake/model-zzz" })
    );
    assert.equal(stale.ok, true);
    const getStale = McpStdioClient.json(await clientB.callTool("jobquay_settings_get", {}));
    const diags = getStale.diagnostics as Array<Record<string, unknown>>;
    assert.ok(diags.some((d) => d.code === "model_stale" && d.value === "fake/model-zzz"), "a stale id must be reported");

    const project3 = path.join(ws.iso.root, "project3");
    fs.mkdirSync(project3, { recursive: true });
    const spawn3 = McpStdioClient.json(await clientB.callTool("jobquay_spawn", { task: "stale model", cwd: project3 }));
    const id3 = String(spawn3.job_id);
    const done3 = await waitTerminal(clientB, id3);
    assert.equal(done3.status, "error");
    assert.equal((done3.result as Record<string, unknown>).kind, "model_stale");
    const rec3 = jobRecord(ws.root, id3);
    assert.equal(rec3.failureKind, "model_stale");
    assert.equal(promptEventsFor(ws.log, project3).length, 0, "a stale model must not run the CLI");

    // ---- isolation / residue ----
    assert.equal(fs.existsSync(sentinel), true, "the isolated profile sentinel must be untouched");
    assert.equal(fs.existsSync(path.join(ws.root, "cli-runs")), false, "the product must not create a per-job CLI tree");
    // No credential leaked onto the recorded protocol log.
    for (const entry of readCcAcpLog(ws.log)) {
      assert.equal(/KEY|TOKEN|SECRET|PASSWORD/i.test(JSON.stringify(entry)), false, `no credential may appear on the wire: ${JSON.stringify(entry)}`);
    }
  } finally {
    if (clientA) await clientA.close();
    if (clientB) await clientB.close();
    await ws.cleanup();
  }
});

test("YOLO settings select the provider's own bypass mode through the built MCP entry", { timeout: 120000 }, async () => {
  const ws = newWorkspace("yolo", "2026-09-29T12:00:00");
  const project = path.join(ws.iso.root, "project-yolo");
  fs.mkdirSync(project, { recursive: true });
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();
    const updated = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", {
        ...CONFIG,
        cli_path: ws.fakeCli,
        permission_mode: "yolo"
      })
    );
    assert.equal(updated.ok, true);

    const spawned = McpStdioClient.json(
      await client.callTool("jobquay_spawn", { task: "yolo argv evidence", cwd: project })
    );
    const id = String(spawned.job_id);
    const done = await waitTerminal(client, id);
    assert.equal(done.status, "done");

    const rec = jobRecord(ws.root, id);
    assert.equal(rec.permissionMode, "yolo");
    const prompt = promptEventsFor(ws.log, project);
    assert.equal(prompt.length, 1, "the controlled CLI must record the YOLO invocation");
    // YOLO maps to the CLI's OWN published bypass mode, selected EXACTLY once
    // before the prompt (no print-mode `--yolo` flag exists on the ACP path).
    assert.equal(prompt[0]!.mode, "bypass");
    const bypassSets = readCcAcpLog(ws.log).filter((entry) => entry.kind === "mode" && entry.value === "bypass");
    assert.equal(bypassSets.length, 1, "the bypass mode must be selected exactly once");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("an unknown settings field is rejected through the built MCP entry and config.json is left byte-identical", { timeout: 120000 }, async () => {
  const ws = newWorkspace("unknown", "2026-09-24T09:00:00");
  const cfgFile = path.join(ws.root, "config.json");
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();

    // Seed a valid config first, so "unchanged bytes" is a meaningful assertion.
    const seed = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", {
        cli_path: ws.fakeCli,
        default_model: "fake/model-a"
      })
    );
    assert.equal(seed.ok, true);
    const before = fs.readFileSync(cfgFile, "utf8");

    // A provider/edition selector is NOT a supported field: the request must be
    // REJECTED, not silently stripped into a misleading `ok:true`.
    const provider = await client.callTool("jobquay_settings_update", { provider: "command-code" });
    assert.equal(provider.isError, true, "an unsupported provider field must fail loudly");
    assert.equal(McpStdioClient.json(provider).code, "config_unknown_field");
    assert.equal(fs.readFileSync(cfgFile, "utf8"), before, "a rejected update must not touch config.json");

    // Scheduling fields are known legacy names but intentionally disabled in the current product.
    const disabledSchedule = await client.callTool("jobquay_settings_update", {
      time_slots: [{ start: "00:00", end: "12:00", model: "fake/model-b", enabled: true }]
    });
    assert.equal(disabledSchedule.isError, true);
    assert.equal(McpStdioClient.json(disabledSchedule).code, "feature_disabled");
    assert.equal(fs.readFileSync(cfgFile, "utf8"), before, "a disabled scheduling update must not touch config.json");

    // A typo of a known field is unknown as well — never silently dropped.
    const typo = await client.callTool("jobquay_settings_update", { default_modle: "fake/model-c" });
    assert.equal(typo.isError, true);
    assert.equal(McpStdioClient.json(typo).code, "config_unknown_field");
    assert.equal(fs.readFileSync(cfgFile, "utf8"), before);

    // The stored config is still the seeded one.
    const get = McpStdioClient.json(await client.callTool("jobquay_settings_get", {}));
    assert.equal(get.ok, true);
    assert.equal((get.config as Record<string, unknown>).default_model, "fake/model-a");

    // A real, valid update still works and DOES change the file.
    const ok = McpStdioClient.json(await client.callTool("jobquay_settings_update", { default_model: "fake/model-c" }));
    assert.equal(ok.ok, true);
    assert.equal((ok.config as Record<string, unknown>).default_model, "fake/model-c");
    assert.notEqual(fs.readFileSync(cfgFile, "utf8"), before, "a valid update must persist");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});

test("independent reasoning effort: changing a model resets ONLY its own effort through the built MCP entry", { timeout: 120000 }, async () => {
  const ws = newWorkspace("effort-reset", "2026-09-24T09:00:00");
  const client = new McpStdioClient(MCP_ENTRY, ws.env, ws.dir);
  try {
    await client.initialize();

    // Seed BOTH selections with their OWN, different effort.
    const seeded = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", {
        cli_path: ws.fakeCli,
        default_model: "fake/model-a",
        default_effort: "high",
        rate_limit_fallback_model: "fake/model-b",
        rate_limit_fallback_effort: "low"
      })
    );
    assert.equal(seeded.ok, true);
    let cfg = seeded.config as Record<string, unknown>;
    assert.equal(cfg.default_effort, "high");
    assert.equal(cfg.rate_limit_fallback_effort, "low");

    // Changing ONLY the default model clears ONLY the default effort.
    const changedDefault = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", { default_model: "fake/model-c" })
    );
    assert.equal(changedDefault.ok, true);
    cfg = changedDefault.config as Record<string, unknown>;
    assert.equal(cfg.default_effort, null, "the default-model change clears its own effort");
    assert.equal(cfg.rate_limit_fallback_effort, "low", "the fallback effort is independent and untouched");

    // A replacement supplied in the SAME update is kept.
    const replaced = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", { default_model: "fake/model-a", default_effort: "max" })
    );
    assert.equal(replaced.ok, true);
    cfg = replaced.config as Record<string, unknown>;
    assert.equal(cfg.default_effort, "max", "an explicit replacement in the same update is kept");
    assert.equal(cfg.rate_limit_fallback_effort, "low");

    // Persisted across a fresh read.
    const get = McpStdioClient.json(await client.callTool("jobquay_settings_get", {}));
    const persisted = get.config as Record<string, unknown>;
    assert.equal(persisted.default_effort, "max");
    assert.equal(persisted.rate_limit_fallback_effort, "low");
  } finally {
    await client.close();
    await ws.cleanup();
  }
});
