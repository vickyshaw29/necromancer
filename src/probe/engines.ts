import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestStructuredOutput } from "../openai.js";
import { runCheckedProcess } from "../process.js";
import { DiscoveryResult, InputPlan, InputPlanEngine, PlanRequest, ProbeEnginePreference } from "./types.js";
import { heuristicInputPlan } from "./candidates.js";
export { loadDotEnv } from "./env.js";

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["functions"],
  properties: {
    functions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["exportPath", "candidates"],
        properties: {
          exportPath: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["args"],
              properties: { args: { type: "array", items: {} }, rationale: { type: "string" } }
            }
          }
        }
      }
    }
  }
};

function promptFor(request: PlanRequest): string {
  const functions = request.functions.map((item) => `${item.path} (${item.arity ?? 0} args)`).join(", ");
  const examples = request.examples.slice(0, 20).map((item) => `${item.exportPath}(${item.args.map((arg) => JSON.stringify(arg)).join(", ")})`).join("\n");
  return [
    "Create a JSON input plan for an isolated JavaScript package probe.",
    "Return only an object matching the provided schema. Include around 20 meaningful candidates per callable export.",
    "Cover normal usage, empty values, Unicode, boundaries, wrong types, very long strings, and prototype-pollution-shaped objects. Do not invent exports.",
    `Package: ${request.packageName}`,
    `Callable exports: ${functions}`,
    `Observed examples:\n${examples || "(none)"}`,
    `README excerpt:\n${request.readme.slice(0, 12_000) || "(none)"}`,
    `Source excerpt:\n${request.sourceExcerpt.slice(0, 16_000) || "(none)"}`
  ].join("\n\n");
}

function validatePlan(value: unknown, request: PlanRequest): InputPlan {
  if (!value || typeof value !== "object" || !Array.isArray((value as { functions?: unknown }).functions)) {
    throw new Error("Model response did not contain an input plan.");
  }
  const allowed = new Set(request.functions.filter((item) => item.type === "function").map((item) => item.path));
  const functions: InputPlan["functions"] = [];
  for (const item of (value as { functions: unknown[] }).functions) {
    if (!item || typeof item !== "object") continue;
    const object = item as { exportPath?: unknown; candidates?: unknown };
    if (typeof object.exportPath !== "string" || !allowed.has(object.exportPath) || !Array.isArray(object.candidates)) continue;
    const candidates = object.candidates
      .filter((candidate): candidate is { args: unknown[]; rationale?: string } => {
        return !!candidate && typeof candidate === "object" && Array.isArray((candidate as { args?: unknown }).args);
      })
      .slice(0, 40)
      .map((candidate) => ({ args: candidate.args, ...(typeof candidate.rationale === "string" ? { rationale: candidate.rationale } : {}) }));
    functions.push({ exportPath: object.exportPath, candidates });
  }
  if (functions.length === 0) throw new Error("Model plan did not contain candidates for exported functions.");
  return { functions };
}

export function createHeuristicEngine(discovery: DiscoveryResult): InputPlanEngine {
  return {
    name: "heuristic",
    async generate(): Promise<InputPlan> {
      return heuristicInputPlan(discovery);
    }
  };
}

export function createApiEngine(apiKey: string, request: typeof fetch = fetch): InputPlanEngine {
  return {
    name: "api",
    async generate(planRequest: PlanRequest): Promise<InputPlan> {
      const text = await requestStructuredOutput({
        apiKey,
        input: promptFor(planRequest),
        schemaName: "probe_input_plan",
        schema: PLAN_SCHEMA,
        timeoutMs: 60_000,
        request
      });
      return validatePlan(JSON.parse(text), planRequest);
    }
  };
}

export async function codexAvailable(): Promise<boolean> {
  try {
    await runCheckedProcess("codex", ["--version"], { cwd: process.cwd(), timeoutMs: 5_000, maxOutputChars: 500 });
    return true;
  } catch {
    return false;
  }
}

export function createCodexEngine(): InputPlanEngine {
  return {
    name: "codex",
    async generate(planRequest: PlanRequest): Promise<InputPlan> {
      const root = await mkdtemp(path.join(os.tmpdir(), "necromancer-codex-plan-"));
      const schemaPath = path.join(root, "input-plan.schema.json");
      const outputPath = path.join(root, "input-plan.json");
      try {
        await writeFile(schemaPath, `${JSON.stringify(PLAN_SCHEMA)}\n`, "utf8");
        await runCheckedProcess(
          "codex",
          [
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "-C",
            planRequest.packagePath,
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            promptFor(planRequest)
          ],
          { cwd: planRequest.packagePath, timeoutMs: 90_000, maxOutputChars: 500 }
        );
        return validatePlan(JSON.parse(await readFile(outputPath, "utf8")), planRequest);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
}

export interface PlanGenerationOptions {
  preference?: ProbeEnginePreference;
  discovery: DiscoveryResult;
  request: PlanRequest;
  onNotice?: (message: string) => void;
}

export async function generateInputPlan(options: PlanGenerationOptions): Promise<{ engine: string; plan: InputPlan }> {
  const preference = options.preference ?? "auto";
  const apiKey = process.env.OPENAI_API_KEY;
  const notice = options.onNotice ?? (() => undefined);
  const fallback = createHeuristicEngine(options.discovery);
  const tryEngine = async (engine: InputPlanEngine): Promise<{ engine: string; plan: InputPlan } | undefined> => {
    try {
      return { engine: engine.name, plan: await engine.generate(options.request) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      notice(`[PROBE] ${engine.name} input planning failed: ${detail}`);
      return undefined;
    }
  };

  if (preference === "heuristic") return { engine: fallback.name, plan: await fallback.generate(options.request) };
  if (preference === "api") {
    if (!apiKey) notice("[PROBE] OPENAI_API_KEY is unavailable; falling back to the deterministic heuristic planner.");
    else {
      const result = await tryEngine(createApiEngine(apiKey));
      if (result) return result;
    }
    return { engine: fallback.name, plan: await fallback.generate(options.request) };
  }
  if (preference === "codex") {
    if (await codexAvailable()) {
      const result = await tryEngine(createCodexEngine());
      if (result) return result;
    } else notice("[PROBE] Codex CLI is unavailable; falling back to the deterministic heuristic planner.");
    return { engine: fallback.name, plan: await fallback.generate(options.request) };
  }

  if (apiKey) {
    const apiResult = await tryEngine(createApiEngine(apiKey));
    if (apiResult) return apiResult;
  }
  if (await codexAvailable()) {
    const codexResult = await tryEngine(createCodexEngine());
    if (codexResult) return codexResult;
  } else {
    notice("[PROBE] No API key or Codex CLI is available; using the deterministic heuristic planner.");
  }
  return { engine: fallback.name, plan: await fallback.generate(options.request) };
}
