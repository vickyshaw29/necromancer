import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadTarballReceipt, fetchPackageManifest, parsePackageSpec, registryFileIntegrityMatch } from "./registry.js";
import { unpackNpmTarball } from "./tar.js";
import { MAX_RUNTIME_DEPENDENCIES, triagePackage } from "./triage.js";
import { ExhumedPackage, NpmPackageManifest, PackageSpec } from "./types.js";

export * from "./registry.js";
export * from "./scope.js";
export * from "./tar.js";
export * from "./triage.js";
export * from "./types.js";

interface DependencyCount {
  count: number;
}

const MAX_DEPENDENCIES_TO_RESOLVE = MAX_RUNTIME_DEPENDENCIES + 1;

function runtimeDependencies(manifest: NpmPackageManifest): Record<string, string> {
  return { ...manifest.dependencies, ...manifest.optionalDependencies };
}

/** Stops immediately once the v1 dependency limit is exceeded. */
async function countRuntimeDependencies(root: NpmPackageManifest): Promise<DependencyCount> {
  const queue = Object.entries(runtimeDependencies(root));
  const visited = new Set<string>();
  let count = 0;

  for (let index = 0; index < queue.length; index += 1) {
    const [name, requestedVersion] = queue[index];
    if (visited.has(name)) continue;
    visited.add(name);
    count += 1;
    if (count >= MAX_DEPENDENCIES_TO_RESOLVE) return { count };

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
  const tarballUrl = registryManifest.dist?.tarball as string;
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "necromancer-"));
  const packagePath = path.join(workspacePath, "package");
  const archivePath = path.join(workspacePath, "package.tgz");

  try {
    const download = await downloadTarballReceipt(tarballUrl, archivePath);
    const integrityMatch = await registryFileIntegrityMatch(download.archivePath, registryManifest.dist);
    if (integrityMatch === "mismatch") {
      throw new Error("The downloaded npm tarball did not match the registry integrity declaration. Refusing to inspect it.");
    }
    await unpackNpmTarball(download.archivePath, packagePath);
    await rm(archivePath, { force: true });
    const manifest = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")) as NpmPackageManifest;
    const dependencyResult = await countRuntimeDependencies(manifest);
    const triage = await triagePackage(packagePath, {
      runtimeDependencyCount: dependencyResult.count
    });
    return {
      spec,
      manifest,
      workspacePath,
      packagePath,
      triage,
      original: {
        name: registryManifest.name,
        version: registryManifest.version,
        registryTarballUrl: tarballUrl,
        registryDeclaredIntegrity: {
          integrity: registryManifest.dist?.integrity ?? "unknown",
          shasum: registryManifest.dist?.shasum ?? "unknown"
        },
        localTarballSha512: download.sha512,
        integrityMatch,
        detectedLicense: typeof manifest.license === "string" && manifest.license.trim() ? manifest.license : "unknown",
        sourceLoc: triage.loc,
        resolvedRuntimeDependencyCount: triage.runtimeDependencyCount
      }
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

export async function discardExhumedPackage(exhumed: Pick<ExhumedPackage, "workspacePath">): Promise<void> {
  await rm(exhumed.workspacePath, { recursive: true, force: true });
}
