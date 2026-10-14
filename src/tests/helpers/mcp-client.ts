// mcp-client.ts — a minimal stdio MCP client used by the batch-3 tests. It speaks
// the REAL MCP stdio framing (newline-delimited JSON-RPC 2.0) against the BUILT
// server (`dist/mcp/server.js`) as a separate process, so the tests exercise the
// official SDK's handshake rather than an in-process shortcut.
import { spawn, type ChildProcess } from "node:child_process";
import { TEST_DIRECT_DURABLE_LAUNCH_ENV } from "../../runtime/durable-launch";
import { DISPATCH_DASHBOARD_ENV } from "../../daemon/dashboard-ensure";
import { cleanupDaemonFixture, discoverFixtureJobProcessRoots, removeFixtureWorkspaceBounded } from "./daemon-fixture-cleanup";

const TEST_CHILDLESS_FIXTURE_SCAN_ENV = "JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN";

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class McpStdioClient {
  private readonly child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrText = "";
  private exited = false;

  constructor(entry: string, env: NodeJS.ProcessEnv, cwd?: string, command: string = process.execPath) {
    // Most MCP integration suites exercise the provider/daemon boundary, not the
    // on-demand Dashboard lifecycle. Default that unrelated durable Hub OFF in
    // this TEST helper so it cannot outlive a disposable workspace and hold the
    // parent cwd open on Windows. Dedicated Dashboard acceptance opts in with
    // CREWDISPATCH_DISPATCH_DASHBOARD=1, which remains authoritative.
    const baseEnv: NodeJS.ProcessEnv = {
      ...env,
      [DISPATCH_DASHBOARD_ENV]: env[DISPATCH_DASHBOARD_ENV] ?? "0"
    };
    const childEnv = process.platform === "win32"
      ? {
          ...baseEnv,
          [TEST_DIRECT_DURABLE_LAUNCH_ENV]: env[TEST_DIRECT_DURABLE_LAUNCH_ENV] ?? "1",
          [TEST_CHILDLESS_FIXTURE_SCAN_ENV]: env[TEST_CHILDLESS_FIXTURE_SCAN_ENV] ?? "1"
        }
      : baseEnv;
    this.child = spawn(command, [entry], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    this.child.stderr?.on("data", (d: Buffer) => (this.stderrText += d.toString("utf8")));
    this.child.on("exit", () => {
      this.exited = true;
      for (const p of this.pending.values()) p.reject(new Error("MCP server exited before responding"));
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  get stderr(): string {
    return this.stderrText;
  }

  /** The MCP server process PID (for descendant/process-table assertions). */
  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get alive(): boolean {
    return !this.exited;
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, timeoutMs).unref();
    });
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jobquay-test-client", version: "0.0.0" }
    })) as Record<string, unknown>;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    return result;
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const result = (await this.request("tools/list", {})) as { tools: Array<Record<string, unknown>> };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as McpToolResult;
  }

  /** Parse a tool result's first text block as JSON (the CrewDispatch tool shape). */
  static json(result: McpToolResult): Record<string, unknown> {
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    return JSON.parse(text) as Record<string, unknown>;
  }

  /** Simulate the caller/MCP-server process going away (request lifetime ends). */
  kill(): void {
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }

  /**
   * Final cleanup for a disposable MCP integration workspace.
   *
   * The production daemon is intentionally durable: closing the MCP stdio
   * process does not prove the daemon has exited. On Windows, recursively
   * deleting the test root while that broker is still alive can fail EPERM (or
   * race its heartbeat/meta writes). Finalizers call this only after every MCP
   * client/listener needed by the test has been closed.
   */
  static async cleanupWorkspace(root: string, dir: string): Promise<void> {
    // If the durable daemon cannot be proven stopped, cleanupDaemonFixture
    // deliberately leaves the root in place. Propagate that refusal and do NOT
    // delete the parent directory around it.
    const processRoots = discoverFixtureJobProcessRoots(root);
    await cleanupDaemonFixture({ root });
    await removeFixtureWorkspaceBounded(dir, processRoots);
  }
  async close(): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    const waitExit = (timeoutMs: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (this.exited) return resolve(true);
        const timer = setTimeout(() => resolve(this.exited), timeoutMs);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    // Give the stdio server its normal EOF shutdown first. If it misses that
    // bound, terminate THIS owned test child, then still await the actual exit
    // event before returning. Returning immediately after child.kill() lets a
    // Windows process keep its cwd handle on the disposable parent workspace and
    // turns teardown into a misleading EPERM failure.
    if (await waitExit(5000)) return;
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    if (!(await waitExit(5000))) {
      throw new Error(`MCP server pid=${this.child.pid ?? "unknown"} did not exit after EOF + terminate`);
    }
  }}
