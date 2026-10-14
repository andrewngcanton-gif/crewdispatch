// Native resources belong to one accepted job generation, not a global warm pool.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPidAlive } from "../../runtime/process";
import type { ProviderResourceMaintenanceInput } from "../provider";

export interface RuntimeTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}
export interface OwnedRuntime {
  sessionId: string;
  runtimeId?: string;
  pid?: number;
}
interface RuntimeReceipt extends OwnedRuntime {
  version: 1;
  jobId: string;
  generation: number;
  attempts: number;
  released: boolean;
  promptSettled: boolean;
  lastFailure: string | null;
}
const PREFIX = "jobquay-job-v3-";
const MAX_CLEANUP_ATTEMPTS = 3;
const CONTROL_MS = 5_000;
const MAX_PER_PASS = 4;

export function jobRuntimeId(
  dataRoot: string,
  jobId: string,
  generation: number,
  platform: NodeJS.Platform = process.platform
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid WorkBuddy runtime owner.");
  }
  const resolvedRoot = path.resolve(dataRoot);
  const rootKey = platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const key = [rootKey, jobId, String(generation)].join("\n");
  return PREFIX + crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}
function receiptsDir(root: string): string {
  return path.join(root, "provider-runtime", "workbuddy-ai");
}
function receiptPath(root: string, sessionId: string): string {
  if (!/^jobquay-job-v3-[a-f0-9]{24}$/.test(sessionId)) throw new Error("Unowned WorkBuddy runtime.");
  return path.join(receiptsDir(root), sessionId + ".json");
}
function save(root: string, record: RuntimeReceipt): void {
  const file = receiptPath(root, record.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function registerOwnedRuntime(root: string, jobId: string, generation: number, runtime: OwnedRuntime): void {
  if (runtime.sessionId !== jobRuntimeId(root, jobId, generation) || !runtime.runtimeId || !Number.isSafeInteger(runtime.pid) || runtime.pid! <= 0) {
    throw new Error("WorkBuddy did not prove its private runtime identity.");
  }
  save(root, { ...runtime, version: 1, jobId, generation, attempts: 0, released: false, promptSettled: false, lastFailure: null });
}

function readReceipt(root: string, sessionId: string, history = false): RuntimeReceipt | null {
  try {
    const file = history ? path.join(receiptsDir(root), "history", sessionId + ".json") : receiptPath(root, sessionId);
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeReceipt;
    if (r.version !== 1 || r.sessionId !== sessionId || r.sessionId !== jobRuntimeId(root, r.jobId, r.generation) ||
        typeof r.runtimeId !== "string" || !r.runtimeId || !Number.isSafeInteger(r.pid) || r.pid! <= 0 ||
        !Number.isSafeInteger(r.attempts) || r.attempts < 0 || typeof r.released !== "boolean" || typeof r.promptSettled !== "boolean") return null;
    return r;
  } catch { return null; }
}
function readReceipts(root: string): RuntimeReceipt[] {
  let names: string[];
  try { names = fs.readdirSync(receiptsDir(root)); } catch { return []; }
  return names.filter(n => /^jobquay-job-v3-[a-f0-9]{24}\.json$/.test(n)).slice(0, 512)
    .map(n => readReceipt(root, n.slice(0, -5))).filter((r): r is RuntimeReceipt => r !== null);
}
function archiveReceipt(root: string, record: RuntimeReceipt): void {
  const dir = path.join(receiptsDir(root), "history");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, record.sessionId + ".json"), JSON.stringify(record), { mode: 0o600 });
  fs.unlinkSync(receiptPath(root, record.sessionId));
}

/** Native opaque runtime identity guards against session-id reuse. No raw PID signals. */
export async function disposeOwnedRuntime(
  transport: RuntimeTransport,
  runtime: OwnedRuntime,
  alive: (pid: number) => boolean | null = isPidAlive
): Promise<boolean> {
  if (!runtime.runtimeId || !Number.isSafeInteger(runtime.pid) || runtime.pid! <= 0) return false;
  const listed = await transport.request("session.list", {}, CONTROL_MS);
  if (!Array.isArray(listed)) return false;
  const current = listed.find((r: OwnedRuntime) => r?.sessionId === runtime.sessionId) as OwnedRuntime | undefined;
  if (current) {
    // Installed session.list omits runtimeId; session.kill itself enforces the opaque nonce.
    if ((current.runtimeId != null && current.runtimeId !== runtime.runtimeId) || current.pid !== runtime.pid) return false;
    await transport.request("session.kill", { sessionId: runtime.sessionId, expectedRuntimeId: runtime.runtimeId }, CONTROL_MS);
    const after = await transport.request("session.list", {}, CONTROL_MS);
    if (!Array.isArray(after) || after.some((r: OwnedRuntime) => r?.sessionId === runtime.sessionId)) return false;
  }
  // Removed from the native registry is not the same as the OS process having exited.
  const deadline = Date.now() + 2_000;
  while (alive(runtime.pid!) !== false) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  return true;
}

export function markRuntimeSettled(root: string, runtime: OwnedRuntime): void {
  const record = readReceipt(root, runtime.sessionId);
  if (!record || record.runtimeId !== runtime.runtimeId) throw new Error("Runtime settlement identity unknown.");
  record.promptSettled = true;
  save(root, record);
}

export function registeredJobRuntime(root: string, jobId: string, generation: number): OwnedRuntime | null {
  const id = jobRuntimeId(root, jobId, generation);
  return readReceipt(root, id) ?? readReceipt(root, id, true);
}

export function ownsJobRuntime(root: string, jobId: string, generation: number): boolean {
  const id = jobRuntimeId(root, jobId, generation);
  return readReceipt(root, id) != null || readReceipt(root, id, true) != null;
}

export async function releaseRegisteredRuntime(root: string, transport: RuntimeTransport, runtime: OwnedRuntime): Promise<boolean> {
  const record = readReceipt(root, runtime.sessionId);
  if (!record || record.runtimeId !== runtime.runtimeId) return false;
  if (record.released) return true;
  if (record.attempts >= MAX_CLEANUP_ATTEMPTS) return false;
  record.attempts += 1;
  record.lastFailure = "cleanup_unconfirmed";
  save(root, record); // Persist the attempt before a native control request.
  try {
    if (await disposeOwnedRuntime(transport, record)) {
      record.released = true;
      record.lastFailure = null;
      archiveReceipt(root, record); // Preserve identity without filling the active sweep queue.
      return true;
    }
  } catch { /* Preserve the receipt for bounded daemon cleanup. */ }
  return false;
}

export function eligibleRuntimeReceipts(input: ProviderResourceMaintenanceInput): RuntimeReceipt[] {
  const safe = new Map(input.terminalAttempts.map(t => [t.jobId + "\n" + t.generation, t.turnResolved]));
  return readReceipts(input.dataRoot).filter(r => !r.released && r.attempts < MAX_CLEANUP_ATTEMPTS && safe.has(r.jobId + "\n" + r.generation) && (r.promptSettled || safe.get(r.jobId + "\n" + r.generation) === true)).slice(0, MAX_PER_PASS);
}

export async function reclaimOwnedRuntimes(input: ProviderResourceMaintenanceInput, transport: RuntimeTransport): Promise<void> {
  for (const record of eligibleRuntimeReceipts(input)) await releaseRegisteredRuntime(input.dataRoot, transport, record);
}
