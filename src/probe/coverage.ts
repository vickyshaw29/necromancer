import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "../json.js";
import { processFailure, runProcess } from "../process.js";
import { CoverageSummary } from "./types.js";

const require = createRequire(import.meta.url);

interface CoverageMetric {
  pct?: unknown;
  total?: unknown;
  covered?: unknown;
}

function metric(summary: Record<string, unknown>, key: string): CoverageMetric | undefined {
  const entry = summary[key];
  if (!isRecord(entry)) return undefined;
  return { pct: entry.pct, total: entry.total, covered: entry.covered };
}

function percentage(summary: Record<string, unknown>, key: string): number {
  const entry = metric(summary, key);
  return typeof entry?.pct === "number" ? entry.pct : 0;
}

function branchCounts(summary: Record<string, unknown>): Pick<CoverageSummary, "branchTotal" | "branchCovered"> {
  const branches = metric(summary, "branches");
  const total = branches?.total;
  const covered = branches?.covered;
  if (
    typeof total !== "number" ||
    typeof covered !== "number" ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(covered) ||
    total < 0 ||
    covered < 0 ||
    covered > total
  ) {
    return {};
  }
  return { branchTotal: total, branchCovered: covered };
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
    const report = await runProcess(
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
      { cwd: path.dirname(sourceDirectory), timeoutMs: 30_000, maxOutputChars: 500 }
    );
    if (report.code !== 0) throw processFailure("c8 report", report);
    const summary = JSON.parse(await readFile(path.join(reportsDirectory, "coverage-summary.json"), "utf8")) as {
      total?: Record<string, unknown>;
    };
    const total = summary.total ?? {};
    return {
      branchCoverage: percentage(total, "branches"),
      ...branchCounts(total),
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
