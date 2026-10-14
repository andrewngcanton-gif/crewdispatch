#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  macosMachOArchitectureForNodeArch,
  macosHelperArchitecturesMatchNodeArch
} = require("./macos-architecture.cjs");

const FIXED_DOS_DATE = 0x2821; // 2000-01-01
const UTF8_FLAG = 0x0800;
const ZIP32_LIMIT = 0xffffffff;
const UNIX_VERSION_MADE_BY = (3 << 8) | 20;
const POSIX_REGULAR_FILE = 0o100000;
const APPROVED_RELEASE_VERSION = "0.1.4";
const APPROVED_RELEASE_LICENSE = "Apache-2.0";
const APPROVED_PROVIDER_SCOPE = "command-code+workbuddy-ai";
const PRODUCT_LICENSE_FILE = "LICENSE";
const PRODUCT_LICENSE_MARKERS = ["Apache License", "Version 2.0, January 2004", "END OF TERMS AND CONDITIONS"];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { outputDir: null, allowDirty: false, scope: "command-code+workbuddy-ai" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output-dir") out.outputDir = argv[++i];
    else if (arg === "--allow-dirty") out.allowDirty = true;
    else if (arg === "--scope") out.scope = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: node scripts/build-release-candidate.cjs [--output-dir <dir>] [--allow-dirty] [--scope command-code|workbuddy-ai|command-code+workbuddy-ai]\n"
      );
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  if (!["command-code", "workbuddy-ai", "command-code+workbuddy-ai"].includes(out.scope)) {
    fail(`invalid --scope: ${out.scope}`);
  }
  if (out.outputDir === undefined) fail("--output-dir requires a value");
  return out;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function archivePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function machoCpuName(cpuType) {
  const value = cpuType >>> 0;
  if (value === 0x0100000c) return "arm64";
  if (value === 0x01000007) return "x86_64";
  if (value === 12) return "arm";
  if (value === 7) return "x86";
  return `unknown:0x${value.toString(16)}`;
}

/** Read the CPU inventory from a thin/fat Mach-O without invoking `file`/`lipo`. */
function inspectMachOArchitectures(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  const littleMagic = buffer.readUInt32LE(0);
  if (littleMagic === 0xfeedfacf || littleMagic === 0xfeedface) {
    return [machoCpuName(buffer.readUInt32LE(4))];
  }
  const bigMagic = buffer.readUInt32BE(0);
  if (bigMagic !== 0xcafebabe && bigMagic !== 0xcafebabf) return null;
  const count = buffer.readUInt32BE(4);
  const entrySize = bigMagic === 0xcafebabf ? 32 : 20;
  if (count < 1 || count > 32 || buffer.length < 8 + count * entrySize) return null;
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const cpuType = buffer.readUInt32BE(8 + index * entrySize);
    const name = machoCpuName(cpuType);
    if (!architectures.includes(name)) architectures.push(name);
  }
  return architectures.sort((a, b) => a.localeCompare(b, "en"));
}

function inspectDarwinSignature(file) {
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", file], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status !== 0) {
    return { kind: "unsigned", teamIdentifier: null, cdHashSha256: null };
  }
  const signature = /^Signature=(.+)$/m.exec(detail)?.[1]?.trim() || "signed";
  const teamRaw = /^TeamIdentifier=(.+)$/m.exec(detail)?.[1]?.trim() || "";
  const cdHash = /^CandidateCDHashFull sha256=([a-f0-9]+)$/mi.exec(detail)?.[1]?.toLowerCase()
    || /^CDHash=([a-f0-9]+)$/mi.exec(detail)?.[1]?.toLowerCase()
    || null;
  return {
    kind: signature.toLowerCase() === "adhoc" ? "adhoc" : "signed",
    teamIdentifier: teamRaw && teamRaw !== "not set" ? teamRaw : null,
    cdHashSha256: cdHash
  };
}

function buildCandidateInventory(packageJson, rawFiles, entries) {
  const entryByPath = new Map(entries.map((entry) => [entry.relative, entry]));
  const rawByPath = new Map(rawFiles.map((file) => [file.relative, file]));
  const bin = packageJson && typeof packageJson.bin === "object" && packageJson.bin ? packageJson.bin : {};
  const commandEntrypoints = Object.entries(bin)
    .map(([name, value]) => ({ name, archiveEntry: archivePath(value) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const command of commandEntrypoints) {
    if (!entryByPath.has(command.archiveEntry)) fail(`command entry is missing from candidate payload: ${command.name} -> ${command.archiveEntry}`);
  }

  const notices = ["THIRD_PARTY_NOTICES"].map((relative) => {
    const entry = entryByPath.get(relative);
    if (!entry) fail(`required notice is missing from candidate payload: ${relative}`);
    return { path: relative, bytes: entry.size, sha256: entry.sha256 };
  });

  const licenseEntry = entryByPath.get(PRODUCT_LICENSE_FILE);
  if (!licenseEntry) fail(`required product license is missing from candidate payload: ${PRODUCT_LICENSE_FILE}`);
  const licenseText = licenseEntry.data.toString("utf8");
  for (const marker of PRODUCT_LICENSE_MARKERS) {
    if (!licenseText.includes(marker)) fail(`product LICENSE is not the expected Apache-2.0 text: missing ${marker}`);
  }
  if (packageJson.license !== APPROVED_RELEASE_LICENSE) {
    fail(`package license must be ${APPROVED_RELEASE_LICENSE}; found ${String(packageJson.license)}`);
  }
  const productLicense = {
    path: PRODUCT_LICENSE_FILE,
    spdx: APPROVED_RELEASE_LICENSE,
    bytes: licenseEntry.size,
    sha256: licenseEntry.sha256
  };

  const nativeArtifacts = [];
  if (process.platform === "darwin") {
    const relative = "dist/native/macos-process-info";
    const entry = entryByPath.get(relative);
    const raw = rawByPath.get(relative);
    if (!entry || !raw) fail(`required macOS native helper missing from candidate payload: ${relative}`);
    if ((entry.mode & 0o111) === 0) fail(`macOS native helper is not executable: ${relative}`);
    const architectures = inspectMachOArchitectures(entry.data);
    const expectedArchitecture = macosMachOArchitectureForNodeArch(process.arch);
    if (!expectedArchitecture) fail(`unsupported macOS Node architecture for candidate packaging: ${process.arch}`);
    if (!macosHelperArchitecturesMatchNodeArch(architectures, process.arch)) {
      fail(`macOS native helper must be a thin ${expectedArchitecture} Mach-O for Node ${process.arch}; found ${architectures ? architectures.join(",") : "unknown format"}`);
    }
    nativeArtifacts.push({
      path: relative,
      format: "mach-o",
      architectures,
      mode: entry.mode,
      bytes: entry.size,
      sha256: entry.sha256,
      signature: inspectDarwinSignature(raw.absolute)
    });
  }

  return {
    buildHost: { platform: process.platform, arch: process.arch },
    candidateScope: process.platform === "darwin"
      ? { platform: "darwin", architectures: [macosMachOArchitectureForNodeArch(process.arch)].filter(Boolean) }
      : { platform: process.platform, architectures: [] },
    commandEntrypoints,
    notices,
    productLicense,
    nativeArtifacts
  };
}

function git(sourceRoot, args) {
  const result = spawnSync("git", args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${result.error ? result.error.message : result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function assertRegularFile(file) {
  if (!fs.existsSync(file)) fail(`required release input missing: ${file}`);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`release input must be a regular file: ${file}`);
}

function collectTree(root, archivePrefix, files, skipTopLevelNames = new Set()) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`release input tree must be a regular directory: ${root}`);
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    if (skipTopLevelNames.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    const relative = `${archivePrefix}/${entry.name}`.replaceAll("\\", "/");
    const itemStat = fs.lstatSync(absolute);
    if (itemStat.isSymbolicLink()) fail(`release input contains a symlink: ${absolute}`);
    if (itemStat.isDirectory()) collectTree(absolute, relative, files);
    else if (itemStat.isFile()) files.push({ absolute, relative });
    else fail(`release input contains an unsupported file type: ${absolute}`);
  }
}

function collectReleaseFiles(sourceRoot) {
  const files = [];
  collectTree(path.join(sourceRoot, "dist"), "dist", files, new Set(["tests"]));
  for (const relative of [
    "integrations/claude/commands/crewdispatch.md",
    "integrations/codex/prompts/crewdispatch.md",
    "scripts/install-codex-command.cjs",
    "scripts/uninstall-codex-command.cjs",
    "plugins/crewdispatch/.codex-plugin/plugin.json",
    "plugins/crewdispatch/skills/crewdispatch/SKILL.md",
    "plugins/crewdispatch/mcp.template.json",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES"
  ]) {
    const absolute = path.join(sourceRoot, ...relative.split("/"));
    assertRegularFile(absolute);
    files.push({ absolute, relative });
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative, "en"));

  const seen = new Set();
  for (const file of files) {
    if (seen.has(file.relative)) fail(`duplicate archive path: ${file.relative}`);
    seen.add(file.relative);
    if (
      file.relative === ".env" ||
      file.relative.startsWith(".env.") ||
      file.relative.includes("/.git/") ||
      file.relative.startsWith(".git/") ||
      file.relative.startsWith("dist/tests/")
    ) {
      fail(`forbidden release path: ${file.relative}`);
    }
  }
  return files;
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function buildDeterministicZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.relative, "utf8");
    const data = entry.data;
    const mode = Number.isInteger(entry.mode) ? entry.mode & 0o777 : 0o644;
    if (data.length > ZIP32_LIMIT || offset > ZIP32_LIMIT) fail(`ZIP32 limit exceeded by ${entry.relative}`);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(UNIX_VERSION_MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((POSIX_REGULAR_FILE | mode) << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (entries.length > 0xffff || centralDirectory.length > ZIP32_LIMIT || offset > ZIP32_LIMIT) fail("ZIP32 archive limits exceeded");

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(__dirname, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  const pluginJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "plugins", "crewdispatch", ".codex-plugin", "plugin.json"), "utf8"));
  const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
  const dirty = git(sourceRoot, ["status", "--porcelain"]).length > 0;
  if (dirty && !args.allowDirty) fail("working tree is dirty; commit/stash changes first, or use --allow-dirty for a non-release internal candidate");

  const rawFiles = collectReleaseFiles(sourceRoot);
  const entries = rawFiles.map((file) => {
    const data = fs.readFileSync(file.absolute);
    const mode = fs.statSync(file.absolute).mode & 0o777;
    return { relative: file.relative, data, mode, size: data.length, sha256: sha256(data) };
  });
  const inventory = buildCandidateInventory(packageJson, rawFiles, entries);
  const zip = buildDeterministicZip(entries);
  const archiveSha256 = sha256(zip);
  const shortCommit = commit.slice(0, 8);
  const dirtyLabel = dirty ? "-dirty" : "";
  const baseName = `crewdispatch-${packageJson.version}-${process.platform}-${process.arch}-${shortCommit}${dirtyLabel}-${archiveSha256.slice(0, 12)}`;
  const outputDir = path.resolve(args.outputDir || path.join(sourceRoot, "work", "release-candidates"));
  fs.mkdirSync(outputDir, { recursive: true });

  const archivePath = path.join(outputDir, `${baseName}.zip`);
  const reportPath = path.join(outputDir, `${baseName}.json`);
  const checksumPath = path.join(outputDir, `${baseName}.sha256`);
  fs.writeFileSync(archivePath, zip);
  fs.writeFileSync(checksumPath, `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");

  const metadataBlockers = [];
  if (dirty) metadataBlockers.push("working tree is dirty");
  if (String(packageJson.version) !== APPROVED_RELEASE_VERSION) metadataBlockers.push(`package version must be ${APPROVED_RELEASE_VERSION}`);
  if (String(pluginJson.version) !== APPROVED_RELEASE_VERSION) metadataBlockers.push(`plugin version must be ${APPROVED_RELEASE_VERSION}`);
  if (String(packageJson.version) !== String(pluginJson.version)) metadataBlockers.push("package and plugin versions are not aligned");
  if (packageJson.license !== APPROVED_RELEASE_LICENSE) metadataBlockers.push(`package license must be ${APPROVED_RELEASE_LICENSE}`);
  if (args.scope !== APPROVED_PROVIDER_SCOPE) metadataBlockers.push(`${APPROVED_RELEASE_VERSION} provider scope must be ${APPROVED_PROVIDER_SCOPE}`);
  const blockers = [
    ...metadataBlockers,
    "public release acceptance gates are not completed (MAC-60I / MAC-REL-01..08)"
  ];

  const report = {
    kind: "jobquay-release-candidate",
    releaseEligible: false,
    internalOnly: true,
    candidateMetadataValid: metadataBlockers.length === 0,
    publicDistributionApproved: false,
    sourceRoot,
    gitCommit: commit,
    gitDirty: dirty,
    packageVersion: packageJson.version,
    pluginVersion: pluginJson.version,
    providerScope: args.scope,
    providersBundled: false,
    npmPublishBlocked: packageJson.private === true,
    distributionForm: {
      kind: "github-zip",
      signing: process.platform === "darwin" ? "unsigned-or-adhoc" : "unsigned",
      developerIdRequired: false,
      notarizationRequired: false,
      gatekeeperUserConfirmationRequired: process.platform === "darwin"
    },
    nodeVersion: process.version,
    buildHost: inventory.buildHost,
    candidateScope: inventory.candidateScope,
    commandEntrypoints: inventory.commandEntrypoints,
    notices: inventory.notices,
    productLicense: inventory.productLicense,
    nativeArtifacts: inventory.nativeArtifacts,
    archive: {
      path: archivePath,
      sha256: archiveSha256,
      bytes: zip.length,
      deterministicTimestamps: "2000-01-01T00:00:00",
      compression: "store",
      posixModes: "unix-external-attributes"
    },
    checksumPath,
    reportPath,
    files: entries.map(({ relative, mode, size, sha256: fileSha256 }) => ({ path: relative, mode, bytes: size, sha256: fileSha256 })),
    releaseBlockers: blockers
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (require.main === module) main();

module.exports = { buildDeterministicZip, collectReleaseFiles, crc32, inspectMachOArchitectures };
