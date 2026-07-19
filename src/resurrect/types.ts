import { ProbeArtifact } from "../distill/index.js";
import { JsonSafeValue, SerializedError } from "../sandbox/index.js";

export type RebuildEngineName = "api" | "codex";
export type RebuildEnginePreference = RebuildEngineName | "auto";

export interface PublicApiMember {
  path: string;
  type: string;
  arity?: number;
}

export interface BehaviorFailureFeedback {
  id: string;
  fn: string;
  args: JsonSafeValue[];
  expected: JsonSafeValue | SerializedError;
  actual: string;
}

export interface StructuralFailureFeedback {
  kind: "structural";
  instruction: string;
}

export type FailureFeedback = BehaviorFailureFeedback | StructuralFailureFeedback;

export interface RebuildRequest {
  packageName: string;
  api: PublicApiMember[];
  soul: string;
  soulTest: string;
  round: number;
  previousSource?: string;
  failures: FailureFeedback[];
}

export interface RebuildGenerator {
  readonly name: RebuildEngineName | string;
  generate(request: RebuildRequest): Promise<string>;
}

export interface TestFailure {
  id: string;
  detail: string;
}

export interface CharacterizationResult {
  passed: number;
  total: number;
  failures: TestFailure[];
  structuralFailure?: string;
}

export interface ResurrectionRound {
  round: number;
  passed: number;
  total: number;
  failedIds: string[];
}

export interface LastRitesResult {
  passed: number;
  total: number;
}

export type ResurrectionEvent =
  | { type: "engine-selected"; engine: string }
  | { type: "round-start"; round: number; maxRounds: number }
  | { type: "generation-complete"; round: number; engine: string }
  | { type: "build-start"; round: number }
  | { type: "test-start"; round: number }
  | { type: "round-complete"; round: number; passed: number; total: number; result: string };

export type ResurrectionEventCallback = (event: ResurrectionEvent) => void;

export interface ResurrectionResult {
  packageName: string;
  engine: string;
  rounds: ResurrectionRound[];
  passed: number;
  total: number;
  complete: boolean;
  lastRites?: LastRitesResult;
  resultPath: string;
}

export interface ResurrectionTarget {
  artifact: ProbeArtifact;
  artifactDirectory: string;
}
