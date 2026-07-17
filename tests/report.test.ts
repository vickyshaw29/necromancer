import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queryOsv } from "../src/report/index.js";
import { createReport } from "../src/report/stage.js";
import type { ProbeArtifact } from "../src/distill/index.js";
import type { ReportInput } from "../src/report/index.js";

const temporaryPaths: string[] = [];

const artifact: ProbeArtifact = {
  packageName: "report-fixture",
  coverage: { branchCoverage: 83.33, lineCoverage: 80, functionCoverage: 80, statementCoverage: 80, available: true },
  behaviors: [
    { id: "behavior-0001", fn: "report-fixture", args: ["x"], result: "x" },
    { id: "behavior-0002", fn: "report-fixture", args: ["y"], result: "y" }
  ]
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("REPORT OSV client", () => {
  it("counts advisories and unique CVE aliases from a mocked response", async () => {
    const result = await queryOsv(
      "report-fixture",
      "1.0.0",
      async () =>
        new Response(
          JSON.stringify({
            vulns: [
              { aliases: ["CVE-2024-1000", "GHSA-example"] },
              { aliases: ["CVE-2024-1000", "CVE-2023-2000"] }
            ]
          })
        )
    );

    expect(result).toEqual({ status: "known", advisoryCount: 2, cveCount: 2 });
  });

  it("returns an explicit unknown state when OSV cannot be reached", async () => {
    const result = await queryOsv("report-fixture", "1.0.0", async () => {
      throw new TypeError("offline");
    });

    expect(result).toEqual({ status: "unknown", detail: "OSV unreachable" });
  });
});

describe("graveyard HTML", () => {
  it("writes a self-contained report with honest fidelity and source comparison", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "report-test-"));
    temporaryPaths.push(directory);
    const rebuiltSource = path.join(directory, "rebuilt", "src");
    await mkdir(rebuiltSource, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, "SOUL.md"), "# SOUL — report-fixture\n\n## Behavioral clusters\n\n### `report-fixture`\n\n#### Typical inputs\n\n- Evidence: `behavior-0001`.\n", "utf8"),
      writeFile(path.join(directory, "rebuilt", "package.json"), '{"name":"rebuilt","type":"module"}\n', "utf8"),
      writeFile(path.join(rebuiltSource, "index.ts"), 'export default function fixture(value: string): string { return value; }\n', "utf8")
    ]);
    const input: ReportInput = {
      packageName: "report-fixture",
      version: "1.0.0",
      artifact,
      triage: { loc: 12, runtimeDependencyCount: 1, nativeEvidence: [], filesystemImports: [], networkImports: [], verdict: "IN_SCOPE", reasons: [] },
      resurrection: {
        packageName: "report-fixture",
        engine: "stub",
        rounds: [{ round: 1, passed: 2, total: 2, failedIds: [] }],
        passed: 2,
        total: 2,
        complete: true,
        resultPath: path.join(directory, "rebuilt", "result.json")
      },
      artifactDirectory: directory
    };

    const result = await createReport(input, { osvQuery: async () => ({ status: "known", advisoryCount: 1, cveCount: 1 }) });
    const html = await readFile(result.reportPath, "utf8");

    expect(html).toContain("2 of 2 observed behaviors, 83.33% branch coverage of the original");
    expect(html).toContain("SOUL behavior clusters");
    expect(html).toContain("Original source");
    expect(html).toContain("Rebuilt source");
    expect(html).toContain("REVIVED");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });
});
