import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DASHBOARD_FIRST_USE_HINT,
  claimDashboardFirstUseHint,
  dashboardHintMarkerPath
} from "../../onboarding/dashboard-hint";

test("Dashboard first-use hint is claimed at most once per data root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-dashboard-hint-"));
  try {
    assert.equal(claimDashboardFirstUseHint(root), DASHBOARD_FIRST_USE_HINT);
    assert.equal(claimDashboardFirstUseHint(root), null);
    assert.equal(fs.readFileSync(dashboardHintMarkerPath(root), "utf8"), "shown\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
