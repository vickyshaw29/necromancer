import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxRunner, SandboxRunner } from "../src/sandbox/index.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = path.join(fixturesPath, "sandbox-edge-package");
const activeRunners: SandboxRunner[] = [];

afterEach(async () => {
  await Promise.all(activeRunners.splice(0).map((runner) => runner.dispose()));
});

async function childRunner(warnings: string[] = []): Promise<SandboxRunner> {
  const runner = await createSandboxRunner(
    { packagePath: fixturePath, packageName: "sandbox-edge-package" },
    { noDocker: true, onWarning: (message) => warnings.push(message) }
  );
  activeRunners.push(runner);
  return runner;
}

describe("SANDBOX RPC runner", () => {
  it("uses an explicit reduced-isolation child mode when Docker is disabled", async () => {
    const warnings: string[] = [];
    const runner = await childRunner(warnings);

    expect(runner.mode).toBe("child");
    expect(warnings.join(" ")).toContain("reduced isolation mode");
    expect(warnings.join(" ")).toContain("cannot guarantee network isolation");
  });

  it("invokes a CommonJS package without loading it in the test process", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["ordinary"]);

    expect(result).toMatchObject({ ok: true, value: { kind: "ordinary" } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ["undefined", { $necromancer: "undefined" }],
    ["nan", { $necromancer: "number", value: "NaN" }],
    ["infinity", { $necromancer: "number", value: "Infinity" }],
    ["negative-infinity", { $necromancer: "number", value: "-Infinity" }],
    ["bigint", { $necromancer: "bigint", value: "9007199254740993" }]
  ])("serializes %s as JSON-safe tagged data", async (kind, expected) => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", [kind]);

    expect(result).toMatchObject({ ok: true, value: expected });
    if (result.ok) expect(() => JSON.stringify(result.value)).not.toThrow();
  });

  it("records circular return values without throwing during serialization", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["circular"]);

    expect(result).toMatchObject({
      ok: true,
      value: { name: "cycle", self: { $necromancer: "circular", path: "$" } }
    });
  });

  it("returns thrown Error name and message as RPC data", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["throw"]);

    expect(result).toMatchObject({
      ok: false,
      error: { name: "RangeError", message: "edge failure" }
    });
  });
});
