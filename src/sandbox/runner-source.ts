/**
 * This program is written into each isolated workspace. It deliberately has no
 * imports from Necromancer so Docker and child modes execute the same tiny RPC host.
 */
export const RUNNER_SOURCE = String.raw`"use strict";

const RPC_PREFIX = "NECROMANCER_RPC:";
const TAG = "$necromancer";
const MAX_DEPTH = 64;
const MAX_ENTRIES = 1_000;

function tagged(kind, details) {
  return { [TAG]: kind, ...details };
}

function jsonSafe(value, valuePath = "$", ancestors = new Map(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return tagged("undefined", {});
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
    if (value instanceof Error) {
      return tagged("error", { name: value.name || "Error", message: String(value.message || "") });
    }
    if (value instanceof Date) {
      return tagged("date", { value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() });
    }
    if (value instanceof RegExp) return tagged("regexp", { value: value.toString() });
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return tagged("buffer", { encoding: "base64", value: value.toString("base64") });
    }

    ancestors.set(value, valuePath);
    if (Array.isArray(value)) {
      const entries = value.slice(0, MAX_ENTRIES).map((item, index) => jsonSafe(item, valuePath + "[" + index + "]", ancestors, depth + 1));
      if (value.length > MAX_ENTRIES) entries.push(tagged("truncated", { reason: "max_entries" }));
      ancestors.delete(value);
      return entries;
    }
    if (value instanceof Map) {
      const entries = [];
      let index = 0;
      for (const [key, item] of value) {
        if (index >= MAX_ENTRIES) {
          entries.push(tagged("truncated", { reason: "max_entries" }));
          break;
        }
        entries.push([jsonSafe(key, valuePath + ".<key" + index + ">", ancestors, depth + 1), jsonSafe(item, valuePath + ".<value" + index + ">", ancestors, depth + 1)]);
        index += 1;
      }
      ancestors.delete(value);
      return tagged("map", { entries });
    }
    if (value instanceof Set) {
      const entries = [];
      let index = 0;
      for (const item of value) {
        if (index >= MAX_ENTRIES) {
          entries.push(tagged("truncated", { reason: "max_entries" }));
          break;
        }
        entries.push(jsonSafe(item, valuePath + ".<set" + index + ">", ancestors, depth + 1));
        index += 1;
      }
      ancestors.delete(value);
      return tagged("set", { entries });
    }

    const output = Object.create(null);
    const keys = Object.keys(value);
    for (const [index, key] of keys.slice(0, MAX_ENTRIES).entries()) {
      try {
        output[key] = jsonSafe(value[key], valuePath + "." + key, ancestors, depth + 1);
      } catch (error) {
        output[key] = tagged("unreadable", { message: errorMessage(error) });
      }
      if (index + 1 === MAX_ENTRIES && keys.length > MAX_ENTRIES) {
        output["$truncated"] = tagged("truncated", { reason: "max_entries" });
      }
    }
    ancestors.delete(value);
    return output;
  } catch (error) {
    ancestors.delete(value);
    return tagged("unserializable", { message: errorMessage(error) });
  }
}

function errorMessage(error) {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

function serializeError(error) {
  if (error && typeof error === "object") {
    return { name: typeof error.name === "string" ? error.name : "Error", message: errorMessage(error) };
  }
  return { name: "Error", message: String(error) };
}

function disableNetwork() {
  const blocked = () => {
    throw new Error("Network access is disabled by the Necromancer child-process sandbox.");
  };
  const blockedAsync = () => Promise.reject(new Error("Network access is disabled by the Necromancer child-process sandbox."));
  for (const moduleName of ["node:http", "node:https", "node:http2"]) {
    try {
      const module = require(moduleName);
      module.request = blocked;
      module.get = blocked;
      if (module.connect) module.connect = blocked;
    } catch {}
  }
  for (const moduleName of ["node:net", "node:tls", "node:dgram"]) {
    try {
      const module = require(moduleName);
      for (const key of ["connect", "createConnection", "createServer", "createSocket"]) {
        if (typeof module[key] === "function") module[key] = blocked;
      }
    } catch {}
  }
  try {
    const dns = require("node:dns");
    for (const key of ["lookup", "resolve", "resolve4", "resolve6", "reverse"]) {
      if (typeof dns[key] === "function") dns[key] = blocked;
    }
  } catch {}
  if (typeof globalThis.fetch === "function") globalThis.fetch = blockedAsync;
}

async function loadModule(packageName) {
  try {
    return require(packageName);
  } catch (error) {
    if (error && error.code === "ERR_REQUIRE_ESM") return import(packageName);
    throw error;
  }
}

function resolveExport(moduleValue, exportPath, packageName) {
  if (!exportPath || exportPath === "." || exportPath === packageName) {
    return typeof moduleValue === "function" ? moduleValue : moduleValue.default;
  }

  let propertyPath = exportPath;
  if (propertyPath.startsWith(packageName + ".")) propertyPath = propertyPath.slice(packageName.length + 1);
  if (propertyPath.startsWith(".")) propertyPath = propertyPath.slice(1);
  let current = moduleValue;
  for (const segment of propertyPath.split(".")) {
    if (!segment) continue;
    current = current == null ? undefined : current[segment];
  }
  return current;
}

async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  if (process.env.NECROMANCER_NETWORK === "disabled") disableNetwork();
  const request = await readRequest();
  const start = process.hrtime.bigint();
  let response;
  try {
    const moduleValue = await loadModule(request.packageName);
    const target = resolveExport(moduleValue, request.exportPath, request.packageName);
    if (typeof target !== "function") {
      throw new TypeError("Requested export " + JSON.stringify(request.exportPath) + " is not a function.");
    }
    const value = await target(...request.args);
    response = { ok: true, value: jsonSafe(value), durationMs: Number(process.hrtime.bigint() - start) / 1e6 };
  } catch (error) {
    response = { ok: false, error: serializeError(error), durationMs: Number(process.hrtime.bigint() - start) / 1e6 };
  }
  process.stdout.write(RPC_PREFIX + JSON.stringify(response) + "\n");
}

main().catch((error) => {
  process.stdout.write(RPC_PREFIX + JSON.stringify({ ok: false, error: serializeError(error), durationMs: 0 }) + "\n");
});
`;
