// index.ts — the Command Code provider implementation of the minimal contract.
//
// TRANSPORT (Command Code ACP migration): a real run no longer launches
// `cmdc -p ...` directly. The provider entry launches the CrewDispatch-owned
// ACP bridge (src/providers/command-code/acp-bridge.ts) as the child process;
// the bridge speaks the official CLI's own ACP protocol over stdio and
// translates the real protocol evidence into the SAME canonical NDJSON stream
// this module has always parsed. The shared runner therefore still writes the
// task to the child's stdin and reads canonical records from its stdout, and
// the exit classification stays the official CLI's own table.
//
// The print-mode argv is still built and validated (model / permission mode /
// effort / resume token legality, the model-specific effort gate), because the
// bridge needs exactly those validated values; it is never spawned as `-p`.
//
// M1 batch 1 scope: discovery, public capability probe, model catalog, run plan,
// NDJSON parsing and exit classification. No job service, no MCP, no Hub, no
// installer or distribution logic lives here.
import path from "node:path";
import type {
  CapabilityProbeResult,
  CliResolveInput,
  CliResolution,
  ExitClassification,
  ModelCatalogResult,
  ProviderAdapter,
  RunPlanInput,
  RunPlanResult,
  StreamState,
  UsageSnapshot
} from "../provider";
import { COMMAND_CODE_DISPLAY_NAME, COMMAND_CODE_PROVIDER } from "./capability";
import { resolveCommandCodeCli } from "./discovery";
import { buildCommandCodeArgv } from "./argv";
import { createCommandCodeState, normalizeUsage, parseCommandCodeRecord, type CommandCodeStreamState } from "./stream";
import { classifyCommandCodeExit } from "./exit";
import { applyApprovalStreamLine } from "../../jobs/approval-channel";
import { buildCcAcpBridgeArgv } from "./acp-bridge";
import { probeCapabilities as probeCapabilitiesSync, readModelCatalog as readModelCatalogSync } from "./probe";

export * from "./capability";
export * from "./discovery";
export * from "./argv";
export * from "./spawn-plan";
export * from "./stream";
export * from "./exit";
export * from "./catalog";
export * from "./local-catalog";
export * from "./probe";
export * from "./acp-wire";
export * from "./acp-normalizer";

export function createCommandCodeAdapter(): ProviderAdapter {
  return {
    id: COMMAND_CODE_PROVIDER,
    displayName: COMMAND_CODE_DISPLAY_NAME,

    resolveCli(input: CliResolveInput): CliResolution {
      return resolveCommandCodeCli(input);
    },

    async probeCapabilities(input): Promise<CapabilityProbeResult> {
      return probeCapabilitiesSync(input);
    },

    async readModelCatalog(input): Promise<ModelCatalogResult> {
      return readModelCatalogSync(input);
    },

    buildRunPlan(input: RunPlanInput): RunPlanResult {
      // The accepted argv validation stays authoritative for the values the
      // bridge receives: model token grammar, the installed CLI's published
      // permission modes, `--effort` support + the model-specific effort gate,
      // and the resume session token.
      const built = buildCommandCodeArgv({
        model: input.model,
        permissionMode: input.permissionMode,
        publishedPermissionModes: input.publishedPermissionModes ?? null,
        resumeSessionId: input.resumeSessionId ?? null,
        effort: input.effort ?? null,
        effortSupported: input.effortSupported,
        supportedEfforts: input.supportedEfforts ?? null
      });
      if (!built.ok) return { ok: false, stage: "argv", error: built.error };

      // Read the VALIDATED values back out of the built argv (the same
      // technique the WorkBuddy AI adapter uses for its bridge): the bridge
      // must never receive an unvalidated token.
      const valueOf = (flag: string): string | null => {
        const index = built.argv.indexOf(flag);
        return index >= 0 ? built.argv[index + 1] ?? null : null;
      };
      const model = valueOf("--model");
      const permissionMode = valueOf("--permission-mode");
      if (!model || !permissionMode) {
        return { ok: false, stage: "argv", error: "The Command Code run plan could not resolve its validated model/permission mode." };
      }

      // The bridge is a Node script launched with THIS runtime; the official
      // CLI is then spawned by the bridge through the same shell-free
      // Windows-safe spawn plan (see acp-client.ts).
      const bridgePath = path.join(__dirname, "acp-bridge.js");
      const bridgeArgv = buildCcAcpBridgeArgv({
        cliPath: input.cliPath,
        model,
        permissionMode,
        effort: valueOf("--effort"),
        resumeSessionId: valueOf("--resume"),
        // Proven model-default provenance (the worker proved this job never
        // selected an explicit effort for this model on the resumed session).
        effortDefaultProven: input.effortDefaultProven === true,
        attempt: input.attempt ?? null
      });
      return {
        ok: true,
        argv: bridgeArgv,
        plan: {
          file: process.execPath,
          args: [bridgePath, ...bridgeArgv],
          windowsVerbatimArguments: false,
          shellShim: null
        }
      };
    },

    createStreamState(): StreamState {
      return createCommandCodeState();
    },

    parseStreamLine(line: string, state: StreamState, observedAtMs?: number): StreamState {
      // An interactive-approval record is bridge transport state, not part of
      // the shared event/terminal grammar: consume it here so the shared parser
      // never counts it as an unknown line.
      if (applyApprovalStreamLine(line, state)) return state;
      return parseCommandCodeRecord(line, state as CommandCodeStreamState, observedAtMs);
    },

    normalizeUsage(state: StreamState): UsageSnapshot {
      return normalizeUsage(state as CommandCodeStreamState);
    },

    classifyExit(code: unknown): ExitClassification {
      return classifyCommandCodeExit(code);
    }
  };
}
