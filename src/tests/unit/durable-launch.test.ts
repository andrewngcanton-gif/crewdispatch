import test from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { spawnDetachedProcess } from "../../runtime/durable-launch";

test("shared detached launch boundary is shell-free, detached, headless and unref'd", () => {
  const capture: { value: { file: string; args: readonly string[]; options: SpawnOptions } | null } = { value: null };
  let unrefs = 0;
  const child = {
    pid: 4242,
    unref: () => {
      unrefs += 1;
      return child;
    }
  } as unknown as ChildProcess;
  const spawnFn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    capture.value = { file, args: [...args], options };
    return child;
  }) as unknown as typeof spawn;

  const env = { TEST_MARKER: "yes" };
  const result = spawnDetachedProcess({
    file: "/opt/node",
    args: ["/app/entry.js", "--root", "/tmp/root"],
    cwd: "/tmp/root",
    env,
    stdio: "ignore",
    spawnFn
  });

  assert.equal(result, child);
  assert.equal(unrefs, 1);
  const captured = capture.value;
  assert.ok(captured);
  assert.equal(captured.file, "/opt/node");
  assert.deepEqual(captured.args, ["/app/entry.js", "--root", "/tmp/root"]);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.windowsHide, true);
  assert.equal(captured.options.shell, undefined, "the launch boundary never introduces a shell");
  assert.equal(captured.options.cwd, "/tmp/root");
  assert.equal(captured.options.env, env);
  assert.equal(captured.options.stdio, "ignore");});
