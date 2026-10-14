// argv.test.ts — targeted unit tests for the Command Code argv builder.
//
// These are UNIT tests: they exercise the pure argv builder. Cross-process
// acceptance lives in tests/integration and in the real-entry commands
// (npm.cmd run smoke / test:e2e:command-code).
import test from "node:test";
import assert from "node:assert/strict";
import { buildCommandCodeArgv, MODEL_TOKEN_RE, SESSION_TOKEN_RE } from "../../providers/command-code/argv";
import { EFFORT_LEVELS } from "../../providers/command-code/capability";

const MODEL = "deepseek/deepseek-v4-flash";

test("builds the fixed official flag set with the validated model and mode", () => {
  const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "accept-edits" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.argv, [
    "-p",
    "--output-format",
    "json",
    "--model",
    MODEL,
    "--permission-mode",
    "accept-edits",
    "--skip-onboarding"
  ]);
});

test("normalizes a permission mode case-insensitively", () => {
  const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "  PLAN " });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.argv.includes("plan"));
});

test("YOLO emits the dedicated print-mode bypass in addition to --permission-mode yolo", () => {
  const r = buildCommandCodeArgv({
    model: MODEL,
    permissionMode: "YOLO",
    publishedPermissionModes: ["standard", "plan", "accept-edits", "yolo"]
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.argv[r.argv.indexOf("--permission-mode") + 1], "yolo");
  assert.equal(r.argv.filter((arg) => arg === "--yolo").length, 1);
  assert.ok(r.argv.indexOf("--yolo") > r.argv.indexOf("--permission-mode"));
});

test("non-YOLO modes never receive the dangerous bypass flag", () => {
  for (const mode of ["standard", "plan", "accept-edits"]) {
    const r = buildCommandCodeArgv({
      model: MODEL,
      permissionMode: mode,
      publishedPermissionModes: ["standard", "plan", "accept-edits", "yolo"]
    });
    assert.equal(r.ok, true);
    assert.ok(r.ok && !r.argv.includes("--yolo"), mode);
  }
});

test("rejects an invalid model id instead of interpolating it", () => {
  for (const bad of ["", "   ", "bad model", "a;b", "a|b", "a$(x)", "a`b", "--model", "-x"]) {
    const r = buildCommandCodeArgv({ model: bad, permissionMode: "plan" });
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.ok(!r.ok && r.error.includes("invalid model id"));
  }
});

test("accepts namespaced ids and one trailing :segment", () => {
  assert.ok(MODEL_TOKEN_RE.test("deepseek/deepseek-v4-flash"));
  assert.ok(MODEL_TOKEN_RE.test("inclusionai/ling-3.0-flash-sante:free"));
  assert.ok(!MODEL_TOKEN_RE.test("a/b:free:x"));
  assert.ok(!MODEL_TOKEN_RE.test("/leading"));
});

test("accepts the documented default synonym as standard, using the CLI-published list when given", () => {
  const published = ["standard", "plan", "accept-edits", "yolo"];
  // The exact input token `default` is the CLI's own name for Standard: it is
  // normalized to the canonical `standard` BEFORE the published-list check, so
  // it launches standard approval behavior and never gains the yolo bypass.
  const synonym = buildCommandCodeArgv({ model: MODEL, permissionMode: "default", publishedPermissionModes: published });
  assert.equal(synonym.ok, true);
  assert.ok(synonym.ok && synonym.argv[synonym.argv.indexOf("--permission-mode") + 1] === "standard");
  assert.ok(synonym.ok && !synonym.argv.includes("--yolo"));

  // Trim/case behavior applies to the synonym exactly as to a canonical value.
  const spaced = buildCommandCodeArgv({ model: MODEL, permissionMode: " DEFAULT ", publishedPermissionModes: published });
  assert.equal(spaced.ok, true);
  assert.ok(spaced.ok && spaced.argv[spaced.argv.indexOf("--permission-mode") + 1] === "standard");

  // The installed CLI's own native standard stays `standard` — it is never
  // mapped to another mode.
  const ok = buildCommandCodeArgv({ model: MODEL, permissionMode: "standard", publishedPermissionModes: published });
  assert.equal(ok.ok, true);
  assert.ok(ok.ok && ok.argv[ok.argv.indexOf("--permission-mode") + 1] === "standard");

  // An unsupported mode still fails closed, naming the published valid values
  // and the one documented synonym.
  const bad = buildCommandCodeArgv({ model: MODEL, permissionMode: "root", publishedPermissionModes: published });
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.error.includes("standard, plan, accept-edits, yolo"));
  assert.ok(!bad.ok && bad.error.includes('"default" is accepted as a synonym for "standard"'));

  // The published list stays authoritative for the NORMALIZED mode: a CLI whose
  // own help does NOT prove `standard` must reject BOTH spellings instead of
  // silently receiving a different permission.
  const unpublished = buildCommandCodeArgv({
    model: MODEL,
    permissionMode: "standard",
    publishedPermissionModes: ["default", "plan", "accept-edits", "yolo", "dont-ask"]
  });
  assert.equal(unpublished.ok, false);
  assert.ok(!unpublished.ok && unpublished.error.includes("invalid permission mode"));
  const unpublishedSynonym = buildCommandCodeArgv({
    model: MODEL,
    permissionMode: "default",
    publishedPermissionModes: ["default", "plan", "accept-edits", "yolo", "dont-ask"]
  });
  assert.equal(unpublishedSynonym.ok, false);

  // With NO published list (the CLI help could not be read) the canonical
  // contract applies and standard is passed through unchanged.
  const fallback = buildCommandCodeArgv({ model: MODEL, permissionMode: "standard" });
  assert.equal(fallback.ok, true);
  assert.ok(fallback.ok && fallback.argv[fallback.argv.indexOf("--permission-mode") + 1] === "standard");
});

test("emits --effort exactly once, only when the CLI published the flag", () => {
  const supported = buildCommandCodeArgv({
    model: MODEL,
    permissionMode: "plan",
    effort: "HIGH",
    effortSupported: true
  });
  assert.equal(supported.ok, true);
  assert.ok(supported.ok);
  assert.equal(supported.argv.filter((a) => a === "--effort").length, 1);
  assert.equal(supported.argv[supported.argv.indexOf("--effort") + 1], "high");

  const notSupported = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan", effort: "high", effortSupported: false });
  assert.equal(notSupported.ok, false);
  assert.ok(!notSupported.ok && notSupported.error.includes("--effort"));

  const unknown = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan", effort: "ultra", effortSupported: true });
  assert.equal(unknown.ok, false);
  assert.ok(!unknown.ok && unknown.error.includes(EFFORT_LEVELS.join(", ")));
});

test("omits --effort entirely when no level is requested (CLI/model default)", () => {
  for (const blank of [null, undefined, ""]) {
    const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan", effort: blank, effortSupported: true });
    assert.equal(r.ok, true);
    assert.ok(r.ok && !r.argv.includes("--effort"));
  }
});

test("validates the --resume session id and appends it last", () => {
  const ok = buildCommandCodeArgv({
    model: MODEL,
    permissionMode: "plan",
    resumeSessionId: "a1b2c3d4-1111-2222-3333-444455556666"
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.ok);
  assert.deepEqual(ok.argv.slice(-2), ["--resume", "a1b2c3d4-1111-2222-3333-444455556666"]);

  for (const bad of ["has space", "id;rm", "id\nmore", ""]) {
    if (bad === "") {
      const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan", resumeSessionId: bad });
      assert.equal(r.ok, true);
      assert.ok(r.ok && !r.argv.includes("--resume"));
      continue;
    }
    const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan", resumeSessionId: bad });
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.ok(!SESSION_TOKEN_RE.test("id;rm"));
});

test("never puts the prompt or cwd into the argv and never sets --max-turns", () => {
  const r = buildCommandCodeArgv({ model: MODEL, permissionMode: "plan" });
  assert.ok(r.ok);
  assert.ok(!r.argv.some((a) => a.includes("\n") || a.includes("\r")));
  assert.ok(!r.argv.includes("--max-turns"));
});
