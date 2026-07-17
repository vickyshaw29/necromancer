import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isRecord } from "../json.js";
import { CoverageSummary } from "../probe/index.js";
import { AuthoredSourceFile, ProvenanceReceipt, ReportEvidence, UnobservedBoundary } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const CLAIM_BOUNDARY = "Behavior outside the observed coverage is not claimed." as const;

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function sourceFiles(directory: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(filePath, files);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(filePath);
  }
  return files;
}

async function authoredSourceFiles(rebuiltDirectory: string): Promise<AuthoredSourceFile[]> {
  const sourceDirectory = path.join(rebuiltDirectory, "src");
  const files = await sourceFiles(sourceDirectory);
  return Promise.all(
    files.map(async (filePath) => ({
      path: path.relative(rebuiltDirectory, filePath).split(path.sep).join("/"),
      sha256: await sha256File(filePath)
    }))
  );
}

async function necromancerVersion(): Promise<string> {
  const manifestPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  return isRecord(value) && typeof value.version === "string" ? value.version : "unknown";
}

async function probeEngine(artifactDirectory: string): Promise<string> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(artifactDirectory, "behaviors.json"), "utf8"));
    return isRecord(value) && typeof value.engine === "string" ? value.engine : "unknown";
  } catch {
    return "unknown";
  }
}

export function unobservedBoundary(coverage: CoverageSummary): UnobservedBoundary {
  const total = coverage.branchTotal;
  const covered = coverage.branchCovered;
  if (
    typeof total !== "number" ||
    typeof covered !== "number" ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(covered) ||
    total < 0 ||
    covered < 0 ||
    covered > total
  ) {
    return {
      branchCoveragePercent: coverage.branchCoverage,
      branchTotals: "unavailable",
      uncoveredBranchStatement: "branch totals unavailable",
      claimBoundary: CLAIM_BOUNDARY
    };
  }
  const uncovered = total - covered;
  return {
    branchCoveragePercent: coverage.branchCoverage,
    branchTotals: { total, covered, uncovered },
    uncoveredBranchStatement: `${uncovered} of ${total} original branches were never exercised — behavior there is not claimed`,
    claimBoundary: CLAIM_BOUNDARY
  };
}

export function integritySummary(receipt: ProvenanceReceipt): string {
  if (receipt.original.integrityMatch === "verified") return "registry integrity verified";
  if (receipt.original.integrityMatch === "mismatch") return "registry integrity mismatch";
  return "registry integrity unknown";
}

export async function writeProvenance(
  data: ReportEvidence,
  original: ProvenanceReceipt["original"],
  artifactDirectory: string,
  soulWriterEngine: string | undefined
): Promise<{ provenance: ProvenanceReceipt; provenancePath: string }> {
  const rebuiltDirectory = path.join(artifactDirectory, "rebuilt");
  const [soulSha256, soulTestSha256, authoredFiles, version, planner] = await Promise.all([
    sha256File(path.join(artifactDirectory, "SOUL.md")),
    sha256File(path.join(artifactDirectory, "soul.test.ts")),
    authoredSourceFiles(rebuiltDirectory),
    necromancerVersion(),
    probeEngine(artifactDirectory)
  ]);
  const provenance: ProvenanceReceipt = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    necromancerVersion: version,
    original,
    observation: {
      recordedBehaviorCount: data.artifact.behaviors.length,
      branchCoveragePercent: data.artifact.coverage.branchCoverage,
      probeEngine: planner,
      artifactDirectoryName: path.basename(path.resolve(artifactDirectory))
    },
    distillation: { soulSha256, soulTestSha256, writerEngine: soulWriterEngine ?? "unknown" },
    resurrection: {
      engine: data.resurrection.engine,
      roundsExecuted: data.resurrection.rounds.length,
      passedObservedBehaviors: data.resurrection.passed,
      totalObservedBehaviors: data.resurrection.total,
      authoredSourceFiles: authoredFiles,
      rebuiltLoc: data.after.loc,
      declaredRuntimeDependencyCount: data.after.runtimeDependencies
    },
    quarantine: {
      originalSourceProvided: false,
      generatorInputs: ["SOUL", "characterization suite", "public API shape", "failure feedback"]
    },
    unobserved: unobservedBoundary(data.artifact.coverage)
  };
  const provenancePath = path.join(rebuiltDirectory, "provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  return { provenance, provenancePath };
}
