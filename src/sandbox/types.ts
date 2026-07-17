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

export interface SandboxOptions {
  /** Prefer the child-process runner even when Docker is available. */
  noDocker?: boolean;
  /** Per-invocation wall-clock cap. */
  timeoutMs?: number;
  /** Receives explicit fallback warnings; defaults to stderr. */
  onWarning?: (message: string) => void;
}

export interface SandboxRunner {
  readonly mode: RunnerMode;
  invoke(exportPath: string, args: unknown[]): Promise<InvocationResult>;
  dispose(): Promise<void>;
}
