// windows-hidden-spawn-guard.test.ts — STATIC regression guard for every child
// process an automated test starts on Windows.
//
// Policy (Windows spawn audit):
//   * a test or test-driver child process passes `windowsHide: true`, so a
//     console-subsystem helper (node, cmd, netstat, git, a provider CLI) never
//     flashes a window on the desktop — including the grandchild a generated
//     fixture script starts, and the process-tree / detached fixtures;
//   * a PowerShell helper is additionally non-interactive
//     (`-NoProfile -NonInteractive`);
//   * a browser started for a UI test stays `--headless=new`;
//   * `shell: true` is never a way to hide a window (it is also an injection
//     hazard), so it is refused outright in test code.
//
// The guard reads the SOURCE files, not `dist`, so a spawn call written inside
// a generated fixture string literal is covered exactly like a direct call.
// Comment text is ignored and a call is matched as `name(` through its balanced
// parentheses, so multi-line option objects are handled (write a call without a
// space before the parenthesis, as the codebase does, or the guard cannot see
// it). Options built elsewhere (a variable passed as the third argument) cannot
// be verified and therefore fail closed: inline the options object or extend
// this guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
/** Source trees whose child processes are started by automated tests. */
const SCAN_ROOTS = ["src/tests", "scripts"];
const SOURCE_EXTENSIONS = new Set([".ts", ".cjs", ".mjs", ".js"]);
const SOURCES_PRESENT = fs.existsSync(path.join(REPO_ROOT, "src", "tests"));
/** This file states the policy, so it carries the policy's own literal text. */
const SELF_SOURCE = "src/tests/unit/windows-hidden-spawn-guard.test.ts";

// Built from parts so this guard's own text never contains a call it searches
// for. Longest names first so an alternation never stops inside a longer name.
const CALL_NAMES = ["spawnSync", "spawn", "execFileSync", "execFile", "exec", "fork"];
const SPAWN_CALL_RE = new RegExp(`(?<![\\w.$])(?:${CALL_NAMES.join("|")})\\(`, "g");
const SHELL_TRUE_RE = /(?<![\w.$])shell\s*:\s*true\b/;

interface ScannedSource {
  /** Repo-relative path with forward slashes. */
  rel: string;
  text: string;
}

interface SpawnCall {
  file: string;
  line: number;
  /** The full call text, used by the per-call checks. */
  text: string;
  /** The call text, whitespace-collapsed and truncated for messages. */
  snippet: string;
}

/**
 * Replace comment characters with spaces (newlines kept) so every match index
 * still maps onto the original source. String and template literals are NOT
 * masked: a generated fixture script lives inside one and its spawn calls are
 * exactly what this guard must see.
 */
function maskComments(source: string): string {
  const chars = source.split("");
  let quote: string | null = null;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && chars[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < chars.length) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

/** Index just past the `)` that closes the `(` at `openParen`. */
function balancedEnd(source: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

function collapse(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 157)}...` : one;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") stack.push(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

function scannedSources(): ScannedSource[] {
  const out: ScannedSource[] = [];
  for (const relRoot of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, relRoot))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (rel === SELF_SOURCE) continue;
      out.push({ rel, text: fs.readFileSync(file, "utf8") });
    }
  }
  return out;
}

function collectSpawnCalls(source: ScannedSource): SpawnCall[] {
  const masked = maskComments(source.text);
  const calls: SpawnCall[] = [];
  for (const match of masked.matchAll(SPAWN_CALL_RE)) {
    const start = match.index ?? 0;
    const openParen = start + match[0]!.length - 1;
    const text = source.text.slice(start, balancedEnd(source.text, openParen));
    calls.push({ file: source.rel, line: lineAt(source.text, start), text, snippet: collapse(text) });
  }
  return calls;
}

const SOURCES: ScannedSource[] = SOURCES_PRESENT ? scannedSources() : [];
const CALLS: SpawnCall[] = SOURCES.flatMap((source) => collectSpawnCalls(source));

/** `file:line snippet` lines for every call the predicate rejects. */
function violations(calls: readonly SpawnCall[], rejects: (call: SpawnCall) => boolean): string[] {
  return calls.filter(rejects).map((call) => `  - ${call.file}:${call.line}  ${call.snippet}`);
}

test("the guard reads direct spawn calls AND calls inside generated fixture scripts", { skip: !SOURCES_PRESENT }, () => {
  const files = new Set(CALLS.map((call) => call.file));
  for (const expected of [
    "src/tests/helpers/mcp-client.ts",
    "src/tests/integration/job-harness.test.ts",
    "src/tests/integration/mcp-stdio.test.ts",
    "src/tests/integration/process-tree-cancel.test.ts",
    "scripts/webcodex-mcp-console.cjs"
  ]) {
    assert.ok(
      files.has(expected),
      `the guard must scan ${expected} (saw ${CALLS.length} calls in ${files.size} files)`
    );
  }
  assert.ok(
    CALLS.some((call) => call.text.includes("setInterval(")),
    "the guard must see a spawn call written inside a generated fixture script (a string literal)"
  );
});

test("every automated-test child process requests a hidden Windows window", { skip: !SOURCES_PRESENT }, () => {
  const found = violations(CALLS, (call) => !/windowsHide\s*:\s*true/.test(call.text));
  assert.deepEqual(
    found,
    [],
    `child-process call(s) must pass windowsHide: true (never shell:true merely to hide a window):\n${found.join("\n")}`
  );
});

test("automated-test PowerShell helpers are non-interactive", { skip: !SOURCES_PRESENT }, () => {
  const shellCalls = CALLS.filter((call) => /powershell/i.test(call.text));
  assert.ok(shellCalls.length > 0, "the guard must see the known PowerShell call sites");
  const found = violations(
    shellCalls,
    (call) => !call.text.includes("-NoProfile") || !call.text.includes("-NonInteractive")
  );
  assert.deepEqual(
    found,
    [],
    `PowerShell helper(s) must run non-interactively (-NoProfile -NonInteractive):\n${found.join("\n")}`
  );
});

test("UI-test browsers stay headless", { skip: !SOURCES_PRESENT }, () => {
  const browserCalls = CALLS.filter((call) => call.text.includes("--remote-debugging-port"));
  assert.ok(browserCalls.length > 0, "the guard must see the browser test's launch calls");
  const found = violations(browserCalls, (call) => !call.text.includes("--headless=new"));
  assert.deepEqual(found, [], `a browser started by a UI test must stay --headless=new:\n${found.join("\n")}`);
});

test("test code never uses shell:true to hide a window", { skip: !SOURCES_PRESENT }, () => {
  const found: string[] = [];
  for (const source of SOURCES) {
    const masked = maskComments(source.text);
    for (const match of masked.matchAll(new RegExp(SHELL_TRUE_RE.source, "g"))) {
      found.push(`  - ${source.rel}:${lineAt(source.text, match.index ?? 0)}  shell: true`);
    }
  }
  assert.deepEqual(
    found,
    [],
    `shell: true is never a way to hide a window (and is an injection hazard); keep argv-safe direct spawning:\n${found.join("\n")}`
  );
});
