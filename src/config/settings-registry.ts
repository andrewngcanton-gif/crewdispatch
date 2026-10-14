// settings-registry.ts — the ONE place that binds the shared settings read path
// to the first-release providers.
//
// The always-fresh read orchestration is provider-neutral
// (src/config/settings-reads.ts); everything provider-specific (how a view is
// read, how a snake_case patch is persisted) stays in the provider config
// layers. Adding a provider means adding one definition here — no second
// settings read/cache implementation, no provider-specific Settings flow.
import { configPatchFromSnake, configView, updateConfig } from "./schema";
import { readSettings, readSettingsCapabilities, type SettingsView } from "./settings";
import {
  readWorkBuddyAiSettings,
  updateWorkBuddyAiConfig,
  workBuddyAiConfigPatchFromSnake,
  workBuddyAiConfigView,
  type WorkBuddyAiSettingsView
} from "./workbuddy-ai";
import {
  ProviderSettingsReads,
  workerSettingsProbe,
  type SettingsProviderDefinition
} from "./settings-reads";

export const COMMAND_CODE_SETTINGS_ID = "command-code";
export const WORKBUDDY_AI_SETTINGS_ID = "workbuddy-ai";

/** The provider settings definitions used by the Hub (and the probe worker). */
export function defaultSettingsProviders(): SettingsProviderDefinition<any>[] {
  const commandCode: SettingsProviderDefinition<SettingsView> = {
    id: COMMAND_CODE_SETTINGS_ID,
    // `phase` lets the Hub UI ask for the process-free catalog phase (prompt
    // model list + Free-now) while MCP/embedding keep the complete `full` read.
    read: (root, env, phase) => readSettings(root, { env, phase: phase ?? "full" }),
    // The capability phase is the ONLY part that spawns the CLI; it is served
    // as a separate later read so it can never gate the first form render. The
    // config layer names its result a `patch` (it is applied to an already
    // rendered view); the shared read path speaks in `view`s, so adapt here.
    readCapabilities: async (root, env) => {
      const result = await readSettingsCapabilities(root, { env });
      return result.ok ? { ok: true, view: result.patch } : result;
    },
    applyPatch: (root, patch) => configView(updateConfig(root, configPatchFromSnake(patch)).config)
  };
  const workBuddyAi: SettingsProviderDefinition<WorkBuddyAiSettingsView> = {
    id: WORKBUDDY_AI_SETTINGS_ID,
    read: (root, env) => readWorkBuddyAiSettings(root, { env }),
    applyPatch: (root, patch) =>
      workBuddyAiConfigView(updateWorkBuddyAiConfig(root, workBuddyAiConfigPatchFromSnake(patch)).config)
  };
  return [commandCode, workBuddyAi];
}

let sharedReads: ProviderSettingsReads | null = null;

/**
 * The process-wide read path used by the Hub. Probes run through the
 * worker-backed runner so the synchronous provider probes never block the
 * event loop.
 */
export function getDefaultSettingsReads(): ProviderSettingsReads {
  if (!sharedReads) {
    sharedReads = new ProviderSettingsReads(defaultSettingsProviders(), { probe: workerSettingsProbe });
  }
  return sharedReads;
}

/** Test seam: drop the process-wide read instance. */
export function resetDefaultSettingsReadsForTests(): void {
  sharedReads = null;
}
