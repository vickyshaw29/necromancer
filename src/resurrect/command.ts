import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createProbeArtifactDirectory, findLatestProbeArtifact } from "../artifacts.js";
import { distillArtifact, readProbeArtifact } from "../distill/index.js";
import { probeIntoArtifact } from "../distill/command.js";
import { discardExhumedPackage, exhume, ScopeReason } from "../exhume/index.js";
import { loadDotEnv } from "../probe/index.js";
import { RebuildEngineUnavailableError, selectRebuildGenerator } from "./engines.js";
import { resurrectArtifact } from "./loop.js";
import { RebuildEnginePreference } from "./types.js";

function scopeMessage(reasons: ScopeReason[]): string {
  const detail = reasons.map((reason) => reason.message).join("; ");
  return [
    `This corpse is beyond v1 necromancy: ${detail}.`,
    "v1 supports small (<=2,000 LOC), pure-JS, mostly-pure npm packages with <=3 runtime dependencies."
  ].join(" ");
}

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
  console.log("💀 NECROMANCER");
  console.log("[1/6] EXHUME      Fetching npm tarball and performing static triage…");
  const exhumed = await exhume(pkg);
  try {
    console.log(`  Package              ${exhumed.manifest.name}@${exhumed.manifest.version}`);
    console.log(`  Verdict              ${exhumed.triage.verdict}`);
    if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
      console.log(`\nOUT_OF_SCOPE — ${scopeMessage(exhumed.triage.reasons)}`);
      process.exitCode = 2;
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
      await probeIntoArtifact(exhumed.manifest.name, exhumed.packagePath, artifactDirectory, options);
    } else {
      console.log(`[3/6] PROBE       Reusing ${path.join(artifactDirectory, "behaviors.json")}`);
    }
    const artifact = await readProbeArtifact(path.join(artifactDirectory, "behaviors.json"));
    if (!(await hasDistilledFiles(artifactDirectory))) {
      console.log("[4/6] DISTILL     Writing SOUL.md and deterministic characterization tests…");
      await distillArtifact(artifact, exhumed.packagePath, artifactDirectory, { engine: options.engine, onNotice: (message) => console.error(message) });
    } else {
      console.log("[4/6] DISTILL     Reusing SOUL.md and soul.test.ts.");
    }
    console.log("[5/6] RESURRECT   Rebuilding from observed behavior…");
    const result = await resurrectArtifact({ artifact, artifactDirectory }, generator);
    console.log(
      `rebuilt passes ${result.passed} of ${result.total} observed behaviors (${artifact.coverage.branchCoverage.toFixed(2)}% branch coverage of the original)`
    );
    console.log(`Resurrection artifact: ${result.resultPath}`);
    console.log("[6/6] REPORT      queued for Milestone 6");
    if (!result.complete) process.exitCode = 3;
  } finally {
    await discardExhumedPackage(exhumed);
  }
}
