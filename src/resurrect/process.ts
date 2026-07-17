import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_LOG_CHARS = 8_000;

function append(current: string, chunk: Buffer): string {
  if (current.length >= MAX_LOG_CHARS) return current;
  return current + chunk.toString("utf8").slice(0, MAX_LOG_CHARS - current.length);
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`${command} exceeded its ${options.timeoutMs} ms limit.`)));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

export function processFailure(command: string, result: ProcessResult): Error {
  const detail = (result.stderr || result.stdout).trim() || "no process output";
  return new Error(`${command} exited with ${result.code}: ${detail}`);
}
