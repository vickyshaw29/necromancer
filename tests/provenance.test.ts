import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTarballReceipt, registryFileIntegrityMatch, registryIntegrityMatch } from "../src/exhume/index.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EXHUME provenance", () => {
  it("hashes the downloaded tarball while reading one mocked registry response", async () => {
    const archive = Buffer.from("tarball fixture bytes", "utf8");
    const declaredIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const fetch = vi.fn(async () => new Response(archive, { headers: { "content-length": String(archive.byteLength) } }));
    vi.stubGlobal("fetch", fetch);
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "provenance-test-"));
    temporaryPaths.push(directory);

    const receipt = await downloadTarballReceipt(
      "https://registry.npmjs.org/provenance-fixture/-/provenance-fixture-1.0.0.tgz",
      path.join(directory, "fixture.tgz")
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(readFile(receipt.archivePath)).resolves.toEqual(archive);
    expect(receipt.byteLength).toBe(archive.byteLength);
    expect(receipt.sha512).toBe(declaredIntegrity);
    expect(registryIntegrityMatch(archive, { integrity: declaredIntegrity, shasum: "0000000000000000000000000000000000000000" })).toBe("verified");
    await expect(registryFileIntegrityMatch(receipt.archivePath, { integrity: declaredIntegrity })).resolves.toBe("verified");
  });

  it("reports a mocked registry mismatch or missing declaration without concealing either", () => {
    const archive = Buffer.from("tarball fixture bytes", "utf8");

    expect(registryIntegrityMatch(archive, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` })).toBe("mismatch");
    expect(registryIntegrityMatch(archive, undefined)).toBe("unknown");
  });
});
