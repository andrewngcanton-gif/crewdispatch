// hub-workbuddy-activity.test.ts — the HUB/UI activity boundary.
//
// A WorkBuddy ACP turn is normalized into the SHARED event vocabulary (see
// src/tests/helpers/acp-workbuddy-fixture.ts) and served through the REAL Hub
// log endpoint in the SAME compact activity mode the Hub client uses
// (`activity=1&scope=current`). These tests prove the user-visible outcome:
//   - ONE readable assistant message row per spoken segment, never one row per
//     streamed chunk, while the raw streamed deltas stay in the log for
//     diagnostics in the non-activity view;
//   - tool rows name the tool and show its lifecycle (queued / running /
//     update / completed / failed);
//   - reasoning text never reaches the default view and is exposed only for an
//     explicit reasoning opt-in (and never as token-level rows);
//   - the compact view of a whole turn stays bounded.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle } from "../../hub/server";
import { createJobRecord } from "../../jobs/service";
import { ensureRoot, logPath, saveJob } from "../../jobs/store";
import { emptyUsage } from "../../jobs/types";
import { createWorkBuddyAiAdapter } from "../../providers/workbuddy-ai/index";
import {
  ACP_FIXTURE_ANSWER,
  ACP_FIXTURE_ASSISTANT_TEXT,
  ACP_FIXTURE_CACHE_READ_TOKENS,
  ACP_FIXTURE_CONTEXT_USED,
  ACP_FIXTURE_CONTEXT_WINDOW,
  ACP_FIXTURE_CREDITS,
  ACP_FIXTURE_INPUT_TOKENS,
  ACP_FIXTURE_OUTPUT_TOKENS,
  ACP_FIXTURE_THOUGHT,
  ACP_FIXTURE_TOOL_FAILURE,
  acpFixtureRunLines
} from "../helpers/acp-workbuddy-fixture";

const MODEL = "deepseek-v4.1-flash";

interface Fixture {
  dir: string;
  root: string;
  hub: HubHandle;
  url: string;
  jobId: string;
  cleanup: () => Promise<void>;
}

/** Start the real Hub over a temp root holding ONE WorkBuddy ACP transcript. */
async function startFixture(model: string = MODEL): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-wb-activity-"));
  const root = path.join(dir, "root");
  const project = path.join(dir, "project");
  fs.mkdirSync(project, { recursive: true });
  ensureRoot(root);

  const lines = acpFixtureRunLines(model);
  const job = createJobRecord({ task: "WORKBUDDY_ACTIVITY_TASK", cwd: project, provider: "workbuddy-ai", runner: "workbuddy-ai", model });
  job.status = "done";
  job.sessionId = "01a0ecaf-aa3e-799c-90ea-7680e8184d7e";
  // The usage the REAL adapter derives from this very transcript, persisted the
  // way the job service persists an attempt's usage.
  const adapter = createWorkBuddyAiAdapter();
  const state = adapter.createStreamState();
  let at = 1_000_000;
  for (const line of lines) {
    adapter.parseStreamLine(line, state, at);
    at += 400;
  }
  const snapshot = adapter.normalizeUsage(state);
  job.usage = { ...emptyUsage(), ...snapshot };
  job.attempts = [{
    generation: 0,
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    kind: "success",
    failureKind: null,
    segment: false,
    resumedFrom: null,
    model,
    modelSource: "explicit",
    effort: null,
    rateLimited: false,
    switched: false,
    switchToModel: null,
    usage: job.usage
  }];
  saveJob(root, job);
  fs.writeFileSync(logPath(root, job.id), lines.join("\n") + "\n", "utf8");

  const hub = startHub({ root, host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    hub.server.once("listening", () => resolve());
    hub.server.once("error", reject);
  });
  const url = `http://127.0.0.1:${hub.port}`;

  return {
    dir,
    root,
    hub,
    url,
    jobId: job.id,
    cleanup: async () => {
      hub.server.closeAllConnections?.();
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

interface LogEntry {
  offset?: number;
  data?: Record<string, any>;
  reasoning?: unknown[];
  error?: string;
  unparsed?: boolean;
}

async function readLog(fixture: Fixture, query: string): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  let cursor = "0";
  for (let page = 0; page < 8; page += 1) {
    const response = await fetch(
      `${fixture.url}/api/jobs/${encodeURIComponent(fixture.jobId)}/log?cursor=${encodeURIComponent(cursor)}&limit=200&${query}`
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { entries: LogEntry[]; cursor: string; drained: boolean };
    entries.push(...body.entries);
    const previous = cursor;
    cursor = body.cursor;
    if (body.drained || cursor === previous) break;
  }
  return entries;
}

function eventOf(entry: LogEntry): Record<string, any> | null {
  const event = entry.data?.event;
  return event && typeof event === "object" ? event as Record<string, any> : null;
}

test("a WorkBuddy ACP turn reads as ONE assistant message plus named tool rows in the compact Hub view", { timeout: 60000 }, async () => {
  const fixture = await startFixture();
  try {
    const entries = await readLog(fixture, "activity=1&scope=current&include_reasoning=false");
    const events = entries.map((entry) => eventOf(entry)).filter((event): event is Record<string, any> => !!event);
    const types = events.map((event) => String(event.type));

    // The streamed chunk noise is gone from the activity view.
    for (const hidden of ["text_delta", "message_start", "thinking_delta", "thinking_start", "thinking_end", "usage"]) {
      assert.equal(types.includes(hidden), false, `compact activity must not show a "${hidden}" row`);
    }

    // Exactly one readable assistant row per spoken segment, carrying the whole
    // aggregated text — not one row per streamed chunk.
    const messages = events.filter((event) => event.type === "message_end");
    assert.equal(messages.length, 2, "one completed assistant message per spoken segment");
    assert.equal(
      String(messages[0]?.content?.[0]?.text ?? ""),
      ACP_FIXTURE_ANSWER,
      "the completed message carries the whole aggregated text"
    );
    assert.equal(
      messages.map((event) => String(event.content?.[0]?.text ?? "")).join(""),
      ACP_FIXTURE_ASSISTANT_TEXT
    );

    // Tool activity is meaningful: every row names the tool it belongs to.
    const queued = events.filter((event) => event.type === "tool_queued");
    assert.deepEqual(queued.map((event) => event.toolName), ["read_file", "execute", "search_code"]);
    assert.equal(events.some((event) => event.type === "tool_use"), false, "a bare tool_use row is never emitted");
    assert.deepEqual(events.filter((event) => event.type === "tool_running").map((event) => event.toolName), ["read_file", "search_code"]);
    assert.deepEqual(
      events.filter((event) => event.type === "tool_update").map((event) => event.toolName),
      ["search_code"],
      "a tool that streamed content but never finished reports ONE aggregated progress row"
    );
    assert.equal(
      events.filter((event) => event.type === "tool_update").length,
      1,
      "three streamed content updates of one tool never become three rows"
    );
    const completed = events.filter((event) => event.type === "tool_completed");
    assert.deepEqual(completed.map((event) => [event.toolName, event.status ?? "completed"]), [
      ["read_file", "completed"],
      ["execute", "failed"]
    ]);
    assert.equal(String(completed[1]?.result?.[0]?.text ?? ""), ACP_FIXTURE_TOOL_FAILURE);

    // A whole ACP turn stays bounded instead of one row per streamed chunk.
    assert.ok(entries.length <= 12, `compact activity of one turn must stay small, got ${entries.length} rows`);
    assert.equal(JSON.stringify(entries).includes(ACP_FIXTURE_THOUGHT), false, "hidden reasoning never reaches the default view");

    // The raw streamed material stays available for diagnostics (non-activity view).
    const raw = await readLog(fixture, "include_reasoning=false");
    const rawTypes = raw.map((entry) => String(entry.data?.event?.type ?? entry.data?.type ?? ""));
    assert.ok(rawTypes.includes("text_delta"), "the raw streamed deltas remain in the log for diagnostics");
    assert.ok(rawTypes.includes("message_start"));
    assert.ok(raw.length > entries.length, "the diagnostics view keeps more detail than the activity view");
  } finally {
    await fixture.cleanup();
  }
});

test("the Hub detail serves the canonical WorkBuddy usage derived from the ACP transcript", { timeout: 60000 }, async () => {
  const fixture = await startFixture();
  try {
    const response = await fetch(`${fixture.url}/api/jobs/${encodeURIComponent(fixture.jobId)}`);
    assert.equal(response.status, 200);
    const detail = await response.json() as { usage: Record<string, number | null> };

    // The metrics the ACP evidence proves are served as the canonical fields.
    assert.equal(detail.usage.toolCalls, 3);
    assert.equal(detail.usage.contextUsed, ACP_FIXTURE_CONTEXT_USED);
    assert.equal(detail.usage.contextWindow, ACP_FIXTURE_CONTEXT_WINDOW);
    assert.equal(detail.usage.credits, ACP_FIXTURE_CREDITS);
    // Decode is NOT reported from the ACP transcript alone: the dsh contract
    // needs the response's assembled/final instant, which this transport never
    // proves (its message closures are bridge-synthesized). A missing metric is
    // honest — the old synthetic-boundary pairing produced inflated rates.
    assert.equal(detail.usage.decodeTokens, null, "no exact completed-response evidence → no numerator");
    assert.equal(detail.usage.decodeSeconds, null, "no exact completed-response evidence → no denominator");

    // The raw usage snapshot the response republished under its identity reaches
    // the canonical JobUsage the Hub serves.
    assert.equal(detail.usage.tokensIn, ACP_FIXTURE_INPUT_TOKENS);
    assert.equal(detail.usage.tokensOut, ACP_FIXTURE_OUTPUT_TOKENS);
    assert.equal(detail.usage.cacheRead, ACP_FIXTURE_CACHE_READ_TOKENS);

    // The installed WorkBuddy runtime proves cache-read is a subset of input,
    // so the canonical normalizer derives the non-hit portion exactly.
    assert.equal(
      detail.usage.cacheMiss,
      ACP_FIXTURE_INPUT_TOKENS - ACP_FIXTURE_CACHE_READ_TOKENS,
      "cacheMiss is the proven non-hit portion of inclusive input"
    );

    // Metrics this transport still does not publish stay unavailable — never 0.
    for (const unavailable of ["cacheCreation", "totalCostUsd"]) {
      assert.equal(detail.usage[unavailable], null, `${unavailable} stays unavailable`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("WorkBuddy ACP reasoning is hidden by default and exposed only by an explicit opt-in", { timeout: 60000 }, async () => {
  const fixture = await startFixture();
  try {
    const hidden = await readLog(fixture, "activity=1&scope=current&include_reasoning=false");
    assert.equal(JSON.stringify(hidden).includes(ACP_FIXTURE_THOUGHT), false, "default activity never leaks reasoning");

    const optedIn = await readLog(fixture, "activity=1&scope=current&include_reasoning=true");
    const optedText = JSON.stringify(optedIn);
    assert.ok(optedText.includes(ACP_FIXTURE_THOUGHT), "opt-in surfaces the reasoning text the protocol actually emitted");
    assert.ok(
      optedIn.some((entry) => eventOf(entry)?.type === "thinking_end" && JSON.stringify(entry.reasoning ?? []).includes(ACP_FIXTURE_THOUGHT)),
      "the reasoning is attached to the shared thinking_end record"
    );
    const optedTypes = optedIn.map((entry) => String(eventOf(entry)?.type ?? ""));
    assert.equal(optedTypes.includes("thinking_delta"), false, "even with opt-in, token-level reasoning rows stay out of the compact view");
  } finally {
    await fixture.cleanup();
  }
});

test("the same WorkBuddy ACP transcript is served as the same activity under a second model id", { timeout: 60000 }, async () => {
  const first = await startFixture("deepseek-v4.1-flash");
  const second = await startFixture("hy4-preview-f");
  try {
    const a = await readLog(first, "activity=1&scope=current&include_reasoning=false");
    const b = await readLog(second, "activity=1&scope=current&include_reasoning=false");

    // Byte positions and model metadata are the only allowed differences: every
    // canonical activity row is identical under both model ids.
    const comparable = (entries: LogEntry[]): unknown => entries.map((entry) => {
      const copy = JSON.parse(JSON.stringify(entry)) as LogEntry & { data?: Record<string, unknown> };
      delete copy.offset;
      if (copy.data) delete copy.data.model;
      return copy;
    });
    assert.deepEqual(comparable(a), comparable(b));
    assert.equal(a.length, b.length);
    assert.equal(a.length > 0, true);

    const modelOf = (entries: LogEntry[]): string | null => {
      const declared = entries
        .map((entry) => entry.data?.model)
        .filter((value): value is string => typeof value === "string");
      return declared[0] ?? null;
    };
    assert.equal(modelOf(a), "deepseek-v4.1-flash", "the model id is recorded as METADATA on the terminal result");
    assert.equal(modelOf(b), "hy4-preview-f");
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
