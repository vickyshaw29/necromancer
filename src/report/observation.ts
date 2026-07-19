import { isRecord } from "../json.js";
import type { ProbeBehavior } from "../probe/index.js";

export interface ObservedArgumentShape {
  arities: number[];
  callsWithTwoOrMoreArguments: number;
}

export interface HeldOutValidation {
  passed: number;
  total: number;
}

export interface ArgumentShapeCompleteness {
  completeFunctions: number;
  measuredFunctions: number;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeIntegerArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => nonNegativeInteger(item) !== undefined);
}

export function observedArgumentShape(behaviors: ProbeBehavior[]): ObservedArgumentShape {
  const arities = new Set<number>();
  let callsWithTwoOrMoreArguments = 0;

  for (const behavior of behaviors) {
    const arity = behavior.args.length;
    arities.add(arity);
    if (arity >= 2) callsWithTwoOrMoreArguments += 1;
  }

  return { arities: [...arities].sort((left, right) => left - right), callsWithTwoOrMoreArguments };
}

export function lastRitesValidation(resurrection: unknown): HeldOutValidation | undefined {
  if (!isRecord(resurrection) || !isRecord(resurrection.lastRites)) return undefined;
  const passed = nonNegativeInteger(resurrection.lastRites.passed);
  const total = nonNegativeInteger(resurrection.lastRites.total);
  if (passed === undefined || total === undefined || passed > total) return undefined;
  return { passed, total };
}

export function argumentShapeCompleteness(artifact: unknown): ArgumentShapeCompleteness | undefined {
  if (!isRecord(artifact) || !Array.isArray(artifact.argumentShapeCoverage)) return undefined;
  const entries = artifact.argumentShapeCoverage;
  if (
    !entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.fn === "string" &&
        typeof entry.complete === "boolean" &&
        nonNegativeIntegerArray(entry.requiredArgumentCounts) &&
        nonNegativeIntegerArray(entry.observedArgumentCounts)
    )
  ) {
    return undefined;
  }
  return { completeFunctions: entries.filter((entry) => isRecord(entry) && entry.complete === true).length, measuredFunctions: entries.length };
}
