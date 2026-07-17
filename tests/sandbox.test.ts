import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxRunner, SandboxRunner } from "../src/sandbox/index.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = path.join(fixturesPath, "sandbox-edge-package");
const activeRunners: SandboxRunner[] = [];
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(activeRunners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function childRunner(warnings: string[] = []): Promise<SandboxRunner> {
  const runner = await createSandboxRunner(
    { packagePath: fixturePath, packageName: "sandbox-edge-package" },
    { noDocker: true, onWarning: (message) => warnings.push(message) }
  );
  activeRunners.push(runner);
  return runner;
}

async function lifecyclePackage(): Promise<{ packagePath: string; sentinelPath: string }> {
  const cache = path.join(process.cwd(), ".necromancer-cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "lifecycle-test-"));
  temporaryPaths.push(directory);
  const packagePath = path.join(directory, "package");
  const sentinelPath = path.join(directory, "host-lifecycle-sentinel");
  await cp(path.join(fixturesPath, "lifecycle-package"), packagePath, { recursive: true, force: true });
  await writeFile(
    path.join(packagePath, "prepare.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "unexpected lifecycle execution\\n");\n`,
    "utf8"
  );
  return { packagePath, sentinelPath };
}

describe("SANDBOX RPC runner", () => {
  it("uses an explicit reduced-isolation child mode when Docker is disabled", async () => {
    const warnings: string[] = [];
    const runner = await childRunner(warnings);

    expect(runner.mode).toBe("child");
    expect(warnings.join(" ")).toContain("reduced isolation mode");
    expect(warnings.join(" ")).toContain("not full containment");
  });

  it("invokes a CommonJS package without loading it in the test process", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["ordinary"]);

    expect(result).toMatchObject({ ok: true, value: { kind: "ordinary" } });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("removes copied lifecycle scripts before staging a linked package", async () => {
    const source = await lifecyclePackage();
    const runner = await createSandboxRunner(
      { packagePath: source.packagePath, packageName: "lifecycle-package" },
      { noDocker: true, onWarning: () => undefined }
    );
    activeRunners.push(runner);

    await expect(access(source.sentinelPath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("serializes a prototype-swapped array without using its inherited methods", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["prototype-swapped-array"]);

    expect(result).toMatchObject({
      ok: true,
      value: {
        $necromancer: "array",
        length: 4,
        entries: [
          ["0", 2],
          ["1", 0],
          ["2", 8],
          ["3", -5],
          ["label", "retained"]
        ]
      }
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

  it("blocks process-control modules from the probed package", async () => {
    const runner = await childRunner();

    const result = await runner.invoke("sandbox-edge-package", ["process-control"]);

    expect(result).toMatchObject({
      ok: false,
      error: { name: "Error", message: expect.stringContaining("child_process") }
    });
  });
});
