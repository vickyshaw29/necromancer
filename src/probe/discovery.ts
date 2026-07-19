import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { SandboxRunner } from "../sandbox/index.js";
import { DiscoveryResult, ExampleCall } from "./types.js";

const MAX_FILES = 250;
const MAX_DIRECTORIES = 1_000;
const MAX_TEXT_BYTES = 64_000;
const SOURCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  const directories = [directory];
  for (let index = 0; index < directories.length && files.length < MAX_FILES && index < MAX_DIRECTORIES; index += 1) {
    const entries = await readdir(directories[index], { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const fullPath = path.join(directories[index], entry.name);
      if (entry.isDirectory() && directories.length < MAX_DIRECTORIES) directories.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

async function readSnippet(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_TEXT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function isTestFile(relativePath: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(relativePath);
}

function splitArguments(source: string): string[] | undefined {
  const tokens: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      tokens.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return undefined;
  const finalToken = source.slice(start).trim();
  if (finalToken) tokens.push(finalToken);
  return tokens;
}

function parseLiteral(token: string): unknown | undefined {
  if (token === "undefined") return undefined;
  if (token === "null") return null;
  if (token === "true") return true;
  if (token === "false") return false;
  if (/^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return Number(token);
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token);
    } catch {
      return undefined;
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  if ((token.startsWith("[") && token.endsWith("]")) || (token.startsWith("{") && token.endsWith("}"))) {
    try {
      return JSON.parse(token.replace(/'/g, '"'));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseArguments(source: string): unknown[] | undefined {
  if (source.trim() === "") return [];
  const tokens = splitArguments(source);
  if (!tokens) return undefined;
  const values: unknown[] = [];
  for (const token of tokens) {
    const value = parseLiteral(token);
    if (value === undefined && token !== "undefined") return undefined;
    values.push(value);
  }
  return values;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function callsFromText(text: string, source: "readme" | "test", functionPaths: string[]): ExampleCall[] {
  const calls: ExampleCall[] = [];
  for (const exportPath of functionPaths) {
    const lastSegment = exportPath.split(".").at(-1) ?? exportPath;
    if (!/^[A-Za-z_$][\w$]*$/.test(lastSegment)) continue;
    const matcher = new RegExp(`\\b${escapeRegex(lastSegment)}\\s*\\(([^()\\n]{0,500})\\)`, "g");
    for (const match of text.matchAll(matcher)) {
      const args = parseArguments(match[1]);
      if (!args) continue;
      calls.push({ exportPath, args, source, snippet: match[0] });
    }
  }
  return calls;
}

function codeFences(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

/** Discover callable exports in the sandbox and conservative examples from shipped text. */
export async function discoverPackage(
  sandbox: SandboxRunner,
  packagePath: string
): Promise<DiscoveryResult> {
  const surface = await sandbox.inspect();
  const functionPaths = surface.exports.filter((item) => item.type === "function").map((item) => item.path);
  const files = await walk(packagePath);
  const readmes = files.filter((filePath) => /^readme(?:\.|$)/i.test(path.basename(filePath)));
  const testFiles = files.filter((filePath) => isTestFile(path.relative(packagePath, filePath)) && SOURCE_EXTENSIONS.has(path.extname(filePath)));
  const sourceFiles = files.filter(
    (filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath)) && !isTestFile(path.relative(packagePath, filePath))
  );

  const readmeParts = await Promise.all(readmes.slice(0, 3).map(readSnippet));
  const testParts = await Promise.all(testFiles.slice(0, 20).map(readSnippet));
  const sourceParts = await Promise.all(sourceFiles.slice(0, 8).map(readSnippet));
  const readme = readmeParts.join("\n\n").slice(0, MAX_TEXT_BYTES);
  const examples = [
    ...codeFences(readme).flatMap((fence) => callsFromText(fence, "readme", functionPaths)),
    ...testParts.flatMap((test) => callsFromText(test, "test", functionPaths))
  ];

  return {
    surface,
    examples,
    readme,
    sourceExcerpt: sourceParts.join("\n\n").slice(0, MAX_TEXT_BYTES)
  };
}
