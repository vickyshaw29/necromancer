import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { writeReplayReport } from "../src/replay.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "replay-test-"));
  temporaryPaths.push(directory);
  return directory;
}

describe("offline report replay", () => {
  it("writes the real renderer output and a fixture-marked provenance receipt", async () => {
    const output = await outputDirectory();
    const result = await writeReplayReport({ output });
    const [html, provenanceText] = await Promise.all([readFile(result.reportPath, "utf8"), readFile(result.provenancePath, "utf8")]);
    const provenance = JSON.parse(provenanceText) as Record<string, unknown>;

    expect(result.outputDirectory).toBe(output);
    expect(result.reportPath).toBe(path.join(output, "replay.html"));
    expect(result.provenancePath).toBe(path.join(output, "rebuilt", "provenance.json"));
    expect(html).toContain("NECROMANCER report UX replay");
    expect(html).toContain("REVIVED — FIXTURE ONLY");
    expect(html).toContain("This fixed fixture was rendered locally by NECROMANCER.");
    expect(html).toContain("It did not fetch, execute, rebuild, or assess a package; its values are not reconstruction evidence.");
    expect(html).toContain('href="rebuilt/provenance.json"');
    expect(html).toContain("1 of 1 held-out behaviors passed.");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
    expect(provenance).toMatchObject({ fixture: true, purpose: "Offline report UX replay only; not a package reconstruction receipt." });
  });

  it("exposes replay as a credential-free CLI command", async () => {
    const output = await outputDirectory();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["node", "necromancer", "replay", "--output", output]);

    expect(log).toHaveBeenCalledWith(`Replay report: ${path.join(output, "replay.html")}`);
    expect(log).toHaveBeenCalledWith("Offline report UX replay only: no package was fetched, executed, rebuilt, or assessed.");
  });
});
