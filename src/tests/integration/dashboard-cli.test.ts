import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CLI_ENTRY = path.join(__dirname, "..", "..", "cli", "crewdispatch-cli.js");

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitDown(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch("http://127.0.0.1:" + port + "/api/ping", { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function runCliAsync(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("jobquay web --no-open starts and then reuses one real loopback Hub", { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-web-cli-"));
  const port = await freePort();
  const env = { ...process.env, JOBQUAY_DATA_ROOT: path.join(temp, "data") };
  let pid: number | null = null;
  try {
    const first = spawnSync(process.execPath, [CLI_ENTRY, "web", "--no-open", "--port", String(port), "--json"], {
      cwd: temp,
      env,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    assert.ifError(first.error);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const body1 = JSON.parse(first.stdout) as Record<string, unknown>;
    assert.equal(body1.ok, true);
    assert.equal(body1.started, true);
    assert.equal(body1.restarted, false);
    assert.equal(body1.action, "started");
    assert.equal(body1.opened, false);
    assert.equal(body1.service, "jobquay");
    assert.equal(typeof body1.build_id, "string", "the started Hub publishes a build id");
    pid = Number(body1.hub_pid);
    assert.ok(Number.isInteger(pid) && pid > 0);

    const ping = await fetch("http://127.0.0.1:" + port + "/api/ping", { signal: AbortSignal.timeout(3000) });
    const pingBody = (await ping.json()) as Record<string, unknown>;
    assert.equal(ping.status, 200);
    assert.equal(pingBody.ok, true);
    assert.equal(pingBody.service, "jobquay");
    assert.equal(typeof pingBody.version, "string");
    assert.equal(pingBody.build_id, body1.build_id, "the reported build is the one the Hub snapshotted");
    assert.equal(pingBody.version, body1.version);

    const second = spawnSync(process.execPath, [path.join(__dirname, "..", "..", "cli", "jobquay-cli.js"), "web", "--no-open", "--port", String(port), "--json"], {
      cwd: temp,
      env,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    });
    assert.ifError(second.error);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const body2 = JSON.parse(second.stdout) as Record<string, unknown>;
    assert.equal(body2.action, "reused", "an unchanged version+build is reused");
    assert.equal(body2.started, false);
    assert.equal(body2.restarted, false);
    assert.equal(body2.hub_pid, null);
    assert.equal(body2.opened, false);
    assert.equal(body2.build_id, body1.build_id, "a reuse only happens for the same build id");
    assert.equal(body2.version, body1.version);
  } finally {
    if (pid) {
      try { process.kill(pid); } catch {}
      await waitDown(port);
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("jobquay web fails closed when the port belongs to another local service", { timeout: 15000 }, async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "not-jobquay" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const run = await runCliAsync(["web", "--no-open", "--port", String(port), "--json"]);
    assert.equal(run.code, 1, run.stderr || run.stdout);
    const body = JSON.parse(run.stdout) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.code, "port_in_use");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
