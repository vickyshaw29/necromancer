import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../json.js";
import { requestStructuredOutput } from "../openai.js";
import { codexAvailable } from "../probe/index.js";
import { runProcess } from "../process.js";
import { RebuildEnginePreference, RebuildGenerator, RebuildRequest } from "./types.js";

const REBUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: { source: { type: "string" } }
};

export const DEFAULT_CODEX_REBUILD_TIMEOUT_MS = 600_000;

export interface CodexRebuildConfiguration {
  timeoutMs: number;
}

export class RebuildEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebuildEngineUnavailableError";
  }
}

function sourceFrom(value: unknown): string {
  if (!isRecord(value) || typeof value.source !== "string" || !value.source.trim()) {
    throw new Error("Model response did not contain a TypeScript implementation.");
  }
  return value.source;
}

function promptFor(request: RebuildRequest): string {
  return [
    "Reconstruct a small npm package from observed behavior only.",
    "Return JSON matching the required schema with only the complete contents of src/index.ts in source.",
    "Implement modern strict TypeScript that compiles to both ESM and CommonJS. Use zero runtime dependencies and preserve the listed public exports.",
    "Do not import, require, inspect, or reference the original package or its source. This is behavioral reconstruction for compatibility from the supplied observations.",
    "Use the SOUL and characterization test as the complete behavioral contract. The test runner resolves the rebuilt directory as the package root.",
    `Round: ${request.round}`,
    `Public API shape:\n${JSON.stringify(request.api)}`,
    `Failure feedback from the preceding round:\n${JSON.stringify(request.failures) || "[]"}`,
    request.previousSource ? `Previous candidate source to revise:\n${request.previousSource}` : "No previous candidate source exists.",
    `SOUL.md:\n${request.soul}`,
    `soul.test.ts:\n${request.soulTest}`
  ].join("\n\n");
}

export function codexRebuildConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  onNotice: (message: string) => void = (message) => console.error(`[RESURRECT] ${message}`)
): CodexRebuildConfiguration {
  const configured = environment.NECROMANCER_CODEX_TIMEOUT_MS;
  if (configured === undefined) return { timeoutMs: DEFAULT_CODEX_REBUILD_TIMEOUT_MS };
  if (!/^[1-9]\d*$/.test(configured)) {
    onNotice(`NECROMANCER_CODEX_TIMEOUT_MS must be a positive integer; using ${DEFAULT_CODEX_REBUILD_TIMEOUT_MS} ms.`);
    return { timeoutMs: DEFAULT_CODEX_REBUILD_TIMEOUT_MS };
  }
  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs)) {
    onNotice(`NECROMANCER_CODEX_TIMEOUT_MS must be a positive integer; using ${DEFAULT_CODEX_REBUILD_TIMEOUT_MS} ms.`);
    return { timeoutMs: DEFAULT_CODEX_REBUILD_TIMEOUT_MS };
  }
  return { timeoutMs };
}

export function createApiRebuildGenerator(apiKey: string, request: typeof fetch = fetch): RebuildGenerator {
  return {
    name: "api",
    async generate(rebuildRequest): Promise<string> {
      const output = await requestStructuredOutput({
        apiKey,
        input: promptFor(rebuildRequest),
        schemaName: "rebuilt_typescript",
        schema: REBUILD_SCHEMA,
        timeoutMs: 90_000,
        request
      });
      return sourceFrom(JSON.parse(output));
    }
  };
}

async function writeWorkOrder(directory: string, request: RebuildRequest): Promise<void> {
  await Promise.all([
    writeFile(path.join(directory, "SOUL.md"), request.soul, "utf8"),
    writeFile(path.join(directory, "soul.test.ts"), request.soulTest, "utf8"),
    writeFile(path.join(directory, "public-api.json"), `${JSON.stringify(request.api, null, 2)}\n`, "utf8"),
    writeFile(path.join(directory, "failure-feedback.json"), `${JSON.stringify(request.failures, null, 2)}\n`, "utf8"),
    writeFile(path.join(directory, "previous-candidate.ts"), request.previousSource ?? "", "utf8")
  ]);
}

export function createCodexRebuildGenerator(configuration: CodexRebuildConfiguration = codexRebuildConfiguration()): RebuildGenerator {
  return {
    name: "codex",
    async generate(request): Promise<string> {
      const base = path.join(process.cwd(), ".necromancer-cache", "rebuild-workorder-");
      await mkdir(path.dirname(base), { recursive: true });
      const directory = await mkdtemp(base);
      const schemaPath = path.join(directory, "rebuild.schema.json");
      const outputPath = path.join(directory, "rebuild.json");
      try {
        await Promise.all([writeWorkOrder(directory, request), writeFile(schemaPath, `${JSON.stringify(REBUILD_SCHEMA)}\n`, "utf8")]);
        const result = await runProcess(
          "codex",
          [
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            directory,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "Read the supplied work-order files. Return only the required JSON TypeScript source. Do not inspect or reference any original package source."
          ],
          { cwd: directory, timeoutMs: configuration.timeoutMs }
        );
        if (result.code !== 0) throw new Error(`codex exited with ${result.code}: ${(result.stderr || result.stdout).trim() || "no output"}`);
        return sourceFrom(JSON.parse(await readFile(outputPath, "utf8")));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

export function createAutoRebuildGenerator(primary: RebuildGenerator, fallback: RebuildGenerator | undefined): RebuildGenerator {
  let active = primary;
  return {
    get name(): string {
      return active.name;
    },
    async generate(request): Promise<string> {
      try {
        return await active.generate(request);
      } catch (error) {
        if (!fallback || active === fallback) throw error;
        active = fallback;
        throw error;
      }
    }
  };
}

export async function selectRebuildGenerator(preference: RebuildEnginePreference = "auto"): Promise<RebuildGenerator> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (preference === "api") {
    if (!apiKey) throw new RebuildEngineUnavailableError("--engine api requires OPENAI_API_KEY. Resurrection requires a model engine.");
    return createApiRebuildGenerator(apiKey);
  }
  if (preference === "codex") {
    if (!(await codexAvailable())) throw new RebuildEngineUnavailableError("--engine codex requires the Codex CLI. Resurrection requires a model engine.");
    return createCodexRebuildGenerator();
  }
  const codex = (await codexAvailable()) ? createCodexRebuildGenerator() : undefined;
  if (codex) return createAutoRebuildGenerator(codex, apiKey ? createApiRebuildGenerator(apiKey) : undefined);
  if (apiKey) return createApiRebuildGenerator(apiKey);
  throw new RebuildEngineUnavailableError("No OpenAI API key or Codex CLI is available. Resurrection requires a model engine; use --engine api with OPENAI_API_KEY or configure Codex CLI.");
}
