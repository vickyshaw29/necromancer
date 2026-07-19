import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderGraveyard } from "./report/html.js";
import type { ReportData } from "./report/types.js";

export interface ReplayOptions {
  output?: string;
}

export interface ReplayResult {
  outputDirectory: string;
  reportPath: string;
  provenancePath: string;
}

function replayData(outputDirectory: string): ReportData {
  const resurrection = {
    packageName: "replay-fixture",
    engine: "offline-fixture",
    rounds: [{ round: 1, passed: 3, total: 3, failedIds: [] }],
    passed: 3,
    total: 3,
    complete: true,
    lastRites: { passed: 1, total: 1 },
    resultPath: path.join(outputDirectory, "rebuilt", "result.json")
  };
  return {
    replay: true,
    packageName: "replay-fixture",
    version: "0.0.0",
    artifact: {
      packageName: "replay-fixture",
      behaviors: [
        { id: "behavior-0001", fn: "replay-fixture", args: [], result: "empty input" },
        { id: "behavior-0002", fn: "replay-fixture", args: ["x"], result: "x" },
        { id: "behavior-0003", fn: "replay-fixture", args: ["x", "y"], result: "x:y" }
      ],
      argumentShapeCoverage: [{ fn: "replay-fixture", requiredArgumentCounts: [0, 1, 2, 3], observedArgumentCounts: [0, 1, 2], complete: false }],
      coverage: { branchCoverage: 66.67, branchTotal: 3, branchCovered: 2, lineCoverage: 75, functionCoverage: 50, statementCoverage: 75, available: true }
    },
    resurrection,
    before: { loc: 12, runtimeDependencies: 1 },
    after: { loc: 7, runtimeDependencies: 0, declaredRuntimeDependencies: [] },
    originalOsv: { status: "known", advisoryCount: 0, cveCount: 0, identifiers: [] },
    rebuiltOsv: { status: "known", advisoryCount: 0, cveCount: 0, identifiers: [], scannedDependencyCount: 0 },
    soul: "# SOUL — replay-fixture\n\n## Behavioral clusters\n\n### `replay-fixture`\n\n- Evidence: `behavior-0001`, `behavior-0002`, `behavior-0003`.\n\n## Quirks\n\n- **Two-argument fixture** — `replay-fixture` with `[\"x\", \"y\"]` returned \"x:y\". Evidence: `behavior-0003`.\n",
    provenance: {
      schemaVersion: 1,
      generatedAt: "2026-07-19T00:00:00.000Z",
      necromancerVersion: "fixture",
      original: {
        name: "replay-fixture",
        version: "0.0.0",
        registryTarballUrl: "not-fetched",
        registryDeclaredIntegrity: { integrity: "unknown", shasum: "unknown" },
        localTarballSha512: "unknown",
        integrityMatch: "unknown",
        detectedLicense: "fixture",
        sourceLoc: 12,
        resolvedRuntimeDependencyCount: 1
      },
      observation: {
        recordedBehaviorCount: 3,
        branchCoveragePercent: 66.67,
        lineCoveragePercent: 75,
        functionCoveragePercent: 50,
        observedArgumentCounts: [0, 1, 2],
        callsWithTwoOrMoreArguments: 1,
        argumentShapeCompleteness: { completeFunctions: 0, measuredFunctions: 1 },
        heldOutValidation: { passed: 1, total: 1 },
        probeEngine: "offline-fixture",
        artifactDirectoryName: "replay"
      },
      distillation: { soulSha256: "not-applicable", soulTestSha256: "not-applicable", writerEngine: "offline-fixture" },
      resurrection: {
        engine: "offline-fixture",
        roundsExecuted: 1,
        passedObservedBehaviors: 3,
        totalObservedBehaviors: 3,
        authoredSourceFiles: [],
        rebuiltLoc: 7,
        declaredRuntimeDependencyCount: 0
      },
      quarantine: {
        originalSourceProvided: false,
        generatorInputs: ["SOUL", "characterization suite", "public API shape", "failure feedback"]
      },
      unobserved: {
        branchCoveragePercent: 66.67,
        branchTotals: { total: 3, covered: 2, uncovered: 1 },
        uncoveredBranchStatement: "1 of 3 fictional original branches was never exercised — behavior there is not claimed",
        claimBoundary: "Behavior outside the observed coverage is not claimed."
      }
    }
  };
}

function replayOutputDirectory(output: string | undefined): string {
  return path.resolve(output ?? path.join(process.cwd(), ".necromancer-cache", "replay"));
}

export async function writeReplayReport(options: ReplayOptions = {}): Promise<ReplayResult> {
  const outputDirectory = replayOutputDirectory(options.output);
  const provenancePath = path.join(outputDirectory, "rebuilt", "provenance.json");
  const reportPath = path.join(outputDirectory, "replay.html");
  try {
    await mkdir(path.dirname(provenancePath), { recursive: true });
    const data = replayData(outputDirectory);
    const provenance = {
      ...data.provenance,
      fixture: true,
      purpose: "Offline report UX replay only; not a package reconstruction receipt."
    };
    await Promise.all([
      writeFile(reportPath, renderGraveyard(data), "utf8"),
      writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8")
    ]);
  } catch {
    throw new Error(`Could not write the offline replay under ${outputDirectory}. Choose a writable directory with --output.`);
  }
  return { outputDirectory, reportPath, provenancePath };
}
