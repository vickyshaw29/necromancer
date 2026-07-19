import { readFile, stat } from "node:fs/promises";
import { isRecord } from "../json.js";
import { ArgumentShapeCoverage, CoverageSummary, ProbeBehavior } from "../probe/index.js";
import { ModuleSurface } from "../sandbox/index.js";
import { ProbeArtifact } from "./types.js";

const MAX_PROBE_ARTIFACT_BYTES = 4 * 1024 * 1024;

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

function isArgumentShapeCoverage(value: unknown): value is ArgumentShapeCoverage {
  if (!isRecord(value) || typeof value.fn !== "string" || typeof value.complete !== "boolean") return false;
  const required = value.requiredArgumentCounts;
  const observed = value.observedArgumentCounts;
  return (
    Array.isArray(required) &&
    Array.isArray(observed) &&
    required.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    observed.every((count) => Number.isSafeInteger(count) && count >= 0)
  );
}

export function parseProbeArtifact(value: unknown): ProbeArtifact {
  if (
    !isRecord(value) ||
    typeof value.packageName !== "string" ||
    (value.version !== undefined && typeof value.version !== "string") ||
    (value.sourceTarballSha512 !== undefined && typeof value.sourceTarballSha512 !== "string") ||
    !Array.isArray(value.behaviors) ||
    !isCoverage(value.coverage)
  ) {
    throw new Error("behaviors.json is not a valid Necromancer probe artifact.");
  }
  const behaviors = value.behaviors.filter(isBehavior);
  if (behaviors.length !== value.behaviors.length) throw new Error("behaviors.json contains an invalid behavior record.");
  const heldOut = value.heldOutBehaviors;
  if (heldOut !== undefined && (!Array.isArray(heldOut) || !heldOut.every(isBehavior))) {
    throw new Error("behaviors.json contains an invalid Last Rites behavior record.");
  }
  const argumentShapeCoverage = value.argumentShapeCoverage;
  if (argumentShapeCoverage !== undefined && (!Array.isArray(argumentShapeCoverage) || !argumentShapeCoverage.every(isArgumentShapeCoverage))) {
    throw new Error("behaviors.json contains invalid argument-shape coverage.");
  }
  return {
    packageName: value.packageName,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.sourceTarballSha512 === "string" ? { sourceTarballSha512: value.sourceTarballSha512 } : {}),
    behaviors,
    ...(heldOut ? { heldOutBehaviors: heldOut } : {}),
    ...(argumentShapeCoverage ? { argumentShapeCoverage } : {}),
    coverage: value.coverage,
    ...(isSurface(value.surface) ? { surface: value.surface } : {})
  };
}

export async function readProbeArtifact(artifactPath: string): Promise<ProbeArtifact> {
  const details = await stat(artifactPath);
  if (!details.isFile() || details.size > MAX_PROBE_ARTIFACT_BYTES) {
    throw new Error("behaviors.json exceeds Necromancer's 4 MB artifact safety limit.");
  }
  return parseProbeArtifact(JSON.parse(await readFile(artifactPath, "utf8")));
}
