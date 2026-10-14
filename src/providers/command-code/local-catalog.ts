// local-catalog.ts — the INSTALLED-PACKAGE model reference of Command Code.
//
// WHY THIS EXISTS: the installed Command Code package ships its own model
// reference (`dist/bundled/command-code-knowledge/reference/models.md`) with the
// ids the installed version accepts, their advertised per-1M-token rates and the
// rows whose advertised rates are exactly zero. Reading that file is a bounded
// local file read — no process, no network — so Settings can populate its model
// dropdown and its Command Code Free-now labels from what the CURRENTLY
// INSTALLED package itself ships, instead of waiting for the CLI's
// `--list-models` (a cold spawn that can take tens of seconds or time out).
//
// SEMANTICS (deliberately narrow):
//   * "free" here means: the installed package's OWN shipped rate column lists
//     every advertised rate as exactly $0. It mirrors what the installed
//     Command Code version believes; it is NOT a live billing guarantee, an
//     account entitlement, or a promise that the provider backend agrees during
//     a release-lag window. Nothing is inferred from an id or a name containing
//     "free" — the price evidence is the only evidence.
//   * nothing else is claimed: no default model, no entitlement, no plan.
//   * when the file cannot be read or the table cannot be parsed safely the
//     reader fails honestly (ok:false) and NO model/free claim is produced —
//     never a hard-coded allowlist, never a guess.
//
// DISCOVERY is generic: it starts from the ALREADY RESOLVED CLI executable and
// derives the package from the local filesystem layout only. No user name, npm
// prefix, drive letter or machine-specific path is ever hardcoded.
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH_NAMES, normalizeEffort } from "./capability";
import { MODEL_TOKEN_RE } from "./argv";

/** The npm package name that ships the official Command Code CLI. */
export const COMMAND_CODE_PACKAGE_NAME = "command-code";

/**
 * Shipped reference locations, tried in order inside a discovered package root.
 * The first entry is the stable shipped path; the others tolerate a package
 * that ships the knowledge base at a shallower layout.
 */
export const INSTALLED_MODELS_REFERENCE_RELATIVE_PATHS: readonly string[] = Object.freeze([
  "dist/bundled/command-code-knowledge/reference/models.md",
  "bundled/command-code-knowledge/reference/models.md",
  "command-code-knowledge/reference/models.md"
]);

/** Bounds: this reader must stay cheap even on a huge package tree. */
const MAX_ANCESTORS = 12;
const MAX_SEARCH_ENTRIES = 4000;
const MAX_SEARCH_DEPTH = 6;
const MAX_SHIM_BYTES = 64 * 1024;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;

export interface PackageDiscoveryResult {
  /** Absolute package root that contains the Command Code `package.json`. */
  packageRoot: string;
  /** The `package.json` that proved the package identity. */
  packageJsonPath: string;
  /** How the root was found (diagnostics/evidence, never user-facing copy). */
  strategy: "cli-ancestor" | "shim-node-modules" | "shim-content" | "ancestor-node-modules";
}

function statFile(p: string): fs.Stats | null {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function readTextFile(p: string, maxBytes: number): string | null {
  try {
    const s = fs.statSync(p);
    if (!s.isFile() || s.size > maxBytes) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Bounded realpath: a symlinked CLI resolves to the package it really runs. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function ancestorsOf(startDir: string, limit = MAX_ANCESTORS): string[] {
  const out: string[] = [];
  let current = path.resolve(startDir);
  for (let i = 0; i < limit; i += 1) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * True when this `package.json` is the Command Code package: its `name` is
 * `command-code`, OR its `bin` maps one of the CLI's own command names onto a
 * file inside the package (a rename/scope is still the same installed CLI).
 */
function isCommandCodePackageJson(packageJsonPath: string, cliFile: string): boolean {
  const text = readTextFile(packageJsonPath, 256 * 1024);
  if (!text) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const pkg = parsed as { name?: unknown; bin?: unknown };
  if (typeof pkg.name === "string" && pkg.name.trim().toLowerCase() === COMMAND_CODE_PACKAGE_NAME) return true;
  const bin = pkg.bin;
  const targets: string[] = [];
  if (typeof bin === "string") targets.push(bin);
  else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
      if (typeof target === "string" && CLI_PATH_NAMES.includes(name)) targets.push(target);
    }
  }
  const root = path.dirname(packageJsonPath);
  const cliReal = safeRealpath(cliFile);
  for (const target of targets) {
    const resolved = path.resolve(root, target);
    if (resolved === path.resolve(cliFile) || safeRealpath(resolved) === cliReal) return true;
  }
  return false;
}

/** The package root of `dir`, when `dir` itself is the Command Code package. */
function packageRootAt(dir: string, cliFile: string): string | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (!statFile(packageJsonPath)) return null;
  return isCommandCodePackageJson(packageJsonPath, cliFile) ? packageJsonPath : null;
}

/**
 * npm keeps a global bin shim (`<prefix>/cmdc.cmd`, `<prefix>/cmdc`) next to the
 * package it launches (`<prefix>/node_modules/command-code`). POSIX prefixes
 * additionally use `<prefix>/lib/node_modules/<name>`. Both layouts are derived
 * from the shim's own directory — never from a fixed prefix.
 */
function nodeModulesCandidates(dir: string): string[] {
  return [
    path.join(dir, "node_modules", COMMAND_CODE_PACKAGE_NAME),
    path.join(dir, "lib", "node_modules", COMMAND_CODE_PACKAGE_NAME)
  ];
}

/** A text shim names the script it launches; extract its package-local target. */
function shimReferencedPackageRoots(shimPath: string): string[] {
  const raw = readTextFile(shimPath, MAX_SHIM_BYTES);
  if (!raw) return [];
  const roots: string[] = [];
  const dir = path.dirname(shimPath);
  // Resolve the shim's own directory placeholders first (`%dp0%`, `$basedir`),
  // so an npm-style shim names an absolute target.
  const text = raw
    .replace(/%dp0%|%~dp0/gi, dir + path.sep)
    .replace(/\$\{?basedir\}?/gi, dir)
    .replace(/\\/g, "/");
  const marker = `node_modules/${COMMAND_CODE_PACKAGE_NAME}`;
  let from = 0;
  for (;;) {
    const index = text.toLowerCase().indexOf(marker, from);
    if (index < 0) break;
    const end = index + marker.length;
    // Prefer an unmatched opening quote: npm shims commonly quote targets and
    // Windows temp/prefix paths may contain spaces or 8.3 `~` segments. Falling
    // back to token scanning keeps unquoted POSIX/npm shims working.
    const before = text.slice(0, index);
    const lastDouble = before.lastIndexOf('"');
    const lastSingle = before.lastIndexOf("'");
    const quote = Math.max(lastDouble, lastSingle);
    let start = index;
    if (quote >= 0) {
      const q = before[quote];
      const between = before.slice(quote + 1);
      if (q && !between.includes(q)) start = quote + 1;
    }
    if (start === index) {
      while (start > 0 && /[\w.@:/\\~+-]/.test(text[start - 1] ?? "")) start -= 1;
    }
    const token = text.slice(start, end);
    const isAbsolute = token.startsWith("/") || /^[A-Za-z]:\//.test(token);
    const root = isAbsolute ? path.resolve(token) : path.resolve(dir, ...token.split("/").filter(Boolean));
    if (!roots.includes(root)) roots.push(root);
    from = end;
  }
  return roots;
}

/**
 * Discover the installed Command Code package starting from the resolved CLI
 * executable. Returns null when no Command Code package can be proven — this
 * reader never invents a package.
 */
export function discoverCommandCodePackage(cliPath: string): PackageDiscoveryResult | null {
  const raw = typeof cliPath === "string" ? cliPath.trim() : "";
  if (!raw) return null;
  const cliFile = safeRealpath(raw);
  const cliDir = path.dirname(cliFile);
  const rawDir = path.dirname(path.resolve(raw));

  const accept = (root: string, strategy: PackageDiscoveryResult["strategy"]): PackageDiscoveryResult | null => {
    const packageJsonPath = packageRootAt(root, cliFile) ?? packageRootAt(root, path.resolve(raw));
    return packageJsonPath
      ? { packageRoot: safeRealpath(path.resolve(root)), packageJsonPath: safeRealpath(packageJsonPath), strategy }
      : null;
  };

  // 1. The CLI file itself lives inside the package (…/node_modules/command-code/dist/index.mjs).
  for (const dir of [cliDir, rawDir]) {
    for (const ancestor of ancestorsOf(dir)) {
      const found = accept(ancestor, "cli-ancestor");
      if (found) return found;
    }
  }

  // 2. The shim sits in the npm prefix next to the package it launches.
  for (const dir of [rawDir, cliDir]) {
    for (const candidate of nodeModulesCandidates(dir)) {
      const found = accept(candidate, "shim-node-modules");
      if (found) return found;
    }
  }

  // 3. The shim's own text names the package-relative script it launches.
  for (const shim of [raw, cliFile]) {
    for (const candidate of shimReferencedPackageRoots(shim)) {
      const found = accept(candidate, "shim-content");
      if (found) return found;
    }
  }

  // 4. A prefix further up the shim's ancestors (pnpm/nvm-style layouts).
  for (const dir of [rawDir, cliDir]) {
    for (const ancestor of ancestorsOf(dir, 6)) {
      for (const candidate of nodeModulesCandidates(ancestor)) {
        const found = accept(candidate, "ancestor-node-modules");
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Find the installed models reference inside a discovered package root.
 *
 * The stable shipped path is tried first; when a package ships the knowledge
 * base at an unknown depth, a bounded search finds a `models.md` directly inside
 * a `reference` directory (preferring one under `command-code-knowledge`).
 */
export function findInstalledModelsReference(packageRoot: string): string | null {
  for (const relative of INSTALLED_MODELS_REFERENCE_RELATIVE_PATHS) {
    const candidate = path.join(packageRoot, ...relative.split("/"));
    if (statFile(candidate)) return candidate;
  }

  const preferred: string[] = [];
  const others: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: packageRoot, depth: 0 }];
  let seen = 0;
  while (queue.length > 0 && seen < MAX_SEARCH_ENTRIES) {
    const current = queue.shift();
    if (!current) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_SEARCH_ENTRIES) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        if (current.depth + 1 <= MAX_SEARCH_DEPTH) queue.push({ dir: full, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== "models.md") continue;
      if (path.basename(current.dir).toLowerCase() !== "reference") continue;
      const grandparent = path.basename(path.dirname(current.dir)).toLowerCase();
      if (grandparent === "command-code-knowledge") preferred.push(full);
      else others.push(full);
    }
  }
  const candidates = [...preferred, ...others].sort((a, b) => a.length - b.length);
  return candidates[0] ?? null;
}

export interface InstalledModelCatalog {
  /** Ordered ids EXACTLY as the installed package's reference lists them. */
  models: string[];
  /** Ids whose own rate column proves every advertised rate is exactly $0. */
  freeModels: string[];
  /**
   * Ids whose own rate column was parsed successfully. Membership outside
   * `freeModels` proves the row is NOT zero-priced; an id absent here has no
   * parsed price evidence at all (nothing is claimed for it).
   */
  ratedModels: string[];
  /**
   * Per-model REASONING EFFORT levels, read from the reference's own `Efforts`
   * column when it publishes one. Only ids whose cell published at least one
   * real level appear here: a row that publishes `—` (or that has no efforts
   * column at all) is ABSENT — "no published evidence", never "supports
   * nothing". The installed package's own list is what the CLI validates
   * `--effort` against, so this is the per-model evidence a run is checked
   * against before a process starts.
   */
  effortsByModel: Record<string, string[]>;
}

/** One markdown table cell, trimmed. */
function cellsOf(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/** The column index that publishes the per-1M-token rates, from the header row. */
function rateColumnIndex(headerCells: readonly string[]): number {
  for (let i = 0; i < headerCells.length; i += 1) {
    const cell = headerCells[i] ?? "";
    if (cell.includes("$") && /1M/i.test(cell)) return i;
    if (/\bprice\b/i.test(cell) && /cache/i.test(cell)) return i;
  }
  return -1;
}

/** The id column index: the header cell that names the exact id. */
function idColumnIndex(headerCells: readonly string[]): number {
  for (let i = 0; i < headerCells.length; i += 1) {
    if (/^id\b/i.test((headerCells[i] ?? "").trim())) return i;
  }
  return -1;
}

/**
 * The column index that publishes the per-model reasoning effort levels, from
 * the header row (the shipped reference names it `Efforts`). Optional: a
 * reference without the column still yields ids and rates, it just publishes no
 * effort evidence.
 */
function effortsColumnIndex(headerCells: readonly string[]): number {
  for (let i = 0; i < headerCells.length; i += 1) {
    if (/^efforts?\b/i.test((headerCells[i] ?? "").trim())) return i;
  }
  return -1;
}

/**
 * The effort levels one row's `Efforts` cell publishes, or null when it
 * publishes none (blank, `—`, prose). Only the CLI's own real levels are kept:
 * a placeholder or an unknown token is never invented into an option list.
 */
export function effortLevelsFromCell(cell: unknown): string[] | null {
  if (typeof cell !== "string") return null;
  const levels: string[] = [];
  for (const piece of cell.split(",")) {
    const level = normalizeEffort(piece);
    if (level && !levels.includes(level)) levels.push(level);
  }
  return levels.length > 0 ? levels : null;
}

/** Extract a backticked model id from a cell (the reference marks ids this way). */
function idFromCell(cell: string): string | null {
  const match = /^`([^`]+)`$/.exec(cell.trim());
  const value = (match?.[1] ?? "").trim();
  if (!value || !MODEL_TOKEN_RE.test(value)) return null;
  return value;
}

/**
 * Price evidence of one rate cell: every advertised `$` amount is exactly zero
 * (input, output, cache-read and any cache-write). Fewer than two amounts is not
 * evidence at all. Returns null when the cell carries no parseable rate.
 */
function priceEvidence(cell: string): boolean | null {
  const amounts: number[] = [];
  for (const match of cell.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const value = Number(match[1] ?? "");
    if (!Number.isFinite(value)) return null;
    amounts.push(value);
  }
  if (amounts.length < 2) return null;
  return amounts.every((amount) => amount === 0);
}

/**
 * Parse the installed package's models reference (markdown table) into the
 * ordered id list, the rows whose advertised rates are all exactly zero, and the
 * rows that publish their own reasoning effort levels.
 *
 * A header row that publishes the id column AND a per-1M rate column is
 * REQUIRED: without it the price cells have no proven meaning, so the whole
 * parse fails (null) instead of guessing. Data rows are read only after that
 * header, and a row is kept only when its id cell holds a strict backticked id.
 * The `Efforts` column is OPTIONAL and read only when the header names it, so a
 * reference without it simply publishes no per-model effort evidence. Nothing is
 * inferred from an id, a name, a description or a "free" word.
 */
export function parseInstalledModelsReference(raw: unknown): InstalledModelCatalog | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const models: string[] = [];
  const freeModels: string[] = [];
  const ratedModels: string[] = [];
  const effortsByModel: Record<string, string[]> = {};
  let idColumn = -1;
  let rateColumn = -1;
  let effortsColumn = -1;

  for (const line of raw.split(/\r?\n/)) {
    const cells = cellsOf(line);
    if (cells.length === 0) continue;
    if (isSeparatorRow(cells)) continue;
    if (idColumn < 0 || rateColumn < 0) {
      // Still looking for the table header: it must name the id column and a
      // per-1M rate column, otherwise the table is not the models catalog.
      const candidateId = idColumnIndex(cells);
      const candidateRate = rateColumnIndex(cells);
      if (candidateId >= 0 && candidateRate >= 0 && candidateId !== candidateRate) {
        idColumn = candidateId;
        rateColumn = candidateRate;
        const candidateEfforts = effortsColumnIndex(cells);
        effortsColumn = candidateEfforts !== idColumn && candidateEfforts !== rateColumn ? candidateEfforts : -1;
      }
      continue;
    }
    const id = idFromCell(cells[idColumn] ?? "");
    if (!id) continue;
    if (!models.includes(id)) models.push(id);
    if (effortsColumn >= 0) {
      const levels = effortLevelsFromCell(cells[effortsColumn]);
      if (levels && !effortsByModel[id]) effortsByModel[id] = levels;
    }
    const evidence = priceEvidence(cells[rateColumn] ?? "");
    if (evidence === null) continue;
    if (!ratedModels.includes(id)) ratedModels.push(id);
    if (evidence && !freeModels.includes(id)) freeModels.push(id);
  }

  if (models.length === 0) return null;
  return { models, freeModels, ratedModels, effortsByModel };
}

export type InstalledCatalogRead =
  | {
      ok: true;
      packageRoot: string;
      packageJsonPath: string;
      referencePath: string;
      catalog: InstalledModelCatalog;
      /** Bounded verbatim evidence (the parsed reference text). */
      raw: string;
    }
  | {
      ok: false;
      packageRoot: string | null;
      referencePath: string | null;
      error: string;
    };

/**
 * Read the currently installed package's model reference starting from the
 * resolved CLI executable. Pure local I/O: no process, no network, no cache.
 */
export function readInstalledModelCatalog(cliPath: string): InstalledCatalogRead {
  const discovered = discoverCommandCodePackage(cliPath);
  if (!discovered) {
    return {
      ok: false,
      packageRoot: null,
      referencePath: null,
      error: "the installed Command Code package could not be located from the resolved CLI executable"
    };
  }
  const referencePath = findInstalledModelsReference(discovered.packageRoot);
  if (!referencePath) {
    return {
      ok: false,
      packageRoot: discovered.packageRoot,
      referencePath: null,
      error: `the installed Command Code package (${discovered.packageRoot}) ships no readable models reference`
    };
  }
  const raw = readTextFile(referencePath, MAX_REFERENCE_BYTES);
  if (raw === null) {
    return {
      ok: false,
      packageRoot: discovered.packageRoot,
      referencePath,
      error: `the installed models reference could not be read (${referencePath})`
    };
  }
  const catalog = parseInstalledModelsReference(raw);
  if (!catalog) {
    return {
      ok: false,
      packageRoot: discovered.packageRoot,
      referencePath,
      error: `the installed models reference could not be parsed safely (${referencePath}); no model or Free-now claim is made`
    };
  }
  return {
    ok: true,
    packageRoot: discovered.packageRoot,
    packageJsonPath: discovered.packageJsonPath,
    referencePath,
    catalog,
    raw
  };
}
