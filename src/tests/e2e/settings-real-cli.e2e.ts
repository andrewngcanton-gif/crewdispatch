// settings-real-cli.e2e.ts — REAL-ENTRY acceptance of the settings read path
// against the user-installed official `cmdc`, under a DISPOSABLE ISOLATED TEST
// PROFILE.
//
// Run with:  npm.cmd run test:e2e:settings
//
// What this proves:
//   * the BUILT MCP server answers `jobquay_settings_get` / `jobquay_settings_update`
//     as a separate process with real JSON-RPC;
//   * the config `cli_path` override is honoured and reported with its source;
//   * the model catalog is reported with its SOURCE, its ordered model id list
//     and refresh time, or an honest unavailable state (empty list, null refresh
//     time) — never a hard-coded list; the normal source is the installed
//     package's own shipped reference, with `--list-models` as the fallback;
//   * only the CLI's PUBLIC read-only probes run (`--version`/`--help` and, on
//     the fallback path, `--list-models`): no prompt, no paid request and no
//     credential is used.
//
// It does NOT claim a usable catalog: under an isolated, unauthenticated profile
// `--list-models` may legitimately be unavailable, and the test accepts either
// outcome as long as it is reported honestly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { createCliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");

test("the built MCP settings entry probes the real cmdc under an isolated profile and reports provenance honestly", { timeout: 300000 }, async () => {
  const resolution = resolveCommandCodeCli({});
  if (!resolution.ok || !resolution.path) {
    console.log(`[e2e:settings] skipped: Command Code CLI not resolved (source=${resolution.source})`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-settings-real-"));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "jobquay-settings-iso-" });
  const sentinel = path.join(iso.cliHome, "jobquay-sandbox-sentinel");
  fs.writeFileSync(sentinel, "jobquay-settings-e2e-sandbox\n", "utf8");

  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root };
  const client = new McpStdioClient(MCP_ENTRY, env, dir);
  try {
    const init = await client.initialize();
    assert.equal((init.serverInfo as Record<string, unknown>).name, "crewdispatch");

    const updated = McpStdioClient.json(
      await client.callTool("jobquay_settings_update", { cli_path: resolution.path, permission_mode: "plan" })
    );
    assert.equal(updated.ok, true);

    const get = McpStdioClient.json(await client.callTool("jobquay_settings_get", {}));
    assert.equal(get.ok, true);
    const cli = get.cli as Record<string, unknown>;
    const catalog = get.catalog as Record<string, unknown>;
    assert.equal(cli.available, true, "the real CLI must resolve through the configured path");
    assert.equal(cli.path, resolution.path);
    assert.equal(cli.source, "config-path");
    if (cli.error) {
      assert.equal(cli.version, null, "a failed/unconfirmed capability probe reports no version");
    } else {
      assert.ok(typeof cli.version === "string" && cli.version.length > 0, "the real CLI version must be read");
    }
    // Honest catalog provenance: the installed package's OWN shipped reference
    // (the normal path) or the CLI's own --list-models (fallback) are the only
    // reliable sources; anything else is reported unavailable.
    const reliableSources = new Set(["installed-package-reference", "cli-list-models"]);
    assert.equal(catalog.reliable, reliableSources.has(String(catalog.source)));
    assert.ok(reliableSources.has(String(catalog.source)) || catalog.source === "unavailable");
    const models = catalog.models as unknown;
    assert.ok(Array.isArray(models), "the catalog exposes an ordered model id list");
    if (catalog.reliable) {
      // A reliable catalog is a real provider-owned list: an ordered, non-empty
      // id array that a dynamic dropdown can use directly.
      assert.equal((models as unknown[]).length, catalog.count);
      assert.ok((models as unknown[]).length > 0, "the installed catalog publishes at least one model");
      assert.ok((models as string[]).every((m) => typeof m === "string" && m.length > 0));
      if (catalog.default_model) {
        assert.ok((models as string[]).includes(String(catalog.default_model)), "a published default must be one of the published ids");
      }
      assert.match(String(catalog.refreshed_at), /^\d{4}-\d{2}-\d{2}T/);
    } else {
      assert.equal(catalog.count, 0);
      assert.deepEqual(models, [], "an unavailable catalog must not fabricate a list");
      assert.equal(catalog.refreshed_at, null, "an unavailable catalog is NOT a refresh");
      assert.ok(catalog.error, "an unavailable catalog must carry an honest reason");
    }
    const features = get.features as Record<string, unknown>;
    // First-release runtime: rate-limit fallback remains active; time-of-day
    // scheduling and in-flight clock-boundary switching are disabled.
    assert.equal(features.rate_limit_fallback_active, true);
    assert.equal(features.in_flight_switch_active, false);

    console.log(
      "[e2e:settings] real cmdc settings:",
      JSON.stringify({
        cli: { available: cli.available, source: cli.source, version: cli.version },
        catalog: {
          source: catalog.source,
          reliable: catalog.reliable,
          count: catalog.count,
          models: Array.isArray(catalog.models) ? (catalog.models as string[]).slice(0, 5) : catalog.models,
          refreshed_at: catalog.refreshed_at,
          default_model: catalog.default_model
        },
        effective: get.effective
      })
    );
    console.log(`[e2e:settings] isolated profile used: cliHome=${iso.cliHome}`);

    assert.equal(fs.existsSync(sentinel), true, "the isolated profile sentinel must be untouched");
    assert.equal(fs.existsSync(path.join(root, "cli-runs")), false, "the product must not create a per-job CLI tree");
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
