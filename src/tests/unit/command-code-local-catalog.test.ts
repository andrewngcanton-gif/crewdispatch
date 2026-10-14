// command-code-local-catalog.test.ts — the installed-package model reference.
//
// Two evidence layers:
//   * a REAL temp filesystem laid out like an npm global install (prefix shim +
//     prefix/node_modules/command-code/…) proves the package discovery is
//     derived from the resolved CLI path and from the local layout only — the
//     module must never know a user name, drive letter or npm prefix;
//   * parser fixtures in the exact shape the installed 1.72.4 package ships
//     prove the id list and the Free evidence ($0/$0 with cache $0) come from
//     the package's own rate column, never from an id/name containing "free".
//
// The parser must fail SAFELY: an unreadable/unparseable reference produces no
// model list and no Free claim at all (never a guess, never an allowlist).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  COMMAND_CODE_PACKAGE_NAME,
  discoverCommandCodePackage,
  findInstalledModelsReference,
  parseInstalledModelsReference,
  readInstalledModelCatalog
} from "../../providers/command-code/local-catalog";
import {
  MODELS_REFERENCE_FIXTURE,
  writeCommandCodeShim,
  writeInstalledCommandCodePackage
} from "../helpers/command-code-package-fixture";

// ---------------------------------------------------------------------------
// Temp npm-global-shaped layouts
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-local-catalog-${prefix}-`));
}

const MODELS_MD = MODELS_REFERENCE_FIXTURE;

/** A package that ships the reference at the stable shipped path. */
function writePackage(prefixDir: string, modelsText: string, options: { referenceRelative?: string } = {}): string {
  return writeInstalledCommandCodePackage(prefixDir, { modelsText, referenceRelative: options.referenceRelative }).packageRoot;
}

/** A Windows npm shim that names the package-relative script it launches. */
function writeNpmShim(prefixDir: string, name = "cmdc.cmd"): string {
  return writeCommandCodeShim(prefixDir, { name: name.replace(/\.cmd$/, "") });
}

// ---------------------------------------------------------------------------
// A — generic package discovery from the resolved CLI executable
// ---------------------------------------------------------------------------

test("package discovery derives the package root from the resolved CLI path only (npm prefix layout)", () => {
  const dir = tmpDir("discover");
  try {
    const prefix = path.join(dir, "some", "npm", "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    const packageRoot = writePackage(prefix, MODELS_MD);
    const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
    const shim = writeNpmShim(prefix);

    const viaShim = discoverCommandCodePackage(shim);
    assert.ok(viaShim, "a shim in an npm prefix discovers the package beside it");
    assert.equal(viaShim?.packageRoot, canonicalPackageRoot);
    assert.equal(viaShim?.packageJsonPath, path.join(canonicalPackageRoot, "package.json"));

    // The same package is discovered when the resolved CLI is the package entry itself.
    const entry = path.join(packageRoot, "dist", "index.mjs");
    const viaEntry = discoverCommandCodePackage(entry);
    assert.ok(viaEntry, "the package entry file discovers its own package root");
    assert.equal(viaEntry?.packageRoot, canonicalPackageRoot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package discovery reads a shim's own launch target and never a fixed prefix", () => {
  const dir = tmpDir("shim-content");
  try {
    // A layout where the package is NOT a sibling of the shim: only the shim's
    // own text names where it launches from.
    const prefix = path.join(dir, "bin with space~1");
    const store = path.join(dir, "store with space~1", "pkgs");
    fs.mkdirSync(prefix, { recursive: true });
    const packageRoot = writePackage(store, MODELS_MD);
    const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
    const target = path.join(store, "node_modules", COMMAND_CODE_PACKAGE_NAME, "dist", "index.mjs");
    const shim = process.platform === "win32" ? path.join(prefix, "cmdc.cmd") : path.join(prefix, "cmdc");
    fs.writeFileSync(
      shim,
      process.platform === "win32"
        ? `@echo off\r\nnode "${target}" %*\r\n`
        : `#!/bin/sh\nexec node "${target}" "$@"\n`,
      "utf8"
    );

    const found = discoverCommandCodePackage(shim);
    assert.ok(found, "the shim's own launch target locates the package");
    assert.equal(found?.packageRoot, canonicalPackageRoot);
    assert.equal(found?.strategy, "shim-content");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("package discovery refuses an unrelated CLI: no package, no invention", () => {
  const dir = tmpDir("unrelated");
  try {
    const cli = path.join(dir, "other-cli.cmd");
    fs.writeFileSync(cli, `@ECHO off\r\nnode "%~dp0other-cli.js" %*\r\n`, "utf8");
    fs.writeFileSync(path.join(dir, "other-cli.js"), "// not command code\n", "utf8");
    // A decoy package that is NOT Command Code.
    const decoy = path.join(dir, "node_modules", "not-command-code");
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, "package.json"), JSON.stringify({ name: "not-command-code" }), "utf8");

    assert.equal(discoverCommandCodePackage(cli), null);
    assert.equal(discoverCommandCodePackage(""), null);
    assert.equal(readInstalledModelCatalog(cli).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped reader contains no user-specific absolute path", () => {
  // The built module must derive everything from its input; a hardcoded user
  // profile / npm prefix would make this test fail.
  const built = path.join(__dirname, "..", "..", "providers", "command-code", "local-catalog.js");
  const source = fs.readFileSync(built, "utf8");
  assert.doesNotMatch(source, /AppData|C:\\\\Users|\/Users\/|Roaming\\?\\?npm/i, "no user profile / npm prefix may be hardcoded");
});

test("the models reference is found at the shipped path and at an equivalent package-local location", () => {
  const dir = tmpDir("reference");
  try {
    const prefix = path.join(dir, "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    const shipped = writePackage(prefix, MODELS_MD);
    assert.equal(
      findInstalledModelsReference(shipped),
      path.join(shipped, "dist", "bundled", "command-code-knowledge", "reference", "models.md")
    );

    // An equivalent package-local layout: a `reference/models.md` under a
    // `command-code-knowledge` directory at a different depth.
    const other = tmpDir("reference-alt");
    try {
      const alt = path.join(other, "node_modules", COMMAND_CODE_PACKAGE_NAME);
      const referencePath = path.join(alt, "lib", "bundled", "command-code-knowledge", "reference", "models.md");
      fs.mkdirSync(path.dirname(referencePath), { recursive: true });
      fs.writeFileSync(referencePath, MODELS_MD, "utf8");
      fs.writeFileSync(path.join(alt, "package.json"), JSON.stringify({ name: COMMAND_CODE_PACKAGE_NAME }), "utf8");
      assert.equal(findInstalledModelsReference(alt), referencePath);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — the parser: ids + Free evidence from the package's own rate column
// ---------------------------------------------------------------------------

test("the shipped table yields the ordered ids and the rows whose advertised rates are exactly $0", () => {
  const catalog = parseInstalledModelsReference(MODELS_MD);
  assert.ok(catalog);
  assert.deepEqual(catalog?.models, [
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4.1-flash",
    "poolside/laguna-s-2.1-free",
    "inclusionai/ling-3.1-flash:free",
    "stealth/space-bunny-alpha",
    "stealth/pixel-canary"
  ]);
  // The two stealth ids contain no "free" substring: only the price column proves them.
  assert.deepEqual(catalog?.freeModels, [
    "poolside/laguna-s-2.1-free",
    "inclusionai/ling-3.1-flash:free",
    "stealth/space-bunny-alpha",
    "stealth/pixel-canary"
  ]);
  assert.equal(catalog?.ratedModels.length, catalog?.models.length);
});

test("Free is never inferred from an id, a name or a description", () => {
  const catalog = parseInstalledModelsReference(
    [
      "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
      "|---|---|---|---|---|---|---|",
      "| `x/paid-but-free-named` | Free Named Paid Model | 1M | high | $0.05/$0.10 · cache $0.01 | Go and above | a FREE-sounding id that is not free |",
      "| `y/zero-write` | Zero Write | 1M | high | $0/$0 · cache $0 (write $2.5) | Go and above | a non-zero cache-write rate is not free |",
      "| `z/really-zero` | Really Zero | 1M | high | $0.00/$0.00 · cache $0.00 | Go and above | advertised rates are exactly zero |",
      "| `w/unknown-price` | Unknown Price | 1M | high | — | Go and above | no rate evidence at all |"
    ].join("\n")
  );
  assert.ok(catalog);
  assert.deepEqual(catalog?.models, ["x/paid-but-free-named", "y/zero-write", "z/really-zero", "w/unknown-price"]);
  assert.deepEqual(catalog?.freeModels, ["z/really-zero"], "only the fully zero-priced row is free");
  assert.deepEqual(
    catalog?.ratedModels,
    ["x/paid-but-free-named", "y/zero-write", "z/really-zero"],
    "the row without a parseable rate carries no price evidence (nothing is claimed for it)"
  );
});

test("an unparseable reference fails safely: no ids, no Free claim", () => {
  assert.equal(parseInstalledModelsReference(""), null);
  assert.equal(parseInstalledModelsReference("   "), null);
  assert.equal(parseInstalledModelsReference("<html><body>not a catalog</body></html>"), null);
  assert.equal(parseInstalledModelsReference("just some prose about models"), null);
  assert.equal(parseInstalledModelsReference(null), null);
  assert.equal(parseInstalledModelsReference(42), null);

  // A table whose header publishes NO rate column cannot prove a price: the
  // whole parse fails instead of guessing Free.
  assert.equal(
    parseInstalledModelsReference(
      ["| Id (use EXACTLY this) | Name |", "|---|---|", "| `a/b` | Some Model |"].join("\n")
    ),
    null
  );
  // Rows before the header are not data rows.
  assert.equal(
    parseInstalledModelsReference(["| `a/b` | Some Model |", "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |"].join("\n")),
    null
  );
});

test("ids outside the strict model-token grammar are never taken from the table", () => {
  const catalog = parseInstalledModelsReference(
    [
      "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
      "|---|---|---|---|---|---|---|",
      "| `bad id with spaces` | Broken | 1M | high | $0/$0 · cache $0 | Go and above | not an id |",
      "| `good/id` | Good | 1M | high | $1/$2 · cache $0.1 | Go and above | fine |"
    ].join("\n")
  );
  assert.ok(catalog);
  assert.deepEqual(catalog?.models, ["good/id"]);
  assert.deepEqual(catalog?.freeModels, []);
});

// ---------------------------------------------------------------------------
// C — the reader: package + reference + catalog, or an honest failure
// ---------------------------------------------------------------------------

test("the installed reader returns the package catalog and its Free evidence", () => {
  const dir = tmpDir("read");
  try {
    const prefix = path.join(dir, "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    const packageRoot = writePackage(prefix, MODELS_MD);
    const canonicalPackageRoot = fs.realpathSync.native(packageRoot);
    const shim = writeNpmShim(prefix);

    const read = readInstalledModelCatalog(shim);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.packageRoot, canonicalPackageRoot);
    assert.match(read.referencePath, /command-code-knowledge[/\\]reference[/\\]models\.md$/);
    assert.ok(read.catalog.models.includes("stealth/space-bunny-alpha"));
    assert.ok(read.catalog.freeModels.includes("stealth/pixel-canary"), "an id without 'free' is free by price evidence");
    assert.ok(read.raw.includes("stealth/pixel-canary"), "the verbatim reference text is kept as evidence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable or unparseable installed reference fails honestly", () => {
  const dir = tmpDir("unparseable");
  try {
    const prefix = path.join(dir, "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    writePackage(prefix, "this is not the models table at all\n");
    const shim = writeNpmShim(prefix);
    const read = readInstalledModelCatalog(shim);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.match(read.error, /could not be parsed safely/);
    assert.ok(read.packageRoot, "the discovered package is still reported for diagnostics");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const missing = tmpDir("missing");
  try {
    const prefix = path.join(missing, "prefix");
    fs.mkdirSync(prefix, { recursive: true });
    // A Command Code package that ships no reference at all.
    const root = path.join(prefix, "node_modules", COMMAND_CODE_PACKAGE_NAME);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: COMMAND_CODE_PACKAGE_NAME }), "utf8");
    const shim = writeNpmShim(prefix);
    const read = readInstalledModelCatalog(shim);
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.match(read.error, /no readable models reference/);
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D — the per-model `Efforts` column
// ---------------------------------------------------------------------------
//
// `--effort` is NOT a global enum: the installed package's reference publishes
// each model's own levels. These tests pin that evidence to the model's OWN row,
// so a run can be refused for a level the selected model does not publish.

test("the shipped reference publishes deepseek/deepseek-v4.1-flash's own efforts (low, high, max — no xhigh)", () => {
  const catalog = parseInstalledModelsReference(MODELS_MD);
  assert.ok(catalog);
  assert.deepEqual(catalog?.effortsByModel["deepseek/deepseek-v4.1-flash"], ["low", "high", "max"]);
  assert.ok(
    !catalog?.effortsByModel["deepseek/deepseek-v4.1-flash"]?.includes("xhigh"),
    "xhigh is not one of this model's published levels"
  );
  // A neighbouring row publishes a DIFFERENT list: the evidence is per model.
  assert.deepEqual(catalog?.effortsByModel["stealth/pixel-canary"], ["low", "medium", "xhigh"]);
  assert.deepEqual(catalog?.effortsByModel["deepseek/deepseek-v4-pro"], ["high", "max"]);
});

test("a row that publishes no efforts carries no effort evidence (never an empty claim)", () => {
  const catalog = parseInstalledModelsReference(MODELS_MD);
  assert.ok(catalog);
  // `—` in the Efforts column means the reference publishes no list for that
  // row: it is ABSENT from the map ("unknown"), not present-but-empty.
  assert.equal(catalog?.effortsByModel["poolside/laguna-s-2.1-free"], undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(catalog?.effortsByModel ?? {}, "poolside/laguna-s-2.1-free"));
});

test("a reference without an Efforts column still yields ids and rates, with no effort evidence", () => {
  const catalog = parseInstalledModelsReference(
    [
      "| Id (use EXACTLY this) | Name | $/1M in/out · cache read |",
      "|---|---|---|",
      "| `a/b` | Some Model | $1/$2 · cache $0.1 |"
    ].join("\n")
  );
  assert.ok(catalog, "the id + rate header is still sufficient");
  assert.deepEqual(catalog?.models, ["a/b"]);
  assert.deepEqual(catalog?.effortsByModel, {});
});

test("effort cells are read only as the CLI's own levels, per row", () => {
  const catalog = parseInstalledModelsReference(
    [
      "| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |",
      "|---|---|---|---|---|---|---|",
      "| `a/one` | One | 1M | LOW, High , max | $1/$2 · cache $0.1 | Go and above | mixed case is normalized |",
      "| `b/two` | Two | 1M | turbo, high | $1/$2 · cache $0.1 | Go and above | unknown tokens are never invented into a level |",
      "| `c/three` | Three | 1M | prose about efforts | $1/$2 · cache $0.1 | Go and above | prose publishes nothing |",
      "| `d/four` | Four | 1M | low, low, high | $1/$2 · cache $0.1 | Go and above | duplicates collapse |"
    ].join("\n")
  );
  assert.ok(catalog);
  assert.deepEqual(catalog?.effortsByModel["a/one"], ["low", "high", "max"]);
  assert.deepEqual(catalog?.effortsByModel["b/two"], ["high"], "only real levels survive");
  assert.equal(catalog?.effortsByModel["c/three"], undefined);
  assert.deepEqual(catalog?.effortsByModel["d/four"], ["low", "high"]);
});
