#!/usr/bin/env node
import { Command } from "commander";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createProbeArtifactDirectory } from "./artifacts.js";
import { distillEngine, runDistillCommand } from "./distill/command.js";
import { discardExhumedPackage, exhume, reportOutOfScope, TriageResult } from "./exhume/index.js";
import { loadDotEnv, probePackage, ProbeEnginePreference } from "./probe/index.js";
import { resurrectEngine, runResurrectCommand } from "./resurrect/command.js";
import { createSandboxRunner, SandboxRunner } from "./sandbox/index.js";
import { printBanner, printPhase } from "./terminal.js";

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

function positiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--max-behaviors must be a positive integer.");
  return parsed;
}

function probeEngine(value: string): ProbeEnginePreference {
  if (value === "auto" || value === "api" || value === "codex" || value === "heuristic") return value;
  throw new Error("--engine must be one of: auto, api, codex, heuristic.");
}

async function runProbeCommand(
  pkg: string,
  options: { maxBehaviors: number; fast?: boolean; engine: ProbeEnginePreference; output?: string }
): Promise<void> {
  await loadDotEnv();
  printBanner();
  printPhase(1, "EXHUME", "Fetching npm tarball and performing static triage…");
  const exhumed = await exhume(pkg);
  let sandbox: SandboxRunner | undefined;
  try {
    printTriage(exhumed.manifest.name, exhumed.manifest.version, exhumed.triage);
    if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
      reportOutOfScope(exhumed.triage.reasons);
      return;
    }

    const artifactDirectory = await createProbeArtifactDirectory(exhumed.manifest.name, exhumed.manifest.version, options.output);
    const coverageDirectory = path.join(artifactDirectory, ".v8-coverage");
    printPhase(2, "SANDBOX", "Preparing child-process instrumentation for coverage…");
    sandbox = await createSandboxRunner(
      { packagePath: exhumed.packagePath, packageName: exhumed.manifest.name },
      { coverageDirectory, onWarning: (message) => console.error(message) }
    );
    printPhase(3, "PROBE", "Discovering exports, examples, and deterministic behaviors…");
    const maxBehaviors = options.fast ? Math.min(options.maxBehaviors, 60) : options.maxBehaviors;
    const result = await probePackage(
      {
        packageName: exhumed.manifest.name,
        version: exhumed.manifest.version,
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
    printPhase(4, "DISTILL", "Available: necromancer distill <pkg>");
    printPhase(5, "RESURRECT", "Available: necromancer resurrect <pkg>");
    printPhase(6, "REPORT", "Available after resurrection.");
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
      printBanner();
      printPhase(1, "EXHUME", "Fetching npm tarball and performing static triage…");

      const exhumed = await exhume(pkg);
      let sandbox: SandboxRunner | undefined;
      try {
        printTriage(exhumed.manifest.name, exhumed.manifest.version, exhumed.triage);
        if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
          reportOutOfScope(exhumed.triage.reasons);
          return;
        }

        console.log("\nIN_SCOPE — static triage passed.");
        printPhase(2, "SANDBOX", "Installing package in an isolated runner…");
        sandbox = await createSandboxRunner(
          { packagePath: exhumed.packagePath, packageName: exhumed.manifest.name },
          {
            noDocker: options.docker === false,
            onWarning: (message) => console.error(message)
          }
        );
        printPhase(2, "SANDBOX", `Ready (${sandbox.mode} runner).`);
        printPhase(3, "PROBE", "Available: necromancer probe <pkg>");
        printPhase(4, "DISTILL", "Available: necromancer distill <pkg>");
        printPhase(5, "RESURRECT", "Available: necromancer resurrect <pkg>");
        printPhase(6, "REPORT", "Available after resurrection.");
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
