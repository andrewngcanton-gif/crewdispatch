// jobs-generation.test.ts — generation-scoped registry and terminal uniqueness.
import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { canFinalize, createGenerationRegistry, isCurrentGeneration, makeOwnerId, ownerPidOf } from "../../jobs/generation";
import { createJobRecord } from "../../jobs/service";
import type { JobRecord } from "../../jobs/types";

function fakeChild(exitCode: number | null = null): ChildProcess {
  return { exitCode, signalCode: null } as unknown as ChildProcess;
}

test("a stale generation's unregister never drops a newer child handle", () => {
  const reg = createGenerationRegistry();
  reg.register("job-1", 0, fakeChild());
  reg.register("job-1", 1, fakeChild());
  reg.unregister("job-1", 0); // the OLD attempt finishes late
  assert.equal(reg.currentGeneration("job-1"), 1);
  assert.equal(reg.hasLiveChild("job-1"), true);
  assert.equal(reg.hasLiveChild("job-1", 1), true);
  assert.equal(reg.hasLiveChild("job-1", 0), false);
  reg.unregister("job-1", 1);
  assert.equal(reg.hasLiveChild("job-1"), false);
});

test("hasLiveChild is false once the child has exited", () => {
  const reg = createGenerationRegistry();
  reg.register("job-2", 3, fakeChild(0));
  assert.equal(reg.hasLiveChild("job-2", 3), false);
});

test("isCurrentGeneration: null/undefined is legacy-current, mismatches are not", () => {
  assert.equal(isCurrentGeneration({ generation: 5 }, null), true);
  assert.equal(isCurrentGeneration({ generation: 5 }, undefined), true);
  assert.equal(isCurrentGeneration({ generation: 5 }, 5), true);
  assert.equal(isCurrentGeneration({ generation: 5 }, 4), false);
});

test("canFinalize: only the current generation of a non-terminal job may write terminal", () => {
  const job = createJobRecord({ task: "t", cwd: process.cwd() });
  job.generation = 2;
  assert.equal(canFinalize(job, 2), true);
  assert.equal(canFinalize(job, 1), false, "a superseded generation must not finalise");
  const terminal = { ...job, status: "done" as JobRecord["status"] };
  assert.equal(canFinalize(terminal, 2), false, "a terminal job must never be re-finalised");
});

test("owner id encodes the PID and parses back", () => {
  const id = makeOwnerId(4321, 1_700_000_000_000);
  assert.match(id, /^jobquay-4321-/);
  assert.equal(ownerPidOf(id), 4321);
  assert.equal(ownerPidOf("nonsense"), null);
  assert.equal(ownerPidOf(null), null);
});

test("terminal uniqueness: the first terminal write wins across generations", () => {
  // Model the service's finalize predicate directly: an old generation arriving
  // after the current one already terminated changes nothing.
  const job = createJobRecord({ task: "t", cwd: process.cwd() });
  job.generation = 1;
  job.status = "done";
  assert.equal(canFinalize(job, 1), false);
  assert.equal(canFinalize(job, 0), false);
});
