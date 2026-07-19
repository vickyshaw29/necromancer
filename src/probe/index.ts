import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ExportDescriptor, JsonSafeValue, ModuleSurface } from "../sandbox/index.js";
import { buildProbeCandidateBatches, ProbeCandidate, toArtifactValue } from "./candidates.js";
import { collectCoverage } from "./coverage.js";
import { discoverPackage } from "./discovery.js";
import { generateInputPlan } from "./engines.js";
import { REQUIRED_ARGUMENT_COUNTS } from "./shapes.js";
import { ArgumentShapeCoverage, ProbeBehavior, ProbeOptions, ProbeResult, ProbeTarget } from "./types.js";

const MAX_CALLABLE_EXPORTS = 200;

export * from "./types.js";
export * from "./engines.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

function containsUnserializableTag(value: JsonSafeValue): boolean {
  if (Array.isArray(value)) return value.some(containsUnserializableTag);
  if (value === null || typeof value !== "object") return false;
  if (value.$necromancer === "unserializable") return true;
  return Object.keys(value).some((key) => containsUnserializableTag(value[key]));
}

type ProbeInvocationResult = Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>;

function hasUnserializableResult(result: ProbeInvocationResult): boolean {
  return result.ok && containsUnserializableTag(result.value);
}

function behaviorFromResult(id: string, fn: string, args: unknown[], result: ProbeInvocationResult): ProbeBehavior {
  const artifactArgs = args.map((item) => toArtifactValue(item)) as JsonSafeValue[];
  if (result.ok) return { id, fn, args: artifactArgs, result: result.value };
  return { id, fn, args: artifactArgs, throw: result.error };
}

function deterministic(
  first: ProbeInvocationResult,
  second: ProbeInvocationResult
): boolean {
  if (first.ok !== second.ok) return false;
  if (first.ok && second.ok) return stable(first.value) === stable(second.value);
  if (!first.ok && !second.ok) return first.error.name === second.error.name && first.error.message === second.error.message;
  return false;
}

function callableExports(surface: ModuleSurface): ExportDescriptor[] {
  const seen = new Set<string>();
  return surface.exports.filter((item) => {
    if (item.type !== "function" || seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

function argumentShapeCoverage(functions: ExportDescriptor[], behaviors: ProbeBehavior[]): ArgumentShapeCoverage[] {
  const countsByFunction = new Map<string, Set<number>>();
  for (const behavior of behaviors) {
    const counts = countsByFunction.get(behavior.fn) ?? new Set<number>();
    counts.add(behavior.args.length);
    countsByFunction.set(behavior.fn, counts);
  }
  return functions.map((item) => {
    const observed = [...(countsByFunction.get(item.path) ?? new Set<number>())].sort((left, right) => left - right);
    return {
      fn: item.path,
      requiredArgumentCounts: [...REQUIRED_ARGUMENT_COUNTS],
      observedArgumentCounts: observed,
      complete: REQUIRED_ARGUMENT_COUNTS.every((count) => observed.includes(count))
    };
  });
}

interface RecordedBatch {
  behaviors: ProbeBehavior[];
  discardedNonDeterministic: number;
}

async function recordBatchedCandidates(
  target: ProbeTarget,
  candidates: ProbeCandidate[],
  idPrefix: string,
  notice: (message: string) => void
): Promise<RecordedBatch> {
  if (!target.sandbox.invokeBatch) throw new Error("Sandbox batch runner is unavailable.");
  let first: ProbeInvocationResult[];
  let second: ProbeInvocationResult[];
  try {
    first = await target.sandbox.invokeBatch(candidates.map((candidate) => ({ exportPath: candidate.fn, args: candidate.args })));
    second = await target.sandbox.invokeBatch(candidates.map((candidate) => ({ exportPath: candidate.fn, args: candidate.args })));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "sandbox batch failed";
    notice(`[PROBE] Skipped ${candidates.length} candidates after batch runner failure: ${detail}`);
    return { behaviors: [], discardedNonDeterministic: 0 };
  }
  if (first.length !== candidates.length || second.length !== candidates.length) {
    notice("[PROBE] Skipped a batch because the sandbox returned an unexpected number of results.");
    return { behaviors: [], discardedNonDeterministic: 0 };
  }
  const behaviors: ProbeBehavior[] = [];
  let discardedNonDeterministic = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (hasUnserializableResult(first[index]) || hasUnserializableResult(second[index])) {
      notice(`[PROBE] Skipped ${candidate.fn} candidate because its returned value could not be serialized safely.`);
      continue;
    }
    if (!deterministic(first[index], second[index])) {
      discardedNonDeterministic += 1;
      continue;
    }
    behaviors.push(behaviorFromResult(`${idPrefix}-${String(behaviors.length + 1).padStart(4, "0")}`, candidate.fn, candidate.args, first[index]));
  }
  return { behaviors, discardedNonDeterministic };
}

async function recordCandidates(
  target: ProbeTarget,
  candidates: ProbeCandidate[],
  idPrefix: string,
  notice: (message: string) => void
): Promise<RecordedBatch> {
  if (target.sandbox.invokeBatch) return recordBatchedCandidates(target, candidates, idPrefix, notice);
  const behaviors: ProbeBehavior[] = [];
  let discardedNonDeterministic = 0;
  for (const candidate of candidates) {
    let first: ProbeInvocationResult;
    let second: ProbeInvocationResult;
    try {
      first = await target.sandbox.invoke(candidate.fn, candidate.args);
      second = await target.sandbox.invoke(candidate.fn, candidate.args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "sandbox invocation failed";
      notice(`[PROBE] Skipped ${candidate.fn} candidate after runner failure: ${detail}`);
      continue;
    }
    if (hasUnserializableResult(first) || hasUnserializableResult(second)) {
      notice(`[PROBE] Skipped ${candidate.fn} candidate because its returned value could not be serialized safely.`);
      continue;
    }
    if (!deterministic(first, second)) {
      discardedNonDeterministic += 1;
      continue;
    }
    behaviors.push(behaviorFromResult(`${idPrefix}-${String(behaviors.length + 1).padStart(4, "0")}`, candidate.fn, candidate.args, first));
  }
  return { behaviors, discardedNonDeterministic };
}

/** Execute candidates twice in the sandbox and persist only deterministic observed behavior. */
export async function probePackage(target: ProbeTarget, options: ProbeOptions): Promise<ProbeResult> {
  if (!Number.isSafeInteger(options.maxBehaviors) || options.maxBehaviors <= 0) {
    throw new Error("maxBehaviors must be a positive integer.");
  }
  const notice = options.onNotice ?? (() => undefined);
  const discovery = await discoverPackage(target.sandbox, target.packagePath);
  const functions = callableExports(discovery.surface);
  if (functions.length === 0) throw new Error("This package has no callable exports that v1 can probe.");
  if (functions.length > MAX_CALLABLE_EXPORTS) {
    throw new Error(`This package exposes ${functions.length.toLocaleString()} callable exports; v1 caps bounded probing at ${MAX_CALLABLE_EXPORTS.toLocaleString()}.`);
  }

  const planRequest = {
    packageName: target.packageName,
    packagePath: target.packagePath,
    functions,
    examples: discovery.examples,
    readme: discovery.readme,
    sourceExcerpt: discovery.sourceExcerpt
  };
  const generated = options.planEngine
    ? { engine: options.planEngine.name, plan: await options.planEngine.generate(planRequest) }
    : await generateInputPlan({ preference: options.engine, discovery, request: planRequest, onNotice: notice });
  const batches = buildProbeCandidateBatches(discovery, generated.plan, options.maxBehaviors);
  const [observed, heldOut] = await Promise.all([
    recordCandidates(target, batches.observed, "behavior", notice),
    recordCandidates(target, batches.heldOut, "last-rites", notice)
  ]);
  const behaviors = observed.behaviors;
  const heldOutBehaviors = heldOut.behaviors;

  await mkdir(target.artifactDirectory, { recursive: true });
  const coveragePaths = target.sandbox.coveragePaths();
  const coverage = coveragePaths
    ? await collectCoverage(coveragePaths.rawDirectory, coveragePaths.sourceDirectory, target.artifactDirectory)
    : {
        branchCoverage: 0,
        lineCoverage: 0,
        functionCoverage: 0,
        statementCoverage: 0,
        available: false,
        detail: "No V8 coverage directory was configured."
      };
  const result: ProbeResult = {
    packageName: target.packageName,
    version: target.version,
    ...(target.sourceTarballSha512 ? { sourceTarballSha512: target.sourceTarballSha512 } : {}),
    engine: generated.engine,
    surface: discovery.surface,
    examples: discovery.examples,
    behaviors,
    heldOutBehaviors,
    argumentShapeCoverage: argumentShapeCoverage(functions, behaviors),
    discardedNonDeterministic: observed.discardedNonDeterministic + heldOut.discardedNonDeterministic,
    coverage,
    artifactPath: target.artifactDirectory
  };
  await Promise.all([
    writeFile(path.join(target.artifactDirectory, "behaviors.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(path.join(target.artifactDirectory, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`, "utf8")
  ]);
  return result;
}
