import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 1_000_000;

export interface SandboxCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
}

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
}

export class SandboxProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProcessError";
  }
}

interface CapturedOutput {
  chunks: Buffer[];
  bytes: number;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have already exited before its group was terminated.
    }
  }
  child.kill("SIGKILL");
}

function outputText(output: CapturedOutput): string {
  return Buffer.concat(output.chunks, output.bytes).toString("utf8");
}

/** Run one isolated command with bounded output and a wall-clock deadline. */
export async function runSandboxCommand(command: string, args: string[], options: SandboxCommandOptions): Promise<SandboxCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stdout: CapturedOutput = { chunks: [], bytes: 0 };
    const stderr: CapturedOutput = { chunks: [], bytes: 0 };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (output: CapturedOutput, chunk: Buffer): void => {
      if (settled) return;
      const nextBytes = output.bytes + chunk.byteLength;
      if (nextBytes > MAX_PROCESS_OUTPUT_BYTES) {
        terminate(child);
        finish(() => reject(new SandboxProcessError("Sandbox process exceeded the 1 MB output safety limit.")));
        return;
      }
      output.chunks.push(chunk);
      output.bytes = nextBytes;
    };
    const timeout = setTimeout(() => {
      terminate(child);
      finish(() => reject(new SandboxProcessError(`Sandbox process exceeded its ${options.timeoutMs} ms time limit.`)));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(new SandboxProcessError(`Could not start ${command}: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(() => resolve({ stdout: outputText(stdout), stderr: outputText(stderr) }));
        return;
      }
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = truncateOutput(outputText(stderr) || outputText(stdout));
      finish(() => reject(new SandboxProcessError(`${command} exited with ${status}${detail ? `: ${detail}` : "."}`)));
    });

    child.stdin.on("error", (error) => finish(() => reject(new SandboxProcessError(`Could not write to ${command}: ${error.message}`))));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}…` : trimmed;
}
