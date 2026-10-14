// argv.ts — the fixed, validated argv of one official Command Code run.
//
// Behaviour re-implemented from the read-only reference
// `wb-crew/src/command-code.mjs` buildCommandCodeArgv.
//
// TRANSPORT (fixed by the official CLI):
//   cmdc -p --output-format json --model <ID> --permission-mode <MODE>
//        --skip-onboarding [--effort <LEVEL>] [--resume <SESSION_ID>]
//   - the PROMPT is never an argv value: it is written to the child's STDIN;
//   - the working directory never appears here: it is the spawn `cwd` option;
//   - no `--max-turns`: the official CLI applies its own per-process default and
//     reaching it is an INTERNAL segment boundary, never a CrewDispatch task cap or
//     wall-clock timeout.
import {
  EFFORT_FLAG,
  checkModelEffort,
  normalizeEffort,
  normalizePermissionMode,
  PERMISSION_MODE_STANDARD_SYNONYM,
  PERMISSION_MODES,
  EFFORT_LEVELS
} from "./capability";

export interface ArgvInput {
  /** A model id from the CLI's own public catalog (token-checked). */
  model: unknown;
  /** One of the permission modes the CLI publishes (or the documented enum). */
  permissionMode: unknown;
  /** Modes read from the installed CLI's own `--help`, when available. */
  publishedPermissionModes?: readonly string[] | null;
  resumeSessionId?: unknown;
  /** null/"" = the CLI/model default: no flag is emitted. Unknown = rejected. */
  effort?: unknown;
  /** True only when the CLI's own public `--help` published `--effort`. */
  effortSupported?: boolean;
  /**
   * The effort levels THIS model's own published metadata proves (the installed
   * package's reference row, or the provider's product metadata). When a
   * non-empty list is supplied it is authoritative for this model and a level
   * outside it is REJECTED before any process starts; null/absent means no
   * reliable per-model evidence, so the level is passed through unchanged.
   */
  supportedEfforts?: readonly string[] | null;
}

export type ArgvResult = { ok: true; argv: string[] } | { ok: false; error: string };

/**
 * A model id token: letters/digits/._-, slash-separated namespace segments
 * ("deepseek/deepseek-v4-flash") and at most one trailing ":segment"
 * ("inclusionai/ling-3.0-flash-sante:free"). Deliberately narrow: the id must
 * start with a letter/digit, and nothing that could ever be a shell
 * metacharacter (whitespace, quotes, `$`, `;`, `&`, `|`, backticks, `<>`)
 * becomes an argv token.
 */
export const MODEL_TOKEN_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** A provider session id token (UUID-ish / slug-ish). Same conservative grammar. */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Build the argv of one run. Pure and total: every value is validated before it
 * can become an argv token, and a value that cannot be represented safely is
 * REJECTED instead of being interpolated.
 */
export function buildCommandCodeArgv(input: ArgvInput = { model: undefined, permissionMode: undefined }): ArgvResult {
  const m = typeof input.model === "string" ? input.model.trim() : "";
  if (!m || !MODEL_TOKEN_RE.test(m)) {
    return { ok: false, error: `invalid model id for Command Code: ${JSON.stringify(String(input.model))}` };
  }
  // The installed CLI's own published list wins over the documented enum: an
  // unpublished mode is rejected instead of being handed to a CLI that may not
  // accept it. `normalizePermissionMode` resolves the documented `default`
  // synonym to the canonical `standard` FIRST, so the value checked (and
  // launched) is always the canonical public mode.
  const published = Array.isArray(input.publishedPermissionModes) && input.publishedPermissionModes.length > 0
    ? input.publishedPermissionModes
    : PERMISSION_MODES;
  const mode = normalizePermissionMode(input.permissionMode, published);
  if (!mode) {
    return {
      ok: false,
      error:
        `invalid permission mode: ${JSON.stringify(String(input.permissionMode))} (valid: ${published.join(", ")}; ` +
        `"${PERMISSION_MODE_STANDARD_SYNONYM}" is accepted as a synonym for "standard")`
    };
  }

  const argv = ["-p", "--output-format", "json", "--model", m, "--permission-mode", mode];
  // Current Command Code print/headless mode has a second launch-time gate for
  // file writes and shell tools. Its own error text requires the dedicated
  // --yolo / --dangerously-skip-permissions flag even when
  // --permission-mode yolo is already present. Keep the semantic mode flag for
  // the CLI's mode selection, and add the dedicated bypass only for YOLO.
  if (mode === "yolo") argv.push("--yolo");
  argv.push("--skip-onboarding");

  const effort = input.effort;
  if (effort !== null && effort !== undefined && String(effort).trim() !== "") {
    if (input.effortSupported !== true) {
      return {
        ok: false,
        error:
          `The public --help of the Command Code CLI does not confirm support for ${EFFORT_FLAG}, so the argument is not passed: ` +
          `${JSON.stringify(String(effort))} (available only when the installed CLI's help text publishes this option)`
      };
    }
    const level = normalizeEffort(effort);
    if (!level) {
      return {
        ok: false,
        error: `invalid reasoning effort for Command Code: ${JSON.stringify(String(effort))} (valid: ${EFFORT_LEVELS.join(", ")})`
      };
    }
    // MODEL-SPECIFIC gate: `--effort` is not a global enum. The installed
    // package publishes each model's own levels (deepseek/deepseek-v4.1-flash:
    // low, high, max), and a level outside that list makes the CLI exit
    // immediately. Reject it here, before a process exists, instead of letting
    // the run fail on its first line. A model with no published list is never
    // rejected.
    const modelCheck = checkModelEffort({ model: m, effort: level, supported: input.supportedEfforts ?? null });
    if (!modelCheck.ok) return { ok: false, error: modelCheck.error };
    argv.push(EFFORT_FLAG, level);
  }

  const resume = input.resumeSessionId;
  if (resume !== null && resume !== undefined && String(resume).trim()) {
    const sid = String(resume).trim();
    if (!SESSION_TOKEN_RE.test(sid)) {
      return { ok: false, error: `invalid Command Code session id for --resume: ${JSON.stringify(sid)}` };
    }
    argv.push("--resume", sid);
  }

  return { ok: true, argv };
}

/** The official flag set without the value-carrying ones (evidence for tests). */
export const FIXED_FLAGS: readonly string[] = Object.freeze(["-p", "--output-format", "json", "--skip-onboarding"]);
