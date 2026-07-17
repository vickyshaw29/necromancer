import { ProbeArtifact } from "../distill/index.js";
import { TriageResult } from "../exhume/index.js";
import { ResurrectionResult } from "../resurrect/index.js";

export interface OsvAdvisoryResult {
  status: "known" | "unknown";
  advisoryCount?: number;
  cveCount?: number;
  detail?: string;
}

export interface SourceMetrics {
  loc: number;
  runtimeDependencies: number;
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
  after: SourceMetrics;
  osv: OsvAdvisoryResult;
  soul: string;
}

export interface ReportResult {
  reportPath: string;
  data: ReportData;
}
