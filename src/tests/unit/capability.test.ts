// capability.test.ts — unit tests for the PUBLIC capability probe parsers.
//
// Support is discovered from the CLI's own `--help`, never assumed: an effort
// level is only ever sent when the help publishes the option, and a permission
// mode outside the CLI's published list is rejected.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHelpEffortSupport,
  parseHelpPermissionModes,
  findEffortHelpLines,
  normalizeEffort,
  isBlankEffort,
  normalizePermissionMode,
  effectivePermissionMode,
  PERMISSION_MODES,
  EFFORT_LEVELS
} from "../../providers/command-code/capability";

test("effort support requires a real option line with a value placeholder", () => {
  assert.equal(parseHelpEffortSupport("  --effort <level>   Set reasoning effort"), true);
  assert.equal(parseHelpEffortSupport("  --effort [level]   Set reasoning effort"), true);
  assert.equal(parseHelpEffortSupport("  --effort=<level>   Set reasoning effort"), true);
  assert.equal(parseHelpEffortSupport("use the --effort flag to tune"), false); // prose, not an option
  assert.equal(parseHelpEffortSupport("  --effortless mode"), false); // another flag
  assert.equal(parseHelpEffortSupport("  --effort"), false); // no value placeholder
  assert.equal(parseHelpEffortSupport(null), false);
  assert.equal(parseHelpEffortSupport(""), false);
});

test("permission modes come from the CLI's own help line", () => {
  const help = "  --permission-mode <mode>          Set permission mode (standard, plan, accept-edits, yolo)";
  assert.deepEqual(parseHelpPermissionModes(help), ["standard", "plan", "accept-edits", "yolo"]);
  assert.deepEqual(parseHelpPermissionModes("no such option here"), []);
  assert.deepEqual(parseHelpPermissionModes(null), []);
});

test("a published permission list narrows what is accepted, applied to the normalized mode", () => {
  const published = ["standard", "plan", "accept-edits", "yolo"];
  // The documented `default` synonym resolves to the canonical `standard`
  // BEFORE the capability check, and `standard` IS published here.
  assert.equal(normalizePermissionMode("default", published), "standard");
  assert.equal(normalizePermissionMode("plan", published), "plan");
  assert.equal(normalizePermissionMode("PLAN"), "plan"); // documented enum fallback
  assert.equal(normalizePermissionMode("dont-ask"), "dont-ask");
  assert.equal(normalizePermissionMode("nope"), null);
  assert.equal(normalizePermissionMode(undefined), null);
});

test("the canonical public contract includes the installed native standard and normalizes the documented default synonym", () => {
  // The installed CLI's own help publishes `standard`; the canonical contract
  // (used by config validation and as the help-less fallback) must include it
  // so a saved standard round-trips unchanged. `default` is NOT a separate
  // canonical mode: it is the CLI's own name for Standard and normalizes to it.
  assert.ok(PERMISSION_MODES.includes("standard"));
  assert.equal(PERMISSION_MODES.includes("default"), false, "default is a synonym, not a canonical persisted value");
  assert.equal(normalizePermissionMode("standard"), "standard");
  assert.equal(normalizePermissionMode("STANDARD"), "standard");
  assert.equal(normalizePermissionMode("  Default "), "standard", "trim/case behavior applies to the synonym");
  assert.equal(normalizePermissionMode("default"), "standard");
  // The reference-only `dont-ask` token stays known so an already-saved value
  // is never rejected or rewritten; no other alias is invented.
  assert.equal(normalizePermissionMode("dont-ask"), "dont-ask");
  assert.equal(normalizePermissionMode("yolo"), "yolo");
  assert.equal(normalizePermissionMode("accept-edits"), "accept-edits");
  assert.equal(normalizePermissionMode("full-access"), null, "no alias is guessed for another provider's vocabulary");
  assert.equal(normalizePermissionMode("root"), null);

  // A NONEMPTY published list is still the ONLY accepted set, and the check
  // applies to the NORMALIZED mode: a CLI that does not prove `standard`
  // rejects both spellings instead of silently receiving a different mode.
  const published = ["default", "plan", "accept-edits", "yolo", "dont-ask"];
  assert.equal(normalizePermissionMode("standard", published), null);
  assert.equal(normalizePermissionMode("default", published), null);
});

test("an invalid configured mode falls back to the default, which stays accept-edits", () => {
  assert.equal(effectivePermissionMode({ permission_mode: "plan" }), "plan");
  assert.equal(effectivePermissionMode({ permission_mode: "default" }), "standard", "the synonym resolves to the canonical mode");
  assert.equal(effectivePermissionMode({ permission_mode: "nonsense" }), "accept-edits");
  assert.equal(effectivePermissionMode(null), "accept-edits");
});

test("effort normalization is strict and case-insensitive", () => {
  for (const level of EFFORT_LEVELS) assert.equal(normalizeEffort(level.toUpperCase()), level);
  assert.equal(normalizeEffort("ultra"), null);
  assert.equal(normalizeEffort(3), null);
  assert.equal(isBlankEffort(""), true);
  assert.equal(isBlankEffort(null), true);
  assert.equal(isBlankEffort("high"), false);
});

test("help evidence lines are kept verbatim for external review", () => {
  const help = "Options\n  --effort <level>   Set reasoning effort\n  --effortless  nope";
  const lines = findEffortHelpLines(help, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.includes("--effort <level>"));
});
