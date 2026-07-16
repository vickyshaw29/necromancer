import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const TAR_BLOCK_SIZE = 512;

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function readTarString(block: Buffer, start: number, length: number): string {
  const value = block.subarray(start, start + length);
  const zeroIndex = value.indexOf(0);
  return value.subarray(0, zeroIndex === -1 ? value.length : zeroIndex).toString("utf8");
}

function readTarNumber(block: Buffer, start: number, length: number): number {
  const value = block.subarray(start, start + length);
  if ((value[0] & 0x80) !== 0) {
    // GNU tar's base-256 representation. npm tarballs use positive sizes.
    let number = 0;
    for (let index = 0; index < value.length; index += 1) {
      number = number * 256 + (index === 0 ? value[index] & 0x7f : value[index]);
    }
    return number;
  }

  const raw = value.toString("ascii").replace(/\0/g, "").trim();
  return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0;

  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    if (separator === -1) break;

    const recordLength = Number.parseInt(data.subarray(offset, separator).toString("ascii"), 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0 || offset + recordLength > data.length) break;

    const record = data.subarray(separator + 1, offset + recordLength - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals !== -1) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += recordLength;
  }

  return values;
}

function entryRelativePath(entryPath: string): string | undefined {
  // npm always prefixes archives with package/. Do not extract anything outside it.
  if (entryPath === "package" || entryPath === "package/") return undefined;
  if (!entryPath.startsWith("package/")) return undefined;

  const relative = entryPath.slice("package/".length);
  if (
    relative === "" ||
    entryPath.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe path in npm tarball: ${JSON.stringify(entryPath)}`);
  }

  return relative;
}

/**
 * Extract regular files and directories from an npm .tgz without invoking a shell
 * command or following archive symlinks. The destination represents package/.
 */
export async function unpackNpmTarball(archive: Buffer, destination: string): Promise<void> {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new Error("The registry response was not a valid gzip-compressed npm tarball.");
  }

  await mkdir(destination, { recursive: true });
  let offset = 0;
  let globalPax: Record<string, string> = {};
  let localPax: Record<string, string> = {};
  let nextLongPath: string | undefined;

  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) break;

    const size = readTarNumber(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("The npm tarball has an invalid entry size.");

    const contentStart = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error("The npm tarball ended before an entry was complete.");

    const content = tar.subarray(contentStart, contentEnd);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;

    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(content) };
    } else if (type === "x") {
      localPax = parsePax(content);
    } else if (type === "L") {
      nextLongPath = content.toString("utf8").replace(/\0+$/, "").replace(/\n$/, "");
    } else {
      const archivePath = nextLongPath ?? localPax.path ?? globalPax.path ?? headerPath;
      const relative = entryRelativePath(archivePath);
      nextLongPath = undefined;
      localPax = {};

      if (relative) {
        const outputPath = path.resolve(destination, relative);
        const destinationPrefix = `${path.resolve(destination)}${path.sep}`;
        if (!outputPath.startsWith(destinationPrefix)) {
          throw new Error(`Unsafe path in npm tarball: ${JSON.stringify(archivePath)}`);
        }

        if (type === "5") {
          await mkdir(outputPath, { recursive: true });
        } else if (type === "0" || type === "7") {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, content);
        }
        // Symlinks, hard links, devices, and unknown types are deliberately skipped.
      }
    }

    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
}
