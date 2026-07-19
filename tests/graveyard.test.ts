import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGraveyardIndex } from "../src/graveyard/index.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function artifact(
  cacheDirectory: string,
  directoryName: string,
  packageName: string,
  version: string,
  behaviorCount: number,
  result?: { passed: number; total: number; engine: string }
): Promise<string> {
  const directory = path.join(cacheDirectory, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "behaviors.json"),
    `${JSON.stringify({ packageName, version, behaviors: Array.from({ length: behaviorCount }, () => ({})), coverage: { branchCoverage: 71.25, lineCoverage: 64, functionCoverage: 50 } })}\n`,
    "utf8"
  );
  if (result) {
    await mkdir(path.join(directory, "rebuilt"), { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, "rebuilt", "result.json"), `${JSON.stringify(result)}\n`, "utf8"),
      writeFile(path.join(directory, "graveyard.html"), "<!doctype html>\n", "utf8")
    ]);
  }
  return directory;
}

describe("graveyard index", () => {
  it("writes escaped, newest-first completed cards and a muted awaiting list", async () => {
    const cacheDirectory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "graveyard-test-"));
    temporaryPaths.push(cacheDirectory);
    const older = await artifact(cacheDirectory, "older", "failed-fixture", "1.0.0", 3, { passed: 0, total: 3, engine: "api" });
    const newer = await artifact(cacheDirectory, "newer", '<script>alert("x")</script>', "2.0.0", 1, { passed: 1, total: 1, engine: "codex" });
    await artifact(cacheDirectory, "partial", "partial-fixture", "1.0.0", 10, { passed: 9, total: 10, engine: "codex" });
    await artifact(cacheDirectory, "awaiting", "probe-fixture", "3.0.0", 2);
    const past = new Date(Date.now() - 60_000);
    await utimes(older, past, past);
    await utimes(newer, new Date(), new Date());

    const indexPath = await writeGraveyardIndex(cacheDirectory);
    const html = await readFile(indexPath, "utf8");

    expect(indexPath).toBe(path.join(cacheDirectory, "graveyard-index.html"));
    expect(html).toContain("Local artifacts on this machine — each card links to its full evidence report.");
    expect(html).toContain('href="newer/graveyard.html"');
    expect(html).toContain('href="older/graveyard.html"');
    expect(html.indexOf("&lt;script&gt;")).toBeLessThan(html.indexOf("failed-fixture@1.0.0"));
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("REVIVED");
    expect(html).toContain("PARTIAL RECONSTRUCTION");
    expect(html).toContain("FAILED RECONSTRUCTION");
    expect(html).toContain("Coverage: branch 71.25%; line 64.00%; function 50.00% of the original");
    expect(html).toContain("Rebuild engine: codex");
    expect(html).toContain("Probe artifacts without a completed reconstruction");
    expect(html).toContain("probe-fixture@3.0.0");
    expect(html).toContain("2 observed behaviors");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });
});
