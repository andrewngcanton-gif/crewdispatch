// failure-evidence-boundary-child.ts — a TEST-ONLY separate-process driver.
//
// It is NOT a `*.test.ts`, so the runner never executes it directly. The
// boundary regression (`failure-evidence.test.ts`) spawns it as a REAL separate
// OS process. It performs a disposable, REAL MCP stdio -> daemon -> worker ->
// provider-fixture -> loopback HTTP callback execution, then intentionally fails
// the test body AND its teardown. The failure-evidence helper must retain the
// real generation/state/callback evidence in a directory OUTSIDE the workspace
// it then deletes, and both original error markers must reach stderr.
//
// No real provider, credential or network is used: the provider PROCESS is the
// only fixture and the callback is a loopback listener in this process.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createCliIsolation } from "../../cli/run-isolation";
import { McpStdioClient } from "../helpers/mcp-client";
import { createFailureEvidence, runWithFailureEvidence } from "../helpers/failure-evidence";

const MCP_ENTRY = path.join(__dirname, "..", "..", "mcp", "server.js");
const TERMINAL = new Set(["done", "error", "cancelled", "interrupted"]);

export const BOUNDARY_BODY_MARKER = "INTENTIONAL_BODY_FAILURE_MARKER_boundary_7f3a";
export const BOUNDARY_CLEANUP_MARKER = "INTENTIONAL_CLEANUP_FAILURE_MARKER_boundary_7f3a";
export const BOUNDARY_ARTIFACT_LINE = "FAILURE_EVIDENCE_ARTIFACT=";
export const BOUNDARY_SOURCE_DIR_LINE = "FAILURE_EVIDENCE_SOURCE_DIR=";
export const BOUNDARY_SOURCE_DELETED_LINE = "FAILURE_EVIDENCE_SOURCE_DELETED=";

const HEADER = [
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { input += d; });'
];

function fixtureEcho(): string[] {
  return [
    ...HEADER,
    'process.stdin.on("end", () => {',
    '  out({ type: "event", event: { type: "run_start", sessionId: "fx-boundary-session" } });',
    '  out({ type: "result", subtype: "success", result: "BOUNDARY_DONE", session_id: "fx-boundary-session", stop_reason: "end_turn" });',
    "  process.exit(0);",
    "});"
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Listener {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

function startListener(): Promise<Listener> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d: Buffer) => (b += d.toString("utf8")));
    req.on("end", () => {
      bodies.push(b);
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/wake`, bodies, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function waitTerminal(client: McpStdioClient, id: string, timeoutMs: number, onObserve?: (r: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = McpStdioClient.json(await client.callTool("jobquay_result", { id }));
    onObserve?.(r);
    if (TERMINAL.has(String(r.status))) return r;
    if (Date.now() >= deadline) throw new Error(`job ${id} did not reach a terminal state`);
    await sleep(150);
  }
}

async function waitBodies(listener: Listener, n: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (listener.bodies.length < n) {
    if (Date.now() >= deadline) throw new Error(`expected ${n} callback bodies, saw ${listener.bodies.length}`);
    await sleep(100);
  }
}

async function main(): Promise<void> {
  const artifactBaseDir = process.env.JOBQUAY_FAILURE_EVIDENCE_ARTIFACT_BASE || undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-boundary-child-"));
  const root = path.join(dir, "root");
  const iso = createCliIsolation({ baseDir: dir, tempPrefix: "iso-boundary-" });
  const project = path.join(iso.root, "project");
  fs.mkdirSync(project, { recursive: true });
  const fixture = path.join(dir, "boundary-fixture.js");
  fs.writeFileSync(fixture, fixtureEcho().join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = { ...iso.env, JOBQUAY_DATA_ROOT: root, JOBQUAY_TEST_FIXTURE: fixture };

  const listener = await startListener();
  const client = new McpStdioClient(MCP_ENTRY, env, dir);
  let lastObserved: Record<string, unknown> | null = null;
  const evidence = createFailureEvidence({
    name: "boundary-child",
    dataRoot: root,
    workspaceDir: dir,
    artifactBaseDir,
    extra: () => ({ mcpLastObserved: lastObserved, callbackBodies: listener.bodies.map((b) => b.slice(0, 2048)), callbackCount: listener.bodies.length })
  });

  try {
    await runWithFailureEvidence(
      evidence,
      async () => {
        await client.initialize();
        const spawned = McpStdioClient.json(await client.callTool("jobquay_spawn", { task: "boundary", cwd: project, callback_url: listener.url }));
        const id = String(spawned.job_id);
        const done = await waitTerminal(client, id, 30000, (r) => {
          lastObserved = r;
        });
        if (done.status !== "done") throw new Error(`unexpected terminal status ${String(done.status)}`);
        await waitBodies(listener, 1, 15000);
        // REAL durable job/generation/callback evidence now exists; fail on purpose.
        throw new Error(BOUNDARY_BODY_MARKER);
      },
      async () => {
        // Close the test-owned endpoints, then let the shared MCP finalizer own
        // daemon discovery -> shutdown -> confirmed native exit -> root removal.
        // The marker below remains the intentional cleanup failure this boundary
        // test is designed to retain alongside the body failure.
        await client.close().catch(() => undefined);
        await listener.close().catch(() => undefined);
        await McpStdioClient.cleanupWorkspace(root, dir);
        throw new Error(BOUNDARY_CLEANUP_MARKER);
      }
    );
    process.exitCode = 0;
  } catch (e) {
    process.stderr.write(`${BOUNDARY_SOURCE_DIR_LINE}${dir}\n`);
    process.stderr.write(`${BOUNDARY_SOURCE_DELETED_LINE}${!fs.existsSync(dir)}\n`);
    process.stderr.write(`${(e as Error)?.stack || String(e)}\n`);
    process.exitCode = 3;
  }
}

if (require.main === module) {
  void main().catch((e) => {
    process.stderr.write(`[boundary-child] fatal: ${(e as Error)?.stack || String(e)}\n`);
    process.exitCode = 4;
  });
}
