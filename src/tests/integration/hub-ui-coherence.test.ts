// hub-ui-coherence.test.ts — regression for the post-rebuild incoherence defect:
// one Hub process must serve ONE coherent API + UI revision for its whole life.
//
// Root cause being pinned: `/ui/client.js` used to be read from the mutable
// build output on EVERY request, so an old process (whose /api/settings still
// answered the pre-T3 raw view) could serve a NEW client bundle after a
// rebuild — the browser then ran new client code against old handlers and the
// Settings page failed with "Settings unavailable".
//
// Evidence layers, all through the real HTTP Hub on an ephemeral loopback port:
//   * the client asset is pointed at a disposable file: revision A is served;
//     the backing file is replaced with revision B while the Hub stays alive;
//     every repeated /ui/client.js request still serves A, and the same live
//     process keeps answering the CURRENT settings fresh-read envelope;
//   * a NEW Hub started afterwards serves B — while the old process still
//     serves A (no cross-process leakage);
//   * an asset missing at creation fails honestly (503 ui_build_missing) on
//     every request and is NEVER healed by a later build appearing on disk.
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
import { commandCodeSettingsView } from "../helpers/settings-fixtures";

// ---------------------------------------------------------------------------
// Controlled provider (no CLI involved): pins the settings envelope contract.
// ---------------------------------------------------------------------------

function controlledProvider(id: string): {
  definition: SettingsProviderDefinition<any>;
  pendingCount(): number;
  settleNext(result: SettingsProbeResult<any>): void;
} {
  const pending: Array<{ resolve: (result: SettingsProbeResult<any>) => void }> = [];
  return {
    definition: {
      id,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve) => {
          pending.push({ resolve });
        }),
      applyPatch: () => ({})
    },
    pendingCount: () => pending.length,
    settleNext(result) {
      const slot = pending.shift();
      if (!slot) throw new Error(`no pending probe for ${id}`);
      slot.resolve(result);
    }
  };
}

// ---------------------------------------------------------------------------
// Test hub helpers
// ---------------------------------------------------------------------------

interface TestHub {
  hub: HubHandle;
  url: string;
  stop(): Promise<void>;
}

async function startTestHub(options: {
  root: string;
  clientAssetPath?: string;
  settingsReads?: ProviderSettingsReads;
}): Promise<TestHub> {
  const hub = startHub({
    root: options.root,
    host: "127.0.0.1",
    port: 0,
    settingsReads: options.settingsReads,
    clientAssetPath: options.clientAssetPath,
    // A minimal env keeps the test from inheriting any real user configuration.
    env: { JOBQUAY_DATA_ROOT: options.root }
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

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function tmpWorkspace(name: string): { dir: string; root: string; assetPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-ui-coherence-${name}-`));
  return { dir, root: path.join(dir, "root"), assetPath: path.join(dir, "ui", "client.js") };
}

// ---------------------------------------------------------------------------
// A — the live process keeps its own client revision while the build changes
// ---------------------------------------------------------------------------

test("a live Hub serves ONE coherent client revision: the backing file may change, the process never does", { timeout: 60000 }, async () => {
  const { dir, root, assetPath } = tmpWorkspace("revision");
  const revisionA = "// jobquay client revision A\nwindow.__jobquayClientRevision = 'A';\n";
  const revisionB = "// jobquay client revision B\nwindow.__jobquayClientRevision = 'B';\n";
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, revisionA, "utf8");

  const cc = controlledProvider("command-code");
  const first = await startTestHub({ root, clientAssetPath: assetPath, settingsReads: new ProviderSettingsReads([cc.definition]) });
  let second: TestHub | null = null;
  try {
    // The /ui shell and its script boundary are unchanged.
    const page = await fetch(`${first.url}/ui`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(await page.text(), /<script defer src="\/ui\/client\.js"><\/script>/);

    // This process started with revision A and serves exactly those bytes.
    const initial = await fetch(`${first.url}/ui/client.js`);
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.equal(await initial.text(), revisionA);

    // The build output changes on disk while the process stays alive...
    fs.writeFileSync(assetPath, revisionB, "utf8");
    assert.equal(fs.readFileSync(assetPath, "utf8"), revisionB, "the backing file really holds revision B now");

    // ...and the LIVE Hub still serves revision A on every repeated request:
    // it never re-reads the mutable build output.
    for (let i = 0; i < 3; i += 1) {
      const again = await fetch(`${first.url}/ui/client.js`);
      assert.equal(again.status, 200);
      assert.equal(await again.text(), revisionA, `request #${i + 1} after the rebuild still serves revision A`);
    }

    // The API contract of the SAME live process is the CURRENT one: the
    // settings fresh-read envelope — the exact route the defect surfaced
    // through when an old process served a new client bundle.
    const freshResponse = getJson(`${first.url}/api/settings?fresh=1`);
    await waitFor(() => cc.pendingCount() === 1, 5000, "the settings probe");
    cc.settleNext({ ok: true, view: commandCodeSettingsView({ models: ["m/one", "m/two"], freeModels: ["m/two"] }) });
    const fresh = await freshResponse;
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.ok, true);
    assert.deepEqual(fresh.body.view.catalog.models, ["m/one", "m/two"]);
    assert.equal(fresh.body.freshness.source, "probe");
    assert.equal(fresh.body.freshness.billing_verified, true);

    // A NEW Hub started afterwards (for its OWN data root — a second Hub for the
    // SAME root is a different contract, covered by hub-endpoint-ownership) picks
    // up revision B...
    second = await startTestHub({ root: path.join(dir, "root-b"), clientAssetPath: assetPath, settingsReads: new ProviderSettingsReads([cc.definition]) });
    const freshProcess = await fetch(`${second.url}/ui/client.js`);
    assert.equal(freshProcess.status, 200);
    assert.equal(await freshProcess.text(), revisionB);

    // ...while the old process still serves its own revision (no leakage).
    const stillOld = await fetch(`${first.url}/ui/client.js`);
    assert.equal(await stillOld.text(), revisionA, "the new process must not leak its build into the old one");
  } finally {
    if (second) await second.stop();
    await first.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — a missing asset at creation fails honestly and is never healed mid-process
// ---------------------------------------------------------------------------

test("a Hub created without a client asset fails /ui/client.js honestly and never heals mid-process", { timeout: 60000 }, async () => {
  const { dir, root, assetPath } = tmpWorkspace("missing");
  const hub = await startTestHub({ root, clientAssetPath: assetPath });
  let restarted: TestHub | null = null;
  try {
    const missing = await getJson(`${hub.url}/ui/client.js`);
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error, "ui_build_missing");

    // The rest of the Hub is independent of the browser bundle.
    const ping = await getJson(`${hub.url}/api/ping`);
    assert.equal(ping.status, 200);
    assert.equal(ping.body.service, "jobquay");

    // A later build appears on disk: THIS process still refuses honestly — the
    // missing-asset decision is never re-evaluated mid-process.
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, "// jobquay client revision B\n", "utf8");
    const stillMissing = await getJson(`${hub.url}/ui/client.js`);
    assert.equal(stillMissing.status, 503, "the missing-asset decision is never re-evaluated mid-process");
    assert.equal(stillMissing.body.error, "ui_build_missing");

    // A restarted Hub serves it.
    restarted = await startTestHub({ root, clientAssetPath: assetPath });
    const served = await fetch(`${restarted.url}/ui/client.js`);
    assert.equal(served.status, 200);
    assert.match(await served.text(), /revision B/);
  } finally {
    if (restarted) await restarted.stop();
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
