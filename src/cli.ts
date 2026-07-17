#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { distillEngine, runDistillCommand } from "./distill/command.js";
import { discardExhumedPackage, exhume, ScopeReason, TriageResult } from "./exhume/index.js";
import { loadDotEnv, probePackage, ProbeEnginePreference } from "./probe/index.js";
import { resurrectEngine, runResurrectCommand } from "./resurrect/command.js";
import { createSandboxRunner, SandboxRunner } from "./sandbox/index.js";

function marker(value: boolean): string {
  return value ? "detected" : "none";
}

function printTriage(name: string, version: string, triage: TriageResult): void {
  const rows: Array<[string, string]> = [
    ["Package", `${name}@${version}`],
    ["Source LOC", triage.loc.toLocaleString()],
    ["Runtime dependencies", String(triage.runtimeDependencyCount)],
    ["Native module markers", marker(triage.nativeEvidence.length > 0)],
    ["Filesystem imports", marker(triage.filesystemImports.length > 0)],
    ["Network imports", marker(triage.networkImports.length > 0)],
    ["Verdict", triage.verdict]
  ];
  const width = Math.max(...rows.map(([label]) => label.length));

  console.log("\nEXHUME triage");
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`);

  if (triage.nativeEvidence.length > 0) console.log(`  Native evidence        ${triage.nativeEvidence.join(", ")}`);
  if (triage.filesystemImports.length > 0) console.log(`  Filesystem evidence    ${triage.filesystemImports.join(", ")}`);
  if (triage.networkImports.length > 0) console.log(`  Network evidence       ${triage.networkImports.join(", ")}`);
}

function scopeMessage(reasons: ScopeReason[]): string {
  const detail = reasons.map((reason) => reason.message).join("; ");
  return [
    `This corpse is beyond v1 necromancy: ${detail}.`,
    "v1 supports small (<=2,000 LOC), pure-JS, mostly-pure npm packages with <=3 runtime dependencies."
  ].join(" ");
}

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--max-behaviors must be a positive integer.");
  return parsed;
}

function probeEngine(value: string): ProbeEnginePreference {
  if (value === "auto" || value === "api" || value === "codex" || value === "heuristic") return value;
  throw new Error("--engine must be one of: auto, api, codex, heuristic.");
}

function safeArtifactName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

async function probeArtifactDirectory(packageName: string, version: string, output?: string): Promise<string> {
  if (output) {
    const directory = path.resolve(output);
    await mkdir(directory, { recursive: true });
    return directory;
  }
  const base = path.join(process.cwd(), ".necromancer-cache", "probes");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${safeArtifactName(`${packageName}-${version}`)}-`));
}

async function runProbeCommand(
  pkg: string,
  options: { maxBehaviors: number; fast?: boolean; engine: ProbeEnginePreference; output?: string }
): Promise<void> {
  await loadDotEnv();
  console.log("💀 NECROMANCER");
  console.log("[1/6] EXHUME      Fetching npm tarball and performing static triage…");
  const exhumed = await exhume(pkg);
  let sandbox: SandboxRunner | undefined;
  try {
    printTriage(exhumed.manifest.name, exhumed.manifest.version, exhumed.triage);
    if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
      console.log(`\nOUT_OF_SCOPE — ${scopeMessage(exhumed.triage.reasons)}`);
      process.exitCode = 2;
      return;
    }

    const artifactDirectory = await probeArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version, options.output);
    const coverageDirectory = path.join(artifactDirectory, ".v8-coverage");
    console.log("\n[2/6] SANDBOX     Preparing child-process instrumentation for coverage…");
    sandbox = await createSandboxRunner(
      { packagePath: exhumed.packagePath, packageName: exhumed.manifest.name },
      { coverageDirectory, onWarning: (message) => console.error(message) }
    );
    console.log("[3/6] PROBE        Discovering exports, examples, and deterministic behaviors…");
    const maxBehaviors = options.fast ? Math.min(options.maxBehaviors, 60) : options.maxBehaviors;
    const result = await probePackage(
      {
        packageName: exhumed.manifest.name,
        packagePath: exhumed.packagePath,
        sandbox,
        artifactDirectory
      },
      { maxBehaviors, fast: options.fast, engine: options.engine, onNotice: (message) => console.error(message) }
    );
    if (result.coverage.available) {
      console.log(
        `\n${result.behaviors.length} deterministic behaviors recorded, ${result.coverage.branchCoverage.toFixed(2)}% branch coverage of original.`
      );
    } else {
      console.log(`\n${result.behaviors.length} deterministic behaviors recorded; branch coverage of original is unavailable: ${result.coverage.detail}`);
    }
    console.log(`Input planner: ${result.engine}`);
    console.log(`Artifacts: ${result.artifactPath}`);
    console.log("[4/6] DISTILL     available: necromancer distill <pkg>");
    console.log("[5/6] RESURRECT   available: necromancer resurrect <pkg>");
    console.log("[6/6] REPORT      queued for Milestone 6");
  } finally {
    await sandbox?.dispose();
    await discardExhumedPackage(exhumed);
  }
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("necromancer")
    .description("Resurrect abandoned JavaScript packages from observed behavior.")
    .argument("<pkg>", "npm package name, optionally with @version")
    .option("--keep-workspace", "keep the temporary EXHUME workspace for inspection")
    .option("--no-docker", "use the reduced-isolation child-process sandbox")
    .action(async (pkg: string, options: { keepWorkspace?: boolean; docker?: boolean }) => {
      console.log("💀 NECROMANCER");
      console.log("[1/6] EXHUME      Fetching npm tarball and performing static triage…");

      const exhumed = await exhume(pkg);
      let sandbox: SandboxRunner | undefined;
      try {
        printTriage(exhumed.manifest.name, exhumed.manifest.version, exhumed.triage);
        if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
          console.log(`\nOUT_OF_SCOPE — ${scopeMessage(exhumed.triage.reasons)}`);
          process.exitCode = 2;
          return;
        }

        console.log("\nIN_SCOPE — static triage passed.");
        console.log("[2/6] SANDBOX     Installing package in an isolated runner…");
        sandbox = await createSandboxRunner(
          { packagePath: exhumed.packagePath, packageName: exhumed.manifest.name },
          {
            noDocker: options.docker === false,
            onWarning: (message) => console.error(message)
          }
        );
        console.log(`[2/6] SANDBOX     Ready (${sandbox.mode} runner).`);
        console.log("[3/6] PROBE       queued for Milestone 3");
        console.log("[4/6] DISTILL     available: necromancer distill <pkg>");
        console.log("[5/6] RESURRECT   available: necromancer resurrect <pkg>");
        console.log("[6/6] REPORT      queued for Milestone 6");
        if (options.keepWorkspace) console.log(`\nEXHUME workspace retained: ${exhumed.workspacePath}`);
      } finally {
        await sandbox?.dispose();
        if (!options.keepWorkspace) await discardExhumedPackage(exhumed);
      }
    });

  program
    .command("probe <pkg>")
    .description("record deterministic observed behavior from an in-scope npm package")
    .option("--max-behaviors <count>", "maximum deterministic behaviors to record", positiveInteger, 80)
    .option("--fast", "cap the probe at 60 behaviors")
    .option("--engine <engine>", "input planner: auto, api, codex, or heuristic", probeEngine, "auto")
    .option("--output <directory>", "directory for behaviors.json and coverage artifacts")
    .action(runProbeCommand);

  program
    .command("distill <pkg>")
    .description("write a SOUL.md and deterministic tests from observed package behavior")
    .option("--max-behaviors <count>", "maximum deterministic behaviors when a probe is needed", positiveInteger, 80)
    .option("--fast", "cap an automatically-run probe at 60 behaviors")
    .option("--engine <engine>", "prose and input planner: auto, api, codex, or heuristic", distillEngine, "auto")
    .action(runDistillCommand);

  program
    .command("resurrect <pkg>")
    .description("rebuild a package from its distilled observed behavior")
    .option("--max-behaviors <count>", "maximum deterministic behaviors when a probe is needed", positiveInteger, 80)
    .option("--fast", "cap an automatically-run probe at 60 behaviors")
    .option("--engine <engine>", "rebuild engine: auto, api, or codex", resurrectEngine, "auto")
    .action(runResurrectCommand);

  await program.parseAsync(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    console.error(`Necromancer could not complete this package: ${message}`);
    process.exitCode = 1;
  });
}
