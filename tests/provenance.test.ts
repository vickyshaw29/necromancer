import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTarballReceipt, registryIntegrityMatch } from "../src/exhume/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EXHUME provenance", () => {
  it("hashes the downloaded tarball while reading one mocked registry response", async () => {
    const archive = Buffer.from("tarball fixture bytes", "utf8");
    const declaredIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
    const fetch = vi.fn(async () => new Response(archive, { headers: { "content-length": String(archive.byteLength) } }));
    vi.stubGlobal("fetch", fetch);

    const receipt = await downloadTarballReceipt("https://registry.npmjs.org/provenance-fixture/-/provenance-fixture-1.0.0.tgz");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(receipt.archive).toEqual(archive);
    expect(receipt.sha512).toBe(declaredIntegrity);
    expect(registryIntegrityMatch(receipt.archive, { integrity: declaredIntegrity, shasum: "0000000000000000000000000000000000000000" })).toBe("verified");
  });

  it("reports a mocked registry mismatch or missing declaration without concealing either", () => {
    const archive = Buffer.from("tarball fixture bytes", "utf8");

    expect(registryIntegrityMatch(archive, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` })).toBe("mismatch");
    expect(registryIntegrityMatch(archive, undefined)).toBe("unknown");
  });
});
