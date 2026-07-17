import { access, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { processFailure, runProcess } from "./process.js";

const MAX_SOURCE_CHARS = 200_000;

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function normalizeSource(source: string): string {
  const fenced = /^```(?:ts|typescript)?\s*\n([\s\S]*?)\n```\s*$/.exec(source.trim());
  const normalized = (fenced?.[1] ?? source).trim();
  if (!normalized) throw new Error("The rebuild engine returned an empty TypeScript implementation.");
  if (normalized.length > MAX_SOURCE_CHARS) throw new Error("The rebuild engine returned a TypeScript implementation larger than the 200,000-character limit.");
  if (/original\/package|\.\.\/original\//.test(normalized)) {
    throw new Error("The rebuild engine attempted to reference the original package, which violates the behavioral reconstruction contract.");
  }
  return `${normalized}\n`;
}

function projectManifest(): string {
  return `${JSON.stringify(
    {
      name: "necromancer-rebuilt-candidate",
      private: true,
      version: "0.0.0",
      type: "module",
      main: "./dist/cjs/index.cjs",
      module: "./dist/esm/index.js",
      types: "./dist/esm/index.d.ts",
      exports: { ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.cjs" } },
      devDependencies: { typescript: "^5.8.2" }
    },
    null,
    2
  )}\n`;
}

const ESM_CONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      outDir: "dist/esm",
      rootDir: "src",
      strict: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  },
  null,
  2
)}\n`;

const CJS_CONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "CommonJS",
      moduleResolution: "Node",
      declaration: false,
      outDir: "dist/cjs",
      rootDir: "src",
      strict: true,
      skipLibCheck: true
    },
    include: ["src/**/*.ts"]
  },
  null,
  2
)}\n`;

export async function writeCandidateProject(rebuiltDirectory: string, source: string): Promise<void> {
  const sourceDirectory = path.join(rebuiltDirectory, "src");
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(sourceDirectory, "index.ts"), normalizeSource(source), "utf8"),
    writeFile(path.join(rebuiltDirectory, "package.json"), projectManifest(), "utf8"),
    writeFile(path.join(rebuiltDirectory, "tsconfig.esm.json"), ESM_CONFIG, "utf8"),
    writeFile(path.join(rebuiltDirectory, "tsconfig.cjs.json"), CJS_CONFIG, "utf8")
  ]);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hostTypeScript(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

async function compilerPath(rebuiltDirectory: string): Promise<string> {
  const local = path.join(rebuiltDirectory, "node_modules", "typescript", "bin", "tsc");
  if (await fileExists(local)) return local;
  const host = hostTypeScript();
  if (host) return host;
  const install = await runProcess(npmCommand(), ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], {
    cwd: rebuiltDirectory,
    timeoutMs: 60_000
  });
  if (install.code !== 0) throw processFailure("npm install for the rebuilt TypeScript compiler", install);
  if (await fileExists(local)) return local;
  throw new Error("The rebuilt workspace could not locate TypeScript after installation.");
}

async function renameCommonJsFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await renameCommonJsFiles(filePath);
    else if (entry.isFile() && entry.name.endsWith(".js")) await rename(filePath, filePath.slice(0, -3) + ".cjs");
  }
}

export async function buildCandidate(rebuiltDirectory: string): Promise<void> {
  const compiler = await compilerPath(rebuiltDirectory);
  await rm(path.join(rebuiltDirectory, "dist"), { recursive: true, force: true });
  for (const config of ["tsconfig.esm.json", "tsconfig.cjs.json"]) {
    const build = await runProcess(process.execPath, [compiler, "-p", config], { cwd: rebuiltDirectory, timeoutMs: 30_000 });
    if (build.code !== 0) throw processFailure(`TypeScript build (${config})`, build);
  }
  await renameCommonJsFiles(path.join(rebuiltDirectory, "dist", "cjs"));
}
