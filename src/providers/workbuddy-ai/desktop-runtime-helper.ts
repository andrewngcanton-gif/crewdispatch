import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { captureProcessIdentity } from "../../runtime/process";

type JsonObject = Record<string, unknown>;
type DynamicModule = Record<string, any>;

interface HelperArgs {
  asarPath: string;
  configDir: string;
  controlEndpoint: string | null;
  bootstrapOnly: boolean;
  ensureSidecar: boolean;
  appOwnerPid: number | null;
  appOwnerCreatedAtUs: number | null;
  sessionId: string | null;
  appExe: string | null;
  cliPath: string | null;
  cwd: string | null;
  permission: string | null;
  effort: string | null;
}
function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function parseArgs(argv: string[]): HelperArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !value || !key.startsWith("--")) throw new Error("invalid helper arguments");
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key)?.trim();
    if (!value) throw new Error("missing helper argument " + key);
    return value;
  };
  const effortRaw = values.get("--effort")?.trim() || "";
  const bootstrapOnly = values.get("--bootstrap-only")?.trim() === "1";
  const ensureSidecar = values.get("--ensure-sidecar")?.trim() === "1";
  if (bootstrapOnly && ensureSidecar) throw new Error("helper modes are mutually exclusive");
  const ownerPid = ensureSidecar ? Number(required("--app-owner-pid")) : null;
  const ownerCreatedAtUs = ensureSidecar ? Number(required("--app-owner-created-at-us")) : null;
  if (ensureSidecar && (!Number.isSafeInteger(ownerPid) || Number(ownerPid) <= 0)) {
    throw new Error("invalid WorkBuddy Desktop owner pid");
  }
  if (ensureSidecar && (!Number.isSafeInteger(ownerCreatedAtUs) || Number(ownerCreatedAtUs) <= 0)) {
    throw new Error("invalid WorkBuddy Desktop owner birth identity");
  }
  return {
    asarPath: required("--asar"),
    configDir: required("--config-dir"),
    controlEndpoint: ensureSidecar ? null : required("--control-endpoint"),
    bootstrapOnly,
    ensureSidecar,
    appOwnerPid: ownerPid,
    appOwnerCreatedAtUs: ownerCreatedAtUs,
    sessionId: bootstrapOnly || ensureSidecar ? null : required("--session-id"),
    appExe: bootstrapOnly || ensureSidecar ? null : required("--app-exe"),
    cliPath: bootstrapOnly || ensureSidecar ? null : required("--cli"),
    cwd: bootstrapOnly || ensureSidecar ? null : required("--cwd"),
    permission: bootstrapOnly || ensureSidecar ? null : required("--permission"),
    effort: effortRaw || null
  };
}

function request(endpoint: string, method: string, params: JsonObject, timeoutMs = 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(method + " timed out")), timeoutMs);
    socket.once("connect", () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as JsonObject;
        const error = asObject(message.error);
        if (error) finish(new Error(String(error.message || method + " failed")));
        else finish(undefined, message.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error(method + " connection closed"));
    });
  });
}

function nativeStorage(): { loggerGet(): unknown } {
  const linked = (process as NodeJS.Process & {
    _linkedBinding?: (name: string) => unknown;
  })._linkedBinding;
  if (typeof linked !== "function") throw new Error("WorkBuddy native storage binding is unavailable.");
  const storage = linked("electron_browser_workbuddy_storage") as { loggerGet?: () => unknown };
  if (typeof storage?.loggerGet !== "function") throw new Error("WorkBuddy native loggerGet is unavailable.");
  return { loggerGet: storage.loggerGet.bind(storage) };
}

function dynamicFunction(
  module: DynamicModule,
  descriptiveName: string,
  fallbackKey: string,
  expectedFallbackName?: string
): (...args: any[]) => any {
  const direct = module[descriptiveName];
  if (typeof direct === "function") return direct;
  const named = Object.values(module).filter(
    (candidate): candidate is (...args: any[]) => any =>
      typeof candidate === "function" && candidate.name === descriptiveName
  );
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error("WorkBuddy packaged helper API is incompatible: " + descriptiveName);
  const fallback = module[fallbackKey];
  if (
    typeof fallback === "function" &&
    (!expectedFallbackName || fallback.name === expectedFallbackName || fallback.name === "")
  ) return fallback;
  throw new Error("WorkBuddy packaged helper API is incompatible: " + descriptiveName);
}

function findDescriptiveFunction(module: DynamicModule, descriptiveName: string): ((...args: any[]) => any) | null {
  const direct = module[descriptiveName];
  if (typeof direct === "function") return direct;
  const matches = Object.values(module).filter(
    (candidate): candidate is (...args: any[]) => any =>
      typeof candidate === "function" && candidate.name === descriptiveName
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error("WorkBuddy packaged helper API is incompatible: " + descriptiveName);
  return null;
}

function descriptiveFunction(module: DynamicModule, descriptiveName: string): (...args: any[]) => any {
  const found = findDescriptiveFunction(module, descriptiveName);
  if (found) return found;
  throw new Error("WorkBuddy packaged helper API is incompatible: " + descriptiveName);
}

export function findWorkBuddyCliEnvBuilder(module: DynamicModule): ((...args: any[]) => any) | null {
  return findDescriptiveFunction(module, "buildWorkbuddyCliEnv");
}

export function workBuddyCliEnvBuilder(codeCache: DynamicModule): (...args: any[]) => any {
  return descriptiveFunction(codeCache, "buildWorkbuddyCliEnv");
}

export function workBuddyCryptoModulePaths(asarPath: string): string[] {
  return [
    path.join(asarPath, "main", "app-lifetime-job.js"),
    path.join(asarPath, "main", "process-cpu-sampler.js")
  ];
}

export interface WorkBuddyAtRestCryptoApi {
  normalize: (...args: any[]) => any;
  keyblobPathFor: (...args: any[]) => any;
  loadMaster: (...args: any[]) => any;
  encode: (...args: any[]) => any;
  dispose: (...args: any[]) => any;
}

export function resolveWorkBuddyAtRestCryptoApi(module: DynamicModule): WorkBuddyAtRestCryptoApi {
  return {
    normalize: dynamicFunction(module, "normalizeAtRestBuildKeyCapabilities", "_t", "Ge"),
    keyblobPathFor: dynamicFunction(module, "keyblobPathFor", "tt", "It"),
    loadMaster: dynamicFunction(module, "loadOrCreateKeyblobMasterKey", "nt", "Ut"),
    encode: dynamicFunction(module, "encodeAtRestEncryptionBootstrap", "Z", "Zt"),
    dispose: dynamicFunction(module, "disposeAtRestEncryptionBootstrap", "X", "tn")
  };
}

export function initializeWorkBuddyCryptoModule(module: DynamicModule): void {
  if (typeof module.init_dist === "function") {
    module.init_dist();
    return;
  }

  // WorkBuddy 5.8.4 moved the at-rest helpers into app-lifetime-job.js. That
  // module exports its rolldown lazy initializer as anonymous `D`, while `$` is
  // now an unrelated wrapChildProcess helper. Call D only after proving the
  // exact five named at-rest APIs that initializer owns are present.
  const current = module.D;
  const currentApis = [
    "normalizeAtRestBuildKeyCapabilities",
    "keyblobPathFor",
    "loadOrCreateKeyblobMasterKey",
    "encodeAtRestEncryptionBootstrap",
    "disposeAtRestEncryptionBootstrap"
  ];
  if (
    typeof current === "function" && current.name === "" && current.length === 0 &&
    currentApis.every((name) => Object.values(module).some((value) => typeof value === "function" && value.name === name))
  ) {
    current();
    return;
  }

  const legacy = module.$;
  if (
    typeof legacy === "function" &&
    (legacy.name === "init_dist" || legacy.name === "$" || legacy.name === "")
  ) legacy();
}

function credentialBootstrap(cryptoModule: DynamicModule, configDir: string): {
  bootstrap: DynamicModule;
  dispose(): void;
  encode(): JsonObject;
} {
  initializeWorkBuddyCryptoModule(cryptoModule);
  const { normalize, keyblobPathFor, loadMaster, encode, dispose } = resolveWorkBuddyAtRestCryptoApi(cryptoModule);
  const storage = nativeStorage();
  const capabilities = normalize(storage.loggerGet());
  if (capabilities?.symmetric?.status !== "available") {
    throw new Error("WorkBuddy symmetric credential material is unavailable.");
  }
  if (capabilities?.developerPublicKey?.status !== "available") {
    throw new Error("WorkBuddy developer credential material is unavailable.");
  }
  const master = loadMaster({
    keyblobPath: keyblobPathFor(configDir),
    protectorKey: capabilities.symmetric.value
  });
  if (master?.status !== "available") throw new Error("WorkBuddy keyblob master key is unavailable.");
  const bootstrap = {
    policy: "fields",
    symmetricKey: capabilities.symmetric.value,
    userKey: master.value,
    developerPublicKey: capabilities.developerPublicKey.value
  };
  return {
    bootstrap,
    dispose: () => { try { dispose(bootstrap); } catch {} },
    encode: () => encode(bootstrap) as JsonObject
  };
}

export function findWorkBuddySidecarManagerFactory(module: DynamicModule): ((opts?: DynamicModule) => DynamicModule) | null {
  const direct = module.createWorkbuddySidecarManager;
  if (typeof direct === "function") return direct;
  for (const candidate of Object.values(module)) {
    if (typeof candidate === "function" && candidate.name === "createWorkbuddySidecarManager") return candidate;
  }
  return null;
}

export function workBuddySidecarManagerModulePaths(asarPath: string): string[] {
  return [
    path.join(asarPath, "main", "sidecar-manager.js"),
    path.join(asarPath, "main", "code-cache.js")
  ];
}

export function workBuddyRecoverySidecarSpawnOptions(
  sidecarEntry: string,
  spawnArgs: unknown,
  options: unknown
): unknown {
  const argv = Array.isArray(spawnArgs) ? spawnArgs : [];
  const first = typeof argv[0] === "string" ? path.resolve(argv[0]) : "";
  return first === path.resolve(sidecarEntry) && options && typeof options === "object"
    ? { ...(options as JsonObject), stdio: ["ignore", "ignore", "ignore"] }
    : options;
}

export function workBuddyOwnerIdentityMatches(pid: number, createdAtUs: number): boolean {
  const current = captureProcessIdentity(pid);
  return !!current && current.createdAtUs === createdAtUs;
}

async function waitForWorkBuddyOwnerExit(pid: number, createdAtUs: number): Promise<void> {
  while (workBuddyOwnerIdentityMatches(pid, createdAtUs)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<boolean> {
  const args = parseArgs(process.argv.slice(2));
  process.env.CODEBUDDY_CONFIG_DIR = args.configDir;
  process.env.WORKBUDDY_CONFIG_DIR = args.configDir;
  process.env.ELECTRON_RUN_AS_NODE = "1";

  // WorkBuddy's own packaged modules own credential material and sidecar/runtime
  // environment construction. Sensitive key material stays inside this WorkBuddy
  // Electron process; stdout contains only bounded safe acknowledgements.
  let cryptoModule: DynamicModule | null = null;
  for (const modulePath of workBuddyCryptoModulePaths(args.asarPath)) {
    if (!fs.existsSync(modulePath)) continue;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cryptoModule = require(modulePath) as DynamicModule;
    break;
  }
  if (!cryptoModule) throw new Error("WorkBuddy packaged credential helper module is unavailable.");
  const credentials = credentialBootstrap(cryptoModule, args.configDir);
  let credentialsDisposed = false;
  try {
    if (args.ensureSidecar) {
      // Use WorkBuddy's OWN SidecarManager for post-reopen recovery. This preserves
      // its stale-PID verification, control-socket cleanup, spawn contract and
      // credential bootstrap rather than reimplementing those ownership rules.
      //
      // The packaged manager normally pipes sidecar stderr back into its long-lived
      // Desktop parent. This helper lives only for the exact recovered Desktop app
      // incarnation, so the exact sidecar spawn must not inherit helper stdio.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const childProcess = require("node:child_process") as DynamicModule;
      const originalSpawn = childProcess.spawn;
      const sidecarEntry = path.join(args.asarPath, "main", "sidecar-entry.js");
      childProcess.spawn = (file: unknown, spawnArgs: unknown, options: unknown): unknown => {
        const nextOptions = workBuddyRecoverySidecarSpawnOptions(sidecarEntry, spawnArgs, options);
        return Reflect.apply(originalSpawn, childProcess, [file, spawnArgs, nextOptions]);
      };
      let manager: DynamicModule | null = null;
      try {
        let factory: ((opts?: DynamicModule) => DynamicModule) | null = null;
        for (const modulePath of workBuddySidecarManagerModulePaths(args.asarPath)) {
          if (!fs.existsSync(modulePath)) continue;
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          factory = findWorkBuddySidecarManagerFactory(require(modulePath) as DynamicModule);
          if (factory) break;
        }
        if (!factory) throw new Error("WorkBuddy packaged SidecarManager API is unavailable.");
        manager = factory({ credentialProtectionBootstrap: credentials.bootstrap });
        if (typeof manager?.ensureStarted !== "function") throw new Error("WorkBuddy packaged SidecarManager cannot start.");
        await manager.ensureStarted();
        await new Promise<void>((resolve) => {
          process.stdout.write(JSON.stringify({ ok: true, policy: "fields" }) + "\n", () => resolve());
        });
      } finally {
        childProcess.spawn = originalSpawn;
      }

      // Credential material is needed only for the WorkBuddy-owned bootstrap. Zero
      // it immediately, then keep only the manager/control ownership while the exact
      // Desktop process incarnation remains alive.
      credentials.dispose();
      credentialsDisposed = true;
      await waitForWorkBuddyOwnerExit(args.appOwnerPid!, args.appOwnerCreatedAtUs!);
      try { await manager?.shutdown?.(); } catch {}
      try { manager?.client?.dispose?.(); } catch {}
      return false;
    }

    const encoded = credentials.encode();
    const ack = asObject(await request(
      args.controlEndpoint!,
      "sidecar.credentialProtection.bootstrap",
      encoded,
      15_000
    ));
    if (ack?.ok !== true || ack?.policy !== "fields") {
      throw new Error("WorkBuddy sidecar rejected credential bootstrap.");
    }

    if (args.bootstrapOnly) {
      process.stdout.write(JSON.stringify({ ok: true, policy: "fields" }) + "\n");
      return false;
    }

    let runtimeModule: DynamicModule | null = null;
    let envBuilder: ((...args: any[]) => any) | null = null;
    for (const modulePath of workBuddySidecarManagerModulePaths(args.asarPath)) {
      if (!fs.existsSync(modulePath)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const candidate = require(modulePath) as DynamicModule;
      envBuilder = findWorkBuddyCliEnvBuilder(candidate);
      if (envBuilder) {
        runtimeModule = candidate;
        break;
      }
    }
    if (!runtimeModule || !envBuilder) throw new Error("WorkBuddy packaged CLI environment builder is unavailable.");
    runtimeModule.init_workbuddy_paths?.();
    runtimeModule.init_workbuddy_product_config?.();
    const env = envBuilder(
      { ELECTRON_RUN_AS_NODE: "1" },
      undefined,
      { hostId: "workbuddy-desktop" }
    ) as NodeJS.ProcessEnv;

    const sessionId = args.sessionId!;
    const appExe = args.appExe!;
    const cliPath = args.cliPath!;
    const cwd = args.cwd!;
    const permission = args.permission!;
    const runtimeArgs = [
      cliPath,
      "--serve",
      "--setting-sources",
      "user",
      "--permission-mode",
      permission,
      ...(args.effort ? ["--effort", args.effort] : []),
      "--strict-mcp-config"
    ];

    const result = await request(args.controlEndpoint!, "session.create", {
      sessionId,
      command: appExe,
      args: runtimeArgs,
      cwd,
      env,
      port: 0,
      cols: 100,
      rows: 30
    }, 60_000);

    const session = asObject(result);
    if (!session) throw new Error("WorkBuddy sidecar returned an invalid session.");
    const safe = {
      sessionId: typeof session.sessionId === "string" ? session.sessionId : null,
      acpEndpoint: typeof session.acpEndpoint === "string" ? session.acpEndpoint : null,
      runtimeId: typeof session.runtimeId === "string" ? session.runtimeId : null,
      pid: typeof session.pid === "number" ? session.pid : null
    };
    process.stdout.write(JSON.stringify(safe) + "\n");
    return false;
  } finally {
    if (!credentialsDisposed) credentials.dispose();
  }
}

if (require.main === module) {
  main().then((forceExit) => {
    if (forceExit) setImmediate(() => process.exit(0));
  }).catch((error) => {
    process.stderr.write(String((error as Error)?.message || error).slice(0, 1000) + "\n");
    process.exitCode = 2;
  });
}
