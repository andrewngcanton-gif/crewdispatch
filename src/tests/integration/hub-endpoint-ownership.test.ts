// hub-endpoint-ownership.test.ts — regression for JQ-20261001-29 and
// JQ-20261005-55.
//
// Defect JQ-20261001-29: restarting/opening the Dashboard could leave an OLDER
// same-data-root CrewDispatch Hub alive on a different loopback port, so an
// already-open browser tab kept serving the obsolete UI even though the durable
// endpoint (and the new build) pointed at a different port.
//
// The fix makes the durable endpoint the ONE authoritative record and gives the
// Hub an ownership self-check: once a different live same-root Hub owns the
// endpoint, the old Hub stops serving (redirect/refuse) and, when it started as
// the real CLI Hub, is retired. Identity is proven with a live CrewDispatch ping for
// the same root — a foreign listener is never killed.
//
// Defect JQ-20261005-55: the identity proof did not confirm the RECORDED
// INSTANCE, so a replacement Hub that reused the port of a dead owner was
// mistaken for the old owner: the live replacement redirected /ui to ITSELF and
// dropped the approval deep-link query (production: durable endpoint named
// instance 43980946…/PID 17892 at port 30080 while the live replacement at that
// port was instance d6eb3738…/PID 11136). The proof now requires the recorded
// instance id, a same-port record is reconciled instead of redirecting, and a
// real other-owner redirect carries the original query string.
//
// Evidence layers (real loopback processes unless stated):
//   A — Hub A then newer Hub B, same root: endpoint moves to B and A is retired
//       or answers as superseded;
//   B — a foreign listener recorded on the endpoint port is never touched;
//   C — stale endpoint metadata from a dead process never blocks startup;
//   D — an already-open old Hub/tab gets a redirect / explicit stale response
//       (and its health probe stays truthful) after ownership moves;
//   E — concurrent same-port starts converge to one authoritative Hub;
//   F — a stale record naming a DEAD instance on the SAME port as the live Hub
//       is reconciled (200, no self-redirect, no lost deep link);
//   G — a real other-owner redirect preserves the approval deep link;
//   H — a wrong/stale instance record cannot retire the live Hub on that port.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dataRootId, readHubEndpoint, retireHubEndpoint, writeHubEndpoint } from "../../hub/endpoint";
import { startHub, type HubHandle } from "../../hub/server";

const HUB_ENTRY = path.join(__dirname, "..", "..", "hub", "server.js");

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

function spawnHub(port: number, root: string): ChildProcess {
  return spawn(process.execPath, [HUB_ENTRY], {
    env: { ...process.env, HUB_PORT: String(port), JOBQUAY_DATA_ROOT: root },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
}

async function pingBody(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return body?.ok === true && body?.service === "jobquay" ? body : null;
  } catch {
    return null;
  }
}

async function waitReady(port: number, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await pingBody(port);
    if (body) return body;
    if (Date.now() > deadline) throw new Error(`Hub on port ${port} never became ready`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function kill(child: ChildProcess | null): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopHub(handle: HubHandle | null): Promise<void> {
  if (!handle) return;
  handle.server.closeAllConnections?.();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
}

function tmpRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-ownership-${name}-`));
}

// ---------------------------------------------------------------------------
// A — Hub A then newer Hub B (same root): endpoint moves to B, A stops serving
// ---------------------------------------------------------------------------

test("JQ-20261001-29: a newer same-root Hub takes the endpoint and the older one stops serving", { timeout: 60000 }, async () => {
  const root = tmpRoot("supersede");
  const portA = await freePort();
  const portB = await freePort();
  let a: ChildProcess | null = null;
  let b: ChildProcess | null = null;
  try {
    a = spawnHub(portA, root);
    await waitReady(portA);
    const epA = readHubEndpoint(root);
    assert.ok(epA, "Hub A must claim the durable endpoint");
    assert.equal(epA.port, portA);
    assert.ok(epA.instance_id, "the record carries the Hub instance identity");
    assert.equal(epA.root_id, dataRootId(root));

    b = spawnHub(portB, root);
    const pingB = await waitReady(portB);

    await waitFor(
      () => {
        const ep = readHubEndpoint(root);
        return !!ep && ep.port === portB && ep.instance_id !== epA.instance_id;
      },
      8000,
      "the endpoint to move to Hub B"
    );

    // Hub A must no longer serve the current UI: either it was retired (the
    // connection is refused) or it answers as superseded (redirect/409).
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${portA}/ui`, { redirect: "manual", signal: AbortSignal.timeout(600) });
          return response.status === 302 || response.status === 409;
        } catch {
          return true;
        }
      },
      10000,
      "Hub A to be retired or to answer as superseded"
    );

    // Hub A was the recorded previous owner, so Hub B's start retired it.
    const pidA = a.pid;
    await waitFor(() => !isAlive(pidA), 10000, "Hub A to be retired by Hub B");

    // Hub B serves the current Dashboard, and the endpoint resolves to B.
    const uiB = await fetch(`http://127.0.0.1:${portB}/ui`);
    assert.equal(uiB.status, 200);
    const finalEndpoint = readHubEndpoint(root);
    assert.ok(finalEndpoint);
    assert.equal(finalEndpoint.port, portB);
    assert.equal(finalEndpoint.build_id, pingB.build_id, "the endpoint names the build Hub B reports");
  } finally {
    kill(b);
    kill(a);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B — a foreign listener recorded on the endpoint port is never touched
// ---------------------------------------------------------------------------

test("JQ-20261001-29: a foreign listener on a recorded port is never killed or asked to exit", { timeout: 60000 }, async () => {
  const root = tmpRoot("foreign");
  const portB = await freePort();
  const requests: Array<{ method: string; url: string }> = [];
  const foreign = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "not-jobquay" }));
  });
  await new Promise<void>((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(0, "127.0.0.1", resolve);
  });
  const foreignPort = (foreign.address() as net.AddressInfo).port;
  let b: ChildProcess | null = null;
  try {
    // Simulate a stale record whose port has since been taken over by a foreign
    // service for the SAME root.
    writeHubEndpoint(root, {
      port: foreignPort,
      pid: 999999,
      instanceId: "ghost",
      rootId: dataRootId(root),
      at: "2026-10-01T00:00:00.000Z"
    });

    b = spawnHub(portB, root);
    await waitReady(portB);

    const endpoint = readHubEndpoint(root);
    assert.ok(endpoint);
    assert.equal(endpoint.port, portB, "Hub B claims the endpoint");

    // The foreign service is still serving, and it was never sent a shutdown.
    const alive = await fetch(`http://127.0.0.1:${foreignPort}/`);
    assert.equal(alive.status, 200);
    assert.equal(
      requests.some((r) => r.method === "POST" && r.url.includes("/api/hub/shutdown")),
      false,
      "a foreign listener must never receive a shutdown request"
    );
  } finally {
    kill(b);
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C — stale endpoint metadata from a dead process never blocks startup
// ---------------------------------------------------------------------------

test("JQ-20261001-29: stale endpoint metadata from a dead process does not block startup", { timeout: 60000 }, async () => {
  const root = tmpRoot("dead-metadata");
  const deadPort = await freePort(); // opened and closed: nothing listens
  const portB = await freePort();
  let b: ChildProcess | null = null;
  try {
    writeHubEndpoint(root, {
      port: deadPort,
      pid: 424242,
      instanceId: "dead-instance",
      rootId: dataRootId(root),
      at: "2026-01-01T00:00:00.000Z"
    });

    b = spawnHub(portB, root);
    await waitReady(portB); // must not be blocked by the stale record

    const endpoint = readHubEndpoint(root);
    assert.ok(endpoint);
    assert.equal(endpoint.port, portB);
    assert.notEqual(endpoint.instance_id, "dead-instance");
  } finally {
    kill(b);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E — concurrent same-port starts converge to ONE authoritative current Hub
// ---------------------------------------------------------------------------

test("JQ-20261001-29: concurrent same-port starts converge to one authoritative Hub", { timeout: 60000 }, async () => {
  const root = tmpRoot("race");
  const port = await freePort();
  const first = spawnHub(port, root);
  const second = spawnHub(port, root);
  try {
    const ping = await waitReady(port);
    // The endpoint must name exactly the process that answers on the port.
    const endpoint = readHubEndpoint(root);
    assert.ok(endpoint, "the winning Hub must own the endpoint");
    assert.equal(endpoint.port, port);
    assert.equal(endpoint.instance_id, ping.instance_id, "the endpoint names the live owner, not a loser");
    assert.equal(endpoint.build_id, ping.build_id);
  } finally {
    kill(first);
    kill(second);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F — a stale record naming a DEAD instance on the SAME port is reconciled
// ---------------------------------------------------------------------------

test("JQ-20261005-55: a stale same-port record is reconciled to the live instance instead of a self-redirect", { timeout: 60000 }, async () => {
  const root = tmpRoot("same-port-stale");
  const port = await freePort();
  let hub: ChildProcess | null = null;
  try {
    hub = spawnHub(port, root);
    const live = await waitReady(port);
    const claimed = readHubEndpoint(root);
    assert.ok(claimed);
    assert.equal(claimed.instance_id, live.instance_id);

    // The production shape: the durable record still names the DEAD previous
    // instance (old instance id / old PID) on the SAME port the live
    // replacement holds.
    writeHubEndpoint(root, {
      port,
      pid: 17892,
      instanceId: "43980946a5e83863d8c7d041",
      rootId: dataRootId(root),
      at: "2026-10-05T00:00:00.000Z"
    });

    const ui = await fetch(`http://127.0.0.1:${port}/ui`, { redirect: "manual" });
    assert.equal(ui.status, 200, "a stale same-port record must never make the live Hub redirect to itself");
    assert.equal(ui.headers.get("x-jobquay-hub"), null, "the live Hub must not answer as superseded");

    const deep = await fetch(`http://127.0.0.1:${port}/ui?job=JQ-20261005-55&generation=1&request=req-1`, { redirect: "manual" });
    assert.equal(deep.status, 200, "the approval deep link must be served, not redirected away");

    const api = await fetch(`http://127.0.0.1:${port}/api/jobs?limit=50&offset=0`);
    assert.equal(api.status, 200, "API reads must not answer hub_superseded for a stale same-port record");

    // The endpoint is reconciled to the ACTUAL live instance, so repeated
    // access can never loop.
    await waitFor(
      () => {
        const ep = readHubEndpoint(root);
        return !!ep && ep.instance_id === live.instance_id && ep.port === port;
      },
      5000,
      "the endpoint to be re-claimed by the live Hub"
    );
    const again = await fetch(`http://127.0.0.1:${port}/ui`, { redirect: "manual" });
    assert.equal(again.status, 200);
  } finally {
    kill(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G — a real other-owner redirect preserves the approval deep link
// ---------------------------------------------------------------------------

test("JQ-20261005-55: an other-owner redirect preserves the approval deep link and never targets itself", { timeout: 60000 }, async () => {
  const root = tmpRoot("deep-link");
  const portA = await freePort();
  const portB = await freePort();
  let a: ChildProcess | null = null;
  let b: HubHandle | null = null;
  try {
    a = spawnHub(portA, root);
    await waitReady(portA);

    // Hub B is EMBEDDED (no retirement side effect), so Hub A is definitely
    // still alive and we can observe its superseded responses.
    b = startHub({ root, port: portB, host: "127.0.0.1", env: { JOBQUAY_DATA_ROOT: root } });
    await new Promise<void>((resolve, reject) => {
      b!.server.once("listening", () => resolve());
      b!.server.once("error", reject);
    });
    const pingB = await waitReady(portB);

    const deep = "/ui?job=JQ-20261005-55&generation=2&request=req-2";
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${portA}${deep}`, { redirect: "manual", signal: AbortSignal.timeout(600) });
          return response.status === 302;
        } catch {
          return false;
        }
      },
      8000,
      "the old Hub's deep-link page load to redirect"
    );

    const page = await fetch(`http://127.0.0.1:${portA}${deep}`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(
      page.headers.get("location"),
      `http://127.0.0.1:${portB}/ui?job=JQ-20261005-55&generation=2&request=req-2`,
      "the redirect must preserve the approval deep-link query"
    );
    assert.equal(page.headers.get("x-jobquay-hub"), "superseded");
    assert.equal(page.headers.get("x-jobquay-current-endpoint"), `http://127.0.0.1:${portB}`);
    assert.equal(
      String(page.headers.get("location")).includes(`:${portA}/`),
      false,
      "a superseded Hub must never redirect to itself"
    );

    // The current Hub serves the same deep link.
    const current = await fetch(`http://127.0.0.1:${portB}${deep}`, { redirect: "manual" });
    assert.equal(current.status, 200);
    assert.equal(readHubEndpoint(root)?.instance_id, pingB.instance_id);
  } finally {
    await stopHub(b);
    kill(a);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// H — a wrong-instance record cannot retire the live Hub on that port
// ---------------------------------------------------------------------------

test("JQ-20261005-55: a record naming a wrong/stale instance cannot retire the live Hub that reused the port", { timeout: 60000 }, async () => {
  const root = tmpRoot("wrong-instance");
  const port = await freePort();
  const otherPort = await freePort();
  let hub: ChildProcess | null = null;
  try {
    hub = spawnHub(port, root);
    const live = await waitReady(port);

    writeHubEndpoint(root, {
      port,
      pid: 424242,
      instanceId: "ghost-instance",
      rootId: dataRootId(root),
      at: "2026-10-01T00:00:00.000Z"
    });

    const retired = await retireHubEndpoint(readHubEndpoint(root), {
      currentPort: otherPort,
      root,
      startedAtMs: Date.now()
    });
    assert.equal(retired, false, "a record that does not name the live instance must not retire it");

    // The live Hub is untouched: still answering its own ping and serving the UI.
    const ping = await pingBody(port);
    assert.ok(ping);
    assert.equal(ping.instance_id, live.instance_id);
    const ui = await fetch(`http://127.0.0.1:${port}/ui`, { redirect: "manual" });
    assert.equal(ui.status, 200);
  } finally {
    kill(hub);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D — an already-open old Hub/tab cannot keep serving stale UI
// ---------------------------------------------------------------------------

test("JQ-20261001-29: an old Hub redirects page loads and refuses API/asset reads after ownership moves", { timeout: 60000 }, async () => {
  const root = tmpRoot("stale-tab");
  const portA = await freePort();
  const portB = await freePort();
  let a: ChildProcess | null = null;
  let b: HubHandle | null = null;
  try {
    a = spawnHub(portA, root);
    await waitReady(portA);

    // Hub B is an EMBEDDED Hub (no retirement side effect), so the old Hub is
    // definitely still alive and we can observe its superseded responses.
    b = startHub({ root, port: portB, host: "127.0.0.1", env: { JOBQUAY_DATA_ROOT: root } });
    await new Promise<void>((resolve, reject) => {
      b!.server.once("listening", () => resolve());
      b!.server.once("error", reject);
    });

    // A page load on the old Hub redirects to the current endpoint.
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${portA}/ui`, { redirect: "manual", signal: AbortSignal.timeout(600) });
          return response.status === 302;
        } catch {
          return false;
        }
      },
      8000,
      "the old Hub's /ui to redirect"
    );
    const page = await fetch(`http://127.0.0.1:${portA}/ui`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), `http://127.0.0.1:${portB}/ui`);
    assert.equal(page.headers.get("x-jobquay-hub"), "superseded");

    // An API read on the old Hub is an explicit stale response, not stale data.
    const api = await fetch(`http://127.0.0.1:${portA}/api/jobs`, { redirect: "manual" });
    assert.equal(api.status, 409);
    const apiBody = (await api.json()) as Record<string, unknown>;
    assert.equal(apiBody.error, "hub_superseded");
    assert.equal(apiBody.current_endpoint, `http://127.0.0.1:${portB}`);

    // The client bundle is never served from the superseded process either.
    const client = await fetch(`http://127.0.0.1:${portA}/ui/client.js`, { redirect: "manual" });
    assert.equal(client.status, 409);

    // Health stays truthful: the launcher still probes the real build.
    const ping = await pingBody(portA);
    assert.ok(ping, "the superseded Hub still answers /api/ping");
    assert.equal(typeof ping.build_id, "string");
  } finally {
    await stopHub(b);
    kill(a);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
