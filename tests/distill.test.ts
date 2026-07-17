import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApiSoulEngine, distillArtifact, renderHeuristicSoul, renderSoulTest } from "../src/distill/index.js";
import type { ProbeArtifact, SoulRequest } from "../src/distill/index.js";
import type { JsonSafeValue } from "../src/sandbox/index.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = path.join(fixturesPath, "sandbox-edge-package");
const temporaryPaths: string[] = [];

const unusualKeyInput: JsonSafeValue = {
  ["__proto__"]: { recorded: true },
  constructor: { note: "input" }
};

const artifact: ProbeArtifact = {
  packageName: "sandbox-edge-package",
  coverage: { branchCoverage: 42.5, lineCoverage: 50, functionCoverage: 50, statementCoverage: 50, available: true },
  behaviors: [
    { id: "behavior-0001", fn: "sandbox-edge-package", args: ["ordinary"], result: { kind: "ordinary" } },
    { id: "behavior-0002", fn: "sandbox-edge-package", args: ["undefined"], result: { $necromancer: "undefined" } },
    {
      id: "behavior-0003",
      fn: "sandbox-edge-package",
      args: [unusualKeyInput],
      result: { kind: unusualKeyInput }
    },
    { id: "behavior-0004", fn: "sandbox-edge-package", args: ["throw"], throw: { name: "RangeError", message: "edge failure" } },
    {
      id: "behavior-0005",
      fn: "sandbox-edge-package",
      args: ["circular"],
      result: { name: "cycle", self: { $necromancer: "circular", path: "$" } }
    },
    {
      id: "behavior-0006",
      fn: "sandbox-edge-package",
      args: ["map"],
      result: { $necromancer: "map", entries: [["key", 1]] }
    }
  ]
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runGeneratedSuite(directory: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs"), "run", "soul.test.ts"], {
      cwd: directory,
      env: { ...process.env, NECROMANCER_IMPL: "original/package" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let settled = false;
    let output = "";
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const append = (chunk: Buffer): void => {
      if (output.length < 8_000) output += chunk.toString("utf8").slice(0, 8_000 - output.length);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Generated soul.test.ts did not finish within 20 seconds.")));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => resolve({ code, output })));
  });
}

describe("DISTILL", () => {
  it("writes grouped evidence, factual quirks, and one executable test per recorded behavior", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "distill-test-"));
    temporaryPaths.push(directory);

    const result = await distillArtifact(artifact, fixturePath, directory, { engine: "heuristic" });
    const [soul, firstTestSource] = await Promise.all([readFile(result.soulPath, "utf8"), readFile(result.testPath, "utf8")]);

    expect(result.engine).toBe("heuristic");
    expect(soul).toContain("This specification covers 6 observed behaviors, 42.50% branch coverage of the original.");
    expect(soul).toContain("## Behavioral clusters");
    expect(soul).toContain("#### Typical inputs");
    expect(soul).toContain("#### Coercion and type chaos");
    expect(soul).toContain("#### Adversarial object inputs");
    expect(soul).toContain("#### Errors");
    expect(soul).toContain("## Quirks");
    expect(soul).toContain("Unusual property-key input");
    for (const behavior of artifact.behaviors) expect(soul).toContain(behavior.id);
    expect(firstTestSource).toBe(renderSoulTest(artifact));
    expect(renderSoulTest(artifact)).toBe(renderSoulTest(artifact));

    const suite = await runGeneratedSuite(directory);
    expect(suite.code, suite.output).toBe(0);
    expect(suite.output).toContain("6 passed");
  });

  it("validates structured API prose with an offline fixture response", async () => {
    const request: SoulRequest = { packageName: artifact.packageName, behaviors: artifact.behaviors, coverage: artifact.coverage };
    const engine = createApiSoulEngine(
      "test-key",
      async () => new Response(JSON.stringify({ output_text: JSON.stringify({ soulMarkdown: renderHeuristicSoul(request) }) }))
    );

    await expect(engine.generate(request)).resolves.toContain("## Quirks");
  });
});
