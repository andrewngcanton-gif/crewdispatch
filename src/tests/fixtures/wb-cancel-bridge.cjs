// wb-cancel-bridge.cjs — the disposable-bridge driver for the cancellation
// regressions (JQ-20261006-58, generation-2).
//
// WHAT IS REAL HERE
//   * the ACP connection is the PRODUCTION `AcpClient` (its `/connect` +
//     advertised session token, its `initialize`, its `session/new`,
//     `session/set_model`, the long-running `session/prompt` and the native
//     `session/cancel` notification on that SAME connection);
//   * the cancellation control protocol is the PRODUCTION `TurnCancelChannel`
//     (the live-bridge half of `cancel-channel.ts`): it polls the exact
//     job+generation+session-scoped request file while the prompt is in flight,
//     delivers the cancel on THIS connection, and acknowledges the in-protocol
//     delivery — exactly the wiring `desktop-bridge.ts::main` uses.
//
// WHAT IS REPLACED
//   * the bridge's disposable MAIN WIRING only (the Desktop sidecar connection,
//     the host-runtime creation and the terminal stream records): none of those
//     are the cancellation route. The installed WorkBuddy Desktop app itself is
//     replaced by the fake sidecar/runtime fixture, as in every cancellation
//     regression. No real WorkBuddy process, credential, configuration or
//     transcript is touched.
//
// Usage:
//   node wb-cancel-bridge.cjs --endpoint-file <f> --cwd <dir> --session-id <id>
//     --job-id <id> --generation <n> --data-root <dir> --result-file <f>
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const distBridge = require(path.join(REPO_ROOT, "dist", "providers", "workbuddy-ai", "desktop-bridge.js"));
const distChannel = require(path.join(REPO_ROOT, "dist", "providers", "workbuddy-ai", "cancel-channel.js"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

(async () => {
  const endpointFile = arg("--endpoint-file");
  const cwd = arg("--cwd");
  const expectedSessionId = arg("--session-id");
  const jobId = arg("--job-id");
  const generation = Number(arg("--generation"));
  const dataRoot = arg("--data-root");
  const resultFile = arg("--result-file");
  const { port } = readJson(endpointFile);
  const endpoint = `http://127.0.0.1:${port}/api/v1/acp`;

  const acp = new distBridge.AcpClient(endpoint, "claude-sonnet-4-5", null);
  await acp.connect();
  const sessionId = await acp.newSession(cwd);
  if (sessionId !== expectedSessionId) throw new Error(`fixture bridge session mismatch: ${sessionId}`);
  await acp.setModel(sessionId);

  // The SAME wiring as the production bridge: dispatch the prompt FIRST, then
  // watch for a cancel request while it is in flight, and stop the watcher the
  // moment the turn settles.
  const cancelChannel = new distChannel.TurnCancelChannel({
    provider: "workbuddy-ai",
    jobId,
    generation,
    sessionId,
    dataRoot
  });
  const promptPromise = acp.prompt(sessionId, "run the fixture tool");
  const stopCancelWatch = cancelChannel.watch(async (sessionIdToCancel) => {
    await acp.cancel(sessionIdToCancel);
  });
  let result;
  try {
    result = await promptPromise;
  } finally {
    stopCancelWatch();
  }
  writeJson(resultFile, {
    sessionId,
    stopReason: result.stopReason,
    finishReason: result.finishReason,
    finalText: result.finalText
  });
  await acp.close();
  process.exit(0);
})().catch((error) => {
  try {
    const file = arg("--result-file");
    if (file) fs.appendFileSync(`${file}.err`, String((error && error.stack) || error) + "\n");
  } catch {}
  process.exit(3);
});
