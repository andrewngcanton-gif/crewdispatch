// Hub interactive provider approval endpoints — JQ-20261001-26.
//
// The Hub is the only interactive surface that can answer a running provider's
// approval request. These tests pin the provider-neutral read/resolve contract:
// a bounded display-safe pending object, first-write-wins resolution (two tabs
// or duplicate POSTs can never resolve the same request twice), stable
// already-resolved/stale answers, same-origin writes and zero raw provider
// payload leakage.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle } from "../../hub/server";
import { createJobRecord } from "../../jobs/service";
import { loadJob, saveJob } from "../../jobs/store";
import {
  approvalDecisionPath,
  readApprovalDecision,
  type PendingApproval
} from "../../jobs/approval";

function newRoot(prefix: string): { dir: string; root: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-hub-approval-${prefix}-`));
  return { dir, root: path.join(dir, "root") };
}

async function startTestHub(root: string): Promise<{ hub: HubHandle; url: string }> {
  const hub = startHub({ root, host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("listening", () => resolve());
    hub.server.once("error", reject);
  });
  return { hub, url: `http://127.0.0.1:${hub.port}` };
}

async function closeHub(hub: HubHandle): Promise<void> {
  hub.server.closeAllConnections?.();
  await new Promise<void>((resolve) => hub.server.close(() => resolve()));
}

function pendingFor(jobId: string, generation: number): PendingApproval {
  const now = Date.now();
  return {
    version: 1,
    kind: "tool_approval",
    provider: "workbuddy-ai",
    jobId,
    generation,
    requestId: "4242",
    toolName: "Bash",
    summary: null,
    detail: {
      command: "node jq-asar-extract.cjs --out wb-main",
      args: null,
      description: "Extract main/*.js and find finishReason",
      path: "C:/Program Files/WorkBuddy/resources/app.asar",
      cwd: "C:/Users/TestUser/AppData/Local/Temp",
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    },
    options: [
      { id: "allow_always", kind: "allow_always", label: "Always Allow" },
      { id: "allow", kind: "allow_once", label: "Allow" },
      { id: "reject", kind: "reject_once", label: "Reject" }
    ],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString()
  };
}

/** A RUNNING job record that is honestly waiting for an approval. */
function makeApprovalJob(root: string, task: string): string {
  const job = createJobRecord({ task, cwd: root, provider: "workbuddy-ai", model: "wb-model" });
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.pendingApproval = pendingFor(job.id, job.generation);
  saveJob(root, job);
  return job.id;
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("the Hub serves the bounded pending approval of a RUNNING job and never a terminal one", async () => {
  const { dir, root } = newRoot("read");
  const { hub, url } = await startTestHub(root);
  try {
    const runningId = makeApprovalJob(root, "APPROVAL_RUNNING_MARKER");
    // A hand-written record may carry fields this build never persists (an old
    // build, a manual edit): only the bounded normalized fields may be served.
    const running = loadJob(root, runningId)!;
    running.pendingApproval = {
      ...pendingFor(runningId, running.generation),
      rawInput: { command: "rm -rf wb-main" },
      command: "rm -rf wb-main"
    } as unknown as PendingApproval;
    saveJob(root, running);

    const detailResponse = await fetch(`${url}/api/jobs/${runningId}`);
    const detailText = await detailResponse.text();
    const detail = JSON.parse(detailText) as Record<string, unknown>;
    assert.equal(detail.status, "running");
    const served = detail.pending_approval as Record<string, unknown>;
    assert.equal(served.kind, "tool_approval");
    assert.equal(served.provider, "workbuddy-ai");
    assert.equal(served.job_id, runningId);
    assert.equal(served.generation, running.generation);
    assert.equal(served.request_id, "4242");
    assert.equal(served.tool_name, "Bash");
    assert.deepEqual((served.options as Array<Record<string, unknown>>).map((option) => option.id), ["allow_always", "allow", "reject"]);
    // REVISED contract: the ONE bounded operation detail IS served, field by
    // field, so a human can decide. Unknown top-level keys (a stray `rawInput`
    // or `command`) are still dropped at the durable boundary.
    assert.deepEqual(served.detail, {
      command: "node jq-asar-extract.cjs --out wb-main",
      args: null,
      description: "Extract main/*.js and find finishReason",
      path: "C:/Program Files/WorkBuddy/resources/app.asar",
      cwd: "C:/Users/TestUser/AppData/Local/Temp",
      title: null,
      gate: null,
      reason: null,
      truncated: false,
      redacted: false
    });
    assert.equal("rawInput" in served, false, "no raw provider payload field is ever served");
    assert.equal("command" in served, false, "the command is never a top-level field");
    assert.equal(detailText.includes("rawInput"), false);
    assert.equal(detailText.includes("rm -rf"), false, "an injected unknown raw field never reaches the Hub API");

    const approvalResponse = await fetch(`${url}/api/jobs/${runningId}/approval`);
    assert.equal(approvalResponse.status, 200);
    const approval = (await approvalResponse.json()) as Record<string, unknown>;
    assert.equal(approval.ok, true);
    assert.equal(approval.job_id, runningId);
    assert.deepEqual(approval.pending_approval, served, "the dedicated read matches the session view");

    // A terminal record that still carries a pending approval (an older build's
    // write) must never keep presenting an actionable approval.
    const terminalId = makeApprovalJob(root, "APPROVAL_TERMINAL_MARKER");
    const terminal = loadJob(root, terminalId)!;
    terminal.status = "error";
    terminal.failureKind = "provider_permission_required";
    terminal.finishedAt = new Date().toISOString();
    terminal.pendingApproval = pendingFor(terminalId, terminal.generation);
    saveJob(root, terminal);
    const terminalDetail = (await (await fetch(`${url}/api/jobs/${terminalId}`)).json()) as Record<string, unknown>;
    assert.equal(terminalDetail.pending_approval, null, "a non-running job never exposes a pending approval");
    const terminalApproval = (await (await fetch(`${url}/api/jobs/${terminalId}/approval`)).json()) as Record<string, unknown>;
    assert.equal(terminalApproval.pending_approval, null);
  } finally {
    await closeHub(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a credential-bearing operation detail is redacted and bounded before the Hub can serve it", async () => {
  const { dir, root } = newRoot("redact");
  const { hub, url } = await startTestHub(root);
  try {
    const jobId = makeApprovalJob(root, "APPROVAL_REDACT_MARKER");
    const running = loadJob(root, jobId)!;
    // A provider (or a hand-edited record) that published a secret and an
    // oversized command: the durable boundary must bound and redact it before
    // the Hub ever serves it.
    running.pendingApproval = {
      ...pendingFor(jobId, running.generation),
      detail: {
        command: 'curl -H "Authorization: Bearer sk-live-abcdef123456" --data "password=hunter2" https://example.test',
        args: null,
        description: null,
        path: null,
        cwd: null,
        title: null,
        gate: null,
        reason: null,
        truncated: false,
        redacted: false
      }
    };
    saveJob(root, running);

    const served = ((await (await fetch(`${url}/api/jobs/${jobId}/approval`)).json()) as Record<string, unknown>)
      .pending_approval as Record<string, unknown>;
    const detail = served.detail as Record<string, unknown>;
    assert.equal(detail.redacted, true, "the redaction is marked honestly");
    assert.equal(String(detail.command).includes("sk-live-abcdef123456"), false, "the bearer token never reaches the Hub API");
    assert.equal(String(detail.command).includes("hunter2"), false, "the password value never reaches the Hub API");
    assert.match(String(detail.command), /<redacted>/);

    // The bound is enforced on the durable record, not just in the UI.
    const huge = "x".repeat(5000);
    running.pendingApproval = { ...running.pendingApproval!, detail: { ...running.pendingApproval!.detail!, command: huge } };
    saveJob(root, running);
    const bounded = ((await (await fetch(`${url}/api/jobs/${jobId}/approval`)).json()) as Record<string, unknown>)
      .pending_approval as Record<string, unknown>;
    const boundedDetail = bounded.detail as Record<string, unknown>;
    assert.equal(boundedDetail.truncated, true, "truncation is marked honestly");
    assert.ok(String(boundedDetail.command).length <= 600, "the served command is bounded");
  } finally {
    await closeHub(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a resolution is claimed exactly once; duplicate and concurrent answers get a stable already-resolved result", async () => {
  const { dir, root } = newRoot("resolve");
  const { hub, url } = await startTestHub(root);
  try {
    const jobId = makeApprovalJob(root, "APPROVAL_RESOLVE_MARKER");
    const first = await postJson(`${url}/api/jobs/${jobId}/approval`, { generation: 0, request_id: "4242", option_id: "allow" });
    assert.equal(first.status, 200);
    const resolved = (await first.json()) as Record<string, unknown>;
    assert.deepEqual(resolved, {
      ok: true,
      status: "resolved",
      job_id: jobId,
      generation: 0,
      request_id: "4242",
      option_id: "allow",
      kind: "allow_once"
    });
    const decisionFile = approvalDecisionPath(root, jobId, 0, "4242");
    assert.ok(fs.existsSync(decisionFile), "the winning decision is claimed on disk");
    const decision = readApprovalDecision(root, jobId, 0, "4242");
    assert.equal(decision?.optionId, "allow");
    assert.equal(decision?.by, "hub");
    assert.equal(JSON.stringify(decision).includes("rm -rf"), false);

    // A late/duplicate answer (another tab, a retry) never wins: it reads the
    // winner back instead of resolving twice.
    const duplicate = await postJson(`${url}/api/jobs/${jobId}/approval`, { generation: 0, request_id: "4242", option_id: "reject" });
    assert.equal(duplicate.status, 200);
    const duplicateBody = (await duplicate.json()) as Record<string, unknown>;
    assert.equal(duplicateBody.status, "already_resolved");
    assert.equal(duplicateBody.option_id, "allow");
    assert.equal(readApprovalDecision(root, jobId, 0, "4242")?.optionId, "allow", "the first successful resolution wins");

    // Two genuinely concurrent POSTs on a fresh request: exactly one resolves.
    const concurrentId = makeApprovalJob(root, "APPROVAL_CONCURRENT_MARKER");
    const [a, b] = await Promise.all([
      postJson(`${url}/api/jobs/${concurrentId}/approval`, { generation: 0, request_id: "4242", option_id: "allow" }),
      postJson(`${url}/api/jobs/${concurrentId}/approval`, { generation: 0, request_id: "4242", option_id: "reject" })
    ]);
    const bodies = [await a.json(), await b.json()] as Array<Record<string, unknown>>;
    const statuses = bodies.map((body) => body.status).sort();
    assert.deepEqual(statuses, ["already_resolved", "resolved"], "exactly one concurrent answer resolves the request");
    const winner = bodies.find((body) => body.status === "resolved")!;
    const loser = bodies.find((body) => body.status === "already_resolved")!;
    assert.equal(loser.option_id, winner.option_id, "the losing tab reads the winner's option");
    assert.equal(readApprovalDecision(root, concurrentId, 0, "4242")?.optionId, winner.option_id);
  } finally {
    await closeHub(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approval resolution validates the job, the provider option and the same-origin write boundary", async () => {
  const { dir, root } = newRoot("validate");
  const { hub, url } = await startTestHub(root);
  try {
    const jobId = makeApprovalJob(root, "APPROVAL_VALIDATE_MARKER");

    const unknownOption = await postJson(`${url}/api/jobs/${jobId}/approval`, { generation: 0, request_id: "4242", option_id: "definitely-not-published" });
    assert.equal(unknownOption.status, 400);
    assert.equal(((await unknownOption.json()) as Record<string, unknown>).code, "unknown_option");

    const missingOption = await postJson(`${url}/api/jobs/${jobId}/approval`, {});
    assert.equal(missingOption.status, 400);
    assert.equal(((await missingOption.json()) as Record<string, unknown>).code, undefined);

    const foreign = await postJson(`${url}/api/jobs/${jobId}/approval`, { generation: 0, request_id: "4242", option_id: "allow" }, { origin: "http://evil.example" });
    assert.equal(foreign.status, 403);
    assert.equal(((await foreign.json()) as Record<string, unknown>).error, "cross_origin_rejected");

    const missingJob = await postJson(`${url}/api/jobs/job-does-not-exist/approval`, { generation: 0, request_id: "4242", option_id: "allow" });
    assert.equal(missingJob.status, 404);

    const badId = await fetch(`${url}/api/jobs/bad%2Fid/approval`);
    assert.ok(badId.status === 400 || badId.status === 404, "a path-escaping id is never treated as a job");

    // A job with no pending approval (terminal, or simply never asked).
    const plain = createJobRecord({ task: "PLAIN", cwd: root, provider: "command-code", model: null });
    plain.status = "done";
    plain.finishedAt = new Date().toISOString();
    saveJob(root, plain);
    const noPending = await postJson(`${url}/api/jobs/${plain.id}/approval`, { generation: 0, request_id: "4242", option_id: "allow" });
    assert.equal(noPending.status, 409);
    const noPendingBody = (await noPending.json()) as Record<string, unknown>;
    assert.equal(noPendingBody.code, "no_pending_approval");
    assert.equal(fs.existsSync(approvalDecisionPath(root, plain.id, 0, "4242")), false, "a rejected resolution writes nothing");
  } finally {
    await closeHub(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("approval identity rejects stale requests, later runs, missing identity and expiry without writing a decision", async () => {
  const { dir, root } = newRoot("identity");
  const { hub, url } = await startTestHub(root);
  try {
    const id = makeApprovalJob(root, "IDENTITY");
    const route = `${url}/api/jobs/${id}/approval`;
    const before = { generation: 0, request_id: "4242", option_id: "allow" };
    assert.equal((await postJson(route, { option_id: "allow" })).status, 400);
    for (const identity of [{ generation: -1, request_id: "4242" }, { generation: 0.5, request_id: "4242" }, { generation: 0, request_id: "../unsafe" }]) {
      assert.equal((await postJson(route, { ...identity, option_id: "allow" })).status, 400);
    }
    const job = loadJob(root, id)!;
    job.pendingApproval!.requestId = "4243";
    saveJob(root, job);
    const replaced = await postJson(route, before);
    assert.equal(replaced.status, 409);
    assert.equal((await replaced.json() as { code: string }).code, "stale_approval");
    assert.equal(readApprovalDecision(root, id, 0, "4243"), null);

    job.generation = 1;
    job.pendingApproval = pendingFor(id, 1);
    saveJob(root, job);
    assert.equal((await postJson(route, before)).status, 409, "same request id in a later run is different");
    assert.equal(readApprovalDecision(root, id, 1, "4242"), null);
    job.pendingApproval.expiresAt = new Date(Date.now() - 1000).toISOString();
    saveJob(root, job);
    const expired = await postJson(route, { ...before, generation: 1 });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json() as { code: string }).code, "approval_expired");
    assert.equal(readApprovalDecision(root, id, 1, "4242"), null);
    const page = await fetch(`${url}/api/jobs`).then(r => r.json()) as { jobs: Array<{ approval_state: string }>; pending_approvals: unknown[] };
    assert.equal(page.jobs[0]!.approval_state, "expired");
    assert.equal(page.pending_approvals.length, 0);
  } finally { await closeHub(hub); fs.rmSync(dir, {recursive:true, force:true}); }
});

test("global approvals include off-page jobs and colliding request ids remain independent", async () => {
  const { dir, root } = newRoot("global");
  const { hub, url } = await startTestHub(root);
  try {
    const a = makeApprovalJob(root, "TASK_A"), b = makeApprovalJob(root, "TASK_B");
    const page = await fetch(`${url}/api/jobs?offset=1&limit=20`).then(r => r.json()) as { jobs: unknown[]; pending_approvals: Array<{ job_id: string }> };
    assert.equal(page.jobs.length, 1);
    assert.deepEqual(page.pending_approvals.map(j => j.job_id).sort(), [a,b].sort());
    const payload = { generation: 0, request_id: "4242", option_id: "allow" };
    assert.equal((await postJson(`${url}/api/jobs/${b}/approval`, payload)).status, 200);
    assert.equal(readApprovalDecision(root, a, 0, "4242"), null, "approval of B must not authorize A");
    assert.equal(readApprovalDecision(root, b, 0, "4242")?.optionId, "allow");
    const after = await fetch(`${url}/api/jobs?offset=50&limit=20`).then(r => r.json()) as { jobs: unknown[]; pending_approvals: Array<{ job_id: string }> };
    assert.equal(after.jobs.length, 0);
    assert.deepEqual(after.pending_approvals.map(j => j.job_id), [a]);
    const resumed = loadJob(root,b)!;
    resumed.generation = 1;
    resumed.pendingApproval = pendingFor(b,1);
    saveJob(root,resumed);
    const late = await postJson(`${url}/api/jobs/${b}/approval`, payload);
    assert.equal(late.status, 200);
    assert.equal((await late.json() as { status: string }).status, "already_resolved");
    assert.equal(readApprovalDecision(root,b,1,"4242"),null,"retry of old decision cannot authorize next run");
  } finally { await closeHub(hub); fs.rmSync(dir, {recursive:true, force:true}); }
});
