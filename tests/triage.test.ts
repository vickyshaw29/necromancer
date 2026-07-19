import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { triagePackage } from "../src/exhume/triage.js";
import { parsePackageSpec } from "../src/exhume/registry.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => path.join(fixturesPath, name);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("static triage", () => {
  it("parses regular and scoped package specifiers", () => {
    expect(parsePackageSpec("left-pad@1.3.0")).toEqual({ name: "left-pad", requestedVersion: "1.3.0" });
    expect(parsePackageSpec("@scope/package@2.0.0")).toEqual({
      name: "@scope/package",
      requestedVersion: "2.0.0"
    });
  });

  it("accepts a small pure-JS package", async () => {
    const result = await triagePackage(fixture("pure-package"));

    expect(result).toMatchObject({
      verdict: "IN_SCOPE",
      runtimeDependencyCount: 0,
      nativeEvidence: [],
      filesystemImports: [],
      networkImports: []
    });
    expect(result.loc).toBeGreaterThan(0);
  });

  it("rejects node-gyp packages with native evidence", async () => {
    const result = await triagePackage(fixture("native-package"));

    expect(result.verdict).toBe("OUT_OF_SCOPE");
    expect(result.reasons.map((reason) => reason.code)).toContain("NATIVE_MODULE");
    expect(result.nativeEvidence).toEqual(expect.arrayContaining(["package.json:gypfile", "binding.gyp"]));
  });

  it("detects filesystem and network imports without executing the package", async () => {
    const result = await triagePackage(fixture("io-package"));

    expect(result.verdict).toBe("OUT_OF_SCOPE");
    expect(result.filesystemImports).toEqual(["node:fs/promises"]);
    expect(result.networkImports).toEqual(["https"]);
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["FILESYSTEM_USAGE", "NETWORK_USAGE"])
    );
  });

  it("enforces dependency and source-size limits", async () => {
    const result = await triagePackage(fixture("pure-package"), {
      runtimeDependencyCount: 4,
      maxLoc: 1
    });

    expect(result.verdict).toBe("OUT_OF_SCOPE");
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["TOO_MANY_RUNTIME_DEPENDENCIES", "TOO_MANY_LINES"])
    );
  });

  it("ignores non-runtime tests and declaration files during static scope checks", async () => {
    const cache = path.join(process.cwd(), ".necromancer-cache");
    await mkdir(cache, { recursive: true });
    const packagePath = await mkdtemp(path.join(cache, "triage-non-runtime-"));
    temporaryPaths.push(packagePath);
    await cp(fixture("non-runtime-files-package"), packagePath, { recursive: true, force: true });
    await writeFile(path.join(packagePath, "index.d.ts"), "export declare const value: string;\n".repeat(2_100), "utf8");

    const result = await triagePackage(packagePath);

    expect(result).toMatchObject({ verdict: "IN_SCOPE", filesystemImports: [] });
    expect(result.loc).toBeLessThan(10);
  });

  it("rejects dynamic runtime access rather than probing it", async () => {
    const cache = path.join(process.cwd(), ".necromancer-cache");
    await mkdir(cache, { recursive: true });
    const packagePath = await mkdtemp(path.join(cache, "triage-dynamic-"));
    temporaryPaths.push(packagePath);
    await Promise.all([
      writeFile(path.join(packagePath, "package.json"), '{"name":"dynamic-fixture","version":"1.0.0"}\n', "utf8"),
      writeFile(path.join(packagePath, "index.js"), 'module.exports = () => import("node:" + "fs");\n', "utf8")
    ]);

    const result = await triagePackage(packagePath);

    expect(result.verdict).toBe("OUT_OF_SCOPE");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DYNAMIC_RUNTIME_ACCESS" })]));
  });
});
