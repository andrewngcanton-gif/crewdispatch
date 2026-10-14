// acp-client.ts — the CrewDispatch-side ACP client of ONE `cmdc acp` child.
//
// This is the transport only: NDJSON JSON-RPC 2.0 over the child's stdio, with
// the exact framing the installed CLI's own server uses (one object per
// `\n`-terminated line, `\r` stripped, `serializeMessage = JSON.stringify(m) +
// "\n"`). It owns:
//
//   * the Windows-safe spawn plan (the existing shell-free `.cmd` shim path);
//   * request/response correlation with bounded SETUP timeouts — a running
//     prompt has NO wall-clock deadline (long-turn liveness policy);
//   * TRANSPORT-FAILURE detection: stdout end/close/error, stdin error and a
//     broken write are terminal transport failures. A quiet-but-open stream is
//     NOT a failure — only a dead stream is. A prompt that is still quiet after
//     any amount of time keeps waiting (no total/idle deadline);
//   * server -> client requests (only `session/request_permission` in practice;
//     anything else is answered with an honest METHOD_NOT_FOUND error);
//   * a bounded, sanitized stderr tail for diagnostics;
//   * teardown that PROVES the child exited (graceful stdin close -> bounded
//     wait -> forced OS tree kill) before it reports success.
//
// It deliberately knows nothing about jobs, approvals or canonical records.
import { spawn, type ChildProcess } from "node:child_process";
import { CC_ACP_JSONRPC } from "./acp-wire";
import { buildCommandCodeSpawnPlan } from "./spawn-plan";

/** A JSON-RPC error the server returned (or a transport failure), typed. */
export class CcAcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CcAcpError";
    this.code = code;
    this.data = data;
  }
}

export interface CcAcpExitInfo {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CcAcpCloseResult {
  /** True only when the child process was OBSERVED to exit. */
  exited: boolean;
  /** True when a forced OS tree kill had to be used. */
  forced: boolean;
  exitCode: number | null;
}

export interface CcAcpConnectionOptions {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  comSpec?: string;
  spawnFn?: typeof spawn;
  /** Bounded setup/control timeout (initialize, attach, configure, close). */
  controlTimeoutMs?: number;
  /** Bounded stderr evidence kept for diagnostics. */
  stderrCap?: number;
  /** A single NDJSON line larger than this fails the connection. */
  maxLineBytes?: number;
  /** Test seam: the forced tree killer. */
  killTreeFn?: (pid: number) => Promise<boolean>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  method: string;
}

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_CAP = 4096;
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;
const GRACEFUL_CLOSE_MS = 5_000;
const KILL_WAIT_MS = 10_000;

function sanitizeStderr(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * ONE live ACP connection. `start()` never throws: a failed spawn is an honest
 * `{ok:false}` result the bridge reports before any prompt exists.
 */
export class CcAcpConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly options: CcAcpConnectionOptions;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private exitInfo: CcAcpExitInfo = { exited: false, code: null, signal: null };
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private requestHandler: ((method: string, params: unknown, id: unknown) => Promise<unknown>) | null = null;
  private closeWaiters: Array<() => void> = [];
  private writeFailed = false;
  private transportError: CcAcpError | null = null;

  private constructor(child: ChildProcess, options: CcAcpConnectionOptions) {
    this.child = child;
    this.options = options;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.feed(chunk));
    // A protocol stream that ENDS/CLOSES while the child process may still be
    // running is a dead transport: no reply can ever arrive again, so every
    // pending request is rejected instead of waiting forever. A stream error is
    // the same class of failure.
    child.stdout?.on("end", () => {
      this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, "The Command Code ACP protocol stream ended (stdout EOF)"));
    });
    child.stdout?.on("close", () => {
      this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, "The Command Code ACP protocol stream closed (stdout EOF)"));
    });
    child.stdout?.on("error", (error: Error) => {
      this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP stdout stream failed: ${error.message}`));
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = sanitizeStderr((this.stderr + chunk).slice(-(this.options.stderrCap ?? DEFAULT_STDERR_CAP)));
    });
    // stderr is diagnostics only, but an unhandled stream error would crash the
    // host process; it is recorded, never treated as protocol evidence.
    child.stderr?.on("error", () => {
      /* diagnostics only */
    });
    // A failed stdin means requests can no longer reach the server: the same
    // dead-transport class as a closed stdout (never inferred from quiet).
    child.stdin?.on("error", (error: Error) => {
      this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP process stdin failed: ${error.message}`));
    });
    child.on("error", (error: Error) => {
      this.failAll(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP process failed: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { exited: true, code, signal };
      this.failAll(
        new CcAcpError(
          CC_ACP_JSONRPC.INTERNAL_ERROR,
          `The Command Code ACP process exited${code != null ? ` with code ${code}` : signal ? ` on ${signal}` : ""}`
        )
      );
      const waiters = this.closeWaiters;
      this.closeWaiters = [];
      for (const wake of waiters) wake();
    });
  }

  /** Spawn `cmdc acp` through the existing shell-free spawn plan. */
  static start(
    options: CcAcpConnectionOptions
  ): { ok: true; connection: CcAcpConnection } | { ok: false; error: string } {
    const plan = buildCommandCodeSpawnPlan({
      cliPath: options.cliPath,
      argv: ["acp"],
      platform: options.platform,
      comSpec: options.comSpec,
      env: options.env
    });
    if (!plan.ok) return { ok: false, error: plan.error };
    const spawnFn = options.spawnFn ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnFn(plan.plan.file, plan.plan.args, {
        shell: false,
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        windowsVerbatimArguments: plan.plan.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      return { ok: false, error: `The Command Code ACP process could not be started: ${(error as Error)?.message ?? String(error)}` };
    }
    child.stdin?.on("error", () => {
      /* re-bound by the connection constructor (a dead-transport failure) */
    });
    return { ok: true, connection: new CcAcpConnection(child, options) };
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (method: string, params: unknown, id: unknown) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  stderrTail(): string {
    return this.stderr;
  }

  /** The observed child exit, or `exited:false` while it is still running. */
  exit(): CcAcpExitInfo {
    return this.exitInfo;
  }

  /**
   * The transport failure that killed this connection (stdout EOF/close/error,
   * stdin error, broken write), or null while the transport is alive. A quiet
   * stream never sets this: only a provably dead one does.
   */
  transportFailure(): CcAcpError | null {
    return this.transportError;
  }

  /**
   * Send one request. `timeoutMs` bounds SETUP/CONTROL calls only; a prompt
   * passes `null` and waits indefinitely (long-turn liveness policy). A dead
   * transport rejects immediately, however long the caller is willing to wait.
   */
  request(method: string, params: unknown, timeoutMs: number | null = this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || this.exitInfo.exited) {
      return Promise.reject(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, "The Command Code ACP connection is closed"));
    }
    if (this.transportError) {
      return Promise.reject(this.transportError);
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP call ${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  /** Send one notification (no response is expected). */
  notify(method: string, params: unknown): void {
    if (this.closed || this.exitInfo.exited) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private write(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || this.writeFailed) {
      this.writeFailed = true;
      // During a deliberate teardown the pipe is closed on purpose; outside it,
      // an unwritable stdin is a dead transport, not a request to ignore.
      if (!this.closed) {
        this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, "The Command Code ACP process stdin is not writable"));
      }
      return;
    }
    try {
      stdin.write(JSON.stringify(message) + "\n", (error?: Error | null) => {
        if (error && !this.closed) {
          this.writeFailed = true;
          this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP request could not be written: ${error.message}`));
        }
      });
    } catch (error) {
      this.writeFailed = true;
      if (!this.closed) {
        this.failTransport(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, `The Command Code ACP request could not be written: ${(error as Error)?.message ?? String(error)}`));
      }
    }
  }

  /**
   * Mark the transport dead ONCE and reject every pending request with the
   * same typed failure. Later notifications/requests see a rejected connection.
   */
  private failTransport(error: CcAcpError): void {
    if (this.transportError) return;
    this.transportError = error;
    this.failAll(error);
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      this.buffer = "";
      this.failAll(new CcAcpError(CC_ACP_JSONRPC.INTERNAL_ERROR, "The Command Code ACP stream produced an oversized line"));
      return;
    }
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a malformed line is ignored; the protocol stream is otherwise intact
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    const hasMethod = typeof record.method === "string";
    const isResponse = !hasMethod && ("result" in record || "error" in record);
    if (isResponse) {
      const id = typeof record.id === "number" ? record.id : -1;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      if ("error" in record && record.error && typeof record.error === "object") {
        const error = record.error as Record<string, unknown>;
        const code = typeof error.code === "number" ? error.code : CC_ACP_JSONRPC.INTERNAL_ERROR;
        const text = typeof error.message === "string" && error.message.trim() ? error.message : "The Command Code ACP call failed";
        pending.reject(new CcAcpError(code, text, error.data));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (hasMethod && !("id" in record)) {
      this.notificationHandler?.(record.method as string, record.params);
      return;
    }
    if (hasMethod && "id" in record) {
      const id = record.id;
      const method = record.method as string;
      const params = record.params;
      const handler = this.requestHandler;
      if (!handler) {
        this.respondError(id, CC_ACP_JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
        return;
      }
      Promise.resolve()
        .then(() => handler(method, params, id))
        .then(
          (result) => this.respondResult(id, result),
          (error: unknown) => {
            if (error instanceof CcAcpError) this.respondError(id, error.code, error.message, error.data);
            else this.respondError(id, CC_ACP_JSONRPC.INTERNAL_ERROR, (error as Error)?.message ?? "Internal error");
          }
        );
    }
  }

  private respondResult(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: unknown, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  /**
   * Close the connection and PROVE the child exited.
   *
   * 1. `session/close` (best effort, bounded) when a session was attached;
   * 2. end the child's stdin — the ACP server finishes on input end, drains
   *    its inflight work and disposes every session, then exits;
   * 3. wait up to `graceMs` for the observed exit;
   * 4. otherwise force the OS process TREE (the ACP server may have spawned
   *    tool subprocesses) and wait again.
   */
  async close(options: { graceMs?: number; closeSession?: boolean } = {}): Promise<CcAcpCloseResult> {
    if (this.closed) return { exited: this.exitInfo.exited, forced: false, exitCode: this.exitInfo.code };
    if (options.closeSession !== false) {
      // Best effort only, and it MUST run before the connection is marked
      // closed: a session that is already gone must not block teardown.
      try {
        await this.lastCloseSession?.();
      } catch {
        /* ignore */
      }
    }
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const graceMs = options.graceMs ?? GRACEFUL_CLOSE_MS;
    let exited = await this.waitForExit(graceMs);
    let forced = false;
    if (!exited && this.child.pid) {
      forced = true;
      await this.killTree(this.child.pid);
      exited = await this.waitForExit(KILL_WAIT_MS);
    }
    return { exited, forced, exitCode: this.exitInfo.code };
  }

  /** A callback installed by the bridge: the best-effort `session/close` call. */
  private lastCloseSession: (() => Promise<unknown>) | null = null;
  setCloseSession(fn: (() => Promise<unknown>) | null): void {
    this.lastCloseSession = fn;
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exitInfo.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(this.exitInfo.exited), ms);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /** Kill the child's OS process TREE; returns true when a kill was issued. */
  private async killTree(pid: number): Promise<boolean> {
    if (this.options.killTreeFn) return this.options.killTreeFn(pid);
    try {
      if (process.platform === "win32") {
        const { execFile } = await import("node:child_process");
        await new Promise<void>((resolve) => {
          execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
        });
        return true;
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      return true;
    } catch {
      return false;
    }
  }
}
