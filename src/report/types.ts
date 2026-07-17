import { ProbeArtifact } from "../distill/index.js";
import { TriageResult } from "../exhume/index.js";
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
  resurrection: ResurrectionResult;
  artifactDirectory: string;
}

export interface ReportData {
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

export interface ReportResult {
  reportPath: string;
  data: ReportData;
}
