import { cp, lstat, mkdir, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stagedRuntimeDependencyNames, stripStagedPackageScripts } from "../staging.js";
import { runSandboxCommand } from "./command.js";
import { dockerMount, dockerSafetyArgs, dockerUserArgs, DOCKER_IMAGE } from "./docker.js";
import { BATCH_RUNNER_SOURCE } from "./batch-runner-source.js";
import { LOADER_SOURCE, RUNNER_SOURCE } from "./runner-source.js";
import { SandboxSource } from "./types.js";

const MAX_PACKAGE_ENTRIES = 10_000;

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function safePath(): string {
  return process.env.PATH ?? process.env.Path ?? "";
}

export function installationEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: safePath(),
    HOME: path.join(root, ".home"),
    USERPROFILE: path.join(root, ".home"),
    TMPDIR: path.join(root, ".tmp"),
    TEMP: path.join(root, ".tmp"),
    TMP: path.join(root, ".tmp"),
    npm_config_cache: path.join(root, ".npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true"
  };
}

export function childEnvironment(root: string, coverageDirectory?: string): NodeJS.ProcessEnv {
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

async function rejectSymlinks(directory: string): Promise<void> {
  const root = await lstat(directory);
  if (root.isSymbolicLink()) throw new Error("This package uses symbolic links, which v1 will not execute because they can escape the sandbox workspace.");
  if (!root.isDirectory()) throw new Error("The package source must be a directory.");

  const directories = [directory];
  let entriesSeen = 0;
  for (let index = 0; index < directories.length; index += 1) {
    const entries = await opendir(directories[index]);
    for await (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_PACKAGE_ENTRIES) {
        throw new Error(`This package has more than ${MAX_PACKAGE_ENTRIES.toLocaleString()} filesystem entries; v1 will not stage it.`);
      }
      const entryPath = path.join(directories[index], entry.name);
      const details = await lstat(entryPath);
      if (details.isSymbolicLink()) {
        throw new Error(`This package contains the symbolic link ${JSON.stringify(entry.name)}; v1 will not execute symlinked packages.`);
      }
      if (details.isDirectory()) directories.push(entryPath);
    }
  }
}

export async function prepareWorkspace(source: SandboxSource): Promise<string> {
  const workspaceBase = path.join(process.cwd(), ".necromancer-cache");
  await mkdir(workspaceBase, { recursive: true });
  const root = await mkdtemp(path.join(workspaceBase, "sandbox-"));
  const packagePath = path.join(root, "package");
  try {
    await rejectSymlinks(source.packagePath);
    await cp(source.packagePath, packagePath, { recursive: true, force: true, verbatimSymlinks: true });
    await stripStagedPackageScripts(packagePath);
    await Promise.all([
      mkdir(path.join(root, ".home"), { recursive: true }),
      mkdir(path.join(root, ".tmp"), { recursive: true }),
      writeFile(path.join(root, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`, "utf8"),
      writeFile(path.join(root, "runner.cjs"), RUNNER_SOURCE, "utf8"),
      writeFile(path.join(root, "batch-runner.cjs"), BATCH_RUNNER_SOURCE, "utf8"),
      writeFile(path.join(root, "loader.mjs"), LOADER_SOURCE, "utf8")
    ]);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function packageNeedsInstall(root: string): Promise<boolean> {
  return (await stagedRuntimeDependencyNames(path.join(root, "package"))).length > 0;
}

export async function installWithChild(root: string): Promise<void> {
  await runSandboxCommand(npmCommand(), ["install", "--ignore-scripts=true", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false"], {
    cwd: path.join(root, "package"),
    env: installationEnvironment(root),
    timeoutMs: 60_000
  });
}

export async function installWithDocker(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  await runSandboxCommand(
    "docker",
    [
      "run",
      "--rm",
      "--network=bridge",
      ...dockerSafetyArgs(),
      ...dockerUserArgs(),
      "-v",
      dockerMount(root, "/work"),
      "-w",
      "/work/package",
      "-e",
      "npm_config_cache=/tmp/npm-cache",
      "-e",
      "npm_config_update_notifier=false",
      "-e",
      "npm_config_ignore_scripts=true",
      DOCKER_IMAGE,
      "npm",
      "install",
      "--ignore-scripts=true",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false"
    ],
    { env, timeoutMs: 60_000 }
  );
}
