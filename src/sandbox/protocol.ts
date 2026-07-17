import { ExportDescriptor, ModuleSurface, SandboxSource } from "./types.js";

function encodeWireValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === undefined) return { $necromancerInput: "undefined" };
  if (typeof value === "bigint") return { $necromancerInput: "bigint", value: value.toString() };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $necromancerInput: "number", value: "NaN" };
    if (value === Infinity) return { $necromancerInput: "number", value: "Infinity" };
    if (value === -Infinity) return { $necromancerInput: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { $necromancerInput: "number", value: "-0" };
    return value;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value !== "object") throw new Error("Sandbox invocation arguments cannot contain functions or symbols.");
  if (ancestors.has(value)) throw new Error("Sandbox invocation arguments cannot contain circular references.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return { $necromancerInput: "array", value: value.map((item) => encodeWireValue(item, ancestors)) };
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) output[key] = encodeWireValue(item, ancestors);
    return { $necromancerInput: "object", value: output };
  } finally {
    ancestors.delete(value);
  }
}

export function serializeRequest(source: SandboxSource, exportPath: string, args: unknown[], operation = "invoke"): string {
  try {
    return JSON.stringify({ packageName: source.packageName, exportPath, args: encodeWireValue(args), operation });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "arguments could not be encoded safely";
    throw new Error(detail);
  }
}

export function parseSurface(value: unknown): ModuleSurface {
  if (!value || typeof value !== "object" || !("exports" in value) || !Array.isArray(value.exports)) {
    throw new Error("Sandbox returned an invalid export surface.");
  }
  const exports: ExportDescriptor[] = [];
  for (const item of value.exports) {
    if (!item || typeof item !== "object" || !("path" in item) || !("type" in item)) continue;
    const path = (item as { path: unknown }).path;
    const type = (item as { type: unknown }).type;
    const arity = (item as { arity?: unknown }).arity;
    if (typeof path === "string" && typeof type === "string") {
      exports.push({ path, type, ...(typeof arity === "number" ? { arity } : {}) });
    }
  }
  return { exports };
}
