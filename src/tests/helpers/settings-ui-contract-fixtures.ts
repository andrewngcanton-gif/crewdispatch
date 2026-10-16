// settings-ui-contract-fixtures.ts — executable provider adapters for the
// universal Settings UI contract. This map is intentionally typed by the
// production provider-id union: adding a registered provider without adding a
// real browser fixture makes TypeScript fail before CI can pretend coverage.
import type { DefaultSettingsProviderId } from "../../config/settings-registry";
import { commandCodeSettingsView, workBuddyAiSettingsView } from "./settings-fixtures";

export interface SettingsUiContractBrowserFixture {
  readonly providerId: DefaultSettingsProviderId;
  readonly label: string;
  readonly infoId: string;
  readonly modelSelectId: string;
  readonly permissionSelectId: string;
  readonly permissionNoteId: string;
  readonly saveButtonId: string;
  readonly messageId: string;
  readonly defaultEffortId?: string;
  readonly fallbackEffortId?: string;
  readonly alternatePermissionMode: string;
  readonly recommendedPermissionMode: string | null;
  readonly reasoning?: {
    readonly primaryModel: string;
    readonly secondaryModel: string;
    readonly primaryOnlyEffort: string;
    readonly secondaryEfforts: readonly string[];
  };
  buildView(config: Record<string, unknown>, revision: number, capabilityPending: boolean): any;
  buildCapabilityPatch?(config: Record<string, unknown>): any;
}

const COMMAND_MODELS = ["cc/contract-a", "cc/contract-b"];
const WORKBUDDY_MODELS = ["deepseek-v4.1-flash", "hy3"];

export const SETTINGS_UI_CONTRACT_PROVIDER_FIXTURES = {
  "command-code": {
    providerId: "command-code",
    label: "Command Code",
    infoId: "cliInfo",
    modelSelectId: "defaultModel",
    permissionSelectId: "permissionMode",
    permissionNoteId: "yoloWarning",
    saveButtonId: "saveSettings",
    messageId: "settingsMessage",
    defaultEffortId: "defaultEffort",
    fallbackEffortId: "fallbackEffort",
    alternatePermissionMode: "plan",
    recommendedPermissionMode: "yolo",
    reasoning: {
      primaryModel: COMMAND_MODELS[0]!,
      secondaryModel: COMMAND_MODELS[1]!,
      primaryOnlyEffort: "max",
      secondaryEfforts: ["low", "medium", "xhigh"]
    },
    buildView(config, revision, capabilityPending) {
      const freeId = revision % 2 === 1 ? COMMAND_MODELS[1]! : COMMAND_MODELS[0]!;
      const view = commandCodeSettingsView({
        models: COMMAND_MODELS,
        freeModels: [freeId],
        extraMeta: {
          [COMMAND_MODELS[0]!]: { free: freeId === COMMAND_MODELS[0], efforts: ["low", "high", "max"] },
          [COMMAND_MODELS[1]!]: { free: freeId === COMMAND_MODELS[1], efforts: ["low", "medium", "xhigh"] }
        }
      });
      view.config.default_effort = "max";
      Object.assign(view.config, config);
      if (capabilityPending) {
        view.capabilities = { supports_effort: false, permission_modes: [], checked: false };
      }
      return view;
    },
    buildCapabilityPatch() {
      return {
        cli: { available: true, version: "9.9.9-contract", error: null, checked: true },
        capabilities: { supports_effort: true, permission_modes: ["plan", "accept-edits", "yolo"], checked: true },
        catalog: null,
        model_meta: null,
        observed_default_model: COMMAND_MODELS[0]!
      };
    }
  },
  "workbuddy-ai": {
    providerId: "workbuddy-ai",
    label: "WorkBuddy AI",
    infoId: "wbCliInfo",
    modelSelectId: "wbDefaultModel",
    permissionSelectId: "wbPermissionMode",
    permissionNoteId: "wbYoloWarning",
    saveButtonId: "wbSaveSettings",
    messageId: "wbSettingsMessage",
    defaultEffortId: "wbDefaultEffort",
    fallbackEffortId: "wbFallbackEffort",
    alternatePermissionMode: "plan",
    recommendedPermissionMode: "full-access",
    reasoning: {
      primaryModel: WORKBUDDY_MODELS[0]!,
      secondaryModel: WORKBUDDY_MODELS[1]!,
      primaryOnlyEffort: "max",
      secondaryEfforts: ["low", "medium", "xhigh"]
    },
    buildView(config, revision) {
      const freeId = revision % 2 === 1 ? WORKBUDDY_MODELS[0]! : WORKBUDDY_MODELS[1]!;
      const view = workBuddyAiSettingsView({
        models: WORKBUDDY_MODELS,
        offeredModels: WORKBUDDY_MODELS,
        effort: "max",
        meta: {
          [WORKBUDDY_MODELS[0]!]: {
            label: "DeepSeek V4.1 Flash",
            credits: WORKBUDDY_MODELS[0] === freeId ? "x0" : "x1",
            free: WORKBUDDY_MODELS[0] === freeId,
            reasoning: { app_default_effort: "high", supported_efforts: ["low", "high", "max"], supported_efforts_source: "official-app" }
          },
          [WORKBUDDY_MODELS[1]!]: {
            label: "HY3",
            credits: WORKBUDDY_MODELS[1] === freeId ? "x0" : "x1",
            free: WORKBUDDY_MODELS[1] === freeId,
            reasoning: { app_default_effort: "medium", supported_efforts: ["low", "medium", "xhigh"], supported_efforts_source: "official-app" }
          }
        }
      });
      Object.assign(view.config, config);
      view.capabilities.permission_modes = ["default", "plan", "accept-edits", "yolo", "dont-ask", "auto", "full-access"];
      return view;
    }
  }
} satisfies Record<DefaultSettingsProviderId, SettingsUiContractBrowserFixture>;
