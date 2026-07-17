import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSoulTest } from "../src/distill/index.js";
import { writeDistillWorkspace } from "../src/distill/stage.js";
import { sha256File } from "../src/report/provenance.js";
import { verifyArtifact } from "../src/verify/index.js";
import type { ProbeArtifact } from "../src/distill/index.js";

const runner = vi.hoisted(() => ({ runCharacterization: vi.fn() }));

vi.mock("../src/resurrect/test-runner.js", () => ({ runCharacterization: runner.runCharacterization }));

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  runner.runCharacterization.mockReset();
});

async function fixtureArtifact(): Promise<string> {
  await mkdir(path.join(process.cwd(), ".necromancer-cache"), { recursive: true });
  const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "verify-test-"));
  temporaryPaths.push(directory);
  const artifact: ProbeArtifact = {
    packageName: "verify-fixture",
    version: "1.0.0",
    coverage: { branchCoverage: 50, lineCoverage: 50, functionCoverage: 50, statementCoverage: 50, available: true },
    behaviors: [{ id: "behavior-0001", fn: "verify-fixture", args: ["observed"], result: "observed" }]
  };
  const originalDirectory = path.join(directory, "original", "package");
  const rebuiltDirectory = path.join(directory, "rebuilt");
  const sourcePath = path.join(rebuiltDirectory, "src", "index.ts");
  await Promise.all([
    writeDistillWorkspace(directory, "# SOUL — verify fixture\n", renderSoulTest(artifact)),
    mkdir(path.join(rebuiltDirectory, "src"), { recursive: true }),
    mkdir(originalDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(originalDirectory, "package.json"), '{"name":"verify-fixture","main":"index.js"}\n', "utf8"),
    writeFile(path.join(originalDirectory, "index.js"), 'module.exports = (value) => value;\n', "utf8"),
    writeFile(path.join(rebuiltDirectory, "package.json"), '{"name":"rebuilt","main":"index.js"}\n', "utf8"),
    writeFile(path.join(rebuiltDirectory, "index.js"), 'module.exports = (value) => value;\n', "utf8"),
    writeFile(sourcePath, 'export default function verifyFixture(value: string): string { return value; }\n', "utf8"),
    writeFile(path.join(rebuiltDirectory, "result.json"), '{"engine":"fixture","passed":1,"total":1}\n', "utf8")
  ]);
  const [soulSha256, soulTestSha256, sourceSha256] = await Promise.all([
    sha256File(path.join(directory, "SOUL.md")),
    sha256File(path.join(directory, "soul.test.ts")),
    sha256File(sourcePath)
  ]);
  await writeFile(
    path.join(rebuiltDirectory, "provenance.json"),
    `${JSON.stringify({ distillation: { soulSha256, soulTestSha256 }, resurrection: { authoredSourceFiles: [{ path: "src/index.ts", sha256: sourceSha256 }] } }, null, 2)}\n`,
    "utf8"
  );
  return directory;
}

describe("verify", () => {
  it("re-measures attested files and both emitted-suite targets offline", async () => {
    const directory = await fixtureArtifact();
    runner.runCharacterization.mockResolvedValue({ passed: 1, total: 1, failures: [] });

    const receipt = await verifyArtifact(directory);

    expect(receipt.exitCode).toBe(0);
    expect(receipt.lines).toEqual(
      expect.arrayContaining([
        "SOUL.md sha256 ✓ matches attestation",
        "soul.test.ts sha256 ✓ matches attestation",
        "rebuilt/src/index.ts sha256 ✓ matches attestation",
        "observed suite vs original: ✓ 1 of 1",
        "observed suite vs rebuilt: ✓ 1 of 1",
        "Not re-verified: registry tarball hash (no network in verify)",
        "Not re-verified: OSV advisory data (recorded at report time; not re-queried)",
        "All performed checks passed."
      ])
    );
    expect(runner.runCharacterization).toHaveBeenNthCalledWith(1, directory, { implementation: "original", offline: true, readOnly: true });
    expect(runner.runCharacterization).toHaveBeenNthCalledWith(2, directory, { implementation: "rebuilt", offline: true, readOnly: true });
    await expect(readFile(path.join(directory, ".necromancer-resurrection-report.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails verification and names a rebuilt source whose attested hash was tampered", async () => {
    const directory = await fixtureArtifact();
    runner.runCharacterization.mockResolvedValue({ passed: 1, total: 1, failures: [] });
    await writeFile(path.join(directory, "rebuilt", "src", "index.ts"), "export default 0;\n", "utf8");

    const receipt = await verifyArtifact(directory);

    expect(receipt.exitCode).toBe(1);
    expect(receipt.lines).toContain("rebuilt/src/index.ts sha256 ✗ does not match attestation");
  });

  it("reports a missing provenance receipt with exit code 2", async () => {
    const directory = await fixtureArtifact();
    await rm(path.join(directory, "rebuilt", "provenance.json"));

    const receipt = await verifyArtifact(directory);

    expect(receipt.exitCode).toBe(2);
    expect(receipt.lines[0]).toContain("No provenance.json exists");
  });
});
