import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REQUIRED_NODE_MAJOR = 22;

export interface UserNodeRuntime {
  path: string;
  version: string;
  major: number;
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = [env.PATH, env.Path, env.path].find((value) => typeof value === "string") ?? "";
  const delimiter = platform === "win32" ? path.win32.delimiter : path.posix.delimiter;
  return raw.split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function candidateNodePaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const executable = platform === "win32" ? "node.exe" : "node";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathEntries(env, platform).map((dir) => pathApi.resolve(dir, executable));
}

function usableNodeFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeNodeRuntimePath(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): UserNodeRuntime | null {
  const candidate = (platform === "win32" ? path.win32 : path.posix).resolve(file);
  if (!usableNodeFile(candidate, platform)) return null;
  const probe = spawnSync(candidate, ["-p", "process.versions.node"], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000
  });
  if (probe.error || probe.status !== 0) return null;
  const version = String(probe.stdout || "").trim();
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) ? { path: candidate, version, major } : null;
}

export function resolveUserNodeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): UserNodeRuntime | null {
  for (const candidate of candidateNodePaths(env, platform)) {
    const runtime = probeNodeRuntimePath(candidate, env, platform);
    if (runtime) return runtime;
  }
  return null;
}
