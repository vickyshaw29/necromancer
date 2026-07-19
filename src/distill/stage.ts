import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { processFailure, runProcess } from "../process.js";
import { stagedInstallEnvironment, stagedRuntimeDependencyNames, stripStagedPackageScripts } from "../staging.js";

const INSTALL_TIMEOUT_MS = 60_000;

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installDependencies(packagePath: string): Promise<void> {
  const env = await stagedInstallEnvironment(packagePath);
  const result = await runProcess(npmCommand(), ["install", "--ignore-scripts=true", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false"], {
    cwd: packagePath,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputChars: 500
  });
  if (result.code !== 0) throw processFailure("Could not install staged runtime dependencies", result);
}

export async function stageOriginalPackage(packagePath: string, artifactDirectory: string): Promise<string> {
  const destination = path.join(artifactDirectory, "original", "package");
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await cp(packagePath, destination, { recursive: true, force: true, verbatimSymlinks: true });
  await stripStagedPackageScripts(destination);
  const runtimeDependencies = await stagedRuntimeDependencyNames(destination);
  if (runtimeDependencies.length > 0) await installDependencies(destination);
  return destination;
}

export async function writeDistillWorkspace(artifactDirectory: string, soul: string, testSource: string): Promise<{ soulPath: string; testPath: string }> {
  const soulPath = path.join(artifactDirectory, "SOUL.md");
  const testPath = path.join(artifactDirectory, "soul.test.ts");
  const packagePath = path.join(artifactDirectory, "package.json");
  const configPath = path.join(artifactDirectory, "vitest.config.ts");
  await Promise.all([
    writeFile(soulPath, soul, "utf8"),
    writeFile(testPath, testSource, "utf8"),
    writeFile(
      configPath,
      'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({ test: { include: ["soul.test.ts"], environment: "node" } });\n',
      "utf8"
    ),
    writeFile(
      packagePath,
      `${JSON.stringify({ private: true, type: "module", scripts: { test: "vitest run soul.test.ts" }, devDependencies: { vitest: "^3.0.8" } }, null, 2)}\n`,
      "utf8"
    )
  ]);
  return { soulPath, testPath };
}
