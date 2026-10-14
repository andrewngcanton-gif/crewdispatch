// exit.test.ts — unit tests for the official exit-code classification.
//
// The fallback policy is the point of this table: ONLY a real model rate limit
// (5) may advance the model chain; auth (3), permission (4) and insufficient
// credits (10) stop the run and are never a rate-limit fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommandCodeExit } from "../../providers/command-code/exit";
import { EXIT_CODES, FAILURE_AUTH, FAILURE_PERMISSION, FAILURE_QUOTA_EXHAUSTED, FAILURE_RATE_LIMIT } from "../../providers/command-code/capability";

test("success is the only non-failure zero exit", () => {
  const c = classifyCommandCodeExit(EXIT_CODES.SUCCESS);
  assert.equal(c.kind, "success");
  assert.equal(c.fatal, false);
  assert.equal(c.fallback, false);
  assert.equal(c.failureKind, null);
});

test("auth, permission and insufficient credits are fatal and never a fallback", () => {
  const auth = classifyCommandCodeExit(EXIT_CODES.AUTH);
  assert.equal(auth.kind, "auth");
  assert.equal(auth.fatal, true);
  assert.equal(auth.fallback, false);
  assert.equal(auth.failureKind, FAILURE_AUTH);

  const perm = classifyCommandCodeExit(EXIT_CODES.PERMISSION);
  assert.equal(perm.kind, "permission");
  assert.equal(perm.fatal, true);
  assert.equal(perm.fallback, false);
  assert.equal(perm.failureKind, FAILURE_PERMISSION);

  const credits = classifyCommandCodeExit(EXIT_CODES.INSUFFICIENT_CREDITS);
  assert.equal(credits.kind, "insufficient_credits");
  assert.equal(credits.fatal, true);
  assert.equal(credits.fallback, false);
  assert.equal(credits.failureKind, FAILURE_QUOTA_EXHAUSTED);
});

test("only a model rate limit may advance the fallback chain", () => {
  const rl = classifyCommandCodeExit(EXIT_CODES.RATE_LIMIT);
  assert.equal(rl.kind, "rate_limit");
  assert.equal(rl.fallback, true);
  assert.equal(rl.fatal, false);
  assert.equal(rl.failureKind, FAILURE_RATE_LIMIT);
});

test("network, server, max turns, no response and interrupted are not fallbacks", () => {
  for (const code of [
    EXIT_CODES.NETWORK,
    EXIT_CODES.SERVER,
    EXIT_CODES.MAX_TURNS,
    EXIT_CODES.NO_RESPONSE,
    EXIT_CODES.INTERRUPTED
  ]) {
    const c = classifyCommandCodeExit(code);
    assert.equal(c.fallback, false, `exit ${code} must not be a fallback`);
    assert.equal(c.fatal, false);
  }
  assert.equal(classifyCommandCodeExit(EXIT_CODES.MAX_TURNS).kind, "max_turns");
  assert.equal(classifyCommandCodeExit(EXIT_CODES.INTERRUPTED).stopReason, "cli_interrupted");
});

test("an unmapped or non-numeric exit stays unknown and non-fatal", () => {
  assert.equal(classifyCommandCodeExit(1).kind, "unknown");
  assert.equal(classifyCommandCodeExit(1).stopReason, "cli_nonzero");
  assert.equal(classifyCommandCodeExit(null).stopReason, "cli_exit_unknown");
  assert.equal(classifyCommandCodeExit("0" as unknown as number).stopReason, "cli_exit_unknown");
  assert.equal(classifyCommandCodeExit(NaN).stopReason, "cli_exit_unknown");
});
