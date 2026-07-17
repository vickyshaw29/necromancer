import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { stagedRuntimeDependencyNames, stripStagedPackageScripts } from "../staging.js";
import { parseSurface, serializeRequest } from "./protocol.js";
import { RUNNER_SOURCE } from "./runner-source.js";
import {
  InvocationResult,
  ModuleSurface,
  RunnerMode,
  SandboxOptions,
  SandboxRunner,
  SandboxSource
} from "./types.js";

export * from "./types.js";

const DOCKER_IMAGE = "node:20-slim";
const RPC_PREFIX = "NECROMANCER_RPC:";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1_000_000;

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

class SandboxProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProcessError";
  }
}

function warningSink(options: SandboxOptions): (message: string) => void {
  return options.onWarning ?? ((message) => process.stderr.write(`${message}\n`));
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function safePath(): string {
  return process.env.PATH ?? process.env.Path ?? "";
}

function installationEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: safePath(),
    HOME: path.join(root, ".home"),
    USERPROFILE: path.join(root, ".home"),
    TMPDIR: path.join(root, ".tmp"),
    TEMP: path.join(root, ".tmp"),
    TMP: path.join(root, ".tmp"),
    npm_config_cache: path.join(root, ".npm-cache"),
    npm_config_update_notifier: "false"
  };
}

function childEnvironment(root: string, coverageDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...installationEnvironment(root),
    NODE_ENV: "production",
    NECROMANCER_NETWORK: "disabled",
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    NECROMANCER_PACKAGE_PATH: path.join(root, "package"),
    ...(coverageDirectory ? { NODE_V8_COVERAGE: coverageDirectory } : {})
  };
}

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}…` : trimmed;
}

async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true
    });
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > MAX_PROCESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new SandboxProcessError("Sandbox process exceeded the 1 MB output safety limit.")));
      }
      return next;
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new SandboxProcessError(`Sandbox process exceeded its ${options.timeoutMs} ms time limit.`)));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish(() => reject(new SandboxProcessError(`Could not start ${command}: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(() => resolve({ stdout, stderr }));
        return;
      }
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      const detail = truncateOutput(stderr || stdout);
      finish(() => reject(new SandboxProcessError(`${command} exited with ${status}${detail ? `: ${detail}` : "."}`)));
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await runCommand("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function dockerEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const dockerConfig = path.join(root, ".docker-config");
  await mkdir(dockerConfig, { recursive: true });
  await writeFile(path.join(dockerConfig, "config.json"), `${JSON.stringify({ auths: {} })}\n`, "utf8");

  let dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) {
    const context = (await runCommand("docker", ["context", "show"], { timeoutMs: 3_000 })).stdout.trim();
    if (context) {
      dockerHost = (
        await runCommand("docker", ["context", "inspect", context, "--format", "{{ .Endpoints.docker.Host }}"], {
          timeoutMs: 3_000
        })
      ).stdout.trim();
    }
  }

  return {
    PATH: safePath(),
    DOCKER_CONFIG: dockerConfig,
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {})
  };
}

function dockerUserArgs(): string[] {
  if (process.platform === "win32" || !process.getuid || !process.getgid) return [];
  return ["--user", `${process.getuid()}:${process.getgid()}`];
}

function dockerMount(root: string, readOnly = false): string {
  return `${path.resolve(root)}:/work${readOnly ? ":ro" : ""}`;
}

function parseRpcResponse(output: string): InvocationResult {
  const line = output
    .split(/\r?\n/)
    .filter((candidate) => candidate.startsWith(RPC_PREFIX))
    .at(-1);
  if (!line) throw new SandboxProcessError("Sandbox did not return an RPC response.");

  try {
    const parsed = JSON.parse(line.slice(RPC_PREFIX.length)) as InvocationResult;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean" || typeof parsed.durationMs !== "number") {
      throw new Error("malformed response");
    }
    if (parsed.ok && !("value" in parsed)) throw new Error("missing value");
    if (!parsed.ok && (!("error" in parsed) || !parsed.error || typeof parsed.error.name !== "string" || typeof parsed.error.message !== "string")) {
      throw new Error("missing error");
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new SandboxProcessError(`Sandbox returned invalid RPC JSON: ${detail}`);
  }
}

async function prepareWorkspace(source: SandboxSource): Promise<string> {
  const workspaceBase = path.join(process.cwd(), ".necromancer-cache");
  await mkdir(workspaceBase, { recursive: true });
  const root = await mkdtemp(path.join(workspaceBase, "sandbox-"));
  const packagePath = path.join(root, "package");
  try {
    await cp(source.packagePath, packagePath, { recursive: true, force: true, verbatimSymlinks: true });
    await stripStagedPackageScripts(packagePath);
    await Promise.all([
      mkdir(path.join(root, ".home"), { recursive: true }),
      mkdir(path.join(root, ".tmp"), { recursive: true }),
      writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`,
        "utf8"
      ),
      writeFile(path.join(root, "runner.cjs"), RUNNER_SOURCE, "utf8")
    ]);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function installWithChild(root: string): Promise<void> {
  await runCommand(npmCommand(), ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false"], {
    cwd: path.join(root, "package"),
    env: installationEnvironment(root),
    timeoutMs: 60_000
  });
}

async function installWithDocker(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runCommand(
    "docker",
    [
      "run",
      "--rm",
      "--network=bridge",
      ...dockerUserArgs(),
      "-v",
      dockerMount(root),
      "-w",
      "/work/package",
      "-e",
      "npm_config_cache=/tmp/npm-cache",
      "-e",
      "npm_config_update_notifier=false",
      DOCKER_IMAGE,
      "npm",
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false"
    ],
    { env, timeoutMs: 60_000 }
  );
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

  private async request(exportPath: string, args: unknown[], operation: "invoke" | "inspect"): Promise<InvocationResult> {
    if (this.disposed) throw new SandboxProcessError("This sandbox has already been disposed.");
    let input: string;
    try {
      input = serializeRequest(this.source, exportPath, args, operation);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "arguments could not be encoded safely";
      throw new SandboxProcessError(detail);
    }
    const result =
      this.mode === "docker"
        ? await runCommand(
            "docker",
            [
              "run",
              "--rm",
              "--network=none",
              "--read-only",
              "--tmpfs",
              "/tmp",
              ...dockerUserArgs(),
              "-i",
              "-v",
              dockerMount(this.root, true),
              "-w",
              "/work",
              "-e",
              "NECROMANCER_PACKAGE_PATH=/work/package",
              DOCKER_IMAGE,
              "node",
              "runner.cjs"
            ],
            { env: this.dockerEnv, input, timeoutMs: this.timeoutMs }
          )
        : await runCommand(process.execPath, ["runner.cjs"], {
            cwd: this.root,
            env: childEnvironment(this.root, this.coverageDirectory),
            input,
            timeoutMs: this.timeoutMs
          });
    return parseRpcResponse(result.stdout);
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

/**
 * Install an exhumed package without running lifecycle scripts, then expose it through
 * a one-shot RPC runner. The target is never imported into the Necromancer process.
 */
export async function createSandboxRunner(source: SandboxSource, options: SandboxOptions = {}): Promise<SandboxRunner> {
  const warn = warningSink(options);
  const root = await prepareWorkspace(source);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let mode: RunnerMode = "child";
  let dockerEnv: NodeJS.ProcessEnv | undefined;

  try {
    const needsInstall = (await stagedRuntimeDependencyNames(path.join(root, "package"))).length > 0;
    if (options.coverageDirectory) {
      await mkdir(options.coverageDirectory, { recursive: true });
      warn(
        "[SANDBOX] Behavioral probing uses reduced-isolation child-process mode because V8 coverage must write locally. Docker currently isolates only the bare install/inspection step. The child runner is not full containment; run untrusted packages on a disposable machine or VM."
      );
      if (needsInstall) await installWithChild(root);
    } else if (!options.noDocker && (await dockerAvailable())) {
      try {
        dockerEnv = await dockerEnvironment(root);
        if (needsInstall) await installWithDocker(root, dockerEnv);
        mode = "docker";
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown Docker error";
        warn(`[SANDBOX] Docker setup failed; using reduced isolation child-process mode. ${detail}`);
        if (needsInstall) await installWithChild(root);
      }
    } else {
      const reason = options.noDocker ? "--no-docker was requested" : "Docker is unavailable";
      warn(
        `[SANDBOX] Warning: reduced isolation mode (${reason}). The child runner scrubs its environment and blocks common network and process-control modules, but is not full containment. Run untrusted packages on a disposable machine or VM.`
      );
      if (needsInstall) await installWithChild(root);
    }
    return new Runner(mode, root, source, timeoutMs, dockerEnv, options.coverageDirectory);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
