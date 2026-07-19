import { createHash, getHashes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { NpmPackageManifest, PackageSpec, RegistryIntegrityMatch } from "./types.js";

const REGISTRY_URL = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

interface RegistryDocument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmPackageManifest>;
}

export interface TarballDownload {
  archivePath: string;
  sha512: string;
  byteLength: number;
}

function registryPackageUrl(name: string): string {
  return `${REGISTRY_URL}/${encodeURIComponent(name)}`;
}

async function request(url: string): Promise<Response> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal
    });
    if (!response.ok) {
      throw new Error(`npm registry responded with ${response.status} ${response.statusText}.`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Timed out while contacting the npm registry. Check your network and try again.");
    }
    if (error instanceof TypeError && error.message === "fetch failed") {
      throw new Error("Could not reach the npm registry. Check your network and try again.");
    }
    if (error instanceof Error) throw error;
    throw new Error("Unable to contact the npm registry.");
  }
}

async function registryJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  const advertisedSize = contentLength ? Number(contentLength) : undefined;
  if (advertisedSize !== undefined && Number.isFinite(advertisedSize) && advertisedSize > MAX_MANIFEST_BYTES) {
    throw new Error("The npm registry document exceeds Necromancer's 8 MB safety limit.");
  }
  if (!response.body) throw new Error("npm returned an empty registry document.");

  let received = 0;
  const chunks: Buffer[] = [];
  for await (const value of Readable.fromWeb(response.body)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    received += chunk.byteLength;
    if (received > MAX_MANIFEST_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("The npm registry document exceeds Necromancer's 8 MB safety limit.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, received).toString("utf8"));
  } catch {
    throw new Error("npm returned an invalid registry document.");
  }
}

export function parsePackageSpec(input: string): PackageSpec {
  const value = input.trim();
  if (!value) throw new Error("Provide a package name, for example: necromancer left-pad");

  let marker = -1;
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    if (slash <= 1) throw new Error(`Invalid npm package specifier: ${JSON.stringify(input)}`);
    marker = value.indexOf("@", slash);
  } else {
    marker = value.indexOf("@");
  }

  const name = marker === -1 ? value : value.slice(0, marker);
  const requestedVersion = marker === -1 ? undefined : value.slice(marker + 1) || undefined;
  if (!name || /\s/.test(name) || (name.startsWith("@") && !name.includes("/"))) {
    throw new Error(`Invalid npm package specifier: ${JSON.stringify(input)}`);
  }

  return { name, requestedVersion };
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return left.localeCompare(right);
}

function highestVersionMatching(versions: string[], range: string): string | undefined {
  const stable = versions.filter((version) => !version.includes("-") && parseVersion(version));
  if (stable.length === 0) return undefined;
  if (range === "*" || range === "latest") return stable.sort(compareVersions).at(-1);

  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const wildcard = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(range);
  const comparator = /^>=\s*(\d+)\.(\d+)\.(\d+)\s+<\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);

  const matches = stable.filter((version) => {
    const parsed = parseVersion(version);
    if (!parsed) return false;
    const [major, minor, patch] = parsed;
    if (caret) {
      const [wantedMajor, wantedMinor, wantedPatch] = caret.slice(1).map(Number);
      if (wantedMajor > 0) return major === wantedMajor && compareVersions(version, `${wantedMajor}.${wantedMinor}.${wantedPatch}`) >= 0;
      if (wantedMinor > 0) return major === 0 && minor === wantedMinor && patch >= wantedPatch;
      return major === 0 && minor === 0 && patch === wantedPatch;
    }
    if (tilde) {
      const [wantedMajor, wantedMinor, wantedPatch] = tilde.slice(1).map(Number);
      return major === wantedMajor && minor === wantedMinor && patch >= wantedPatch;
    }
    if (wildcard) {
      const [, rawMajor, rawMinor, rawPatch] = wildcard;
      return (
        major === Number(rawMajor) &&
        (!rawMinor || rawMinor === "x" || rawMinor === "*" || minor === Number(rawMinor)) &&
        (!rawPatch || rawPatch === "x" || rawPatch === "*" || patch === Number(rawPatch))
      );
    }
    if (comparator) {
      const lower = comparator.slice(1, 4).join(".");
      const upper = comparator.slice(4, 7).join(".");
      return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0;
    }
    return false;
  });

  return matches.sort(compareVersions).at(-1);
}

export async function fetchPackageManifest(spec: PackageSpec): Promise<NpmPackageManifest> {
  const response = await request(registryPackageUrl(spec.name));
  const document = (await registryJson(response)) as RegistryDocument;
  const versions = document.versions ?? {};
  const selector = spec.requestedVersion ?? "latest";
  const selectedVersion =
    document["dist-tags"]?.[selector] ??
    (versions[selector] ? selector : highestVersionMatching(Object.keys(versions), selector));
  const manifest = selectedVersion ? versions[selectedVersion] : undefined;

  if (!manifest) {
    throw new Error(`npm does not have a published ${spec.name}@${selector} that Necromancer can fetch.`);
  }
  if (!manifest.dist?.tarball) {
    throw new Error(`npm did not provide a tarball URL for ${manifest.name}@${manifest.version}.`);
  }
  return manifest;
}

export async function downloadTarballReceipt(tarballUrl: string, archivePath: string): Promise<TarballDownload> {
  let parsed: URL;
  try {
    parsed = new URL(tarballUrl);
  } catch {
    throw new Error("npm returned an invalid tarball URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("Refusing a non-HTTPS tarball URL from npm.");

  const response = await request(tarballUrl);
  const contentLength = response.headers.get("content-length");
  const advertisedSize = contentLength ? Number(contentLength) : undefined;
  if (advertisedSize !== undefined && Number.isFinite(advertisedSize) && advertisedSize > MAX_TARBALL_BYTES) {
    throw new Error("The npm tarball exceeds Necromancer's 50 MB safety limit.");
  }
  if (!response.body) throw new Error("npm returned an empty tarball response.");

  const sha512 = createHash("sha512");
  let total = 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(archivePath, "wx");
    for await (const value of Readable.fromWeb(response.body)) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_TARBALL_BYTES) {
        throw new Error("The npm tarball exceeds Necromancer's 50 MB safety limit.");
      }
      sha512.update(chunk);
      await handle.write(chunk);
    }
    return { archivePath, sha512: `sha512-${sha512.digest("base64")}`, byteLength: total };
  } catch (error) {
    await handle?.close();
    handle = undefined;
    await response.body.cancel().catch(() => undefined);
    await rm(archivePath, { force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function integrityFromSsri(archive: Buffer, integrity: string): boolean | undefined {
  let compared = false;
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^([A-Za-z0-9]+)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(token);
    if (!match) continue;
    const [, algorithm, encoded] = match;
    if (!getHashes().includes(algorithm.toLowerCase())) continue;
    compared = true;
    const expected = Buffer.from(encoded, "base64");
    const actual = createHash(algorithm).update(archive).digest();
    if (sameDigest(actual, expected)) return true;
  }
  return compared ? false : undefined;
}

interface IntegrityToken {
  algorithm: string;
  expected: Buffer;
}

function integrityTokens(integrity: string): IntegrityToken[] {
  const tokens: IntegrityToken[] = [];
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^([A-Za-z0-9]+)-([A-Za-z0-9+/=]+)(?:\?.*)?$/.exec(token);
    if (!match) continue;
    const algorithm = match[1].toLowerCase();
    if (!getHashes().includes(algorithm)) continue;
    tokens.push({ algorithm, expected: Buffer.from(match[2], "base64") });
  }
  return tokens;
}

async function hashesForFile(filePath: string, algorithms: string[]): Promise<Map<string, Buffer>> {
  const hashes = new Map(algorithms.map((algorithm) => [algorithm, createHash(algorithm)]));
  for await (const chunk of createReadStream(filePath)) {
    for (const hash of hashes.values()) hash.update(chunk);
  }
  return new Map([...hashes].map(([algorithm, hash]) => [algorithm, hash.digest()]));
}

export async function registryFileIntegrityMatch(filePath: string, dist: NpmPackageManifest["dist"]): Promise<RegistryIntegrityMatch> {
  if (dist?.integrity) {
    const tokens = integrityTokens(dist.integrity);
    if (tokens.length === 0) return "unknown";
    const hashes = await hashesForFile(filePath, [...new Set(tokens.map((token) => token.algorithm))]);
    return tokens.some((token) => sameDigest(hashes.get(token.algorithm) as Buffer, token.expected)) ? "verified" : "mismatch";
  }
  if (!dist?.shasum || !/^[a-fA-F0-9]{40}$/.test(dist.shasum)) return "unknown";
  const actual = (await hashesForFile(filePath, ["sha1"])).get("sha1") as Buffer;
  return actual.toString("hex").toLowerCase() === dist.shasum.toLowerCase() ? "verified" : "mismatch";
}

export function registryIntegrityMatch(archive: Buffer, dist: NpmPackageManifest["dist"]): RegistryIntegrityMatch {
  if (dist?.integrity) {
    const matched = integrityFromSsri(archive, dist.integrity);
    return matched === undefined ? "unknown" : matched ? "verified" : "mismatch";
  }
  if (!dist?.shasum || !/^[a-fA-F0-9]{40}$/.test(dist.shasum)) return "unknown";
  const actual = createHash("sha1").update(archive).digest("hex");
  return actual.toLowerCase() === dist.shasum.toLowerCase() ? "verified" : "mismatch";
}
