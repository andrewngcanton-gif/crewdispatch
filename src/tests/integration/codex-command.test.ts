import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "../../..");
const installer = path.join(root, "scripts/install-codex-command.cjs");
const uninstaller = path.join(root, "scripts/uninstall-codex-command.cjs");
const preCanonicalPrompt = `---\ndescription: CrewDispatch — 在当前对话中派发任务\n---\n\nLoad and follow the CrewDispatch dispatch skill (legacy: jobquay-dispatch), including task preparation and acceptance. Dispatch the request appended below, or the latest agreed task in this conversation. Ask only if the objective or workspace is unclear; report missing skill or MCP tools.\n\nTask:\n`;

test("Codex command registration from another cwd is idempotent and preserves other prompts", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-command-"));
  try {
    const prompts = path.join(temporary, "prompts");
    fs.mkdirSync(prompts);
    fs.writeFileSync(path.join(prompts, "personal.md"), "personal command");
    const run = () => spawnSync(process.execPath, [installer, "--codex-home", temporary], {
      cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    for (let i = 0; i < 2; i++) {
      const result = run();
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\/prompts:crewdispatch/);
    }
    const installed = fs.readFileSync(path.join(prompts, "crewdispatch.md"), "utf8");
    assert.equal(installed, fs.readFileSync(path.join(root, "integrations/codex/prompts/crewdispatch.md"), "utf8"));
    assert.equal(fs.readFileSync(path.join(prompts, "personal.md"), "utf8"), "personal command");
    fs.writeFileSync(path.join(prompts, "crewdispatch.md"), "user customized command");
    const conflict = run();
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Preserved existing command/);
    assert.equal(fs.readFileSync(path.join(prompts, "crewdispatch.md"), "utf8"), "user customized command");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("Codex command registration upgrades only the exact pre-canonical CrewDispatch prompt", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-command-legacy-"));
  try {
    const prompts = path.join(temporary, "prompts");
    fs.mkdirSync(prompts);
    fs.writeFileSync(path.join(prompts, "crewdispatch.md"), preCanonicalPrompt);
    const result = spawnSync(process.execPath, [installer, "--codex-home", temporary], {
      cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated pre-0\.1\.0 CrewDispatch command/);
    assert.equal(
      fs.readFileSync(path.join(prompts, "crewdispatch.md"), "utf8"),
      fs.readFileSync(path.join(root, "integrations/codex/prompts/crewdispatch.md"), "utf8")
    );
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("Codex command uninstall removes only the untouched CrewDispatch prompt", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "crewdispatch-command-uninstall-"));
  try {
    const prompts = path.join(temporary, "prompts");
    fs.mkdirSync(prompts);
    fs.writeFileSync(path.join(prompts, "personal.md"), "personal command");
    const run = (script: string) => spawnSync(process.execPath, [script, "--codex-home", temporary], {
      cwd: temporary, encoding: "utf8", windowsHide: true, timeout: 10000,
    });

    assert.equal(run(installer).status, 0);
    const removed = run(uninstaller);
    assert.ifError(removed.error);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.existsSync(path.join(prompts, "crewdispatch.md")), false);
    assert.equal(fs.readFileSync(path.join(prompts, "personal.md"), "utf8"), "personal command");

    const absent = run(uninstaller);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /already absent/);

    fs.writeFileSync(path.join(prompts, "crewdispatch.md"), preCanonicalPrompt);
    const legacyRemoved = run(uninstaller);
    assert.equal(legacyRemoved.status, 0, legacyRemoved.stderr);
    assert.equal(fs.existsSync(path.join(prompts, "crewdispatch.md")), false);

    assert.equal(run(installer).status, 0);
    fs.writeFileSync(path.join(prompts, "crewdispatch.md"), "user customized command");
    const conflict = run(uninstaller);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Preserved user-modified command/);
    assert.equal(fs.readFileSync(path.join(prompts, "crewdispatch.md"), "utf8"), "user customized command");
    assert.equal(fs.readFileSync(path.join(prompts, "personal.md"), "utf8"), "personal command");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("Codex command installer rejects missing option values", () => {
  const result = spawnSync(process.execPath, [installer, "--codex-home"], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected --codex-home/);
});
