# NECROMANCER — Engineering Standards

Authoritative spec: `SPEC.md`. These standards apply to every change in this repository. They are hard requirements, not suggestions.

## Code quality contract

- **Small, focused modules.** Target ≤250 lines per file; hard cap 400. If a file wants to grow past that, split by responsibility — never by "part 1 / part 2".
- **No narration comments.** Comments exist only to state non-obvious invariants, constraints, or *why* something is done this way. Never describe what the next line does, never leave commented-out code, never leave TODO/FIXME in committed work — do it or log it in DECISIONS.md.
- **No speculative abstraction.** No interfaces with one implementation "for flexibility", no util grab-bag files, no wrapper layers that only rename things. Three concrete uses before an abstraction earns its place.
- **Dead code is a defect.** No unused exports, unreachable branches, or vestigial flags. Deleting is a feature.
- **TypeScript strict, `any` is a code smell.** Every `any`/assertion needs a one-line justification in DECISIONS.md, or a proper type instead.
- **Dependencies are a liability.** Runtime deps require strong justification (current count: 1 — commander). Prefer node built-ins.
- **Errors are product surface.** Every user-facing failure path ends in a clear, actionable message — never a raw stack trace, never a hang. Distinct exit codes per failure class.

## Performance contract

- Stream or chunk anything unbounded (tarballs, probe outputs, logs); never buffer entire artifacts of unknown size.
- No O(n²) over user-controlled input sizes (behavior lists, package files).
- Sandbox/container reuse over per-invocation setup where isolation allows; batch RPC invocations when probing.
- Measure before optimizing further: durations already captured per invocation — surface them, don't guess.

## Test quality contract

- Tests assert observable behavior, not implementation details. A test that can't fail for a real reason is deleted.
- The suite stays offline-green: no network, no API keys, no Docker required for `vitest run`.
- Fixtures are minimal and purpose-named; no snapshot dumps of large blobs.

## Documentation & output tone

- Docs and CLI output are technical, precise, and understated. State capabilities and limits plainly.
- The honest-claims rule is absolute: parity is always "N of M observed behaviors, X% branch coverage of the original" — never "identical", never "100% parity".
