import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiEngine, createSandboxRunner, InputPlanEngine, probePackage, SandboxRunner } from "../src/index.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = path.join(fixturesPath, "sandbox-edge-package");
const temporaryPaths: string[] = [];
const activeRunners: SandboxRunner[] = [];

afterEach(async () => {
  await Promise.all(activeRunners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function probeRunner(): Promise<{ runner: SandboxRunner; artifactDirectory: string }> {
  const artifactDirectory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "probe-test-"));
  temporaryPaths.push(artifactDirectory);
  const runner = await createSandboxRunner(
    { packagePath: fixturePath, packageName: "sandbox-edge-package" },
    {
      noDocker: true,
      coverageDirectory: path.join(artifactDirectory, ".v8-coverage"),
      onWarning: () => undefined
    }
  );
  activeRunners.push(runner);
  return { runner, artifactDirectory };
}

describe("PROBE", () => {
  it("discovers exports, uses a fixture plan, persists behaviors, and records c8 coverage", async () => {
    const { runner, artifactDirectory } = await probeRunner();
    const fixturePlan: InputPlanEngine = {
      name: "fixture",
      async generate() {
        return {
          functions: [
            {
              exportPath: "sandbox-edge-package",
              candidates: [{ args: ["ordinary"] }, { args: ["throw"] }, { args: ["circular"] }]
            }
          ]
        };
      }
    };

    const result = await probePackage(
      {
        packageName: "sandbox-edge-package",
        version: "1.0.0",
        packagePath: fixturePath,
        sandbox: runner,
        artifactDirectory
      },
      { maxBehaviors: 16, planEngine: fixturePlan }
    );

    expect(result.engine).toBe("fixture");
    expect(result.surface.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "sandbox-edge-package", type: "function", arity: 1 }),
        expect.objectContaining({ path: "sandbox-edge-package.edge", type: "function", arity: 1 })
      ])
    );
    expect(result.examples).toEqual(expect.arrayContaining([expect.objectContaining({ source: "readme", snippet: 'edge("ordinary")' })]));
    expect(result.behaviors).toHaveLength(16);
    expect(result.behaviors.some((behavior) => behavior.throw?.name === "RangeError")).toBe(true);
    expect(result.coverage.available).toBe(true);
    expect(result.coverage.branchCoverage).toBeGreaterThan(0);

    const artifact = JSON.parse(await readFile(path.join(artifactDirectory, "behaviors.json"), "utf8")) as { behaviors: unknown[] };
    expect(artifact.behaviors).toHaveLength(16);
    await expect(readFile(path.join(artifactDirectory, "coverage.json"), "utf8")).resolves.toContain("branchCoverage");
  });

  it("validates an API structured-output plan using a stubbed fetch implementation", async () => {
    const engine = createApiEngine(
      "test-key",
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              functions: [{ exportPath: "sandbox-edge-package", candidates: [{ args: ["ordinary"] }] }]
            })
          })
        )
    );

    const plan = await engine.generate({
      packageName: "sandbox-edge-package",
      packagePath: fixturePath,
      functions: [{ path: "sandbox-edge-package", type: "function", arity: 1 }],
      examples: [],
      readme: "",
      sourceExcerpt: ""
    });

    expect(plan).toEqual({ functions: [{ exportPath: "sandbox-edge-package", candidates: [{ args: ["ordinary"] }] }] });
  });
});
