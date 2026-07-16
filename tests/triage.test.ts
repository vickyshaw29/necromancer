import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { triagePackage } from "../src/exhume/triage.js";
import { parsePackageSpec } from "../src/exhume/registry.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => path.join(fixturesPath, name);

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
});
