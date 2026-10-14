// failure-evidence.test.ts — regression for the TEST-ONLY failure-evidence helper.
//
// This suite does NOT assert that either original unknown production bug is
// fixed. It asserts the EVIDENCE-RETENTION contract: a real separate-process
// MCP/daemon/provider-fixture/callback run that then fails (body + cleanup)
// leaves a bounded artifact, outside the deleted workspace, that contains the
// real generation/state/callback evidence and BOTH original error markers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createFailureEvidence, runCleanupSteps, runWithFailureEvidence } from "../helpers/failure-evidence";
import {
  BOUNDARY_ARTIFACT_LINE,
  BOUNDARY_BODY_MARKER,
  BOUNDARY_CLEANUP_MARKER,
  BOUNDARY_SOURCE_DELETED_LINE,
  BOUNDARY_SOURCE_DIR_LINE
} from "./failure-evidence-boundary-child";

const DRIVER = path.join(__dirname, "failure-evidence-boundary-child.js");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function extractLine(text: string, prefix: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

test(
  "the failure-evidence helper retains real separate-process MCP/daemon/callback evidence across an intentional body+cleanup failure",
  { timeout: 120000 },
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-failure-evidence-test-"));
    let artifactDir: string | null = null;
    try {
      const run = await runNode([DRIVER], { ...process.env, JOBQUAY_FAILURE_EVIDENCE_ARTIFACT_BASE: base });
      assert.notEqual(run.code, 0, `the boundary child must exit non-zero: ${run.stderr}`);
      assert.ok(run.stderr.includes(BOUNDARY_BODY_MARKER), `the primary body error must be reported: ${run.stderr}`);
      assert.ok(run.stderr.includes(BOUNDARY_CLEANUP_MARKER), `the cleanup error must be reported: ${run.stderr}`);

      artifactDir = extractLine(run.stderr, BOUNDARY_ARTIFACT_LINE);
      assert.ok(artifactDir, `the artifact path must be printed: ${run.stderr}`);
      const sourceDir = extractLine(run.stderr, BOUNDARY_SOURCE_DIR_LINE);
      assert.ok(sourceDir, `the source dir must be printed: ${run.stderr}`);
      const sourceDeleted = extractLine(run.stderr, BOUNDARY_SOURCE_DELETED_LINE);
      assert.equal(sourceDeleted, "true", "the driver must have deleted its source workspace");
      assert.equal(fs.existsSync(sourceDir!), false, "the source workspace was deleted by teardown");
      assert.equal(fs.existsSync(artifactDir!), true, "the artifact must survive deletion of the source fixture directory");

      const payload = JSON.parse(fs.readFileSync(path.join(artifactDir!, "evidence.json"), "utf8")) as {
        phases: Array<{ phase: string; durable: { jobs: Array<Record<string, unknown>>; notifyResults: Array<Record<string, unknown>> }; extra: { callbackCount?: number; callbackBodies?: string[] } }>;
        primaryError: { stack: string | null } | null;
        cleanupError: { stack: string | null } | null;
      };
      const phase = payload.phases.find((p) => p.phase === "body-error-before-teardown") ?? payload.phases[payload.phases.length - 1];
      assert.ok(phase, "at least one pre-teardown phase was retained");

      // Real durable generation/state evidence.
      assert.ok(phase.durable.jobs.length >= 1, "a durable job record was retained");
      const job = phase.durable.jobs[0]!;
      assert.equal(job.status, "done", "the real job reached its terminal state");
      assert.equal(typeof job.generation, "number", "the generation was retained");
      assert.equal(job.childPid, null, "the finished job records no retained child");

      // Real terminal-wake evidence.
      assert.ok(phase.durable.notifyResults.length >= 1, "the terminal wake result was retained");
      assert.equal(phase.durable.notifyResults[0]!.delivered, true, "the wake was delivered to the loopback listener");

      // Real callback evidence (A-shape).
      assert.ok((phase.extra.callbackCount ?? 0) >= 1, "the real callback body count was retained");
      assert.ok((phase.extra.callbackBodies ?? []).length >= 1, "the real callback body was retained");

      // Both original errors, with stacks.
      assert.ok(payload.primaryError?.stack?.includes(BOUNDARY_BODY_MARKER), "the primary error stack is retained");
      assert.ok(payload.cleanupError?.stack?.includes(BOUNDARY_CLEANUP_MARKER), "the cleanup error stack is retained");
    } finally {
      if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
);

test("a diagnostic-write failure is secondary and never hides the original body/cleanup failure", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-failure-evidence-writefail-"));
  try {
    const evidence = createFailureEvidence({
      name: "write-failure",
      dataRoot: path.join(base, "root"),
      workspaceDir: path.join(base, "ws"),
      artifactBaseDir: path.join(base, "artifacts"),
      writeArtifactFn: () => {
        throw new Error("INTENTIONAL_DIAGNOSTIC_WRITE_FAILURE_MARKER");
      }
    });
    let caught: unknown;
    try {
      await runWithFailureEvidence(
        evidence,
        async () => {
          throw new Error("PRIMARY_BODY_FAILURE_MARKER");
        },
        async () => {
          throw new Error("CLEANUP_FAILURE_MARKER");
        }
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof AggregateError, `both errors must be combined: ${String(caught)}`);
    const message = (caught as Error).message;
    assert.ok(message.includes("PRIMARY_BODY_FAILURE_MARKER"), `the primary marker survives: ${message}`);
    assert.ok(message.includes("CLEANUP_FAILURE_MARKER"), `the cleanup marker survives: ${message}`);
    const members = (caught as AggregateError).errors as unknown[];
    assert.ok(
      members.some((e) => String((e as Error)?.message ?? e).includes("INTENTIONAL_DIAGNOSTIC_WRITE_FAILURE_MARKER")),
      "the write failure is attached as a secondary member"
    );
    assert.equal(fs.existsSync(path.join(base, "artifacts")), false, "no artifact directory is created when the writer fails");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a passing run leaves no persistent failure-evidence artifact", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-failure-evidence-pass-"));
  try {
    const artifactBase = path.join(base, "artifacts");
    const evidence = createFailureEvidence({
      name: "passing",
      dataRoot: path.join(base, "root"),
      workspaceDir: path.join(base, "ws"),
      artifactBaseDir: artifactBase
    });
    let ran = false;
    const out = await runWithFailureEvidence(
      evidence,
      async () => {
        ran = true;
        return 42;
      },
      async () => {
        /* no cleanup failure */
      }
    );
    assert.equal(out, 42, "the body result is returned unchanged");
    assert.equal(ran, true, "the body ran");
    assert.equal(fs.existsSync(artifactBase), false, "a passing run creates no artifact directory");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("runCleanupSteps attempts EVERY step after a failing first step and preserves all cleanup errors", async () => {
  const ran: string[] = [];
  let caught: unknown;
  try {
    await runCleanupSteps([
      { name: "step-1", run: () => { ran.push("1"); throw new Error("STEP_ONE_FAILURE_MARKER"); } },
      { name: "step-2", run: () => { ran.push("2"); } },
      { name: "step-3", run: () => { ran.push("3"); throw new Error("STEP_THREE_FAILURE_MARKER"); } },
      { name: "step-4", run: () => { ran.push("4"); } }
    ]);
  } catch (e) {
    caught = e;
  }
  assert.deepEqual(ran, ["1", "2", "3", "4"], "every step ran despite the failing first step");
  assert.ok(caught instanceof AggregateError, `all cleanup errors are combined: ${String(caught)}`);
  const message = (caught as Error).message;
  assert.ok(message.includes("STEP_ONE_FAILURE_MARKER"), `the first error survives: ${message}`);
  assert.ok(message.includes("STEP_THREE_FAILURE_MARKER"), `the later error survives: ${message}`);
  assert.ok(message.includes("step-1") && message.includes("step-3"), "the failing steps are named");
  assert.equal((caught as AggregateError).errors.length, 2, "exactly the two failing steps are collected");
});

test("a failing first cleanup step cannot skip later cleanup; the body and every cleanup error survive, and a diagnostic-write failure stays secondary", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-failure-evidence-cleanup-"));
  try {
    const ran: string[] = [];
    const evidence = createFailureEvidence({
      name: "cleanup-steps-regression",
      dataRoot: path.join(base, "root"),
      workspaceDir: path.join(base, "ws"),
      artifactBaseDir: path.join(base, "artifacts"),
      writeArtifactFn: () => {
        throw new Error("INTENTIONAL_DIAGNOSTIC_WRITE_FAILURE_MARKER");
      }
    });
    let caught: unknown;
    try {
      await runWithFailureEvidence(
        evidence,
        async () => {
          throw new Error("PRIMARY_BODY_FAILURE_MARKER");
        },
        async () => {
          await runCleanupSteps([
            { name: "cleanup-1", run: () => { ran.push("1"); throw new Error("CLEANUP_ONE_FAILURE_MARKER"); } },
            { name: "cleanup-2", run: () => { ran.push("2"); } },
            { name: "cleanup-3", run: () => { ran.push("3"); throw new Error("CLEANUP_THREE_FAILURE_MARKER"); } }
          ]);
        }
      );
    } catch (e) {
      caught = e;
    }
    assert.deepEqual(ran, ["1", "2", "3"], "the failing first cleanup step did NOT skip the later cleanup steps");
    assert.ok(caught instanceof AggregateError, `all failures are combined: ${String(caught)}`);
    const message = (caught as Error).message;
    assert.ok(message.includes("PRIMARY_BODY_FAILURE_MARKER"), `the original body error survives: ${message}`);
    assert.ok(message.includes("CLEANUP_ONE_FAILURE_MARKER"), `the first cleanup error survives: ${message}`);
    assert.ok(message.includes("CLEANUP_THREE_FAILURE_MARKER"), `the later cleanup error survives: ${message}`);

    const members = (caught as AggregateError).errors as unknown[];
    const cleanupAggregate = members.find((m) => m instanceof AggregateError) as AggregateError | undefined;
    assert.ok(cleanupAggregate, "the collected cleanup errors are attached as a nested AggregateError");
    assert.equal(cleanupAggregate!.errors.length, 2, "both cleanup errors are preserved");
    assert.ok(
      members.some((m) => String((m as Error)?.message ?? m).includes("INTENTIONAL_DIAGNOSTIC_WRITE_FAILURE_MARKER")),
      "the diagnostic-write failure is attached as a secondary member and never hides the original failures"
    );
    assert.equal(fs.existsSync(path.join(base, "artifacts")), false, "the failed writer created no artifact directory");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
