// catalog.test.ts — unit tests for the public `--list-models` parser.
//
// Fixtures mirror the real CLI's published shapes (an "Available models · N
// models" header, category headers, `<id><2+ spaces><description>` rows and the
// usage/docs footer). They are parser fixtures, NOT cross-process evidence: the
// real `--list-models` run is `npm.cmd run smoke`.
import test from "node:test";
import assert from "node:assert/strict";
import { parseListModelsCatalog, parseListModelsOutput } from "../../providers/command-code/catalog";

const REAL_SHAPE = [
  "Available models  ·  3 models",
  "",
  "Open Source",
  "",
  "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
  "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
  "inclusionai/ling-3.0-flash-sante:free  FREE cheap multilingual reasoning",
  "",
  "Pass the full id, or just the short name after the last \"/\":",
  "cmdc --model moonshotai/kimi-k2.5",
  "",
  "Docs:  https://commandcode.ai/docs/reference/cli/models",
  "",
  "Decision models (headless only)",
  "typesafe/jev  typed questions in, probabilities out"
].join("\n");

test("parses the columnar listing and the CLI's own (default) marker", () => {
  const c = parseListModelsCatalog(REAL_SHAPE);
  assert.ok(c);
  assert.deepEqual(c?.models, [
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "inclusionai/ling-3.0-flash-sante:free"
  ]);
  assert.equal(c?.defaultModel, "deepseek/deepseek-v4-flash");
  assert.deepEqual(c?.freeModels, ["inclusionai/ling-3.0-flash-sante:free"]);
});

test("FREE is accepted only from the row price/tag column, never from an id or description", () => {
  const c = parseListModelsCatalog([
    "Available models",
    "poolside/laguna-s-2.1-free  paid description",
    "a/b  $0.05/M FREE trial available",
    "stealth/space-bunny-alpha  FREE stealth model"
  ].join("\n"));
  assert.ok(c);
  assert.deepEqual(c.freeModels, ["stealth/space-bunny-alpha"]);
});

test("stops at the footer so the headless-only section is never folded in", () => {
  const c = parseListModelsCatalog(REAL_SHAPE);
  assert.ok(c && !c.models.includes("typesafe/jev"));
  assert.ok(c && !c.models.includes("cmdc"));
});

test("a bare word inside the columnar listing is a category header, not an id", () => {
  const c = parseListModelsCatalog("Available models\n\nOpen Source\n\ndeepseek/deepseek-v4-pro  reasoning");
  assert.ok(c);
  assert.deepEqual(c?.models, ["deepseek/deepseek-v4-pro"]);
});

test("accepts a legacy bare id list and an inline list", () => {
  const bare = parseListModelsCatalog("deepseek/deepseek-v4-flash\nmoonshotai/kimi-k2.5\n");
  assert.deepEqual(bare?.models, ["deepseek/deepseek-v4-flash", "moonshotai/kimi-k2.5"]);

  const inline = parseListModelsCatalog('Currently supported: (a/b, c/d)');
  assert.deepEqual(inline?.models, ["a/b", "c/d"]);
});

test("accepts JSON arrays and objects, honouring an explicit default flag", () => {
  const arr = parseListModelsCatalog('["a/b","c/d"]');
  assert.deepEqual(arr?.models, ["a/b", "c/d"]);

  const objs = parseListModelsCatalog(
    JSON.stringify({ models: [{ id: "a/b" }, { id: "c/d", default: true }, { name: "e/f", description: "the default pick" }] })
  );
  assert.deepEqual(objs?.models, ["a/b", "c/d", "e/f"]);
  assert.equal(objs?.defaultModel, "c/d");
});

test("never invents an id from prose, and returns null when nothing is parseable", () => {
  assert.equal(parseListModelsCatalog(""), null);
  assert.equal(parseListModelsCatalog("   "), null);
  assert.equal(parseListModelsCatalog("not a model catalog at all"), null);
  assert.equal(parseListModelsCatalog("use cmdc --model <id> to pick one"), null);
  assert.equal(parseListModelsOutput("nothing here"), null);
});

test("deduplicates ids while keeping the CLI's own order", () => {
  const c = parseListModelsCatalog(["Available models", "a/b  first", "a/b  again", "c/d  second"].join("\n"));
  assert.deepEqual(c?.models, ["a/b", "c/d"]);
});

test("rejects ids outside the strict token grammar", () => {
  const c = parseListModelsCatalog(["Available models", "bad id  spaced", "good/id  fine"].join("\n"));
  assert.deepEqual(c?.models, ["good/id"]);
});
