export type RunnerMode = "docker" | "child";

export type JsonSafeValue =
  | null
  | boolean
  | string
  | number
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

export interface SerializedError {
  name: string;
  message: string;
}

export interface InvocationSuccess {
  ok: true;
  value: JsonSafeValue;
  durationMs: number;
}

export interface InvocationFailure {
  ok: false;
  error: SerializedError;
  durationMs: number;
}

export type InvocationResult = InvocationSuccess | InvocationFailure;

export interface SandboxSource {
  packagePath: string;
  packageName: string;
}

export interface ExportDescriptor {
  path: string;
  type: string;
  arity?: number;
}

export interface ModuleSurface {
  exports: ExportDescriptor[];
}

export interface SandboxOptions {
  /** Prefer the child-process runner even when Docker is available. */
  noDocker?: boolean;
  /** Per-invocation wall-clock cap. */
  timeoutMs?: number;
  /** Enables V8 raw coverage output and selects the child runner for this sandbox. */
  coverageDirectory?: string;
  /** Receives explicit fallback warnings; defaults to stderr. */
  onWarning?: (message: string) => void;
}

export interface SandboxRunner {
  readonly mode: RunnerMode;
  inspect(): Promise<ModuleSurface>;
  invoke(exportPath: string, args: unknown[]): Promise<InvocationResult>;
  coveragePaths(): { rawDirectory: string; sourceDirectory: string } | undefined;
  dispose(): Promise<void>;
}
