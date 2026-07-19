import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./json.js";

async function stagedManifest(packageDirectory: string): Promise<Record<string, unknown>> {
  const manifestPath = path.join(packageDirectory, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("The staged package has an unreadable package.json.");
  }
  if (!isRecord(manifest)) throw new Error("The staged package has an invalid package.json.");
  return manifest;
}

export async function stripStagedPackageScripts(packageDirectory: string): Promise<void> {
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = await stagedManifest(packageDirectory);

  const sanitized = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "scripts" && key !== "devDependencies"));
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8"),
    rm(path.join(packageDirectory, ".npmrc"), { force: true })
  ]);
}

function dependencyNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, version]) => (typeof version === "string" ? [name] : []));
}

export async function stagedRuntimeDependencyNames(packageDirectory: string): Promise<string[]> {
  const manifest = await stagedManifest(packageDirectory);
  return [...new Set([...dependencyNames(manifest.dependencies), ...dependencyNames(manifest.optionalDependencies)])];
}

function executablePath(): string {
  return process.env.PATH ?? process.env.Path ?? "";
}

export async function stagedInstallEnvironment(packageDirectory: string): Promise<NodeJS.ProcessEnv> {
  const root = path.join(path.dirname(packageDirectory), ".install-home");
  const temporary = path.join(root, "tmp");
  const cache = path.join(root, "npm-cache");
  const userConfig = path.join(root, "npmrc");
  await Promise.all([
    mkdir(temporary, { recursive: true }),
    mkdir(cache, { recursive: true }),
    writeFile(userConfig, "update-notifier=false\n", "utf8")
  ]);
  return {
    PATH: executablePath(),
    HOME: root,
    USERPROFILE: root,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    npm_config_cache: cache,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: userConfig,
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: ""
  };
}
