import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { discardExhumedPackage, exhume, ScopeReason } from "../exhume/index.js";
import { loadDotEnv, probePackage, ProbeEnginePreference } from "../probe/index.js";
import { createSandboxRunner, SandboxRunner } from "../sandbox/index.js";
import { readProbeArtifact } from "./artifact.js";
import { distillArtifact } from "./index.js";
import { DistillEnginePreference } from "./types.js";

type CommandEngine = DistillEnginePreference & ProbeEnginePreference;

function scopeMessage(reasons: ScopeReason[]): string {
  const detail = reasons.map((reason) => reason.message).join("; ");
  return [
    `This corpse is beyond v1 necromancy: ${detail}.`,
    "v1 supports small (<=2,000 LOC), pure-JS, mostly-pure npm packages with <=3 runtime dependencies."
  ].join(" ");
}

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

function artifactsBase(): string {
  return path.join(process.cwd(), ".necromancer-cache", "probes");
}

async function latestArtifact(packageName: string, version: string): Promise<string | undefined> {
  const prefix = `${safeArtifactName(`${packageName}-${version}`)}-`;
  let entries: string[];
  try {
    entries = await readdir(artifactsBase());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const directory = path.join(artifactsBase(), entry);
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

async function newArtifactDirectory(packageName: string, version: string): Promise<string> {
  const base = artifactsBase();
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${safeArtifactName(`${packageName}-${version}`)}-`));
}

async function probeIntoArtifact(
  packageName: string,
  packagePath: string,
  artifactDirectory: string,
  options: DistillCommandOptions
): Promise<void> {
  const coverageDirectory = path.join(artifactDirectory, ".v8-coverage");
  let sandbox: SandboxRunner | undefined;
  try {
    console.log("[2/6] SANDBOX     Preparing child-process instrumentation for coverage…");
    sandbox = await createSandboxRunner(
      { packageName, packagePath },
      { coverageDirectory, onWarning: (message) => console.error(message) }
    );
    console.log("[3/6] PROBE       Discovering deterministic observed behaviors…");
    const maxBehaviors = options.fast ? Math.min(options.maxBehaviors, 60) : options.maxBehaviors;
    await probePackage(
      { packageName, packagePath, sandbox, artifactDirectory },
      { maxBehaviors, fast: options.fast, engine: options.engine, onNotice: (message) => console.error(message) }
    );
  } finally {
    await sandbox?.dispose();
  }
}

export interface DistillCommandOptions {
  maxBehaviors: number;
  fast?: boolean;
  engine: CommandEngine;
}

export function distillEngine(value: string): CommandEngine {
  if (value === "auto" || value === "api" || value === "codex" || value === "heuristic") return value;
  throw new Error("--engine must be one of: auto, api, codex, heuristic.");
}

export async function runDistillCommand(pkg: string, options: DistillCommandOptions): Promise<void> {
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

    let artifactDirectory = await latestArtifact(exhumed.manifest.name, exhumed.manifest.version);
    if (artifactDirectory) {
      console.log(`[3/6] PROBE       Reusing ${path.join(artifactDirectory, "behaviors.json")}`);
    } else {
      artifactDirectory = await newArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version);
      await probeIntoArtifact(exhumed.manifest.name, exhumed.packagePath, artifactDirectory, options);
    }
    const artifact = await readProbeArtifact(path.join(artifactDirectory, "behaviors.json"));
    console.log("[4/6] DISTILL     Writing SOUL.md and deterministic characterization tests…");
    const result = await distillArtifact(artifact, exhumed.packagePath, artifactDirectory, {
      engine: options.engine,
      onNotice: (message) => console.error(message)
    });
    console.log(`DISTILL writer: ${result.engine}`);
    console.log(`Artifacts: ${result.soulPath}, ${result.testPath}`);
    console.log("[5/6] RESURRECT   queued for Milestone 5");
    console.log("[6/6] REPORT      queued for Milestone 6");
  } finally {
    await discardExhumedPackage(exhumed);
  }
}
