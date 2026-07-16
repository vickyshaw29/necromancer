export type ScopeReasonCode =
  | "NATIVE_MODULE"
  | "TOO_MANY_LINES"
  | "TOO_MANY_RUNTIME_DEPENDENCIES"
  | "FILESYSTEM_USAGE"
  | "NETWORK_USAGE";

export interface ScopeReason {
  code: ScopeReasonCode;
  message: string;
}

export interface TriageResult {
  loc: number;
  runtimeDependencyCount: number;
  nativeEvidence: string[];
  filesystemImports: string[];
  networkImports: string[];
  verdict: "IN_SCOPE" | "OUT_OF_SCOPE";
  reasons: ScopeReason[];
}

export interface PackageSpec {
  name: string;
  requestedVersion?: string;
}

export interface NpmPackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  gypfile?: boolean;
  dist?: {
    tarball?: string;
  };
}

export interface ExhumedPackage {
  spec: PackageSpec;
  manifest: NpmPackageManifest;
  workspacePath: string;
  packagePath: string;
  triage: TriageResult;
}
