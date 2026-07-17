import fc from "fast-check";
import { JsonSafeValue } from "../sandbox/index.js";
import { DiscoveryResult, FunctionInputPlan, InputCandidate, InputPlan } from "./types.js";

const INPUT_TAG = "$necromancer";

function prototypePayload(): Record<string, unknown> {
  return JSON.parse('{"__proto__":{"necromancerProbe":true},"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>;
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
    if (Array.isArray(value)) return value.map((item, index) => toArtifactValue(item, ancestors, `${valuePath}[${index}]`));
    const output: Record<string, JsonSafeValue> = Object.create(null);
    for (const [key, item] of Object.entries(value)) output[key] = toArtifactValue(item, ancestors, `${valuePath}.${key}`);
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function semanticCandidates(arity: number): unknown[][] {
  const width = Math.max(1, Math.min(arity || 1, 3));
  const baseline: unknown[] = Array.from({ length: width }, () => "x");
  const scalars: unknown[] = [
    "",
    "x",
    "hello",
    "😀",
    "e\u0301",
    "x".repeat(1_024),
    0,
    1,
    -1,
    2,
    5,
    42,
    10_000,
    Number.NaN,
    Infinity,
    -Infinity,
    null,
    undefined,
    true,
    false,
    [],
    {},
    prototypePayload()
  ];
  const candidates: unknown[][] = [[], [...baseline]];
  for (let position = 0; position < width; position += 1) {
    for (const scalar of scalars) {
      const args = [...baseline];
      args[position] = scalar;
      candidates.push(args);
    }
  }
  return candidates;
}

function seedFor(path: string): number {
  let hash = 2_166_136_261;
  for (const character of path) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
}

function amplifiedCandidates(arity: number, exportPath: string, count: number): unknown[][] {
  const width = Math.max(1, Math.min(arity || 1, 3));
  const primitive = fc.oneof(
    fc.string({ maxLength: 64 }),
    fc.integer({ min: -10_000, max: 10_000 }),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.integer({ min: -8, max: 8 }), { maxLength: 8 }),
    fc.constant(prototypePayload())
  );
  return fc.sample(fc.array(primitive, { minLength: width, maxLength: width }), {
    numRuns: count,
    seed: seedFor(exportPath)
  });
}

export function heuristicInputPlan(discovery: DiscoveryResult): InputPlan {
  return {
    functions: discovery.surface.exports
      .filter((item) => item.type === "function")
      .map((item) => ({
        exportPath: item.path,
        candidates: semanticCandidates(item.arity ?? 1).slice(0, 24).map((args) => ({ args, rationale: "deterministic type-informed seed" }))
      }))
  };
}

function candidatesForFunction(
  exportPath: string,
  arity: number,
  modelCandidates: InputCandidate[],
  examples: InputCandidate[],
  maxCandidates: number
): unknown[][] {
  const all = [
    ...modelCandidates.map((candidate) => candidate.args),
    ...examples.map((candidate) => candidate.args),
    ...semanticCandidates(arity),
    ...amplifiedCandidates(arity, exportPath, Math.max(24, maxCandidates))
  ];
  const seen = new Set<string>();
  const unique: unknown[][] = [];
  for (const args of all) {
    const key = stableInput(args);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(args);
    if (unique.length >= maxCandidates) break;
  }
  return unique;
}

/** Merge model seeds, shipped examples, and deterministic fast-check mutations. */
export function buildProbeCandidates(discovery: DiscoveryResult, plan: InputPlan, maxBehaviors: number): Array<{ fn: string; args: unknown[] }> {
  const functions = discovery.surface.exports.filter((item) => item.type === "function");
  const perFunction = Math.max(1, Math.ceil(maxBehaviors / Math.max(functions.length, 1)));
  const planByPath = new Map(plan.functions.map((item) => [item.exportPath, item.candidates]));
  const examplesByPath = new Map<string, InputCandidate[]>();
  for (const example of discovery.examples) {
    const current = examplesByPath.get(example.exportPath) ?? [];
    current.push({ args: example.args, rationale: example.source });
    examplesByPath.set(example.exportPath, current);
  }

  return functions.flatMap((item) =>
    candidatesForFunction(item.path, item.arity ?? 1, planByPath.get(item.path) ?? [], examplesByPath.get(item.path) ?? [], perFunction).map(
      (args) => ({ fn: item.path, args })
    )
  );
}
