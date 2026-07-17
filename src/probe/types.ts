import { ExportDescriptor, JsonSafeValue, ModuleSurface, SandboxRunner, SerializedError } from "../sandbox/index.js";

export type ProbeEngineName = "api" | "codex" | "heuristic";
export type ProbeEnginePreference = ProbeEngineName | "auto";

export interface InputCandidate {
  args: unknown[];
  rationale?: string;
}

export interface FunctionInputPlan {
  exportPath: string;
  candidates: InputCandidate[];
}

export interface InputPlan {
  functions: FunctionInputPlan[];
}

export interface ExampleCall {
  exportPath: string;
  args: unknown[];
  source: "readme" | "test";
  snippet: string;
}

export interface DiscoveryResult {
  surface: ModuleSurface;
  examples: ExampleCall[];
  readme: string;
  sourceExcerpt: string;
}

export interface PlanRequest {
  packageName: string;
  packagePath: string;
  functions: ExportDescriptor[];
  examples: ExampleCall[];
  readme: string;
  sourceExcerpt: string;
}

export interface InputPlanEngine {
  readonly name: ProbeEngineName | string;
  generate(request: PlanRequest): Promise<InputPlan>;
}

export interface ProbeBehavior {
  id: string;
  fn: string;
  args: JsonSafeValue[];
  result?: JsonSafeValue;
  throw?: SerializedError;
}

export interface CoverageSummary {
  branchCoverage: number;
  lineCoverage: number;
  functionCoverage: number;
  statementCoverage: number;
  available: boolean;
  detail?: string;
}

export interface ProbeResult {
  packageName: string;
  version: string;
  engine: string;
  surface: ModuleSurface;
  examples: ExampleCall[];
  behaviors: ProbeBehavior[];
  discardedNonDeterministic: number;
  coverage: CoverageSummary;
  artifactPath: string;
}

export interface ProbeOptions {
  maxBehaviors: number;
  fast?: boolean;
  engine?: ProbeEnginePreference;
  planEngine?: InputPlanEngine;
  onNotice?: (message: string) => void;
}

export interface ProbeTarget {
  packageName: string;
  version: string;
  packagePath: string;
  sandbox: SandboxRunner;
  artifactDirectory: string;
}
