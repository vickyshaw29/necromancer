import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./json.js";

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

function probeArtifactsDirectory(): string {
  return path.join(process.cwd(), ".necromancer-cache", "probes");
}

function artifactPrefix(packageName: string, version: string): string {
  const readable = safeArtifactName(`${packageName}-${version}`);
  const hash = createHash("sha256").update(`${packageName}@${version}`).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

function matchesArtifact(value: unknown, packageName: string, version: string): boolean {
  return isRecord(value) && value.packageName === packageName && value.version === version;
}

export async function findLatestProbeArtifact(packageName: string, version: string): Promise<string | undefined> {
  const prefix = `${artifactPrefix(packageName, version)}-`;
  let entries: string[];
  try {
    entries = await readdir(probeArtifactsDirectory());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const directory = path.join(probeArtifactsDirectory(), entry);
        try {
          const details = await stat(path.join(directory, "behaviors.json"));
          if (!details.isFile()) return undefined;
          const artifact: unknown = JSON.parse(await readFile(path.join(directory, "behaviors.json"), "utf8"));
          return matchesArtifact(artifact, packageName, version) ? { directory, modified: details.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      })
  );
  return candidates
    .filter((candidate): candidate is { directory: string; modified: number } => candidate !== undefined)
    .sort((left, right) => right.modified - left.modified)[0]?.directory;
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
