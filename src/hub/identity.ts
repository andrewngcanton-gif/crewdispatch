// identity.ts — the CrewDispatch Hub's build identity.
//
// One lightweight value, snapshotted when a Hub process starts (see
// `createHubHandler`) and never recomputed per request:
//
//   * `buildId` — a deterministic digest of the SERVED build output
//                 (`<root>/dist`, minus the test build): the newest build
//                 timestamp plus a short hash of the build files' paths, sizes,
//                 mtimes and bytes. It changes on every rebuild — including a
//                 rebuild that keeps `package.json` at the same `0.0.0-m1`.
//
// Release upgrades are identified by the package VERSION; development rebuilds
// under the same version are identified by this build id. Together they answer
// exactly one question: "is the process on this port the build I am about to
// run, or an older one?".
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Build outputs that are NOT part of the served product. `dist/tests` holds the
 * compiled test suite only; a test-only edit must not force a Hub restart.
 */
const NON_SERVED_BUILD_DIRS = new Set(["tests"]);

export interface HubBuildIdentity {
  /** Deterministic digest of the served build, or null when it cannot be read. */
  buildId: string | null;
  /** The package version this build reports (null when unavailable). */
  version: string | null;
}

/** The build root a compiled module lives in (`dist/<dir>` -> root). */
export function resolveHubRoot(fromDir: string): string {
  return path.resolve(fromDir, "..", "..");
}

interface BuildFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Every served build file, as sorted POSIX-relative paths. */
function collectBuildFiles(distDir: string): BuildFile[] | null {
  const files: BuildFile[] = [];
  const visit = (dir: string, rel: string, depth: number): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (depth === 0 && entry.isDirectory() && NON_SERVED_BUILD_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(path.join(dir, entry.name));
      files.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  try {
    visit(distDir, "", 0);
  } catch {
    return null;
  }
  return files;
}

/**
 * Lightweight deterministic identity of the served Hub API/UI build: the newest
 * build timestamp (base36) plus a short digest of the sorted build files. Both
 * a changed file and a rebuild that only re-emits the same bytes (a new
 * timestamp) produce a different id; identical build output always produces the
 * identical one.
 */
export function computeBuildId(distDir: string): string | null {
  const files = collectBuildFiles(distDir);
  if (files === null) return null;
  const hash = crypto.createHash("sha256");
  let newest = 0;
  try {
    for (const file of files) {
      hash.update(`${file.path}|${file.size}|${file.mtimeMs}|`);
      hash.update(fs.readFileSync(path.join(distDir, ...file.path.split("/"))));
      hash.update("\0");
      if (file.mtimeMs > newest) newest = file.mtimeMs;
    }
  } catch {
    return null;
  }
  return `${Math.round(newest).toString(36)}-${hash.digest("hex").slice(0, 12)}`;
}

/** Read the package version recorded in the build root (null when absent). */
export function readPackageVersion(root: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Snapshot the identity of one build root. Called ONCE per Hub process (and
 * once per ensure attempt in the launcher), never per request.
 */
export function snapshotHubBuild(options: { root: string; distDir?: string }): HubBuildIdentity {
  const root = path.resolve(options.root);
  return {
    buildId: computeBuildId(options.distDir ?? path.join(root, "dist")),
    version: readPackageVersion(root)
  };
}
