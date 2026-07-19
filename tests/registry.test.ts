import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPackageManifest } from "../src/exhume/registry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("npm registry manifests", () => {
  it("reads a bounded manifest without depending on Response.json buffering", async () => {
    const manifest = {
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name: "registry-fixture",
          version: "1.0.0",
          dist: { tarball: "https://registry.npmjs.org/registry-fixture/-/registry-fixture-1.0.0.tgz" }
        }
      }
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(manifest))));

    await expect(fetchPackageManifest({ name: "registry-fixture" })).resolves.toMatchObject({ name: "registry-fixture", version: "1.0.0" });
  });

  it("rejects an oversized registry document before buffering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-length": String(9 * 1024 * 1024) } })));

    await expect(fetchPackageManifest({ name: "registry-fixture" })).rejects.toThrow("8 MB safety limit");
  });
});
