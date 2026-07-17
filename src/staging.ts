import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
  await writeFile(manifestPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
}

function dependencyNames(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, version]) => (typeof version === "string" ? [name] : []));
}

export async function stagedRuntimeDependencyNames(packageDirectory: string): Promise<string[]> {
  const manifest = await stagedManifest(packageDirectory);
  return [...new Set([...dependencyNames(manifest.dependencies), ...dependencyNames(manifest.optionalDependencies)])];
}
