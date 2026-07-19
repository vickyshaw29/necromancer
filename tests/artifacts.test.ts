import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProbeArtifactDirectory, findLatestProbeArtifact } from "../src/artifacts.js";
import { readProbeArtifact } from "../src/distill/artifact.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function artifact(packageName: string, version: string, sourceTarballSha512?: string): string {
  return JSON.stringify({
    packageName,
    version,
    ...(sourceTarballSha512 ? { sourceTarballSha512 } : {}),
    behaviors: [],
    coverage: { branchCoverage: 0, lineCoverage: 0, functionCoverage: 0, statementCoverage: 0, available: true }
  });
}

describe("probe artifact cache", () => {
  it("uses different directory identities for names with the same safe prefix", async () => {
    const version = "1.0.0";
    const scoped = await createProbeArtifactDirectory("@scope/cache-fixture-package", version);
    const unscoped = await createProbeArtifactDirectory("scope-cache-fixture-package", version);
    temporaryPaths.push(scoped, unscoped);

    expect(path.basename(scoped).slice(0, -6)).not.toBe(path.basename(unscoped).slice(0, -6));
  });

  it("reuses only a matching package name and version", async () => {
    const packageName = "cache-fixture-package";
    const version = "1.0.0";
    const mismatched = await createProbeArtifactDirectory(packageName, version);
    temporaryPaths.push(mismatched);
    await writeFile(path.join(mismatched, "behaviors.json"), artifact("different-package", version), "utf8");

    await expect(findLatestProbeArtifact(packageName, version)).resolves.toBeUndefined();

    const matching = await createProbeArtifactDirectory(packageName, version);
    temporaryPaths.push(matching);
    await writeFile(path.join(matching, "behaviors.json"), artifact(packageName, version), "utf8");

    await expect(findLatestProbeArtifact(packageName, version)).resolves.toBe(matching);
  });

  it("does not reuse a name-and-version match from a different tarball", async () => {
    const packageName = "cache-tarball-fixture";
    const version = "1.0.0";
    const directory = await createProbeArtifactDirectory(packageName, version);
    temporaryPaths.push(directory);
    await writeFile(path.join(directory, "behaviors.json"), artifact(packageName, version, "sha512-old"), "utf8");

    await expect(findLatestProbeArtifact(packageName, version, "sha512-new")).resolves.toBeUndefined();
    await expect(findLatestProbeArtifact(packageName, version, "sha512-old")).resolves.toBe(directory);
  });

  it("skips oversized cached artifacts instead of buffering them during lookup or distillation", async () => {
    const packageName = "oversized-cache-fixture";
    const version = "1.0.0";
    const directory = await createProbeArtifactDirectory(packageName, version);
    temporaryPaths.push(directory);
    await writeFile(path.join(directory, "behaviors.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));

    await expect(findLatestProbeArtifact(packageName, version)).resolves.toBeUndefined();
    await expect(readProbeArtifact(path.join(directory, "behaviors.json"))).rejects.toThrow("4 MB artifact safety limit");
  });
});
