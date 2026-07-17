2026-07-17 — SANDBOX stages copied packages under the repository's ignored `.necromancer-cache/` so Docker Desktop can mount them reliably and cleanup stays within the project.
2026-07-17 — Docker uses network access only for `npm install --ignore-scripts`; each invocation runs in a separate read-only `node:20-slim` container with `--network=none`.
2026-07-17 — The child-process fallback scrubs its environment and blocks common Node network APIs, but explicitly warns that this is reduced isolation rather than claiming a network guarantee.
2026-07-17 — JSON-safe RPC values use tagged objects for non-JSON primitives and circular references so probe artifacts remain explicit and serializable.
2026-07-17 — Docker commands use an ephemeral credential-free client config and the active Docker endpoint because NECROMANCER only pulls the public `node:20-slim` image and must not inherit host registry credentials or a broken credential helper.
2026-07-17 — PROBE forces the child runner when collecting V8 coverage because c8 needs writable raw coverage files; Docker invocation remains the default elsewhere, and the CLI states the reduced-isolation coverage mode explicitly.
2026-07-17 — The `probe <pkg>` subcommand owns M3 flags so the established `necromancer <pkg>` EXHUME/SANDBOX entry remains backward compatible.
2026-07-17 — Probe artifacts persist under ignored `.necromancer-cache/probes/` by default (or `--output`) rather than a discarded EXHUME temp directory.
2026-07-17 — Probe numeric boundaries cap at 10,000 to exercise large inputs without inducing unbounded output allocation; individual runner failures are discarded with a notice instead of aborting the probe.
2026-07-17 — c8 and fast-check are runtime dependencies because M3 collects c8 coverage and generates fast-check mutations in the installed CLI; JSON `unknown` narrowing is localized at external model, c8, and artifact boundaries with runtime shape checks.
2026-07-17 — On this machine, `codex exec` exits because its local model cache is malformed; auto mode correctly records the notice and continues with the deterministic heuristic planner, which was used for live acceptance.
