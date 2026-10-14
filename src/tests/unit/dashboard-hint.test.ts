import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimDashboardFirstUseHint,
  dashboardFirstUseHint,
  dashboardHintMarkerPath
} from "../../onboarding/dashboard-hint";

test("Dashboard hint is claimed once per caller session and carries the exact URL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-dashboard-hint-"));
  const urlA = "http://127.0.0.1:30080/ui";
  const urlB = "http://127.0.0.1:30123/ui";
  try {
    fs.mkdirSync(path.join(root, "onboarding"), { recursive: true });
    fs.writeFileSync(path.join(root, "onboarding", "dashboard-hint-v1.shown"), "shown\n");

    assert.equal(claimDashboardFirstUseHint(root, "codex:session-a", urlA), dashboardFirstUseHint(urlA));
    assert.equal(claimDashboardFirstUseHint(root, "codex:session-a", urlA), null);
    assert.equal(claimDashboardFirstUseHint(root, "codex:session-b", urlB), dashboardFirstUseHint(urlB));
    assert.equal(fs.readFileSync(dashboardHintMarkerPath(root, "codex:session-a"), "utf8"), "shown\n");
    assert.equal(fs.readFileSync(dashboardHintMarkerPath(root, "codex:session-b"), "utf8"), "shown\n");
    assert.equal(path.basename(dashboardHintMarkerPath(root, "codex:session-a")).includes("session-a"), false, "raw session ids are not persisted in marker names");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});