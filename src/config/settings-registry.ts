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

/**
 * The feature profile that tells the shared Settings contract which OPTIONAL
 * provider capabilities must receive extra coverage. The core loading/refresh/
 * save/stale-response rules are mandatory for every registered provider and
 * therefore are not opt-out booleans here.
 */
export interface SettingsUiContractProfile {
  readonly readStrategy: "single-phase" | "catalog-capabilities";
  readonly modelSpecificReasoning: boolean;
  readonly billingPromotions: boolean;
  readonly recommendedPermissionMode: string | null;
}

/** A production-registered provider must declare its Settings UI contract profile. */
export interface RegisteredSettingsProviderDefinition<TView = unknown> extends SettingsProviderDefinition<TView> {
  readonly uiContract: SettingsUiContractProfile;
}

/**
 * The ONE production provider registry. Its literal keys become the registered
 * provider-id union used by contract fixtures/tests. Adding an active provider
 * here therefore expands that union and makes missing contract coverage a
 * compile/test failure instead of an easy-to-forget checklist item.
 */
const DEFAULT_SETTINGS_PROVIDER_DEFINITIONS = {
  [COMMAND_CODE_SETTINGS_ID]: {
    id: COMMAND_CODE_SETTINGS_ID,
    uiContract: {
      readStrategy: "catalog-capabilities",
      modelSpecificReasoning: true,
      billingPromotions: true,
      recommendedPermissionMode: "yolo"
    },
    // `phase` lets the Hub UI ask for the process-free catalog phase (prompt
    // model list + Free-now) while MCP/embedding keep the complete `full` read.
    read: (root: string, env: NodeJS.ProcessEnv, phase?: "catalog" | "full") => readSettings(root, { env, phase: phase ?? "full" }),
    // The capability phase is the ONLY part that spawns the CLI; it is served
    // as a separate later read so it can never gate the first form render. The
    // config layer names its result a `patch` (it is applied to an already
    // rendered view); the shared read path speaks in `view`s, so adapt here.
    readCapabilities: async (root: string, env: NodeJS.ProcessEnv) => {
      const result = await readSettingsCapabilities(root, { env });
      return result.ok ? { ok: true, view: result.patch } : result;
    },
    applyPatch: (root: string, patch: Record<string, unknown>) => configView(updateConfig(root, configPatchFromSnake(patch)).config)
  } satisfies RegisteredSettingsProviderDefinition<SettingsView>,
  [WORKBUDDY_AI_SETTINGS_ID]: {
    id: WORKBUDDY_AI_SETTINGS_ID,
    uiContract: {
      readStrategy: "single-phase",
      modelSpecificReasoning: true,
      billingPromotions: true,
      recommendedPermissionMode: "full-access"
    },
    read: (root: string, env: NodeJS.ProcessEnv) => readWorkBuddyAiSettings(root, { env }),
    applyPatch: (root: string, patch: Record<string, unknown>) =>
      workBuddyAiConfigView(updateWorkBuddyAiConfig(root, workBuddyAiConfigPatchFromSnake(patch)).config)
  } satisfies RegisteredSettingsProviderDefinition<WorkBuddyAiSettingsView>
} as const;

export type DefaultSettingsProviderId = keyof typeof DEFAULT_SETTINGS_PROVIDER_DEFINITIONS;

/** Stable provider order used by the Hub and contract coverage. */
export const DEFAULT_SETTINGS_PROVIDER_IDS: readonly DefaultSettingsProviderId[] = Object.freeze(
  Object.keys(DEFAULT_SETTINGS_PROVIDER_DEFINITIONS) as DefaultSettingsProviderId[]
);

/** The provider settings definitions used by the Hub (and the probe worker). */
export function defaultSettingsProviders(): RegisteredSettingsProviderDefinition<any>[] {
  return DEFAULT_SETTINGS_PROVIDER_IDS.map((id) => DEFAULT_SETTINGS_PROVIDER_DEFINITIONS[id]);
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
