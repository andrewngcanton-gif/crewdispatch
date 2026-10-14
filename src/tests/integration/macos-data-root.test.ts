import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectDataRootForDoctor } from "../../install/doctor";
import { inspectDataRootResolution, resolveDataRoot, JobStoreError } from "../../jobs/store";

test(
  "native macOS data-root contract chooses fresh/legacy/explicit and refuses ambiguity without migration",
  { skip: process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch) },
  () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-native-data-root-"));
    const home = path.join(sandbox, "home");
    const target = path.join(sandbox, "install");
    const preferred = path.join(home, "Library", "Application Support", "JobQuay");
    const legacy = path.join(home, "JobQuay");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    try {
      const native = { homedir: home };

      const fresh = inspectDataRootResolution(null, {}, native);
      assert.equal(fresh.platform, "darwin");
      assert.equal(fresh.source, "macos_application_support");
      assert.equal(fresh.path, preferred);
      assert.equal(fs.existsSync(preferred), false, "fresh resolution is read-only");

      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, "legacy-sentinel"), "keep\n", "utf8");
      assert.equal(resolveDataRoot(null, {}, native), legacy);
      assert.equal(fs.existsSync(preferred), false, "legacy-only resolution does not migrate");

      fs.mkdirSync(preferred, { recursive: true });
      fs.writeFileSync(path.join(preferred, "fresh-sentinel"), "keep\n", "utf8");
      const ambiguous = inspectDataRootResolution(null, {}, native);
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.source, "ambiguous");
      assert.throws(
        () => resolveDataRoot(null, {}, native),
        (error: unknown) => error instanceof JobStoreError && error.code === "data_root_ambiguous"
      );
      assert.equal(fs.readFileSync(path.join(legacy, "legacy-sentinel"), "utf8"), "keep\n");
      assert.equal(fs.readFileSync(path.join(preferred, "fresh-sentinel"), "utf8"), "keep\n");

      const explicit = path.join(sandbox, "explicit");
      const chosen = inspectDataRootResolution(null, { JOBQUAY_DATA_ROOT: explicit }, native);
      assert.equal(chosen.source, "jobquay_env");
      assert.equal(chosen.path, explicit);
      assert.equal(chosen.preferredExists, null);
      assert.equal(chosen.legacyExists, null);

      const doctor = inspectDataRootForDoctor(target, { JOBQUAY_DATA_ROOT: explicit }, native);
      assert.equal(doctor.ok, true);
      assert.equal(doctor.source, "jobquay_env");
      assert.equal(doctor.path, explicit);
      assert.equal(doctor.outsideInstallDirectory, true);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
);
