// config-schema.test.ts — CrewDispatch's versioned, atomic config: defaults, stable
// rejection codes, no silent repair, atomic writes, and patch/merge semantics.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_VERSION,
  ConfigError,
  MAX_TIME_SLOTS,
  configPatchFromSnake,
  configPath,
  configView,
  defaultConfig,
  loadConfigResult,
  saveConfig,
  updateConfig,
  validateConfig
} from "../../config/schema";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-config-"));
}

/** A platform-absolute fake CLI path (cliPath is validated as absolute per platform). */
const ABS_CLI = process.platform === "win32" ? "C:\\tools\\cmdc.cmd" : "/opt/tools/cmdc";

/** The stable code `validateConfig` returns for an invalid value (it never throws). */
function validationCode(raw: unknown): string {
  const v = validateConfig(raw);
  return v.ok ? "ok" : v.error.code;
}

test("the defaults match the M0 settings requirement (no provider/edition selector)", () => {
  const c = defaultConfig();
  assert.equal(c.configVersion, CONFIG_VERSION);
  assert.equal(c.cliPath, null);
  assert.equal(c.defaultModel, null);
  assert.equal(c.rateLimitFallbackModel, null);
  assert.equal(c.permissionMode, "yolo");
  assert.equal(c.defaultEffort, null);
  assert.equal(c.rateLimitFallbackEffort, null);
  assert.deepEqual(c.timeSlots, []);
  assert.equal(c.inFlightSwitch, false);
  assert.equal(Object.prototype.hasOwnProperty.call(c, "provider"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(c, "edition"), false);
});

test("a saved config reloads field-for-field and writes atomically", () => {
  const root = tmpRoot();
  try {
    const saved = saveConfig(root, {
      ...defaultConfig(),
      cliPath: ABS_CLI,
      defaultModel: "deepseek/deepseek-v4-flash",
      rateLimitFallbackModel: "inclusionai/ling-3.0-flash-sante:free",
      permissionMode: "accept-edits",
      defaultEffort: "high",
      rateLimitFallbackEffort: "low",
      timeSlots: [
        { start: "23:00", end: "08:00", model: "a/b", enabled: true },
        { start: "08:00", end: "12:00", model: "c/d", enabled: false }
      ],
      inFlightSwitch: true
    });
    const loaded = loadConfigResult(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.present, true);
    assert.deepEqual(loaded.config, saved);
    assert.deepEqual(loaded.config.timeSlots[0], { start: "23:00", end: "08:00", model: "a/b", enabled: true });
    // Atomic: no temp residue left behind.
    const residue = fs.readdirSync(root).filter((n) => n.includes(".tmp"));
    assert.deepEqual(residue, []);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath(root), "utf8")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing config is a normal 'not configured yet' result (defaults apply)", () => {
  const root = tmpRoot();
  try {
    const loaded = loadConfigResult(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.present, false);
    assert.deepEqual(loaded.config, defaultConfig());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid fields are rejected with stable codes (never silently repaired)", () => {
  // Unknown field (including the forbidden provider/edition selector).
  assert.equal(validationCode({ provider: "command-code" }), "config_unknown_field");
  assert.equal(validationCode({ nope: 1 }), "config_unknown_field");

  // Too many slots.
  const slot = { start: "00:00", end: "01:00", model: "a/b", enabled: true };
  assert.equal(validationCode({ timeSlots: [slot, slot, slot, slot] }), "config_too_many_slots");

  // Bad model id.
  assert.equal(validationCode({ defaultModel: "bad model!" }), "config_invalid_model");
  // Bad permission mode.
  assert.equal(validationCode({ permissionMode: "root" }), "config_invalid_permission_mode");
  // Bad effort.
  assert.equal(validationCode({ defaultEffort: "ultra" }), "config_invalid_effort");
  assert.equal(validationCode({ rateLimitFallbackEffort: "ultra" }), "config_invalid_effort");
  // Bad slot time.
  assert.equal(validationCode({ timeSlots: [{ start: "24:00", end: "01:00", model: "a/b" }] }), "config_invalid_slot");
  assert.equal(validationCode({ timeSlots: [{ start: "9:0", end: "10:00", model: "a/b" }] }), "config_invalid_slot");
  // Zero-length window.
  assert.equal(validationCode({ timeSlots: [{ start: "09:00", end: "09:00", model: "a/b" }] }), "config_invalid_slot");
  // Wrong enabled type.
  assert.equal(validationCode({ timeSlots: [{ start: "09:00", end: "10:00", model: "a/b", enabled: "yes" }] }), "config_invalid_type");
  // Wrong top-level types.
  assert.equal(validationCode({ cliPath: 5 }), "config_invalid_type");
  assert.equal(validationCode({ inFlightSwitch: "on" }), "config_invalid_type");
  // cliPath is an ABSOLUTE path contract: a relative value is rejected, an
  // absolute one (per the current platform) is accepted.
  assert.equal(validationCode({ cliPath: "relative/cmdc" }), "config_invalid_cli_path");
  assert.equal(validationCode({ cliPath: ABS_CLI }), "ok");

  // A newer config version is refused honestly.
  assert.equal(validationCode({ configVersion: CONFIG_VERSION + 1 }), "config_version_too_new");
  // A valid config (with a cross-midnight window) is accepted and normalised.
  const ok = validateConfig({ timeSlots: [{ start: "9:05", end: "23:00", model: "a/b", enabled: true }] });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.timeSlots[0]?.start, "09:05");
});

test("the installed native standard permission mode saves, persists and reads back (never rejected)", () => {
  const root = tmpRoot();
  try {
    // The pure validator accepts the native mode and normalises case.
    const v = validateConfig({ permissionMode: "standard" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.value.permissionMode, "standard");
    assert.equal(validationCode({ permissionMode: "STANDARD" }), "ok");

    // It persists through the real atomic update path and reads back unchanged.
    const saved = updateConfig(root, { permissionMode: "standard" });
    assert.equal(saved.config.permissionMode, "standard");
    const loaded = loadConfigResult(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.permissionMode, "standard");
    assert.equal(JSON.parse(fs.readFileSync(configPath(root), "utf8")).permissionMode, "standard");
    assert.equal(configView(loaded.config).permission_mode, "standard");

    // Validation stays a whitelist: an arbitrary invalid mode is still rejected.
    assert.equal(validationCode({ permissionMode: "root" }), "config_invalid_permission_mode");
    assert.equal(validationCode({ permissionMode: "standard;" }), "config_invalid_permission_mode");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a saved default permission mode is normalized to the canonical standard (documented synonym)", () => {
  const root = tmpRoot();
  try {
    // The pure validator resolves the synonym (trim/case aware) to standard.
    const v = validateConfig({ permissionMode: "default" });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.value.permissionMode, "standard");
    const spaced = validateConfig({ permissionMode: "  Default " });
    assert.equal(spaced.ok, true);
    if (spaced.ok) assert.equal(spaced.value.permissionMode, "standard");

    // A NEW/updated saved value is persisted in the canonical spelling.
    const saved = updateConfig(root, { permissionMode: "default" });
    assert.equal(saved.config.permissionMode, "standard");
    assert.equal(JSON.parse(fs.readFileSync(configPath(root), "utf8")).permissionMode, "standard");
    assert.equal(configView(loadConfigResult(root).config).permission_mode, "standard");

    // An EXISTING file that already contains the synonym is normalized on read
    // (canonical view) but NEVER rewritten by a read — no migration.
    const legacyRoot = tmpRoot();
    try {
      fs.writeFileSync(configPath(legacyRoot), JSON.stringify({ permissionMode: "default" }), "utf8");
      const before = fs.readFileSync(configPath(legacyRoot), "utf8");
      const loaded = loadConfigResult(legacyRoot);
      assert.equal(loaded.ok, true);
      assert.equal(loaded.config.permissionMode, "standard");
      assert.equal(configView(loaded.config).permission_mode, "standard");
      assert.equal(fs.readFileSync(configPath(legacyRoot), "utf8"), before, "a read must not rewrite the stored file");
    } finally {
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    }

    // Every other canonical mode keeps its own spelling; the reference-only
    // dont-ask token is still accepted; unsupported modes still fail closed.
    for (const mode of ["standard", "plan", "accept-edits", "yolo", "dont-ask"]) {
      const r = validateConfig({ permissionMode: mode });
      assert.equal(r.ok, true, mode);
      if (r.ok) assert.equal(r.value.permissionMode, mode);
    }
    assert.equal(validationCode({ permissionMode: "full-access" }), "config_invalid_permission_mode");
    assert.equal(validationCode({ permissionMode: "auto" }), "config_invalid_permission_mode");

    // The rejection message documents the one accepted synonym.
    const bad = validateConfig({ permissionMode: "root" });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.error.message.includes("standard, plan, accept-edits, yolo, dont-ask"));
      assert.ok(bad.error.message.includes('"default" is accepted as a synonym for "standard"'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt config file is reported and NEVER rewritten by a read", () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(configPath(root), "{not json", "utf8");
    const before = fs.readFileSync(configPath(root), "utf8");
    const loaded = loadConfigResult(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error?.code, "config_corrupt");
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a read must not rewrite the file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid stored config is reported with its field and not repaired", () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(configPath(root), JSON.stringify({ permissionMode: "root" }), "utf8");
    const before = fs.readFileSync(configPath(root), "utf8");
    const loaded = loadConfigResult(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.error?.code, "config_invalid_permission_mode");
    assert.equal(loaded.error?.field, "permissionMode");
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update merges: absent keys are kept, time_slots replaces the list, blank effort clears it", () => {
  const root = tmpRoot();
  try {
    updateConfig(root, {
      defaultModel: "a/b",
      defaultEffort: "high",
      timeSlots: [
        { start: "00:00", end: "12:00", model: "m/one", enabled: true },
        { start: "12:00", end: "00:00", model: "m/two", enabled: true }
      ],
      inFlightSwitch: true
    });
    // A partial update keeps everything else and replaces only timeSlots.
    const next = updateConfig(root, {
      timeSlots: [{ start: "22:00", end: "06:00", model: "m/night", enabled: true }],
      defaultEffort: ""
    });
    assert.equal(next.config.defaultModel, "a/b", "an absent default model is kept");
    assert.equal(next.config.defaultEffort, null, "a blank effort clears the default (no --effort)");
    assert.equal(next.config.inFlightSwitch, true, "an absent toggle is kept");
    assert.equal(next.config.timeSlots.length, 1);
    assert.equal(next.config.timeSlots[0]?.model, "m/night");

    const reloaded = loadConfigResult(root);
    assert.deepEqual(reloaded.config, next.config);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("changing a selection's model resets ONLY that selection's effort (unless the same patch supplies one)", () => {
  const root = tmpRoot();
  try {
    updateConfig(root, {
      defaultModel: "m/a",
      defaultEffort: "high",
      rateLimitFallbackModel: "m/b",
      rateLimitFallbackEffort: "low"
    });

    // Changing the DEFAULT model alone clears only the default effort.
    const changedDefault = updateConfig(root, { defaultModel: "m/c" });
    assert.equal(changedDefault.config.defaultEffort, null, "the default-model change clears its own effort");
    assert.equal(changedDefault.config.rateLimitFallbackEffort, "low", "the fallback effort is independent and untouched");

    // Restore the default effort, then change the FALLBACK model alone.
    updateConfig(root, { defaultEffort: "high" });
    const changedFallback = updateConfig(root, { rateLimitFallbackModel: "m/d" });
    assert.equal(changedFallback.config.rateLimitFallbackEffort, null, "the fallback-model change clears its own effort");
    assert.equal(changedFallback.config.defaultEffort, "high", "the default effort is independent and untouched");

    // A replacement supplied in the SAME patch as the model change is kept.
    const replaced = updateConfig(root, { defaultModel: "m/e", defaultEffort: "max" });
    assert.equal(replaced.config.defaultEffort, "max", "an explicit replacement in the same patch is kept");

    // Re-submitting the SAME model does not reset the effort.
    const sameModel = updateConfig(root, { defaultModel: "m/e" });
    assert.equal(sameModel.config.defaultEffort, "max", "an unchanged model keeps its effort");

    // An explicit null in the same patch clears the effort.
    const cleared = updateConfig(root, { defaultModel: "m/e", defaultEffort: null });
    assert.equal(cleared.config.defaultEffort, null, "an explicit null clears the effort even without a model change");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid update is rejected and the stored file is left byte-identical", () => {
  const root = tmpRoot();
  try {
    updateConfig(root, { defaultModel: "a/b" });
    const before = fs.readFileSync(configPath(root), "utf8");
    assert.throws(
      () => updateConfig(root, { timeSlots: [{ start: "25:00", end: "09:00", model: "a/b", enabled: true }] }),
      (e: unknown) => e instanceof ConfigError && e.code === "config_invalid_slot"
    );
    assert.equal(fs.readFileSync(configPath(root), "utf8"), before, "a rejected update must not partially write");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an update over a PRESENT-but-invalid file is refused and the file is byte-identical", () => {
  const root = tmpRoot();
  try {
    // Corrupt JSON.
    fs.writeFileSync(configPath(root), "{not json", "utf8");
    const corruptBefore = fs.readFileSync(configPath(root), "utf8");
    assert.throws(
      () => updateConfig(root, { defaultModel: "a/b" }),
      (e: unknown) => e instanceof ConfigError && e.code === "config_corrupt"
    );
    assert.equal(fs.readFileSync(configPath(root), "utf8"), corruptBefore, "a corrupt file must never be overwritten");

    // Structurally valid JSON with an invalid field.
    fs.writeFileSync(configPath(root), JSON.stringify({ permissionMode: "root" }), "utf8");
    const invalidBefore = fs.readFileSync(configPath(root), "utf8");
    assert.throws(
      () => updateConfig(root, { defaultModel: "a/b" }),
      (e: unknown) => e instanceof ConfigError && e.code === "config_invalid_permission_mode"
    );
    assert.equal(fs.readFileSync(configPath(root), "utf8"), invalidBefore, "an invalid file must never be silently repaired");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an update with NO existing file builds a new config from the defaults", () => {
  const root = tmpRoot();
  try {
    const result = updateConfig(root, { defaultModel: "a/b" });
    assert.equal(result.config.defaultModel, "a/b");
    assert.equal(result.config.permissionMode, "yolo", "an absent field keeps the default");
    const reloaded = loadConfigResult(root);
    assert.equal(reloaded.ok, true);
    assert.equal(reloaded.present, true);
    assert.equal(reloaded.config.defaultModel, "a/b");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configPatchFromSnake rejects unknown top-level keys instead of dropping them", () => {
  assert.throws(
    () => configPatchFromSnake({ provider: "command-code" }),
    (e: unknown) => e instanceof ConfigError && e.code === "config_unknown_field"
  );
  assert.throws(
    () => configPatchFromSnake({ default_modle: "a/b" }),
    (e: unknown) => e instanceof ConfigError && e.code === "config_unknown_field"
  );
  // Known keys still map, and an absent key is not invented.
  assert.deepEqual(configPatchFromSnake({ default_model: "a/b", permission_mode: "plan" }), {
    defaultModel: "a/b",
    permissionMode: "plan"
  });
});

test("configView exposes exactly the whitelisted snake_case fields", () => {
  const view = configView(defaultConfig());
  assert.deepEqual(Object.keys(view).sort(), [
    "cli_path",
    "default_effort",
    "default_model",
    "in_flight_switch",
    "permission_mode",
    "rate_limit_fallback_effort",
    "rate_limit_fallback_model",
    "time_slots"
  ]);
  assert.equal(MAX_TIME_SLOTS, 3);
});
