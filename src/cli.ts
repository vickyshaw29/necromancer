#!/usr/bin/env node
import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { discardExhumedPackage, exhume, ScopeReason, TriageResult } from "./exhume/index.js";

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

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("necromancer")
    .description("Resurrect abandoned JavaScript packages from observed behavior.")
    .argument("<pkg>", "npm package name, optionally with @version")
    .option("--keep-workspace", "keep the temporary EXHUME workspace for inspection")
    .action(async (pkg: string, options: { keepWorkspace?: boolean }) => {
      console.log("💀 NECROMANCER");
      console.log("[1/6] EXHUME      Fetching npm tarball and performing static triage…");

      const exhumed = await exhume(pkg);
      try {
        printTriage(exhumed.manifest.name, exhumed.manifest.version, exhumed.triage);
        if (exhumed.triage.verdict === "OUT_OF_SCOPE") {
          console.log(`\nOUT_OF_SCOPE — ${scopeMessage(exhumed.triage.reasons)}`);
          process.exitCode = 2;
          return;
        }

        console.log("\nIN_SCOPE — static triage passed.");
        console.log("[2/6] SANDBOX     queued for Milestone 2");
        console.log("[3/6] PROBE       queued for Milestone 3");
        console.log("[4/6] DISTILL     queued for Milestone 4");
        console.log("[5/6] RESURRECT   queued for Milestone 5");
        console.log("[6/6] REPORT      queued for Milestone 6");
        if (options.keepWorkspace) console.log(`\nEXHUME workspace retained: ${exhumed.workspacePath}`);
      } finally {
        if (!options.keepWorkspace) await discardExhumedPackage(exhumed);
      }
    });

  await program.parseAsync(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unexpected failure.";
    console.error(`Necromancer could not exhume this package: ${message}`);
    process.exitCode = 1;
  });
}
