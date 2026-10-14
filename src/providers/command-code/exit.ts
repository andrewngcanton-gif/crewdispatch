// exit.ts — the official exit-code classification of the Command Code CLI.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` classifyCommandCodeExit.
//
// Official codes: 0 success, 3 auth, 4 permission, 5 rate limit, 6 network,
// 7 server, 8 max turns, 9 no response, 10 insufficient credits, 130 interrupted.
//
// FALLBACK POLICY (the point of the table):
//   - `fallback: true` ONLY for exit 5 (a transient model rate limit) — the one
//     class that may advance the model candidate chain;
//   - `fatal: true` for auth (3), permission (4) and insufficient credits (10):
//     the run stops immediately. An exhausted quota or a credential/permission
//     problem is NEVER treated as a rate limit and never triggers a fallback.
import type { ExitClassification } from "../provider";
import { EXIT_CODES, FAILURE_AUTH, FAILURE_PERMISSION, FAILURE_QUOTA_EXHAUSTED, FAILURE_RATE_LIMIT } from "./capability";

interface ExitRow {
  kind: string;
  failureKind: string | null;
  stopReason: string | null;
  fatal: boolean;
  fallback: boolean;
}

const EXIT_TABLE: Readonly<Record<number, ExitRow>> = Object.freeze({
  [EXIT_CODES.SUCCESS]: { kind: "success", failureKind: null, stopReason: null, fatal: false, fallback: false },
  [EXIT_CODES.AUTH]: { kind: "auth", failureKind: FAILURE_AUTH, stopReason: FAILURE_AUTH, fatal: true, fallback: false },
  [EXIT_CODES.PERMISSION]: {
    kind: "permission",
    failureKind: FAILURE_PERMISSION,
    stopReason: FAILURE_PERMISSION,
    fatal: true,
    fallback: false
  },
  [EXIT_CODES.RATE_LIMIT]: {
    kind: "rate_limit",
    failureKind: FAILURE_RATE_LIMIT,
    stopReason: FAILURE_RATE_LIMIT,
    fatal: false,
    fallback: true
  },
  [EXIT_CODES.NETWORK]: { kind: "network", failureKind: null, stopReason: "cli_network_error", fatal: false, fallback: false },
  [EXIT_CODES.SERVER]: { kind: "server", failureKind: null, stopReason: "cli_server_error", fatal: false, fallback: false },
  [EXIT_CODES.MAX_TURNS]: { kind: "max_turns", failureKind: null, stopReason: "cli_max_turns", fatal: false, fallback: false },
  [EXIT_CODES.NO_RESPONSE]: { kind: "no_response", failureKind: null, stopReason: "cli_no_response", fatal: false, fallback: false },
  [EXIT_CODES.INSUFFICIENT_CREDITS]: {
    kind: "insufficient_credits",
    failureKind: FAILURE_QUOTA_EXHAUSTED,
    stopReason: FAILURE_QUOTA_EXHAUSTED,
    fatal: true,
    fallback: false
  },
  [EXIT_CODES.INTERRUPTED]: { kind: "interrupted", failureKind: null, stopReason: "cli_interrupted", fatal: false, fallback: false }
});

export function classifyCommandCodeExit(code: unknown): ExitClassification {
  if (typeof code !== "number" || !Number.isFinite(code)) {
    return { kind: "unknown", failureKind: null, stopReason: "cli_exit_unknown", fatal: false, fallback: false };
  }
  const hit = EXIT_TABLE[code];
  if (hit) return { ...hit };
  return { kind: "unknown", failureKind: null, stopReason: "cli_nonzero", fatal: false, fallback: false };
}
