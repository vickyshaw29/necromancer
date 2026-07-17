import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonSafeValue } from "../sandbox/index.js";
import { buildProbeCandidates, toArtifactValue } from "./candidates.js";
import { collectCoverage } from "./coverage.js";
import { discoverPackage } from "./discovery.js";
import { generateInputPlan } from "./engines.js";
import { ProbeBehavior, ProbeOptions, ProbeResult, ProbeTarget } from "./types.js";

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

function behaviorFromResult(id: string, fn: string, args: unknown[], result: Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>): ProbeBehavior {
  const artifactArgs = args.map((item) => toArtifactValue(item)) as JsonSafeValue[];
  if (result.ok) return { id, fn, args: artifactArgs, result: result.value };
  return { id, fn, args: artifactArgs, throw: result.error };
}

function deterministic(
  first: Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>,
  second: Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>
): boolean {
  if (first.ok !== second.ok) return false;
  if (first.ok && second.ok) return stable(first.value) === stable(second.value);
  if (!first.ok && !second.ok) return first.error.name === second.error.name && first.error.message === second.error.message;
  return false;
}

/** Execute candidates twice in the sandbox and persist only deterministic observed behavior. */
export async function probePackage(target: ProbeTarget, options: ProbeOptions): Promise<ProbeResult> {
  const notice = options.onNotice ?? (() => undefined);
  const discovery = await discoverPackage(target.sandbox, target.packagePath);
  const functions = discovery.surface.exports.filter((item) => item.type === "function");
  if (functions.length === 0) throw new Error("This package has no callable exports that v1 can probe.");

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
  const candidates = buildProbeCandidates(discovery, generated.plan, options.maxBehaviors);
  const behaviors: ProbeBehavior[] = [];
  let discardedNonDeterministic = 0;

  for (const candidate of candidates) {
    if (behaviors.length >= options.maxBehaviors) break;
    let first: Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>;
    let second: Awaited<ReturnType<ProbeTarget["sandbox"]["invoke"]>>;
    try {
      first = await target.sandbox.invoke(candidate.fn, candidate.args);
      second = await target.sandbox.invoke(candidate.fn, candidate.args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "sandbox invocation failed";
      notice(`[PROBE] Skipped ${candidate.fn} candidate after runner failure: ${detail}`);
      continue;
    }
    if (!deterministic(first, second)) {
      discardedNonDeterministic += 1;
      continue;
    }
    behaviors.push(behaviorFromResult(`behavior-${String(behaviors.length + 1).padStart(4, "0")}`, candidate.fn, candidate.args, first));
  }

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
    engine: generated.engine,
    surface: discovery.surface,
    examples: discovery.examples,
    behaviors,
    discardedNonDeterministic,
    coverage,
    artifactPath: target.artifactDirectory
  };
  await Promise.all([
    writeFile(path.join(target.artifactDirectory, "behaviors.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
    writeFile(path.join(target.artifactDirectory, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`, "utf8")
  ]);
  return result;
}
