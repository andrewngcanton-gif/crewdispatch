#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BUILDER = path.join(ROOT, "scripts", "build-release-candidate.cjs");
const VERIFIER = path.join(ROOT, "scripts", "verify-release-candidate.cjs");
const SCOPE = "command-code+workbuddy-ai";

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 900000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail(options.label || `${executable} ${args.join(" ")} failed`, {
      exitCode: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error ? String(result.error.message || result.error) : null,
      stdoutTail: String(result.stdout || "").slice(-4000),
      stderrTail: String(result.stderr || "").slice(-4000)
    });
  }
  return result;
}

function runJson(executable, args, options = {}) {
  const result = run(executable, args, options);
  const text = String(result.stdout || "").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    fail((options.label || "JSON command") + " returned non-JSON output", {
      parseError: String(error?.message || error),
      stdoutTail: text.slice(-4000)
    });
  }
}

function runNpm(args, options = {}) {
  if (process.platform !== "win32") return run("npm", args, options);

  // Node's child_process cannot reliably execute .cmd shims directly on current
  // Windows runners (spawnSync npm.cmd can fail with EINVAL). Execute npm's own
  // JavaScript entry through the already-verified Node runtime instead of asking
  // cmd.exe to re-parse arguments.
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) {
    fail(options.label || "npm CLI entry is missing", { npmCli, node: process.execPath });
  }
  return run(process.execPath, [npmCli, ...args], options);
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function git(args) {
  return run("git", args, { label: "git " + args.join(" ") }).stdout.trim();
}

function assertClean(label) {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) fail(label + ": working tree is dirty", { dirty: dirty.split(/\r?\n/).slice(0, 50) });
}

function assertReport(report, label) {
  if (!report || typeof report !== "object") fail(label + ": missing report");
  if (report.gitDirty !== false) fail(label + ": candidate report is dirty", { gitDirty: report.gitDirty });
  if (report.providerScope !== SCOPE) fail(label + ": provider scope mismatch", { providerScope: report.providerScope });
  if (report.providersBundled !== false) fail(label + ": providersBundled must be false", { providersBundled: report.providersBundled });
  if (report.candidateMetadataValid !== true) fail(label + ": candidate metadata is not valid", { candidateMetadataValid: report.candidateMetadataValid });
  if (report.releaseEligible !== false || report.publicDistributionApproved !== false) {
    fail(label + ": preparation candidate must not self-approve public release", {
      releaseEligible: report.releaseEligible,
      publicDistributionApproved: report.publicDistributionApproved
    });
  }
  const blockers = Array.isArray(report.releaseBlockers) ? report.releaseBlockers : [];
  if (!blockers.some((value) => String(value).includes("public release acceptance gates are not completed"))) {
    fail(label + ": public release blocker is missing", { blockers });
  }
  if (!report.archive || typeof report.archive.path !== "string" || typeof report.archive.sha256 !== "string") {
    fail(label + ": archive identity is missing", { archive: report.archive });
  }
}

function appendStepSummary(summary) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    "## CrewDispatch exact-artifact clean-room",
    "",
    `- Commit: \`${summary.commit}\``,
    `- Runner: \`${summary.platform}/${summary.arch}\``,
    `- Node: \`${summary.node}\``,
    `- ZIP: \`${summary.archive.name}\``,
    `- SHA-256: \`${summary.archive.sha256}\``,
    `- Bytes: \`${summary.archive.bytes}\``,
    `- Two full builds byte-identical: **${summary.deterministic ? "yes" : "no"}**`,
    `- Installed doctor: **${summary.verifier.doctorStatus}**`,
    `- Installed wrappers checked: **${summary.verifier.wrapperCount}**`,
    `- Authenticated provider checked: **${summary.verifier.providerAuthenticatedChecked}**`,
    `- Gatekeeper checked: **${summary.verifier.gatekeeperChecked}**`,
    `- Fresh OS assumed: **${summary.verifier.cleanOsAssumed}**`,
    ""
  ];
  fs.appendFileSync(file, lines.join("\n"), "utf8");
}

function exportCiEvidence(summary, archivePath) {
  const configured = process.env.CREWDISPATCH_CI_EXPORT_DIR?.trim();
  if (!configured) return;
  const exportDir = path.resolve(configured);
  fs.mkdirSync(exportDir, { recursive: true });
  fs.copyFileSync(archivePath, path.join(exportDir, path.basename(archivePath)));
  fs.writeFileSync(path.join(exportDir, "cleanroom-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
}

function main() {
  if (!["win32", "darwin"].includes(process.platform)) {
    fail("hosted clean-room CI supports Windows and macOS only", { platform: process.platform });
  }

  assertClean("before hosted clean-room run");
  const tempBase = process.env.RUNNER_TEMP ? path.resolve(process.env.RUNNER_TEMP) : fs.realpathSync.native(os.tmpdir());
  const workRoot = fs.mkdtempSync(path.join(tempBase, "crewdispatch-hosted-cleanroom-"));
  const firstDir = path.join(workRoot, "candidate-a");
  const secondDir = path.join(workRoot, "candidate-b");
  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });

  try {
    runNpm(["run", "build"], { label: "first full build" });
    const first = runJson(process.execPath, [BUILDER, "--scope", SCOPE, "--output-dir", firstDir], { label: "first candidate build" });
    assertReport(first, "first candidate");

    assertClean("after first candidate");
    runNpm(["run", "build"], { label: "second full build" });
    const second = runJson(process.execPath, [BUILDER, "--scope", SCOPE, "--output-dir", secondDir], { label: "second candidate build" });
    assertReport(second, "second candidate");
    assertClean("after second candidate");

    const firstArchive = path.resolve(first.archive.path);
    const secondArchive = path.resolve(second.archive.path);
    const firstActualSha = sha256File(firstArchive);
    const secondActualSha = sha256File(secondArchive);
    if (firstActualSha !== first.archive.sha256 || secondActualSha !== second.archive.sha256) {
      fail("candidate report SHA-256 does not match archive bytes", {
        firstReported: first.archive.sha256,
        firstActual: firstActualSha,
        secondReported: second.archive.sha256,
        secondActual: secondActualSha
      });
    }
    if (first.archive.sha256 !== second.archive.sha256) {
      fail("two full builds produced different candidate hashes", {
        first: first.archive.sha256,
        second: second.archive.sha256
      });
    }
    const firstBytes = fs.readFileSync(firstArchive);
    const secondBytes = fs.readFileSync(secondArchive);
    if (!firstBytes.equals(secondBytes)) {
      fail("two full builds produced different candidate bytes despite matching report expectations");
    }

    const verifier = runJson(
      process.execPath,
      [VERIFIER, "--archive", firstArchive, "--sha256", first.archive.sha256],
      { label: "exact candidate clean-room verifier" }
    );
    if (verifier.ok !== true || verifier.doctorStatus !== "healthy") {
      fail("clean-room verifier did not return a healthy result", { verifier });
    }
    if (verifier.providerAuthenticatedChecked !== false || verifier.gatekeeperChecked !== false || verifier.cleanOsAssumed !== false) {
      fail("clean-room verifier overstated evidence", {
        providerAuthenticatedChecked: verifier.providerAuthenticatedChecked,
        gatekeeperChecked: verifier.gatekeeperChecked,
        cleanOsAssumed: verifier.cleanOsAssumed
      });
    }
    const wrapperChecks = Array.isArray(verifier.wrapperChecks) ? verifier.wrapperChecks : [];
    if (wrapperChecks.length !== 2 || !wrapperChecks.every((item) => item && item.checkoutIndependent === true && item.exitCode === 0)) {
      fail("installed wrapper evidence is incomplete", { wrapperChecks });
    }

    const commit = git(["rev-parse", "HEAD"]);
    if (first.gitCommit !== commit || second.gitCommit !== commit) {
      fail("candidate commit identity does not match checkout", { commit, first: first.gitCommit, second: second.gitCommit });
    }

    const summary = {
      ok: true,
      commit,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      deterministic: true,
      providerScope: SCOPE,
      archive: {
        name: path.basename(firstArchive),
        sha256: first.archive.sha256,
        bytes: first.archive.bytes
      },
      candidateMetadataValid: true,
      releaseEligible: false,
      verifier: {
        doctorStatus: verifier.doctorStatus,
        wrapperCount: wrapperChecks.length,
        providerAuthenticatedChecked: false,
        gatekeeperChecked: false,
        cleanOsAssumed: false,
        dataHashPreserved: verifier.dataHashBefore === verifier.dataHashAfter,
        stagingResidueCount: Array.isArray(verifier.stagingResidue) ? verifier.stagingResidue.length : null
      }
    };
    appendStepSummary(summary);
    exportCiEvidence(summary, firstArchive);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        workRoot,
        error: {
          message: String(error?.message || error),
          ...(error?.details && typeof error.details === "object" ? { details: error.details } : {})
        }
      }, null, 2) + "\n"
    );
    process.exitCode = 1;
    return;
  }

  fs.rmSync(workRoot, { recursive: true, force: true });
}

main();
