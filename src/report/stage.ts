import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderGraveyard } from "./html.js";
import { rebuiltMetrics } from "./metrics.js";
import { queryOsv } from "./osv.js";
import { OsvAdvisoryResult, ReportData, ReportInput, ReportResult } from "./types.js";

const MAX_SOUL_CHARS = 96_000;

async function readSoul(filePath: string): Promise<string> {
  let text = "";
  const stream = createReadStream(filePath, { encoding: "utf8" });
  try {
    for await (const chunk of stream) {
      if (text.length >= MAX_SOUL_CHARS) break;
      text += chunk.slice(0, MAX_SOUL_CHARS - text.length);
    }
  } finally {
    stream.destroy();
  }
  return text.length >= MAX_SOUL_CHARS ? `${text}\n\n[Truncated at ${MAX_SOUL_CHARS} characters.]` : text;
}

export interface ReportOptions {
  osvQuery?: (packageName: string, version: string) => Promise<OsvAdvisoryResult>;
}

export async function createReport(input: ReportInput, options: ReportOptions = {}): Promise<ReportResult> {
  const rebuiltDirectory = path.join(input.artifactDirectory, "rebuilt");
  const [after, soul, osv] = await Promise.all([
    rebuiltMetrics(rebuiltDirectory),
    readSoul(path.join(input.artifactDirectory, "SOUL.md")),
    (options.osvQuery ?? queryOsv)(input.packageName, input.version)
  ]);
  const data: ReportData = {
    packageName: input.packageName,
    version: input.version,
    artifact: input.artifact,
    resurrection: input.resurrection,
    before: { loc: input.triage.loc, runtimeDependencies: input.triage.runtimeDependencyCount },
    after,
    osv,
    soul
  };
  await mkdir(input.artifactDirectory, { recursive: true });
  const reportPath = path.join(input.artifactDirectory, "graveyard.html");
  await writeFile(reportPath, renderGraveyard(data), "utf8");
  return { reportPath, data };
}
