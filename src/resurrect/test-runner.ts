import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "../json.js";
import { processFailure, runProcess } from "../process.js";
import { dockerAvailable, dockerClientEnvironment, dockerMount, dockerSafetyArgs, dockerUserArgs, DOCKER_IMAGE } from "../sandbox/docker.js";
import { CharacterizationResult, TestFailure } from "./types.js";
import { ExecutionIsolationError, reducedIsolationWarning } from "./isolation.js";

const MAX_REPORT_BYTES = 512 * 1024;
const TEST_TIMEOUT_MS = 60_000;
const DOCKER_RUNTIME_VERSION = "3.0.8";
const TEST_ENVIRONMENT_KEYS = ["PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hostVitest(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("vitest/vitest.mjs");
  } catch {
    return undefined;
  }
}

function testFilePath(artifactDirectory: string, testFile: string | undefined): { relative: string; absolute: string } {
  const relative = testFile ?? "soul.test.ts";
  const normalized = path.normalize(relative);
  if (path.isAbsolute(relative) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("Characterization testFile must be a path inside the artifact directory.");
  }
  return { relative: normalized, absolute: path.join(artifactDirectory, normalized) };
}

async function vitestPath(artifactDirectory: string, offline: boolean): Promise<string> {
  const local = path.join(artifactDirectory, "node_modules", "vitest", "vitest.mjs");
  if (await exists(local)) return local;
  const host = hostVitest();
  if (host) return host;
  if (offline) throw new Error("An offline reduced-isolation characterization run requires Vitest in the artifact or NECROMANCER installation.");
  const install = await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts=true", "--no-audit", "--no-fund"], {
    cwd: artifactDirectory,
    timeoutMs: TEST_TIMEOUT_MS
  });
  if (install.code !== 0) throw processFailure("npm install for the characterization runner", install);
  if (await exists(local)) return local;
  throw new Error("The artifact workspace could not locate Vitest after installation.");
}

function failuresFromReport(report: Record<string, unknown>): TestFailure[] {
  if (!Array.isArray(report.testResults)) return [];
  const failures: TestFailure[] = [];
  for (const suite of report.testResults) {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) continue;
    for (const assertion of suite.assertionResults) {
      if (!isRecord(assertion) || assertion.status === "passed" || typeof assertion.title !== "string") continue;
      const id = assertion.title.split(" — ")[0];
      if (!id) continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter((message): message is string => typeof message === "string") : [];
      failures.push({ id, detail: messages.join("\n").slice(0, 4_000) || "Characterization test failed." });
    }
  }
  return failures;
}

function parseReport(value: unknown): CharacterizationResult {
  if (!isRecord(value) || typeof value.numTotalTests !== "number" || typeof value.numPassedTests !== "number") {
    throw new Error("Vitest did not produce a recognizable characterization report.");
  }
  return { total: value.numTotalTests, passed: value.numPassedTests, failures: failuresFromReport(value) };
}

async function reportText(reportPath: string): Promise<string> {
  const details = await stat(reportPath);
  if (details.size > MAX_REPORT_BYTES) throw new Error(`Vitest characterization report exceeds the ${MAX_REPORT_BYTES}-byte limit.`);
  return readFile(reportPath, "utf8");
}

export type CharacterizationImplementation = "original" | "rebuilt";

export interface CharacterizationOptions {
  implementation?: CharacterizationImplementation;
  offline?: boolean;
  readOnly?: boolean;
  /** Defaults to soul.test.ts; must remain within the artifact directory. */
  testFile?: string;
  /** Explicit escape hatch for trusted fixtures or disposable VMs. */
  allowReducedIsolation?: boolean;
  /** Explicitly use reduced isolation rather than Docker from a disposable VM. */
  noDocker?: boolean;
  onWarning?: (message: string) => void;
}

function testEnvironment(implementation: CharacterizationImplementation): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NECROMANCER_IMPL: implementation === "original" ? "original/package" : "rebuilt" };
  for (const key of TEST_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function cacheDirectory(): Promise<string> {
  const directory = path.join(process.cwd(), ".necromancer-cache", "docker-vitest-runtime");
  await mkdir(directory, { recursive: true });
  return directory;
}

async function dockerRuntime(offline: boolean): Promise<string> {
  const directory = path.join(await cacheDirectory(), `vitest-${DOCKER_RUNTIME_VERSION}`);
  const entry = path.join(directory, "node_modules", "vitest", "vitest.mjs");
  if (await exists(entry)) return directory;
  if (offline) throw new ExecutionIsolationError("The Docker characterization runtime is not cached, so offline verification cannot execute untrusted code. Run one online Docker-backed resurrection first.");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ private: true, devDependencies: { vitest: DOCKER_RUNTIME_VERSION } })}\n`, "utf8");
  const environment = await dockerClientEnvironment(directory);
  const install = await runProcess(
    "docker",
    [
      "run",
      "--rm",
      "--network=bridge",
      ...dockerSafetyArgs(),
      ...dockerUserArgs(),
      "-v",
      dockerMount(directory, "/runtime"),
      "-w",
      "/runtime",
      "-e",
      "HOME=/tmp",
      "-e",
      "npm_config_cache=/tmp/npm-cache",
      "-e",
      "npm_config_ignore_scripts=true",
      DOCKER_IMAGE,
      "npm",
      "install",
      "--ignore-scripts=true",
      "--no-audit",
      "--no-fund",
      "--package-lock=false"
    ],
    { cwd: directory, env: environment, timeoutMs: TEST_TIMEOUT_MS }
  );
  if (install.code !== 0 || !(await exists(entry))) throw processFailure("Docker Vitest runtime installation", install);
  return directory;
}

function dockerTestArgs(
  artifactDirectory: string,
  runtimeDirectory: string,
  reportDirectory: string,
  implementation: CharacterizationImplementation,
  testFile: string
): string[] {
  const containerTestFile = `/work/${testFile.split(path.sep).join("/")}`;
  return [
    "run",
    "--rm",
    "--network=none",
    ...dockerSafetyArgs(),
    ...dockerUserArgs(),
    "-v",
    dockerMount(artifactDirectory, "/work", true),
    "-v",
    dockerMount(path.join(runtimeDirectory, "node_modules"), "/work/node_modules", true),
    "-v",
    // Vite writes its transpiled config bundle to node_modules/.vite-temp; the runtime
    // mount is read-only, so a writable directory is bind-mounted over that path.
    dockerMount(path.join(reportDirectory, "vite-temp"), "/work/node_modules/.vite-temp"),
    "-v",
    dockerMount(reportDirectory, "/reports"),
    "-w",
    "/work",
    "-e",
    `NECROMANCER_IMPL=${implementation === "original" ? "original/package" : "rebuilt"}`,
    "-e",
    "HOME=/tmp",
    "-e",
    "TMPDIR=/tmp",
    "-e",
    "NO_PROXY=*",
    "-e",
    "HTTP_PROXY=",
    "-e",
    "HTTPS_PROXY=",
    DOCKER_IMAGE,
    "node",
    "/work/node_modules/vitest/vitest.mjs",
    "run",
    containerTestFile,
    "--reporter=json",
    "--outputFile=/reports/report.json",
    "--maxWorkers=1",
    "--minWorkers=1",
    "--no-file-parallelism",
    "--cache=false"
  ];
}

async function runDockerCharacterization(
  artifactDirectory: string,
  reportDirectory: string,
  options: CharacterizationOptions,
  testFile: string
): Promise<void> {
  const runtime = await dockerRuntime(options.offline === true);
  await mkdir(path.join(runtime, "node_modules", ".vite-temp"), { recursive: true });
  await mkdir(path.join(reportDirectory, "vite-temp"), { recursive: true });
  const environment = await dockerClientEnvironment(reportDirectory);
  const result = await runProcess(
    "docker",
    dockerTestArgs(artifactDirectory, runtime, reportDirectory, options.implementation ?? "rebuilt", testFile),
    { cwd: artifactDirectory, env: environment, timeoutMs: TEST_TIMEOUT_MS }
  );
  const reportPath = path.join(reportDirectory, "report.json");
  if (!(await exists(reportPath))) throw processFailure("Docker Vitest characterization run", result);
}

async function runReducedCharacterization(
  artifactDirectory: string,
  reportDirectory: string,
  options: CharacterizationOptions,
  testFile: string
): Promise<void> {
  const vitest = await vitestPath(artifactDirectory, options.offline === true);
  const result = await runProcess(process.execPath, [vitest, "run", testFile, "--reporter=json", "--outputFile", path.join(reportDirectory, "report.json")], {
    cwd: artifactDirectory,
    env: testEnvironment(options.implementation ?? "rebuilt"),
    timeoutMs: TEST_TIMEOUT_MS
  });
  if (!(await exists(path.join(reportDirectory, "report.json")))) throw processFailure("Vitest characterization run", result);
}

/** Execute a characterization suite in a resource-capped Docker container by default. */
export async function runCharacterization(artifactDirectory: string, options: CharacterizationOptions = {}): Promise<CharacterizationResult> {
  const test = testFilePath(artifactDirectory, options.testFile);
  if (!(await exists(test.absolute))) throw new Error(`Characterization test file ${test.relative} is unavailable in the artifact directory.`);
  const base = path.join(process.cwd(), ".necromancer-cache", "characterization-");
  await mkdir(path.dirname(base), { recursive: true });
  const reportDirectory = await mkdtemp(base);
  const reportPath = path.join(reportDirectory, "report.json");
  try {
    if (!options.noDocker && (await dockerAvailable())) {
      await runDockerCharacterization(artifactDirectory, reportDirectory, options, test.relative);
    } else {
      if (!options.allowReducedIsolation) {
        throw new ExecutionIsolationError("Docker is required to run characterization against untrusted original or generated code. Start Docker, or explicitly allow reduced isolation only from a disposable VM.");
      }
      options.onWarning?.(reducedIsolationWarning("characterization"));
      await runReducedCharacterization(artifactDirectory, reportDirectory, options, test.relative);
    }
    return parseReport(JSON.parse(await reportText(reportPath)));
  } finally {
    await rm(reportDirectory, { recursive: true, force: true });
  }
}

export { ExecutionIsolationError } from "./isolation.js";
