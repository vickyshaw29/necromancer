import { JsonSafeValue } from "../sandbox/index.js";
import { DiscoveryResult, InputCandidate, InputPlan } from "./types.js";
import {
  amplifiedSemanticCandidates,
  argumentShapeCandidates,
  isProbeInput,
  lastRitesCandidates,
  semanticCandidates
} from "./shapes.js";

const INPUT_TAG = "$necromancer";
const MIN_AMPLIFIED_CANDIDATES = 16;
const MAX_MODEL_CANDIDATES = 40;
const MAX_EXAMPLE_CANDIDATES = 24;
const MAX_HELD_OUT_BEHAVIORS = 16;

export interface ProbeCandidate {
  fn: string;
  args: unknown[];
}

export interface ProbeCandidateBatches {
  observed: ProbeCandidate[];
  heldOut: ProbeCandidate[];
}

interface CallableExport {
  path: string;
  arity?: number;
}

function hasInputTag(value: Record<string, JsonSafeValue>): boolean {
  return Object.prototype.hasOwnProperty.call(value, INPUT_TAG);
}

function stableInput(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Infinity) return "number:Infinity";
    if (value === -Infinity) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
  }
  if (Array.isArray(value)) return `[${value.map(stableInput).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableInput(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueArgs(candidates: unknown[][], limit: number, excluded = new Set<string>()): unknown[][] {
  if (limit <= 0) return [];
  const unique: unknown[][] = [];
  const seen = new Set(excluded);
  for (const args of candidates) {
    if (!isProbeInput(args)) continue;
    const key = stableInput(args);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(args);
    if (unique.length >= limit) break;
  }
  return unique;
}

function candidatesForFunction(
  exportPath: string,
  arity: number | undefined,
  modelCandidates: InputCandidate[],
  examples: InputCandidate[],
  count: number
): unknown[][] {
  const fixedShapes = argumentShapeCandidates();
  const supplied = [...modelCandidates.slice(0, MAX_MODEL_CANDIDATES), ...examples.slice(0, MAX_EXAMPLE_CANDIDATES)].map((candidate) => candidate.args);
  const semantic = semanticCandidates(arity);
  const amplified = amplifiedSemanticCandidates(arity, exportPath, Math.max(MIN_AMPLIFIED_CANDIDATES, count));
  return uniqueArgs([...fixedShapes, ...supplied, ...semantic, ...amplified], count);
}

function callableExports(discovery: DiscoveryResult): CallableExport[] {
  const seen = new Set<string>();
  return discovery.surface.exports.flatMap((item) => {
    if (item.type !== "function" || seen.has(item.path)) return [];
    seen.add(item.path);
    return [{ path: item.path, ...(item.arity === undefined ? {} : { arity: item.arity }) }];
  });
}

function quotas(functionCount: number, budget: number): number[] {
  if (functionCount === 0 || budget === 0) return Array.from({ length: functionCount }, () => 0);
  const base = Math.floor(budget / functionCount);
  const remainder = budget % functionCount;
  return Array.from({ length: functionCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

function roundRobin(functions: CallableExport[], candidateLists: unknown[][][]): ProbeCandidate[] {
  const output: ProbeCandidate[] = [];
  let index = 0;
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const [functionIndex, plan] of functions.entries()) {
      const args = candidateLists[functionIndex][index];
      if (!args) continue;
      output.push({ fn: plan.path, args });
      remaining = true;
    }
    index += 1;
  }
  return output;
}

function examplesByPath(discovery: DiscoveryResult): Map<string, InputCandidate[]> {
  const examples = new Map<string, InputCandidate[]>();
  for (const example of discovery.examples) {
    const current = examples.get(example.exportPath) ?? [];
    current.push({ args: example.args, rationale: example.source });
    examples.set(example.exportPath, current);
  }
  return examples;
}

function heldOutBudget(observedBudget: number): number {
  return Math.min(MAX_HELD_OUT_BEHAVIORS, Math.max(1, Math.floor(observedBudget / 5)));
}

/** Convert values to the tagged JSON form used by probe artifacts. */
export function toArtifactValue(value: unknown, ancestors = new WeakMap<object, string>(), valuePath = "$"): JsonSafeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return { [INPUT_TAG]: "undefined" };
  if (typeof value === "bigint") return { [INPUT_TAG]: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { [INPUT_TAG]: "number", value: "NaN" };
    if (value === Infinity) return { [INPUT_TAG]: "number", value: "Infinity" };
    if (value === -Infinity) return { [INPUT_TAG]: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { [INPUT_TAG]: "number", value: "-0" };
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") return { [INPUT_TAG]: typeof value };
  if (ancestors.has(value)) return { [INPUT_TAG]: "circular", path: ancestors.get(value) ?? "$" };
  ancestors.set(value, valuePath);
  try {
    if (Array.isArray(value)) {
      const output: JsonSafeValue[] = [];
      const length = Reflect.get(value, "length");
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        output.push(
          Object.prototype.hasOwnProperty.call(value, key)
            ? toArtifactValue(Reflect.get(value, key), ancestors, `${valuePath}[${index}]`)
            : null
        );
      }
      return output;
    }
    const output: Record<string, JsonSafeValue> = Object.create(null);
    for (const key of Object.keys(value)) output[key] = toArtifactValue(Reflect.get(value, key), ancestors, `${valuePath}.${key}`);
    return hasInputTag(output) ? { [INPUT_TAG]: "object", value: output } : output;
  } finally {
    ancestors.delete(value);
  }
}

export function heuristicInputPlan(discovery: DiscoveryResult): InputPlan {
  return {
    functions: callableExports(discovery).map((item) => {
      return {
        exportPath: item.path,
        candidates: semanticCandidates(item.arity).slice(0, 24).map((args) => ({ args, rationale: "deterministic type-informed seed" }))
      };
    })
  };
}

/** Build public evidence and a separate deterministic evaluation batch. */
export function buildProbeCandidateBatches(discovery: DiscoveryResult, plan: InputPlan, maxBehaviors: number): ProbeCandidateBatches {
  const functions = callableExports(discovery);
  const planByPath = new Map(plan.functions.map((item) => [item.exportPath, item.candidates]));
  const examples = examplesByPath(discovery);
  const observedQuotas = quotas(functions.length, maxBehaviors);
  const observedLists = functions.map((item, index) => {
    if (observedQuotas[index] === 0) return [];
    return candidatesForFunction(item.path, item.arity, planByPath.get(item.path) ?? [], examples.get(item.path) ?? [], observedQuotas[index]);
  });
  const observed = roundRobin(functions, observedLists);
  const knownByFunction = new Map<string, Set<string>>();
  for (const candidate of observed) {
    const known = knownByFunction.get(candidate.fn) ?? new Set<string>();
    known.add(stableInput(candidate.args));
    knownByFunction.set(candidate.fn, known);
  }
  const heldOutQuotas = quotas(functions.length, heldOutBudget(maxBehaviors));
  const heldOutLists = functions.map((item, index) => {
    if (heldOutQuotas[index] === 0) return [];
    return uniqueArgs(lastRitesCandidates(item.arity, item.path, heldOutQuotas[index] + 8), heldOutQuotas[index], knownByFunction.get(item.path));
  });
  return { observed, heldOut: roundRobin(functions, heldOutLists) };
}
