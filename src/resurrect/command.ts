import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createProbeArtifactDirectory, findLatestProbeArtifact } from "../artifacts.js";
import { distillArtifact, readProbeArtifact } from "../distill/index.js";
import { probeIntoArtifact } from "../distill/command.js";
import { discardExhumedPackage, exhume, reportOutOfScope } from "../exhume/index.js";
import { loadDotEnv } from "../probe/index.js";
import { createReport, integritySummary, ReportResult, unobservedBoundary } from "../report/index.js";
import { RebuildEngineUnavailableError, selectRebuildGenerator } from "./engines.js";
import { resurrectArtifact } from "./loop.js";
import { RebuildEnginePreference, ResurrectionResult } from "./types.js";
import { printBanner, printPhase, printReproducibilityHandoff, printResurrectionEngineSetup, printResurrectionEvent, printSuccess } from "../terminal.js";

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
  const advisories = result.advisoryCount ?? 0;
  const aliases = result.cveCount ?? 0;
  return `${advisories} published OSV ${advisories === 1 ? "advisory" : "advisories"}${aliases ? `; ${aliases} CVE ${aliases === 1 ? "alias" : "aliases"}` : ""}`;
}

function identifierSummary(result: ReportResult["data"]["originalOsv"]): string {
  if (result.status === "unknown") return "";
  const identifiers = result.identifiers ?? [];
  return identifiers.length > 0 ? `; returned identifiers: ${identifiers.join(", ")}` : "";
}

function originalOsvSummary(report: ReportResult): string {
  const { packageName, version, originalOsv } = report.data;
  return `${osvSummary(originalOsv)} — published advisory metadata for original ${packageName}@${version}, queried at report time${identifierSummary(originalOsv)}; not source-code analysis`;
}

function rebuiltOsvSummary(report: ReportResult): string {
  const { rebuiltOsv, after } = report.data;
  const scanned = rebuiltOsv.scannedDependencyCount ?? after.runtimeDependencies;
  const scope = `${scanned} declared rebuild runtime dependencies scanned`;
  if (rebuiltOsv.status === "unknown") return `unknown, OSV unreachable — ${scope}`;
  if ((rebuiltOsv.advisoryCount ?? 0) === 0) {
    return `no published OSV advisories returned across ${scanned} declared runtime dependencies — ${scope}${scanned === 0 ? "; no network request made" : ""}; does not analyze generated code or establish CVE remediation`;
  }
  return `${osvSummary(rebuiltOsv)} — ${scope}${identifierSummary(rebuiltOsv)}; does not analyze generated code or establish CVE remediation`;
}

function lastRitesSummary(result: ResurrectionResult): string {
  if (!result.lastRites) return "not recorded";
  if (result.lastRites.total === 0) return "no eligible held-out cases";
  return `${result.lastRites.passed} of ${result.lastRites.total} held-out behaviors passing`;
}

function printReportSummary(report: ReportResult): void {
  const { artifact, resurrection, before, after } = report.data;
  const rows: Array<[string, string]> = [
    ["Final generator", resurrection.engine],
    ["Observed fidelity", `${resurrection.passed} of ${resurrection.total} observed behaviors, ${artifact.coverage.branchCoverage.toFixed(2)}% branch coverage of the original`],
    ["Last Rites", lastRitesSummary(resurrection)],
    ["Unobserved boundary", unobservedBoundary(artifact.coverage).uncoveredBranchStatement],
    ["Published advisories — original", originalOsvSummary(report)],
    ["Declared-dependency advisories — rebuild", rebuiltOsvSummary(report)],
    ["Runtime dependencies", `${before.runtimeDependencies} → ${after.runtimeDependencies}`],
    ["Source LOC", `${before.loc.toLocaleString()} → ${after.loc.toLocaleString()}`],
    ["Provenance", `${report.provenancePath} — ${integritySummary(report.data.provenance)}`],
    ["Result JSON", resurrection.resultPath],
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
  /** Explicitly use the reduced-isolation runner from a disposable VM. */
  noDocker?: boolean;
}

export function resurrectEngine(value: string): RebuildEnginePreference {
  if (value === "auto" || value === "api" || value === "codex") return value;
  throw new Error("--engine must be one of: auto, api, codex.");
}

export function printReconstructionConclusion(result: ResurrectionResult): void {
  if (!result.complete && result.total > 0 && result.passed === 0) {
    console.log("\nReconstruction report written; no observed behavior was reproduced.");
    return;
  }
  printSuccess(result.complete ? "Reconstruction report written." : "Reconstruction report written; some observed behaviors still differ.");
}

export async function runResurrectCommand(pkg: string, options: ResurrectCommandOptions): Promise<void> {
  await loadDotEnv();
  printBanner();
  let generator;
  try {
    generator = await selectRebuildGenerator(options.engine);
  } catch (error) {
    if (error instanceof RebuildEngineUnavailableError) {
      console.error(`[RESURRECT] ${error.message}`);
      printResurrectionEngineSetup();
      process.exitCode = 4;
      return;
    }
    throw error;
  }
  printPhase(1, "EXHUME", "Fetching npm tarball and performing static triage…");
  const exhumed = await exhume(pkg);
  try {
    console.log(`  Package              ${exhumed.manifest.name}@${exhumed.manifest.version}`);
    console.log(`  Verdict              ${exhumed.triage.verdict}`);
    if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
      reportOutOfScope(exhumed.triage.reasons);
      return;
    }

    let artifactDirectory = await findLatestProbeArtifact(
      exhumed.manifest.name,
      exhumed.manifest.version,
      exhumed.original.localTarballSha512
    );
    if (!artifactDirectory) {
      artifactDirectory = await createProbeArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version);
      await probeIntoArtifact(
        exhumed.manifest.name,
        exhumed.manifest.version,
        exhumed.packagePath,
        artifactDirectory,
        options,
        exhumed.original.localTarballSha512
      );
    } else {
      printPhase(3, "PROBE", `Reusing ${path.join(artifactDirectory, "behaviors.json")}`);
    }
    const artifact = await readProbeArtifact(path.join(artifactDirectory, "behaviors.json"));
    let soulWriterEngine: string | undefined;
    if (!(await hasDistilledFiles(artifactDirectory))) {
      printPhase(4, "DISTILL", "Writing SOUL.md and deterministic characterization tests…");
      const distillation = await distillArtifact(artifact, exhumed.packagePath, artifactDirectory, {
        engine: options.engine,
        onNotice: (message) => console.error(message)
      });
      soulWriterEngine = distillation.engine;
    } else {
      printPhase(4, "DISTILL", "Reusing SOUL.md and soul.test.ts.");
    }
    printPhase(5, "RESURRECT", "Rebuilding from observed behavior…");
    const result = await resurrectArtifact({ artifact, artifactDirectory }, generator, {
      onEvent: printResurrectionEvent,
      allowReducedIsolation: options.noDocker === true,
      noDocker: options.noDocker === true
    });
    printPhase(6, "REPORT", "Collecting compatibility, dependency, and advisory evidence…");
    const report = await createReport({
      packageName: exhumed.manifest.name,
      version: exhumed.manifest.version,
      artifact,
      triage: exhumed.triage,
      original: exhumed.original,
      resurrection: result,
      artifactDirectory,
      soulWriterEngine
    });
    printReportSummary(report);
    console.log(`Artifact directory: ${artifactDirectory}`);
    printReproducibilityHandoff(artifactDirectory, true, true);
    printReconstructionConclusion(result);
    if (!result.complete) process.exitCode = 3;
  } finally {
    await discardExhumedPackage(exhumed);
  }
}
