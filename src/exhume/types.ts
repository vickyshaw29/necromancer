export type ScopeReasonCode =
  | "NATIVE_MODULE"
  | "TOO_MANY_LINES"
  | "TOO_MANY_FILES"
  | "TOO_LARGE_SOURCE_FILE"
  | "TOO_MANY_RUNTIME_DEPENDENCIES"
  | "FILESYSTEM_USAGE"
  | "NETWORK_USAGE"
  | "DYNAMIC_RUNTIME_ACCESS";

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
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  gypfile?: boolean;
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
  };
}

export type RegistryIntegrityMatch = "verified" | "mismatch" | "unknown";

export interface OriginalPackageReceipt {
  name: string;
  version: string;
  registryTarballUrl: string;
  registryDeclaredIntegrity: {
    integrity: string | "unknown";
    shasum: string | "unknown";
  };
  localTarballSha512: string;
  integrityMatch: RegistryIntegrityMatch;
  detectedLicense: string;
  sourceLoc: number;
  resolvedRuntimeDependencyCount: number;
}

export interface ExhumedPackage {
  spec: PackageSpec;
  manifest: NpmPackageManifest;
  workspacePath: string;
  packagePath: string;
  triage: TriageResult;
  original: OriginalPackageReceipt;
}
