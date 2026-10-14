import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDataRoot } from "../jobs/store";
import { INSTALL_MARKER } from "./marker";
import { REQUIRED_NODE_MAJOR, resolveUserNodeRuntime } from "./node-runtime";
import {
  registerDashboardAutostart,
  removeDashboardAutostart,
  writeAutostartPayloadInto,
  type RegisterAutostartResult,
  type RemoveAutostartResult
} from "./autostart";

export { INSTALL_MARKER };
/** The reviewed third-party notice bundle; shipped verbatim and tracked in the marker. */
export const NOTICE_FILE = "THIRD_PARTY_NOTICES";
/** CrewDispatch's own product license, shipped as an installer-owned file. */
export const PRODUCT_LICENSE_FILE = "LICENSE";
export const PRODUCT_LICENSE_REQUIRED_MARKERS = [
  "Apache License",
  "Version 2.0, January 2004",
  "END OF TERMS AND CONDITIONS"
] as const;
/** Copyright lines every copy of NOTICE_FILE must carry (see the canonical provenance record). */
export const NOTICE_REQUIRED_MARKERS = [
  "Copyright (c) 2026 WorkBuddy Crew contributors",
  "Copyright (c) 2026 ZSeven-W"
] as const;
const INSTALL_FORMAT_VERSION = 1;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const OUTPUT_PATH_CAP = 100;
const RUNTIME_LICENSES = [
  "node_modules/@modelcontextprotocol/server/LICENSE",
  "node_modules/@modelcontextprotocol/core/LICENSE",
  "node_modules/zod/LICENSE"
] as const;

export interface ManagedFile {
  path: string;
  sha256: string;
  /** POSIX mode owned by this installer entry. Older v1 markers may omit it. */
  mode?: number;
}

export interface InstallMarkerData {
  product: "jobquay";
  formatVersion: number;
  installId: string;
  packageVersion: string;
  createdAt: string;
  updatedAt: string;
  managedFiles: ManagedFile[];
}

interface ScannedFile extends ManagedFile {
  absolutePath: string;
}

interface InstallContext {
  target: string;
  sourceRoot: string;
  packageVersion: string;
}

export interface OperationResult {
  ok: true;
  command: "install" | "upgrade" | "uninstall";
  target: string;
  [key: string]: unknown;
}

export class InstallError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "InstallError";
    this.code = code;
    this.details = details;
  }
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new InstallError(code, message, details);
}

function canonical(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathContains(parent: string, child: string): boolean {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function pathsOverlap(a: string, b: string): boolean {
  return pathContains(a, b) || pathContains(b, a);
}

function validateTarget(targetArg: string, sourceRoot: string | null): string {
  if (!path.isAbsolute(targetArg)) fail("target_must_be_absolute", "--target must be an absolute path.", { target: targetArg });
  const target = path.resolve(targetArg);
  const root = path.parse(target).root;
  if (canonical(target) === canonical(root)) {
    fail("dangerous_root", "Refusing to use the filesystem root as the install target.", { target });
  }
  if (sourceRoot && pathsOverlap(target, sourceRoot)) {
    fail("source_checkout_overlap", "The install target must not overlap the current source checkout.", { target, sourceRoot });
  }

  const home = os.homedir();
  const protectedPaths = [
    path.join(home, ".codex"),
    path.join(home, ".workbuddy"),
    path.join(home, ".commandcode"),
    path.join(home, ".claude"),
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude") : "",
    process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude-3p") : "",
    process.platform === "darwin" ? path.join(home, "Library", "LaunchAgents") : "",
    process.platform === "darwin" ? "/Applications" : "",
    process.platform === "darwin" ? "/Library" : "",
    process.platform === "darwin" ? "/System" : "",
    process.platform === "darwin" ? "/usr" : "",
    process.platform === "darwin" ? "/bin" : "",
    process.platform === "darwin" ? "/sbin" : "",
    process.env.APPDATA ? path.join(process.env.APPDATA, "Codex") : "",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Codex") : "",
    process.env.SystemRoot || process.env.WINDIR || "",
    process.env.ProgramFiles || "",
    process.env["ProgramFiles(x86)"] || ""
  ].filter(Boolean);
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(target, protectedPath)) {
      fail("protected_target", "The install target overlaps user configuration, CLI data, or a system install directory.", { target });
    }
  }

  checkPathChain(target, true);
  return target;
}

/** Check every existing path component without following a symlink/junction. */
function checkPathChain(target: string, allowMissing: boolean): void {
  const parsed = path.parse(target);
  let current = parsed.root;
  const parts = target.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") fail("target_not_found", "The target path does not exist.", { target, missing: current });
      throw e;
    }
    if (stat.isSymbolicLink()) fail("symlink_target", "Refusing a path that goes through a symlink or junction.", { path: current });
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail("invalid_target_parent", "The parent of the target path is not a directory.", { path: current });
    }
  }
}

function assertRegularFile(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("unsafe_file", "Encountered a non-regular file or a link; stopping the operation.", { path: file });
  return stat;
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function relativeKey(rel: string): string {
  return rel.split(path.sep).join("/");
}

function fromRelative(root: string, rel: string): string {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    fail("invalid_marker", "The install marker contains an invalid file path.", { path: rel });
  }
  const pieces = rel.split(/[\\/]+/);
  if (pieces.some((part) => !part || part === "." || part === "..")) {
    fail("invalid_marker", "The install marker contains an out-of-bounds file path.", { path: rel });
  }
  const absolute = path.resolve(root, ...pieces);
  if (!pathContains(root, absolute) || canonical(root) === canonical(absolute)) {
    fail("invalid_marker", "An install marker file path escapes the installation directory.", { path: rel });
  }
  return absolute;
}

function scanFiles(root: string, skipMarker = false): ScannedFile[] {
  const files: ScannedFile[] = [];
  const visit = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (skipMarker && dir === root && entry.name === INSTALL_MARKER) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail("symlink_in_target", "The installation directory contains a symlink or junction; stopping the operation.", { path: full });
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile()) {
        const rel = relativeKey(path.relative(root, full));
        const scanned: ScannedFile = { path: rel, sha256: sha256(full), absolutePath: full };
        if (process.platform !== "win32") scanned.mode = stat.mode & 0o777;
        files.push(scanned);
      } else {
        fail("unsupported_target_entry", "The installation directory contains an unsupported file type; stopping the operation.", { path: full });
      }
    }
  };
  visit(root);
  return files;
}

function scanDirectories(root: string): string[] {
  const dirs: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail("symlink_in_target", "The installation directory contains a symlink or junction; stopping the operation.", { path: full });
      if (stat.isDirectory()) {
        dirs.push(full);
        visit(full);
      }
    }
  };
  visit(root);
  return dirs.sort((a, b) => b.length - a.length);
}

function readMarker(target: string): { marker: InstallMarkerData; raw: string } {
  const markerPath = path.join(target, INSTALL_MARKER);
  let raw: string;
  try {
    assertRegularFile(markerPath);
    raw = fs.readFileSync(markerPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") fail("not_managed", "The target directory has no CrewDispatch install marker.", { target });
    throw e;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("invalid_marker", "The CrewDispatch install marker is not valid JSON.", { target });
  }
  const marker = value as Partial<InstallMarkerData>;
  if (
    marker.product !== "jobquay" ||
    marker.formatVersion !== INSTALL_FORMAT_VERSION ||
    typeof marker.installId !== "string" ||
    typeof marker.packageVersion !== "string" ||
    typeof marker.createdAt !== "string" ||
    typeof marker.updatedAt !== "string" ||
    !Array.isArray(marker.managedFiles)
  ) {
    fail("invalid_marker", "The target directory's CrewDispatch install marker format is unsupported.", { target });
  }
  const paths = new Set<string>();
  for (const item of marker.managedFiles) {
    if (
      !item ||
      typeof item.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      (item.mode !== undefined && (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777)) ||
      paths.has(item.path)
    ) {
      fail("invalid_marker", "The CrewDispatch install marker's file manifest is invalid.", { target });
    }
    paths.add(item.path);
    fromRelative(target, item.path);
  }
  return { marker: marker as InstallMarkerData, raw };
}

function buildContext(targetArg: string): InstallContext {
  const sourceRoot = path.resolve(__dirname, "..", "..");
  const target = validateTarget(targetArg, sourceRoot);
  let pkg: { version?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  } catch {
    fail("source_package_missing", "There is no valid package.json next to the current installer.", { sourceRoot });
  }
  if (typeof pkg.version !== "string") fail("source_package_invalid", "package.json is missing a valid version.", { sourceRoot });
  return { target, sourceRoot, packageVersion: pkg.version };
}

function copyRegularFile(source: string, destination: string): void {
  assertRegularFile(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(destination, fs.statSync(source).mode & 0o777);
  } catch {
    // Windows ACLs do not map to POSIX mode bits; content verification is authoritative.
  }
}

function assertNoticeFile(file: string): void {
  assertRegularFile(file);
  const text = fs.readFileSync(file, "utf8");
  for (const marker of NOTICE_REQUIRED_MARKERS) {
    if (!text.includes(marker)) {
      fail("notice_content_invalid", "THIRD_PARTY_NOTICES is missing a required third-party copyright line; the install is aborted.", { path: file, missing: marker });
    }
  }
}

function assertProductLicenseFile(file: string): void {
  assertRegularFile(file);
  const text = fs.readFileSync(file, "utf8");
  for (const marker of PRODUCT_LICENSE_REQUIRED_MARKERS) {
    if (!text.includes(marker)) {
      fail("product_license_invalid", "LICENSE is not the expected Apache-2.0 product license; the install is aborted.", { path: file, missing: marker });
    }
  }
}

function copyTree(source: string, destination: string, skipTests = false): void {
  const rootStat = fs.lstatSync(source);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("invalid_source_tree", "The install source must be a regular directory.", { path: source });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skipTests && entry.name === "tests") continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) fail("invalid_source_tree", "The build output contains a link; refusing to copy.", { path: from });
    if (stat.isDirectory()) copyTree(from, to, false);
    else if (stat.isFile()) copyRegularFile(from, to);
    else fail("invalid_source_tree", "The build output contains an unsupported file type.", { path: from });
  }
}

function copyPayload(sourceRoot: string, target: string, finalTarget: string, nodePath: string): void {
  const dist = path.join(sourceRoot, "dist");
  const pluginRoot = path.join(sourceRoot, "plugins", "crewdispatch");
  // The Claude caller integration installs from the packaged runtime itself
  // (`dist/claude/client-install.js` resolves its source root as the runtime
  // root), so the composer command asset must travel with the payload — not
  // only the dispatch Skill and the built dist tree.
  const claudeCommand = path.join(sourceRoot, "integrations", "claude", "commands", "crewdispatch.md");
  const codexPrompt = path.join(sourceRoot, "integrations", "codex", "prompts", "crewdispatch.md");
  const codexInstallCommand = path.join(sourceRoot, "scripts", "install-codex-command.cjs");
  const codexUninstallCommand = path.join(sourceRoot, "scripts", "uninstall-codex-command.cjs");
  const required = [
    path.join(dist, "mcp", "server.js"),
    path.join(dist, "hub", "server.js"),
    path.join(dist, "ui", "client.js"),
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, "skills", "crewdispatch", "SKILL.md"),
    path.join(pluginRoot, "mcp.template.json"),
    claudeCommand,
    codexPrompt,
    codexInstallCommand,
    codexUninstallCommand,
    path.join(sourceRoot, "package.json"),
    path.join(sourceRoot, "package-lock.json"),
    path.join(sourceRoot, PRODUCT_LICENSE_FILE),
    path.join(sourceRoot, NOTICE_FILE)
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) fail("build_artifacts_missing", "Run npm.cmd run build first and confirm the plugin resources and package-lock.json exist.", { missing: file });
    assertRegularFile(file);
  }
  assertNoticeFile(path.join(sourceRoot, NOTICE_FILE));
  assertProductLicenseFile(path.join(sourceRoot, PRODUCT_LICENSE_FILE));

  copyTree(dist, path.join(target, "dist"), true);
  copyRegularFile(path.join(sourceRoot, "package.json"), path.join(target, "package.json"));
  copyRegularFile(path.join(sourceRoot, "package-lock.json"), path.join(target, "package-lock.json"));
  copyRegularFile(path.join(sourceRoot, PRODUCT_LICENSE_FILE), path.join(target, PRODUCT_LICENSE_FILE));
  copyRegularFile(path.join(sourceRoot, NOTICE_FILE), path.join(target, NOTICE_FILE));
  copyRegularFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), path.join(target, "plugins", "crewdispatch", ".codex-plugin", "plugin.json"));
  copyRegularFile(path.join(pluginRoot, "skills", "crewdispatch", "SKILL.md"), path.join(target, "plugins", "crewdispatch", "skills", "crewdispatch", "SKILL.md"));
  copyRegularFile(path.join(pluginRoot, "mcp.template.json"), path.join(target, "plugins", "crewdispatch", "mcp.template.json"));
  copyRegularFile(claudeCommand, path.join(target, "integrations", "claude", "commands", "crewdispatch.md"));
  copyRegularFile(codexPrompt, path.join(target, "integrations", "codex", "prompts", "crewdispatch.md"));
  copyRegularFile(codexInstallCommand, path.join(target, "scripts", "install-codex-command.cjs"));
  copyRegularFile(codexUninstallCommand, path.join(target, "scripts", "uninstall-codex-command.cjs"));
  renderMcpConfig(target, finalTarget, nodePath);
}

function renderMcpConfig(target: string, finalTarget: string, nodePath: string): void {
  const templatePath = path.join(target, "plugins", "crewdispatch", "mcp.template.json");
  const raw = fs.readFileSync(templatePath, "utf8");
  const serverToken = '"__CREWDISPATCH_SERVER_ENTRY__"';
  const nodeToken = '"__CREWDISPATCH_NODE_ENTRY__"';
  if (!raw.includes(serverToken) || !raw.includes(nodeToken)) {
    fail("invalid_plugin_template", "The MCP template is missing an installer placeholder.", { templatePath });
  }
  const entry = path.join(finalTarget, "dist", "mcp", "server.js");
  const rendered = raw
    .split(serverToken).join(JSON.stringify(path.resolve(entry)))
    .split(nodeToken).join(JSON.stringify(path.resolve(nodePath)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    fail("invalid_plugin_template", "The generated MCP configuration is not valid JSON.", { templatePath });
  }
  const outPath = path.join(target, "plugins", "crewdispatch", ".mcp.json");
  fs.writeFileSync(outPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
export const POSIX_COMMAND_WRAPPERS = [
  { name: "crewdispatch", entry: "crewdispatch-cli.js" },
  { name: "jobquay", entry: "jobquay-cli.js" }
] as const;

function shellSingleQuote(value: string): string {
  return "'" + value.replace(/\'/g, "'\"'\"'") + "'";
}

/**
 * Render one checkout-independent POSIX command wrapper. The wrapper pins both
 * the exact Node executable and the FINAL installed CLI entry, so it works
 * from arbitrary cwd and under a sparse GUI/LaunchAgent PATH.
 */
export function renderPosixCommandWrapper(installRoot: string, nodePath: string, entryName: string): string {
  const cliEntry = path.join(installRoot, "dist", "cli", entryName);
  return [
    "#!/bin/sh",
    "# Managed by CrewDispatch; do not edit in place.",
    "exec " + shellSingleQuote(path.resolve(nodePath)) + " " + shellSingleQuote(path.resolve(cliEntry)) + " \"$@\"",
    ""
  ].join("\n");
}

function cmdQuotedLiteral(value: string): string {
  // `%NAME%` expansion is active even inside quotes. Doubling percent signs is
  // the batch-file literal form; double quotes cannot appear in Windows paths.
  return path.win32.resolve(value).replace(/%/g, "%%");
}

/** Render one checkout-independent Windows .cmd wrapper. */
export function renderWindowsCommandWrapper(installRoot: string, nodePath: string, entryName: string): string {
  const cliEntry = path.win32.join(path.win32.resolve(installRoot), "dist", "cli", entryName);
  return [
    "@echo off",
    "REM Managed by CrewDispatch; do not edit in place.",
    `\"${cmdQuotedLiteral(nodePath)}\" \"${cmdQuotedLiteral(cliEntry)}\" %*`,
    ""
  ].join("\r\n");
}

function writeCommandWrappers(payloadRoot: string, installRoot: string, nodePath = process.execPath): void {
  const binDir = path.join(payloadRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const wrapper of POSIX_COMMAND_WRAPPERS) {
    if (process.platform === "win32") {
      const file = path.join(binDir, `${wrapper.name}.cmd`);
      fs.writeFileSync(file, renderWindowsCommandWrapper(installRoot, nodePath, wrapper.entry), { encoding: "utf8", flag: "wx" });
    } else {
      const file = path.join(binDir, wrapper.name);
      fs.writeFileSync(file, renderPosixCommandWrapper(installRoot, nodePath, wrapper.entry), { encoding: "utf8", flag: "wx", mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
  }
}

function writeEmptyFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
}

function npmEnvironment(scratch: string): NodeJS.ProcessEnv {
  const allow = ["PATH", "PATHEXT", "COMSPEC", "SystemRoot", "WINDIR", "SYSTEMDRIVE"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allow) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  env.HOME = scratch;
  env.USERPROFILE = scratch;
  env.TEMP = scratch;
  env.TMP = scratch;
  return env;
}

function installRuntimeDependencies(target: string): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "jobquay-npm-install-"));
  const userConfig = path.join(scratch, "empty.npmrc");
  const cache = path.join(scratch, "cache");
  writeEmptyFile(userConfig);
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
      npm,
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig", userConfig, "--cache", cache],
      {
        cwd: target,
        env: npmEnvironment(scratch),
        encoding: "utf8",
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32"
      }
    );
    if (result.error || result.status !== 0) {
      fail("dependency_install_failed", "npm ci --omit=dev failed in the temporary install area; the original installation was not replaced.", {
        exitCode: result.status ?? null,
        signal: result.signal ?? null,
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const rel of RUNTIME_LICENSES) {
    const file = path.join(target, rel);
    if (!fs.existsSync(file)) fail("runtime_license_missing", "A runtime dependency did not retain its actual LICENSE file; the install is aborted.", { path: rel });
    assertRegularFile(file);
  }
  assertProductLicenseFile(path.join(target, PRODUCT_LICENSE_FILE));
}

function makeMarker(files: ScannedFile[], context: InstallContext, prior?: InstallMarkerData): InstallMarkerData {
  const now = new Date().toISOString();
  return {
    product: "jobquay",
    formatVersion: INSTALL_FORMAT_VERSION,
    installId: prior?.installId ?? crypto.randomUUID(),
    packageVersion: context.packageVersion,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
    managedFiles: files
      .map(({ path: filePath, sha256: hash, mode }) => {
        const file: ManagedFile = { path: filePath, sha256: hash };
        if (mode !== undefined) file.mode = mode;
        return file;
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  };
}

function writeMarker(target: string, marker: InstallMarkerData): void {
  const markerPath = path.join(target, INSTALL_MARKER);
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function ensureDataRootOutsideInstall(target: string): string {
  const dataRoot = resolveDataRoot(undefined, process.env);
  if (pathsOverlap(target, dataRoot)) {
    fail("data_root_inside_install", "JOBQUAY_DATA_ROOT must be outside the installation directory.", { target, dataRoot });
  }
  return dataRoot;
}

function allocateStage(parent: string): string {
  return fs.mkdtempSync(path.join(parent, ".jobquay-stage-"));
}

function assertSameVolume(parent: string, stage: string): void {
  const parentStat = fs.statSync(parent);
  const stageStat = fs.statSync(stage);
  if (parentStat.dev !== stageStat.dev) {
    fail("stage_volume_mismatch", "The temporary install stage is not on the target parent filesystem; atomic rename is not guaranteed.", {
      parent,
      stage
    });
  }
}

function removeFreshStage(stage: string): void {
  // Stage names are created by this process; only remove after verifying no links.
  checkPathChain(stage, false);
  scanFiles(stage);
  fs.rmSync(stage, { recursive: true, force: false });
}

function summarizePaths(paths: string[]): { count: number; paths: string[]; truncated: boolean } {
  const sorted = [...paths].sort();
  return { count: sorted.length, paths: sorted.slice(0, OUTPUT_PATH_CAP), truncated: sorted.length > OUTPUT_PATH_CAP };
}

function managedBy(marker: InstallMarkerData): Map<string, ManagedFile> {
  return new Map(marker.managedFiles.map((file) => [file.path, file]));
}

function managedNotice(marker: InstallMarkerData): { path: string; sha256: string } | null {
  const entry = marker.managedFiles.find((file) => file.path === NOTICE_FILE);
  return entry ? { path: entry.path, sha256: entry.sha256 } : null;
}

function managedProductLicense(marker: InstallMarkerData): { path: string; sha256: string; spdx: "Apache-2.0" } | null {
  const entry = marker.managedFiles.find((file) => file.path === PRODUCT_LICENSE_FILE);
  return entry ? { path: entry.path, sha256: entry.sha256, spdx: "Apache-2.0" } : null;
}

function classifyFiles(files: ScannedFile[], marker: InstallMarkerData): {
  managed: ScannedFile[];
  unowned: ScannedFile[];
  modified: ScannedFile[];
} {
  const expected = managedBy(marker);
  const managed: ScannedFile[] = [];
  const unowned: ScannedFile[] = [];
  const modified: ScannedFile[] = [];
  for (const file of files) {
    const owned = expected.get(file.path);
    if (owned === undefined) unowned.push(file);
    else {
      const modeMatches = owned.mode === undefined || file.mode === owned.mode;
      if (owned.sha256 === file.sha256 && modeMatches) managed.push(file);
      else {
        modified.push(file);
        unowned.push(file);
      }
    }
  }
  return { managed, unowned, modified };
}

function ensureInstallDirectory(target: string, mode: "new" | "managed"): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (mode === "managed") fail("target_not_found", "The upgrade or uninstall target does not exist.", { target });
      return;
    }
    throw e;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("unsafe_target", "The install target must be a regular directory, not a link or a file.", { target });
  if (mode === "new") fail("target_exists", "install accepts only a target that does not yet exist; an existing directory must be managed by upgrade with an install marker.", { target });
}

function emptyDirectory(target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

function copyUnknownFiles(stage: string, unknown: ScannedFile[]): void {
  for (const file of unknown) {
    const destination = fromRelative(stage, file.path);
    if (fs.existsSync(destination)) {
      fail("upgrade_collision", "The upgrade would overwrite files the installer does not own; it stopped and the original installation was not replaced.", { path: file.path });
    }
    copyRegularFile(file.absolutePath, destination);
    const copiedMode = process.platform === "win32" ? undefined : (fs.statSync(destination).mode & 0o777);
    if (sha256(destination) !== file.sha256 || (file.mode !== undefined && copiedMode !== file.mode)) {
      fail("copy_verification_failed", "Verification failed while preserving a user file.", { path: file.path });
    }
  }
}

function copyEmptyDirectories(source: string, destination: string, files: ScannedFile[]): void {
  const occupied = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i += 1) occupied.add(parts.slice(0, i).join("/"));
  }
  const dirs = scanDirectories(source).map((dir) => relativeKey(path.relative(source, dir)));
  for (const dir of dirs) {
    if (occupied.has(dir)) continue;
    const to = fromRelative(destination, dir);
    if (fs.existsSync(to) && !fs.lstatSync(to).isDirectory()) {
      fail("upgrade_collision", "The upgrade would overwrite a directory or file the installer does not own; it stopped.", { path: dir });
    }
    fs.mkdirSync(to, { recursive: true });
  }
}

function pruneEmptyDirectories(root: string): void {
  for (const dir of scanDirectories(root)) {
    try {
      fs.rmdirSync(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
    }
  }
}

function cleanVerifiedTree(root: string, snapshot: ScannedFile[], markerRaw: string): string[] {
  const retained: string[] = [];
  const expected = new Map(snapshot.map((file) => [file.path, file]));
  const current = scanFiles(root, true);
  const currentByPath = new Map(current.map((file) => [file.path, file]));
  for (const [rel, owned] of expected) {
    const file = currentByPath.get(rel);
    if (!file) continue;
    if (file.sha256 !== owned.sha256 || (owned.mode !== undefined && file.mode !== owned.mode)) {
      retained.push(rel);
      continue;
    }
    fs.unlinkSync(file.absolutePath);
  }
  for (const file of current) {
    if (!expected.has(file.path)) retained.push(file.path);
  }

  const markerPath = path.join(root, INSTALL_MARKER);
  if (fs.existsSync(markerPath)) {
    try {
      assertRegularFile(markerPath);
      if (fs.readFileSync(markerPath, "utf8") === markerRaw) fs.unlinkSync(markerPath);
      else retained.push(INSTALL_MARKER);
    } catch {
      retained.push(INSTALL_MARKER);
    }
  }
  pruneEmptyDirectories(root);
  if (retained.length === 0) {
    try {
      fs.rmdirSync(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOTEMPTY" || (e as NodeJS.ErrnoException).code === "EEXIST") {
        retained.push("<directory-not-empty>");
      } else {
        throw e;
      }
    }
  }
  return retained;
}

export function install(targetArg: string): OperationResult {
  const runtime = resolveUserNodeRuntime();
  if (!runtime) fail("node_runtime_missing", `Node.js ${REQUIRED_NODE_MAJOR} or newer must be installed and available on PATH before installing CrewDispatch.`);
  if (runtime.major < REQUIRED_NODE_MAJOR) fail("node_runtime_unsupported", `Node.js ${REQUIRED_NODE_MAJOR} or newer is required; PATH currently resolves Node.js ${runtime.version}.`, { nodePath: runtime.path, nodeVersion: runtime.version, required: `>=${REQUIRED_NODE_MAJOR}` });
  const context = buildContext(targetArg);
  const dataRoot = ensureDataRootOutsideInstall(context.target);
  ensureInstallDirectory(context.target, "new");
  const parent = path.dirname(context.target);
  fs.mkdirSync(parent, { recursive: true });
  checkPathChain(context.target, true);
  const stage = allocateStage(parent);
  assertSameVolume(parent, stage);
  try {
    copyPayload(context.sourceRoot, stage, context.target, runtime.path);
    writeCommandWrappers(stage, context.target, runtime.path);
    // The Windows login autostart shim is part of the payload: it is written
    // into the stage before the managed-file manifest, so the marker owns it
    // and uninstall removes it together with the rest of the installation.
    writeAutostartPayloadInto(stage, context.target, { nodePath: runtime.path });
    installRuntimeDependencies(stage);
    const managedFiles = scanFiles(stage);
    const marker = makeMarker(managedFiles, context);
    writeMarker(stage, marker);
    try {
      fs.renameSync(stage, context.target);
    } catch (e) {
      fail("install_commit_failed", "The temporary install content is ready, but it could not be switched to the target directory.", { target: context.target, error: String((e as Error).message) });
    }
    // Registration happens after the commit and never fails the install: the
    // Dashboard autostart is a convenience, not a job-service dependency.
    const autostart = registerDashboardAutostart(context.target, { env: process.env, nodePath: runtime.path });
    return {
      ok: true,
      command: "install",
      target: context.target,
      installId: marker.installId,
      packageVersion: marker.packageVersion,
      managedFileCount: marker.managedFiles.length,
      runtimeLicenses: [...RUNTIME_LICENSES],
      productLicense: managedProductLicense(marker),
      thirdPartyNotices: managedNotice(marker),
      licenseStatus: `CrewDispatch ${marker.packageVersion} is licensed under Apache-2.0; package.json remains private only to prevent accidental npm publication.`,
      dataRoot,
      autostart
    };
  } catch (e) {
    if (fs.existsSync(stage)) {
      try {
        removeFreshStage(stage);
      } catch {
        // Do not recursively delete a stage whose contents no longer verify.
      }
    }
    throw e;
  }
}

export function upgrade(targetArg: string): OperationResult {
  const runtime = resolveUserNodeRuntime();
  if (!runtime) fail("node_runtime_missing", `Node.js ${REQUIRED_NODE_MAJOR} or newer must be installed and available on PATH before upgrading CrewDispatch.`);
  if (runtime.major < REQUIRED_NODE_MAJOR) fail("node_runtime_unsupported", `Node.js ${REQUIRED_NODE_MAJOR} or newer is required; PATH currently resolves Node.js ${runtime.version}.`, { nodePath: runtime.path, nodeVersion: runtime.version, required: `>=${REQUIRED_NODE_MAJOR}` });
  const context = buildContext(targetArg);
  const dataRoot = ensureDataRootOutsideInstall(context.target);
  ensureInstallDirectory(context.target, "managed");
  checkPathChain(context.target, false);
  const { marker: oldMarker, raw: oldMarkerRaw } = readMarker(context.target);
  const oldSnapshot = scanFiles(context.target, true);
  const ownership = classifyFiles(oldSnapshot, oldMarker);
  const modifiedProductLicense = ownership.modified.find((file) => file.path === PRODUCT_LICENSE_FILE);
  if (modifiedProductLicense) {
    fail("product_license_modified", "The managed LICENSE was modified; upgrade refuses to overwrite it and leaves the existing installation unchanged.", { path: PRODUCT_LICENSE_FILE });
  }
  const sourceRoot = canonical(context.sourceRoot);
  if (canonical(context.target) === sourceRoot) {
    fail("self_upgrade_source", "The current CLI is running inside the target installation; run upgrade from the source build directory.", { target: context.target });
  }

  const parent = path.dirname(context.target);
  const stage = allocateStage(parent);
  assertSameVolume(parent, stage);
  let backup: string | null = null;
  let committed = false;
  try {
    copyPayload(context.sourceRoot, stage, context.target, runtime.path);
    writeCommandWrappers(stage, context.target, runtime.path);
    installRuntimeDependencies(stage);
    // Refresh the Windows login autostart shim in the staged payload BEFORE the
    // manifest is taken: an upgrade must leave the registration pointing at the
    // current installed artifact, and the shim stays a managed file. The
    // manifest must stay BEFORE copyUnknownFiles so preserved user files are
    // never recorded as installer-owned.
    writeAutostartPayloadInto(stage, context.target, { nodePath: runtime.path });
    const stageFiles = scanFiles(stage);
    copyEmptyDirectories(context.target, stage, ownership.unowned);
    copyUnknownFiles(stage, ownership.unowned);
    const marker = makeMarker(stageFiles, context, oldMarker);
    writeMarker(stage, marker);

    const backupBase = path.join(parent, `.jobquay-backup-${crypto.randomBytes(8).toString("hex")}`);
    checkPathChain(backupBase, true);
    fs.renameSync(context.target, backupBase);
    backup = backupBase;
    try {
      fs.renameSync(stage, context.target);
      committed = true;
    } catch (e) {
      try {
        fs.renameSync(backupBase, context.target);
        backup = null;
      } catch (rollbackError) {
        fail("upgrade_rollback_failed", "The upgrade commit failed and the automatic rollback also failed; the old installation is kept in the backup directory.", {
          target: context.target,
          backup: backupBase,
          error: String((rollbackError as Error).message)
        });
      }
      fail("upgrade_commit_failed", "The upgrade commit failed; the old installation was rolled back.", { target: context.target, error: String((e as Error).message) });
    }

    // Verify every previously unowned file is present in the new installation before
    // deleting the backup copies. Any mismatch leaves the backup intact for recovery.
    const preservedByPath = new Map(ownership.unowned.map((file) => [file.path, file]));
    for (const file of ownership.unowned) {
      const destination = fromRelative(context.target, file.path);
      const preserved = preservedByPath.get(file.path)!;
      const destinationExists = fs.existsSync(destination);
      const destinationMode = destinationExists && process.platform !== "win32" ? (fs.statSync(destination).mode & 0o777) : undefined;
      if (
        !destinationExists ||
        sha256(destination) !== preserved.sha256 ||
        (preserved.mode !== undefined && destinationMode !== preserved.mode)
      ) {
        return {
          ok: true,
          command: "upgrade",
          target: context.target,
          installId: marker.installId,
          packageVersion: marker.packageVersion,
          productLicense: managedProductLicense(marker),
          thirdPartyNotices: managedNotice(marker),
          preservedFiles: summarizePaths(ownership.unowned.map((file) => file.path)),
          backupRetained: backupBase,
          warning: "The upgrade completed, but the user-file recheck before backup cleanup failed; the backup directory was retained.",
          autostart: registerDashboardAutostart(context.target, { env: process.env, nodePath: runtime.path })
        };
      }
    }
    const retainedBackup = cleanVerifiedTree(backupBase, oldSnapshot, oldMarkerRaw);
    backup = null;
    return {
      ok: true,
      command: "upgrade",
      target: context.target,
      installId: marker.installId,
      packageVersion: marker.packageVersion,
      managedFileCount: marker.managedFiles.length,
      productLicense: managedProductLicense(marker),
      thirdPartyNotices: managedNotice(marker),
      preservedFiles: summarizePaths(ownership.unowned.map((file) => file.path)),
      modifiedManagedFiles: summarizePaths(ownership.modified.map((file) => file.path)),
      backupRetained: retainedBackup.length ? backupBase : null,
      dataRoot,
      autostart: registerDashboardAutostart(context.target, { env: process.env, nodePath: runtime.path })
    };
  } catch (e) {
    if (!committed && backup && !fs.existsSync(context.target)) {
      try {
        fs.renameSync(backup, context.target);
        backup = null;
      } catch {
        // Keep the old installation in its explicitly reported backup path.
      }
    }
    if (fs.existsSync(stage)) {
      try {
        removeFreshStage(stage);
      } catch {
        // Keep unverified recovery material intact.
      }
    }
    throw e;
  }
}

export function uninstall(targetArg: string): OperationResult {
  const sourceRoot = path.resolve(__dirname, "..", "..");
  const selfTarget = canonical(targetArg) === canonical(sourceRoot);
  // An installed CLI must be able to remove its own managed files. The source
  // checkout is never a self-uninstall target, even if a marker is planted there.
  if (selfTarget && fs.existsSync(path.join(sourceRoot, ".git"))) {
    fail("source_checkout_overlap", "Cannot self-uninstall from the source checkout.", { target: targetArg });
  }
  const target = validateTarget(targetArg, selfTarget ? null : sourceRoot);
  ensureInstallDirectory(target, "managed");
  checkPathChain(target, false);
  const { marker, raw } = readMarker(target);
  const actual = scanFiles(target, true);
  const ownership = classifyFiles(actual, marker);
  // Remove ONLY the CrewDispatch-owned login entry, and only when it points into
  // the installation being removed. A foreign or differently-targeted value is
  // reported, never deleted. Failure here never fails the uninstall: the
  // operator can retry with `crewdispatch autostart disable`.
  const autostart = removeDashboardAutostart({ target, env: process.env });
  const removed: string[] = [];
  const preserved: string[] = [];

  for (const file of ownership.managed) {
    fs.unlinkSync(file.absolutePath);
    removed.push(file.path);
  }
  for (const file of ownership.unowned) preserved.push(file.path);

  const markerPath = path.join(target, INSTALL_MARKER);
  if (fs.existsSync(markerPath)) {
    assertRegularFile(markerPath);
    if (fs.readFileSync(markerPath, "utf8") === raw) {
      fs.unlinkSync(markerPath);
      removed.push(INSTALL_MARKER);
    } else {
      preserved.push(INSTALL_MARKER);
    }
  }
  pruneEmptyDirectories(target);
  let targetRemoved = false;
  try {
    fs.rmdirSync(target);
    targetRemoved = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
  }
  return {
    ok: true,
    command: "uninstall",
    target,
    installId: marker.installId,
    removed: summarizePaths(removed),
    preserved: summarizePaths(preserved),
    modifiedManagedFiles: summarizePaths(ownership.modified.map((file) => file.path)),
    targetRemoved,
    dataRootUntouched: true,
    autostart
  };
}

export function validateDataRootForPurge(dataRootArg: string, targetArg?: string | null): string {
  if (!path.isAbsolute(dataRootArg)) {
    fail("data_root_must_be_absolute", "The CrewDispatch data root must be an absolute path before it can be removed.", { dataRoot: dataRootArg });
  }
  const dataRoot = path.resolve(dataRootArg);
  const leaf = path.basename(dataRoot).toLowerCase();
  if (leaf !== "jobquay" && leaf !== "crewdispatch") {
    fail(
      "data_root_not_dedicated",
      "Refusing to recursively remove a data root whose final directory name is not JobQuay or CrewDispatch.",
      { dataRoot }
    );
  }
  if (targetArg && pathsOverlap(dataRoot, path.resolve(targetArg))) {
    fail("data_root_inside_install", "Refusing to purge a data root that overlaps the installation directory.", { dataRoot, target: path.resolve(targetArg) });
  }
  // Reuse the install-target safety policy: this rejects filesystem roots,
  // provider/system configuration trees, and any path containing a link/junction.
  validateTarget(dataRoot, null);
  if (fs.existsSync(dataRoot)) {
    checkPathChain(dataRoot, false);
    scanFiles(dataRoot);
  }
  return dataRoot;
}

export function purgeDataRoot(dataRootArg: string, targetArg?: string | null): { path: string; removed: boolean; alreadyAbsent: boolean } {
  const dataRoot = validateDataRootForPurge(dataRootArg, targetArg);
  if (!fs.existsSync(dataRoot)) return { path: dataRoot, removed: false, alreadyAbsent: true };
  fs.rmSync(dataRoot, { recursive: true, force: false });
  return { path: dataRoot, removed: true, alreadyAbsent: false };
}

export function inspectManagedTarget(targetArg: string): {
  target: string;
  marker: InstallMarkerData | null;
  markerError: string | null;
  missingFiles: string[];
  modifiedFiles: string[];
  unownedFiles: string[];
} {
  const target = validateTarget(targetArg, null);
  if (!fs.existsSync(target)) {
    return { target, marker: null, markerError: "target_missing", missingFiles: [], modifiedFiles: [], unownedFiles: [] };
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { target, marker: null, markerError: "unsafe_target", missingFiles: [], modifiedFiles: [], unownedFiles: [] };
  }
  try {
    checkPathChain(target, false);
    const { marker } = readMarker(target);
    const actual = scanFiles(target, true);
    const actualByPath = new Map(actual.map((file) => [file.path, file]));
    const expected = managedBy(marker);
    const missingFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const unownedFiles: string[] = [];
    for (const [filePath, expectedFile] of expected) {
      const actualFile = actualByPath.get(filePath);
      if (actualFile === undefined) missingFiles.push(filePath);
      else if (actualFile.sha256 !== expectedFile.sha256 || (expectedFile.mode !== undefined && actualFile.mode !== expectedFile.mode)) {
        modifiedFiles.push(filePath);
      }
    }
    for (const file of actual) if (!expected.has(file.path)) unownedFiles.push(file.path);
    return { target, marker, markerError: null, missingFiles, modifiedFiles, unownedFiles };
  } catch (e) {
    return {
      target,
      marker: null,
      markerError: e instanceof InstallError ? e.code : String((e as Error).message || e),
      missingFiles: [],
      modifiedFiles: [],
      unownedFiles: []
    };
  }
}

export { RUNTIME_LICENSES, summarizePaths };
