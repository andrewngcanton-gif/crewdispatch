// run-isolation.test.ts — regression for the shared CLI isolation helper.
//
// The isolation gap this pins down: the entries used to run their official-CLI
// probes with the real process environment (real HOME/USERPROFILE) and inherited
// credential vars into the child. The helper is the single place that fixes both:
// the child env is built from an explicit MINIMAL_ENV_ALLOWLIST (so a credential
// the operator exported cannot leak in even if CrewDispatch never enumerated it), and
// the home/data/temp roots are redirected into a disposable tree. These tests
// assert the mechanism directly (no real CLI is launched here).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  KNOWN_CREDENTIAL_ENV_VARS,
  MINIMAL_ENV_ALLOWLIST,
  createCliIsolation,
  describeCliIsolation,
  parseForwardCredentialEnv
} from "../../cli/run-isolation";

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("HOME and USERPROFILE are redirected into the disposable cli-home, which exists", () => {
  const iso = createCliIsolation({ env: { PATH: "x", HOME: "/real/home", USERPROFILE: "C:/real" }, tempPrefix: "jobquay-test-" });
  try {
    assert.equal(iso.env.HOME, iso.cliHome);
    assert.equal(iso.env.USERPROFILE, iso.cliHome);
    assert.notEqual(iso.cliHome, "/real/home");
    assert.ok(iso.cliHome.startsWith(iso.root));
    assert.ok(fs.statSync(iso.cliHome).isDirectory());
    assert.ok(fs.statSync(iso.cwd).isDirectory());
    // An allowlisted non-credential variable is carried.
    assert.equal(iso.env.PATH, "x");
  } finally {
    cleanup(iso.root);
  }
});

test("home, app-data, temp and XDG roots are redirected into the isolated tree and exist", () => {
  const iso = createCliIsolation({ env: { PATH: "x" }, tempPrefix: "jobquay-test-" });
  try {
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      const value = iso.env[name];
      assert.equal(typeof value, "string", `${name} must be set`);
      assert.ok((value as string).startsWith(iso.root), `${name} must point inside the isolated tree`);
      assert.ok(fs.statSync(value as string).isDirectory(), `${name} dir must exist`);
      assert.equal(iso.redirectedEnv[name], value);
    }
  } finally {
    cleanup(iso.root);
  }
});

test("win32 also redirects HOMEDRIVE/HOMEPATH; non-win32 does not set them", () => {
  const win = createCliIsolation({ env: { PATH: "x" }, platform: "win32", tempPrefix: "jobquay-test-" });
  const posix = createCliIsolation({ env: { PATH: "x" }, platform: "linux", tempPrefix: "jobquay-test-" });
  try {
    const drive = win.env.HOMEDRIVE;
    const homePath = win.env.HOMEPATH;
    assert.equal(typeof drive, "string");
    assert.equal(typeof homePath, "string");
    assert.equal(`${drive}${homePath}`, win.cliHome);
    assert.equal(posix.env.HOMEDRIVE, undefined);
    assert.equal(posix.env.HOMEPATH, undefined);
  } finally {
    cleanup(win.root);
    cleanup(posix.root);
  }
});

test("known credential env vars are dropped by default and reported", () => {
  const env: NodeJS.ProcessEnv = { PATH: "x", KEEP: "1" };
  for (const name of KNOWN_CREDENTIAL_ENV_VARS) env[name] = "secret-value";
  const iso = createCliIsolation({ env, tempPrefix: "jobquay-test-" });
  try {
    for (const name of KNOWN_CREDENTIAL_ENV_VARS) {
      assert.equal(iso.env[name], undefined, `${name} must be dropped`);
    }
    assert.deepEqual([...iso.removedCredentialVars].sort(), [...KNOWN_CREDENTIAL_ENV_VARS].sort());
    assert.deepEqual(iso.forwardedCredentialVars, []);
    // Not on the allowlist -> not inherited (the old {...process.env} merge did).
    assert.equal(iso.env.KEEP, undefined);
    assert.ok(iso.carriedEnvVars.includes("PATH"));
  } finally {
    cleanup(iso.root);
  }
});

test("the allowlist keeps unenumerated credentials and config paths out of the child env", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "x",
    PATHEXT: ".COM;.EXE",
    OPENAI_API_KEY: "sk-openai-secret",
    ANTHROPIC_API_KEY: "sk-anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "gh-token",
    SOME_VENDOR_API_KEY: "vendor-key",
    MYAPP_CONFIG_PATH: "C:/real/config.json",
    NODE_OPTIONS: "--require ./evil.js",
    HTTP_PROXY: "http://user:pass@proxy:8080"
  };
  const iso = createCliIsolation({ env, tempPrefix: "jobquay-test-" });
  try {
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "SOME_VENDOR_API_KEY", "MYAPP_CONFIG_PATH", "NODE_OPTIONS", "HTTP_PROXY"]) {
      assert.equal(iso.env[name], undefined, `${name} must NOT reach the child`);
    }
    // Allowlisted bootstrap vars still carried.
    assert.equal(iso.env.PATH, "x");
    assert.equal(iso.env.PATHEXT, ".COM;.EXE");
    // Secret-looking dropped names are reported by NAME only (never a value).
    assert.ok(iso.droppedSensitiveVars.includes("OPENAI_API_KEY"));
    assert.ok(iso.droppedSensitiveVars.includes("ANTHROPIC_API_KEY"));
    assert.ok(iso.droppedSensitiveVars.includes("GITHUB_TOKEN"));
    assert.ok(!JSON.stringify(iso).includes("sk-openai-secret"), "no credential value may appear in the isolation object");
  } finally {
    cleanup(iso.root);
  }
});

test("a credential is forwarded only when the operator names it explicitly", () => {
  const iso = createCliIsolation({
    env: { PATH: "x", COMMAND_CODE_API_KEY: "dedicated-test-key" },
    forwardCredentialEnv: ["COMMAND_CODE_API_KEY"],
    tempPrefix: "jobquay-test-"
  });
  try {
    assert.equal(iso.env.COMMAND_CODE_API_KEY, "dedicated-test-key");
    assert.deepEqual(iso.forwardedCredentialVars, ["COMMAND_CODE_API_KEY"]);
    assert.deepEqual(iso.removedCredentialVars, []);
  } finally {
    cleanup(iso.root);
  }
});

test("an explicitly forwarded non-known credential is injected, not dropped", () => {
  const iso = createCliIsolation({
    env: { PATH: "x", OPENAI_API_KEY: "dedicated-openai-key" },
    forwardCredentialEnv: ["OPENAI_API_KEY"],
    tempPrefix: "jobquay-test-"
  });
  try {
    assert.equal(iso.env.OPENAI_API_KEY, "dedicated-openai-key");
    assert.deepEqual(iso.forwardedCredentialVars, ["OPENAI_API_KEY"]);
    assert.ok(!iso.droppedSensitiveVars.includes("OPENAI_API_KEY"));
  } finally {
    cleanup(iso.root);
  }
});

test("a requested-but-absent credential is reported, never invented", () => {
  const iso = createCliIsolation({ env: { PATH: "x" }, forwardCredentialEnv: ["COMMAND_CODE_API_KEY"], tempPrefix: "jobquay-test-" });
  try {
    assert.equal(iso.env.COMMAND_CODE_API_KEY, undefined);
    assert.deepEqual(iso.missingCredentialVars, ["COMMAND_CODE_API_KEY"]);
    assert.deepEqual(iso.forwardedCredentialVars, []);
  } finally {
    cleanup(iso.root);
  }
});

test("describeCliIsolation reports paths and does not claim a live confirmation", () => {
  const iso = createCliIsolation({ env: { PATH: "x" }, tempPrefix: "jobquay-test-" });
  try {
    const r = describeCliIsolation(iso);
    assert.equal(r.cliHome, iso.cliHome);
    assert.equal(r.homeEnv.HOME, iso.cliHome);
    assert.equal(r.homeEnv.USERPROFILE, iso.cliHome);
    assert.equal(r.liveConfirmed, false);
    assert.match(r.note, /live/i);
    assert.ok(Array.isArray(r.carriedEnvVars));
    assert.ok(r.redirectedEnv.HOME === iso.cliHome);
  } finally {
    cleanup(iso.root);
  }
});

test("the allowlist is a small, explicit, non-credential set", () => {
  for (const name of KNOWN_CREDENTIAL_ENV_VARS) {
    assert.ok(!MINIMAL_ENV_ALLOWLIST.includes(name), `${name} must never be allowlisted`);
  }
  for (const name of MINIMAL_ENV_ALLOWLIST) {
    assert.ok(!/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i.test(name), `${name} looks like a credential`);
  }
});

test("--credential-env parses both spellings, dedupes and ignores values", () => {
  assert.deepEqual(parseForwardCredentialEnv(["--credential-env", "A", "--credential-env=B", "--credential-env", "A"]), ["A", "B"]);
  assert.deepEqual(parseForwardCredentialEnv(["--other", "x"]), []);
  assert.deepEqual(parseForwardCredentialEnv(["--credential-env"]), []);
});
