import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createProbeArtifactDirectory, findLatestProbeArtifact } from "../artifacts.js";
import { distillArtifact, readProbeArtifact } from "../distill/index.js";
import { probeIntoArtifact } from "../distill/command.js";
import { discardExhumedPackage, exhume, reportOutOfScope } from "../exhume/index.js";
import { loadDotEnv } from "../probe/index.js";
import { createReport, ReportResult } from "../report/index.js";
import { RebuildEngineUnavailableError, selectRebuildGenerator } from "./engines.js";
import { resurrectArtifact } from "./loop.js";
import { RebuildEnginePreference } from "./types.js";
import { printBanner, printPhase, printSuccess } from "../terminal.js";

async function readable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasDistilledFiles(artifactDirectory: string): Promise<boolean> {
  const [soul, test] = await Promise.all([readable(path.join(artifactDirectory, "SOUL.md")), readable(path.join(artifactDirectory, "soul.test.ts"))]);
  return soul && test;
}

function osvSummary(result: ReportResult["data"]["originalOsv"]): string {
  if (result.status === "unknown") return "unknown, OSV unreachable";
  return `${result.cveCount ?? 0} CVE aliases across ${result.advisoryCount ?? 0} OSV advisories`;
}

function rebuiltOsvSummary(report: ReportResult): string {
  const { rebuiltOsv, after } = report.data;
  if (rebuiltOsv.status === "unknown") return "unknown, OSV unreachable";
  if ((rebuiltOsv.advisoryCount ?? 0) === 0) {
    return `no advisories found across ${rebuiltOsv.scannedDependencyCount ?? after.runtimeDependencies} runtime dependencies`;
  }
  return osvSummary(rebuiltOsv);
}

function printReportSummary(report: ReportResult): void {
  const { artifact, resurrection, before, after } = report.data;
  const rows: Array<[string, string]> = [
    ["Observed fidelity", `${resurrection.passed} of ${resurrection.total} observed behaviors, ${artifact.coverage.branchCoverage.toFixed(2)}% branch coverage of the original`],
    ["CVEs before", osvSummary(report.data.originalOsv)],
    ["CVEs after", rebuiltOsvSummary(report)],
    ["Runtime dependencies", `${before.runtimeDependencies} → ${after.runtimeDependencies}`],
    ["Source LOC", `${before.loc.toLocaleString()} → ${after.loc.toLocaleString()}`],
    ["Graveyard report", report.reportPath]
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  console.log("\nREPORT summary");
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`);
}

export interface ResurrectCommandOptions {
  maxBehaviors: number;
  fast?: boolean;
  engine: RebuildEnginePreference;
}

export function resurrectEngine(value: string): RebuildEnginePreference {
  if (value === "auto" || value === "api" || value === "codex") return value;
  throw new Error("--engine must be one of: auto, api, codex.");
}

export async function runResurrectCommand(pkg: string, options: ResurrectCommandOptions): Promise<void> {
  await loadDotEnv();
  printBanner();
  printPhase(1, "EXHUME", "Fetching npm tarball and performing static triage…");
  const exhumed = await exhume(pkg);
  try {
    console.log(`  Package              ${exhumed.manifest.name}@${exhumed.manifest.version}`);
    console.log(`  Verdict              ${exhumed.triage.verdict}`);
    if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
      reportOutOfScope(exhumed.triage.reasons);
      return;
    }

    let generator;
    try {
      generator = await selectRebuildGenerator(options.engine);
    } catch (error) {
      if (error instanceof RebuildEngineUnavailableError) {
        console.error(`[RESURRECT] ${error.message}`);
        process.exitCode = 4;
        return;
      }
      throw error;
    }

    let artifactDirectory = await findLatestProbeArtifact(exhumed.manifest.name, exhumed.manifest.version);
    if (!artifactDirectory) {
      artifactDirectory = await createProbeArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version);
      await probeIntoArtifact(exhumed.manifest.name, exhumed.manifest.version, exhumed.packagePath, artifactDirectory, options);
    } else {
      printPhase(3, "PROBE", `Reusing ${path.join(artifactDirectory, "behaviors.json")}`);
    }
    const artifact = await readProbeArtifact(path.join(artifactDirectory, "behaviors.json"));
    if (!(await hasDistilledFiles(artifactDirectory))) {
      printPhase(4, "DISTILL", "Writing SOUL.md and deterministic characterization tests…");
      await distillArtifact(artifact, exhumed.packagePath, artifactDirectory, { engine: options.engine, onNotice: (message) => console.error(message) });
    } else {
      printPhase(4, "DISTILL", "Reusing SOUL.md and soul.test.ts.");
    }
    printPhase(5, "RESURRECT", "Rebuilding from observed behavior…");
    const result = await resurrectArtifact({ artifact, artifactDirectory }, generator);
    printPhase(6, "REPORT", "Collecting compatibility, dependency, and advisory evidence…");
    const report = await createReport({
      packageName: exhumed.manifest.name,
      version: exhumed.manifest.version,
      artifact,
      triage: exhumed.triage,
      resurrection: result,
      artifactDirectory
    });
    printReportSummary(report);
    printSuccess(result.complete ? "Reconstruction report written." : "Reconstruction report written; some observed behaviors still differ.");
    if (!result.complete) process.exitCode = 3;
  } finally {
    await discardExhumedPackage(exhumed);
  }
}
