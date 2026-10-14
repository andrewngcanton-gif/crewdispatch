import type { JobRecord, NotifyTarget, RunnerKind } from "../jobs/types";

export const DAEMON_PROTOCOL_VERSION = 1;
export const DAEMON_META_VERSION = 1;

export interface DaemonMeta {
  version: number;
  pid: number;
  /** Exact process birth on Darwin when the OS proved it; additive for legacy metadata. */
  startedAtUs?: number | null;
  /** Launch process-group/session facts (diagnostic + identity verification). */
  pgid?: number | null;
  sid?: number | null;
  port: number;
  token: string;
  startedAt: string;
  heartbeatAt: string;
  serverPath: string;
}

export interface DaemonStartPayload {
  task: string;
  cwd: string;
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  provider?: string;
  runner?: RunnerKind;
  fixturePath?: string | null;
  cliPath?: string | null;
  workerScript?: string;
  env?: NodeJS.ProcessEnv;
  notifyTarget?: NotifyTarget;
}

export interface DaemonContinuePayload {
  jobId: string;
  task: string;
  fixturePath?: string | null;
  cliPath?: string | null;
  workerScript?: string;
  env?: NodeJS.ProcessEnv;
  notifyTarget?: NotifyTarget;
}

/**
 * Ask the broker for ONE bounded notification-recovery pass on behalf of a
 * verified local caller registration. Opaque references ONLY — the session id
 * and binding id of the registration the caller just wrote; the native inbox
 * address and token stay in the private binding store and are never sent here.
 */
export interface DaemonRecoverPayload {
  sessionId: string;
  bindingId: string;
}

export type DaemonOperation = "ping" | "start" | "continue" | "shutdown" | "recover";

export type DaemonRequest =
  | { version: 1; token: string; id: string; op: "ping"; payload?: null }
  | { version: 1; token: string; id: string; op: "start"; payload: DaemonStartPayload }
  | { version: 1; token: string; id: string; op: "continue"; payload: DaemonContinuePayload }
  | { version: 1; token: string; id: string; op: "recover"; payload: DaemonRecoverPayload }
  | { version: 1; token: string; id: string; op: "shutdown"; payload?: null };

export type DaemonResponse =
  | {
      version: 1;
      id: string;
      ok: true;
      op: DaemonOperation;
      result:
        | { pong: true; pid: number }
        | { job: JobRecord; workerPid: number | null }
        | { accepted: true }
        | { stopped: true };
    }
  | {
      version: 1;
      id: string;
      ok: false;
      op: DaemonOperation | "unknown";
      code: string;
      message: string;
    };
