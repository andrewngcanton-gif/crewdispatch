import fs from "node:fs";
import path from "node:path";
import { assertInside, ensureRoot } from "../jobs/store";

/**
 * One-time first-use hint, claimed by the MCP layer on the first
 * dispatch for a data root. This describes an ATTEMPT made off the
 * response path: it must never promise that the Dashboard is running
 * or will succeed — startup is fire-and-forget, may be disabled, and
 * any failure is recorded in the bounded local diagnostic rather than
 * claimed in the dispatch response.
 */
export const DASHBOARD_FIRST_USE_HINT = "CrewDispatch is attempting to start the Dashboard quietly in the background with this dispatch; no browser is opened and it may not be ready yet.\nTo open it manually, run: `crewdispatch web`";

export function dashboardHintMarkerPath(root: string): string {
  const file = path.join(root, "onboarding", "dashboard-hint-v1.shown");
  assertInside(root, file);
  return file;
}

/**
 * Claim the one-time Dashboard onboarding hint for this CrewDispatch data root.
 *
 * The marker uses an exclusive create so concurrent first dispatches cannot both
 * claim the hint. Hint persistence is best-effort and must never make an accepted
 * job fail.
 */
export function claimDashboardFirstUseHint(root: string): string | null {
  try {
    ensureRoot(root);
    const file = dashboardHintMarkerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, "shown\n", "utf8");
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    return DASHBOARD_FIRST_USE_HINT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return null;
    return null;
  }
}
