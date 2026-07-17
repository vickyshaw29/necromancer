import { access, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "../json.js";
import { processFailure, runProcess } from "../process.js";
import { CharacterizationResult, TestFailure } from "./types.js";

const MAX_REPORT_BYTES = 512 * 1024;
const TEST_ENVIRONMENT_KEYS = ["PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hostVitest(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("vitest/vitest.mjs");
  } catch {
    return undefined;
  }
}

async function vitestPath(artifactDirectory: string): Promise<string> {
  const local = path.join(artifactDirectory, "node_modules", "vitest", "vitest.mjs");
  if (await exists(local)) return local;
  const host = hostVitest();
  if (host) return host;
  const install = await runProcess(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: artifactDirectory,
    timeoutMs: 60_000
  });
  if (install.code !== 0) throw processFailure("npm install for the characterization runner", install);
  if (await exists(local)) return local;
  throw new Error("The artifact workspace could not locate Vitest after installation.");
}

function failuresFromReport(report: Record<string, unknown>): TestFailure[] {
  if (!Array.isArray(report.testResults)) return [];
  const failures: TestFailure[] = [];
  for (const suite of report.testResults) {
    if (!isRecord(suite) || !Array.isArray(suite.assertionResults)) continue;
    for (const assertion of suite.assertionResults) {
      if (!isRecord(assertion) || assertion.status === "passed" || typeof assertion.title !== "string") continue;
      const id = assertion.title.split(" — ")[0];
      if (!id) continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter((message): message is string => typeof message === "string") : [];
      failures.push({ id, detail: messages.join("\n").slice(0, 4_000) || "Characterization test failed." });
    }
  }
  return failures;
}

function parseReport(value: unknown): CharacterizationResult {
  if (!isRecord(value) || typeof value.numTotalTests !== "number" || typeof value.numPassedTests !== "number") {
    throw new Error("Vitest did not produce a recognizable characterization report.");
  }
  return { total: value.numTotalTests, passed: value.numPassedTests, failures: failuresFromReport(value) };
}

async function reportText(reportPath: string): Promise<string> {
  const details = await stat(reportPath);
  if (details.size > MAX_REPORT_BYTES) throw new Error(`Vitest characterization report exceeds the ${MAX_REPORT_BYTES}-byte limit.`);
  return readFile(reportPath, "utf8");
}

function testEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NECROMANCER_IMPL: "rebuilt" };
  for (const key of TEST_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export async function runCharacterization(artifactDirectory: string): Promise<CharacterizationResult> {
  const reportPath = path.join(artifactDirectory, ".necromancer-resurrection-report.json");
  await rm(reportPath, { force: true });
  const vitest = await vitestPath(artifactDirectory);
  const result = await runProcess(process.execPath, [vitest, "run", "soul.test.ts", "--reporter=json", "--outputFile", reportPath], {
    cwd: artifactDirectory,
    env: testEnvironment(),
    timeoutMs: 60_000
  });
  if (!(await exists(reportPath))) throw processFailure("Vitest characterization run", result);
  const parsed = parseReport(JSON.parse(await reportText(reportPath)));
  if (result.code !== 0 && parsed.failures.length === 0) throw processFailure("Vitest characterization run", result);
  return parsed;
}
