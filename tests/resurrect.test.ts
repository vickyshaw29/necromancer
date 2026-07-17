import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHeuristicSoul, renderSoulTest } from "../src/distill/index.js";
import { writeDistillWorkspace } from "../src/distill/stage.js";
import { createApiRebuildGenerator, resurrectArtifact } from "../src/resurrect/index.js";
import type { ProbeArtifact } from "../src/distill/index.js";
import type { RebuildGenerator, RebuildRequest } from "../src/resurrect/index.js";

const temporaryPaths: string[] = [];

const artifact: ProbeArtifact = {
  packageName: "resurrect-fixture",
  coverage: { branchCoverage: 37.5, lineCoverage: 50, functionCoverage: 50, statementCoverage: 50, available: true },
  surface: { exports: [{ path: "resurrect-fixture", type: "function", arity: 1 }] },
  behaviors: [
    { id: "behavior-0001", fn: "resurrect-fixture", args: [true], result: "yes" },
    { id: "behavior-0002", fn: "resurrect-fixture", args: [false], result: "no" }
  ]
};

const wrongSource = 'export default function resurrectFixture(_value: unknown): string { return "wrong"; }';
const correctSource = 'export default function resurrectFixture(value: unknown): string { return value === true ? "yes" : "no"; }';

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function resurrectionWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "resurrect-test-"));
  temporaryPaths.push(directory);
  const soul = renderHeuristicSoul({ packageName: artifact.packageName, behaviors: artifact.behaviors, coverage: artifact.coverage });
  await writeDistillWorkspace(directory, soul, renderSoulTest(artifact));
  return directory;
}

function generator(sources: string[], requests: RebuildRequest[]): RebuildGenerator {
  let index = 0;
  return {
    name: "stub",
    async generate(request): Promise<string> {
      requests.push(request);
      const source = sources[Math.min(index, sources.length - 1)];
      index += 1;
      return source;
    }
  };
}

describe("RESURRECT", () => {
  it("accepts a structured API candidate through an offline fetch stub", async () => {
    const request: RebuildRequest = {
      packageName: artifact.packageName,
      api: artifact.surface?.exports ?? [],
      soul: "fixture soul",
      soulTest: "fixture test",
      round: 1,
      failures: []
    };
    const engine = createApiRebuildGenerator(
      "test-key",
      async () => new Response(JSON.stringify({ output_text: JSON.stringify({ source: correctSource }) }))
    );

    await expect(engine.generate(request)).resolves.toBe(correctSource);
  });

  it("feeds failed behavior evidence into a regenerated candidate", async () => {
    const directory = await resurrectionWorkspace();
    const requests: RebuildRequest[] = [];

    const result = await resurrectArtifact({ artifact, artifactDirectory: directory }, generator([wrongSource, correctSource], requests));

    expect(result.complete).toBe(true);
    expect(result.rounds.map((round) => round.passed)).toEqual([0, 2]);
    expect(requests).toHaveLength(2);
    expect(requests[1].failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "behavior-0001", expected: "yes" }), expect.objectContaining({ id: "behavior-0002", expected: "no" })])
    );
    await expect(readFile(result.resultPath, "utf8")).resolves.toMatch(/"rounds"[\s\S]*"passed": 2[\s\S]*"complete": true/);
  });

  it("caps an incomplete reconstruction at six rounds", async () => {
    const directory = await resurrectionWorkspace();
    const requests: RebuildRequest[] = [];

    const result = await resurrectArtifact(
      { artifact, artifactDirectory: directory },
      generator([wrongSource], requests),
      {
        async evaluateCandidate(_artifactDirectory, _source, total) {
          return {
            passed: 0,
            total,
            failures: artifact.behaviors.map((behavior) => ({ id: behavior.id, detail: "Observed behavior did not match." }))
          };
        }
      }
    );

    expect(result.complete).toBe(false);
    expect(result.rounds).toHaveLength(6);
    expect(requests).toHaveLength(6);
    expect(result.passed).toBe(0);
  });

  it("stops after the first all-green candidate", async () => {
    const directory = await resurrectionWorkspace();
    const requests: RebuildRequest[] = [];

    const result = await resurrectArtifact({ artifact, artifactDirectory: directory }, generator([correctSource], requests));

    expect(result.complete).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
});
