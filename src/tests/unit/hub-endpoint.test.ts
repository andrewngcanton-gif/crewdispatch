// hub-endpoint.test.ts — pure/unit contract for the durable current-Hub record.
//
// The record is the bounded, CrewDispatch-owned evidence the ownership contract is
// built on: it is advisory INPUT, never proof by itself. These tests pin the
// shape, the inside-root guard, instance-based release, and the identity proof
// that gates every retirement decision (foreign listeners are never touched).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearHubEndpoint,
  dataRootId,
  newHubInstanceId,
  probeHubOwner,
  readHubEndpoint,
  retireHubEndpoint,
  writeHubEndpoint
} from "../../hub/endpoint";

function tmpRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jobquay-endpoint-${name}-`));
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

test("the root fingerprint is deterministic, distinct per root, and never the raw path", () => {
  const a = path.join("C:", "data", "JobQuay");
  assert.equal(dataRootId(a), dataRootId(path.resolve(a)));
  assert.notEqual(dataRootId(a), dataRootId(path.join("C:", "data", "JobQuay2")));
  assert.match(dataRootId(a), /^[0-9a-f]{16}$/);
  assert.equal(dataRootId(a).includes("JobQuay"), false, "the fingerprint must not leak the path");
});

test("a written record round-trips with its ownership identity; a legacy record still reads", () => {
  const root = tmpRoot("roundtrip");
  try {
    const instanceId = newHubInstanceId();
    writeHubEndpoint(root, {
      port: 30080,
      pid: 4242,
      instanceId,
      buildId: "build-x",
      version: "0.0.0-m1",
      rootId: dataRootId(root)
    });
    const record = readHubEndpoint(root);
    assert.ok(record);
    assert.equal(record.port, 30080);
    assert.equal(record.pid, 4242);
    assert.equal(record.instance_id, instanceId);
    assert.equal(record.build_id, "build-x");
    assert.equal(record.version, "0.0.0-m1");
    assert.equal(record.root_id, dataRootId(root));
    assert.equal(typeof record.at, "string");

    // A pre-upgrade `{port,pid,at}` record is still discoverable.
    fs.writeFileSync(path.join(root, "hub", "endpoint.json"), JSON.stringify({ port: 54410, pid: 7, at: "2026-10-01T00:00:00.000Z" }));
    const legacy = readHubEndpoint(root);
    assert.ok(legacy);
    assert.equal(legacy.port, 54410);
    assert.equal(legacy.instance_id, "");
    assert.equal(legacy.root_id, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed or missing record reads as null instead of a guess", () => {
  const root = tmpRoot("malformed");
  try {
    assert.equal(readHubEndpoint(root), null);
    fs.mkdirSync(path.join(root, "hub"), { recursive: true });
    fs.writeFileSync(path.join(root, "hub", "endpoint.json"), "{ not json");
    assert.equal(readHubEndpoint(root), null);
    fs.writeFileSync(path.join(root, "hub", "endpoint.json"), JSON.stringify({ port: 70000, pid: 1 }));
    assert.equal(readHubEndpoint(root), null, "an out-of-range port is rejected");
    fs.writeFileSync(path.join(root, "hub", "endpoint.json"), JSON.stringify({ port: 30080, pid: -1 }));
    assert.equal(readHubEndpoint(root), null, "an invalid pid is rejected");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release matches the owner: instance id is preferred, pid is the fallback", () => {
  const root = tmpRoot("clear");
  try {
    writeHubEndpoint(root, { port: 30080, pid: 10, instanceId: "aaa" });
    // A different instance must never clear the record, even at the same pid.
    clearHubEndpoint(root, { instanceId: "bbb" });
    assert.ok(readHubEndpoint(root), "a non-owner instance must not clear the record");
    // A different pid must not clear it either (fallback path).
    clearHubEndpoint(root, { pid: 99 });
    assert.ok(readHubEndpoint(root));
    // The owner clears it.
    clearHubEndpoint(root, { instanceId: "aaa" });
    assert.equal(readHubEndpoint(root), null);

    writeHubEndpoint(root, { port: 30080, pid: 10, instanceId: "ccc" });
    clearHubEndpoint(root, { pid: 10 });
    assert.equal(readHubEndpoint(root), null, "the pid fallback clears a matching owner");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probeHubOwner requires a live CrewDispatch ping for the SAME root", async () => {
  const root = tmpRoot("probe");
  try {
    const rootId = dataRootId(root);
    const foreign = (async () => jsonResponse({ ok: true, service: "not-jobquay" })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId }, foreign), false, "a foreign listener is never an owner");

    const otherRoot = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: "other" })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId }, otherRoot), false, "another root's Hub is never this root's owner");

    const same = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: rootId })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId }, same), true);

    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId }, dead), false, "a dead port is not an owner");

    // A legacy record (no root_id) falls back to the CrewDispatch service identity.
    const legacyLive = (async () => jsonResponse({ ok: true, service: "jobquay" })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: "" }, legacyLive), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("probeHubOwner requires the recorded INSTANCE, so a replacement on a reused port is not the old owner", async () => {
  const root = tmpRoot("probe-instance");
  try {
    const rootId = dataRootId(root);
    // The exact production shape: the record names the dead old instance on the
    // port a live replacement now holds. Same service, same root — the old
    // instance identity must still fail the proof.
    const replacement = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: rootId, instance_id: "replacement-instance" })) as unknown as typeof fetch;
    assert.equal(
      await probeHubOwner({ port: 1, root_id: rootId, instance_id: "old-instance" }, replacement),
      false,
      "a replacement instance that reused the port is never the recorded owner"
    );

    const exact = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: rootId, instance_id: "old-instance" })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId, instance_id: "old-instance" }, exact), true);

    // A live Hub that does not report the recorded instance id at all cannot be
    // trusted as that exact instance.
    const silent = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: rootId })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId, instance_id: "old-instance" }, silent), false);

    // A legacy record (empty instance_id) has no instance to confirm and keeps
    // the service+root contract.
    const anyInstance = (async () => jsonResponse({ ok: true, service: "jobquay", root_id: rootId, instance_id: "whatever" })) as unknown as typeof fetch;
    assert.equal(await probeHubOwner({ port: 1, root_id: rootId, instance_id: "" }, anyInstance), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retirement only targets a live, older, same-root CrewDispatch Hub on another port", async () => {
  const root = tmpRoot("retire");
  try {
    const rootId = dataRootId(root);
    const older = { port: 54410, pid: 7, instance_id: "old", build_id: "b", version: "0.0.0-m1", root_id: rootId, at: "2026-10-01T00:00:00.000Z" };
    const calls: Array<{ url: string; method: string }> = [];
    const fake = (async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/api/hub/shutdown")) return jsonResponse({ ok: true, exiting: true });
      if (url.endsWith("/api/ping")) return jsonResponse({ ok: true, service: "jobquay", root_id: rootId, instance_id: "old" });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const retired = await retireHubEndpoint(
      { product: "jobquay", kind: "jobquay-hub-endpoint", ...older },
      { currentPort: 30080, root, startedAtMs: Date.parse("2026-10-02T00:00:00.000Z"), fetchImpl: fake }
    );
    assert.equal(retired, true);
    assert.equal(calls.filter((c) => c.method === "POST").length, 1, "exactly one shutdown request");
    assert.match(calls.find((c) => c.method === "POST")!.url, /\/api\/hub\/shutdown$/);

    // Same port: never a self-retirement.
    calls.length = 0;
    assert.equal(
      await retireHubEndpoint({ product: "jobquay", kind: "jobquay-hub-endpoint", ...older, port: 30080 }, { currentPort: 30080, root, startedAtMs: Date.now(), fetchImpl: fake }),
      false
    );
    assert.equal(calls.length, 0);

    // A NEWER record (a concurrent start) is never retired.
    calls.length = 0;
    assert.equal(
      await retireHubEndpoint(
        { product: "jobquay", kind: "jobquay-hub-endpoint", ...older, at: "2026-10-03T00:00:00.000Z" },
        { currentPort: 30080, root, startedAtMs: Date.parse("2026-10-02T00:00:00.000Z"), fetchImpl: fake }
      ),
      false
    );
    assert.equal(calls.length, 0, "a newer owner is left to win the race");

    // A foreign listener on the recorded port is proven NOT CrewDispatch and never killed.
    calls.length = 0;
    const foreign = (async (input: unknown, init?: { method?: string }) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({ ok: true, service: "not-jobquay" });
    }) as unknown as typeof fetch;
    assert.equal(
      await retireHubEndpoint(
        { product: "jobquay", kind: "jobquay-hub-endpoint", ...older },
        { currentPort: 30080, root, startedAtMs: Date.parse("2026-10-02T00:00:00.000Z"), fetchImpl: foreign }
      ),
      false
    );
    assert.equal(calls.some((c) => c.method === "POST"), false, "a foreign listener is never asked to exit");

    // A record whose root fingerprint is ANOTHER root is never retired (or even
    // probed): it cannot name this root's owner.
    calls.length = 0;
    assert.equal(
      await retireHubEndpoint(
        { product: "jobquay", kind: "jobquay-hub-endpoint", ...older, root_id: dataRootId(path.join(root, "other")) },
        { currentPort: 30080, root, startedAtMs: Date.parse("2026-10-02T00:00:00.000Z"), fetchImpl: fake }
      ),
      false
    );
    assert.equal(calls.length, 0, "another root's Hub is never contacted");

    // A record naming an OLD instance whose port is now answered by a DIFFERENT
    // live same-root instance is never retired: the replacement owns the port,
    // and shutting it down from a stale record would destroy the winner.
    calls.length = 0;
    const replacement = (async (input: unknown, init?: { method?: string }) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (String(input).endsWith("/api/ping")) {
        return jsonResponse({ ok: true, service: "jobquay", root_id: rootId, instance_id: "replacement" });
      }
      throw new Error(`unexpected ${String(input)}`);
    }) as unknown as typeof fetch;
    assert.equal(
      await retireHubEndpoint(
        { product: "jobquay", kind: "jobquay-hub-endpoint", ...older, instance_id: "old" },
        { currentPort: 30080, root, startedAtMs: Date.parse("2026-10-02T00:00:00.000Z"), fetchImpl: replacement }
      ),
      false
    );
    assert.equal(calls.some((c) => c.method === "POST"), false, "a replacement instance that reused the port is never asked to exit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
