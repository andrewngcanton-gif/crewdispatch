// settings-probe-worker.ts — runs ONE provider settings probe off the Hub's
// event loop.
//
// The provider probes are synchronous child-process calls (`spawnSync`), so the
// Hub must never execute them on its main thread: doing so would block every
// other request, including the listen callback and job polling. Each probe gets
// a short-lived worker; the worker resolves the provider definition from the
// SAME registry the Hub uses, so there is exactly one probe implementation.
import { parentPort, workerData } from "node:worker_threads";
import { defaultSettingsProviders } from "./settings-registry";
import type { SettingsProbePhase, SettingsProbeResult } from "./settings-reads";

interface ProbeWorkerInput {
  providerId: string;
  root: string;
  env: NodeJS.ProcessEnv;
  /** Which phase of the provider read to execute (default `"full"`). */
  phase?: SettingsProbePhase;
}

type ProbeWorkerMessage =
  | { kind: "result"; result: SettingsProbeResult<unknown> }
  | { kind: "error"; message: string };

async function run(): Promise<void> {
  const input = workerData as ProbeWorkerInput;
  let message: ProbeWorkerMessage;
  try {
    const definition = defaultSettingsProviders().find((provider) => provider.id === input.providerId);
    const phase = input.phase ?? "full";
    if (!definition) {
      message = { kind: "error", message: `Unknown settings provider: ${input.providerId}` };
    } else if (phase === "capabilities") {
      if (!definition.readCapabilities) {
        message = { kind: "error", message: `Provider ${input.providerId} publishes no separate capability phase.` };
      } else {
        message = { kind: "result", result: await definition.readCapabilities(input.root, input.env) };
      }
    } else {
      message = { kind: "result", result: await definition.read(input.root, input.env, phase) };
    }
  } catch (error) {
    message = { kind: "error", message: String((error as Error)?.message || error) };
  }
  parentPort?.postMessage(message);
}

void run();
