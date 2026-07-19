import fc from "fast-check";

const MAX_ARGUMENTS_PER_CALL = 8;
const MAX_INPUT_DEPTH = 8;
const MAX_INPUT_ENTRIES = 64;
const MAX_INPUT_NODES = 256;
const MAX_INPUT_STRING_LENGTH = 4_096;

export const REQUIRED_ARGUMENT_COUNTS: readonly number[] = Object.freeze([0, 1, 2, 3]);

function prototypePayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = Object.create(null);
  payload["__proto__"] = { necromancerProbe: true };
  payload["constructor"] = { prototype: { polluted: true } };
  return payload;
}

function nestedValue(label: string): Record<string, unknown> {
  return {
    label,
    nested: { depth: 2, values: [0, "x", true] },
    metadata: { empty: false }
  };
}

function seedFor(exportPath: string, namespace: string): number {
  let hash = 2_166_136_261;
  for (const character of `${namespace}:${exportPath}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
}

function operationalWidth(arity: number | undefined): number {
  if (!Number.isSafeInteger(arity) || arity === undefined) return 1;
  return Math.max(1, Math.min(arity, 3));
}

function isBoundedValue(value: unknown, depth: number, ancestors: WeakSet<object>, budget: { remaining: number }): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return true;
  if (typeof value === "string") return value.length <= MAX_INPUT_STRING_LENGTH;
  if (typeof value !== "object" || depth >= MAX_INPUT_DEPTH || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Reflect.get(value, "length");
      if (!Number.isSafeInteger(length) || length > MAX_INPUT_ENTRIES) return false;
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        if (Object.prototype.hasOwnProperty.call(value, key) && !isBoundedValue(Reflect.get(value, key), depth + 1, ancestors, budget)) return false;
      }
      return true;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_INPUT_ENTRIES || keys.some((key) => key.length > MAX_INPUT_STRING_LENGTH)) return false;
    return keys.every((key) => isBoundedValue(Reflect.get(value, key), depth + 1, ancestors, budget));
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

export function isProbeInput(args: unknown[]): boolean {
  const ancestors = new WeakSet<object>();
  const budget = { remaining: MAX_INPUT_NODES };
  return args.length <= MAX_ARGUMENTS_PER_CALL && args.every((value) => isBoundedValue(value, 0, ancestors, budget));
}

/** Fixed call shapes prevent function.length from hiding rest-argument behavior. */
export function argumentShapeCandidates(): unknown[][] {
  return [
    [],
    ["x"],
    [nestedValue("left"), nestedValue("right")],
    [prototypePayload(), nestedValue("nested"), ["third", 0, false]]
  ];
}

export function semanticCandidates(arity: number | undefined): unknown[][] {
  const width = operationalWidth(arity);
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
  const candidates: unknown[][] = [
    [["alpha", "beta"], ["beta"]],
    [nestedValue("left"), nestedValue("right")],
    [prototypePayload(), nestedValue("target")],
    [nestedValue("first"), ["second"], prototypePayload()],
    [...baseline]
  ];
  for (let position = 0; position < width; position += 1) {
    for (const scalar of scalars) {
      const args = [...baseline];
      args[position] = scalar;
      candidates.push(args);
    }
  }
  return candidates;
}

function amplifiedCandidates(arity: number | undefined, exportPath: string, count: number, namespace: string): unknown[][] {
  const width = operationalWidth(arity);
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
    seed: seedFor(exportPath, namespace)
  });
}

export function amplifiedSemanticCandidates(arity: number | undefined, exportPath: string, count: number): unknown[][] {
  return amplifiedCandidates(arity, exportPath, count, "observed");
}

export function lastRitesCandidates(arity: number | undefined, exportPath: string, count: number): unknown[][] {
  const token = seedFor(exportPath, "last-rites").toString(36);
  const seeds: unknown[][] = [
    [{ lastRites: token, nested: nestedValue("sealed") }],
    [{ lastRites: token, side: "left" }, { lastRites: token, side: "right", nested: nestedValue("pair") }],
    [
      Object.assign(prototypePayload(), { lastRites: token }),
      { lastRites: token, nested: nestedValue("adversarial") },
      ["last", "rites", token]
    ]
  ];
  return [...seeds, ...amplifiedCandidates(arity, exportPath, Math.max(0, count - seeds.length), "last-rites-amplified")];
}
