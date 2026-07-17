import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { codexAvailable } from "../probe/index.js";
import { renderHeuristicSoul } from "./soul.js";
import { DistillEnginePreference, SoulEngine, SoulRequest } from "./types.js";

const MODEL = "gpt-5.6";
const MAX_EVIDENCE_CHARS = 48_000;

const SOUL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["soulMarkdown"],
  properties: { soulMarkdown: { type: "string" } }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "undefined";
  return serialized.length > 360 ? `${serialized.slice(0, 357)}...` : serialized;
}

function evidenceFor(request: SoulRequest): string {
  const ids = request.behaviors.map((behavior) => behavior.id).join(", ");
  const entries = request.behaviors
    .map((behavior) => {
      const outcome = behavior.throw
        ? `throw ${behavior.throw.name}: ${JSON.stringify(behavior.throw.message)}`
        : `return ${describe(behavior.result)}`;
      return `${behavior.id} | export: ${behavior.fn} | args: ${describe(behavior.args)} | ${outcome}`;
    })
    .join("\n");
  return `Evidence IDs requiring citations: ${ids}\n\n${entries.slice(0, MAX_EVIDENCE_CHARS)}`;
}

function promptFor(request: SoulRequest): string {
  return [
    "Write a factual Markdown behavioral specification from the recorded observations below.",
    "Do not infer unrecorded behavior. Every bullet must cite one or more evidence IDs.",
    `Use headings: # SOUL — ${request.packageName}, ## Observed fidelity, ## Behavioral clusters, and ## Quirks.`,
    "Under Behavioral clusters, use a ### heading for every exported function and named #### headings for its meaningful input categories. In Quirks, plainly record error text, coercion, unusual returns, and unusual property-key input/output facts. Do not use security or exploit framing.",
    `The fidelity sentence must be exactly: This specification covers ${request.behaviors.length} observed behaviors, ${request.coverage.branchCoverage.toFixed(2)}% branch coverage of the original.`,
    "Do not claim identical behavior or use the phrase 100% parity.",
    `Package: ${request.packageName}`,
    evidenceFor(request)
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

function validateSoul(value: unknown, request: SoulRequest): string {
  if (!isRecord(value) || typeof value.soulMarkdown !== "string") throw new Error("Model response did not contain a Markdown soul.");
  const markdown = value.soulMarkdown.trim();
  const expectedFidelity = `This specification covers ${request.behaviors.length} observed behaviors, ${request.coverage.branchCoverage.toFixed(2)}% branch coverage of the original.`;
  if (
    !markdown.includes(`# SOUL — ${request.packageName}`) ||
    !markdown.includes("## Behavioral clusters") ||
    !markdown.includes("## Quirks") ||
    !markdown.includes("### ") ||
    !markdown.includes("#### ")
  ) {
    throw new Error("Model response omitted a required SOUL section.");
  }
  if (!markdown.includes(expectedFidelity)) throw new Error("Model response did not preserve the required observed-fidelity statement.");
  if (/100%\s+parity|\bidentical\b/i.test(markdown)) throw new Error("Model response made an unsupported fidelity claim.");
  const uncited = request.behaviors.find((behavior) => !markdown.includes(behavior.id));
  if (uncited) throw new Error(`Model response omitted evidence ID ${uncited.id}.`);
  return `${markdown}\n`;
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
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
      finish(() => reject(new Error(`${command} exceeded its ${timeoutMs} ms limit.`)));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8").slice(0, 500 - stderr.length);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`${command} exited with ${code}: ${stderr.trim() || "no error output"}`)));
    });
  });
}

export function createHeuristicSoulEngine(): SoulEngine {
  return { name: "heuristic", async generate(request): Promise<string> { return renderHeuristicSoul(request); } };
}

export function createApiSoulEngine(apiKey: string, request: typeof fetch = fetch): SoulEngine {
  return {
    name: "api",
    async generate(soulRequest): Promise<string> {
      const response = await request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          input: promptFor(soulRequest),
          text: { format: { type: "json_schema", name: "distilled_soul", strict: false, schema: SOUL_SCHEMA } }
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`OpenAI API responded with ${response.status}.`);
      const text = outputText(await response.json());
      if (!text) throw new Error("OpenAI API response had no structured output text.");
      return validateSoul(JSON.parse(text), soulRequest);
    }
  };
}

export function createCodexSoulEngine(): SoulEngine {
  return {
    name: "codex",
    async generate(request): Promise<string> {
      const base = path.join(process.cwd(), ".necromancer-cache", "codex-soul-");
      await mkdir(path.dirname(base), { recursive: true });
      const directory = await mkdtemp(base);
      const schemaPath = path.join(directory, "soul.schema.json");
      const outputPath = path.join(directory, "soul.json");
      try {
        await writeFile(schemaPath, `${JSON.stringify(SOUL_SCHEMA)}\n`, "utf8");
        await runCommand(
          "codex",
          [
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            process.cwd(),
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            promptFor(request)
          ],
          process.cwd(),
          90_000
        );
        return validateSoul(JSON.parse(await readFile(outputPath, "utf8")), request);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
}

export interface SoulGenerationOptions {
  preference?: DistillEnginePreference;
  request: SoulRequest;
  onNotice?: (message: string) => void;
}

export async function generateSoul(options: SoulGenerationOptions): Promise<{ engine: string; soul: string }> {
  const preference = options.preference ?? "auto";
  const notice = options.onNotice ?? (() => undefined);
  const heuristic = createHeuristicSoulEngine();
  const use = async (engine: SoulEngine): Promise<{ engine: string; soul: string } | undefined> => {
    try {
      return { engine: engine.name, soul: await engine.generate(options.request) };
    } catch (error) {
      notice(`[DISTILL] ${engine.name} prose generation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return undefined;
    }
  };
  const apiKey = process.env.OPENAI_API_KEY;

  if (preference === "heuristic") return { engine: heuristic.name, soul: await heuristic.generate(options.request) };
  if (preference === "api") {
    if (!apiKey) notice("[DISTILL] OPENAI_API_KEY is unavailable; using the deterministic heuristic writer.");
    else {
      const result = await use(createApiSoulEngine(apiKey));
      if (result) return result;
    }
    return { engine: heuristic.name, soul: await heuristic.generate(options.request) };
  }
  if (preference === "codex") {
    if (await codexAvailable()) {
      const result = await use(createCodexSoulEngine());
      if (result) return result;
    } else notice("[DISTILL] Codex CLI is unavailable; using the deterministic heuristic writer.");
    return { engine: heuristic.name, soul: await heuristic.generate(options.request) };
  }
  if (apiKey) {
    const result = await use(createApiSoulEngine(apiKey));
    if (result) return result;
  }
  if (await codexAvailable()) {
    const result = await use(createCodexSoulEngine());
    if (result) return result;
  } else {
    notice("[DISTILL] No API key or Codex CLI is available; using the deterministic heuristic writer.");
  }
  return { engine: heuristic.name, soul: await heuristic.generate(options.request) };
}
