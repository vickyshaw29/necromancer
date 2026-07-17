import { CoverageSummary, ProbeBehavior } from "../probe/index.js";

export type DistillEngineName = "api" | "codex" | "heuristic";
export type DistillEnginePreference = DistillEngineName | "auto";

export interface ProbeArtifact {
  packageName: string;
  behaviors: ProbeBehavior[];
  coverage: CoverageSummary;
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
