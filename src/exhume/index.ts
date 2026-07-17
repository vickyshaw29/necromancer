import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadTarball, fetchPackageManifest, parsePackageSpec } from "./registry.js";
import { unpackNpmTarball } from "./tar.js";
import { triagePackage } from "./triage.js";
import { ExhumedPackage, NpmPackageManifest, PackageSpec } from "./types.js";

export * from "./registry.js";
export * from "./scope.js";
export * from "./tar.js";
export * from "./triage.js";
export * from "./types.js";

interface DependencyCount {
  count: number;
}

const MAX_DEPENDENCIES_TO_RESOLVE = 50;

function runtimeDependencies(manifest: NpmPackageManifest): Record<string, string> {
  return { ...manifest.dependencies, ...manifest.optionalDependencies };
}

/**
 * Count a package's runtime dependency graph without installing it. Fifty packages is
 * ample to distinguish v1's <=3-dependency scope and prevents an unbounded registry walk.
 */
async function countRuntimeDependencies(root: NpmPackageManifest): Promise<DependencyCount> {
  const queue = Object.entries(runtimeDependencies(root));
  const visited = new Set<string>();
  let count = 0;

  while (queue.length > 0) {
    const [name, requestedVersion] = queue.shift() as [string, string];
    if (visited.has(name)) continue;
    visited.add(name);
    count += 1;
    if (count > MAX_DEPENDENCIES_TO_RESOLVE) return { count };

    try {
      const manifest = await fetchPackageManifest({ name, requestedVersion });
      queue.push(...Object.entries(runtimeDependencies(manifest)));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown registry error";
      throw new Error(`Could not inspect runtime dependency ${name}@${requestedVersion}: ${detail}`);
    }
  }

  return { count };
}

export async function exhume(input: string): Promise<ExhumedPackage> {
  const spec: PackageSpec = parsePackageSpec(input);
  const registryManifest = await fetchPackageManifest(spec);
  const archive = await downloadTarball(registryManifest.dist?.tarball as string);
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "necromancer-"));
  const packagePath = path.join(workspacePath, "package");

  try {
    await unpackNpmTarball(archive, packagePath);
    const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")) as NpmPackageManifest;
    const dependencyResult = await countRuntimeDependencies(manifest);
    const triage = await triagePackage(packagePath, {
      runtimeDependencyCount: dependencyResult.count
    });
    return { spec, manifest, workspacePath, packagePath, triage };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export async function discardExhumedPackage(exhumed: Pick<ExhumedPackage, "workspacePath">): Promise<void> {
  await rm(exhumed.workspacePath, { recursive: true, force: true });
}
