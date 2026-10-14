// one-shot-cli.ts — REAL end-to-end probe of one short, no-side-effect prompt
// through the user-installed official Command Code CLI, from the BUILT artifact.
//
//   npm.cmd run test:e2e:command-code     -> node dist/cli/one-shot-cli.js
//   node dist/cli/one-shot-cli.js --dry-run   (plan only; no child, no quota)
//
// Behaviour:
//   - resolves the official CLI (read-only PATH/env lookup; no child process);
//   - creates ONE isolated environment (src/cli/run-isolation.ts) BEFORE any
//     official-CLI probe, and passes that SAME env + cwd to every CLI call of the
//     run: `--version`, `--help`, `--list-models` and the real prompt;
//   - reads the CLI's public catalog; the model is either requested explicitly or
//     taken from the CLI's own catalog/default. If the catalog is unavailable the
//     run is REFUSED (a model id is never invented) and the real profile is NEVER
//     used as a catalog fallback;
//   - runs ONE request in the isolated cwd with the safest permission mode by
//     default (`plan`: no edits) and a deliberately tiny prompt;
//   - ISOLATES the CLI's own data: the official CLI roots everything it writes at
//     `${env.HOME ?? env.USERPROFILE}/.commandcode` (auth.json, sessions/,
//     projects/ transcripts, history.jsonl, settings.json, mcp.json, plans,
//     skills, taste), where `~` = env.HOME ?? env.USERPROFILE (verified read-only
//     in the installed cmdc 1.65.0; there is no dedicated config-dir override).
//     HOME and USERPROFILE are pointed at a disposable `<temp>/cli-home`, so every
//     CLI-produced session, config and credential stays confined to the throwaway
//     tree. The real `~/.commandcode` is not referenced by the isolated
//     environment — but this is a MECHANISM, and a live "real profile unchanged"
//     confirmation is a separate acceptance item that is NOT claimed here
//     (reported as `isolation.liveConfirmed: false`);
//   - CREDENTIAL HYGIENE: the child environment is built from a minimal
//     non-credential ALLOWLIST (PATH/PATHEXT/ComSpec/SystemRoot on Windows) plus
//     the redirected home/data/temp roots, so a credential the operator has
//     exported (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) and any stray config path
//     are NOT inherited — this is not limited to a named list. A dedicated test
//     credential is forwarded only when the operator names it explicitly for this
//     run, e.g. `--credential-env COMMAND_CODE_API_KEY` (never a default; only the
//     name is reported, never the value);
//   - spawns with shell:false, feeds the prompt on STDIN and folds the real
//     NDJSON stream through the production parser;
//   - reports the real exit code, its classification, the terminal record and the
//     usage as the CLI reported it (unavailable metrics stay unavailable);
//   - passes ONLY on a real exit 0 + terminal `success` + no error/timeout/spawn
//     error (see one-shot-verdict.ts); any other outcome exits 1.
//
// NO product wall-clock timeout by default: the child runs to its own exit.
// `--max-wait-ms` exists only as an operator escape hatch and is reported when
// used. This command spends the user's own entitlement at most once per run.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createLineSplitter } from "../runtime/line-splitter";
import { createCommandCodeAdapter } from "../providers/command-code/index";
import { createCommandCodeState, parseCommandCodeRecord, normalizeUsage, usageText } from "../providers/command-code/stream";
import { classifyCommandCodeExit } from "../providers/command-code/exit";
import { describeCommandCodeCliSource } from "../providers/command-code/discovery";
import { computeOneShotVerdict, isOneShotSuccess } from "./one-shot-verdict";
import { createCliIsolation, describeCliIsolation, parseForwardCredentialEnv } from "./run-isolation";

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" ? v : null;
}

const DEFAULT_PROMPT = "Reply with exactly one word: pong";
const STDERR_TAIL_CAP = 2000;

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const explicitPath = argValue("--cli-path");
  const requestedModel = argValue("--model") || process.env.JOBQUAY_E2E_MODEL || null;
  const permissionMode = argValue("--permission") || process.env.JOBQUAY_E2E_PERMISSION || "plan";
  const prompt = argValue("--prompt") || process.env.JOBQUAY_E2E_PROMPT || DEFAULT_PROMPT;
  const maxWaitMs = Number(argValue("--max-wait-ms") || process.env.JOBQUAY_E2E_MAX_WAIT_MS || "") || null;
  const outFile = argValue("--out") || null;
  const forwardCredentialEnv = parseForwardCredentialEnv(process.argv);

  const adapter = createCommandCodeAdapter();
  const resolution = adapter.resolveCli(explicitPath ? { configPath: explicitPath } : {});
  const base: Record<string, unknown> = {
    entry: "dist/cli/one-shot-cli.js",
    node: process.version,
    platform: process.platform,
    dryRun,
    resolution: {
      ok: resolution.ok,
      path: resolution.path,
      source: resolution.source,
      sourceLabel: describeCommandCodeCliSource(resolution.source),
      reason: resolution.reason ?? null
    }
  };
  if (!resolution.ok || !resolution.path) {
    base.error = "The official Command Code CLI was not found; no child process was started.";
    console.log(JSON.stringify(base, null, 2));
    return 1;
  }

  const cliPath = resolution.path;

  // Isolation is created BEFORE any official-CLI probe, and the same env + cwd are
  // handed to every CLI call below (probes and the real prompt).
  const isolation = createCliIsolation({ tempPrefix: "jobquay-e2e-", forwardCredentialEnv });
  base.isolation = describeCliIsolation(isolation);

  const probeInput = { cliPath, env: isolation.env, cwd: isolation.cwd };
  const capabilities = await adapter.probeCapabilities(probeInput);
  const catalog = await adapter.readModelCatalog(probeInput);

  let model = requestedModel;
  if (!model) {
    if (!catalog.ok || !catalog.defaultModel) {
      base.error =
        "The model catalog is unavailable (cmdc --list-models returned no usable catalog in the isolated environment) and no --model was given explicitly; " +
        "CrewDispatch will not invent a model ID or fall back to the real user profile's catalog, so this real prompt verification was cancelled.";
      base.catalog = { ok: catalog.ok, error: catalog.error };
      console.log(JSON.stringify(base, null, 2));
      return 1;
    }
    model = catalog.defaultModel;
  }

  const runPlan = adapter.buildRunPlan({
    cliPath,
    model,
    permissionMode,
    publishedPermissionModes: capabilities.permissionModes,
    effort: null,
    effortSupported: capabilities.supportsEffort
  });
  if (!runPlan.ok) {
    base.error = `Run plan build failed (${runPlan.stage}): ${runPlan.error}`;
    console.log(JSON.stringify(base, null, 2));
    return 1;
  }

  base.plan = {
    file: runPlan.plan.file,
    args: runPlan.plan.args,
    windowsVerbatimArguments: runPlan.plan.windowsVerbatimArguments,
    shellShim: runPlan.plan.shellShim,
    shell: false,
    cwd: isolation.cwd,
    model,
    permissionMode,
    effort: null,
    modelSource: requestedModel ? "explicit" : "cli-catalog-default",
    maxWaitMs
  };

  if (dryRun) {
    base.result = "dry-run";
    console.log(JSON.stringify(base, null, 2));
    return 0;
  }

  const state = createCommandCodeState();
  const splitter = createLineSplitter();
  const evidence: string[] = [];
  let stderrTail = "";
  let stdoutChars = 0;
  let lineCount = 0;
  let killedByMaxWait = false;
  let spawnError: string | null = null;

  const code = await new Promise<number | null>((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(runPlan.plan.file, runPlan.plan.args, {
        shell: false,
        cwd: isolation.cwd,
        env: isolation.env,
        windowsHide: true,
        windowsVerbatimArguments: runPlan.plan.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (e) {
      spawnError = String((e as Error)?.message || e);
      base.spawnError = spawnError;
      resolve(null);
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    if (maxWaitMs && maxWaitMs > 0) {
      timer = setTimeout(() => {
        killedByMaxWait = true;
        base.killedByMaxWait = true;
        try {
          child.kill();
        } catch {
          /* best effort */
        }
      }, maxWaitMs);
    }

    try {
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt, "utf8");
    } catch {
      /* best effort */
    }

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stdoutChars += text.length;
      for (const line of splitter.feed(text)) {
        lineCount += 1;
        parseCommandCodeRecord(line, state);
        if (evidence.length < 5 && line.trim()) evidence.push(line.trim().slice(0, 400));
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-STDERR_TAIL_CAP);
    });
    child.on("error", (e: Error) => {
      spawnError = String(e?.message || e);
      base.childError = spawnError;
    });
    child.on("close", (c: number | null) => {
      if (timer) clearTimeout(timer);
      for (const line of splitter.flush()) {
        lineCount += 1;
        parseCommandCodeRecord(line, state);
      }
      resolve(c);
    });
  });

  const classification = classifyCommandCodeExit(code);
  const usage = normalizeUsage(state);
  base.result = {
    exitCode: code,
    classification,
    lines: lineCount,
    stdoutChars,
    terminal: state.terminal,
    resultSubtype: state.resultSubtype,
    isError: state.isError,
    stopReason: state.stopReason,
    sessionId: state.sessionId,
    model: state.model,
    actualModel: state.actualModel,
    finalResultPreview: state.finalResult ? state.finalResult.slice(0, 300) : null,
    usage,
    usageText: {
      tokensIn: usageText(usage.tokensIn),
      tokensOut: usageText(usage.tokensOut),
      toolCalls: usageText(usage.toolCalls),
      credits: usageText(usage.credits),
      totalCostUsd: usageText(usage.totalCostUsd),
      cacheRead: usageText(usage.cacheRead)
    },
    malformedLines: state.malformedLines,
    unknownLines: state.unknownLines,
    stderrTail: stderrTail.slice(-800),
    evidence,
    isolation: describeCliIsolation(isolation)
  };

  // Only a real exit 0 + terminal `success` + no error/timeout/spawn error passes.
  const verdict = computeOneShotVerdict({
    outcome: {
      exitCode: code,
      terminal: state.terminal,
      resultSubtype: state.resultSubtype,
      isError: state.isError,
      stopReason: state.stopReason,
      errorMsg: state.errorMsg
    },
    killedByMaxWait,
    spawnError
  });
  const ok = isOneShotSuccess(verdict);
  base.verdict = verdict;
  const text = JSON.stringify(base, null, 2);
  console.log(text);
  if (outFile) fs.writeFileSync(outFile, text + "\n", "utf8");
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code));
