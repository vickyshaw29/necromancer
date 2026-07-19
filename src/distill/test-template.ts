import { isRecord } from "../json.js";
import { ProbeArtifact } from "./types.js";

function containsUnserializableTag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnserializableTag);
  if (!isRecord(value)) return false;
  if (value.$necromancer === "unserializable") return true;
  return Object.keys(value).some((key) => containsUnserializableTag(value[key]));
}

function testableBehaviors(artifact: ProbeArtifact, onNotice: (message: string) => void): ProbeArtifact["behaviors"] {
  return artifact.behaviors.filter((behavior) => {
    if (!containsUnserializableTag(behavior.result)) return true;
    onNotice(`[DISTILL] Skipped ${behavior.id} because its recorded result contains an unserializable serializer tag.`);
    return false;
  });
}

function templateData(artifact: ProbeArtifact, onNotice: (message: string) => void): string {
  return JSON.stringify(testableBehaviors(artifact, onNotice), null, 2);
}

export function renderSoulTest(artifact: ProbeArtifact, onNotice: (message: string) => void = () => undefined): string {
  return `import { expect, test } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ErrorShape = { name: string; message: string };
type Behavior = { id: string; fn: string; args: unknown[]; result?: unknown; throw?: ErrorShape };
const MAX_DEPTH = 64;
const MAX_ENTRIES = 1_000;

const workspace = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageName = ${JSON.stringify(artifact.packageName)};
const behaviors: Behavior[] = ${templateData(artifact, onNotice)};
const implementationInput = process.env.NECROMANCER_IMPL ?? "original/package";
const implementationPath = path.resolve(workspace, implementationInput);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactTag(record: Record<string, unknown>, kind: string, keys: string[]): boolean {
  return record.$necromancer === kind && Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function reviveRecord(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    Object.defineProperty(output, key, { value: revive(item), enumerable: true, configurable: true, writable: true });
  }
  return output;
}

function revive(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(revive);
  if (!isRecord(value)) return value;
  const record = value;
  if (exactTag(record, "undefined", ["$necromancer"])) return undefined;
  if (exactTag(record, "bigint", ["$necromancer", "value"]) && typeof record.value === "string") return BigInt(record.value);
  if (exactTag(record, "number", ["$necromancer", "value"])) {
    if (record.value === "NaN") return Number.NaN;
    if (record.value === "Infinity") return Infinity;
    if (record.value === "-Infinity") return -Infinity;
    if (record.value === "-0") return -0;
  }
  if (exactTag(record, "object", ["$necromancer", "value"]) && isRecord(record.value)) return reviveRecord(record.value);
  return reviveRecord(record);
}

function tagged(kind: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { $necromancer: kind, ...details };
}

function errorMessage(error: unknown): string {
  return isRecord(error) && "message" in error ? String(error.message) : String(error);
}

function jsonSafe(value: unknown, valuePath = "$", ancestors = new Map<object, string>(), depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return tagged("undefined");
  if (typeof value === "bigint") return tagged("bigint", { value: value.toString() });
  if (typeof value === "number") {
    if (Number.isNaN(value)) return tagged("number", { value: "NaN" });
    if (value === Infinity) return tagged("number", { value: "Infinity" });
    if (value === -Infinity) return tagged("number", { value: "-Infinity" });
    if (Object.is(value, -0)) return tagged("number", { value: "-0" });
    return value;
  }
  if (typeof value === "symbol") return tagged("symbol", { value: String(value) });
  if (typeof value === "function") return tagged("function", { name: value.name || null });
  if (depth >= MAX_DEPTH) return tagged("truncated", { reason: "max_depth" });
  if (ancestors.has(value)) return tagged("circular", { path: ancestors.get(value) });
  try {
    if (value instanceof Error) return tagged("error", { name: Reflect.get(value, "name") || "Error", message: String(Reflect.get(value, "message") || "") });
    if (value instanceof Date) {
      const time = Date.prototype.getTime.call(value);
      return tagged("date", { value: Number.isNaN(time) ? "Invalid Date" : Date.prototype.toISOString.call(value) });
    }
    if (value instanceof RegExp) return tagged("regexp", { value: RegExp.prototype.toString.call(value) });
    if (Buffer.isBuffer(value)) return tagged("buffer", { encoding: "base64", value: Buffer.prototype.toString.call(value, "base64") });
    ancestors.set(value, valuePath);
    if (Array.isArray(value)) {
      const length = Reflect.get(value, "length");
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        const entries: unknown[] = [];
        const keys = Object.keys(value);
        for (let index = 0; index < keys.length && index < MAX_ENTRIES; index += 1) {
          const key = keys[index];
          entries.push([key, jsonSafe(Reflect.get(value, key), "\${valuePath}.\${key}", ancestors, depth + 1)]);
        }
        if (keys.length > MAX_ENTRIES) entries.push(tagged("truncated", { reason: "max_entries" }));
        ancestors.delete(value);
        return tagged("array", { length, entries });
      }
      const entries: unknown[] = [];
      for (let index = 0; index < length && index < MAX_ENTRIES; index += 1) {
        const key = String(index);
        entries.push(
          Object.prototype.hasOwnProperty.call(value, key)
            ? jsonSafe(Reflect.get(value, key), "\${valuePath}[\${index}]", ancestors, depth + 1)
            : null
        );
      }
      if (length > MAX_ENTRIES) entries.push(tagged("truncated", { reason: "max_entries" }));
      ancestors.delete(value);
      return entries;
    }
    if (value instanceof Map) {
      const entries: unknown[] = [];
      let index = 0;
      for (const [key, item] of Map.prototype.entries.call(value)) {
        if (index >= MAX_ENTRIES) {
          entries.push(tagged("truncated", { reason: "max_entries" }));
          break;
        }
        entries.push([jsonSafe(key, "\${valuePath}.<key\${index}>", ancestors, depth + 1), jsonSafe(item, "\${valuePath}.<value\${index}>", ancestors, depth + 1)]);
        index += 1;
      }
      ancestors.delete(value);
      return tagged("map", { entries });
    }
    if (value instanceof Set) {
      const entries: unknown[] = [];
      let index = 0;
      for (const item of Set.prototype.values.call(value)) {
        if (index >= MAX_ENTRIES) {
          entries.push(tagged("truncated", { reason: "max_entries" }));
          break;
        }
        entries.push(jsonSafe(item, "\${valuePath}.<set\${index}>", ancestors, depth + 1));
        index += 1;
      }
      ancestors.delete(value);
      return tagged("set", { entries });
    }
    const output: Record<string, unknown> = Object.create(null);
    const keys = Object.keys(value);
    for (const [index, key] of keys.slice(0, MAX_ENTRIES).entries()) {
      try {
        output[key] = jsonSafe(Reflect.get(value, key), "\${valuePath}.\${key}", ancestors, depth + 1);
      } catch (error) {
        output[key] = tagged("unreadable", { message: errorMessage(error) });
      }
      if (index + 1 === MAX_ENTRIES && keys.length > MAX_ENTRIES) output.$truncated = tagged("truncated", { reason: "max_entries" });
    }
    return output;
  } catch (error) {
    return tagged("unserializable", { message: errorMessage(error) });
  } finally {
    ancestors.delete(value);
  }
}

function errorShape(error: unknown): ErrorShape {
  if (isRecord(error)) {
    const value = error;
    return { name: typeof value.name === "string" ? value.name : "Error", message: String(value.message ?? "") };
  }
  return { name: "Error", message: String(error) };
}

function isEsmError(error: unknown): boolean {
  return isRecord(error) && error.code === "ERR_REQUIRE_ESM";
}

async function loadImplementation(id: string): Promise<unknown> {
  const entry = require.resolve(implementationPath);
  delete require.cache[entry];
  try {
    return require(entry);
  } catch (error) {
    if (!isEsmError(error)) throw error;
    return import("\${pathToFileURL(entry).href}?behavior=\${encodeURIComponent(id)}");
  }
}

function resolveFunction(moduleValue: unknown, exportPath: string): (...args: unknown[]) => unknown {
  if (!moduleValue || (typeof moduleValue !== "object" && typeof moduleValue !== "function")) throw new TypeError("Implementation did not export a module value.");
  if (exportPath === packageName || exportPath === ".") {
    const root = typeof moduleValue === "function" ? moduleValue : isRecord(moduleValue) ? moduleValue.default : undefined;
    if (typeof root !== "function") throw new TypeError("Module root is not callable.");
    return root;
  }
  const propertyPath = exportPath.startsWith(packageName + ".") ? exportPath.slice(packageName.length + 1) : exportPath.replace(/^\./, "");
  let current: unknown = moduleValue;
  for (const segment of propertyPath.split(".")) {
    if (!segment) continue;
    current = current && (typeof current === "object" || typeof current === "function") ? Reflect.get(current, segment) : undefined;
  }
  if (typeof current !== "function") throw new TypeError("Recorded export " + JSON.stringify(exportPath) + " is not callable.");
  return current;
}

for (const behavior of behaviors) {
  test(\`\${behavior.id} — \${behavior.fn}\`, async () => {
    try {
      const moduleValue = await loadImplementation(behavior.id);
      const args = revive(behavior.args);
      if (!Array.isArray(args)) throw new TypeError("Recorded arguments are not an array.");
      const value = await resolveFunction(moduleValue, behavior.fn)(...args);
      if (!("result" in behavior)) throw new Error("Expected recorded throw but implementation returned.");
      expect(jsonSafe(value)).toEqual(behavior.result);
    } catch (error) {
      if (!("throw" in behavior)) throw error;
      expect(errorShape(error)).toEqual(behavior.throw);
    }
  });
}
`;
}
