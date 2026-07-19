import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NpmPackageManifest, ScopeReason, TriageResult } from "./types.js";

export const MAX_SOURCE_LOC = 2_000;
export const MAX_RUNTIME_DEPENDENCIES = 3;
export const MAX_PACKAGE_FILES = 5_000;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx"]);
const FILESYSTEM_MODULES = new Set(["fs"]);
const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns", "cluster"]);
const NETWORK_PACKAGES = new Set(["axios", "got", "node-fetch", "undici", "request", "superagent"]);
const MODULE_REFERENCE = /(?:\b(?:require|import)\s*\(\s*|\b(?:from|import)\s+)["']([^"']+)["']/g;
const NON_RUNTIME_DIRECTORIES = /^(test|tests|__tests__|spec|example|examples|benchmark|benchmarks|docs)$/i;
const DYNAMIC_RUNTIME_ACCESS = /\b(?:require|import)\s*\((?!\s*["'][^"']+["']\s*\))|\bprocess\.(?:binding|dlopen|mainModule)\b/;
const GLOBAL_FETCH = /\b(?:globalThis\.)?fetch\s*\(/;

export interface TriageOptions {
  runtimeDependencyCount?: number;
  maxLoc?: number;
  maxRuntimeDependencies?: number;
}

async function walk(directory: string, maximum: number): Promise<{ files: string[]; exceeded: boolean }> {
  const files: string[] = [];
  const directories = [directory];
  for (let index = 0; index < directories.length; index += 1) {
    const entries = await readdir(directories[index], { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directories[index], entry.name);
      if (entry.isDirectory()) directories.push(fullPath);
      else if (entry.isFile()) {
        files.push(fullPath);
        if (files.length > maximum) return { files, exceeded: true };
      }
    }
  }
  return { files, exceeded: false };
}

function lineCount(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lines += 1;
  }
  return source.endsWith("\n") || source.endsWith("\r") ? lines - 1 : lines;
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

/** Static scope gate that rejects dynamic capability access rather than executing it. */
export async function triagePackage(packagePath: string, options: TriageOptions = {}): Promise<TriageResult> {
  const manifestPath = path.join(packagePath, "package.json");
  let manifest: NpmPackageManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as NpmPackageManifest;
  } catch {
    throw new Error("The npm tarball does not contain a readable package.json.");
  }

  const walked = await walk(packagePath, MAX_PACKAGE_FILES);
  const nativeEvidence: string[] = manifest.gypfile ? ["package.json:gypfile"] : [];
  const filesystemImports = new Set<string>();
  const networkImports = new Set<string>();
  const dynamicRuntimeAccess = new Set<string>();
  let oversizedSourceFile: string | undefined;
  let loc = 0;

  for (const filePath of walked.files) {
    const relativePath = path.relative(packagePath, filePath).split(path.sep).join("/");
    if (relativePath.endsWith(".node")) nativeEvidence.push(relativePath);
    if (path.basename(relativePath) === "binding.gyp") nativeEvidence.push(relativePath);
    if (!isRuntimeSource(relativePath)) continue;

    if ((await stat(filePath)).size > MAX_SOURCE_FILE_BYTES) {
      oversizedSourceFile ??= relativePath;
      continue;
    }
    const source = await readFile(filePath, "utf8");
    loc += lineCount(source);
    for (const moduleName of importedModules(source)) {
      const normalized = normalizedModuleName(moduleName);
      if (FILESYSTEM_MODULES.has(normalized)) filesystemImports.add(moduleName);
      if (NETWORK_MODULES.has(normalized) || NETWORK_PACKAGES.has(normalized)) networkImports.add(moduleName);
    }
    if (DYNAMIC_RUNTIME_ACCESS.test(source)) dynamicRuntimeAccess.add(relativePath);
    if (GLOBAL_FETCH.test(source)) networkImports.add("global fetch()");
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
  if (walked.exceeded) {
    reasons.push({
      code: "TOO_MANY_FILES",
      message: `it has more than ${MAX_PACKAGE_FILES.toLocaleString()} files (v1 caps target inspection at ${MAX_PACKAGE_FILES.toLocaleString()})`
    });
  }
  if (oversizedSourceFile) {
    reasons.push({
      code: "TOO_LARGE_SOURCE_FILE",
      message: `it contains a source file larger than ${(MAX_SOURCE_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB (${oversizedSourceFile})`
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
  if (dynamicRuntimeAccess.size > 0) {
    reasons.push({
      code: "DYNAMIC_RUNTIME_ACCESS",
      message: "it dynamically accesses runtime capabilities that v1 cannot safely inspect"
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
