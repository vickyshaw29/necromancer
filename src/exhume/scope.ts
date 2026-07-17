import { ScopeReason } from "./types.js";

export function scopeMessage(reasons: ScopeReason[]): string {
  const detail = reasons.map((reason) => reason.message).join("; ");
  return [
    `This corpse is beyond v1 necromancy: ${detail}.`,
    "v1 supports small (<=2,000 LOC), pure-JS, mostly-pure npm packages with <=3 runtime dependencies."
  ].join(" ");
}

export function reportOutOfScope(reasons: ScopeReason[]): void {
  console.log(`\nOUT_OF_SCOPE — ${scopeMessage(reasons)}`);
  process.exitCode = 2;
}
