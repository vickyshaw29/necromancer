import { createHash, getHashes, timingSafeEqual } from "node:crypto";
import { NpmPackageManifest, PackageSpec, RegistryIntegrityMatch } from "./types.js";

const REGISTRY_URL = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TARBALL_BYTES = 50 * 1024 * 1024;

interface RegistryDocument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmPackageManifest>;
}

export interface TarballDownload {
  archive: Buffer;
  sha512: string;
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
  const document = (await response.json()) as RegistryDocument;
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

export async function downloadTarballReceipt(tarballUrl: string): Promise<TarballDownload> {
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

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  const sha512 = createHash("sha512");
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TARBALL_BYTES) {
      await reader.cancel();
      throw new Error("The npm tarball exceeds Necromancer's 50 MB safety limit.");
    }
    const chunk = Buffer.from(value);
    sha512.update(chunk);
    chunks.push(chunk);
  }
  return { archive: Buffer.concat(chunks, total), sha512: `sha512-${sha512.digest("base64")}` };
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

export function registryIntegrityMatch(archive: Buffer, dist: NpmPackageManifest["dist"]): RegistryIntegrityMatch {
  if (dist?.integrity) {
    const matched = integrityFromSsri(archive, dist.integrity);
    return matched === undefined ? "unknown" : matched ? "verified" : "mismatch";
  }
  if (!dist?.shasum || !/^[a-fA-F0-9]{40}$/.test(dist.shasum)) return "unknown";
  const actual = createHash("sha1").update(archive).digest("hex");
  return actual.toLowerCase() === dist.shasum.toLowerCase() ? "verified" : "mismatch";
}
