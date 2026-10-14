// one-shot-verdict.test.ts — regression for the one-shot pass/fail rule.
//
// The previous entry accepted `exitCode === 0 || state.terminal`, so a nonzero
// exit with an error terminal, or a zero exit without a terminal record, passed.
// These cases pin the corrected production rule.
import test from "node:test";
import assert from "node:assert/strict";
import { computeOneShotVerdict, isOneShotSuccess, type OneShotFacts } from "../../cli/one-shot-verdict";

function facts(over: Partial<OneShotFacts["outcome"]> = {}, extra: Partial<OneShotFacts> = {}): OneShotFacts {
  return {
    outcome: {
      exitCode: 0,
      terminal: true,
      resultSubtype: "success",
      isError: false,
      stopReason: "end_turn",
      errorMsg: null,
      ...over
    },
    killedByMaxWait: false,
    spawnError: null,
    ...extra
  };
}

test("real exit 0 with a success terminal record passes", () => {
  const v = computeOneShotVerdict(facts());
  assert.equal(v, "success");
  assert.equal(isOneShotSuccess(v), true);
});

test("a nonzero exit never passes, even with a success terminal record", () => {
  assert.equal(computeOneShotVerdict(facts({ exitCode: 3 })), "nonzero-exit");
  assert.equal(computeOneShotVerdict(facts({ exitCode: 1 })), "nonzero-exit");
  assert.equal(computeOneShotVerdict(facts({ exitCode: 8 })), "nonzero-exit");
});

test("exit 0 with an error terminal record is a failure (the old rule passed it)", () => {
  const v = computeOneShotVerdict(facts({ resultSubtype: "error", isError: true }));
  assert.equal(v, "error-terminal");
  assert.equal(isOneShotSuccess(v), false);
});

test("exit 0 without a terminal record is a failure (the old rule passed it)", () => {
  const v = computeOneShotVerdict(facts({ terminal: false, resultSubtype: null }));
  assert.equal(v, "no-terminal-record");
  assert.equal(isOneShotSuccess(v), false);
});

test("max_turns is a segment boundary and never success without continuation", () => {
  // The parser marks a max_turns terminal as isError, but the verdict stays the
  // distinct segment-boundary class so the reason is never masked as "error".
  const v = computeOneShotVerdict(facts({ resultSubtype: "max_turns", isError: true, stopReason: "cli_max_turns" }));
  assert.equal(v, "max-turns-segment");
  assert.equal(isOneShotSuccess(v), false);
});

test("a timeout kill or a spawn/child error never passes", () => {
  assert.equal(computeOneShotVerdict(facts({ exitCode: null, terminal: false }, { killedByMaxWait: true })), "timeout");
  assert.equal(computeOneShotVerdict(facts({ exitCode: null }, { spawnError: "ENOENT" })), "spawn-error");
  assert.equal(
    computeOneShotVerdict(facts({ exitCode: 0, resultSubtype: "success" }, { spawnError: "EPIPE" })),
    "spawn-error"
  );
});

test("a terminal record without a success subtype is not accepted as success", () => {
  const v = computeOneShotVerdict(facts({ resultSubtype: null, isError: false }));
  assert.equal(v, "unconfirmed-terminal");
  assert.equal(isOneShotSuccess(v), false);
});
