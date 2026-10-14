// autostart.ts — platform-agnostic orchestration of the Dashboard autostart.
//
// Ownership model (one sentence): the internal installer owns the registration
// for the installation it just created; upgrade refreshes it to the current
// artifact; uninstall removes only the CrewDispatch-owned entry; the operator can
// disable/re-enable/inspect it through `jobquay autostart`.
//
// Failure policy (documented, and identical everywhere):
//   * writing the shim into the staged payload is a payload write — if it
//     fails, the install fails like any other payload failure and nothing is
//     committed;
//   * registering the Run value happens after the install is committed. It is
//     a Dashboard convenience, never a job-service dependency, so a failure
//     leaves the installation intact and is reported as a degraded
//     `autostart` sub-result. `doctor` then reports the resulting state
//     honestly instead of pretending the install is healthy.
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../jobs/store";
import { readAutostartRunRecord, type AutostartRunRecord } from "../dashboard/autostart";
import { probeHubEndpoint, resolveDashboardPort } from "../dashboard/launcher";
import { INSTALL_MARKER } from "./marker";
import { resolveUserNodeRuntime } from "./node-runtime";
import {
  MACOS_AUTOSTART_LABEL,
  MACOS_AUTOSTART_MECHANISM_ID,
  inspectMacLaunchAgent,
  makeMacLaunchAgentSpec,
  registerMacLaunchAgent,
  removeMacLaunchAgent
} from "./autostart-macos";
import {
  AUTOSTART_MECHANISM_ID,
  AUTOSTART_METADATA_FORMAT_VERSION,
  AUTOSTART_VALUE_NAME,
  autostartMetadataPath,
  autostartShimPath,
  isJobQuayAutostartCommand,
  parseAutostartCommand,
  renderAutostartCommand,
  resolveAutostartRegistry,
  writeAutostartPayload,
  type AutostartPayloadInput,
  type AutostartRegistry
} from "./autostart-windows";

export interface AutostartError {
  code: string;
  message: string;
}

export interface RegisterAutostartResult {
  ok: boolean;
  platformSupported: boolean;
  mechanism: string;
  valueName: string;
  registered: boolean;
  command: string | null;
  shimPath: string | null;
  metadataPath: string | null;
  error: AutostartError | null;
  note: string | null;
}

export interface RemoveAutostartResult {
  ok: boolean;
  platformSupported: boolean;
  mechanism: string;
  valueName: string;
  removed: boolean;
  reason: "removed" | "not_registered" | "value_not_jobquay" | "points_at_other_install" | "platform_unsupported" | null;
  command: string | null;
  registeredInstallRoot: string | null;
  error: AutostartError | null;
}

export interface AutostartInspection {
  ok: boolean;
  status: "healthy" | "disabled" | "broken" | "unsupported" | "unknown";
  platform: NodeJS.Platform;
  platformSupported: boolean;
  mechanism: string;
  valueName: string;
  registered: boolean | null;
  registeredCommand: string | null;
  expectedCommand: string | null;
  matchesExpectedCommand: boolean | null;
  targetsThisInstall: boolean | null;
  registeredInstallRoot: string | null;
  shim: { path: string | null; exists: boolean | null };
  metadata: {
    path: string | null;
    valid: boolean | null;
    nodePath: string | null;
    nodeExists: boolean | null;
    cliEntry: string | null;
    cliEntryExists: boolean | null;
    error: string | null;
  };
  lastRun: AutostartRunRecord | null;
  lastRunError: string | null;
  hubEndpoint: {
    port: number | null;
    state: "ready" | "unreachable" | "foreign" | "unknown";
    version: string | null;
    error: string | null;
  };
  error: AutostartError | null;
  hint: string | null;
}

export interface RegisterAutostartOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registry?: AutostartRegistry;
  /** Node runtime recorded in the shim (default: the running process). */
  nodePath?: string;
}

export interface RemoveAutostartOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registry?: AutostartRegistry;
  /** When given, only remove the value if it points into this installation. */
  target?: string | null;
}

export interface InspectAutostartOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  registry?: AutostartRegistry;
  target?: string | null;
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  port?: number;
  /** Set false to skip the loopback `/api/ping` probe (default: probe). */
  probeHub?: boolean;
}

function canonical(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameCommandLine(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const UNSUPPORTED_NOTE = "Dashboard autostart is implemented for Windows and macOS in this internal build; no login entry is registered or claimed on this platform.";

function cliCommandHint(target: string | null): string {
  if (target) {
    const entry = path.join(target, "dist", "cli", "jobquay-cli.js");
    return `node "${entry}" autostart enable --target "${target}"`;
  }
  return "jobquay autostart enable --target <installed-directory>";
}

/**
 * Write the autostart shim + metadata into a staged payload. Called by
 * install/upgrade BEFORE the managed-file manifest is taken, so both files are
 * owned by the install marker and are removed again by uninstall.
 */
export function writeAutostartPayloadInto(payloadRoot: string, installRoot: string, input: AutostartPayloadInput = {}): void {
  // Windows owns a payload-local GUI shim. macOS owns one external user
  // LaunchAgent plist instead, so a macOS install must not carry Windows-only
  // autostart files in its managed payload.
  if (process.platform === "win32") writeAutostartPayload(payloadRoot, installRoot, input);
}

/**
 * Register (or refresh) the user-scoped Windows Dashboard autostart for one
 * managed installation. Never throws: every failure is returned as a degraded
 * result so the caller can report it without corrupting the installation.
 */
export function registerDashboardAutostart(target: string, options: RegisterAutostartOptions = {}): RegisterAutostartResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const platformSupported = platform === "win32" || platform === "darwin";
  const base: RegisterAutostartResult = {
    ok: false,
    platformSupported,
    mechanism: platform === "darwin" ? MACOS_AUTOSTART_MECHANISM_ID : AUTOSTART_MECHANISM_ID,
    valueName: platform === "darwin" ? MACOS_AUTOSTART_LABEL : AUTOSTART_VALUE_NAME,
    registered: false,
    command: null,
    shimPath: null,
    metadataPath: null,
    error: null,
    note: null
  };
  if (!platformSupported) {
    return { ...base, ok: true, note: UNSUPPORTED_NOTE };
  }
  try {
    const installRoot = path.resolve(target);
    if (!fs.existsSync(path.join(installRoot, INSTALL_MARKER))) {
      return {
        ...base,
        error: { code: "not_managed", message: `Target is not a managed CrewDispatch installation (no ${INSTALL_MARKER}): ${installRoot}` }
      };
    }
    if (platform === "darwin") {
      const mac = registerMacLaunchAgent(installRoot, { env, nodePath: options.nodePath ?? resolveUserNodeRuntime(env, platform)?.path ?? process.execPath });
      return {
        ...base,
        ok: mac.ok,
        registered: mac.registered,
        command: JSON.stringify(mac.spec.programArguments),
        shimPath: mac.spec.plistPath,
        metadataPath: mac.spec.plistPath,
        error: mac.error,
        note: null
      };
    }
    const payload = writeAutostartPayload(installRoot, installRoot, { nodePath: options.nodePath ?? resolveUserNodeRuntime(env, platform)?.path ?? process.execPath });
    const command = renderAutostartCommand(payload.shimPath, env);
    const registry = options.registry ?? resolveAutostartRegistry(env);
    const written = registry.write(AUTOSTART_VALUE_NAME, command);
    if (!written.ok) {
      return {
        ...base,
        shimPath: payload.shimPath,
        metadataPath: payload.metadataPath,
        error: { code: "autostart_registration_failed", message: written.error }
      };
    }
    const readBack = registry.read(AUTOSTART_VALUE_NAME);
    if (!readBack.ok) {
      return {
        ...base,
        shimPath: payload.shimPath,
        metadataPath: payload.metadataPath,
        error: { code: "autostart_verification_failed", message: readBack.error }
      };
    }
    if (readBack.value !== command) {
      return {
        ...base,
        shimPath: payload.shimPath,
        metadataPath: payload.metadataPath,
        error: {
          code: "autostart_verification_failed",
          message: `Registered command does not match the written command for ${installRoot}.`
        }
      };
    }
    return {
      ok: true,
      platformSupported: true,
      mechanism: AUTOSTART_MECHANISM_ID,
      valueName: AUTOSTART_VALUE_NAME,
      registered: true,
      command,
      shimPath: payload.shimPath,
      metadataPath: payload.metadataPath,
      error: null,
      note: null
    };
  } catch (error) {
    return { ...base, error: { code: "autostart_registration_failed", message: String((error as Error)?.message || error) } };
  }
}

/**
 * Remove the CrewDispatch-owned autostart entry. Only a value that parses as a
 * CrewDispatch shim command is ever deleted; a foreign or repurposed value is left
 * alone and reported. When `target` is given (uninstall), a value pointing at
 * a different installation is also left alone.
 */
export function removeDashboardAutostart(options: RemoveAutostartOptions = {}): RemoveAutostartResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const platformSupported = platform === "win32" || platform === "darwin";
  const base: RemoveAutostartResult = {
    ok: false,
    platformSupported,
    mechanism: platform === "darwin" ? MACOS_AUTOSTART_MECHANISM_ID : AUTOSTART_MECHANISM_ID,
    valueName: platform === "darwin" ? MACOS_AUTOSTART_LABEL : AUTOSTART_VALUE_NAME,
    removed: false,
    reason: null,
    command: null,
    registeredInstallRoot: null,
    error: null
  };
  if (!platformSupported) {
    return { ...base, ok: true, reason: "platform_unsupported" };
  }
  if (platform === "darwin") {
    const mac = removeMacLaunchAgent({ env, target: options.target });
    return {
      ...base,
      ok: mac.ok,
      removed: mac.removed,
      reason: mac.reason,
      command: null,
      registeredInstallRoot: mac.registeredInstallRoot,
      error: mac.error
    };
  }
  try {
    const registry = options.registry ?? resolveAutostartRegistry(env);
    const read = registry.read(AUTOSTART_VALUE_NAME);
    if (!read.ok) {
      return { ...base, error: { code: "autostart_read_failed", message: read.error } };
    }
    if (read.value === null) {
      return { ...base, ok: true, reason: "not_registered" };
    }
    const parsed = parseAutostartCommand(read.value);
    if (!isJobQuayAutostartCommand(read.value)) {
      return { ...base, ok: true, reason: "value_not_jobquay", command: read.value };
    }
    if (options.target) {
      const target = canonical(options.target, platform);
      if (!parsed.installRoot || canonical(parsed.installRoot, platform) !== target) {
        return {
          ...base,
          ok: true,
          reason: "points_at_other_install",
          command: read.value,
          registeredInstallRoot: parsed.installRoot
        };
      }
    }
    const removed = registry.remove(AUTOSTART_VALUE_NAME);
    if (!removed.ok) {
      return { ...base, error: { code: "autostart_removal_failed", message: removed.error } };
    }
    return {
      ...base,
      ok: true,
      removed: removed.removed,
      reason: removed.removed ? "removed" : "not_registered",
      command: read.value,
      registeredInstallRoot: parsed.installRoot
    };
  } catch (error) {
    return { ...base, error: { code: "autostart_removal_failed", message: String((error as Error)?.message || error) } };
  }
}

interface AutostartMetadata {
  product?: unknown;
  kind?: unknown;
  formatVersion?: unknown;
  installRoot?: unknown;
  nodePath?: unknown;
  cliEntry?: unknown;
}

/**
 * Read-only inspection used by `jobquay autostart status` and `doctor`. It
 * answers three questions honestly: is the CrewDispatch-owned Run value present and
 * does it still match this installation; do the shim and its recorded runtime
 * exist; and does the configured Hub endpoint answer as CrewDispatch. It reads no
 * credentials and performs no writes.
 */
export async function inspectDashboardAutostart(options: InspectAutostartOptions = {}): Promise<AutostartInspection> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const target = options.target ? path.resolve(options.target) : null;
  const dataRoot = options.dataRoot ?? resolveDataRoot(undefined, env);
  const platformSupported = platform === "win32" || platform === "darwin";

  const lastRunRead = readAutostartRunRecord(dataRoot);
  const lastRun = lastRunRead.ok ? lastRunRead.record : null;
  const lastRunError = lastRunRead.ok ? null : lastRunRead.error;

  let hubEndpoint: AutostartInspection["hubEndpoint"] = { port: null, state: "unknown", version: null, error: null };
  if (options.probeHub !== false) {
    try {
      const port = resolveDashboardPort({ port: options.port, env });
      const probe = await probeHubEndpoint(port, options.fetchImpl ?? fetch);
      hubEndpoint = { port, state: probe.state, version: probe.version, error: null };
    } catch (error) {
      hubEndpoint = { port: null, state: "unknown", version: null, error: String((error as Error)?.message || error) };
    }
  }

  const base: AutostartInspection = {
    ok: false,
    status: "unknown",
    platform,
    platformSupported,
    mechanism: platform === "darwin" ? MACOS_AUTOSTART_MECHANISM_ID : AUTOSTART_MECHANISM_ID,
    valueName: platform === "darwin" ? MACOS_AUTOSTART_LABEL : AUTOSTART_VALUE_NAME,
    registered: null,
    registeredCommand: null,
    expectedCommand: target
      ? (platform === "darwin"
        ? JSON.stringify(makeMacLaunchAgentSpec(target, { env, dataRoot }).programArguments)
        : renderAutostartCommand(autostartShimPath(target), env))
      : null,
    matchesExpectedCommand: null,
    targetsThisInstall: null,
    registeredInstallRoot: null,
    shim: { path: null, exists: null },
    metadata: { path: null, valid: null, nodePath: null, nodeExists: null, cliEntry: null, cliEntryExists: null, error: null },
    lastRun,
    lastRunError,
    hubEndpoint,
    error: null,
    hint: null
  };

  if (!platformSupported) {
    return { ...base, ok: true, status: "unsupported", hint: UNSUPPORTED_NOTE };
  }

  if (platform === "darwin") {
    const mac = inspectMacLaunchAgent({ target, env, dataRoot });
    const registeredCommand = mac.registeredProgramArguments ? JSON.stringify(mac.registeredProgramArguments) : null;
    const expectedCommand = mac.spec ? JSON.stringify(mac.spec.programArguments) : null;
    const targetsThisInstall = target && mac.registeredInstallRoot
      ? canonical(mac.registeredInstallRoot, platform) === canonical(target, platform)
      : null;
    const lastRunFailure = lastRun?.ok === false ? lastRun : null;
    const endpointFailure = hubEndpoint.state === "foreign" || hubEndpoint.state === "unreachable";
    const effectiveStatus =
      mac.status !== "healthy"
        ? mac.status
        : lastRunError
          ? "unknown"
          : lastRunFailure || endpointFailure
            ? "broken"
            : "healthy";
    const effectiveError: AutostartError | null =
      mac.error ??
      (lastRunError
        ? { code: "autostart_diagnostic_read_failed", message: lastRunError }
        : lastRunFailure
          ? {
              code: lastRunFailure.error?.code ?? "autostart_last_run_failed",
              message: lastRunFailure.error?.message ?? "The most recent Dashboard autostart run failed."
            }
          : endpointFailure
            ? {
                code: hubEndpoint.state === "foreign" ? "hub_endpoint_foreign" : "hub_endpoint_unreachable",
                message: hubEndpoint.state === "foreign"
                  ? "The configured Dashboard port is occupied by a non-CrewDispatch or mismatched Hub."
                  : "The configured Dashboard Hub endpoint is unreachable."
              }
            : null);
    return {
      ...base,
      ok: effectiveStatus === "healthy",
      status: effectiveStatus,
      registered: mac.exists,
      registeredCommand,
      expectedCommand,
      matchesExpectedCommand: registeredCommand && expectedCommand ? registeredCommand === expectedCommand : null,
      targetsThisInstall,
      registeredInstallRoot: mac.registeredInstallRoot,
      shim: { path: mac.plistPath, exists: mac.exists },
      metadata: {
        path: mac.plistPath,
        valid: mac.owned,
        nodePath: mac.registeredProgramArguments?.[0] ?? null,
        nodeExists: mac.nodeExists,
        cliEntry: mac.registeredProgramArguments?.[1] ?? null,
        cliEntryExists: mac.cliEntryExists,
        error: mac.error?.message ?? null
      },
      error: effectiveError,
      hint: effectiveStatus === "disabled"
        ? `Dashboard autostart is not registered. Re-enable it with: ${cliCommandHint(target)}`
        : effectiveStatus === "healthy"
          ? null
          : `Re-register it with: ${cliCommandHint(target)}`
    };
  }

  let registry: AutostartRegistry;
  try {
    registry = options.registry ?? resolveAutostartRegistry(env);
  } catch (error) {
    return { ...base, status: "unknown", error: { code: "autostart_read_failed", message: String((error as Error)?.message || error) } };
  }

  const read = registry.read(AUTOSTART_VALUE_NAME);
  if (!read.ok) {
    return { ...base, status: "unknown", error: { code: "autostart_read_failed", message: read.error } };
  }
  if (read.value === null) {
    return {
      ...base,
      status: "disabled",
      registered: false,
      hint: `Dashboard autostart is not registered. Re-enable it with: ${cliCommandHint(target)}`
    };
  }

  const registeredCommand = read.value;
  const parsed = parseAutostartCommand(registeredCommand);
  if (!isJobQuayAutostartCommand(registeredCommand)) {
    return {
      ...base,
      status: "broken",
      registered: true,
      registeredCommand,
      error: {
        code: "value_not_jobquay",
        message: `The ${AUTOSTART_VALUE_NAME} Run value does not point at a CrewDispatch autostart shim; it is left untouched.`
      }
    };
  }

  const shimPath = parsed.shimPath!;
  const installRoot = parsed.installRoot!;
  const shimExists = fs.existsSync(shimPath);
  const metadataPath = autostartMetadataPath(installRoot);
  const metadata: AutostartInspection["metadata"] = {
    path: metadataPath,
    valid: false,
    nodePath: null,
    nodeExists: null,
    cliEntry: null,
    cliEntryExists: null,
    error: null
  };
  try {
    const raw = fs.readFileSync(metadataPath, "utf8");
    const parsedMetadata = JSON.parse(raw) as AutostartMetadata;
    if (
      parsedMetadata.product !== "jobquay" ||
      parsedMetadata.kind !== "jobquay-dashboard-autostart" ||
      parsedMetadata.formatVersion !== AUTOSTART_METADATA_FORMAT_VERSION ||
      typeof parsedMetadata.installRoot !== "string" ||
      typeof parsedMetadata.nodePath !== "string" ||
      typeof parsedMetadata.cliEntry !== "string"
    ) {
      metadata.error = "the autostart metadata file has an unsupported shape";
    } else {
      metadata.valid = true;
      metadata.nodePath = parsedMetadata.nodePath;
      metadata.nodeExists = fs.existsSync(parsedMetadata.nodePath);
      metadata.cliEntry = parsedMetadata.cliEntry;
      metadata.cliEntryExists = fs.existsSync(parsedMetadata.cliEntry);
    }
  } catch (error) {
    metadata.error = String((error as Error)?.message || error);
  }

  const targetsThisInstall = target ? canonical(installRoot, platform) === canonical(target, platform) : null;
  const matchesExpectedCommand = target
    ? sameCommandLine(registeredCommand, renderAutostartCommand(autostartShimPath(target), env), platform)
    : null;

  const problems: AutostartError[] = [];
  if (!shimExists) problems.push({ code: "shim_missing", message: `The registered autostart shim is missing: ${shimPath}` });
  if (!metadata.valid) problems.push({ code: "metadata_invalid", message: `The autostart metadata is missing or invalid: ${metadata.error ?? metadataPath}` });
  if (metadata.valid && metadata.nodeExists === false) problems.push({ code: "runtime_missing", message: `The recorded Node runtime is missing: ${metadata.nodePath}` });
  if (metadata.valid && metadata.cliEntryExists === false) problems.push({ code: "cli_entry_missing", message: `The recorded CrewDispatch CLI entry is missing: ${metadata.cliEntry}` });
  if (targetsThisInstall === false) {
    problems.push({
      code: "other_install",
      message: `The registered autostart points at ${installRoot}, not at ${target}.`
    });
  }

  const status: AutostartInspection["status"] = problems.length === 0 ? "healthy" : "broken";
  return {
    ...base,
    ok: status === "healthy",
    status,
    registered: true,
    registeredCommand,
    matchesExpectedCommand,
    targetsThisInstall,
    registeredInstallRoot: installRoot,
    shim: { path: shimPath, exists: shimExists },
    metadata,
    error: problems.length ? problems[0]! : null,
    hint: status === "healthy" ? null : `Re-register it with: ${cliCommandHint(target)}`
  };
}
