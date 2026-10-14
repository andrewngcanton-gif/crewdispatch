// cc-acp-approval-guard.test.ts — offline coverage of the PURE guard the opt-in
// installed Command Code ACP acceptance uses before auto-answering an approval.
//
// It pins the promised boundary: a decision is allowed ONLY for an `edit` whose
// explicit path resolves to EXACTLY this run's probe file, bound to this exact
// job + generation + provider + request id and offering the provider's own
// allow_once option. Nothing here loads the E2E entry or spends entitlement.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  approvalIsThisRunsProbe,
  type CcAcpApprovalExpectation,
  type CcAcpApprovalVerdict,
  type CcAcpPendingApprovalLike
} from "../helpers/cc-acp-approval-guard";

function assertAllowed(verdict: CcAcpApprovalVerdict): void {
  assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
}

const JOB = "job-guard-0001";
const PROBE_FILE = "jobquay-acp-approval-probe.txt";
const PROJECT = path.resolve(os.tmpdir(), "jobquay-guard-project");
const PROBE = path.join(PROJECT, PROBE_FILE);
const OTHER_INSIDE = path.join(PROJECT, "other.txt");
const OUTSIDE = path.resolve(os.tmpdir(), "jobquay-guard-outside", PROBE_FILE);
const FOREIGN_CWD = path.resolve(os.tmpdir(), "jobquay-guard-other-cwd");

function expected(overrides: Partial<CcAcpApprovalExpectation> = {}): CcAcpApprovalExpectation {
  return {
    jobId: JOB,
    generation: 0,
    provider: "command-code",
    toolKind: "edit",
    probePath: PROBE,
    projectDir: PROJECT,
    optionId: "allow_once",
    platform: process.platform,
    ...overrides
  };
}

function pending(overrides: Partial<CcAcpPendingApprovalLike> = {}): CcAcpPendingApprovalLike {
  return {
    jobId: JOB,
    generation: 0,
    provider: "command-code",
    requestId: "7777",
    toolName: "edit",
    detail: { path: PROBE, title: `Edit: ${PROBE_FILE}`, command: null, cwd: null },
    options: [
      { id: "allow_once", kind: "allow_once" },
      { id: "reject_once", kind: "reject_once" }
    ],
    ...overrides
  };
}

test("the exact expected probe edit is allowed", () => {
  assert.deepEqual(approvalIsThisRunsProbe(pending(), expected()), {
    ok: true,
    reason: "this run's own disposable probe edit, bound to this job+generation+request"
  });
});

test("a relative path that resolves to the probe file is normalized and allowed", () => {
  assertAllowed(approvalIsThisRunsProbe(pending({ detail: { path: PROBE_FILE } }), expected()));
});

test("a conflicting cwd equal to the project directory is allowed", () => {
  assertAllowed(approvalIsThisRunsProbe(pending({ detail: { path: PROBE, cwd: PROJECT } }), expected()));
});

test("an option advertised through the provider's optionId key is accepted", () => {
  assertAllowed(approvalIsThisRunsProbe(pending({ options: [{ optionId: "allow_once" }] }), expected()));
});

const REJECTIONS: Array<{ name: string; pending: CcAcpPendingApprovalLike; expect: RegExp; expected?: Partial<CcAcpApprovalExpectation> }> = [
  {
    name: "a different job",
    pending: pending({ jobId: "job-other" }),
    expect: /is not this job/
  },
  {
    name: "a different generation",
    pending: pending({ generation: 1 }),
    expect: /is not generation 0/
  },
  {
    name: "a different provider",
    pending: pending({ provider: "workbuddy-ai" }),
    expect: /is not command-code/
  },
  {
    name: "a missing request id",
    pending: pending({ requestId: "  " }),
    expect: /no request id/
  },
  {
    name: "a shell/execute operation kind",
    pending: pending({ toolName: "execute" }),
    expect: /is not "edit"/
  },
  {
    name: "a missing explicit path (title-only filename mention)",
    pending: pending({ detail: { path: null, title: `Edit: ${PROBE_FILE}`, description: `write ${PROBE_FILE}` } }),
    expect: /no explicit target path/
  },
  {
    name: "a relative path that resolves to a different inside-tree file",
    pending: pending({ detail: { path: "sub/other.txt" } }),
    expect: /is not this run's probe file/
  },
  {
    name: "a different inside-tree file",
    pending: pending({ detail: { path: OTHER_INSIDE } }),
    expect: /is not this run's probe file/
  },
  {
    name: "an outside path",
    pending: pending({ detail: { path: OUTSIDE } }),
    expect: /is not this run's probe file/
  },
  {
    name: "a command-shaped request naming the probe file",
    pending: pending({ detail: { path: PROBE, command: `echo x > ${PROBE_FILE}` } }),
    expect: /carries a command/
  },
  {
    name: "a conflicting cwd",
    pending: pending({ detail: { path: PROBE, cwd: FOREIGN_CWD } }),
    expect: /conflicts with this run's project directory/
  },
  {
    name: "an approval that does not offer the expected native option",
    pending: pending({ options: [{ id: "reject_once" }, { id: "reject_always" }] }),
    expect: /did not offer its native option "allow_once"/
  }
];

for (const testCase of REJECTIONS) {
  test(`rejects ${testCase.name}`, () => {
    const verdict = approvalIsThisRunsProbe(testCase.pending, expected(testCase.expected));
    assert.equal(verdict.ok, false, `expected rejection: ${JSON.stringify(verdict)}`);
    assert.match(verdict.ok === false ? verdict.reason : "", testCase.expect);
  });
}
