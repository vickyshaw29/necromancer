import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagedInstallEnvironment, stripStagedPackageScripts } from "../src/staging.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("staged package preparation", () => {
  it("removes lifecycle configuration and isolates npm configuration", async () => {
    const directory = await mkdtemp(path.join(process.cwd(), ".necromancer-cache", "staging-test-"));
    temporaryPaths.push(directory);
    await Promise.all([
      writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ scripts: { prepare: "unsafe" }, devDependencies: { unsafe: "1.0.0" }, dependencies: { runtime: "1.0.0" } }),
        "utf8"
      ),
      writeFile(path.join(directory, ".npmrc"), "//registry.npmjs.org/:_authToken=unsafe\n", "utf8")
    ]);

    await stripStagedPackageScripts(directory);
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>;
    const environment = await stagedInstallEnvironment(directory);

    expect(manifest).toEqual({ dependencies: { runtime: "1.0.0" } });
    await expect(readFile(path.join(directory, ".npmrc"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(environment.HOME).not.toBe(process.env.HOME);
    expect(environment.npm_config_ignore_scripts).toBe("true");
    expect(environment.npm_config_userconfig).toContain(".install-home");
  });
});
