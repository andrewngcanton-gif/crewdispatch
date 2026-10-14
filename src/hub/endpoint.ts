// endpoint.ts — the ONE durable, CrewDispatch-owned record of "which Hub currently
// owns this data root".
//
// A data root may be served by at most ONE authoritative Hub at a time. The
// record lives at `<root>/hub/endpoint.json` and is written by a Hub when it
// starts listening and cleared when it exits cleanly. It carries enough bounded
// identity to answer, without trusting a PID or a port number alone:
//
//   * `instance_id` — a random per-Hub-instance token. Two Hubs started from
//     the same process (tests) still get distinct tokens, so ownership is never
//     confused by a shared PID.
//   * `root_id`     — a short, non-reversible fingerprint of the resolved data
//     root, so a recorded port that has since been taken over by a DIFFERENT
//     data root's Hub is never mistaken for this root's owner.
//   * `build_id` / `version` — the build this owner snapshotted at startup.
//
// The record is advisory INPUT to identity proof, never proof by itself: any
// retirement decision must still confirm a live CrewDispatch Hub (see
// `probeHubOwner`). This module is deliberately dependency-free (node builtins
// only) so it can be imported from both the Hub server and the job-approval
// discovery path without an import cycle.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HUB_ENDPOINT_PRODUCT = "jobquay";
export const HUB_ENDPOINT_KIND = "jobquay-hub-endpoint";

/** The durable "current Hub" record for one data root. */
export interface HubEndpointRecord {
  product: typeof HUB_ENDPOINT_PRODUCT;
  kind: typeof HUB_ENDPOINT_KIND;
  /** The Hub's loopback listen port. */
  port: number;
  /** The owning process id (diagnostic only — never proof on its own). */
  pid: number;
  /** Random per-Hub-instance token; empty only for a legacy record. */
  instance_id: string;
  /** The build the owner snapshotted (null when unavailable). */
  build_id: string | null;
  version: string | null;
  /** Fingerprint of the resolved data root; empty only for a legacy record. */
  root_id: string;
  /** ISO instant the record was written. */
  at: string;
}

/** The fields a caller supplies; product/kind/at are filled in by the writer. */
export interface HubEndpointInput {
  port: number;
  pid: number;
  instanceId?: string;
  buildId?: string | null;
  version?: string | null;
  rootId?: string;
  at?: string;
}

export function hubEndpointPath(root: string): string {
  return path.join(root, "hub", "endpoint.json");
}

/** A short, stable, non-reversible fingerprint of a resolved data root. */
export function dataRootId(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

/** A fresh random token identifying ONE Hub instance (process or embedded). */
export function newHubInstanceId(): string {
  return crypto.randomBytes(12).toString("hex");
}

/** Defensive: a computed path must stay inside the root. */
function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function validPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;
}

function validPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Read the current endpoint record, or null when it is absent, unreadable,
 * malformed or outside the root. A legacy `{port,pid,at}` record is still read
 * (with empty identity fields) so a pre-upgrade owner remains discoverable.
 */
export function readHubEndpoint(root: string): HubEndpointRecord | null {
  const file = hubEndpointPath(root);
  if (!insideRoot(root, file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  const port = validPort(r.port);
  const pid = validPid(r.pid);
  if (port === null || pid === null) return null;
  return {
    product: HUB_ENDPOINT_PRODUCT,
    kind: HUB_ENDPOINT_KIND,
    port,
    pid,
    instance_id: asOptionalString(r.instance_id) ?? "",
    build_id: asOptionalString(r.build_id),
    version: asOptionalString(r.version),
    root_id: asOptionalString(r.root_id) ?? "",
    at: asOptionalString(r.at) ?? ""
  };
}

/** Atomically write the current endpoint record (temp file + rename). */
export function writeHubEndpoint(root: string, input: HubEndpointInput): void {
  const file = hubEndpointPath(root);
  if (!insideRoot(root, file)) return;
  const record: HubEndpointRecord = {
    product: HUB_ENDPOINT_PRODUCT,
    kind: HUB_ENDPOINT_KIND,
    port: input.port,
    pid: input.pid,
    instance_id: input.instanceId ?? "",
    build_id: input.buildId ?? null,
    version: input.version ?? null,
    root_id: input.rootId ?? dataRootId(root),
    at: input.at ?? new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, JSON.stringify(record), "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* best effort */
    }
  } finally {
    fs.closeSync(fd);
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastError = e;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      } catch {
        /* the next attempt is immediate */
      }
    }
  }
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* best effort */
  }
  throw new Error(`atomic write failed for ${file}: ${String((lastError as Error)?.message || lastError)}`);
}

/**
 * Remove the endpoint record only when it still belongs to this owner. Match on
 * `instanceId` when given (preferred — never confused by a shared PID), else on
 * `pid` for callers that only have one.
 */
export function clearHubEndpoint(root: string, owner: { instanceId?: string; pid?: number }): void {
  const record = readHubEndpoint(root);
  if (!record) return;
  const matches = owner.instanceId
    ? record.instance_id === owner.instanceId
    : owner.pid != null
      ? record.pid === owner.pid
      : false;
  if (!matches) return;
  try {
    fs.rmSync(hubEndpointPath(root), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Prove whether the CrewDispatch Hub a record names is still live AND belongs to the
 * SAME data root AND is the SAME instance the record names. Only a
 * `service: "jobquay"` ping that also confirms the recorded `root_id` AND the
 * recorded `instance_id` counts — anything else (a foreign listener, another
 * root's Hub, a dead process, or a DIFFERENT instance now holding the recorded
 * port) is never treated as this record's owner.
 *
 * The instance check is what makes port reuse safe: when a replacement Hub
 * starts on the port a dead owner left behind, the ping answers as the
 * REPLACEMENT, so a record naming the old instance must never be mistaken for
 * a live owner (that mistake made a Hub redirect to itself and drop the
 * approval deep link — JQ-INC-20261005-HUB-OWNERSHIP).
 *
 * A legacy record (empty `instance_id`) falls back to the service + root
 * identity, exactly as before; it can never confirm a specific instance.
 */
export async function probeHubOwner(
  record: Pick<HubEndpointRecord, "port" | "root_id"> & Partial<Pick<HubEndpointRecord, "instance_id">>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 800
): Promise<boolean> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${record.port}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json()) as Record<string, unknown>;
    if (body?.ok !== true || body?.service !== HUB_ENDPOINT_PRODUCT) return false;
    // A recorded root MUST be confirmed by the live process: a record with a
    // root fingerprint only matches a ping that reports the SAME fingerprint
    // (an owner that cannot prove the root is not trusted). A legacy record
    // (empty root_id) falls back to the CrewDispatch service identity alone.
    if (record.root_id && body.root_id !== record.root_id) return false;
    // A recorded instance MUST be confirmed by the live process: a replacement
    // that reused the recorded port answers with a DIFFERENT instance id and is
    // therefore not the recorded owner. A legacy record (empty instance_id)
    // has no instance to confirm and keeps the service+root contract.
    if (record.instance_id && body.instance_id !== record.instance_id) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort retirement of the PREVIOUS recorded owner when it is a live,
 * same-root CrewDispatch Hub of the SAME recorded instance on a DIFFERENT port.
 * The request is the existing loopback, same-origin-guarded `POST
 * /api/hub/shutdown`; nothing is ever sent to a listener that did not just
 * identify itself as this exact recorded owner, and a foreign listener or a
 * DIFFERENT instance that reused the recorded port is therefore never touched.
 * Never throws.
 */
export async function retireHubEndpoint(
  previous: HubEndpointRecord | null,
  options: { currentPort: number; root: string; startedAtMs?: number; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<boolean> {
  if (!previous) return false;
  if (previous.port === options.currentPort) return false;
  if (previous.root_id && previous.root_id !== dataRootId(options.root)) return false;
  // Only retire an OLDER owner. A record written after this process started
  // belongs to a concurrent start; retiring it could destroy the winner.
  if (options.startedAtMs != null) {
    const at = Date.parse(previous.at);
    if (!Number.isFinite(at) || at > options.startedAtMs) return false;
  }
  if (!(await probeHubOwner(previous, options.fetchImpl ?? fetch, options.timeoutMs ?? 3000))) return false;
  try {
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${previous.port}/api/hub/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
