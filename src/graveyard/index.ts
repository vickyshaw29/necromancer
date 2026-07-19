import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeArtifactsDirectory } from "../artifacts.js";
import { isRecord } from "../json.js";
import { reconstructionState } from "../report/html.js";

const MAX_ARTIFACT_JSON_BYTES = 4 * 1024 * 1024;

interface ProbeSummary {
  packageName: string;
  version: string;
  behaviorCount: number;
  branchCoverage: number;
  lineCoverage?: number;
  functionCoverage?: number;
}

interface ReconstructionSummary {
  passed: number;
  total: number;
  engine: string;
}

interface CompletedArtifact extends ProbeSummary, ReconstructionSummary {
  directory: string;
  modified: number;
}

interface AwaitingArtifact extends ProbeSummary {
  directory: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function artifactJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const details = await stat(filePath);
    if (!details.isFile() || details.size > MAX_ARTIFACT_JSON_BYTES) return undefined;
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function probeSummary(value: Record<string, unknown>): ProbeSummary | undefined {
  const coverage = value.coverage;
  if (!isRecord(coverage) || typeof value.packageName !== "string" || typeof value.version !== "string" || !Array.isArray(value.behaviors)) return undefined;
  return {
    packageName: value.packageName,
    version: value.version,
    behaviorCount: value.behaviors.length,
    branchCoverage: typeof coverage.branchCoverage === "number" && Number.isFinite(coverage.branchCoverage) ? coverage.branchCoverage : 0,
    lineCoverage: typeof coverage.lineCoverage === "number" && Number.isFinite(coverage.lineCoverage) ? coverage.lineCoverage : undefined,
    functionCoverage: typeof coverage.functionCoverage === "number" && Number.isFinite(coverage.functionCoverage) ? coverage.functionCoverage : undefined
  };
}

function reconstructionSummary(value: Record<string, unknown>): ReconstructionSummary | undefined {
  const passed = finiteCount(value.passed);
  const total = finiteCount(value.total);
  if (passed === undefined || total === undefined || passed > total || typeof value.engine !== "string") return undefined;
  return { passed, total, engine: value.engine };
}

async function scanArtifacts(cacheDirectory: string): Promise<{ completed: CompletedArtifact[]; awaiting: AwaitingArtifact[] }> {
  let entries: Awaited<ReturnType<typeof opendir>>;
  try {
    entries = await opendir(cacheDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { completed: [], awaiting: [] };
    throw error;
  }
  const completed: CompletedArtifact[] = [];
  const awaiting: AwaitingArtifact[] = [];
  for await (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const directory = path.join(cacheDirectory, entry.name);
      const probe = await artifactJson(path.join(directory, "behaviors.json"));
      const observed = probe ? probeSummary(probe) : undefined;
      if (!observed) continue;
      const reconstruction = await artifactJson(path.join(directory, "rebuilt", "result.json"));
      const rebuilt = reconstruction ? reconstructionSummary(reconstruction) : undefined;
      if (!rebuilt) {
        awaiting.push({ directory, ...observed });
        continue;
      }
      const modified = (await stat(directory)).mtimeMs;
      completed.push({ directory, modified, ...observed, ...rebuilt });
    } catch {
      continue;
    }
  }
  completed.sort((left, right) => right.modified - left.modified);
  awaiting.sort((left, right) => `${left.packageName}@${left.version}`.localeCompare(`${right.packageName}@${right.version}`));
  return { completed, awaiting };
}

function relativeReportLink(cacheDirectory: string, artifactDirectory: string): string {
  return path
    .relative(cacheDirectory, path.join(artifactDirectory, "graveyard.html"))
    .split(path.sep)
    .map(encodeURIComponent)
    .join("/");
}

function completedCard(cacheDirectory: string, artifact: CompletedArtifact): string {
  const state = reconstructionState(artifact.passed, artifact.total);
  const report = relativeReportLink(cacheDirectory, artifact.directory);
  const coverage = [
    `branch ${artifact.branchCoverage.toFixed(2)}%`,
    artifact.lineCoverage === undefined ? "line unavailable" : `line ${artifact.lineCoverage.toFixed(2)}%`,
    artifact.functionCoverage === undefined ? "function unavailable" : `function ${artifact.functionCoverage.toFixed(2)}%`
  ].join("; ");
  return `<a class="card" href="${escapeHtml(report)}"><div class="state">${escapeHtml(state)}</div><h2>† ${escapeHtml(artifact.packageName)}@${escapeHtml(artifact.version)}</h2><p>${artifact.passed} of ${artifact.total} observed behaviors</p><p>Coverage: ${coverage} of the original</p><p class="muted">Rebuild engine: ${escapeHtml(artifact.engine)}</p></a>`;
}

function awaitingItem(artifact: AwaitingArtifact): string {
  return `<li><span>† ${escapeHtml(artifact.packageName)}@${escapeHtml(artifact.version)}</span><span>${artifact.behaviorCount} observed behaviors</span></li>`;
}

function renderIndex(cacheDirectory: string, completed: CompletedArtifact[], awaiting: AwaitingArtifact[]): string {
  const cards = completed.length > 0 ? completed.map((artifact) => completedCard(cacheDirectory, artifact)).join("\n") : '<p class="empty">No completed reconstructions were found.</p>';
  const awaitingList = awaiting.length > 0 ? `<ul>${awaiting.map(awaitingItem).join("\n")}</ul>` : '<p class="empty">No probe artifacts are awaiting resurrection.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NECROMANCER graveyard index</title>
<style>
:root { color-scheme: dark; --bg:#101217; --panel:#191d25; --line:#303746; --text:#e7eaf0; --muted:#aab2c0; --accent:#8bd7b1; } * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; } main { max-width:1060px; margin:0 auto; padding:28px 22px 56px; } header { border:1px solid var(--line); border-radius:96px 96px 18px 18px; padding:30px; background:linear-gradient(145deg,#202632,#151820); text-align:center; } h1 { margin:0; font-size:clamp(28px,5vw,48px); letter-spacing:.05em; } h2 { margin:10px 0 8px; font-size:18px; overflow-wrap:anywhere; } p { margin:5px 0; } section { margin-top:34px; } .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px; } .card { display:block; min-height:210px; padding:20px; border:1px solid var(--line); border-radius:18px; background:linear-gradient(145deg,#202632,#151820); color:var(--text); text-decoration:none; transition:border-color .15s ease; } .card:hover { border-color:var(--accent); } .state { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.12em; } .muted,.empty { color:var(--muted); } ul { margin:0; padding:0; list-style:none; border:1px solid var(--line); border-radius:12px; background:var(--panel); } li { display:flex; justify-content:space-between; gap:18px; padding:13px 16px; color:var(--muted); } li + li { border-top:1px solid var(--line); } li span:first-child { color:var(--text); overflow-wrap:anywhere; } @media (max-width:680px) { main { padding:18px 14px 42px; } header { padding:24px 16px; } li { display:block; } }
</style>
</head>
<body>
<main>
<header><div class="state">NECROMANCER local cemetery</div><h1>Graveyard index</h1><p>Local artifacts on this machine — each card links to its full evidence report.</p></header>
<section><div class="cards">${cards}</div></section>
<section><div class="state">Awaiting resurrection</div><h2>Probe artifacts without a completed reconstruction</h2>${awaitingList}</section>
</main>
</body>
</html>
`;
}

export async function writeGraveyardIndex(cache?: string): Promise<string> {
  const cacheDirectory = path.resolve(cache ?? probeArtifactsDirectory());
  const { completed, awaiting } = await scanArtifacts(cacheDirectory);
  await mkdir(cacheDirectory, { recursive: true });
  const indexPath = path.join(cacheDirectory, "graveyard-index.html");
  await writeFile(indexPath, renderIndex(cacheDirectory, completed, awaiting), "utf8");
  return indexPath;
}
