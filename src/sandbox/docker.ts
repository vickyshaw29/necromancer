import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runSandboxCommand } from "./command.js";

export const DOCKER_IMAGE = "node:20-slim";

function safePath(): string {
  return process.env.PATH ?? process.env.Path ?? "";
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await runSandboxCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Keep Docker client credentials and unrelated host environment out of sandbox commands. */
export async function dockerClientEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const dockerConfig = path.join(root, ".docker-config");
  await mkdir(dockerConfig, { recursive: true });
  await writeFile(path.join(dockerConfig, "config.json"), `${JSON.stringify({ auths: {} })}\n`, "utf8");

  const inheritedHost = process.env.DOCKER_HOST;
  if (inheritedHost) return { PATH: safePath(), DOCKER_CONFIG: dockerConfig, DOCKER_HOST: inheritedHost };
  return { PATH: safePath(), DOCKER_CONFIG: dockerConfig };
}

export function dockerUserArgs(): string[] {
  if (process.platform === "win32" || !process.getuid || !process.getgid) return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

export function dockerMount(hostPath: string, containerPath: string, readOnly = false): string {
  return `${path.resolve(hostPath)}:${containerPath}${readOnly ? ":ro" : ""}`;
}

/** Resource and privilege boundaries shared by package and candidate execution containers. */
export function dockerSafetyArgs(): string[] {
  return [
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "512m",
    "--memory-swap",
    "512m",
    "--cpus",
    "1",
    "--ulimit",
    "nofile=256:256",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,mode=1777"
  ];
}
