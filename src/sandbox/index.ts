import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseSurface, serializeRequest } from "./protocol.js";
import { SandboxProcessError, runSandboxCommand } from "./command.js";
import { dockerAvailable, dockerClientEnvironment, dockerMount, dockerSafetyArgs, dockerUserArgs, DOCKER_IMAGE } from "./docker.js";
import { childEnvironment, installWithChild, installWithDocker, packageNeedsInstall, prepareWorkspace } from "./workspace.js";
import {
  InvocationResult,
  ModuleSurface,
  RunnerMode,
  SandboxInvocation,
  SandboxOptions,
  SandboxRunner,
  SandboxSource
} from "./types.js";

export * from "./types.js";
export { SandboxProcessError } from "./command.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_BATCH_INVOCATIONS = 8;
const MAX_BATCH_TIMEOUT_MS = 180_000;
const RPC_PREFIX = "NECROMANCER_RPC:";
const BATCH_PREFIX = "NECROMANCER_BATCH:";

export class SandboxIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxIsolationError";
  }
}

function warningSink(options: SandboxOptions): (message: string) => void {
  return options.onWarning ?? ((message) => process.stderr.write(`${message}\n`));
}

function reducedIsolationWarning(reason: string): string {
  return [
    `[SANDBOX] Warning: reduced isolation mode (${reason}).`,
    "The child runner limits time, heap, output, and common ESM/CommonJS escape modules, but it is not full containment.",
    "Only use it for packages you trust or from a disposable VM."
  ].join(" ");
}

function parseInvocationResult(value: unknown): InvocationResult {
  const parsed = value as InvocationResult;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean" || typeof parsed.durationMs !== "number") {
    throw new Error("malformed response");
  }
  if (parsed.ok && !("value" in parsed)) throw new Error("missing value");
  if (!parsed.ok && (!("error" in parsed) || !parsed.error || typeof parsed.error.name !== "string" || typeof parsed.error.message !== "string")) {
    throw new Error("missing error");
  }
  return parsed;
}

function parseRpcResponse(output: string, nonce: string): InvocationResult {
  const prefix = `${RPC_PREFIX}${nonce}:`;
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(prefix))
    .at(-1);
  if (!line) throw new SandboxProcessError("Sandbox did not return an RPC response.");

  try {
    return parseInvocationResult(JSON.parse(line.slice(prefix.length)));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new SandboxProcessError(`Sandbox returned invalid RPC JSON: ${detail}`);
  }
}

function parseBatchResponse(output: string, expectedCount: number): InvocationResult[] {
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(BATCH_PREFIX))
    .at(-1);
  if (!line) throw new SandboxProcessError("Sandbox did not return a batch RPC response.");
  try {
    const parsed: unknown = JSON.parse(line.slice(BATCH_PREFIX.length));
    if (!parsed || typeof parsed !== "object") throw new Error("malformed response");
    if ("error" in parsed) {
      const error = (parsed as { error?: unknown }).error;
      const message = error && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : "unknown batch error";
      throw new Error(message);
    }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results) || results.length !== expectedCount) throw new Error("unexpected result count");
    return results.map(parseInvocationResult);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new SandboxProcessError(`Sandbox returned invalid batch RPC JSON: ${detail}`);
  }
}

class Runner implements SandboxRunner {
  readonly mode: RunnerMode;
  private disposed = false;

  constructor(
    mode: RunnerMode,
    private readonly root: string,
    private readonly source: SandboxSource,
    private readonly timeoutMs: number,
    private readonly dockerEnv?: NodeJS.ProcessEnv,
    private readonly coverageDirectory?: string
  ) {
    this.mode = mode;
  }

  private dockerArgs(program: "runner.cjs" | "batch-runner.cjs"): string[] {
    const coverageArgs = this.coverageDirectory
      ? ["-v", dockerMount(this.coverageDirectory, "/coverage"), "-e", "NODE_V8_COVERAGE=/coverage"]
      : [];
    return [
      "run",
      "--rm",
      "--network=none",
      ...dockerSafetyArgs(),
      ...dockerUserArgs(),
      "-i",
      "-v",
      dockerMount(this.root, "/work", true),
      ...coverageArgs,
      "-w",
      "/work",
      "-e",
      "NECROMANCER_PACKAGE_PATH=/work/package",
      "-e",
      "NECROMANCER_NETWORK=disabled",
      DOCKER_IMAGE,
      "node",
      program
    ];
  }

  private async execute(program: "runner.cjs" | "batch-runner.cjs", input: string, timeoutMs: number): Promise<string> {
    const result =
      this.mode === "docker"
        ? await runSandboxCommand("docker", this.dockerArgs(program), { env: this.dockerEnv, input, timeoutMs })
        : await runSandboxCommand(
            process.execPath,
            program === "runner.cjs"
              ? ["--max-old-space-size=256", "--experimental-loader", "./loader.mjs", program]
              : ["--max-old-space-size=256", program],
            { cwd: this.root, env: childEnvironment(this.root, this.coverageDirectory), input, timeoutMs }
          );
    return result.stdout;
  }

  private async request(exportPath: string, args: unknown[], operation: "invoke" | "inspect"): Promise<InvocationResult> {
    if (this.disposed) throw new SandboxProcessError("This sandbox has already been disposed.");
    let input: string;
    const nonce = randomBytes(16).toString("hex");
    try {
      input = serializeRequest(this.source, exportPath, args, operation, nonce);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "arguments could not be encoded safely";
      throw new SandboxProcessError(detail);
    }
    if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
      throw new SandboxProcessError("Sandbox invocation arguments exceed the 256 KB input safety limit.");
    }
    return parseRpcResponse(await this.execute("runner.cjs", input, this.timeoutMs), nonce);
  }

  async inspect(): Promise<ModuleSurface> {
    const result = await this.request(".", [], "inspect");
    if (!result.ok) throw new SandboxProcessError(`Could not inspect exports: ${result.error.name}: ${result.error.message}`);
    try {
      return parseSurface(result.value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid surface";
      throw new SandboxProcessError(detail);
    }
  }

  async invoke(exportPath: string, args: unknown[]): Promise<InvocationResult> {
    return this.request(exportPath, args, "invoke");
  }

  async invokeBatch(invocations: SandboxInvocation[]): Promise<InvocationResult[]> {
    if (this.disposed) throw new SandboxProcessError("This sandbox has already been disposed.");
    const results: InvocationResult[] = [];
    for (let start = 0; start < invocations.length; start += MAX_BATCH_INVOCATIONS) {
      const batch = invocations.slice(start, start + MAX_BATCH_INVOCATIONS);
      const requests = batch.map((invocation) => {
        try {
          return JSON.parse(serializeRequest(this.source, invocation.exportPath, invocation.args, "invoke", randomBytes(16).toString("hex"))) as unknown;
        } catch (error) {
          const detail = error instanceof Error ? error.message : "arguments could not be encoded safely";
          throw new SandboxProcessError(detail);
        }
      });
      const input = JSON.stringify({ requests, timeoutMs: this.timeoutMs });
      if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
        throw new SandboxProcessError("Sandbox batch invocation arguments exceed the 256 KB input safety limit.");
      }
      const timeoutMs = Math.min(MAX_BATCH_TIMEOUT_MS, this.timeoutMs * batch.length + 5_000);
      results.push(...parseBatchResponse(await this.execute("batch-runner.cjs", input, timeoutMs), batch.length));
    }
    return results;
  }

  coveragePaths(): { rawDirectory: string; sourceDirectory: string } | undefined {
    if (!this.coverageDirectory) return undefined;
    return { rawDirectory: this.coverageDirectory, sourceDirectory: path.join(this.root, "package") };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.root, { recursive: true, force: true });
  }
}

function fallbackAllowed(options: SandboxOptions): boolean {
  return options.noDocker === true || options.allowReducedIsolation === true;
}

/**
 * Install an exhumed package without lifecycle scripts, then expose it through a
 * one-shot RPC runner. Docker is required by default because child mode is only
 * a diagnostic fallback, never a containment guarantee.
 */
export async function createSandboxRunner(source: SandboxSource, options: SandboxOptions = {}): Promise<SandboxRunner> {
  const warn = warningSink(options);
  const root = await prepareWorkspace(source);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowFallback = fallbackAllowed(options);
  try {
    if (options.coverageDirectory) await mkdir(options.coverageDirectory, { recursive: true });
    const needsInstall = await packageNeedsInstall(root);
    if (!options.noDocker && (await dockerAvailable())) {
      try {
        const dockerEnv = await dockerClientEnvironment(root);
        if (needsInstall) await installWithDocker(root, dockerEnv);
        return new Runner("docker", root, source, timeoutMs, dockerEnv, options.coverageDirectory);
      } catch (error) {
        if (!allowFallback) {
          const detail = error instanceof Error ? error.message : "unknown Docker error";
          throw new SandboxIsolationError(`Docker sandbox setup failed (${detail}). Refusing to execute an untrusted package with reduced isolation; start Docker or explicitly request --no-docker from a disposable VM.`);
        }
        const detail = error instanceof Error ? error.message : "unknown Docker error";
        warn(`[SANDBOX] Docker setup failed; continuing only because reduced isolation was explicitly requested. ${detail}`);
      }
    } else if (!allowFallback) {
      throw new SandboxIsolationError("Docker is required to execute an untrusted package safely. Start Docker, or explicitly request --no-docker only from a disposable VM.");
    }

    const reason = options.noDocker ? "--no-docker was explicitly requested" : "Docker setup failed after reduced isolation was explicitly permitted";
    warn(reducedIsolationWarning(reason));
    if (needsInstall) await installWithChild(root);
    return new Runner("child", root, source, timeoutMs, undefined, options.coverageDirectory);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
