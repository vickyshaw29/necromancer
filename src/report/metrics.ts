import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { SourceMetrics } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRECTORIES = new Set(["dist", "node_modules", ".git"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function lineCount(source: string): number {
  if (!source) return 0;
  const lines = source.split(/\r\n|\n|\r/);
  return source.endsWith("\n") || source.endsWith("\r") ? lines.length - 1 : lines.length;
}

async function collectSourceFiles(directory: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) await collectSourceFiles(path.join(directory, entry.name), files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(directory, entry.name));
    }
  }
}

export async function rebuiltMetrics(rebuiltDirectory: string): Promise<SourceMetrics> {
  const manifestValue: unknown = JSON.parse(await readFile(path.join(rebuiltDirectory, "package.json"), "utf8"));
  if (!isRecord(manifestValue)) throw new Error("The rebuilt package has an invalid package.json.");
  const files: string[] = [];
  await collectSourceFiles(path.join(rebuiltDirectory, "src"), files);
  const sources = await Promise.all(files.map((filePath) => readFile(filePath, "utf8")));
  return {
    loc: sources.reduce((total, source) => total + lineCount(source), 0),
    runtimeDependencies: new Set([
      ...Object.keys(isRecord(manifestValue.dependencies) ? manifestValue.dependencies : {}),
      ...Object.keys(isRecord(manifestValue.optionalDependencies) ? manifestValue.optionalDependencies : {})
    ]).size
  };
}
