import { ArgumentShapeCoverage, CoverageSummary, ProbeBehavior } from "../probe/index.js";
import { ModuleSurface } from "../sandbox/index.js";

export type DistillEngineName = "api" | "codex" | "heuristic";
export type DistillEnginePreference = DistillEngineName | "auto";

export interface ProbeArtifact {
  packageName: string;
  version?: string;
  sourceTarballSha512?: string;
  behaviors: ProbeBehavior[];
  /** Sealed Last Rites cases are deliberately absent from SOUL.md and soul.test.ts. */
  heldOutBehaviors?: ProbeBehavior[];
  argumentShapeCoverage?: ArgumentShapeCoverage[];
  coverage: CoverageSummary;
  surface?: ModuleSurface;
}

export interface SoulRequest {
  packageName: string;
  behaviors: ProbeBehavior[];
  coverage: CoverageSummary;
}

export interface SoulEngine {
  readonly name: DistillEngineName | string;
  generate(request: SoulRequest): Promise<string>;
}

export interface DistillOptions {
  engine?: DistillEnginePreference;
  onNotice?: (message: string) => void;
}

export interface DistillResult {
  engine: string;
  soulPath: string;
  testPath: string;
  originalPath: string;
}
