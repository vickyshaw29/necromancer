import path from "node:path";
import { createProbeArtifactDirectory, findLatestProbeArtifact } from "../artifacts.js";
import { discardExhumedPackage, exhume, reportOutOfScope } from "../exhume/index.js";
import { loadDotEnv, probePackage, ProbeEnginePreference } from "../probe/index.js";
import { createSandboxRunner, SandboxRunner } from "../sandbox/index.js";
import { printBanner, printPhase, printReproducibilityHandoff } from "../terminal.js";
import { readProbeArtifact } from "./artifact.js";
import { distillArtifact } from "./index.js";
import { DistillEnginePreference } from "./types.js";

type CommandEngine = DistillEnginePreference & ProbeEnginePreference;

export interface ProbeArtifactOptions {
  maxBehaviors: number;
  fast?: boolean;
  engine: ProbeEnginePreference;
  /** Explicitly use the reduced-isolation runner from a disposable VM. */
  noDocker?: boolean;
}

export async function probeIntoArtifact(
  packageName: string,
  version: string,
  packagePath: string,
  artifactDirectory: string,
  options: ProbeArtifactOptions,
  sourceTarballSha512?: string
): Promise<void> {
  const coverageDirectory = path.join(artifactDirectory, ".v8-coverage");
  let sandbox: SandboxRunner | undefined;
  try {
    printPhase(2, "SANDBOX", "Preparing child-process instrumentation for coverage…");
    sandbox = await createSandboxRunner(
      { packageName, packagePath },
      { coverageDirectory, noDocker: options.noDocker === true, onWarning: (message) => console.error(message) }
    );
    printPhase(3, "PROBE", "Discovering deterministic observed behaviors…");
    const maxBehaviors = options.fast ? Math.min(options.maxBehaviors, 60) : options.maxBehaviors;
    await probePackage(
      { packageName, version, sourceTarballSha512, packagePath, sandbox, artifactDirectory },
      { maxBehaviors, fast: options.fast, engine: options.engine, onNotice: (message) => console.error(message) }
    );
  } finally {
    await sandbox?.dispose();
  }
}

export interface DistillCommandOptions extends ProbeArtifactOptions {
  engine: CommandEngine;
}

export function distillEngine(value: string): CommandEngine {
  if (value === "auto" || value === "api" || value === "codex" || value === "heuristic") return value;
  throw new Error("--engine must be one of: auto, api, codex, heuristic.");
}

export async function runDistillCommand(pkg: string, options: DistillCommandOptions): Promise<void> {
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

    let artifactDirectory = await findLatestProbeArtifact(
      exhumed.manifest.name,
      exhumed.manifest.version,
      exhumed.original.localTarballSha512
    );
    if (artifactDirectory) {
      printPhase(3, "PROBE", `Reusing ${path.join(artifactDirectory, "behaviors.json")}`);
    } else {
      artifactDirectory = await createProbeArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version);
      await probeIntoArtifact(
        exhumed.manifest.name,
        exhumed.manifest.version,
        exhumed.packagePath,
        artifactDirectory,
        options,
        exhumed.original.localTarballSha512
      );
    }
    const artifact = await readProbeArtifact(path.join(artifactDirectory, "behaviors.json"));
    printPhase(4, "DISTILL", "Writing SOUL.md and deterministic characterization tests…");
    const result = await distillArtifact(artifact, exhumed.packagePath, artifactDirectory, {
      engine: options.engine,
      onNotice: (message) => console.error(message)
    });
    console.log(`DISTILL writer: ${result.engine}`);
    console.log(`Artifacts: ${result.soulPath}, ${result.testPath}`);
    console.log(`Artifact directory: ${artifactDirectory}`);
    printReproducibilityHandoff(artifactDirectory, true, false);
    printPhase(5, "RESURRECT", "Available: necromancer resurrect <pkg>");
    printPhase(6, "REPORT", "Available after resurrection.");
  } finally {
    await discardExhumedPackage(exhumed);
  }
}
