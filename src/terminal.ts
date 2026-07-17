import path from "node:path";
import type { ResurrectionEvent } from "./resurrect/types.js";

export function printBanner(): void {
  console.log(["", "        ┌──────────────┐", "        │ NECROMANCER  │", "        │     R.I.P.   │", "        └──────────────┘"].join("\n"));
}

export function printPhase(number: number, name: string, detail: string): void {
  console.log(`[${number}/6] ${name.padEnd(10)} ◌ ${detail}`);
}

export function printSuccess(detail: string): void {
  console.log(`\n✓ ${detail}`);
}

export function printResurrectionEvent(event: ResurrectionEvent): void {
  switch (event.type) {
    case "engine-selected":
      console.log(`[5/6] RESURRECT  ◌ Generator selected: ${event.engine}`);
      return;
    case "round-start":
      console.log(`[5/6] RESURRECT  ◌ round ${event.round} of ${event.maxRounds} — generating candidate`);
      return;
    case "generation-complete":
      console.log(`[5/6] RESURRECT  ◌ round ${event.round} generation complete (${event.engine})`);
      return;
    case "build-start":
      console.log(`[5/6] RESURRECT  ◌ round ${event.round} build start`);
      return;
    case "test-start":
      console.log(`[5/6] RESURRECT  ◌ round ${event.round} test start`);
      return;
    case "round-complete":
      console.log(`[5/6] RESURRECT  ◌ round ${event.round} complete — ${event.result}`);
  }
}

export function printResurrectionEngineSetup(): void {
  console.error("  API setup: export OPENAI_API_KEY=...");
  console.error("  Codex setup: codex login");
  console.error("  No model required: necromancer probe <pkg> and necromancer distill <pkg> work without a model.");
}

export function printReproducibilityHandoff(artifactDirectory: string, distilledAvailable: boolean, rebuiltAvailable: boolean): void {
  const root = JSON.stringify(artifactDirectory);
  const soul = path.join(artifactDirectory, "SOUL.md");
  const distillNote = distilledAvailable ? "" : " (available after DISTILL)";
  const rebuiltNote = rebuiltAvailable ? "" : " (available after RESURRECT)";
  console.log("\nNEXT actions");
  console.log(`  View SOUL.md: ${soul}${distillNote}`);
  console.log(`  Rerun against original: npx vitest run --root ${root} soul.test.ts${distillNote}`);
  console.log(`  Rerun with NECROMANCER_IMPL=rebuilt: NECROMANCER_IMPL=rebuilt npx vitest run --root ${root} soul.test.ts${rebuiltNote}`);
}
