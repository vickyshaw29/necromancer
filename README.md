# NECROMANCER

† Behavioral reconstruction for abandoned JavaScript packages. NECROMANCER records what a small package actually does, turns those observations into a SOUL specification and characterization suite, then uses a model engine to rebuild against that suite. Its claim is deliberately bounded: a rebuild reports **N of M observed behaviors plus branch, line, and function coverage of the original**. It also records exercised argument shapes and, when Last Rites is run, a held-out result. It does not claim unobserved behavior, security, vulnerability remediation, equivalence, or production safety.

## Judge replay (no network, credentials, or package rebuild)

After installing dependencies and building, run:

```sh
node dist/cli.js replay
```

This exercises the real report renderer with a small tracked fixture and writes `.necromancer-cache/replay/replay.html` plus its local fixture-marked provenance receipt. The command makes no network requests, starts no sandbox, uses no model credentials, and does not fetch, execute, rebuild, or assess a package. Pass `--output <directory>` to choose another writable output directory.

For an immediate browser-only preview, open [demo/replay.html](demo/replay.html) directly. Both paths are report-UX walkthroughs, not claims that the fictional fixture package was reconstructed. [demo/README.md](demo/README.md) describes the fixture and the offline checks.

## Fast first look (no model credentials needed)

From a fresh clone, install and build first (`npm install && npm run build`), then:

```sh
node dist/cli.js probe is-number --engine heuristic
```

This fetches the named npm package and records an observed-behavior probe artifact without a model; a probe normally takes seconds, while resurrection can take several minutes per model round and makes up to six rounds.

## Resurrect quickstart

Node 20 or newer is required. A complete run needs either an OpenAI API key or an authenticated Codex CLI for the RESURRECT phase.

```sh
git clone https://github.com/vickyshaw29/necromancer.git
cd necromancer
npm install
npm run build
node dist/cli.js resurrect left-pad
```

That command fetches the package, creates artifacts under `.necromancer-cache/probes/`, and writes `SOUL.md`, `soul.test.ts`, `rebuilt/result.json`, `rebuilt/provenance.json`, and `graveyard.html` in the probe artifact. (The unrelated `necromancer` name on the npm registry belongs to another project; this tool is not published there, so run it from this repository.)

`resurrect` exits 0 when all recorded behaviors are reproduced, 3 when it caps with differences, and 4 when no model engine is available.

## Engines

### How Codex and GPT-5.6 are used

The OpenAI API engine calls GPT-5.6 (`OPENAI_MODEL` in `src/openai.ts`) and the `codex` engine drives the Codex CLI. They power the two model-dependent jobs: planning semantic probe inputs in PROBE/DISTILL, and writing the TypeScript rebuild in RESURRECT — where the model receives SOUL.md, the characterization suite, and structured judge feedback (never the original source) for up to six repair rounds. The live resurrection results table below was produced with the Codex engine.

PROBE and DISTILL use `api → codex → heuristic` automatically: the OpenAI API is selected when `OPENAI_API_KEY` is present, then Codex CLI when available, then the deterministic heuristic planner/writer. Override with `--engine api`, `--engine codex`, or `--engine heuristic` where supported.

RESURRECT requires a model engine because emitting a meaningful implementation is not a heuristic operation. It auto-selects Codex CLI then the OpenAI API, or accepts `--engine api` / `--engine codex`; if neither is available, it exits before EXHUME with a clear setup message and does not fabricate a rebuild. In automatic mode, a Codex generation failure switches the remaining rounds to the API when `OPENAI_API_KEY` is available; explicit engine selections remain strict.

Codex rebuild generations allow 10 minutes per round by default; set `NECROMANCER_CODEX_TIMEOUT_MS` to a positive integer millisecond value to override it.

Set an API key in the shell or a gitignored `.env` file:

```sh
OPENAI_API_KEY=your-key-here
```

## Demo corpses

- `deep-extend@0.5.0` is an in-scope version with a published, later-fixed security advisory (fixed in 0.5.1). It demonstrates a crucial trade-off: compatibility work can preserve harmful legacy behavior. The report queries OSV metadata for the selected original version and separately scans only the rebuild's declared runtime dependencies. Neither result analyzes generated code or establishes that a vulnerability was remediated. Select `@0.5.0` explicitly; bare `deep-extend` resolves to the latest version.
- `left-pad` is a small no-advisory comparison target. Its report demonstrates that a no-advisory result is limited to the declared dependencies actually scanned.

Advisory counts are queried at report time; this tool does not hardcode a before/after outcome or infer a code-security outcome from a dependency manifest.

## v1 scope

| In scope | Out of scope in v1 |
| --- | --- |
| Small pure-JS npm packages, CommonJS or ESM | Native modules, node-gyp bindings, browser-only UI libraries |
| About 2,000 source LOC or less; at most 3 resolved runtime dependencies | Filesystem/network-heavy packages, servers, interactive CLIs |
| Deterministic, mostly-pure APIs | Databases, distributed systems, secrets-dependent software |
| Node 20+ | Python and other non-JavaScript ecosystems |

Unsupported targets fail during EXHUME with the v1 scope and the observed reason.

Python remains out of scope for v1; a future v2 could apply the same observed-behavior workflow to Python packages.

## Historical probe range (2026-07-17 sweep)

A ten-package sweep with the deterministic heuristic planner (`probe --fast --engine heuristic`) produced these observed results. They describe this sweep only, not a guarantee for all of npm.

| Target | Deterministic behaviors | Branch coverage of original | Result |
| --- | --- | --- | --- |
| `arr-diff@4.0.0` | 47 | 66.66% | probed clean |
| `camelcase@9.0.0` | 60 | 68.18% | probed clean |
| `clone@2.1.2` | 60 | 50.00% | probed clean |
| `dedent@1.7.2` | 60 | 53.84% | probed clean |
| `escape-string-regexp@5.0.0` | 51 | 100.00% | probed clean |
| `is-plain-object@5.0.0` | 45 | 75.00% | probed clean |
| `mime-types@3.0.2` | 60 | 75.43% | probed clean |
| `ms@2.1.3` | 60 | 58.18% | probed clean |
| `object-assign@4.1.1` | 60 | 45.45% | probed clean |
| `rimraf` | — | — | OUT_OF_SCOPE: 8 runtime dependencies (v1 caps at 3); accesses the filesystem |

Every run ended with either a recorded artifact or the friendly scope message — no hangs and no raw stack traces. `--fast` caps recording at 60 behaviors, which several targets reached; the API and Codex planners typically discover more semantic inputs than the heuristic used here. This historical table records branch coverage only; a current report displays branch, line, and function coverage along with argument-shape evidence.

### Fresh reconstruction evidence

The repository does not ship ignored cache outputs as proof of a current reconstruction. Run `resurrect <pkg>` and inspect its generated report for a fresh, package-specific result. A result is marked `REVIVED` only when every recorded behavior passes; an incomplete recorded suite remains `PARTIAL RECONSTRUCTION`.

## Platforms and isolation

Supported platforms are macOS, Linux, and Windows with Node 20+. Docker is required by default for package invocation, generated-candidate checks, and characterization; each execution is resource-capped and has no network after dependency installation. It has dedicated writable mounts for coverage and reports. Pass `--no-docker` to `probe`, `distill`, `resurrect`, or `verify` only when you explicitly accept the reduced-isolation fallback from a disposable VM. That fallback scrubs its environment and blocks common network and process-control modules, but it is not full containment.

## How it works

### 1. EXHUME

EXHUME downloads the npm tarball directly from the registry and unpacks it into a temporary workspace. It counts source LOC and dependencies, then detects native, filesystem, and network markers before proceeding.

### 2. SANDBOX

SANDBOX stages the target outside the NECROMANCER process and removes copied lifecycle scripts before dependency installation. Docker runs package invocation by default with a read-only package mount, no network, resource caps, and a dedicated writable coverage mount. `--no-docker` selects the reduced-isolation fallback explicitly. Treat that fallback as a defensive compatibility runner, not a complete security boundary, and use a disposable machine or VM for untrusted packages.

### 3. PROBE

PROBE discovers exports, README examples, and bundled test examples, then plans semantic inputs with an API, Codex, or deterministic heuristic engine. It amplifies those inputs, runs each candidate twice, keeps deterministic results, measures original branch, line, and function coverage, and reserves a small separate deterministic Last Rites set that is excluded from the rebuild work order.

### 4. DISTILL

DISTILL writes `SOUL.md`, grouping observed behaviors and quirks with evidence IDs. It also emits `soul.test.ts` from a fixed template, so every recorded behavior has a deterministic characterization test.

### 5. RESURRECT

RESURRECT gives a model the SOUL, test suite, public API shape, and prior failing observations—not the original source or Last Rites inputs. It writes a modern TypeScript candidate with dual ESM/CJS output, verifies real CommonJS and ESM consumers, reruns the observed suite, and stops after six rounds or an all-green observed suite. Only after an all-green observed suite does it execute Last Rites; those results are reported but never fed back to the model.

### 6. REPORT

REPORT compares observed behavior counts, original branch/line/function coverage, argument shapes, LOC, and runtime dependencies. It labels OSV results as published advisory metadata for the original and declared-dependency metadata for the rebuild; the latter does not analyze generated code or prove CVE remediation. It writes an offline `graveyard.html` report with the same bounded fidelity statement used by the terminal.

#### Provenance receipt

`rebuilt/provenance.json` is an offline, schema-versioned measurement receipt. It records the registry tarball declaration and locally observed hash result, emitted artifact hashes, source hashes, coverage and argument-shape boundaries, any recorded held-out result, and the inputs withheld from or supplied to the rebuild engine. It reports missing or mismatched data as observed; it does not make a security or equivalence guarantee.

## Commands

```sh
necromancer <pkg>                         # EXHUME + SANDBOX gate
necromancer probe <pkg> --fast            # record observed behavior (add --no-docker for reduced isolation)
necromancer distill <pkg>                 # reuse or create probe artifacts (add --no-docker for reduced isolation)
necromancer resurrect <pkg> --engine codex # add --no-docker for reduced isolation
necromancer graveyard                      # index local reports for offline browsing
necromancer replay [--output <directory>]  # render a no-network report UX fixture
necromancer verify <pkg>                   # re-measure local provenance and suites (add --no-docker only for reduced isolation)
```

`probe` and `distill` accept `--max-behaviors`, `--fast`, and their documented engine options. `resurrect` chains missing PROBE and DISTILL artifacts automatically, then writes the REPORT.

### `graveyard`

`graveyard` scans `.necromancer-cache/probes/` by default and writes a self-contained `graveyard-index.html` there. Pass `--cache <dir>` to index a different artifact cache; each completed card links to its local `graveyard.html` report.

```text
$ necromancer graveyard
Graveyard index: /work/necromancer/.necromancer-cache/probes/graveyard-index.html
```

### `replay`

`replay` renders the tracked fictional fixture through the actual report renderer. It is a no-network, no-credential UX check, not a reconstruction or security test.

```text
$ necromancer replay
Replay report: /work/necromancer/.necromancer-cache/replay/replay.html
Offline report UX replay only: no package was fetched, executed, rebuilt, or assessed.
```

### `verify <pkg>`

`verify` stays offline: it re-hashes the local provenance-attested SOUL, suite, and rebuilt sources, then measures the emitted suite against the staged original and rebuilt implementation. Docker is required by default for those code-execution checks; use `--no-docker` only from a disposable VM. A bare package name selects the newest local artifact for that package; use `name@version` to select a version or `--artifact <dir>` to select an artifact directly.

```text
$ necromancer verify deep-extend@0.5.0
Verification receipt — /work/necromancer/.necromancer-cache/probes/deep-extend-0.5.0-abc123
SOUL.md sha256 ✓ matches attestation
soul.test.ts sha256 ✓ matches attestation
rebuilt/src/index.ts sha256 ✓ matches attestation
observed suite vs original: ✓ 53 of 53
observed suite vs rebuilt: ✓ 53 of 53
Not re-verified: registry tarball hash (no network in verify)
Not re-verified: OSV advisory data (recorded at report time; not re-queried)
All performed checks passed.
```

## Testing

The repository suite is offline: it uses fixture packages, stub model engines, and mocked OSV responses. `node dist/cli.js replay` exercises the report renderer without invoking a model, and the tracked [replay report](demo/replay.html) can be opened without installing dependencies.

```sh
npm install
npm run check
npx vitest run
npm run build
node dist/cli.js replay
node dist/cli.js resurrect is-odd --engine codex
```

To rerun the emitted suite against a rebuilt candidate, change into the printed artifact directory:

```sh
NECROMANCER_IMPL=rebuilt npx vitest run soul.test.ts
```

The generated `graveyard.html` is a static file; open it directly in a browser without a server.
