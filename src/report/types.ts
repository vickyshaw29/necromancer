import { ProbeArtifact } from "../distill/index.js";
import { OriginalPackageReceipt, TriageResult } from "../exhume/index.js";
import { ResurrectionResult } from "../resurrect/index.js";

export interface OsvAdvisoryResult {
  status: "known" | "unknown";
  advisoryCount?: number;
  cveCount?: number;
  identifiers?: string[];
  detail?: string;
  scannedDependencyCount?: number;
}

export interface SourceMetrics {
  loc: number;
  runtimeDependencies: number;
}

export interface DeclaredRuntimeDependency {
  name: string;
  version: string;
}

export interface RebuiltSourceMetrics extends SourceMetrics {
  declaredRuntimeDependencies: DeclaredRuntimeDependency[];
}

export interface ReportInput {
  packageName: string;
  version: string;
  artifact: ProbeArtifact;
  triage: TriageResult;
  original?: OriginalPackageReceipt;
  resurrection: ResurrectionResult;
  artifactDirectory: string;
  soulWriterEngine?: string;
}

export interface AuthoredSourceFile {
  path: string;
  sha256: string;
}

export interface UnobservedBoundary {
  branchCoveragePercent: number;
  branchTotals: { total: number; covered: number; uncovered: number } | "unavailable";
  uncoveredBranchStatement: string;
  claimBoundary: "Behavior outside the observed coverage is not claimed.";
}

export interface ProvenanceReceipt {
  schemaVersion: 1;
  generatedAt: string;
  necromancerVersion: string;
  original: OriginalPackageReceipt;
  observation: {
    recordedBehaviorCount: number;
    branchCoveragePercent: number;
    probeEngine: string;
    artifactDirectoryName: string;
  };
  distillation: {
    soulSha256: string;
    soulTestSha256: string;
    writerEngine: string;
  };
  resurrection: {
    engine: string;
    roundsExecuted: number;
    passedObservedBehaviors: number;
    totalObservedBehaviors: number;
    authoredSourceFiles: AuthoredSourceFile[];
    rebuiltLoc: number;
    declaredRuntimeDependencyCount: number;
  };
  quarantine: {
    originalSourceProvided: false;
    generatorInputs: ["SOUL", "characterization suite", "public API shape", "failure feedback"];
  };
  unobserved: UnobservedBoundary;
}

export interface ReportEvidence {
  packageName: string;
  version: string;
  artifact: ProbeArtifact;
  resurrection: ResurrectionResult;
  before: SourceMetrics;
  after: RebuiltSourceMetrics;
  originalOsv: OsvAdvisoryResult;
  rebuiltOsv: OsvAdvisoryResult;
  soul: string;
}

export interface ReportData extends ReportEvidence {
  provenance: ProvenanceReceipt;
}

export interface ReportResult {
  reportPath: string;
  provenancePath: string;
  data: ReportData;
}
