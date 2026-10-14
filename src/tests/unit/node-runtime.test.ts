import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REQUIRED_NODE_MAJOR, probeNodeRuntimePath, resolveUserNodeRuntime } from "../../install/node-runtime";

test("CrewDispatch resolves a user-managed Node runtime from PATH and requires Node 22+", () => {
  const runtime = resolveUserNodeRuntime();
  assert.ok(runtime, "the test environment must expose node on PATH");
  assert.equal(path.isAbsolute(runtime.path), true);
  assert.equal(fs.existsSync(runtime.path), true);
  assert.ok(runtime.major >= REQUIRED_NODE_MAJOR, `expected Node >=${REQUIRED_NODE_MAJOR}, got ${runtime.version}`);
  assert.deepEqual(probeNodeRuntimePath(runtime.path), runtime);
});

test("CrewDispatch does not fall back to its own process when PATH has no Node", () => {
  const runtime = resolveUserNodeRuntime({ ...process.env, PATH: "" });
  assert.equal(runtime, null);
});
