import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NpmPackageManifest, ScopeReason, TriageResult } from "./types.js";

export const MAX_SOURCE_LOC = 2_000;
export const MAX_RUNTIME_DEPENDENCIES = 3;

const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx"]);
const FILESYSTEM_MODULES = new Set(["fs"]);
const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns", "cluster"]);
const NETWORK_PACKAGES = new Set(["axios", "got", "node-fetch", "undici", "request", "superagent"]);
const MODULE_REFERENCE = /(?:\b(?:require|import)\s*\(\s*|\b(?:from|import)\s+)["']([^"']+)["']/g;
const NON_RUNTIME_DIRECTORIES = /^(test|tests|__tests__|spec|example|examples|benchmark|benchmarks|docs)$/i;

export interface TriageOptions {
  runtimeDependencyCount?: number;
  maxLoc?: number;
  maxRuntimeDependencies?: number;
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\n|\r/);
  return source.endsWith("\n") || source.endsWith("\r") ? lines.length - 1 : lines.length;
}

function dependencyCount(manifest: NpmPackageManifest): number {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ]).size;
}

function importedModules(source: string): string[] {
  const modules: string[] = [];
  for (const match of source.matchAll(MODULE_REFERENCE)) modules.push(match[1]);
  return modules;
}

function normalizedModuleName(moduleName: string): string {
  return moduleName.replace(/^node:/, "").split("/")[0];
}

function isRuntimeSource(relativePath: string): boolean {
  if (relativePath.endsWith(".d.ts")) return false;
  if (!CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) return false;
  return !relativePath.split("/").slice(0, -1).some((segment) => NON_RUNTIME_DIRECTORIES.test(segment));
}

/** Static, non-executing source scan for the v1 scope gate. */
export async function triagePackage(packagePath: string, options: TriageOptions = {}): Promise<TriageResult> {
  const manifestPath = path.join(packagePath, "package.json");
  let manifest: NpmPackageManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NpmPackageManifest;
  } catch {
    throw new Error("The npm tarball does not contain a readable package.json.");
  }

  const files = await walk(packagePath);
  const nativeEvidence: string[] = manifest.gypfile ? ["package.json:gypfile"] : [];
  const filesystemImports = new Set<string>();
  const networkImports = new Set<string>();
  let loc = 0;

  for (const filePath of files) {
    const relativePath = path.relative(packagePath, filePath).split(path.sep).join("/");
    if (relativePath.endsWith(".node")) nativeEvidence.push(relativePath);
    if (path.basename(relativePath) === "binding.gyp") nativeEvidence.push(relativePath);
    if (!isRuntimeSource(relativePath)) continue;

    const source = await readFile(filePath, "utf8");
    loc += lineCount(source);
    for (const moduleName of importedModules(source)) {
      const normalized = normalizedModuleName(moduleName);
      if (FILESYSTEM_MODULES.has(normalized)) filesystemImports.add(moduleName);
      if (NETWORK_MODULES.has(normalized) || NETWORK_PACKAGES.has(normalized)) networkImports.add(moduleName);
    }
  }

  const runtimeDependencyCount = options.runtimeDependencyCount ?? dependencyCount(manifest);
  const maxLoc = options.maxLoc ?? MAX_SOURCE_LOC;
  const maxRuntimeDependencies = options.maxRuntimeDependencies ?? MAX_RUNTIME_DEPENDENCIES;
  const reasons: ScopeReason[] = [];
  if (nativeEvidence.length > 0) {
    reasons.push({
      code: "NATIVE_MODULE",
      message: "it binds to native code"
    });
  }
  if (loc > maxLoc) {
    reasons.push({
      code: "TOO_MANY_LINES",
      message: `it has ${loc.toLocaleString()} lines of source (v1 caps targets at ${maxLoc.toLocaleString()})`
    });
  }
  if (runtimeDependencyCount > maxRuntimeDependencies) {
    reasons.push({
      code: "TOO_MANY_RUNTIME_DEPENDENCIES",
      message: `it has ${runtimeDependencyCount} runtime dependencies (v1 caps targets at ${maxRuntimeDependencies})`
    });
  }
  if (filesystemImports.size > 0) {
    reasons.push({
      code: "FILESYSTEM_USAGE",
      message: "it accesses the filesystem"
    });
  }
  if (networkImports.size > 0) {
    reasons.push({
      code: "NETWORK_USAGE",
      message: "it accesses the network"
    });
  }

  return {
    loc,
    runtimeDependencyCount,
    nativeEvidence,
    filesystemImports: [...filesystemImports].sort(),
    networkImports: [...networkImports].sort(),
    verdict: reasons.length === 0 ? "IN_SCOPE" : "OUT_OF_SCOPE",
    reasons
  };
}
