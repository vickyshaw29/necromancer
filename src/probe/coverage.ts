import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { CoverageSummary } from "./types.js";

const require = createRequire(import.meta.url);

async function command(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`c8 report exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function percentage(summary: Record<string, unknown>, key: string): number {
  const entry = summary[key] as { pct?: unknown } | undefined;
  return typeof entry?.pct === "number" ? entry.pct : 0;
}

/** Create a c8 report from the child runner's V8 files while its copied source exists. */
export async function collectCoverage(
  rawDirectory: string,
  sourceDirectory: string,
  artifactDirectory: string
): Promise<CoverageSummary> {
  const reportsDirectory = path.join(artifactDirectory, "coverage");
  try {
    await mkdir(reportsDirectory, { recursive: true });
    const c8Bin = require.resolve("c8/bin/c8.js");
    await command(
      process.execPath,
      [
        c8Bin,
        "report",
        "--temp-directory",
        rawDirectory,
        "--reports-dir",
        reportsDirectory,
        "--reporter",
        "json-summary",
        "--include",
        `${path.basename(sourceDirectory)}/**`
      ],
      path.dirname(sourceDirectory)
    );
    const summary = JSON.parse(await readFile(path.join(reportsDirectory, "coverage-summary.json"), "utf8")) as {
      total?: Record<string, unknown>;
    };
    const total = summary.total ?? {};
    return {
      branchCoverage: percentage(total, "branches"),
      lineCoverage: percentage(total, "lines"),
      functionCoverage: percentage(total, "functions"),
      statementCoverage: percentage(total, "statements"),
      available: true
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "coverage report unavailable";
    return {
      branchCoverage: 0,
      lineCoverage: 0,
      functionCoverage: 0,
      statementCoverage: 0,
      available: false,
      detail
    };
  }
}
