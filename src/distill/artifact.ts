import { readFile } from "node:fs/promises";
import { CoverageSummary, ProbeBehavior } from "../probe/index.js";
import { ProbeArtifact } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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

export function parseProbeArtifact(value: unknown): ProbeArtifact {
  if (!isRecord(value) || typeof value.packageName !== "string" || !Array.isArray(value.behaviors) || !isCoverage(value.coverage)) {
    throw new Error("behaviors.json is not a valid Necromancer probe artifact.");
  }
  const behaviors = value.behaviors.filter(isBehavior);
  if (behaviors.length !== value.behaviors.length) throw new Error("behaviors.json contains an invalid behavior record.");
  return { packageName: value.packageName, behaviors, coverage: value.coverage };
}

export async function readProbeArtifact(artifactPath: string): Promise<ProbeArtifact> {
  return parseProbeArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
}
