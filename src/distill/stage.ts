import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { stagedRuntimeDependencyNames, stripStagedPackageScripts } from "../staging.js";

const INSTALL_TIMEOUT_MS = 60_000;

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function installDependencies(packagePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand(), ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false"], {
      cwd: packagePath,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let settled = false;
    let stderr = "";
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Staged runtime dependency install exceeded its ${INSTALL_TIMEOUT_MS} ms limit.`)));
    }, INSTALL_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8").slice(0, 500 - stderr.length);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`Could not install staged runtime dependencies: ${stderr.trim() || "no error output"}`)));
    });
  });
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
