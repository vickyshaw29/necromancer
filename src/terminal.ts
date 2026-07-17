export function printBanner(): void {
  console.log(["", "        ┌──────────────┐", "        │ NECROMANCER  │", "        │     R.I.P.   │", "        └──────────────┘"].join("\n"));
}

export function printPhase(number: number, name: string, detail: string): void {
  console.log(`[${number}/6] ${name.padEnd(10)} ◌ ${detail}`);
}

export function printSuccess(detail: string): void {
  console.log(`\n✓ ${detail}`);
}
