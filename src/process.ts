import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 8_000;

interface CapturedText {
  chunks: string[];
  length: number;
}

function append(output: CapturedText, chunk: Buffer, maxChars: number): void {
  if (output.length >= maxChars) return;
  const text = chunk.toString("utf8").slice(0, maxChars - output.length);
  if (!text) return;
  output.chunks.push(text);
  output.length += text.length;
}

function outputText(output: CapturedText): string {
  return output.chunks.join("");
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may already have exited before its group was terminated.
    }
  }
  child.kill("SIGKILL");
}

export async function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    let settled = false;
    const stdout: CapturedText = { chunks: [], length: 0 };
    const stderr: CapturedText = { chunks: [], length: 0 };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      terminate(child);
      finish(() => reject(new Error(`${command} exceeded its ${options.timeoutMs} ms limit.`)));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      append(stdout, chunk, maxOutputChars);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(stderr, chunk, maxOutputChars);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, stdout: outputText(stdout), stderr: outputText(stderr) })));
  });
}

export function processFailure(command: string, result: ProcessResult): Error {
  const detail = (result.stderr || result.stdout).trim() || "no process output";
  return new Error(`${command} exited with ${result.code}: ${detail}`);
}

export async function runCheckedProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) throw processFailure(command, result);
  return result;
}
