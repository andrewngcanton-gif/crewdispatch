// fixture-process-wrapper.ts — TEST-ONLY Darwin fixture supervisor.
//
// Production Command Code has a CrewDispatch-owned ACP bridge that participates
// in the Darwin terminal-containment ACK. Raw test fixtures do not, so on macOS
// this tiny supervisor gives them the same stable root/ancestry boundary without
// changing production behavior.
//
// The supervisor is the detached process-group/session leader created by the job
// service. It runs the fixture as an ordinary child, forwards stdio, and when the
// fixture publishes a terminal record it temporarily stops that direct child
// BEFORE forwarding the terminal line. This preserves the PPID chain while the
// worker snapshots escaped/unknown descendants, then resumes the fixture after
// the worker writes the bounded ACK (or after a 2s fail-safe timeout).
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createLineSplitter } from "../runtime/line-splitter";
import { DARWIN_TERMINAL_ACK_ENV } from "../runtime/process";

function terminalRecord(line: string): boolean {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const type = typeof value?.type === "string" ? value.type : "";
    return type === "result" || type === "final" || type === "terminal" || value?.terminal === true;
  } catch {
    return false;
  }
}

async function waitForAck(file: string, timeoutMs = 2_000): Promise<void> {
  if (!file) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(file)) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [fixture, ...args] = argv;
  if (!fixture) {
    process.stderr.write("fixture supervisor: missing fixture path\n");
    return 1;
  }

  const child = spawn(process.execPath, [fixture, ...args], {
    shell: false,
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  process.stdin.pipe(child.stdin!);
  child.stderr?.pipe(process.stderr, { end: false });

  const splitter = createLineSplitter();
  let chain: Promise<void> = Promise.resolve();
  let heldTerminal = false;

  const forward = async (line: string): Promise<void> => {
    const ackPath = typeof process.env[DARWIN_TERMINAL_ACK_ENV] === "string"
      ? process.env[DARWIN_TERMINAL_ACK_ENV]!.trim()
      : "";
    const terminal = !heldTerminal && terminalRecord(line);
    let stopped = false;
    if (terminal && process.platform === "darwin" && child.pid) {
      try {
        process.kill(child.pid, "SIGSTOP");
        stopped = true;
        heldTerminal = true;
      } catch {
        stopped = false;
      }
    }

    process.stdout.write(line + "\n");

    if (stopped) {
      try {
        await waitForAck(ackPath);
      } finally {
        try { process.kill(child.pid!, "SIGCONT"); } catch {}
      }
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of splitter.feed(chunk.toString("utf8"))) {
      chain = chain.then(() => forward(line));
    }
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(`fixture supervisor: ${error.message}\n`);
      resolve({ code: 1, signal: null });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const line of splitter.flush()) chain = chain.then(() => forward(line));
  await chain;
  return typeof exit.code === "number" ? exit.code : exit.signal ? 1 : 0;
}

if (typeof require !== "undefined" && require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
