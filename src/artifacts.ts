import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import path from "node:path";

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

function probeArtifactsDirectory(): string {
  return path.join(process.cwd(), ".necromancer-cache", "probes");
}

export async function findLatestProbeArtifact(packageName: string, version: string): Promise<string | undefined> {
  const prefix = `${safeArtifactName(`${packageName}-${version}`)}-`;
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
          return details.isFile() ? { directory, modified: details.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      })
  );
  return candidates
    .filter((candidate): candidate is { directory: string; modified: number } => candidate !== undefined)
    .sort((left, right) => right.modified - left.modified)[0]?.directory;
}

export async function createProbeArtifactDirectory(packageName: string, version: string): Promise<string> {
  const directory = probeArtifactsDirectory();
  await mkdir(directory, { recursive: true });
  return mkdtemp(path.join(directory, `${safeArtifactName(`${packageName}-${version}`)}-`));
}
