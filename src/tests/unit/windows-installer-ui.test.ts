import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const INSTALLER_SCRIPT = path.join(REPO_ROOT, "installers", "windows", "CrewDispatch.nsi");

test("Windows NSIS Modern UI declares English after all page macros", () => {
  const script = fs.readFileSync(INSTALLER_SCRIPT, "utf8");
  const language = '!insertmacro MUI_LANGUAGE "English"';
  const languageIndex = script.indexOf(language);

  assert.notEqual(languageIndex, -1, "MUI_LANGUAGE is required or the welcome page can render blank");
  assert.equal(script.indexOf(language, languageIndex + language.length), -1, "declare the installer language exactly once");

  for (const page of [
    "!insertmacro MUI_PAGE_WELCOME",
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_WELCOME",
    "UninstPage custom un.RemoveDataPage un.RemoveDataPageLeave",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    "!insertmacro MUI_UNPAGE_FINISH"
  ]) {
    const pageIndex = script.indexOf(page);
    assert.notEqual(pageIndex, -1, `missing NSIS page declaration: ${page}`);
    assert.ok(pageIndex < languageIndex, `NSIS page declaration must precede MUI_LANGUAGE: ${page}`);
  }
});


test("Windows installer publishes complete Installed Apps version metadata", () => {
  const script = fs.readFileSync(INSTALLER_SCRIPT, "utf8");
  for (const required of [
    '!define UNINSTALL_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CrewDispatch"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "CrewDispatch"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString"',
    'WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString"',
    'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1',
    'WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1'
  ]) {
    assert.ok(script.includes(required), `missing Installed Apps metadata contract: ${required}`);
  }
});