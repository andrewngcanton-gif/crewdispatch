import test from "node:test";
import assert from "node:assert/strict";
import { parseDarwinBootTime, parseDarwinProcessSnapshot } from "../../runtime/process-darwin";

test("Darwin snapshot parser preserves exact microsecond birth and group/session facts", () => {
  const scan = parseDarwinProcessSnapshot(JSON.stringify({
    ok: true,
    op: "snapshot",
    processes: [
      {
        pid: 42,
        ppid: 1,
        pgid: 42,
        sid: 42,
        uid: 501,
        start_sec: 1_700_000_000,
        start_usec: 123456,
        session_leader: true,
        comm: "node"
      }
    ]
  }));
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.processes, [{
    pid: 42,
    ppid: 1,
    createdAtMs: 1_700_000_000_123,
    createdAtUs: 1_700_000_000_123_456,
    pgid: 42,
    sid: 42,
    sessionLeader: true,
    imageName: "node"
  }]);
});

test("Darwin snapshot parser fails closed on an unidentifiable partial row", () => {
  const scan = parseDarwinProcessSnapshot(JSON.stringify({
    ok: true,
    op: "snapshot",
    processes: [{ pid: 42, ppid: 1, pgid: 42, sid: 42, start_sec: 0, start_usec: 0 }]
  }));
  assert.equal(scan.ok, false);
  assert.deepEqual(scan.processes, []);
  assert.equal(scan.reason, "darwin_helper_unidentifiable_process");
});

test("Darwin snapshot preserves exact ancestry when a system process session is permission-unknown", () => {
  const scan = parseDarwinProcessSnapshot(JSON.stringify({
    ok: true,
    op: "snapshot",
    processes: [{
      pid: 42,
      ppid: 1,
      pgid: 42,
      sid: null,
      sid_errno: 1,
      start_sec: 1_700_000_000,
      start_usec: 123456,
      session_leader: false,
      comm: "protected"
    }]
  }));
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.processes, [{
    pid: 42,
    ppid: 1,
    createdAtMs: 1_700_000_000_123,
    createdAtUs: 1_700_000_000_123_456,
    pgid: 42,
    sid: null,
    sessionLeader: false,
    imageName: "protected"
  }]);
});
test("Darwin boot parser preserves exact microseconds and rejects future readings", () => {
  const text = JSON.stringify({ ok: true, op: "boot", sec: 1_700_000_000, usec: 654321 });
  const good = parseDarwinBootTime(text, 1_700_000_100_000);
  assert.deepEqual(good, {
    ok: true,
    bootTimeMs: 1_700_000_000_654,
    bootTimeUs: 1_700_000_000_654_321,
    reason: null
  });
  const future = parseDarwinBootTime(text, 1_699_999_000_000);
  assert.deepEqual(future, {
    ok: false,
    bootTimeMs: null,
    bootTimeUs: null,
    reason: "boot_time_in_future"
  });
});

test("Darwin parsers reject invalid helper replies without inventing facts", () => {
  assert.equal(parseDarwinProcessSnapshot("not-json").ok, false);
  const boot = parseDarwinBootTime(JSON.stringify({ ok: false, op: "boot", error: "denied" }));
  assert.equal(boot.ok, false);
  assert.equal(boot.bootTimeMs, null);
  assert.equal(boot.bootTimeUs, null);
});
