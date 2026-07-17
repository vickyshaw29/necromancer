import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProbeBehavior } from "../probe/index.js";
import { buildCandidate, writeCandidateProject } from "./build.js";
import { runCharacterization } from "./test-runner.js";
import {
  CharacterizationResult,
  FailureFeedback,
  PublicApiMember,
  RebuildGenerator,
  ResurrectionResult,
  ResurrectionRound,
  ResurrectionTarget
} from "./types.js";

const MAX_ROUNDS = 6;
const MAX_WORK_ORDER_CHARS = 96_000;
const MAX_FAILURES_FOR_PROMPT = 50;
const MAX_FAILURE_DETAIL_CHARS = 1_200;

async function readWorkOrderFile(filePath: string): Promise<string> {
  let text = "";
  const stream = createReadStream(filePath, { encoding: "utf8" });
  try {
    for await (const chunk of stream) {
      if (text.length >= MAX_WORK_ORDER_CHARS) break;
      text += chunk.slice(0, MAX_WORK_ORDER_CHARS - text.length);
    }
  } finally {
    stream.destroy();
  }
  return text.length >= MAX_WORK_ORDER_CHARS ? `${text}\n\n[Truncated at ${MAX_WORK_ORDER_CHARS} characters.]` : text;
}

function publicApi(target: ResurrectionTarget): PublicApiMember[] {
  if (target.artifact.surface?.exports.length) return target.artifact.surface.exports;
  const seen = new Set<string>();
  return target.artifact.behaviors.flatMap((behavior) => {
    if (seen.has(behavior.fn)) return [];
    seen.add(behavior.fn);
    return [{ path: behavior.fn, type: "function" }];
  });
}

function expected(behavior: ProbeBehavior): ProbeBehavior["result"] | ProbeBehavior["throw"] {
  return behavior.throw ?? behavior.result;
}

function failureFeedback(behaviors: ProbeBehavior[], result: CharacterizationResult): FailureFeedback[] {
  const behaviorById = new Map(behaviors.map((behavior) => [behavior.id, behavior]));
  const feedback = result.failures.flatMap((failure) => {
    const behavior = behaviorById.get(failure.id);
    if (!behavior) return [];
    const wanted = expected(behavior);
    if (wanted === undefined) return [];
    return [{ id: behavior.id, fn: behavior.fn, args: behavior.args, expected: wanted, actual: failure.detail.slice(0, MAX_FAILURE_DETAIL_CHARS) }];
  });
  if (feedback.length > 0) return feedback.slice(0, MAX_FAILURES_FOR_PROMPT);
  const fallbackDetail = (result.failures[0]?.detail ?? "Characterization test did not provide a failure detail.").slice(0, MAX_FAILURE_DETAIL_CHARS);
  return behaviors.flatMap((behavior) => {
    const wanted = expected(behavior);
    if (wanted === undefined) return [];
    return [{ id: behavior.id, fn: behavior.fn, args: behavior.args, expected: wanted, actual: fallbackDetail }];
  }).slice(0, MAX_FAILURES_FOR_PROMPT);
}

function failedRun(total: number, detail: string): CharacterizationResult {
  return { passed: 0, total, failures: [{ id: "", detail }] };
}

async function executeCandidate(artifactDirectory: string, source: string, total: number): Promise<CharacterizationResult> {
  const rebuiltDirectory = path.join(artifactDirectory, "rebuilt");
  try {
    await writeCandidateProject(rebuiltDirectory, source);
    await buildCandidate(rebuiltDirectory);
    return await runCharacterization(artifactDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Candidate build failed.";
    return failedRun(total, detail);
  }
}

export interface ResurrectionLoopOptions {
  evaluateCandidate?: (artifactDirectory: string, source: string, total: number) => Promise<CharacterizationResult>;
}

export async function resurrectArtifact(
  target: ResurrectionTarget,
  generator: RebuildGenerator,
  options: ResurrectionLoopOptions = {}
): Promise<ResurrectionResult> {
  const total = target.artifact.behaviors.length;
  if (total === 0) throw new Error("Cannot resurrect an artifact with no observed behaviors.");
  const [soul, soulTest] = await Promise.all([
    readWorkOrderFile(path.join(target.artifactDirectory, "SOUL.md")),
    readWorkOrderFile(path.join(target.artifactDirectory, "soul.test.ts"))
  ]);
  const rounds: ResurrectionRound[] = [];
  let previousSource: string | undefined;
  let feedback: FailureFeedback[] = [];
  let last: CharacterizationResult = { passed: 0, total, failures: [] };
  const evaluate = options.evaluateCandidate ?? executeCandidate;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const source = await generator.generate({
      packageName: target.artifact.packageName,
      api: publicApi(target),
      soul,
      soulTest,
      round,
      previousSource,
      failures: feedback
    });
    previousSource = source;
    last = await evaluate(target.artifactDirectory, source, total);
    if (last.total !== total) {
      throw new Error(`The emitted suite reported ${last.total} tests, but behaviors.json records ${total} observed behaviors.`);
    }
    rounds.push({ round, passed: last.passed, total, failedIds: last.failures.map((failure) => failure.id).filter(Boolean) });
    if (last.passed === total) break;
    feedback = failureFeedback(target.artifact.behaviors, last);
  }

  const complete = last.passed === total;
  const rebuiltDirectory = path.join(target.artifactDirectory, "rebuilt");
  await mkdir(rebuiltDirectory, { recursive: true });
  const resultPath = path.join(rebuiltDirectory, "result.json");
  const result: ResurrectionResult = {
    packageName: target.artifact.packageName,
    engine: generator.name,
    rounds,
    passed: last.passed,
    total,
    complete,
    resultPath
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
