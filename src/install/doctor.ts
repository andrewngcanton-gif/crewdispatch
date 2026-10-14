import { REQUIRED_NODE_MAJOR, probeNodeRuntimePath } from "./node-runtime";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCliIsolation } from "../cli/run-isolation";
import { resolveCommandCodeCli } from "../providers/command-code/discovery";
import { MODEL_CATALOG_TIMEOUT_MS, PROBE_TIMEOUT_MS, readModelCatalog, runCliProbe } from "../providers/command-code/probe";
import { INSTALL_MARKER, inspectManagedTarget, NOTICE_FILE, NOTICE_REQUIRED_MARKERS, PRODUCT_LICENSE_FILE, PRODUCT_LICENSE_REQUIRED_MARKERS, RUNTIME_LICENSES } from "./manager";
import { POSIX_COMMAND_WRAPPERS } from "./manager";
import { inspectDashboardAutostart } from "./autostart";
import { MACOS_TEST_LAUNCHCTL_STATE_ENV } from "./autostart-macos";
import { inspectDataRootResolution, type DataRootResolutionOptions } from "../jobs/store";

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Minimal newline-delimited JSON-RPC process used by the MCP smoke probes. */
export class JsonLineProcess {
  readonly child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrValue = "";

  constructor(entry: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (this.stderrValue.length < 32 * 1024) this.stderrValue += chunk.toString("utf8").slice(0, 32 * 1024 - this.stderrValue.length);
    });
    const failPending = (reason: string): void => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
    };
    this.child.once("error", (error) => failPending(error.message));
    this.child.once("exit", (code, signal) => failPending(`process exited (${code ?? signal ?? "unknown"})`));
  }

  get stderr(): string {
    return this.stderrValue;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve((message.result as Record<string, unknown>) ?? {});
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      this.child.kill();
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function probeEnvironment(dataRoot: string, tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "PATHEXT", "COMSPEC", "SystemRoot", "WINDIR", "SYSTEMDRIVE"]) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  env.HOME = tempRoot;
  env.USERPROFILE = tempRoot;
  env.LOCALAPPDATA = path.join(tempRoot, "localappdata");
  env.APPDATA = path.join(tempRoot, "appdata");
  env.TEMP = path.join(tempRoot, "tmp");
  env.TMP = env.TEMP;
  env.TMPDIR = env.TEMP;
  env.JOBQUAY_DATA_ROOT = dataRoot;
  for (const dir of [env.LOCALAPPDATA, env.APPDATA, env.TEMP]) fs.mkdirSync(dir!, { recursive: true });
  return env;
}

async function probeMcp(target: string, tempRoot: string): Promise<Record<string, unknown>> {
  const dataRoot = path.join(tempRoot, "mcp-data");
  const env = probeEnvironment(dataRoot, tempRoot);
  const entry = path.join(target, "dist", "mcp", "server.js");
  const processHandle = new JsonLineProcess(entry, tempRoot, env);
  try {
    const initialized = await processHandle.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "jobquay-doctor", version: "1" }
      },
      10000
    );
    processHandle.notify("notifications/initialized", {});
    const listed = await processHandle.request("tools/list", {}, 10000);
    const serverInfo = initialized.serverInfo as Record<string, unknown> | undefined;
    const tools = Array.isArray(listed.tools) ? listed.tools.map((item) => String((item as Record<string, unknown>).name)) : [];
    const prefix = serverInfo?.name === "crewdispatch" ? "crewdispatch" : serverInfo?.name === "jobquay" ? "jobquay" : null;
    const ok = prefix !== null && tools.includes(`${prefix}_spawn`) && tools.includes(`${prefix}_result`);
    return { ok, serverName: serverInfo?.name ?? null, toolCount: tools.length, hasCoreTools: ok, dataRootIsTemporary: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e), stderr: processHandle.stderr.slice(-1000), dataRootIsTemporary: true };
  } finally {
    await processHandle.stop();
  }
}

async function waitForHubPort(child: ChildProcess, getStderr: () => string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(getStderr());
    if (match) return Number(match[1]);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Hub exited before listen (${child.exitCode ?? child.signalCode})`);
    if (Date.now() >= deadline) throw new Error("Hub listen timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function loopbackGet(port: number, requestPath: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: requestPath, timeout: timeoutMs },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    request.once("timeout", () => request.destroy(new Error("loopback_request_timeout")));
    request.once("error", reject);
  });
}

function platformCheck(): Record<string, unknown> {
  const supported = process.platform === "win32" || (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch));
  const status = supported ? "healthy" : "unsupported";
  return {
    ok: supported,
    status,
    platform: process.platform,
    arch: process.arch,
    supportedPlatforms: ["win32", "darwin-arm64", "darwin-x64"],
    ...(!supported
      ? { error: `Unsupported platform for this managed install: ${process.platform}/${process.arch}` }
      : {})
  };
}

function processHelperCheck(target: string): Record<string, unknown> {
  if (process.platform !== "darwin") {
    return { ok: true, status: "not_applicable", applicable: false, platform: process.platform };
  }
  if (!["arm64", "x64"].includes(process.arch)) {
    return { ok: false, status: "unsupported", applicable: true, platform: process.platform, arch: process.arch };
  }
  const helper = path.join(target, "dist", "native", "macos-process-info");
  try {
    const stat = fs.lstatSync(helper);
    const regular = stat.isFile() && !stat.isSymbolicLink();
    const executable = (stat.mode & 0o111) !== 0;
    const processProbe = regular && executable
      ? spawnSync(helper, ["process", String(process.pid)], { encoding: "utf8", timeout: 5000, windowsHide: true })
      : null;
    const bootProbe = regular && executable
      ? spawnSync(helper, ["boot"], { encoding: "utf8", timeout: 5000, windowsHide: true })
      : null;
    let processReply: Record<string, unknown> | null = null;
    let bootReply: Record<string, unknown> | null = null;
    try { processReply = processProbe?.status === 0 ? JSON.parse(processProbe.stdout || "{}") as Record<string, unknown> : null; } catch {}
    try { bootReply = bootProbe?.status === 0 ? JSON.parse(bootProbe.stdout || "{}") as Record<string, unknown> : null; } catch {}
    const processOk = processReply?.ok === true && processReply.op === "process" && Number(processReply.pid) === process.pid;
    const bootOk = bootReply?.ok === true && bootReply.op === "boot";
    const ok = regular && executable && processOk && bootOk;
    return {
      ok,
      status: ok ? "healthy" : "failed",
      applicable: true,
      path: helper,
      regular,
      executable,
      mode: stat.mode & 0o777,
      processProbe: { ok: processOk, exitCode: processProbe?.status ?? null },
      bootProbe: { ok: bootOk, exitCode: bootProbe?.status ?? null }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      applicable: true,
      path: helper,
      error: String((error as Error)?.message || error)
    };
  }
}

function wrappersCheck(target: string): Record<string, unknown> {
  const wrappers = POSIX_COMMAND_WRAPPERS.map(({ name, entry }) => {
    const file = path.join(target, "bin", process.platform === "win32" ? `${name}.cmd` : name);
    const expectedEntry = path.join(target, "dist", "cli", entry);
    try {
      const stat = fs.lstatSync(file);
      const regular = stat.isFile() && !stat.isSymbolicLink();
      const content = regular ? fs.readFileSync(file, "utf8") : "";
      const pointsAtInstalledEntry = content.replace(/%%/g, "%").includes(expectedEntry);
      let mode: number | null = null;
      let executable = true;
      let run: ReturnType<typeof spawnSync> | null = null;
      if (process.platform === "win32") {
        const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
        if (regular) {
          run = spawnSync(comspec, ["/d", "/s", "/v:off", "/c", `"\"${file}\" \"--help\""`], {
            cwd: os.tmpdir(),
            env: process.env,
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true,
            windowsVerbatimArguments: true
          });
        }
      } else {
        mode = stat.mode & 0o777;
        executable = (mode & 0o111) !== 0;
        if (regular && executable) {
          run = spawnSync(file, ["--help"], {
            cwd: os.tmpdir(),
            env: { ...process.env, PATH: "/usr/bin:/bin" },
            encoding: "utf8",
            timeout: 10000,
            windowsHide: true
          });
        }
      }
      const runs = run?.status === 0 && /CrewDispatch/.test(String(run.stdout || ""));
      const modeOk = process.platform === "win32" || mode === 0o755;
      return {
        name,
        path: file,
        ok: regular && executable && modeOk && pointsAtInstalledEntry && runs,
        regular,
        executable,
        mode,
        pointsAtInstalledEntry,
        runs,
        exitCode: run?.status ?? null
      };
    } catch (error) {
      return { name, path: file, ok: false, error: String((error as Error)?.message || error) };
    }
  });
  const ok = wrappers.every((item) => item.ok === true);
  return { ok, status: ok ? "healthy" : "failed", applicable: true, wrappers };
}

async function probeHub(target: string, tempRoot: string): Promise<Record<string, unknown>> {
  const dataRoot = path.join(tempRoot, "hub-data");
  const env = probeEnvironment(dataRoot, tempRoot);
  env.HUB_PORT = "0";
  // Hub startup never probes a provider: provider CLIs are spawned only by an
  // actual settings request, so this diagnostic smoke probe cannot start one.
  const entry = path.join(target, "dist", "hub", "server.js");
  const child = spawn(process.execPath, [entry], { cwd: tempRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 32 * 1024) stderr += chunk.toString("utf8").slice(0, 32 * 1024 - stderr.length);
  });
  try {
    const port = await waitForHubPort(child, () => stderr, 10000);
    const ui = await loopbackGet(port, "/ui", 5000);
    const ping = await loopbackGet(port, "/api/ping", 5000);
    const pingBody = JSON.parse(ping.body) as Record<string, unknown>;
    return {
      ok: ui.status === 200 && (ui.body.includes("CrewDispatch") || ui.body.includes("JobQuay")) && ping.status === 200 && pingBody.ok === true,
      uiStatus: ui.status,
      pingStatus: ping.status,
      pingOk: pingBody.ok === true,
      boundToLoopback: stderr.includes("127.0.0.1:"),
      dataRootIsTemporary: true
    };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e), stderr: stderr.slice(-1000), dataRootIsTemporary: true };
  } finally {
    try {
      child.kill();
    } catch {
      /* process already exited */
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function dependencyCheck(target: string): Record<string, unknown> {
  const resolved: Record<string, string | null> = {};
  for (const id of ["@modelcontextprotocol/server/stdio", "@modelcontextprotocol/core", "zod/v4"]) {
    try {
      resolved[id] = require.resolve(id, { paths: [target] });
    } catch {
      resolved[id] = null;
    }
  }
  const licenses = Object.fromEntries(RUNTIME_LICENSES.map((rel) => [rel, fs.existsSync(path.join(target, rel))]));
  return {
    ok: Object.values(resolved).every(Boolean) && Object.values(licenses).every(Boolean),
    resolved,
    licenseFiles: licenses
  };
}

/**
 * The installed notice bundle must still be the reviewed file: a regular file whose
 * SHA-256 equals the hash recorded in the install marker and which carries the
 * required third-party copyright lines. A user-modified copy fails this check.
 */
function noticeCheck(target: string, expectedSha256: string | null): Record<string, unknown> {
  const file = path.join(target, NOTICE_FILE);
  let sha256Value: string | null = null;
  let missingMarkers: string[] = [...NOTICE_REQUIRED_MARKERS];
  let error: string | null = null;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${NOTICE_FILE} is not a regular file`);
    const text = fs.readFileSync(file, "utf8");
    sha256Value = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    missingMarkers = NOTICE_REQUIRED_MARKERS.filter((marker) => !text.includes(marker));
  } catch (e) {
    error = String((e as Error).message || e);
  }
  const matchesMarker = sha256Value !== null && expectedSha256 !== null && sha256Value === expectedSha256;
  return {
    ok: error === null && matchesMarker && missingMarkers.length === 0,
    path: NOTICE_FILE,
    sha256: sha256Value,
    recordedSha256: expectedSha256,
    matchesInstallMarker: matchesMarker,
    missingMarkers,
    ...(error ? { error } : {})
  };
}

function productLicenseCheck(target: string, expectedSha256: string | null): Record<string, unknown> {
  const file = path.join(target, PRODUCT_LICENSE_FILE);
  let sha256Value: string | null = null;
  let missingMarkers: string[] = [...PRODUCT_LICENSE_REQUIRED_MARKERS];
  let error: string | null = null;
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${PRODUCT_LICENSE_FILE} is not a regular file`);
    const text = fs.readFileSync(file, "utf8");
    sha256Value = crypto.createHash("sha256").update(text, "utf8").digest("hex");
    missingMarkers = PRODUCT_LICENSE_REQUIRED_MARKERS.filter((marker) => !text.includes(marker));
  } catch (e) {
    error = String((e as Error).message || e);
  }
  const matchesMarker = sha256Value !== null && expectedSha256 !== null && sha256Value === expectedSha256;
  return {
    ok: error === null && matchesMarker && missingMarkers.length === 0,
    path: PRODUCT_LICENSE_FILE,
    spdx: "Apache-2.0",
    sha256: sha256Value,
    recordedSha256: expectedSha256,
    matchesInstallMarker: matchesMarker,
    missingMarkers,
    ...(error ? { error } : {})
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

interface TemporaryTreeRemoval {
  removed: boolean;
  error: string | null;
}

/** Yield between retries so Windows can release short-lived CLI temp-file locks. */
async function removeTemporaryTree(root: string): Promise<TemporaryTreeRemoval> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.promises.rm(root, { recursive: true, force: true });
      lastError = null;
    } catch (e) {
      lastError = String((e as Error).message || e);
    }
    if (!fs.existsSync(root)) return { removed: true, error: null };
    if (attempt < 9) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return { removed: false, error: lastError ?? "temporary directory still exists after recursive cleanup" };
}

async function commandCodeCheck(tempRoot: string): Promise<Record<string, unknown>> {
  const blockedRoots = [path.join(os.homedir(), ".codex"), path.join(os.homedir(), ".workbuddy")];
  const safeEnv: NodeJS.ProcessEnv = { ...process.env };
  const originalPath = typeof safeEnv.PATH === "string" ? safeEnv.PATH : "";
  safeEnv.PATH = originalPath
    .split(path.delimiter)
    .filter((entry) => {
      const resolved = path.resolve(entry || ".");
      return !blockedRoots.some((root) => {
        const rel = path.relative(root, resolved);
        return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
      });
    })
    .join(path.delimiter);
  const resolution = resolveCommandCodeCli({ env: safeEnv });
  if (!resolution.ok || !resolution.path) {
    return {
      ok: false,
      status: "unavailable",
      available: false,
      source: resolution.source,
      error: resolution.reason ?? "The Command Code CLI was not found in the configuration or on PATH.",
      probes: { version: { ok: false }, help: { ok: false }, catalog: { ok: false, count: 0 } }
    };
  }

  const resolvedPath = path.resolve(resolution.path);
  const blockedPath = blockedRoots.some((root) => {
    const rel = path.relative(root, resolvedPath);
    return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
  });
  if (blockedPath) {
    return {
      ok: false,
      status: "failed",
      available: false,
      source: resolution.source,
      error: "Resolved to a protected Codex or WorkBuddy directory; that path was not read or executed.",
      probes: { version: { ok: false }, help: { ok: false }, catalog: { ok: false, count: 0 } }
    };
  }

  const isolation = createCliIsolation({ baseDir: tempRoot, tempPrefix: "jobquay-doctor-cli-", env: safeEnv });
  let result: Record<string, unknown>;
  try {
    const input = { cliPath: resolution.path, env: isolation.env, cwd: isolation.cwd };
    const version = runCliProbe({ ...input, args: ["--version"], timeoutMs: PROBE_TIMEOUT_MS });
    const help = runCliProbe({ ...input, args: ["--help"], timeoutMs: PROBE_TIMEOUT_MS });
    const catalog = readModelCatalog({ ...input, timeoutMs: MODEL_CATALOG_TIMEOUT_MS });
    result = {
      ok: version.ok && help.ok && catalog.ok,
      status: version.ok && help.ok && catalog.ok ? "healthy" : "failed",
      available: true,
      source: resolution.source,
      cliPath: resolution.path,
      probes: {
        version: { ok: version.ok, exitCode: version.exitCode, output: version.stdout.trim().slice(0, 200), error: version.error },
        help: { ok: help.ok, exitCode: help.exitCode, bytes: help.stdout.length, mentionsCatalog: /list-models/i.test(help.stdout), error: help.error },
        catalog: {
          ok: catalog.ok,
          count: catalog.models.length,
          defaultModel: catalog.defaultModel,
          source: catalog.source,
          error: catalog.error
        }
      }
    };
  } catch (e) {
    const error = String((e as Error).message || e);
    result = {
      ok: false,
      available: true,
      status: "failed",
      source: resolution.source,
      cliPath: resolution.path,
      error,
      probes: { version: { ok: false }, help: { ok: false }, catalog: { ok: false, count: 0 } }
    };
  }
  const cleanup = await removeTemporaryTree(isolation.root);
  return {
    ...result,
    ok: result.ok === true && cleanup.removed,
    isolation: {
      credentialsForwarded: false,
      homeRedirected: true,
      temporaryDataRemoved: cleanup.removed,
      ...(cleanup.error ? { cleanupError: cleanup.error } : {})
    },
    ...(cleanup.error ? { cleanupError: cleanup.error } : {})
  };
}

export function inspectDataRootForDoctor(
  targetArg: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DataRootResolutionOptions = {}
): Record<string, unknown> {
  const target = path.resolve(targetArg);
  const resolution = inspectDataRootResolution(undefined, env, options);
  const platform = options.platform ?? process.platform;
  const selected = resolution.path;
  const normalizedTarget = platform === "win32" ? target.toLowerCase() : target;
  const normalizedRoot = selected == null
    ? null
    : platform === "win32"
      ? selected.toLowerCase()
      : selected;
  const outsideInstallDirectory =
    normalizedRoot != null &&
    !isWithin(normalizedTarget, normalizedRoot) &&
    !isWithin(normalizedRoot, normalizedTarget);
  return {
    ok: resolution.ok && outsideInstallDirectory,
    status: resolution.ok && outsideInstallDirectory ? "healthy" : "failed",
    path: selected,
    source: resolution.source,
    platform: resolution.platform,
    preferredPath: resolution.preferredPath,
    legacyPath: resolution.legacyPath,
    preferredExists: resolution.preferredExists,
    legacyExists: resolution.legacyExists,
    outsideInstallDirectory: selected == null ? null : outsideInstallDirectory,
    ...(resolution.error ? { error: resolution.error } : {})
  };
}

export async function doctor(targetArg: string): Promise<Record<string, unknown>> {
  const target = path.resolve(targetArg);
  const managed = inspectManagedTarget(targetArg);
  const markerOk = managed.marker !== null && managed.markerError === null;
  const safeToProbe = markerOk && managed.missingFiles.length === 0 && managed.modifiedFiles.length === 0;
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const markerPath = path.join(target, INSTALL_MARKER);
  const pluginDir = path.join(target, "plugins", "crewdispatch");
  const configPath = path.join(pluginDir, ".mcp.json");
  let configOk = false;
  let configuredEntry: string | null = null;
  let configuredNode: string | null = null;
  let configuredNodeRuntime: ReturnType<typeof probeNodeRuntimePath> = null;
  let configError: string | null = null;
  if (safeToProbe) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        mcpServers?: Partial<Record<"crewdispatch" | "jobquay", { command?: string; args?: string[] }>>;
      };
      const server = config.mcpServers?.crewdispatch ?? config.mcpServers?.jobquay;
      configuredEntry = server?.args?.[0] ?? null;
      configuredNode = typeof server?.command === "string" ? server.command : null;
      configuredNodeRuntime = configuredNode && path.isAbsolute(configuredNode) ? probeNodeRuntimePath(configuredNode) : null;
      configOk =
        !!configuredNode &&
        path.isAbsolute(configuredNode) &&
        configuredNodeRuntime !== null &&
        configuredNodeRuntime.major >= REQUIRED_NODE_MAJOR &&
        server?.args?.length === 1 &&
        !!configuredEntry &&
        path.isAbsolute(configuredEntry) &&
        path.resolve(configuredEntry) === path.join(target, "dist", "mcp", "server.js") &&
        fs.existsSync(configuredEntry);
    } catch (e) {
      configError = String((e as Error).message || e);
    }
  } else {
    configError = "Managed files did not pass the marker and hash checks; skipping local service probes to avoid following unverified paths.";
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-doctor-"));
  let runtime: Record<string, unknown>;
  let cmdc: Record<string, unknown>;
  let probeCleanup: TemporaryTreeRemoval = { removed: false, error: "temporary root cleanup was not attempted" };
  try {
    const [serviceChecks, commandCode] = await Promise.all([
      safeToProbe
        ? Promise.all([probeMcp(target, tempRoot), probeHub(target, tempRoot)])
        : Promise.resolve([
            { ok: false, skipped: true, error: "Install files did not pass the integrity check." },
            { ok: false, skipped: true, error: "Install files did not pass the integrity check." }
          ] as [Record<string, unknown>, Record<string, unknown>]),
      commandCodeCheck(tempRoot)
    ]);
    const [mcp, hub] = serviceChecks;
    runtime = { ok: mcp.ok === true && hub.ok === true, mcp, hub, dataRootsTemporary: true };
    cmdc = commandCode;
  } finally {
    probeCleanup = await removeTemporaryTree(tempRoot);
  }

  const platformInfo = platformCheck();
  const processHelper = safeToProbe ? processHelperCheck(target) : { ok: false, status: "failed", skipped: true, error: "Install files did not pass the integrity check." };
  const wrappers = safeToProbe ? wrappersCheck(target) : { ok: false, status: "failed", skipped: true, error: "Install files did not pass the integrity check." };
  const deps = safeToProbe ? dependencyCheck(target) : { ok: false, skipped: true, error: "Install files did not pass the integrity check." };
  const notices = safeToProbe
    ? noticeCheck(target, managed.marker?.managedFiles.find((file) => file.path === NOTICE_FILE)?.sha256 ?? null)
    : { ok: false, skipped: true, error: "Install files did not pass the integrity check." };
  const productLicense = safeToProbe
    ? productLicenseCheck(target, managed.marker?.managedFiles.find((file) => file.path === PRODUCT_LICENSE_FILE)?.sha256 ?? null)
    : { ok: false, skipped: true, error: "Install files did not pass the integrity check." };
  const dataRootCheck = inspectDataRootForDoctor(target, process.env);
  const dataRootForReadOnlyDiagnostics =
    typeof dataRootCheck.path === "string"
      ? dataRootCheck.path
      : String(dataRootCheck.preferredPath);
  // Read-only: reports whether the user-scoped login autostart is registered for
  // THIS installation. An ambiguous macOS data root stays a failed doctor check;
  // the preferred path below is used only so the unsupported/read-only autostart
  // diagnostic itself does not hide that ambiguity by throwing first.
  const autostart = await inspectDashboardAutostart({
    target,
    env: process.env,
    dataRoot: dataRootForReadOnlyDiagnostics,
    // The emulated launchctl state is a TEST-ONLY registration seam: it records
    // load/unload intent but intentionally never launches a real login process.
    // Probing the live Hub under that seam makes a healthy package depend on an
    // unrelated process having occupied the default port earlier in the suite.
    // Production has no such variable and keeps the live endpoint probe.
    probeHub: process.platform === "darwin" && process.env[MACOS_TEST_LAUNCHCTL_STATE_ENV] ? false : undefined
  });
  const pluginResources = {
    manifest: safeToProbe && fs.existsSync(path.join(pluginDir, ".codex-plugin", "plugin.json")),
    skill: safeToProbe && fs.existsSync(path.join(pluginDir, "skills", "crewdispatch", "SKILL.md")),
    template: safeToProbe && fs.existsSync(path.join(pluginDir, "mcp.template.json"))
  };
  const checks = {
    platform: platformInfo,
    node: { ok: nodeMajor >= REQUIRED_NODE_MAJOR, status: nodeMajor >= REQUIRED_NODE_MAJOR ? "healthy" : "failed", version: process.version, required: `>=${REQUIRED_NODE_MAJOR}` },
    processHelper,
    wrappers,
    target: {
      ok: markerOk,
      path: target,
      marker: fs.existsSync(markerPath),
      markerError: managed.markerError,
      missingFiles: managed.missingFiles,
      modifiedFiles: managed.modifiedFiles,
      unownedFiles: managed.unownedFiles
    },
    plugin: {
      ok: configOk && Object.values(pluginResources).every(Boolean),
      config: configOk,
      entry: configuredEntry,
      node: configuredNode ? { path: configuredNode, version: configuredNodeRuntime?.version ?? null, major: configuredNodeRuntime?.major ?? null, required: `>=${REQUIRED_NODE_MAJOR}`, ok: configuredNodeRuntime !== null && configuredNodeRuntime.major >= REQUIRED_NODE_MAJOR } : null,
      error: configError,
      resources: pluginResources
    },
    dependencies: deps,
    notices,
    productLicense,
    autostart,
    commandCode: cmdc,
    probeCleanup: {
      ok: probeCleanup.removed,
      temporaryDataRemoved: probeCleanup.removed,
      ...(probeCleanup.error ? { error: probeCleanup.error } : {})
    },
    runtime,
    dataRoot: dataRootCheck
  };
  const ok =
    checks.platform.ok === true &&
    checks.node.ok &&
    checks.processHelper.ok === true &&
    checks.wrappers.ok === true &&
    checks.target.ok &&
    checks.target.missingFiles.length === 0 &&
    checks.target.modifiedFiles.length === 0 &&
    checks.plugin.ok &&
    deps.ok === true &&
    notices.ok === true &&
    productLicense.ok === true &&
    autostart.ok === true &&
    (cmdc.ok === true) &&
    checks.probeCleanup.ok &&
    runtime.ok === true &&
    checks.dataRoot.ok;
  const status =
    checks.platform.ok !== true
      ? "unsupported"
      : ok
        ? (autostart.status === "disabled" ? "degraded" : "healthy")
        : "failed";
  const nextSteps = ok
    ? []
    : [
        "Fix the items marked as failed in checks, then run doctor again.",
        ...(dataRootCheck.ok === true
          ? []
          : [String(dataRootCheck.error ?? "Choose a data root outside the installation directory and run doctor again.")]),
        ...(autostart.ok === true
          ? []
          : [`The Dashboard login autostart is not registered or unavailable; re-register it with crewdispatch autostart enable --target "${target}" for ${target}, or turn it off explicitly with autostart disable (this feature only affects the Dashboard, not job execution).`])
      ];
  return {
    ok,
    command: "doctor",
    status,
    target,
    sourceCheckoutUsedAtRuntime: false,
    dataRoot: `resolved via ${String(dataRootCheck.source)}; separate from the installation directory; runtime and CLI metadata probes used isolated temporary roots`,
    checks,
    nextSteps
  };
}
