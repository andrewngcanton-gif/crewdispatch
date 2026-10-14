// ui-duration.test.ts — pure formatting/edge tests for the Hub UI's shared
// duration formatter and the session Runtime metric.
//
// The Hub serves ONE classic browser script (dist/ui/client.js), so its pure
// helpers cannot be imported by a node test. Instead of re-implementing the
// formatter (which would prove nothing about the shipped code), these tests
// EXTRACT the two pure functions from the built script and execute them
// directly: every assertion below runs the real shipped implementation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const CLIENT_SCRIPT = path.join(__dirname, "..", "..", "ui", "client.js");

/** Extract one top-level `function <name>(...) {...}` source slice. */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} exists in the shipped client script`);
  let depth = 0;
  let index = source.indexOf("{", start);
  assert.ok(index >= 0, `${name} has a body`);
  for (; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const script = fs.readFileSync(CLIENT_SCRIPT, "utf8");
const helpers = new Function(
  `${extractFunction(script, "formatDuration")}\n${extractFunction(script, "runtimeText")}\nreturn { formatDuration, runtimeText };`
)() as {
  formatDuration: (ms: number) => string;
  runtimeText: (status: string, startedAt: string | null | undefined, finishedAt: string | null | undefined, nowMs: number) => string;
};

const { formatDuration, runtimeText } = helpers;

test("formatDuration is deterministic and compact at every unit boundary", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s", "sub-second spans floor, never round up");
  assert.equal(formatDuration(8000), "8s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(60_000), "1m 00s");
  assert.equal(formatDuration(134_000), "2m 14s");
  assert.equal(formatDuration(3_599_000), "59m 59s");
  assert.equal(formatDuration(3_600_000), "1h 00m");
  assert.equal(formatDuration(3_780_000), "1h 03m", "the minute component is zero-padded inside an hour");
  assert.equal(formatDuration(86_399_000), "23h 59m");
  assert.equal(formatDuration(86_400_000), "1d 0h");
  assert.equal(formatDuration(93_600_000), "1d 2h", "the hour component is not padded inside a day");
  assert.equal(formatDuration(90_061_000), "1d 1h");
});

test("runtimeText: a running session measures now − started_at and keeps advancing", () => {
  const started = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const now = Date.UTC(2026, 0, 1, 0, 2, 14);
  assert.equal(runtimeText("running", started, null, now), "Runtime 2m 14s");
  assert.equal(runtimeText("running", started, null, now + 3000), "Runtime 2m 17s", "the value advances with the refresh clock");
  assert.equal(runtimeText("orphaned", started, null, now), "Runtime 2m 14s", "an orphaned session is still a live span");
  // A queued follow-up belongs to the SAME session and keeps the session clock.
  assert.equal(runtimeText("queued", started, null, now), "Runtime 2m 14s");
});

test("runtimeText: a terminal session freezes at finished_at − started_at", () => {
  const started = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const finished = new Date(Date.UTC(2026, 0, 1, 1, 3, 20)).toISOString();
  const expected = "Runtime 1h 03m";
  assert.equal(runtimeText("done", started, finished, Date.UTC(2026, 0, 1, 5, 0, 0)), expected);
  assert.equal(runtimeText("error", started, finished, Date.UTC(2026, 0, 1, 5, 0, 0)), expected);
  assert.equal(runtimeText("cancelled", started, finished, Date.UTC(2026, 0, 1, 5, 0, 0)), expected);
  assert.equal(runtimeText("done", started, finished, Date.UTC(2026, 0, 2, 0, 0, 0)), expected, "a terminal span never grows");
});

test("runtimeText omits the metric whenever the evidence is absent or malformed", () => {
  const started = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
  const now = Date.UTC(2026, 0, 1, 0, 1, 0);
  // Never started (queued): the queue wait is not session runtime.
  assert.equal(runtimeText("queued", null, null, now), "");
  assert.equal(runtimeText("running", undefined, null, now), "");
  // Terminal without a finished_at: no end boundary to measure to.
  assert.equal(runtimeText("done", started, null, now), "");
  assert.equal(runtimeText("cancelled", started, undefined, now), "");
  // Malformed timestamps are not measurements.
  assert.equal(runtimeText("running", "not-a-date", null, now), "");
  assert.equal(runtimeText("done", started, "not-a-date", now), "");
  // A negative span (clock skew) is omitted, never rendered as a value.
  const future = new Date(now + 60_000).toISOString();
  assert.equal(runtimeText("running", future, null, now), "");
  assert.equal(runtimeText("done", future, started, now), "");
  // A status this UI does not know renders nothing rather than guessing.
  assert.equal(runtimeText("mystery", started, null, now), "");
});
