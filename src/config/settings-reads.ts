// settings-reads.ts — the ONE provider-neutral settings READ path shared by
// every provider.
//
// A provider settings read spawns the user's CLI (`--version` / `--help` /
// `--list-models` or WorkBuddy's own catalog paths) and can take seconds, so
// the synchronous probes run in a short-lived worker (settings-probe-worker.ts)
// and the Hub event loop stays responsive.
//
// The read contract is deliberately simple and always FRESH:
//   * every Settings open / provider switch / post-save refresh performs a real
//     provider read; no cached view is ever served on the normal path, and Hub
//     startup never probes a provider;
//   * concurrent identical reads (same provider + data root) join ONE
//     in-flight probe instead of spawning duplicate CLI/catalog probes;
//   * `billing_verified` is true only for a response produced by a real probe,
//     so stale evidence can never drive Free-now/billing presentation;
//   * a settings save invalidates the provider/root entry: a probe that started
//     before the save is detached and can be neither joined nor reused by a
//     later read, so post-save state always comes from a post-save read.
//
// Provider-specific parsing/metadata stays in the provider config layers
// (src/config/settings.ts, src/config/workbuddy-ai.ts); this module only
// orchestrates read/dedupe/patch through the small definition contract.
import { Worker } from "node:worker_threads";
import path from "node:path";

/** One provider settings read outcome (structurally the config-layer result). */
export type SettingsProbeResult<TView = unknown> =
  | { ok: true; view: TView }
  | { ok: false; code: string; message: string; field: string | null; raw: string | null };

/**
 * Which evidence phase a read performs. `"catalog"` is the process-free part
 * (config + installed-package catalog) and returns promptly; `"full"` is the
 * complete read including the CLI capability probe. Providers that do not
 * split their read simply ignore the phase.
 */
export type SettingsReadPhase = "catalog" | "full";

/**
 * Everything the shared read path needs from one provider. `read` and
 * `applyPatch` are implemented in the provider config layer; this module never
 * knows a provider id beyond the map key.
 */
export interface SettingsProviderDefinition<TView = unknown> {
  readonly id: string;
  read(root: string, env: NodeJS.ProcessEnv, phase?: SettingsReadPhase): Promise<SettingsProbeResult<TView>>;
  /**
   * OPTIONAL second phase: everything that needs the provider's CLI process and
   * therefore must not gate the first form render. A provider that defines it
   * gets a `<route>/capabilities` read served from the same always-fresh,
   * in-flight-deduped, save-invalidated path; a provider that does not is
   * reported as having no separate capability phase.
   */
  readCapabilities?(root: string, env: NodeJS.ProcessEnv): Promise<SettingsProbeResult<unknown>>;
  /** Persist a snake_case patch and return the updated snake_case config view. */
  applyPatch(root: string, patch: Record<string, unknown>): unknown;
}

/**
 * Freshness provenance that travels with every envelope response. The client
 * must never infer freshness from `catalog.refreshed_at` (or from any other
 * payload field): only `billing_verified` is authoritative, and it is true
 * only when THIS response was produced by a real probe.
 */
export interface SettingsFreshness {
  provider: string;
  source: "probe";
  /** When the served view was verified by the real probe (null on failure). */
  verified_at: string | null;
  /** True ONLY for freshly probed evidence — gates Free-now labels and ordering. */
  billing_verified: boolean;
}

export interface SettingsFreshRead<TView = unknown> {
  result: SettingsProbeResult<TView>;
  freshness: SettingsFreshness;
}

/**
 * The phase a probe runner is asked to execute: either a `read` phase or the
 * provider's separate `readCapabilities` phase.
 */
export type SettingsProbePhase = SettingsReadPhase | "capabilities";

/** A probe runner executes one provider read (worker-backed in production). */
export type SettingsProbeRunner = (
  definition: SettingsProviderDefinition<any>,
  root: string,
  env: NodeJS.ProcessEnv,
  phase: SettingsProbePhase
) => Promise<SettingsProbeResult<unknown>>;

/** Run one probe phase in-process (the direct/fallback path). */
function runProbePhase(
  definition: SettingsProviderDefinition<any>,
  root: string,
  env: NodeJS.ProcessEnv,
  phase: SettingsProbePhase
): Promise<SettingsProbeResult<unknown>> {
  if (phase === "capabilities") {
    if (!definition.readCapabilities) {
      return Promise.resolve({ ok: false, code: "capabilities_unsupported", message: `Provider ${definition.id} publishes no separate capability phase.`, field: null, raw: null });
    }
    return definition.readCapabilities(root, env);
  }
  return definition.read(root, env, phase);
}

interface ReadEntry {
  inflight: Promise<SettingsProbeResult<unknown>> | null;
  inflightToken: symbol | null;
}

export interface ProviderSettingsReadsOptions {
  now?: () => number;
  /**
   * Probe runner. Production passes a worker-backed runner so the synchronous
   * provider probes never block the Hub event loop; tests may omit it to run
   * the definition's read directly.
   */
  probe?: SettingsProbeRunner;
}

export class ProviderSettingsReads {
  private readonly definitions = new Map<string, SettingsProviderDefinition<any>>();
  private readonly entries = new Map<string, ReadEntry>();
  private readonly nowFn: () => number;
  private readonly probeRunner: SettingsProbeRunner | null;

  constructor(providers: readonly SettingsProviderDefinition<any>[], options: ProviderSettingsReadsOptions = {}) {
    for (const provider of providers) this.definitions.set(provider.id, provider);
    this.nowFn = options.now ?? (() => Date.now());
    this.probeRunner = options.probe ?? null;
  }

  definition(providerId: string): SettingsProviderDefinition<any> {
    const definition = this.definitions.get(providerId);
    if (!definition) throw new Error(`Unknown settings provider: ${providerId}`);
    return definition;
  }

  /**
   * Always-fresh read. Concurrent callers for the same provider/root/phase JOIN
   * one in-flight probe instead of launching duplicate CLI/catalog probes; a
   * call with no probe in flight always starts a new one — no result is ever
   * replayed from an earlier read.
   */
  async readFresh<TView = unknown>(
    providerId: string,
    root: string,
    env: NodeJS.ProcessEnv,
    phase: SettingsReadPhase = "full"
  ): Promise<SettingsFreshRead<TView>> {
    const definition = this.definition(providerId);
    const entry = this.entry(providerId, root, phase);
    if (!entry.inflight) {
      const token = Symbol("settings-probe");
      entry.inflightToken = token;
      const clear = (): void => {
        if (entry.inflightToken === token) {
          entry.inflight = null;
          entry.inflightToken = null;
        }
      };
      const runner = this.probeRunner ?? runProbePhase;
      entry.inflight = runner(definition, root, env, phase).then(
        (result) => {
          clear();
          return result;
        },
        (error: unknown) => {
          clear();
          throw error;
        }
      );
    }
    const result = (await entry.inflight) as SettingsProbeResult<TView>;
    return {
      result,
      freshness: {
        provider: providerId,
        source: "probe",
        verified_at: result.ok ? new Date(this.nowFn()).toISOString() : null,
        billing_verified: result.ok
      }
    };
  }

  /**
   * The OPTIONAL capability phase, served from the same always-fresh,
   * in-flight-deduped, save-invalidated path. Returns null when the provider
   * publishes no separate capability phase.
   */
  async readCapabilitiesFresh<TView = unknown>(
    providerId: string,
    root: string,
    env: NodeJS.ProcessEnv
  ): Promise<SettingsFreshRead<TView> | null> {
    const definition = this.definition(providerId);
    if (!definition.readCapabilities) return null;
    const entry = this.entry(providerId, root, "capabilities");
    if (!entry.inflight) {
      const token = Symbol("settings-capabilities");
      entry.inflightToken = token;
      const clear = (): void => {
        if (entry.inflightToken === token) {
          entry.inflight = null;
          entry.inflightToken = null;
        }
      };
      const runner = this.probeRunner ?? runProbePhase;
      entry.inflight = runner(definition, root, env, "capabilities").then(
        (result) => {
          clear();
          return result;
        },
        (error: unknown) => {
          clear();
          throw error;
        }
      );
    }
    const result = (await entry.inflight) as SettingsProbeResult<TView>;
    return {
      result,
      freshness: {
        provider: providerId,
        source: "probe",
        verified_at: result.ok ? new Date(this.nowFn()).toISOString() : null,
        billing_verified: result.ok
      }
    };
  }

  /**
   * Drop the provider/root read state (a settings save changed the
   * configuration). EVERY phase is dropped: a save can change the CLI path, so
   * pre-save capability evidence is as stale as a pre-save catalog. Any probe
   * started before the invalidation is detached: its result belongs to the
   * pre-save state and is never joined by the next read.
   */
  invalidate(providerId: string, root: string): void {
    const prefix = `${root}\u0000${providerId}\u0000`;
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      entry.inflight = null;
      entry.inflightToken = null;
    }
  }

  /** True while a real probe is in flight for this provider/root (diagnostics/tests). */
  inflight(providerId: string, root: string): boolean {
    const prefix = `${root}\u0000${providerId}\u0000`;
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && entry.inflight != null) return true;
    }
    return false;
  }

  private key(providerId: string, root: string, phase: SettingsProbePhase): string {
    return `${root}\u0000${providerId}\u0000${phase}`;
  }

  private entry(providerId: string, root: string, phase: SettingsProbePhase): ReadEntry {
    const key = this.key(providerId, root, phase);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { inflight: null, inflightToken: null };
      this.entries.set(key, entry);
    }
    return entry;
  }
}


// ---------------------------------------------------------------------------
// Worker-backed probe runner
// ---------------------------------------------------------------------------
//
// The provider probes call `spawnSync` internally, so running them on the Hub's
// main thread would block every other request (including the listen callback).
// One short-lived worker per probe keeps the Hub responsive and lets genuinely
// concurrent settings requests dedupe onto a single underlying probe.

const PROBE_WORKER_SCRIPT = path.join(__dirname, "settings-probe-worker.js");
const PROBE_WORKER_TIMEOUT_MS = 120_000;

type ProbeWorkerMessage =
  | { kind: "result"; result: SettingsProbeResult<unknown> }
  | { kind: "error"; message: string };

/** The worker infrastructure itself failed (spawn/exit/timeout) — not the probe. */
export class SettingsProbeWorkerUnavailableError extends Error {}

export const workerSettingsProbe: SettingsProbeRunner = async (definition, root, env, phase) => {
  try {
    return await runProbeInWorker(definition.id, root, env, phase);
  } catch (error) {
    if (!(error instanceof SettingsProbeWorkerUnavailableError)) throw error;
    // Unexpected in a built artifact (the worker ships next to this module):
    // probe in-process so a settings read never becomes impossible.
    console.error(`[jobquay-hub] settings probe worker unavailable (${error.message}); probing ${definition.id} in-process`);
    return runProbePhase(definition, root, env, phase);
  }
};

function runProbeInWorker(
  providerId: string,
  root: string,
  env: NodeJS.ProcessEnv,
  phase: SettingsProbePhase
): Promise<SettingsProbeResult<unknown>> {
  return new Promise<ProbeWorkerMessage>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(PROBE_WORKER_SCRIPT, { workerData: { providerId, root, env, phase } });
    } catch (error) {
      reject(new SettingsProbeWorkerUnavailableError(String((error as Error)?.message || error)));
      return;
    }
    worker.unref();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new SettingsProbeWorkerUnavailableError(`settings probe worker timed out after ${PROBE_WORKER_TIMEOUT_MS}ms`));
    }, PROBE_WORKER_TIMEOUT_MS);
    timer.unref?.();
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    worker.once("message", (message: ProbeWorkerMessage) => {
      finish(() => {
        if (message && message.kind === "result") resolve(message);
        else reject(new Error(message && message.kind === "error" ? message.message : "settings probe worker returned an invalid message"));
      });
    });
    worker.once("error", (error) => {
      finish(() => reject(new SettingsProbeWorkerUnavailableError(String((error as Error)?.message || error))));
    });
    worker.once("exit", (code) => {
      finish(() => reject(new SettingsProbeWorkerUnavailableError(`settings probe worker exited without a result (code ${code})`)));
    });
  }).then((message) => {
    if (message.kind === "error") throw new Error(message.message);
    return message.result;
  });
}
