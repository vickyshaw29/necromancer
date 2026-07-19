export class ExecutionIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionIsolationError";
  }
}

export function reducedIsolationWarning(scope: string): string {
  return `[RESURRECT] Warning: ${scope} is executing with reduced isolation because it was explicitly requested. This is not safe for untrusted package or model code; use a disposable VM.`;
}
