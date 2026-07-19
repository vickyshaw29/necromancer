import type { ProbeBehavior } from "../probe/index.js";
import { argumentShapeCompleteness, lastRitesValidation, observedArgumentShape } from "./observation.js";
import { integritySummary, unobservedBoundary } from "./provenance.js";
import type { ReportData } from "./types.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderSoulProse(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function soulSection(soul: string, title: string, fallback: string): string {
  const heading = new RegExp(`^## ${title}\\s*$`, "m").exec(soul);
  if (!heading || heading.index === undefined) return fallback;
  const afterHeading = soul.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s+/m.exec(afterHeading);
  return afterHeading.slice(0, nextHeading?.index).trim() || fallback;
}

function renderValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function renderedOutcome(behavior: ProbeBehavior): string {
  if (behavior.throw) return `threw ${behavior.throw.name}: ${renderValue(behavior.throw.message)}`;
  return `returned ${renderValue(behavior.result)}`;
}

interface FeaturedQuirk {
  entry: string;
  evidenceId: string;
  behavior: ProbeBehavior;
}

function featuredQuirk(soul: string, behaviors: ProbeBehavior[]): FeaturedQuirk | undefined {
  const quirks = soulSection(soul, "Quirks", "");
  const entry = quirks.split("\n").find((line) => /^\s*[-*]\s+\S/.test(line));
  if (!entry) return undefined;
  const evidence = /`(behavior-\d+)`|\[(behavior-\d+)/.exec(entry);
  const evidenceId = evidence?.[1] ?? evidence?.[2];
  if (!evidenceId) return undefined;
  const behavior = behaviors.find((candidate) => candidate.id === evidenceId);
  if (!behavior) return undefined;
  return { entry: entry.replace(/^\s*[-*]\s+/, ""), evidenceId, behavior };
}

function advisoryText(result: ReportData["originalOsv"]): string {
  if (result.status === "unknown") return "unknown, OSV unreachable";
  const advisories = result.advisoryCount ?? 0;
  const aliases = result.cveCount ?? 0;
  return `${advisories} published OSV ${advisories === 1 ? "advisory" : "advisories"}${aliases ? `; ${aliases} CVE ${aliases === 1 ? "alias" : "aliases"}` : ""}`;
}

function identifierText(result: ReportData["originalOsv"]): string {
  if (result.status === "unknown") return "";
  const identifiers = result.identifiers ?? [];
  return identifiers.length > 0 ? `; returned identifiers: ${identifiers.join(", ")}` : "";
}

function originalOsvScope(data: ReportData): string {
  return `Scope: original ${data.packageName}@${data.version}, queried at report time${identifierText(data.originalOsv)}. This is published advisory metadata, not source-code analysis.`;
}

function rebuiltOsvText(data: ReportData): string {
  if (data.rebuiltOsv.status === "unknown") return "unknown, OSV unreachable";
  if ((data.rebuiltOsv.advisoryCount ?? 0) === 0) {
    return `no published OSV advisories found across ${data.rebuiltOsv.scannedDependencyCount ?? data.after.runtimeDependencies} declared runtime dependencies`;
  }
  return advisoryText(data.rebuiltOsv);
}

function rebuiltOsvScope(data: ReportData): string {
  const scanned = data.rebuiltOsv.scannedDependencyCount ?? data.after.runtimeDependencies;
  const scope = `Scope: ${scanned} declared rebuild runtime dependencies scanned`;
  const measured = scanned === 0 ? "; no network request was needed" : identifierText(data.rebuiltOsv);
  return `${scope}${measured}. This scan does not analyze generated code or establish CVE remediation.`;
}

export function reconstructionState(passed: number, total: number): string {
  if (total > 0 && passed === 0) return "FAILED RECONSTRUCTION";
  return total > 0 && passed === total ? "REVIVED" : "PARTIAL RECONSTRUCTION";
}

export function renderGraveyard(data: ReportData): string {
  const replay = data.replay === true;
  const ratio = data.resurrection.total === 0 ? 0 : data.resurrection.passed / data.resurrection.total;
  const reproductionPercentage = Math.max(0, Math.min(100, ratio * 100));
  const coverage = data.artifact.coverage.branchCoverage;
  const coveragePercentage = Math.max(0, Math.min(100, coverage));
  const coverageEvidence = `Branch ${coverage.toFixed(2)}% · Line ${data.artifact.coverage.lineCoverage.toFixed(2)}% · Function ${data.artifact.coverage.functionCoverage.toFixed(2)}%`;
  const argumentShape = observedArgumentShape(data.artifact.behaviors);
  const observedArities = argumentShape.arities.length ? argumentShape.arities.join(", ") : "none";
  const argumentEvidence = `Observed arities: ${observedArities}; ${argumentShape.callsWithTwoOrMoreArguments} of ${data.artifact.behaviors.length} calls used 2+ arguments.`;
  const shapeCompleteness = argumentShapeCompleteness(data.artifact);
  const shapeEvidence = shapeCompleteness
    ? shapeCompleteness.measuredFunctions === 0
      ? "No callable exports were recorded; no argument-shape completeness result is claimed."
      : `Argument-shape completeness: ${shapeCompleteness.completeFunctions} of ${shapeCompleteness.measuredFunctions} callable exports covered every required argument-count shape.`
    : "Argument-shape completeness was not recorded; no completeness result is claimed.";
  const heldOut = lastRitesValidation(data.resurrection);
  const heldOutEvidence = heldOut
    ? heldOut.total === 0
      ? "Last Rites recorded no held-out cases; no held-out behavior result is claimed."
      : `${heldOut.passed} of ${heldOut.total} held-out behaviors passed.`
    : "Not recorded; no held-out behavior result is claimed.";
  const state = reconstructionState(data.resurrection.passed, data.resurrection.total);
  const stateLabel = replay
    ? `${state} — FIXTURE ONLY`
    : state === "REVIVED" && heldOut && heldOut.total > 0 && heldOut.passed < heldOut.total
      ? "OBSERVED SUITE REVIVED — HELD-OUT DIFFERENCES"
      : state;
  const fidelity = `${data.resurrection.passed} of ${data.resurrection.total} observed behaviors, ${coverage.toFixed(2)}% branch coverage of the original`;
  const observedEvidence = `${data.resurrection.passed} of ${data.resurrection.total} observed behaviors reproduced`;
  const boundary = unobservedBoundary(data.artifact.coverage);
  const quirk = featuredQuirk(data.soul, data.artifact.behaviors);
  const clusters = soulSection(data.soul, "Behavioral clusters", "No behavioral clusters were available.");
  const quirks = soulSection(data.soul, "Quirks", "No quirks were available.");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NECROMANCER report — ${escapeHtml(data.packageName)}@${escapeHtml(data.version)}</title>
<style>
:root { color-scheme: dark; --bg: #101217; --panel: #191d25; --panel-raised: #202632; --line: #303746; --text: #e7eaf0; --muted: #aab2c0; --accent: #8bd7b1; --accent-deep: #4f9d79; --violet: #a99be8; --warn: #e7c178; }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { max-width: 1060px; margin: 0 auto; padding: 28px 22px 56px; } .tombstone { border: 1px solid var(--line); border-radius: 96px 96px 18px 18px; padding: 30px; background: linear-gradient(145deg, #202632, #151820); text-align: center; }
h1 { margin: 0; font-size: clamp(28px, 5vw, 48px); letter-spacing: .05em; overflow-wrap: anywhere; } h2 { margin: 34px 0 12px; font-size: 17px; color: var(--accent); letter-spacing: .06em; } p { margin: 8px 0 0; } ul { margin: 10px 0 0; padding-left: 20px; } .state { color: var(--accent); font-weight: 700; letter-spacing: .18em; } .fidelity { color: var(--text); font-size: 16px; }
.receipt { margin-top: 14px; display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(260px, .8fr); gap: 14px; } .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 18px; } .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; } .value { margin-top: 6px; font-size: 20px; overflow-wrap: anywhere; } .muted { color: var(--muted); } .after { color: var(--accent); } .warning { color: var(--warn); }
.evidence { min-height: 164px; } .observed-card { background: linear-gradient(140deg, #1d2a2a, var(--panel)); } .reproduction-meter { height: 13px; margin-top: 28px; background: #0c0e12; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; } .reproduction-meter > span { display: block; width: ${reproductionPercentage.toFixed(2)}%; height: 100%; background: linear-gradient(90deg, var(--accent-deep), var(--accent)); }
.coverage-card { display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center; gap: 14px; background: linear-gradient(140deg, #242139, var(--panel)); } .coverage-gauge { width: 84px; aspect-ratio: 1; border-radius: 50%; background: conic-gradient(var(--violet) ${coveragePercentage.toFixed(2)}%, #101217 0); display: grid; place-items: center; } .coverage-gauge::after { content: ""; width: 62px; height: 62px; border-radius: 50%; background: var(--panel); border: 1px solid var(--line); }
.boundary-card { grid-column: 1 / -1; border-left: 3px solid var(--warn); background: #211f19; color: #f0dfb8; } .receipt-meta { grid-column: 1 / -1; display: flex; align-items: baseline; justify-content: space-between; gap: 16px; background: var(--panel-raised); } a { color: var(--accent); }
.quarantine { margin-top: 14px; border-color: #4d5360; background: linear-gradient(135deg, #181c25, #14161c); } .quarantine strong { color: var(--accent); } .featured { margin-top: 14px; border-color: #544b80; background: linear-gradient(135deg, #211f32, var(--panel)); } .featured-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 14px; } .featured-grid .label { font-size: 11px; } .featured-grid code { display: block; margin-top: 4px; color: #ddd8ff; overflow-wrap: anywhere; white-space: pre-wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; } pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #d9dee8; } .clusters { max-height: 520px; overflow: auto; }
@media (max-width: 680px) { main { padding: 18px 14px 42px; } .tombstone { padding: 24px 16px; } .receipt { grid-template-columns: 1fr; } .coverage-card { min-height: 140px; } .receipt-meta { display: block; } .featured-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header class="tombstone">
    <div class="label">${replay ? "NECROMANCER report UX replay" : "NECROMANCER resurrection receipt"}</div>
    <h1>† ${escapeHtml(data.packageName)}@${escapeHtml(data.version)}</h1>
    <p class="state">${stateLabel}</p>
    <p class="fidelity">${escapeHtml(fidelity)}</p>
  </header>

  ${replay ? `<article class="panel boundary-card" data-evidence="replay-boundary"><div class="label">Offline report UX replay</div><div class="value">This fixed fixture was rendered locally by NECROMANCER. It did not fetch, execute, rebuild, or assess a package; its values are not reconstruction evidence.</div></article>` : ""}

  <section class="receipt" aria-label="Resurrection evidence">
    <article class="panel evidence observed-card" data-evidence="observed-suite">
      <div class="label">Recorded-suite evidence</div>
      <div class="value">${escapeHtml(observedEvidence)}</div>
      <div class="reproduction-meter" role="meter" aria-label="Observed behavior reproduction" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${reproductionPercentage.toFixed(2)}"><span></span></div>
    </article>
    <article class="panel evidence coverage-card" data-evidence="original-coverage">
      <div class="coverage-gauge" aria-hidden="true"></div>
      <div><div class="label">Original-code coverage observed during probing</div><div class="value">${escapeHtml(coverageEvidence)}</div><p class="muted">Coverage is not a security score or a claim about unobserved behavior.</p></div>
    </article>
    <article class="panel boundary-card" data-evidence="unobserved-boundary"><div class="label">Unobserved boundary</div><div class="value">${escapeHtml(boundary.uncoveredBranchStatement)}</div></article>
    <article class="panel receipt-meta"><div class="label">Rebuild engine used</div><div class="value">${escapeHtml(data.resurrection.engine)}</div></article>
    <article class="panel receipt-meta"><div class="label">Provenance</div><div class="value"><a href="rebuilt/provenance.json">provenance.json</a> — ${escapeHtml(integritySummary(data.provenance))}</div></article>
  </section>

  <article class="panel quarantine">
    <div class="label">Source quarantine</div>
    <p>The rebuild engine received only:</p>
    <ul>
      <li>the SOUL</li>
      <li>the characterization suite</li>
      <li>the public API shape</li>
      <li>failing observations</li>
    </ul>
    <p><strong>Original source was withheld.</strong></p>
  </article>

  <article class="panel boundary-card" data-evidence="compatibility-security-boundary">
    <div class="label">Compatibility / security boundary</div>
    <div class="value">A passing recorded suite shows only observed compatibility. It does not prove security, vulnerability remediation, equivalence, or production safety.</div>
  </article>

  <article class="panel featured">
    <div class="label">Featured recorded quirk</div>
    ${quirk ? `<p>${renderSoulProse(quirk.entry)}</p>
    <div class="featured-grid">
      <div><div class="label">Evidence ID</div><code>${escapeHtml(quirk.evidenceId)}</code></div>
      <div><div class="label">Input</div><code>${escapeHtml(renderValue(quirk.behavior.args))}</code></div>
      <div><div class="label">Recorded output / throw</div><code>${escapeHtml(renderedOutcome(quirk.behavior))}</code></div>
    </div>` : `<div class="value">No quirk was recorded</div>`}
  </article>

  <h2>Observed fidelity</h2>
  <section class="grid">
    <article class="panel"><div class="label">Rebuild rounds</div><div class="value">${data.resurrection.rounds.length}</div></article>
    <article class="panel"><div class="label">Observed argument shapes</div><div class="value">${escapeHtml(argumentEvidence)}</div><p class="muted">${escapeHtml(shapeEvidence)}</p><p class="muted">A missing arity or input shape is outside the compatibility claim.</p></article>
    <article class="panel"><div class="label">Held-out behavior check</div><div class="value">${escapeHtml(heldOutEvidence)}</div></article>
    <article class="panel"><div class="label">Published advisory scan — original</div><div class="value ${data.originalOsv.status === "unknown" ? "warning" : ""}">${escapeHtml(advisoryText(data.originalOsv))}</div><p class="muted">${escapeHtml(originalOsvScope(data))}</p></article>
    <article class="panel"><div class="label">Declared-dependency advisory scan — rebuild</div><div class="value ${data.rebuiltOsv.status === "unknown" ? "warning" : "after"}">${escapeHtml(rebuiltOsvText(data))}</div><p class="muted">${escapeHtml(rebuiltOsvScope(data))}</p></article>
  </section>

  <h2>Source comparison</h2>
  <section class="grid">
    <article class="panel"><div class="label">Original source</div><div class="value">${data.before.loc.toLocaleString()} LOC</div><p class="muted">${data.before.runtimeDependencies} runtime dependencies in the resolved original tree.</p></article>
    <article class="panel"><div class="label">Rebuilt source</div><div class="value after">${data.after.loc.toLocaleString()} LOC</div><p class="muted">${data.after.runtimeDependencies} runtime dependencies in the generated package.</p></article>
  </section>

  <h2>SOUL behavior clusters</h2>
  <section class="panel clusters"><pre>${escapeHtml(clusters)}</pre></section>

  <h2>SOUL quirks</h2>
  <section class="panel clusters"><pre>${escapeHtml(quirks)}</pre></section>
</main>
</body>
</html>
`;
}
