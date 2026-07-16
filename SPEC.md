# 💀 NECROMANCER — Build Spec v1

> **One-liner:** Necromancer resurrects dead software. Point it at an abandoned package; it runs the corpse in a sandbox, extracts its soul (a behavioral spec + executable test suite derived from *observed behavior*), then orchestrates Codex to rebuild it in a modern, zero-dependency, CVE-free form that must pass the original's own extracted tests.
>
> **Track:** Developer Tools · **Hackathon:** OpenAI Build Week · **Deadline:** July 21, 5:00 PM PDT (= July 22, 5:30 AM IST)

---

## 1. The wedge (what we say it's for)

Abandoned dependencies with known CVEs. Every real project has one: the maintainer left in 2021, there are 40 open issues, `npm audit` screams, and nobody dares touch it because **there are no tests and nobody understands the code**. Necromancer's two outputs attack exactly that:

1. **The Soul** — a characterization test suite + human-readable behavioral spec extracted empirically. Valuable *on its own* (this is the "no tests" problem solved), even if you never adopt the rebuild.
2. **The Resurrection** — a modern TypeScript rebuild, zero runtime deps, gated by the Soul.

## 2. Honest claims (judge-proofing — never violate these)

- **NEVER** say "100% parity" or "proven identical." Say: **"parity across N observed behaviors, X% branch coverage of the original."** The UI must display both numbers prominently. Precision reads as *more* impressive to expert judges, not less.
- The tool must **genuinely work on arbitrary small packages** — Developer Tools judges install and run entries on their own inputs. Cherry-picked-demo-only = death.
- When a target is out of scope (native modules, network I/O, >2k LOC), **fail fast with a clear, friendly message** that states v1 scope. A confident "this corpse is beyond v1 necromancy: it binds to native code" beats a hang or a garbage result.

## 3. v1 scope (guard rails — do not creep)

| In scope | Out of scope (v1, stated proudly) |
|---|---|
| Pure-JS npm packages, CommonJS or ESM | Native modules (node-gyp), browser-only UI libs |
| ≤ ~2,000 LOC, ≤ 3 transitive runtime deps | Network/filesystem-heavy packages, servers, CLIs with interactive TTY |
| Deterministic, mostly-pure API surfaces | Distributed systems, DBs, anything needing secrets |
| Node 20+ runtime | Python (v2 tease only — mention in README roadmap) |

## 4. Architecture

```
necromancer <pkg-name>[@version]   (CLI, npx-able)
     │
     ├─ 1. EXHUME    – fetch tarball from npm registry; static triage
     │                 (LOC count, dep tree, native-module / io scan → in-scope gate)
     ├─ 2. SANDBOX   – install & load in isolated runner
     │                 (Docker if available, else child-process w/ --disallow network via env + warning)
     ├─ 3. PROBE     – discover API surface (introspect exports, parse README examples,
     │                 mine the package's own tests if any)
     │                 → GPT-5.6 generates candidate inputs (typical / edge / adversarial / type-chaos)
     │                 → property-based amplification via fast-check
     │                 → execute against original, RECORD {input, output|throw, type} tuples
     │                 → measure branch coverage of the ORIGINAL under probing (c8)
     ├─ 4. DISTILL   – GPT-5.6 turns recorded behaviors into:
     │                 a) SOUL.md   – human-readable behavioral spec (grouped, named behaviors,
     │                                including the WEIRD ones: quirks, inconsistencies, bug-compat notes)
     │                 b) soul.test.ts – executable characterization suite (vitest), one test per behavior,
     │                                deterministic, no network, runs against EITHER implementation
     ├─ 5. RESURRECT – rebuild loop:
     │                 engine=codex (default): shell out to `codex exec` with SOUL.md + failing tests
     │                 engine=api  (fallback): GPT-5.6 API direct codegen loop
     │                 iterate: generate → run soul.test.ts → feed failures back → repeat (cap: 6 rounds)
     │                 target: modern TS, zero runtime deps, ESM+CJS dual build
     └─ 6. REPORT    – parity: N/M behaviors passing; coverage % of original;
                       `npm audit`/OSV before vs after; LOC & dep-count before vs after
                       → terminal summary + static HTML "graveyard" report (tombstone → phoenix)
```

### Component notes

- **PROBE is the crown jewel** — this is the novel part; give it the most build time. Input generation strategy per exported function: (1) GPT-5.6 reads source + README and proposes ~20 semantically meaningful inputs incl. edge cases; (2) fast-check fuzzes around them (type mutations, boundary values, unicode, prototype-pollution payloads); (3) everything executed against the original, results recorded verbatim — including thrown errors and their messages (bug-for-bug fidelity is a *feature*: name these "quirk behaviors" in SOUL.md).
- **Determinism filter:** run every recorded behavior twice; discard non-deterministic ones (Date.now, randomness) or wrap with tolerance. The suite must be flake-free — judges will run it.
- **RESURRECT via Codex** makes the product itself Codex-powered (maximum theme alignment): Necromancer writes a work order (SOUL.md + test file + constraints) into a temp workspace and invokes the Codex CLI non-interactively. Auto-detect Codex CLI; fall back to `--engine api` with a notice so judges without Codex auth can still test.
- **Sandbox:** Docker preferred (`node:20-slim`, `--network=none` after install). If no Docker: isolated child process, scrubbed env, and an explicit "reduced isolation" warning. Never `require()` the target in the main process.

## 5. Tech stack

TypeScript, Node 20. CLI: commander + a polished terminal UI (ora spinners, chalk; tombstone/phoenix ASCII moments). Tests: vitest. Fuzzing: fast-check. Coverage: c8. Model: **GPT-5.6 via OpenAI API** (product runtime) — structured outputs for probe plans & spec distillation. Rebuild agent: **Codex CLI** (`codex exec`), API fallback. Report: single static HTML file (no server needed — judges open it in a browser). Keep total runtime deps of Necromancer itself lean; it should feel like a tool, not a platform.

## 6. Pilot corpses (pre-tested demo targets — cache all runs)

| Package | Why it demos well |
|---|---|
| `left-pad` | THE iconic dead package ("broke the internet, 2016") — perfect cold open |
| `is-odd` | Meme value; 400k weekly downloads for one modulo — comedy beat |
| `deep-extend` or `set-value` (old ver) | Real prototype-pollution CVE — the wedge use case, played straight |
| `growl` | Abandoned + CVE + no tests — the "typical corpse" |
| + 5–10 random small packages | Hardening set — this is the "works on judge's input" insurance |

## 7. Day-by-day plan (buffer included)

- **Day 0 — Jul 17 (tonight):** create GitHub repo `necromancer`; start THE Codex project thread (see CODEX_PLAYBOOK.md — one thread for all core work); milestone 1: CLI skeleton + EXHUME + triage gate working on left-pad.
- **Day 1 — Jul 18:** SANDBOX + PROBE end-to-end; behaviors recorded with coverage numbers on 3 pilots. *Checkpoint: `necromancer probe left-pad` prints recorded behaviors.*
- **Day 2 — Jul 19:** DISTILL + RESURRECT loops; **first full resurrection end-to-end** (left-pad, then deep-extend). *Checkpoint: parity report shows N/M green.*
- **Day 3 — Jul 20:** REPORT + graveyard HTML + terminal polish; harden against the random-package set (fix top failure modes; sharpen out-of-scope messages); README with 60-second quickstart + install/testing instructions (track requirement); capture `/feedback` Codex Session ID.
- **Day 4 — Jul 21:** record & edit 3-min video (script beats below), Devpost write-up, submit by **early afternoon IST** — never ride the 5 PM PDT wire.

## 8. Demo video — beat sheet (<3 min, voiceover required)

1. **0:00–0:20 Cold open:** "In 2016, eleven lines of code vanished and broke the internet. left-pad's maintainer quit. Every dead package is a tiny time bomb in someone's supply chain." Tombstone graphic.
2. **0:20–0:50 The claim:** "Necromancer brings dead software back to life — and proves it." Run `npx necromancer deep-extend`. Narrate the phases as they stream.
3. **0:50–1:40 The magic:** SOUL.md scrolls (point at a *quirk* behavior it caught — that's the "no human wrote this" moment); Codex rebuild iterations; parity meter climbs; report: "parity across 214 observed behaviors, 91% branch coverage, CVEs: 1 → 0, deps: 4 → 0."
4. **1:40–2:10 Range shot:** montage of 3 more resurrections incl. is-odd for the laugh.
5. **2:10–2:40 How + Codex story:** architecture slide (10 sec); "the entire pipeline was built in one Codex thread — and the rebuild engine *is* Codex, driven by machine-written specs."
6. **2:40–3:00 Close:** "The Soul is yours even if you never adopt the rebuild. Software dies when knowledge dies. Now knowledge is extractable. — Necromancer. Bring out your dead."

## 9. Risks & fallbacks

| Risk | Mitigation |
|---|---|
| Rebuild loop can't reach high parity on some target | Ship anyway: the Soul alone is the fallback value; report shows honest N/M |
| Docker missing on judge machine | Auto-fallback isolation + warning; README states both paths |
| Judge lacks Codex CLI auth | `--engine api` fallback documented in README |
| Probe runtime too slow / API cost | Cap probe budget per function; cache aggressively; `--fast` mode |
| Non-deterministic tests flake for judges | Determinism filter (run-twice) is non-negotiable in Day 1 scope |
| Credits burn too fast | Codex for core build sessions only; no exploratory churn; check usage daily |

## 10. Submission checklist (Devpost)

- [ ] Working project using **Codex + GPT-5.6** (Stage One pass/fail — both visibly used)
- [ ] Category: Developer Tools
- [ ] Text description (features + what Codex accelerated)
- [ ] YouTube video < 3 min, with audio voiceover
- [ ] Public repo URL, README describing collaboration with Codex
- [ ] **`/feedback` Codex Session ID** from the project thread where majority of core was built
- [ ] Install + testing instructions & supported platforms (Dev Tools track requirement)
