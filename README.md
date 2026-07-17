# NECROMANCER

† Behavioral reconstruction for abandoned JavaScript packages. NECROMANCER records what a small package actually does, turns those observations into a SOUL specification and characterization suite, then uses a model engine to rebuild against that suite. Its claim is deliberately bounded: a rebuild reports **N of M observed behaviors, X% branch coverage of the original**; it does not claim unobserved behavior.

## Quickstart

Node 20 or newer is required. A complete run needs either an OpenAI API key or an authenticated Codex CLI for the RESURRECT phase.

```sh
npx necromancer resurrect left-pad
```

That command fetches the package, creates artifacts under `.necromancer-cache/probes/`, and writes `SOUL.md`, `soul.test.ts`, `rebuilt/`, `result.json`, and `graveyard.html` beside the probe artifact.

For local development:

```sh
npm install
npm run build
node dist/cli.js resurrect is-odd --engine codex
```

## Engines

PROBE and DISTILL use `api → codex → heuristic` automatically: the OpenAI API is selected when `OPENAI_API_KEY` is present, then Codex CLI when available, then the deterministic heuristic planner/writer. Override with `--engine api`, `--engine codex`, or `--engine heuristic` where supported.

RESURRECT requires a model engine because emitting a meaningful implementation is not a heuristic operation. It auto-selects API then Codex, or accepts `--engine api` / `--engine codex`; if neither is available, it exits with a clear message and does not fabricate a rebuild.

Set an API key in the shell or a gitignored `.env` file:

```sh
OPENAI_API_KEY=your-key-here
```

## Demo corpses

- `deep-extend` is an in-scope package with a published, later-fixed security advisory. It is useful for demonstrating the scanner: OSV queries the selected original package version, while a zero-runtime-dependency reconstruction is scanned separately and reports no advisories across 0 runtime dependencies.
- `left-pad` is a small no-advisory comparison target. Its report demonstrates that “no advisories found” is shown only when the scan measures that result.

Advisory counts are queried at report time; this tool does not hardcode a before/after advisory outcome.

## v1 scope

| In scope | Out of scope in v1 |
| --- | --- |
| Small pure-JS npm packages, CommonJS or ESM | Native modules, node-gyp bindings, browser-only UI libraries |
| About 2,000 source LOC or less; at most 3 resolved runtime dependencies | Filesystem/network-heavy packages, servers, interactive CLIs |
| Deterministic, mostly-pure APIs | Databases, distributed systems, secrets-dependent software |
| Node 20+ | Python and other non-JavaScript ecosystems |

Unsupported targets fail during EXHUME with the v1 scope and the observed reason.

## Platforms and isolation

Supported platforms are macOS, Linux, and Windows with Node 20+. Docker is optional: it isolates the bare package install and inspection step when available. Behavioral probing always uses the reduced-isolation child process because V8 coverage must write locally; that runner scrubs its environment and blocks common network and process-control modules, but it is not full containment. Run untrusted packages on a disposable machine or VM.

## How it works

### 1. EXHUME

EXHUME downloads the npm tarball directly from the registry and unpacks it into a temporary workspace. It counts source LOC and dependencies, then detects native, filesystem, and network markers before proceeding.

### 2. SANDBOX

SANDBOX stages the target outside the NECROMANCER process and removes copied lifecycle scripts before dependency installation. Docker currently isolates only the bare install and inspection step; behavioral probing runs in the reduced-isolation child process so c8 can collect V8 coverage. Treat that child process as a defensive compatibility runner, not a complete security boundary, and use a disposable machine or VM for untrusted packages.

### 3. PROBE

PROBE discovers exports, README examples, and bundled test examples, then plans semantic inputs with an API, Codex, or deterministic heuristic engine. It amplifies those inputs, runs each candidate twice, keeps deterministic results, and measures original branch coverage.

### 4. DISTILL

DISTILL writes `SOUL.md`, grouping observed behaviors and quirks with evidence IDs. It also emits `soul.test.ts` from a fixed template, so every recorded behavior has a deterministic characterization test.

### 5. RESURRECT

RESURRECT gives a model the SOUL, test suite, public API shape, and prior failing observations—not the original source. It writes a modern TypeScript candidate with dual ESM/CJS output, reruns the suite, and stops after six rounds or an all-green observed suite.

### 6. REPORT

REPORT compares observed behavior counts, original coverage, LOC, runtime dependencies, and OSV advisory data. It writes an offline `graveyard.html` report with the same bounded fidelity statement used by the terminal.

## Commands

```sh
necromancer <pkg>                         # EXHUME + SANDBOX gate
necromancer probe <pkg> --fast            # record observed behavior
necromancer distill <pkg>                 # reuse or create probe artifacts
necromancer resurrect <pkg> --engine codex
```

`probe` and `distill` accept `--max-behaviors`, `--fast`, and their documented engine options. `resurrect` chains missing PROBE and DISTILL artifacts automatically, then writes the REPORT.

## Testing

The repository suite is offline: it uses fixture packages, stub model engines, and mocked OSV responses.

```sh
npm install
npm run check
npx vitest run
npm run build
node dist/cli.js resurrect is-odd --engine codex
```

To rerun the emitted suite against a rebuilt candidate, change into the printed artifact directory:

```sh
NECROMANCER_IMPL=rebuilt npx vitest run soul.test.ts
```

The generated `graveyard.html` is a static file; open it directly in a browser without a server.
