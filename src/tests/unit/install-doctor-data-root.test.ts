import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectDataRootForDoctor } from "../../install/doctor";

test("doctor reports the macOS fresh/legacy/ambiguous data-root decision truthfully", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-doctor-data-root-"));
  const home = path.join(sandbox, "home");
  const target = path.join(sandbox, "install");
  const preferred = path.join(home, "Library", "Application Support", "JobQuay");
  const legacy = path.join(home, "JobQuay");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(target, { recursive: true });

  try {
    const options = { platform: "darwin" as const, homedir: home };

    const fresh = inspectDataRootForDoctor(target, {}, options);
    assert.equal(fresh.ok, true);
    assert.equal(fresh.source, "macos_application_support");
    assert.equal(fresh.path, preferred);
    assert.equal(fresh.outsideInstallDirectory, true);

    fs.mkdirSync(legacy, { recursive: true });
    const old = inspectDataRootForDoctor(target, {}, options);
    assert.equal(old.ok, true);
    assert.equal(old.source, "macos_legacy");
    assert.equal(old.path, legacy);
    assert.equal(old.preferredExists, false);
    assert.equal(old.legacyExists, true);

    fs.mkdirSync(preferred, { recursive: true });
    const ambiguous = inspectDataRootForDoctor(target, {}, options);
    assert.equal(ambiguous.ok, false);
    assert.equal(ambiguous.source, "ambiguous");
    assert.equal(ambiguous.path, null);
    assert.equal(ambiguous.preferredExists, true);
    assert.equal(ambiguous.legacyExists, true);
    assert.match(String(ambiguous.error), /Refusing to guess, merge, or move data/);

    const chosen = path.join(sandbox, "chosen-root");
    const explicit = inspectDataRootForDoctor(target, { JOBQUAY_DATA_ROOT: chosen }, options);
    assert.equal(explicit.ok, true);
    assert.equal(explicit.source, "jobquay_env");
    assert.equal(explicit.path, chosen);
    assert.equal(explicit.preferredExists, null, "an explicit override does not inspect competing roots");
    assert.equal(explicit.legacyExists, null);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
