import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderSoulTest } from "../distill/test-template.js";
import { ProbeBehavior } from "../probe/index.js";
import { buildCandidate, writeCandidateProject } from "./build.js";
import { validateCandidateConsumers } from "./consumer-check.js";
import { ExecutionIsolationError, runCharacterization } from "./test-runner.js";
import {
  CharacterizationResult,
  FailureFeedback,
  LastRitesResult,
  PublicApiMember,
  RebuildGenerator,
  ResurrectionEventCallback,
  ResurrectionResult,
  ResurrectionRound,
  ResurrectionTarget,
  StructuralFailureFeedback
} from "./types.js";

const MAX_ROUNDS = 6;
const MAX_WORK_ORDER_CHARS = 96_000;
const MAX_FAILURES_FOR_PROMPT = 50;
const MAX_FAILURE_DETAIL_CHARS = 1_200;
const LAST_RITES_TEST_FILE = "last-rites.test.ts";

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

function structuralFeedback(mismatch: string): StructuralFailureFeedback {
  if (mismatch === "module root is not callable") {
    return { kind: "structural", instruction: "The package root export must be a callable function; the previous candidate's root was not callable (module root is not callable)." };
  }
  return { kind: "structural", instruction: `The package must expose the recorded named exports; the previous candidate failed the structural check: ${mismatch}.` };
}

function generationFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Generator failed without an error message.";
}

async function executeCandidate(
  artifactDirectory: string,
  source: string,
  total: number,
  round: number,
  onEvent: ResurrectionEventCallback,
  api: PublicApiMember[],
  packageName: string,
  allowReducedIsolation: boolean,
  noDocker: boolean
): Promise<CharacterizationResult> {
  const rebuiltDirectory = path.join(artifactDirectory, "rebuilt");
  try {
    onEvent({ type: "build-start", round });
    await writeCandidateProject(rebuiltDirectory, source);
    await buildCandidate(rebuiltDirectory);
    const mismatch = await validateCandidateConsumers(rebuiltDirectory, packageName, api, { allowReducedIsolation, noDocker });
    if (mismatch) {
      const structuralFailure = mismatch.includes("package root is not callable") ? "module root is not callable" : mismatch;
      return { passed: 0, total, failures: [], structuralFailure };
    }
    onEvent({ type: "test-start", round });
    return await runCharacterization(artifactDirectory, { allowReducedIsolation, noDocker });
  } catch (error) {
    if (error instanceof ExecutionIsolationError) throw error;
    const detail = error instanceof Error ? error.message : "Candidate build failed.";
    return failedRun(total, detail);
  }
}

async function evaluateLastRites(
  target: ResurrectionTarget,
  allowReducedIsolation: boolean,
  noDocker: boolean,
  evaluate?: (artifactDirectory: string, testFile: string) => Promise<CharacterizationResult>
): Promise<LastRitesResult> {
  const heldOut = target.artifact.heldOutBehaviors ?? [];
  if (heldOut.length === 0) return { passed: 0, total: 0 };
  const testArtifact = { ...target.artifact, behaviors: heldOut };
  await writeFile(path.join(target.artifactDirectory, LAST_RITES_TEST_FILE), renderSoulTest(testArtifact), "utf8");
  const result = evaluate
    ? await evaluate(target.artifactDirectory, LAST_RITES_TEST_FILE)
    : await runCharacterization(target.artifactDirectory, { testFile: LAST_RITES_TEST_FILE, allowReducedIsolation, noDocker });
  return { passed: result.passed, total: result.total };
}

export interface ResurrectionLoopOptions {
  evaluateCandidate?: (artifactDirectory: string, source: string, total: number, round: number, onEvent: ResurrectionEventCallback) => Promise<CharacterizationResult>;
  evaluateLastRites?: (artifactDirectory: string, testFile: string) => Promise<CharacterizationResult>;
  onEvent?: ResurrectionEventCallback;
  /** Explicitly permits host execution for trusted fixtures or a disposable VM. */
  allowReducedIsolation?: boolean;
  /** Explicitly selects reduced isolation instead of Docker. */
  noDocker?: boolean;
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
  const api = publicApi(target);
  const evaluate = options.evaluateCandidate ?? ((artifactDirectory, source, candidateTotal, round, onEvent) =>
    executeCandidate(
      artifactDirectory,
      source,
      candidateTotal,
      round,
      onEvent,
      api,
      target.artifact.packageName,
      options.allowReducedIsolation === true,
      options.noDocker === true
    )
  );
  const emit: ResurrectionEventCallback = (event) => options.onEvent?.(event);
  let selectedEngine = generator.name;
  let generatedCandidate = false;
  emit({ type: "engine-selected", engine: selectedEngine });

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    emit({ type: "round-start", round, maxRounds: MAX_ROUNDS });
    let source: string;
    try {
      source = await generator.generate({
        packageName: target.artifact.packageName,
        api,
        soul,
        soulTest,
        round,
        previousSource,
        failures: feedback
      });
    } catch (error) {
      if (generator.name !== selectedEngine) {
        selectedEngine = generator.name;
        emit({ type: "engine-selected", engine: selectedEngine });
      }
      const detail = generationFailure(error);
      rounds.push({ round, passed: 0, total, failedIds: [] });
      emit({ type: "round-complete", round, passed: 0, total, result: `generation failed: ${detail}` });
      continue;
    }
    generatedCandidate = true;
    previousSource = source;
    if (generator.name !== selectedEngine) {
      selectedEngine = generator.name;
      emit({ type: "engine-selected", engine: selectedEngine });
    }
    emit({ type: "generation-complete", round, engine: generator.name });
    last = await evaluate(target.artifactDirectory, source, total, round, emit);
    if (last.total !== total) {
      throw new Error(`The emitted suite reported ${last.total} tests, but behaviors.json records ${total} observed behaviors.`);
    }
    rounds.push({ round, passed: last.passed, total, failedIds: last.failures.map((failure) => failure.id).filter(Boolean) });
    if (last.structuralFailure) {
      emit({ type: "round-complete", round, passed: 0, total, result: `structural failure: ${last.structuralFailure}` });
      feedback = [structuralFeedback(last.structuralFailure)];
      continue;
    }
    emit({ type: "round-complete", round, passed: last.passed, total, result: `${last.passed} of ${total} observed behaviors passing` });
    if (last.passed === total) break;
    feedback = failureFeedback(target.artifact.behaviors, last);
  }

  if (!generatedCandidate) {
    throw new Error(`No reconstruction candidate was generated in ${MAX_ROUNDS} rounds. Review the recorded generation failures and retry.`);
  }

  const complete = last.passed === total;
  const lastRites = complete
    ? await evaluateLastRites(target, options.allowReducedIsolation === true, options.noDocker === true, options.evaluateLastRites)
    : undefined;
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
    ...(lastRites ? { lastRites } : {}),
    resultPath
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
