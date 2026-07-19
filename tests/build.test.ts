import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCandidate, normalizeCandidateSource, writeCandidateProject } from "../src/resurrect/build.js";
import { validateCandidateConsumers } from "../src/resurrect/consumer-check.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function candidateDirectory(): Promise<string> {
  const cache = path.join(process.cwd(), ".necromancer-cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "candidate-build-test-"));
  temporaryPaths.push(directory);
  return directory;
}

describe("candidate build safety and compatibility", () => {
  it("rejects runtime imports and original-artifact paths while ignoring comments", () => {
    expect(() => normalizeCandidateSource('import fs from "node:fs"; export default fs;')).toThrow("imports are not allowed");
    expect(() => normalizeCandidateSource('export default function value() { return require("node:fs"); }')).toThrow("runtime module loading");
    expect(() => normalizeCandidateSource('export default function value() { return "original/package"; }')).toThrow("forbidden module or filesystem path");
    expect(() => normalizeCandidateSource('export { value } from "other-package";')).toThrow("re-exporting from another module");
    expect(() => normalizeCandidateSource('export default function value() { return Array.from(["safe"]); }')).not.toThrow();
    expect(() => normalizeCandidateSource('// import and require are prose here\nexport default function value() { return "safe"; }')).not.toThrow();
  });

  it("serves a callable root to external CommonJS and ESM consumers", async () => {
    const directory = await candidateDirectory();
    const source = [
      "export default function compatibility(value: string): string { return value; }",
      "export function echo(value: string): string { return value; }"
    ].join("\n");

    await writeCandidateProject(directory, source);
    await buildCandidate(directory);
    const compatibility = await validateCandidateConsumers(
      directory,
      "compatibility-fixture",
      [
        { path: "compatibility-fixture", type: "function", arity: 1 },
        { path: "compatibility-fixture.echo", type: "function", arity: 1 }
      ],
      { allowReducedIsolation: true }
    );
    if (compatibility) throw new Error(compatibility);
  });
});
