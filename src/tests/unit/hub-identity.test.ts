// hub-identity.test.ts — the lightweight build identity that makes Hub reuse
// build-aware. These are pure-function tests; the HTTP snapshot semantics are
// pinned in tests/integration/dashboard-build-aware.test.ts.
//
// The contract is deliberately small: one value derived from the served build's
// stat inventory. The package VERSION identifies a release; this build id
// identifies a development rebuild under the same version.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeBuildId, readPackageVersion, resolveHubRoot, snapshotHubBuild } from "../../hub/identity";

function makeTree(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-identity-${name}-`));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function stagedBuild(root: string): void {
  write(path.join(root, "dist", "hub", "server.js"), "// hub server v1\n");
  write(path.join(root, "dist", "ui", "client.js"), "// client v1\n");
  write(path.join(root, "dist", "ui", "page.js"), "// page v1\n");
  write(path.join(root, "dist", "tests", "unit", "sample.test.js"), "// test v1\n");
  write(path.join(root, "package.json"), JSON.stringify({ name: "jobquay", version: "0.0.0-m1" }));
}

test("the build identity is deterministic for unchanged build output", () => {
  const root = makeTree("deterministic");
  try {
    stagedBuild(root);
    const dist = path.join(root, "dist");
    const first = computeBuildId(dist);
    const second = computeBuildId(dist);
    assert.ok(first);
    assert.equal(first, second, "two computations over the same build output must agree");
    assert.match(first, /^[0-9a-z]+-[0-9a-f]{12}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the build identity changes when a served Hub API or UI file changes", () => {
  const root = makeTree("changes");
  try {
    stagedBuild(root);
    const dist = path.join(root, "dist");
    const before = computeBuildId(dist);

    write(path.join(root, "dist", "hub", "server.js"), "// hub server v2\n");
    const afterApi = computeBuildId(dist);
    assert.notEqual(afterApi, before, "a changed Hub API module must change the identity");

    write(path.join(root, "dist", "ui", "client.js"), "// client v2\n");
    const afterClient = computeBuildId(dist);
    assert.notEqual(afterClient, afterApi, "a changed client bundle must change the identity");

    write(path.join(root, "dist", "ui", "page.js"), "// page v2\n");
    assert.notEqual(computeBuildId(dist), afterClient, "a changed UI shell must change the identity");

    // A same-size in-place edit is still a different build.
    const page = path.join(root, "dist", "ui", "page.js");
    const beforeSameSizeEdit = computeBuildId(dist);
    const sameSize = fs.readFileSync(page, "utf8").replace("v2", "v3");
    assert.equal(sameSize.length, fs.readFileSync(page, "utf8").length);
    fs.writeFileSync(page, sameSize, "utf8");
    assert.notEqual(computeBuildId(dist), beforeSameSizeEdit, "even a same-size edit is a different build");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rebuild under the same version yields a new build identity", () => {
  const root = makeTree("rebuild");
  try {
    stagedBuild(root);
    const dist = path.join(root, "dist");
    const before = computeBuildId(dist);

    // A rebuild re-emits the same file: the bytes are identical, the build is not.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, "dist", "ui", "client.js"), future, future);
    const after = computeBuildId(dist);
    assert.notEqual(after, before, "a rebuilt (re-timestamped) file must produce a new build identity");
    assert.equal(computeBuildId(dist), after, "and the new identity is itself deterministic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("the build identity ignores the test build output and a missing build is honest", () => {
  const root = makeTree("tests-excluded");
  try {
    stagedBuild(root);
    const dist = path.join(root, "dist");
    const withTests = computeBuildId(dist);

    write(path.join(root, "dist", "tests", "unit", "sample.test.js"), "// test v2: only tests changed\n");
    write(path.join(root, "dist", "tests", "integration", "other.test.js"), "// another test file\n");
    assert.equal(computeBuildId(dist), withTests, "a test-only rebuild must not force a Hub restart");

    fs.rmSync(path.join(root, "dist", "tests"), { recursive: true, force: true });
    assert.equal(computeBuildId(dist), withTests, "removing the test build changes nothing served");

    assert.equal(computeBuildId(path.join(root, "missing-dist")), null, "an unreadable build reports no identity instead of inventing one");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("snapshotHubBuild bundles exactly the build id and the package version", () => {
  const root = makeTree("snapshot");
  try {
    stagedBuild(root);
    const snapshot = snapshotHubBuild({ root });
    assert.deepEqual(snapshot, {
      buildId: computeBuildId(path.join(root, "dist")),
      version: "0.0.0-m1"
    });
    assert.deepEqual(Object.keys(snapshot).sort(), ["buildId", "version"], "the published identity stays minimal");

    // A root with no build output or package metadata still yields a usable shape.
    const bare = makeTree("bare");
    try {
      assert.deepEqual(snapshotHubBuild({ root: bare }), { buildId: null, version: null });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveHubRoot and readPackageVersion read the build root, not a hardcoded path", () => {
  assert.equal(resolveHubRoot(path.join("C:", "some", "install", "dist", "hub")), path.resolve(path.join("C:", "some", "install")));
  const root = makeTree("version");
  try {
    assert.equal(readPackageVersion(root), null, "a root without package.json reports no version");
    write(path.join(root, "package.json"), JSON.stringify({ version: "  9.9.9-m9  " }));
    assert.equal(readPackageVersion(root), "9.9.9-m9");
    write(path.join(root, "package.json"), "{ not json");
    assert.equal(readPackageVersion(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
