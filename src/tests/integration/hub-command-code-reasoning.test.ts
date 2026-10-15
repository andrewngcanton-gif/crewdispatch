// hub-command-code-reasoning.test.ts — production-seam regression for Command Code reasoning visibility.
//
// This test intentionally does NOT hand-construct a thinking_end event. It feeds
// real-shape Command Code ACP updates through the production CcAcpNormalizer,
// persists exactly the records that normalizer emits, then asks the real Hub
// compact-activity API for hidden vs explicit-reasoning views. It exists to
// prevent the 2026-10-07 regression where component tests passed independently
// while the production normalizer never emitted the complete reasoning block the
// Dashboard's compact view required.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CcAcpNormalizer } from "../../providers/command-code/acp-normalizer";
import { createJobRecord } from "../../jobs/service";
import { appendLog, saveJob } from "../../jobs/store";
import { startHub, type HubHandle } from "../../hub/server";

async function closeHub(handle: HubHandle | null): Promise<void> {
  if (!handle) return;
  await new Promise<void>((resolve) => {
    try {
      handle.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function waitForHub(handle: HubHandle): Promise<string> {
  if (!handle.server.listening) {
    await new Promise<void>((resolve, reject) => {
      handle.server.once("listening", () => resolve());
      handle.server.once("error", reject);
    });
  }
  return `http://127.0.0.1:${handle.port}`;
}

test("Command Code production normalizer reasoning survives compact Hub activity only after explicit opt-in", { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-cc-reasoning-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(root, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  let hub: HubHandle | null = null;
  try {
    const job = createJobRecord({ cwd: project, task: "Command Code reasoning seam", provider: "command-code" });
    saveJob(root, job);
    appendLog(root, job.id, JSON.stringify({ type: "event", event: { type: "run_start", sessionId: "cc-reasoning-session" } }));

    const normalizer = new CcAcpNormalizer({
      freshSession: true,
      emit: (record) => appendLog(root, job.id, JSON.stringify(record))
    });
    normalizer.markPromptStarted();
    normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "COMMAND_CODE_REASONING_ALPHA " } });
    normalizer.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "BETA" } });
    normalizer.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final answer" } });
    normalizer.handlePromptResult({ stopReason: "end_turn" });
    appendLog(root, job.id, JSON.stringify({ type: "result", subtype: "success", result: "final answer", session_id: "cc-reasoning-session", stop_reason: "end_turn" }));

    hub = startHub({ root, host: "127.0.0.1", port: 0, env: { ...process.env, JOBQUAY_CLI_AUTODISCOVER: "false" } });
    const base = await waitForHub(hub);

    const hiddenResponse = await fetch(`${base}/api/jobs/${job.id}/log?limit=1000&activity=1&scope=current&include_reasoning=false`);
    assert.equal(hiddenResponse.status, 200);
    const hidden = await hiddenResponse.json() as any;
    const hiddenText = JSON.stringify(hidden);
    assert.equal(hiddenText.includes("COMMAND_CODE_REASONING_ALPHA"), false, "default compact activity keeps Command Code reasoning private");
    assert.equal(hiddenText.includes('"thinking_delta"'), false, "token-level thought chunks stay out of compact activity");

    const visibleResponse = await fetch(`${base}/api/jobs/${job.id}/log?limit=1000&activity=1&scope=current&include_reasoning=true`);
    assert.equal(visibleResponse.status, 200);
    const visible = await visibleResponse.json() as any;
    const reasoningRows = visible.entries.filter((entry: any) => entry.data?.event?.type === "thinking_end");
    assert.equal(reasoningRows.length, 1, "one contiguous ACP reasoning block becomes one complete compact row");
    assert.deepEqual(reasoningRows[0].reasoning, ["COMMAND_CODE_REASONING_ALPHA BETA"]);
    assert.equal(JSON.stringify(visible).includes('"thinking_delta"'), false, "opt-in still does not expose chunk-noise rows");
  } finally {
    await closeHub(hub);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
