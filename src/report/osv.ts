import { isRecord } from "../json.js";
import { DeclaredRuntimeDependency, OsvAdvisoryResult } from "./types.js";

const OSV_QUERY_URL = "https://api.osv.dev/v1/query";

function parseOsv(value: unknown): OsvAdvisoryResult {
  if (!isRecord(value) || !Array.isArray(value.vulns)) return { status: "known", advisoryCount: 0, cveCount: 0, identifiers: [] };
  const cves = new Set<string>();
  const identifiers = new Set<string>();
  let advisoryCount = 0;
  for (const vulnerability of value.vulns) {
    if (!isRecord(vulnerability)) continue;
    advisoryCount += 1;
    if (typeof vulnerability.id === "string") identifiers.add(vulnerability.id);
    const aliases = Array.isArray(vulnerability.aliases) ? vulnerability.aliases : [];
    for (const alias of aliases) {
      if (typeof alias === "string" && /^CVE-\d{4}-\d+$/i.test(alias)) {
        cves.add(alias.toUpperCase());
        identifiers.add(alias);
      }
    }
  }
  return { status: "known", advisoryCount, cveCount: cves.size, identifiers: [...identifiers] };
}

export async function queryOsv(packageName: string, version: string, request: typeof fetch = fetch): Promise<OsvAdvisoryResult> {
  try {
    const response = await request(OSV_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ package: { ecosystem: "npm", name: packageName }, version }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return { status: "unknown", detail: "OSV unreachable" };
    return parseOsv(await response.json());
  } catch {
    return { status: "unknown", detail: "OSV unreachable" };
  }
}

export type OsvQuery = (packageName: string, version: string) => Promise<OsvAdvisoryResult>;

export async function queryOsvDependencies(
  dependencies: DeclaredRuntimeDependency[],
  query: OsvQuery = queryOsv
): Promise<OsvAdvisoryResult> {
  if (dependencies.length === 0) {
    return { status: "known", advisoryCount: 0, cveCount: 0, identifiers: [], scannedDependencyCount: 0 };
  }
  const results = await Promise.all(dependencies.map(({ name, version }) => query(name, version)));
  if (results.some((result) => result.status === "unknown")) {
    return { status: "unknown", detail: "OSV unreachable", scannedDependencyCount: dependencies.length };
  }
  const identifiers = new Set(results.flatMap((result) => result.identifiers ?? []));
  return {
    status: "known",
    advisoryCount: results.reduce((count, result) => count + (result.advisoryCount ?? 0), 0),
    cveCount: results.reduce((count, result) => count + (result.cveCount ?? 0), 0),
    identifiers: [...identifiers],
    scannedDependencyCount: dependencies.length
  };
}
