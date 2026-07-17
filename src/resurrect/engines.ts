import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexAvailable } from "../probe/index.js";
import { runProcess } from "./process.js";
import { RebuildEnginePreference, RebuildGenerator, RebuildRequest } from "./types.js";

const MODEL = "gpt-5.6";

const REBUILD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["source"],
  properties: { source: { type: "string" } }
};

export class RebuildEngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebuildEngineUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function outputText(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (isRecord(content) && typeof content.text === "string") return content.text;
  }
  return undefined;
}

export function createApiRebuildGenerator(apiKey: string, request: typeof fetch = fetch): RebuildGenerator {
  return {
    name: "api",
    async generate(rebuildRequest): Promise<string> {
      const response = await request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          input: promptFor(rebuildRequest),
          text: { format: { type: "json_schema", name: "rebuilt_typescript", strict: false, schema: REBUILD_SCHEMA } }
        }),
        signal: AbortSignal.timeout(90_000)
      });
      if (!response.ok) throw new Error(`OpenAI API responded with ${response.status}.`);
      const output = outputText(await response.json());
      if (!output) throw new Error("OpenAI API response had no structured output text.");
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

export function createCodexRebuildGenerator(): RebuildGenerator {
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
          { cwd: directory, timeoutMs: 120_000 }
        );
        if (result.code !== 0) throw new Error(`codex exited with ${result.code}: ${(result.stderr || result.stdout).trim() || "no output"}`);
        return sourceFrom(JSON.parse(await readFile(outputPath, "utf8")));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

function createAutoRebuildGenerator(primary: RebuildGenerator, fallback: RebuildGenerator | undefined): RebuildGenerator {
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
        return active.generate(request);
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
  if (apiKey) return createAutoRebuildGenerator(createApiRebuildGenerator(apiKey), codex);
  if (codex) return codex;
  throw new RebuildEngineUnavailableError("No OpenAI API key or Codex CLI is available. Resurrection requires a model engine; use --engine api with OPENAI_API_KEY or configure Codex CLI.");
}
