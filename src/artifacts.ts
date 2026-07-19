import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./json.js";

const MAX_PROBE_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_LOOKUPS = 32;

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

export function probeArtifactsDirectory(): string {
  return path.join(process.cwd(), ".necromancer-cache", "probes");
}

function artifactPrefix(packageName: string, version: string): string {
  const readable = safeArtifactName(`${packageName}-${version}`);
  const hash = createHash("sha256").update(`${packageName}@${version}`).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

interface ProbeArtifactIdentity {
  packageName: string;
  version: string;
  sourceTarballSha512?: string;
}

export function parsePackageSpecifier(value: string): { packageName: string; version?: string } {
  const separator = value.lastIndexOf("@");
  const scopedName = value.startsWith("@") && separator === 0;
  if (separator <= 0 || scopedName) return { packageName: value };
  const packageName = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!packageName || !version) throw new Error("Package names must use name or name@version.");
  return { packageName, version };
}

async function readProbeArtifactIdentity(directory: string): Promise<ProbeArtifactIdentity | undefined> {
  try {
    const details = await stat(path.join(directory, "behaviors.json"));
    if (!details.isFile() || details.size > MAX_PROBE_ARTIFACT_BYTES) return undefined;
    const artifact: unknown = JSON.parse(await readFile(path.join(directory, "behaviors.json"), "utf8"));
    if (
      !isRecord(artifact) ||
      typeof artifact.packageName !== "string" ||
      typeof artifact.version !== "string" ||
      (artifact.sourceTarballSha512 !== undefined && typeof artifact.sourceTarballSha512 !== "string")
    ) {
      return undefined;
    }
    return {
      packageName: artifact.packageName,
      version: artifact.version,
      ...(typeof artifact.sourceTarballSha512 === "string" ? { sourceTarballSha512: artifact.sourceTarballSha512 } : {})
    };
  } catch {
    return undefined;
  }
}

export async function findLatestProbeArtifactForPackage(packageName: string, version?: string, sourceTarballSha512?: string): Promise<string | undefined> {
  const prefix = version ? `${artifactPrefix(packageName, version)}-` : undefined;
  let entries: string[];
  try {
    entries = await readdir(probeArtifactsDirectory());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const eligible = entries.filter((entry) => !prefix || entry.startsWith(prefix));
  const candidates: Array<{ directory: string; modified: number }> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CACHE_LOOKUPS, eligible.length) }, async () => {
      while (next < eligible.length) {
        const entry = eligible[next];
        next += 1;
        const directory = path.join(probeArtifactsDirectory(), entry);
        try {
          const details = await stat(path.join(directory, "behaviors.json"));
          if (!details.isFile() || details.size > MAX_PROBE_ARTIFACT_BYTES) continue;
          const artifact = await readProbeArtifactIdentity(directory);
          if (
            artifact?.packageName === packageName &&
            (version === undefined || artifact.version === version) &&
            (sourceTarballSha512 === undefined || artifact.sourceTarballSha512 === sourceTarballSha512)
          ) {
            candidates.push({ directory, modified: details.mtimeMs });
          }
        } catch {
          continue;
        }
      }
    })
  );
  return candidates
    .sort((left, right) => right.modified - left.modified)[0]?.directory;
}

export async function findLatestProbeArtifact(packageName: string, version: string, sourceTarballSha512?: string): Promise<string | undefined> {
  return findLatestProbeArtifactForPackage(packageName, version, sourceTarballSha512);
}

export async function createProbeArtifactDirectory(packageName: string, version: string, output?: string): Promise<string> {
  if (output) {
    const directory = path.resolve(output);
    await mkdir(directory, { recursive: true });
    return directory;
  }
  const directory = probeArtifactsDirectory();
  await mkdir(directory, { recursive: true });
  return mkdtemp(path.join(directory, `${artifactPrefix(packageName, version)}-`));
}
