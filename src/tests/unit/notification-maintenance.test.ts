// notification-maintenance.test.ts — the shared, provider/caller-neutral
// maintenance registry: adapters are dispatched once each and a failing adapter
// is isolated into a result, never propagated into the daemon's reconcile cycle.
import test from "node:test";
import assert from "node:assert/strict";
import { registerNotificationMaintenance, runNotificationMaintenance } from "../../jobs/notifications";

test("runNotificationMaintenance dispatches to registered adapters and isolates failures", async () => {
  let ran = 0;
  registerNotificationMaintenance({
    kind: "test_maintenance_ok",
    async maintain(root) {
      ran += 1;
      assert.equal(typeof root, "string");
      return { kind: "test_maintenance_ok", scanned: true, checked: 2, removed: 1, reason: null };
    }
  });
  registerNotificationMaintenance({
    kind: "test_maintenance_throw",
    async maintain() {
      throw new Error("boom");
    }
  });

  const results = await runNotificationMaintenance("/nonexistent-maintenance-root");
  assert.equal(ran, 1, "the working adapter ran exactly once");
  const ok = results.find((r) => r.kind === "test_maintenance_ok");
  assert.equal(ok?.scanned, true);
  assert.equal(ok?.removed, 1);
  const thrown = results.find((r) => r.kind === "test_maintenance_throw");
  assert.equal(thrown?.scanned, false, "a throwing adapter never claims work");
  assert.match(String(thrown?.reason), /maintenance_failed/, "a thrown error becomes a stable diagnostic");
});
