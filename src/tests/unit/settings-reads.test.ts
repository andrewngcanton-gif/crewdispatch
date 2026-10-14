// settings-reads.test.ts — the provider-neutral settings READ path.
//
// Everything here is deterministic: probes are controlled promises and the
// clock is injected; no CLI, worker or filesystem is touched. The tests pin the
// current read contract:
//   A. every read is a real probe — the response carries the probe's own view
//      and billing-verified provenance, and a later read probes again;
//   B. N concurrent reads for one provider/root cause exactly ONE underlying
//      probe (the retained concurrent-probe dedupe);
//   C. a failed (or rejected) probe reports billing_verified false and a later
//      read retries with a genuinely new probe;
//   D. invalidate() detaches a pre-save probe: it is neither joined nor reused,
//      so post-save state always comes from a post-save read;
//   E. providers and roots never share probe state.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderSettingsReads,
  type SettingsProbeResult,
  type SettingsProviderDefinition
} from "../../config/settings-reads";
import { commandCodeSettingsView, workBuddyAiSettingsView } from "../helpers/settings-fixtures";
import type { SettingsView } from "../../config/settings";
import type { WorkBuddyAiSettingsView } from "../../config/workbuddy-ai";

interface ControlledProbe {
  definition: SettingsProviderDefinition<any>;
  calls: number;
  settleAt(index: number, result: SettingsProbeResult<any>): void;
  rejectAt(index: number, error: Error): void;
  pendingCount(): number;
}

/** A provider whose read never resolves until the test settles that exact call. */
function controlledProvider(id: string): ControlledProbe {
  const pending: Array<{
    resolve: (result: SettingsProbeResult<any>) => void;
    reject: (error: Error) => void;
  }> = [];
  const probe: ControlledProbe = {
    calls: 0,
    definition: {
      id,
      read: () =>
        new Promise<SettingsProbeResult<any>>((resolve, reject) => {
          probe.calls += 1;
          pending.push({ resolve, reject });
        }),
      applyPatch: () => ({})
    },
    settleAt(index, result) {
      const slot = pending[index];
      if (!slot) throw new Error(`no probe pending at index ${index}`);
      slot.resolve(result);
    },
    rejectAt(index, error) {
      const slot = pending[index];
      if (!slot) throw new Error(`no probe pending at index ${index}`);
      slot.reject(error);
    },
    pendingCount() {
      return pending.length;
    }
  };
  return probe;
}

test("every read is a real probe with its own evidence and verified_at; no result is replayed", async () => {
  const provider = controlledProvider("command-code");
  const verifiedAtMs = 1_700_000_000_000;
  const reads = new ProviderSettingsReads([provider.definition], { now: () => verifiedAtMs });

  const first = reads.readFresh("command-code", "/root/a", {});
  assert.equal(provider.calls, 1, "the read starts a real probe");
  assert.equal(reads.inflight("command-code", "/root/a"), true);
  provider.settleAt(0, {
    ok: true,
    view: commandCodeSettingsView({ models: ["m/one", "m/two"], freeModels: ["m/two"] })
  });
  const fresh = await first;
  assert.equal(fresh.result.ok, true);
  assert.equal(fresh.freshness.provider, "command-code");
  assert.equal(fresh.freshness.source, "probe");
  assert.equal(fresh.freshness.billing_verified, true, "a real probe is the only billing-verified source");
  assert.equal(fresh.freshness.verified_at, new Date(verifiedAtMs).toISOString());
  assert.equal(reads.inflight("command-code", "/root/a"), false);

  // A later read must NOT replay the completed result: it starts a new probe.
  const second = reads.readFresh<SettingsView>("command-code", "/root/a", {});
  assert.equal(provider.calls, 2, "a completed read is never reused");
  provider.settleAt(1, { ok: true, view: commandCodeSettingsView({ models: ["m/three"] }) });
  const again = await second;
  assert.equal(again.result.ok && again.result.view.catalog.models.join(","), "m/three");
});

test("N concurrent reads for one provider/root cause exactly ONE underlying probe", async () => {
  const provider = controlledProvider("command-code");
  const reads = new ProviderSettingsReads([provider.definition]);

  const concurrent = Promise.all(
    Array.from({ length: 6 }, () => reads.readFresh("command-code", "/root/b", {}))
  );
  assert.equal(provider.calls, 1, "the first read starts the probe; every other read joins it");
  provider.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["m/dedup"] }) });
  const results = await concurrent;
  assert.equal(provider.calls, 1, "no duplicate probe was launched");
  for (const entry of results) {
    assert.equal(entry.result.ok, true);
    assert.equal(entry.freshness.billing_verified, true);
  }

  // The dedupe covers only an IN-FLIGHT probe: the next completed window read
  // starts a genuinely new probe (every read is fresh).
  const next = reads.readFresh("command-code", "/root/b", {});
  assert.equal(provider.calls, 2);
  provider.settleAt(1, { ok: true, view: commandCodeSettingsView() });
  await next;
});

test("a failed probe is never billing-verified, and the next read retries with a new probe", async () => {
  const provider = controlledProvider("command-code");
  const reads = new ProviderSettingsReads([provider.definition]);

  const first = reads.readFresh("command-code", "/root/c", {});
  provider.settleAt(0, { ok: false, code: "config_invalid", message: "bad config", field: "default_model", raw: "{oops" });
  const failed = await first;
  assert.equal(failed.result.ok, false);
  assert.equal(failed.freshness.billing_verified, false, "a failed probe cannot certify billing evidence");
  assert.equal(failed.freshness.verified_at, null);

  const retry = reads.readFresh("command-code", "/root/c", {});
  assert.equal(provider.calls, 2, "the retry is a real new probe");
  provider.settleAt(1, { ok: true, view: commandCodeSettingsView() });
  assert.equal((await retry).freshness.billing_verified, true);
});

test("a rejected probe rejects honestly and leaves no in-flight state behind", async () => {
  const provider = controlledProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([provider.definition]);

  const first = reads.readFresh("workbuddy-ai", "/root/r", {});
  provider.rejectAt(0, new Error("probe worker exploded"));
  await assert.rejects(first, /probe worker exploded/);
  assert.equal(reads.inflight("workbuddy-ai", "/root/r"), false, "a rejection never leaves the entry stuck in flight");

  const retry = reads.readFresh("workbuddy-ai", "/root/r", {});
  assert.equal(provider.calls, 2);
  provider.settleAt(1, { ok: true, view: workBuddyAiSettingsView({ models: ["hy3"] }) });
  await retry;
});

test("invalidate detaches a pre-save probe: it is neither joined nor reused by the post-save read", async () => {
  const provider = controlledProvider("command-code");
  const reads = new ProviderSettingsReads([provider.definition]);

  const preSave = reads.readFresh<SettingsView>("command-code", "/root/d", {});
  assert.equal(provider.pendingCount(), 1);
  reads.invalidate("command-code", "/root/d");
  assert.equal(reads.inflight("command-code", "/root/d"), false, "the pre-save probe was detached");

  const postSave = reads.readFresh<SettingsView>("command-code", "/root/d", {});
  assert.equal(provider.calls, 2, "the post-save read starts a new probe instead of joining the pre-save one");
  provider.settleAt(1, { ok: true, view: commandCodeSettingsView({ models: ["post-save"] }) });
  const after = await postSave;
  assert.deepEqual(
    after.result.ok && after.result.view.catalog.models,
    ["post-save"],
    "the post-save response is the post-save probe's own evidence"
  );

  // The detached pre-save probe still settles for its ORIGINAL caller only.
  provider.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["pre-save"] }) });
  const before = await preSave;
  assert.deepEqual(before.result.ok && before.result.view.catalog.models, ["pre-save"]);
});

test("providers and roots never share probe state", async () => {
  const cc = controlledProvider("command-code");
  const wb = controlledProvider("workbuddy-ai");
  const reads = new ProviderSettingsReads([cc.definition, wb.definition]);

  const ccProbe = reads.readFresh<SettingsView>("command-code", "/root/j", {});
  const wbProbe = reads.readFresh<WorkBuddyAiSettingsView>("workbuddy-ai", "/root/j", {});
  const otherRoot = reads.readFresh<SettingsView>("command-code", "/root/k", {});
  assert.equal(cc.calls, 2, "the same provider on a different root gets its own probe");
  assert.equal(wb.calls, 1);

  cc.settleAt(0, { ok: true, view: commandCodeSettingsView({ models: ["cc/j"] }) });
  wb.settleAt(0, { ok: true, view: workBuddyAiSettingsView() });
  cc.settleAt(1, { ok: true, view: commandCodeSettingsView({ models: ["cc/k"] }) });
  const [first, second, third] = await Promise.all([ccProbe, wbProbe, otherRoot]);
  assert.equal(first.result.ok && first.result.view.catalog.models.join(","), "cc/j");
  assert.equal(second.result.ok && second.result.view.config.default_model, "deepseek-v4.1-flash");
  assert.equal(third.result.ok && third.result.view.catalog.models.join(","), "cc/k");
});
