// one-shot-verdict.ts — the production pass/fail rule of the one-shot real
// entry (`dist/cli/one-shot-cli.js`).
//
// Kept as a pure function so the rule is testable without a child process, and
// so the entry cannot silently drift back to "exit 0 OR saw a terminal record".
//
// A one-shot run is SUCCESS only when ALL of these hold:
//   - the child really exited with code 0;
//   - the stream produced a terminal record whose subtype is `success`;
//   - the run is not marked as an error;
//   - neither the operator timeout nor a spawn/child error occurred.
//
// Everything else is a DISTINCT failure verdict. In particular `max_turns` is an
// internal CLI segment boundary, not a completed job: this entry performs no
// continuation, so a segment boundary must never be accepted as success.

export type OneShotVerdict =
  | "success"
  | "spawn-error"
  | "timeout"
  | "nonzero-exit"
  | "no-terminal-record"
  | "max-turns-segment"
  | "error-terminal"
  | "unconfirmed-terminal";

export interface OneShotOutcome {
  exitCode: number | null;
  terminal: boolean;
  resultSubtype: string | null;
  isError: boolean;
  stopReason: string | null;
  errorMsg: string | null;
}

export interface OneShotFacts {
  outcome: OneShotOutcome;
  /** The operator `--max-wait-ms` escape hatch killed the child. */
  killedByMaxWait: boolean;
  /** spawn() threw synchronously, or the child emitted an 'error' event. */
  spawnError: string | null;
}

/** The single production decision. `exitCode` null (killed/never started) is not 0. */
export function computeOneShotVerdict(facts: OneShotFacts): OneShotVerdict {
  const o = facts.outcome;
  if (facts.spawnError) return "spawn-error";
  if (facts.killedByMaxWait) return "timeout";
  if (o.exitCode !== 0) return "nonzero-exit";
  if (!o.terminal) return "no-terminal-record";
  if (o.resultSubtype === "max_turns") return "max-turns-segment";
  if (o.isError || o.resultSubtype === "error") return "error-terminal";
  if (o.resultSubtype === "success") return "success";
  return "unconfirmed-terminal";
}

/** Only a real `success` verdict exits the process 0. */
export function isOneShotSuccess(verdict: OneShotVerdict): boolean {
  return verdict === "success";
}
