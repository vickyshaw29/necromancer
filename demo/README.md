# Offline judge replay

For the renderer-backed replay after building, run:

```sh
node dist/cli.js replay
```

It writes `.necromancer-cache/replay/replay.html` and `rebuilt/provenance.json` locally. The command uses no network access, model credential, sandbox, package fetch, or package reconstruction. Pass `--output <directory>` to choose another writable directory.

Open [replay.html](replay.html) directly for the checked-in browser-only preview.

The renderer-backed fictional fixture is tracked in [src/replay.ts](../src/replay.ts); the browser-preview values are recorded in [replay-input.json](replay-input.json) and [replay-provenance.json](replay-provenance.json). It demonstrates the report's evidence labels, coverage breakdown, argument-shape boundary, optional held-out result, and advisory-scan scope. It is not evidence that a real package was reconstructed or secured.

To exercise the implementation rather than the static fixture after dependencies are available, run:

```sh
npm test -- tests/replay.test.ts tests/report.test.ts tests/graveyard.test.ts
```

Those tests are offline and use only fixture packages and mocked advisory responses. A real probe fetches a named npm package; a real resurrection additionally needs an authenticated Codex CLI or an OpenAI API key.
