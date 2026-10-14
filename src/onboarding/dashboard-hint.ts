import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertInside, ensureRoot } from "../jobs/store";

export function dashboardFirstUseHint(url: string): string {
  return `CrewDispatch Dashboard: ${url} — it may still be starting.\nOpen it anytime with \`crewdispatch web\`.`;
}

export function dashboardHintMarkerPath(root: string, sessionKey: string): string {
  const digest = crypto.createHash("sha256").update(sessionKey, "utf8").digest("hex");
  const file = path.join(root, "onboarding", "dashboard-hint-v2", `${digest}.shown`);
  assertInside(root, file);
  return file;
}

/**
 * Claim the Dashboard onboarding hint once per caller conversation. The raw
 * caller/session id is never written to disk: only a SHA-256-derived marker
 * filename is persisted. Unknown/unbound callers share one fallback key.
 */
export function claimDashboardFirstUseHint(root: string, sessionKey: string | null, url: string): string | null {
  try {
    ensureRoot(root);
    const file = dashboardHintMarkerPath(root, sessionKey || "unbound");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, "shown\n", "utf8");
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    return dashboardFirstUseHint(url);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return null;
    return null;
  }
}
