2026-07-17 — SANDBOX stages copied packages under the repository's ignored `.necromancer-cache/` so Docker Desktop can mount them reliably and cleanup stays within the project.
2026-07-17 — Docker uses network access only for `npm install --ignore-scripts`; each invocation runs in a separate read-only `node:20-slim` container with `--network=none`.
2026-07-17 — The child-process fallback scrubs its environment and blocks common Node network APIs, but explicitly warns that this is reduced isolation rather than claiming a network guarantee.
2026-07-17 — JSON-safe RPC values use tagged objects for non-JSON primitives and circular references so probe artifacts remain explicit and serializable.
2026-07-17 — Docker commands use an ephemeral credential-free client config and the active Docker endpoint because NECROMANCER only pulls the public `node:20-slim` image and must not inherit host registry credentials or a broken credential helper.
