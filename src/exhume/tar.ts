import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;

type EntryMode = "content" | "padding" | "header" | "ended";
type MetadataKind = "global-pax" | "local-pax" | "long-path" | undefined;

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
    let number = 0;
    for (let index = 0; index < value.length; index += 1) number = number * 256 + (index === 0 ? value[index] & 0x7f : value[index]);
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

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset));
    if (bytesWritten <= 0) throw new Error("Could not write an npm tarball entry.");
    offset += bytesWritten;
  }
}

class TarExtractor {
  private mode: EntryMode = "header";
  private header = Buffer.alloc(0);
  private remaining = 0;
  private padding = 0;
  private totalUnpacked = 0;
  private entries = 0;
  private fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  private metadata: Buffer[] = [];
  private metadataSize = 0;
  private metadataKind: MetadataKind;
  private globalPax: Record<string, string> = {};
  private localPax: Record<string, string> = {};
  private nextLongPath: string | undefined;

  constructor(private readonly destination: string) {}

  async consume(input: Buffer): Promise<void> {
    this.totalUnpacked += input.length;
    if (this.totalUnpacked > MAX_UNPACKED_BYTES) {
      throw new Error("The npm tarball expands beyond Necromancer's 128 MB unpacked safety limit.");
    }
    let offset = 0;
    while (offset < input.length && this.mode !== "ended") {
      if (this.mode === "header") {
        const count = Math.min(TAR_BLOCK_SIZE - this.header.length, input.length - offset);
        this.header = Buffer.concat([this.header, input.subarray(offset, offset + count)]);
        offset += count;
        if (this.header.length === TAR_BLOCK_SIZE) {
          const header = this.header;
          this.header = Buffer.alloc(0);
          await this.startEntry(header);
        }
        continue;
      }
      if (this.mode === "content") {
        const count = Math.min(this.remaining, input.length - offset);
        await this.writeContent(input.subarray(offset, offset + count));
        offset += count;
        this.remaining -= count;
        if (this.remaining === 0) await this.finishContent();
        continue;
      }
      const count = Math.min(this.padding, input.length - offset);
      offset += count;
      this.padding -= count;
      if (this.padding === 0) this.mode = "header";
    }
  }

  async finish(): Promise<void> {
    await this.fileHandle?.close();
    this.fileHandle = undefined;
    if (this.mode !== "ended" && (this.mode !== "header" || this.header.length !== 0)) {
      throw new Error("The npm tarball ended before an entry was complete.");
    }
  }

  private async startEntry(header: Buffer): Promise<void> {
    if (isZeroBlock(header)) {
      this.mode = "ended";
      return;
    }
    const size = readTarNumber(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("The npm tarball has an invalid entry size.");
    if (size > MAX_ENTRY_BYTES) throw new Error("The npm tarball contains an entry larger than Necromancer's 24 MB safety limit.");
    this.entries += 1;
    if (this.entries > MAX_ENTRIES) throw new Error("The npm tarball contains more than Necromancer's 10,000-entry safety limit.");
    this.remaining = size;
    this.padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    this.metadata = [];
    this.metadataSize = 0;
    this.metadataKind = undefined;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;

    if (type === "g") this.metadataKind = "global-pax";
    else if (type === "x") this.metadataKind = "local-pax";
    else if (type === "L") this.metadataKind = "long-path";
    else {
      const archivePath = this.nextLongPath ?? this.localPax.path ?? this.globalPax.path ?? headerPath;
      this.nextLongPath = undefined;
      this.localPax = {};
      const relative = entryRelativePath(archivePath);
      if (relative && type === "5") await mkdir(path.join(this.destination, relative), { recursive: true });
      if (relative && (type === "0" || type === "7")) {
        const outputPath = path.resolve(this.destination, relative);
        const prefixPath = `${path.resolve(this.destination)}${path.sep}`;
        if (!outputPath.startsWith(prefixPath)) throw new Error(`Unsafe path in npm tarball: ${JSON.stringify(archivePath)}`);
        await mkdir(path.dirname(outputPath), { recursive: true });
        this.fileHandle = await open(outputPath, "w");
      }
    }
    if (this.remaining === 0) await this.finishContent();
    else this.mode = "content";
  }

  private async writeContent(chunk: Buffer): Promise<void> {
    if (this.fileHandle) {
      await writeAll(this.fileHandle, chunk);
      return;
    }
    if (!this.metadataKind) return;
    this.metadataSize += chunk.length;
    if (this.metadataSize > MAX_METADATA_BYTES) throw new Error("The npm tarball metadata exceeds Necromancer's 128 KB safety limit.");
    this.metadata.push(Buffer.from(chunk));
  }

  private async finishContent(): Promise<void> {
    await this.fileHandle?.close();
    this.fileHandle = undefined;
    if (this.metadataKind) {
      const value = Buffer.concat(this.metadata, this.metadataSize);
      if (this.metadataKind === "global-pax") this.globalPax = { ...this.globalPax, ...parsePax(value) };
      else if (this.metadataKind === "local-pax") this.localPax = parsePax(value);
      else this.nextLongPath = value.toString("utf8").replace(/\0+$/, "").replace(/\n$/, "");
    }
    this.mode = this.padding === 0 ? "header" : "padding";
  }
}

export async function unpackNpmTarball(archivePath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const extractor = new TarExtractor(destination);
  try {
    for await (const chunk of createReadStream(archivePath).pipe(createGunzip())) {
      await extractor.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await extractor.finish();
  } catch (error) {
    await extractor.finish().catch(() => undefined);
    if (error instanceof Error && /npm tarball|Unsafe path|Could not write/.test(error.message)) throw error;
    throw new Error("The registry response was not a valid gzip-compressed npm tarball.");
  }
}
