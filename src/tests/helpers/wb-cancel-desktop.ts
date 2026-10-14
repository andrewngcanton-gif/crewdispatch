// wb-cancel-desktop.ts — the DISPOSABLE fake WorkBuddy Desktop harness used by
// the cancellation regressions (JQ-20261006-58).
//
// WHAT IS REAL HERE
//   * the sidecar, the ACP runtimes and the tool processes are REAL separate OS
//     processes (a real Windows named-pipe control server, a real loopback ACP
//     HTTP server, real long-running node children);
//   * every path/endpoint the production route uses is computed by the
//     PRODUCTION helpers of `desktop-bridge.ts`, so the fixture can never drift
//     from the installed protocol's own naming;
//   * the disposable-bridge DRIVER (`wb-cancel-bridge.cjs`) runs the PRODUCTION
//     `AcpClient` (its own connection, token, initialize, prompt and native
//     `session/cancel`) and the PRODUCTION `TurnCancelChannel` (the live-bridge
//     half of the cancellation control protocol);
//   * the provider's cancel route, the job service cancel path, the OS process
//     table and the real Windows tree kill are the production ones.
//
// WHAT THE FIXTURE REPLACES
//   * the installed WorkBuddy Desktop app itself (its sidecar and its ACP
//     runtime) — including its INSTALLED connection-scoped cancel semantics:
//     `session/cancel` aborts the in-flight prompt only on the SAME connection,
//     and is a logged no-op on any other connection. No real WorkBuddy process,
//     credential, configuration or transcript is touched: the fake desktop
//     lives under a disposable config dir + tmp dir, and
//     `JOBQUAY_WORKBUDDY_AI_CLI_PATH` points at a fake bundled CLI path inside
//     the disposable root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  hostRuntimeId,
  workBuddyDesktopControlEndpoint,
  workBuddyDesktopSidecarPidPath
} from "../../providers/workbuddy-ai/desktop-bridge";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
// The fake Desktop is a plain `.cjs` fixture that `tsc` does not emit into
// `dist` (tsconfig includes only `src/**/*.ts`), so it is resolved from the
// source tree — the same pattern the other `.cjs` fixtures use.
export const WB_CANCEL_FIXTURE = path.join(REPO_ROOT, "src", "tests", "fixtures", "wb-cancel-desktop.cjs");
/**
 * The disposable-bridge DRIVER fixture. It runs the production `AcpClient` and
 * `TurnCancelChannel` from `dist`, so the integration regression exercises the
 * REAL bridge cancellation control, not a stand-in.
 */
export const WB_CANCEL_BRIDGE_FIXTURE = path.join(REPO_ROOT, "src", "tests", "fixtures", "wb-cancel-bridge.cjs");

export interface FakeRuntimeSession {
  /** The ACP session id of one CrewDispatch turn (what the bridge publishes). */
  acpSessionId: string;
  /** Model a runtime that does NOT stop its tool on cancel (honest `unresolved`). */
  ignoreCancel?: boolean;
}

export interface FakeRuntimeSpec {
  /** The sidecar's runtime id; the test derives it with the production helper. */
  runtimeSessionId: string;
  sessions: FakeRuntimeSession[];
  /** Model a runtime that answers `session/cancel` with an SSE reply that ends. */
  sseReply?: boolean;
}

export interface FakeRuntimeHandle {
  runtimeSessionId: string;
  /** The runtime process (a child of the fake sidecar), never to be killed. */
  runtimePid: number;
  /** Tool PIDs in the order the sessions were declared. */
  toolPids: number[];
  /** JSONL log of every ACP request this runtime received. */
  cancelLog: string;
  /** The endpoint file the fake runtime published (the bridge driver reads it). */
  endpointFile: string;
}

/** One logged ACP request. Marker fields are bounded; a raw token is never logged. */
export interface FakeRuntimeRequest {
  method: string;
  sessionId: string | null;
  tokenOk?: boolean;
  rejected?: string;
  /** The connection that sent this request (fixture-issued id). */
  connectionId?: string;
  /** A `session/prompt` held open as this connection's in-flight prompt. */
  inflight?: boolean;
  /** A `session/cancel` that matched the in-flight prompt of ITS OWN connection. */
  owner?: boolean;
  /** A `session/cancel` that matched no in-flight prompt of its connection. */
  noop?: boolean;
}

export interface FakeDesktop {
  root: string;
  configDir: string;
  tmpDir: string;
  /** Fake absolute bundled CLI path (published through the provider env var). */
  cliPath: string;
  env: NodeJS.ProcessEnv;
  sidecar: ChildProcess;
  sidecarPid: number;
  runtimes: FakeRuntimeHandle[];
  /** JSONL log the fixture writes if the product ever calls `session.kill`. */
  sessionKillLog: string;
  /** Read every ACP request one runtime received (markers only, never a token). */
  requestsOf(index: number): FakeRuntimeRequest[];
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(produce: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = produce();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
}

/** The runtime id the PRODUCTION bridge would derive for one combination. */
export function fakeHostRuntimeId(input: {
  cliPath: string;
  permissionMode: string;
  effort?: string | null;
  cwd: string;
}): string {
  const cliMode: Record<string, string> = {
    default: "default",
    plan: "plan",
    "accept-edits": "acceptEdits",
    yolo: "bypassPermissions",
    "dont-ask": "dontAsk",
    auto: "auto",
    "full-access": "fullAccess"
  };
  const mode = cliMode[input.permissionMode];
  if (!mode) throw new Error(`unsupported permission mode for the fixture: ${input.permissionMode}`);
  return hostRuntimeId(input.cliPath, mode, input.effort ?? null, input.cwd);
}

/**
 * Start a disposable fake WorkBuddy Desktop: one sidecar process owning one
 * runtime process per spec, each owning one real tool process per ACP session.
 */
export async function startFakeWorkBuddyDesktop(input: {
  root: string;
  cliPath: string;
  cwd: string;
  runtimes: FakeRuntimeSpec[];
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  tmpDir?: string;
}): Promise<FakeDesktop> {
  const configDir = input.configDir ?? path.join(input.root, "wb-config");
  // The sidecar pid file must live where the PRODUCTION route reads it: its
  // `workBuddyDesktopSidecarMeta`/`...PidPath` callers default to `os.tmpdir()`,
  // so the fixture defaults there too (isolated by the config-dir-derived token,
  // removed by `stop()`). Everything else stays inside the disposable root.
  const tmpDir = input.tmpDir ?? os.tmpdir();
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const pidFile = workBuddyDesktopSidecarPidPath(configDir, "win32", tmpDir);
  const uuid = crypto.randomBytes(4).toString("hex");
  const pipe = workBuddyDesktopControlEndpoint(configDir, uuid, "win32", tmpDir);

  const runtimeSpecs: Record<string, unknown>[] = [];
  const handles: FakeRuntimeHandle[] = [];
  input.runtimes.forEach((spec, index) => {
    const dir = path.join(input.root, `runtime-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    const endpointFile = path.join(dir, "endpoint.json");
    const runtimePidFile = path.join(dir, "runtime-pid.json");
    const cancelLog = path.join(dir, "requests.log");
    fs.writeFileSync(cancelLog, "", "utf8");
    const sessionsFile = path.join(dir, "sessions.json");
    fs.writeFileSync(
      sessionsFile,
      JSON.stringify(
        spec.sessions.map((session, sessionIndex) => ({
          acpSessionId: session.acpSessionId,
          toolPidFile: path.join(dir, `tool-${sessionIndex}.json`),
          ignoreCancel: session.ignoreCancel === true
        }))
      ),
      "utf8"
    );
    runtimeSpecs.push({
      runtimeSessionId: spec.runtimeSessionId,
      endpointFile,
      runtimePidFile,
      sessionsFile,
      cancelLog,
      sseReply: spec.sseReply === true
    });
    handles.push({ runtimeSessionId: spec.runtimeSessionId, runtimePid: 0, toolPids: [], cancelLog, endpointFile });
  });

  const runtimesFile = path.join(input.root, "runtimes.json");
  fs.writeFileSync(runtimesFile, JSON.stringify(runtimeSpecs), "utf8");
  const sessionKillLog = path.join(input.root, "session-kill.log");
  fs.writeFileSync(sessionKillLog, "", "utf8");

  const sidecar = spawn(
    process.execPath,
    [WB_CANCEL_FIXTURE, "sidecar", "--pid-file", pidFile, "--pipe", pipe, "--uuid", uuid, "--runtimes-file", runtimesFile],
    { stdio: "ignore", windowsHide: true }
  );
  await waitFor(() => (fs.existsSync(pidFile) ? readJson(pidFile).pid : null), 30000, "fake sidecar pid file");
  for (let index = 0; index < handles.length; index += 1) {
    const handle = handles[index];
    if (!handle) continue;
    const spec = runtimeSpecs[index] as { runtimePidFile: string; sessionsFile: string };
    const runtimePid = await waitFor(() => {
      try {
        return Number(readJson(spec.runtimePidFile).pid);
      } catch {
        return null;
      }
    }, 30000, `runtime ${index} pid`);
    handle.runtimePid = runtimePid;
    const sessions = readJson(spec.sessionsFile) as { toolPidFile: string }[];
    for (const session of sessions) {
      const pid = await waitFor(() => {
        try {
          return Number(readJson(session.toolPidFile).pid);
        } catch {
          return null;
        }
      }, 30000, "tool pid");
      handle.toolPids.push(pid);
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...(input.env ?? process.env),
    WORKBUDDY_CONFIG_DIR: configDir,
    CODEBUDDY_CONFIG_DIR: configDir,
    JOBQUAY_WORKBUDDY_AI_CLI_PATH: input.cliPath
  };
  const sidecarPid = Number(readJson(pidFile).pid);

  return {
    root: input.root,
    configDir,
    tmpDir,
    cliPath: input.cliPath,
    env,
    sidecar,
    sidecarPid,
    runtimes: handles,
    sessionKillLog,
    requestsOf(index: number): FakeRuntimeRequest[] {
      const handle = handles[index];
      if (!handle) return [];
      return fs
        .readFileSync(handle.cancelLog, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as FakeRuntimeRequest);
    },
    async stop(): Promise<void> {
      for (const handle of handles) {
        for (const pid of handle.toolPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        try {
          process.kill(handle.runtimePid, "SIGKILL");
        } catch {}
      }
      try {
        process.kill(sidecarPid, "SIGKILL");
      } catch {}
      await sleep(100);
      // Remove the disposable sidecar token dir the fixture created under the
      // real OS temp base (see `pidFile` above).
      try {
        fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
      } catch {}
    }
  };
}

/** A disposable root for one test (removed by the caller). */
export function makeDisposableRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
