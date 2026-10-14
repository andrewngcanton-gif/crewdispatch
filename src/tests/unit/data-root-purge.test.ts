import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InstallError, purgeDataRoot, validateDataRootForPurge } from "../../install/manager";

test("complete-uninstall data purge removes only a dedicated CrewDispatch data root", () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-data-purge-"));
  const dataRoot = path.join(temp, "JobQuay");
  const target = path.join(temp, "runtime");
  fs.mkdirSync(path.join(dataRoot, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, "jobs", "one.json"), "{}\n");
  fs.mkdirSync(target);
  try {
    assert.equal(validateDataRootForPurge(dataRoot, target), path.resolve(dataRoot));
    assert.deepEqual(purgeDataRoot(dataRoot, target), { path: path.resolve(dataRoot), removed: true, alreadyAbsent: false });
    assert.equal(fs.existsSync(dataRoot), false);
    assert.deepEqual(purgeDataRoot(dataRoot, target), { path: path.resolve(dataRoot), removed: false, alreadyAbsent: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("complete-uninstall refuses recursive purge of a non-dedicated arbitrary directory", () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-data-purge-refuse-"));
  const arbitrary = path.join(temp, "Documents");
  fs.mkdirSync(arbitrary);
  fs.writeFileSync(path.join(arbitrary, "keep.txt"), "keep\n");
  try {
    assert.throws(
      () => validateDataRootForPurge(arbitrary, path.join(temp, "runtime")),
      (error: unknown) => error instanceof InstallError && error.code === "data_root_not_dedicated"
    );
    assert.equal(fs.readFileSync(path.join(arbitrary, "keep.txt"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("complete-uninstall refuses a data root overlapping the installation", () => {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "crewdispatch-data-purge-overlap-"));
  const target = path.join(temp, "CrewDispatch");
  const dataRoot = path.join(target, "JobQuay");
  fs.mkdirSync(dataRoot, { recursive: true });
  try {
    assert.throws(
      () => validateDataRootForPurge(dataRoot, target),
      (error: unknown) => error instanceof InstallError && error.code === "data_root_inside_install"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
