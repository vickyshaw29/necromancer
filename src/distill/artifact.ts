import { readFile } from "node:fs/promises";
import { isRecord } from "../json.js";
import { CoverageSummary, ProbeBehavior } from "../probe/index.js";
import { ModuleSurface } from "../sandbox/index.js";
import { ProbeArtifact } from "./types.js";

function isBehavior(value: unknown): value is ProbeBehavior {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.fn !== "string" || !Array.isArray(value.args)) return false;
  return "result" in value || "throw" in value;
}

function isCoverage(value: unknown): value is CoverageSummary {
  return (
    isRecord(value) &&
    typeof value.branchCoverage === "number" &&
    typeof value.lineCoverage === "number" &&
    typeof value.functionCoverage === "number" &&
    typeof value.statementCoverage === "number" &&
    typeof value.available === "boolean"
  );
}

function isSurface(value: unknown): value is ModuleSurface {
  if (!isRecord(value) || !Array.isArray(value.exports)) return false;
  return value.exports.every((entry) => {
    return isRecord(entry) && typeof entry.path === "string" && typeof entry.type === "string" && (entry.arity === undefined || typeof entry.arity === "number");
  });
}

export function parseProbeArtifact(value: unknown): ProbeArtifact {
  if (
    !isRecord(value) ||
    typeof value.packageName !== "string" ||
    (value.version !== undefined && typeof value.version !== "string") ||
    !Array.isArray(value.behaviors) ||
    !isCoverage(value.coverage)
  ) {
    throw new Error("behaviors.json is not a valid Necromancer probe artifact.");
  }
  const behaviors = value.behaviors.filter(isBehavior);
  if (behaviors.length !== value.behaviors.length) throw new Error("behaviors.json contains an invalid behavior record.");
  return {
    packageName: value.packageName,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    behaviors,
    coverage: value.coverage,
    ...(isSurface(value.surface) ? { surface: value.surface } : {})
  };
}

export async function readProbeArtifact(artifactPath: string): Promise<ProbeArtifact> {
  return parseProbeArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
}
