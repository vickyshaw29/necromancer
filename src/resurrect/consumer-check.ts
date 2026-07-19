import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../process.js";
import { dockerAvailable, dockerClientEnvironment, dockerMount, dockerSafetyArgs, dockerUserArgs, DOCKER_IMAGE } from "../sandbox/docker.js";
import { PublicApiMember } from "./types.js";
import { ExecutionIsolationError, reducedIsolationWarning } from "./isolation.js";

const CONSUMER_TIMEOUT_MS = 15_000;

export interface ConsumerCheckOptions {
  /** Explicitly use reduced isolation rather than Docker from a disposable VM. */
  noDocker?: boolean;
  allowReducedIsolation?: boolean;
  onWarning?: (message: string) => void;
}

function consumerScript(packageName: string): string {
  return `import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const api = JSON.parse(await readFile(new URL("./api.json", import.meta.url), "utf8"));
const packageName = ${JSON.stringify(packageName)};
const packageSpecifier = "necromancer-rebuilt-candidate";
const require = createRequire(import.meta.url);

function isObject(value) { return !!value && (typeof value === "object" || typeof value === "function"); }
function segments(member) {
  const relative = member.path === packageName || member.path === "." ? "" : member.path.startsWith(packageName + ".") ? member.path.slice(packageName.length + 1) : member.path.replace(/^\\./, "");
  return relative.split(".").filter(Boolean);
}

function hasExport(value, parts) {
  let current = value;
  for (const part of parts) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = Reflect.get(current, part);
  }
  return true;
}
function check(value, label, cjs) {
  const root = api.find((member) => member.path === packageName || member.path === ".");
  if (root && root.type === "function") {
    const rootValue = cjs ? value : value.default;
    if (typeof rootValue !== "function") throw new Error(label + " consumer: package root is not callable.");
    if (cjs && typeof value.default !== "function") throw new Error("CommonJS consumer: package root default is not callable.");
  }
  for (const member of api) {
    if (member.path === packageName || member.path === ".") continue;
    if (!hasExport(value, segments(member))) throw new Error(label + " consumer: named export " + JSON.stringify(member.path) + " is missing.");
  }
}

const commonJs = require(packageSpecifier);
check(commonJs, "CommonJS", true);
const esm = await import(packageSpecifier);
check(esm, "ESM", false);
`;
}

function reducedConsumerEnvironment(consumerDirectory: string): NodeJS.ProcessEnv {
  const temporary = path.join(consumerDirectory, ".tmp");
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: temporary,
    USERPROFILE: temporary,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NODE_ENV: "production",
    NO_PROXY: "*",
    no_proxy: "*",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: ""
  };
}

async function cacheDirectory(): Promise<string> {
  const directory = path.join(process.cwd(), ".necromancer-cache");
  await mkdir(directory, { recursive: true });
  return directory;
}

async function prepareConsumer(packageName: string, api: PublicApiMember[]): Promise<string> {
  const directory = await mkdtemp(path.join(await cacheDirectory(), "consumer-check-"));
  await Promise.all([
    mkdir(path.join(directory, "node_modules"), { recursive: true }),
    writeFile(path.join(directory, "api.json"), `${JSON.stringify(api)}\n`, "utf8"),
    writeFile(path.join(directory, "consumer.mjs"), consumerScript(packageName), "utf8")
  ]);
  return directory;
}

function dockerArgs(consumerDirectory: string, rebuiltDirectory: string): string[] {
  return [
    "run",
    "--rm",
    "--network=none",
    ...dockerSafetyArgs(),
    ...dockerUserArgs(),
    "-v",
    dockerMount(consumerDirectory, "/consumer", true),
    "-v",
    dockerMount(rebuiltDirectory, "/consumer/node_modules/necromancer-rebuilt-candidate", true),
    "-w",
    "/consumer",
    "-e",
    "HOME=/tmp",
    "-e",
    "TMPDIR=/tmp",
    DOCKER_IMAGE,
    "node",
    "consumer.mjs"
  ];
}

async function runDockerConsumer(consumerDirectory: string, rebuiltDirectory: string): Promise<void> {
  await mkdir(path.join(consumerDirectory, "node_modules", "necromancer-rebuilt-candidate"), { recursive: true });
  const environment = await dockerClientEnvironment(consumerDirectory);
  const result = await runProcess("docker", dockerArgs(consumerDirectory, rebuiltDirectory), {
    cwd: consumerDirectory,
    env: environment,
    timeoutMs: CONSUMER_TIMEOUT_MS
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "no output";
    throw new Error(`consumer compatibility check failed: ${detail}`);
  }
}

async function runReducedConsumer(consumerDirectory: string, rebuiltDirectory: string): Promise<void> {
  const packageLink = path.join(consumerDirectory, "node_modules", "necromancer-rebuilt-candidate");
  await Promise.all([symlink(rebuiltDirectory, packageLink, "dir"), mkdir(path.join(consumerDirectory, ".tmp"), { recursive: true })]);
  const result = await runProcess(process.execPath, ["consumer.mjs"], {
    cwd: consumerDirectory,
    env: reducedConsumerEnvironment(consumerDirectory),
    timeoutMs: CONSUMER_TIMEOUT_MS
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || "no output";
    throw new Error(`consumer compatibility check failed: ${detail}`);
  }
}

/** Verify root and named exports from actual CJS and ESM consumer entry points. */
export async function validateCandidateConsumers(
  rebuiltDirectory: string,
  packageName: string,
  api: PublicApiMember[],
  options: ConsumerCheckOptions = {}
): Promise<string | undefined> {
  const consumerDirectory = await prepareConsumer(packageName, api);
  try {
    if (!options.noDocker && (await dockerAvailable())) {
      await runDockerConsumer(consumerDirectory, rebuiltDirectory);
      return undefined;
    }
    if (!options.allowReducedIsolation) {
      throw new ExecutionIsolationError("Docker is required to validate generated package consumers safely. Start Docker, or use reduced isolation only from a disposable VM.");
    }
    options.onWarning?.(reducedIsolationWarning("consumer compatibility validation"));
    await runReducedConsumer(consumerDirectory, rebuiltDirectory);
    return undefined;
  } catch (error) {
    if (error instanceof ExecutionIsolationError) throw error;
    return error instanceof Error ? error.message : "consumer compatibility check failed";
  } finally {
    await rm(consumerDirectory, { recursive: true, force: true });
  }
}
