import { ReportData } from "./types.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clusterText(soul: string): string {
  const start = soul.indexOf("## Behavioral clusters");
  if (start < 0) return "No behavioral clusters were available.";
  const end = soul.indexOf("## Quirks", start);
  return soul.slice(start, end < 0 ? undefined : end).trim();
}

function osvText(result: ReportData["originalOsv"]): string {
  if (result.status === "unknown") return "unknown, OSV unreachable";
  return `${result.cveCount ?? 0} CVE aliases across ${result.advisoryCount ?? 0} OSV advisories`;
}

function rebuiltOsvText(data: ReportData): string {
  if (data.rebuiltOsv.status === "unknown") return "unknown, OSV unreachable";
  if ((data.rebuiltOsv.advisoryCount ?? 0) === 0) {
    return `no advisories found across ${data.rebuiltOsv.scannedDependencyCount ?? data.after.runtimeDependencies} runtime dependencies`;
  }
  return osvText(data.rebuiltOsv);
}

export function renderGraveyard(data: ReportData): string {
  const ratio = data.resurrection.total === 0 ? 0 : data.resurrection.passed / data.resurrection.total;
  const percentage = Math.max(0, Math.min(100, ratio * 100));
  const state = ratio >= 0.9 ? "REVIVED" : "PARTIAL RECONSTRUCTION";
  const fidelity = `${data.resurrection.passed} of ${data.resurrection.total} observed behaviors, ${data.artifact.coverage.branchCoverage.toFixed(2)}% branch coverage of the original`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NECROMANCER report — ${escapeHtml(data.packageName)}@${escapeHtml(data.version)}</title>
<style>
:root { color-scheme: dark; --bg: #101217; --panel: #191d25; --line: #303746; --text: #e7eaf0; --muted: #aab2c0; --accent: #8bd7b1; --warn: #e7c178; }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { max-width: 1000px; margin: 0 auto; padding: 36px 22px 56px; } .tombstone { border: 1px solid var(--line); border-radius: 96px 96px 18px 18px; padding: 32px; background: linear-gradient(145deg, #202632, #151820); text-align: center; }
h1 { margin: 0; font-size: clamp(28px, 5vw, 48px); letter-spacing: .08em; } h2 { margin: 34px 0 12px; font-size: 17px; color: var(--accent); letter-spacing: .06em; } .state { color: var(--accent); font-weight: 700; letter-spacing: .18em; } .fidelity { color: var(--text); font-size: 16px; }
.meter { height: 12px; margin: 16px 0 8px; background: #0c0e12; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; } .meter > span { display: block; width: ${percentage.toFixed(2)}%; height: 100%; background: linear-gradient(90deg, #4f9d79, var(--accent)); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; } .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 18px; } .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; } .value { margin-top: 6px; font-size: 20px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #d9dee8; } .clusters { max-height: 520px; overflow: auto; } .muted { color: var(--muted); } .after { color: var(--accent); } .warning { color: var(--warn); }
</style>
</head>
<body>
<main>
  <header class="tombstone">
    <div class="label">NECROMANCER graveyard report</div>
    <h1>† ${escapeHtml(data.packageName)}</h1>
    <p class="muted">${escapeHtml(data.version)}</p>
    <p class="state">${state}</p>
    <p class="fidelity">${escapeHtml(fidelity)}</p>
    <div class="meter" role="meter" aria-label="Observed behavior reproduction" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage.toFixed(2)}"><span></span></div>
    <p class="muted">${data.resurrection.passed} reproduced behavior records</p>
  </header>

  <h2>Observed fidelity</h2>
  <section class="grid">
    <article class="panel"><div class="label">Original branch coverage</div><div class="value">${data.artifact.coverage.branchCoverage.toFixed(2)}%</div></article>
    <article class="panel"><div class="label">Rebuild rounds</div><div class="value">${data.resurrection.rounds.length}</div></article>
    <article class="panel"><div class="label">CVEs / OSV before</div><div class="value ${data.originalOsv.status === "unknown" ? "warning" : ""}">${escapeHtml(osvText(data.originalOsv))}</div></article>
    <article class="panel"><div class="label">CVEs / OSV after</div><div class="value ${data.rebuiltOsv.status === "unknown" ? "warning" : "after"}">${escapeHtml(rebuiltOsvText(data))}</div></article>
  </section>

  <h2>Source comparison</h2>
  <section class="grid">
    <article class="panel"><div class="label">Original source</div><div class="value">${data.before.loc.toLocaleString()} LOC</div><p class="muted">${data.before.runtimeDependencies} runtime dependencies in the resolved original tree.</p></article>
    <article class="panel"><div class="label">Rebuilt source</div><div class="value after">${data.after.loc.toLocaleString()} LOC</div><p class="muted">${data.after.runtimeDependencies} runtime dependencies in the generated package.</p></article>
  </section>

  <h2>SOUL behavior clusters</h2>
  <section class="panel clusters"><pre>${escapeHtml(clusterText(data.soul))}</pre></section>
</main>
</body>
</html>
`;
}
