// job-cli.ts — the small BUILT harness that drives the local job service from a
// separate process.
//
//   node dist/cli/job-cli.js start   --root <dir> --task "..." [--cwd <dir>] [--model M]
//                                    [--provider command-code|workbuddy-ai]
//                                    [--permission plan] [--effort high] [--fixture <js>]
//                                    [--cli-path <exe>]
//   node dist/cli/job-cli.js worker  --root <dir> --job <id> [--fixture <js>] [--cli-path <exe>]
//   node dist/cli/job-cli.js status  --root <dir> --job <id>
//   node dist/cli/job-cli.js list    --root <dir>
//   node dist/cli/job-cli.js cancel  --root <dir> --job <id> [--wait-ms N]
//   node dist/cli/job-cli.js resume  --root <dir> --job <id> [--task "..."] [--fixture <js>]
//   node dist/cli/job-cli.js wait    --root <dir> --job <id> [--timeout-ms N]
//   node dist/cli/job-cli.js reconcile --root <dir>
//
// Every subcommand prints ONE JSON object to stdout. `start` returns the stable
// job id as soon as the detached worker is launched — the caller may exit (or be
// killed) and the job keeps running. `wait` is a CLIENT-side poll with an
// optional bound; it never kills the job (CrewDispatch imposes no wall-clock timeout
// on a job).
//
// The harness runs the PRODUCTION path: it inherits the caller's environment and
// uses the requested `--cwd`, so a TEST that wants an isolated profile must pass
// one in (env + a cwd inside the disposable tree) — see the batch-2 e2e/harness
// tests. This is an internal acceptance harness, not the product UI or the MCP
// entry.
import fs from "node:fs";
import path from "node:path";
import {
  getStatus,
  prepareContinuation,
  providerManagedIgnoredPids,
  requestCancel,
  runWorker,
  startJob,
  type RunWorkerResult
} from "../jobs/service";
import { recoverTerminalHolders, reconcileAll } from "../jobs/reconcile";
import { listJobs, resolveDataRoot } from "../jobs/store";
import { workspaceJobFilter } from "../jobs/workspace";
import { readBootTime } from "../runtime/process";
import { toStatusView, type JobRecord, type NotifyTarget } from "../jobs/types";
import type { CreateRunner } from "../jobs/runner";
import { NotifyInputError, resolveNotifyTarget } from "../mcp/notify";
import { createWorkBuddyAiAdapter, WORKBUDDY_AI_PROVIDER } from "../providers/workbuddy-ai/index";
import { createFixtureRunner } from "./fixture-runner";

// TEST-ONLY: hosted functional suites whose controlled provider process is
// contractually childless may skip the expensive Windows process-table scan at
// natural root exit. The test harness is the only code that injects this marker;
// product config/tool schemas never emit it. Tests that deliberately create
// descendants must leave it unset (or set it to "0").
const TEST_CHILDLESS_FIXTURE_SCAN_ENV = "JOBQUAY_TEST_CHILDLESS_FIXTURE_SCAN";
const TEST_NOTIFY_TIMEOUT_ENV = "JOBQUAY_TEST_NOTIFY_TIMEOUT_MS";

interface ParsedArgs {
  flags: Map<string, string[]>;
  positionals: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const push = (k: string, v: string): void => {
    const list = flags.get(k) ?? [];
    list.push(v);
    flags.set(k, list);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (typeof a !== "string") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        push(a.slice(0, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (typeof next === "string" && !next.startsWith("--")) {
          push(a, next);
          i += 1;
        } else {
          push(a, "true");
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function get(args: ParsedArgs, name: string): string | null {
  const list = args.flags.get(name);
  return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
}
function getNum(args: ParsedArgs, name: string): number | null {
  const v = get(args, name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function print(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function taskFrom(args: ParsedArgs): string {
  const t = get(args, "--task");
  if (t != null) return t;
  return readStdin();
}

/**
 * Terminal-wake target from the harness flags (callback > thread > env). Returns
 * `undefined` when NEITHER flag is present, so a resume keeps the job's persisted
 * target instead of silently resetting it.
 */
function notifyFrom(args: ParsedArgs): NotifyTarget | undefined {
  const callback = get(args, "--callback-url");
  const thread = get(args, "--codex-thread-id");
  if (callback == null && thread == null) return undefined;
  try {
    return resolveNotifyTarget({ callbackUrl: callback, codexThreadId: thread, env: process.env });
  } catch (e) {
    if (e instanceof NotifyInputError) throw e;
    throw e;
  }
}

function view(job: JobRecord): Record<string, unknown> {
  return { ...toStatusView(job) } as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdStart(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  if (!root) {
    print({ ok: false, error: "--root is required" });
    return 1;
  }
  const fixture = get(args, "--fixture");
  const cwd = get(args, "--cwd") ?? process.cwd();
  try {
    // The harness dispatches WITHOUT a daemon, so it reaches the same bounded
    // passive recovery itself: a terminal holder of THIS directory whose
    // retained managed tree is independently proven stopped releases before the
    // authoritative admission check. Best-effort only — a live/unproven tree
    // still yields the ordinary `workspace_busy` refusal.
    try {
      await recoverTerminalHolders(root, {
        by: "cli-admission",
        includeJob: workspaceJobFilter(cwd),
        ignoredPidsFor: (job) => providerManagedIgnoredPids(job, process.env, root),
        readBootTimeFn: readBootTime
      });
    } catch {
      /* recovery is best-effort; the authoritative check still runs */
    }
    const result = startJob({
      root,
      task: taskFrom(args),
      cwd,
      model: get(args, "--model"),
      permissionMode: get(args, "--permission"),
      effort: get(args, "--effort"),
      // `--provider` selects the supported CLI (default: command-code).
      // `workbuddy-ai` uses its isolated international profile and may use its
      // saved provider default model when `--model` is omitted.
      provider: get(args, "--provider") ?? undefined,
      // The runner follows the provider unless a TEST fixture was requested.
      runner: fixture ? "fixture" : undefined,
      fixturePath: fixture,
      cliPath: get(args, "--cli-path"),
      notifyTarget: notifyFrom(args)
    });
    print({
      ok: true,
      jobId: result.job.id,
      status: result.job.status,
      workerPid: result.workerPid,
      root: resolveDataRoot(root),
      provider: result.job.provider,
      runner: result.job.runner,
      notify: result.job.notifyTarget
    });
    return 0;
  } catch (e) {
    // A stable service refusal (e.g. `workspace_busy`, `config_invalid`) keeps
    // its code in the harness output so an acceptance can assert it.
    const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : null;
    print({ ok: false, code, error: String((e as Error)?.message || e) });
    return 1;
  }
}

function workerDeathDetail(value: unknown): string {
  if (value instanceof Error) return String(value.stack || value.message || value.name).slice(0, 4000);
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return String(value).slice(0, 4000);
  }
}

/**
 * Minimal worker-death diagnostics. The detached worker's stderr is already
 * redirected to <job>.worker.log, so keep the breadcrumb on that existing
 * channel instead of adding another persistence format.
 *
 * Signal handlers re-raise the SAME signal after the synchronous write, so they
 * do not turn SIGTERM/SIGINT/SIGHUP into a graceful application exit. SIGKILL
 * cannot be observed by a process; a sudden worker disappearance with no
 * breadcrumb therefore remains useful evidence of a hard/unobservable kill.
 */
function installWorkerDeathBreadcrumbs(jobId: string): void {
  const write = (event: string, detail: string | null = null): void => {
    const record = {
      type: "crewdispatch_worker_death",
      at: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      jobId,
      event,
      detail
    };
    try {
      fs.writeSync(2, `[crewdispatch-worker-death] ${JSON.stringify(record)}\n`);
    } catch {
      // Diagnostics must never interfere with the worker's real failure path.
    }
  };

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = (): void => {
      write("signal", signal);
      process.removeListener(signal, handler);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = 128;
      }
    };
    process.once(signal, handler);
  }

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    write(`uncaughtException:${origin}`, workerDeathDetail(error));
  });

  const rejectionHandler = (reason: unknown): void => {
    write("unhandledRejection", workerDeathDetail(reason));
    process.removeListener("unhandledRejection", rejectionHandler);
    queueMicrotask(() => {
      throw reason instanceof Error ? reason : new Error(workerDeathDetail(reason));
    });
  };
  process.on("unhandledRejection", rejectionHandler);
}

async function cmdWorker(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  const jobId = get(args, "--job");
  if (!root || !jobId) {
    print({ ok: false, error: "--root and --job are required" });
    return 1;
  }
  installWorkerDeathBreadcrumbs(jobId);
  const fixture = get(args, "--fixture");
  // A fixture substitutes the provider PROCESS only: for a WorkBuddy job it is
  // driven through the REAL WorkBuddy adapter (approval records, terminal
  // classification), exactly like the other controlled runs.
  const createRunner: CreateRunner | undefined = fixture
    ? (ctx) =>
        Promise.resolve(
          createFixtureRunner(
            fixture,
            ctx.env,
            ctx.job.provider === WORKBUDDY_AI_PROVIDER ? createWorkBuddyAiAdapter() : undefined
          )
        )
    : undefined;
  const enumerateFn = process.env[TEST_CHILDLESS_FIXTURE_SCAN_ENV] === "1"
    ? async () => ({ ok: true as const, processes: [] })
    : undefined;
  const rawNotifyTimeout = fixture ? Number(process.env[TEST_NOTIFY_TIMEOUT_ENV]) : Number.NaN;
  const notify = Number.isFinite(rawNotifyTimeout) && rawNotifyTimeout > 0
    ? { timeoutMs: Math.floor(rawNotifyTimeout) }
    : undefined;
  let result: RunWorkerResult;
  try {
    result = await runWorker({
      root,
      jobId,
      cliPath: get(args, "--cli-path"),
      createRunner,
      enumerateFn,
      notify
    });
  } catch (e) {
    print({ ok: false, jobId, error: String((e as Error)?.message || e) });
    return 1;
  }
  print(result);
  return result.ok ? 0 : 1;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  const jobId = get(args, "--job");
  if (!root || !jobId) {
    print({ ok: false, error: "--root and --job are required" });
    return 1;
  }
  const job = getStatus(root, jobId);
  if (!job) {
    print({ ok: false, error: "job not found", jobId });
    return 1;
  }
  print({ ok: true, job: view(job) });
  return 0;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  if (!root) {
    print({ ok: false, error: "--root is required" });
    return 1;
  }
  reconcileAll(root);
  const { jobs, unreadable } = listJobs(resolveDataRoot(root));
  print({ ok: true, count: jobs.length, unreadable, jobs: jobs.map(view) });
  return 0;
}

async function cmdCancel(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  const jobId = get(args, "--job");
  if (!root || !jobId) {
    print({ ok: false, error: "--root and --job are required" });
    return 1;
  }
  const waitMs = getNum(args, "--wait-ms") ?? 5000;
  const result = await requestCancel(root, jobId, { by: `harness-${process.pid}`, waitMs });
  print({
    ok: result.job != null,
    job: result.job ? view(result.job) : null,
    kill: result.kill,
    finalizedBy: result.finalizedBy,
    providerCancel: result.providerCancel
  });
  return result.job ? 0 : 1;
}

async function cmdResume(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  const jobId = get(args, "--job");
  if (!root || !jobId) {
    print({ ok: false, error: "--root and --job are required" });
    return 1;
  }
  const fixture = get(args, "--fixture");
  const result = await prepareContinuation({
    root,
    jobId,
    task: taskFrom(args),
    fixturePath: fixture,
    cliPath: get(args, "--cli-path"),
    notifyTarget: notifyFrom(args)
  });
  if (!result.ok) {
    print({ ok: false, code: result.code, error: result.error, job: result.job ? view(result.job) : null });
    return 1;
  }
  print({ ok: true, jobId: result.job.id, status: result.job.status, generation: result.job.generation, workerPid: result.workerPid });
  return 0;
}

async function cmdWait(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  const jobId = get(args, "--job");
  if (!root || !jobId) {
    print({ ok: false, error: "--root and --job are required" });
    return 1;
  }
  const timeoutMs = getNum(args, "--timeout-ms") ?? 60000;
  const pollMs = getNum(args, "--poll-ms") ?? 200;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getStatus(root, jobId);
    if (!job) {
      print({ ok: false, error: "job not found", jobId });
      return 1;
    }
    const terminal = ["done", "error", "cancelled", "interrupted"].includes(job.status);
    if (terminal) {
      print({ ok: true, terminal: true, timedOut: false, job: view(job) });
      return 0;
    }
    if (Date.now() >= deadline) {
      print({ ok: false, terminal: false, timedOut: true, job: view(job) });
      return 2;
    }
    await sleep(pollMs);
  }
}

async function cmdReconcile(args: ParsedArgs): Promise<number> {
  const root = get(args, "--root");
  if (!root) {
    print({ ok: false, error: "--root is required" });
    return 1;
  }
  const result = reconcileAll(root);
  print({
    ok: true,
    scanned: result.scanned,
    unreadable: result.unreadable,
    changed: result.changed.map((j) => ({ id: j.id, status: j.status, stopReason: j.stopReason }))
  });
  return 0;
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<number>> = {
  start: cmdStart,
  worker: cmdWorker,
  status: cmdStatus,
  list: cmdList,
  cancel: cmdCancel,
  resume: cmdResume,
  wait: cmdWait,
  reconcile: cmdReconcile
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    print({ ok: false, error: `usage: job-cli.js <${Object.keys(COMMANDS).join("|")}> [--flags]`, entry: path.basename(__filename) });
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    print({ ok: false, error: `unknown command: ${command}`, commands: Object.keys(COMMANDS) });
    return 1;
  }
  return handler(parseArgs(argv.slice(1)));
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    print({ ok: false, error: String((e as Error)?.stack || e) });
    process.exit(1);
  });
