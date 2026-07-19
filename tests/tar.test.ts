import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unpackNpmTarball } from "../src/exhume/tar.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function tarEntry(entryPath: string, content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write(entryPath, 0, "utf8");
  header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("0", 156, "ascii");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function archive(entries: Array<[string, string]>): Buffer {
  return gzipSync(Buffer.concat([...entries.map(([entryPath, content]) => tarEntry(entryPath, content)), Buffer.alloc(1_024)]));
}

describe("streamed npm tarball extraction", () => {
  it("extracts regular package files without buffering the decompressed archive", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "tar-test-"));
    temporaryPaths.push(directory);
    const archivePath = path.join(directory, "package.tgz");
    const destination = path.join(directory, "package");
    await writeFile(archivePath, archive([["package/package.json", '{"name":"fixture"}\n'], ["package/index.js", "module.exports = 1;\n"]]));

    await unpackNpmTarball(archivePath, destination);

    await expect(readFile(path.join(destination, "package.json"), "utf8")).resolves.toBe('{"name":"fixture"}\n');
    await expect(readFile(path.join(destination, "index.js"), "utf8")).resolves.toBe("module.exports = 1;\n");
  });

  it("rejects unsafe paths before writing outside the package", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "tar-test-"));
    temporaryPaths.push(directory);
    const archivePath = path.join(directory, "unsafe.tgz");
    await writeFile(archivePath, archive([["package/../outside.js", "unsafe"]]));

    await expect(unpackNpmTarball(archivePath, path.join(directory, "package"))).rejects.toThrow("Unsafe path");
  });
});
