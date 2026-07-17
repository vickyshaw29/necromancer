import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { queryOsv, queryOsvDependencies } from "../src/report/index.js";
import { renderGraveyard } from "../src/report/html.js";
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
  it("keeps OSV IDs and unique CVE aliases from a mocked response", async () => {
    const result = await queryOsv(
      "report-fixture",
      "1.0.0",
      async () =>
        new Response(
          JSON.stringify({
            vulns: [
              { id: "OSV-2024-1000", aliases: ["CVE-2024-1000", "GHSA-example"] },
              { id: "OSV-2023-2000", aliases: ["CVE-2024-1000", "CVE-2023-2000"] }
            ]
          })
        )
    );

    expect(result).toEqual({
      status: "known",
      advisoryCount: 2,
      cveCount: 2,
      identifiers: ["OSV-2024-1000", "CVE-2024-1000", "OSV-2023-2000", "CVE-2023-2000"]
    });
  });

  it("keeps OSV IDs when an advisory has no CVE alias", async () => {
    const result = await queryOsv(
      "report-fixture",
      "1.0.0",
      async () => new Response(JSON.stringify({ vulns: [{ id: "OSV-2022-3000" }] }))
    );

    expect(result).toEqual({ status: "known", advisoryCount: 1, cveCount: 0, identifiers: ["OSV-2022-3000"] });
  });

  it("reports an empty OSV result without inventing identifiers", async () => {
    const result = await queryOsv("report-fixture", "1.0.0", async () => new Response(JSON.stringify({ vulns: [] })));

    expect(result).toEqual({ status: "known", advisoryCount: 0, cveCount: 0, identifiers: [] });
  });

  it("returns an explicit unknown state when OSV cannot be reached", async () => {
    const result = await queryOsv("report-fixture", "1.0.0", async () => {
      throw new TypeError("offline");
    });

    expect(result).toEqual({ status: "unknown", detail: "OSV unreachable" });
  });

  it("scans declared rebuilt dependencies through the same query interface", async () => {
    const calls: string[] = [];
    const result = await queryOsvDependencies([{ name: "rebuilt-dependency", version: "1.2.3" }], async (name, version) => {
      calls.push(`${name}@${version}`);
      return { status: "known", advisoryCount: 0, cveCount: 0 };
    });

    expect(calls).toEqual(["rebuilt-dependency@1.2.3"]);
    expect(result).toEqual({ status: "known", advisoryCount: 0, cveCount: 0, identifiers: [], scannedDependencyCount: 1 });
  });

  it("reports zero declared rebuilt dependencies without issuing a request", async () => {
    let calls = 0;
    const result = await queryOsvDependencies([], async () => {
      calls += 1;
      return { status: "unknown", detail: "OSV unreachable" };
    });

    expect(calls).toBe(0);
    expect(result).toEqual({ status: "known", advisoryCount: 0, cveCount: 0, identifiers: [], scannedDependencyCount: 0 });
  });
});

describe("graveyard HTML", () => {
  it("writes a self-contained report with honest fidelity and source comparison", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "report-test-"));
    temporaryPaths.push(directory);
    const rebuiltSource = path.join(directory, "rebuilt", "src");
    await mkdir(rebuiltSource, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(directory, "SOUL.md"),
        "# SOUL — report-fixture\n\n## Behavioral clusters\n\n### `report-fixture`\n\n#### Typical inputs\n\n- Evidence: `behavior-0001`.\n\n## Quirks\n\n- **String preservation** — `report-fixture` with `[\"x\"]` returned \"x\". Evidence: `behavior-0001`.\n- **Second recorded quirk** — preserved below the fold. Evidence: `behavior-0002`.\n",
        "utf8"
      ),
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

    const result = await createReport(input, {
      osvQuery: async () => ({ status: "known", advisoryCount: 1, cveCount: 1, identifiers: ["OSV-2024-1000", "CVE-2024-1000"] })
    });
    const html = await readFile(result.reportPath, "utf8");

    expect(html).toContain("2 of 2 observed behaviors, 83.33% branch coverage of the original");
    expect(html).toContain("2 of 2 observed behaviors reproduced");
    expect(html).toContain("83.33% branch coverage of the original");
    expect(html).toContain("Recorded-suite evidence");
    expect(html).toContain("Original-code evidence");
    expect(html).toContain('data-evidence="observed-suite"');
    expect(html).toContain('data-evidence="original-coverage"');
    expect(html).toContain("No unobserved behavior is claimed; this receipt is limited to the recorded suite.");
    expect(html).toContain("Rebuild engine used");
    expect(html).toContain("stub");
    expect(html).toContain("Source quarantine");
    expect(html).toContain("the SOUL");
    expect(html).toContain("the characterization suite");
    expect(html).toContain("the public API shape");
    expect(html).toContain("failing observations");
    expect(html).toContain("Original source was withheld.");
    expect(html).toContain("Featured quirk — first recorded entry");
    expect(html).toContain("behavior-0001");
    expect(html).toContain("Recorded output / throw");
    expect(html).toContain("SOUL behavior clusters");
    expect(html).toContain("SOUL quirks");
    expect(html).toContain("Second recorded quirk");
    expect(html).toContain("Original source");
    expect(html).toContain("Rebuilt source");
    expect(html).toContain("original: report-fixture@1.0.0, queried at report time; returned identifiers: OSV-2024-1000, CVE-2024-1000");
    expect(html).toContain("rebuild: 0 declared runtime dependencies scanned; measured result: no advisories found across 0 declared runtime dependencies (no network request made)");
    expect(html).toContain("no advisories found across 0 declared runtime dependencies");
    expect(html).toContain("REVIVED");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
    expect(result.data.rebuiltOsv).toEqual({ status: "known", advisoryCount: 0, cveCount: 0, identifiers: [], scannedDependencyCount: 0 });

    const noIdentifierHtml = renderGraveyard({
      ...result.data,
      originalOsv: { status: "known", advisoryCount: 0, cveCount: 0, identifiers: [] }
    });
    const rebuiltIdentifierHtml = renderGraveyard({
      ...result.data,
      after: { ...result.data.after, runtimeDependencies: 1 },
      rebuiltOsv: { status: "known", advisoryCount: 1, cveCount: 0, identifiers: ["OSV-2024-2000"], scannedDependencyCount: 1 }
    });
    expect(noIdentifierHtml).not.toContain("returned identifiers:");
    expect(rebuiltIdentifierHtml).toContain("rebuild: 1 declared runtime dependencies scanned; returned identifiers: OSV-2024-2000");
  });

  it("renders the no-quirk fallback and escapes a malicious package name", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "report-test-"));
    temporaryPaths.push(directory);
    const rebuiltSource = path.join(directory, "rebuilt", "src");
    await mkdir(rebuiltSource, { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, "SOUL.md"), "# SOUL — fixture\n\n## Behavioral clusters\n\nNo extra behavior.\n\n## Quirks\n\nNo quirk was recorded.\n", "utf8"),
      writeFile(path.join(directory, "rebuilt", "package.json"), '{"name":"rebuilt","type":"module"}\n', "utf8"),
      writeFile(path.join(rebuiltSource, "index.ts"), "export const fixture = true;\n", "utf8")
    ]);
    const maliciousName = '<img src=x onerror="alert(1)">';
    const result = await createReport(
      {
        packageName: maliciousName,
        version: "1.0.0",
        artifact,
        triage: { loc: 1, runtimeDependencyCount: 0, nativeEvidence: [], filesystemImports: [], networkImports: [], verdict: "IN_SCOPE", reasons: [] },
        resurrection: { packageName: maliciousName, engine: "stub", rounds: [], passed: 0, total: 2, complete: false, resultPath: path.join(directory, "rebuilt", "result.json") },
        artifactDirectory: directory
      },
      { osvQuery: async () => ({ status: "unknown", detail: "OSV unreachable" }) }
    );
    const html = renderGraveyard(result.data);

    expect(html).toContain("No quirk was recorded");
    expect(html).toContain("unknown, OSV unreachable");
    expect(html).not.toContain("returned identifiers:");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });
});
