import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { findLatestProbeArtifactForPackage, parsePackageSpecifier } from "../artifacts.js";
import { isRecord } from "../json.js";
import { sha256File } from "../report/provenance.js";
import { runCharacterization } from "../resurrect/test-runner.js";
import type { CharacterizationResult } from "../resurrect/types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;

export interface VerifyOptions {
  artifact?: string;
  /** Explicitly run local suites with reduced isolation from a disposable VM. */
  noDocker?: boolean;
}

export interface VerificationReceipt {
  exitCode: 0 | 1 | 2;
  lines: string[];
  artifactDirectory?: string;
}

interface AttestedFile {
  path: string;
  sha256: string;
}

interface ProvenanceAttestation {
  soulSha256: string | undefined;
  soulTestSha256: string | undefined;
  authoredSourceFiles: AttestedFile[] | undefined;
}

async function readable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readProvenance(artifactDirectory: string): Promise<Record<string, unknown> | undefined> {
  const provenancePath = path.join(artifactDirectory, "rebuilt", "provenance.json");
  if (!(await readable(provenancePath))) return undefined;
  try {
    if ((await stat(provenancePath)).size > MAX_PROVENANCE_BYTES) return {};
    const value: unknown = JSON.parse(await readFile(provenancePath, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function hash(value: unknown): string | undefined {
  return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function attestedFiles(value: unknown): AttestedFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: AttestedFile[] = [];
  for (const entry of value) {
    const sha256 = isRecord(entry) ? hash(entry.sha256) : undefined;
    if (!isRecord(entry) || typeof entry.path !== "string" || !sha256) return undefined;
    files.push({ path: entry.path, sha256 });
  }
  return files;
}

function attestation(value: Record<string, unknown>): ProvenanceAttestation {
  const distillation = isRecord(value.distillation) ? value.distillation : undefined;
  const resurrection = isRecord(value.resurrection) ? value.resurrection : undefined;
  return {
    soulSha256: hash(distillation?.soulSha256),
    soulTestSha256: hash(distillation?.soulTestSha256),
    authoredSourceFiles: attestedFiles(resurrection?.authoredSourceFiles)
  };
}

function sourcePath(rebuiltDirectory: string, source: string): string | undefined {
  const normalized = path.normalize(source);
  if (path.isAbsolute(source) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return undefined;
  return path.join(rebuiltDirectory, normalized);
}

async function hashLine(label: string, filePath: string | undefined, expected: string | undefined): Promise<{ line: string; passed: boolean }> {
  if (!expected) return { line: `${label} sha256 ✗ attestation is missing or invalid`, passed: false };
  if (!filePath) return { line: `${label} sha256 ✗ attested path is outside rebuilt/`, passed: false };
  try {
    const actual = await sha256File(filePath);
    return actual === expected
      ? { line: `${label} sha256 ✓ matches attestation`, passed: true }
      : { line: `${label} sha256 ✗ does not match attestation`, passed: false };
  } catch {
    return { line: `${label} sha256 ✗ file is unavailable`, passed: false };
  }
}

async function suiteLine(target: "original" | "rebuilt", artifactDirectory: string, noDocker: boolean): Promise<{ line: string; passed: boolean }> {
  try {
    const result: CharacterizationResult = await runCharacterization(artifactDirectory, {
      implementation: target,
      offline: true,
      readOnly: true,
      ...(noDocker ? { allowReducedIsolation: true, noDocker: true } : {})
    });
    const passed = result.passed === result.total;
    return { line: `observed suite vs ${target}: ${passed ? "✓" : "✗"} ${result.passed} of ${result.total}`, passed };
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : "suite could not be measured";
    return { line: `observed suite vs ${target}: ✗ ${detail}`, passed: false };
  }
}

function notReverifiedLines(): string[] {
  return [
    "Not re-verified: registry tarball hash (no network in verify)",
    "Not re-verified: OSV advisory data (recorded at report time; not re-queried)"
  ];
}

export async function verifyArtifact(artifactDirectory: string, options: VerifyOptions = {}): Promise<VerificationReceipt> {
  const resolvedDirectory = path.resolve(artifactDirectory);
  const provenance = await readProvenance(resolvedDirectory);
  if (!provenance) {
    return {
      exitCode: 2,
      lines: [`No provenance.json exists in ${resolvedDirectory}. Run necromancer resurrect <pkg> before verification.`],
      artifactDirectory: resolvedDirectory
    };
  }
  const recorded = attestation(provenance);
  const rebuiltDirectory = path.join(resolvedDirectory, "rebuilt");
  const hashes = [
    await hashLine("SOUL.md", path.join(resolvedDirectory, "SOUL.md"), recorded.soulSha256),
    await hashLine("soul.test.ts", path.join(resolvedDirectory, "soul.test.ts"), recorded.soulTestSha256)
  ];
  if (!recorded.authoredSourceFiles) {
    hashes.push(await hashLine("rebuilt/(source list)", undefined, undefined));
  } else {
    for (const source of recorded.authoredSourceFiles) {
      hashes.push(await hashLine(`rebuilt/${source.path}`, sourcePath(rebuiltDirectory, source.path), source.sha256));
    }
  }
  const original = await suiteLine("original", resolvedDirectory, options.noDocker === true);
  const rebuilt = await suiteLine("rebuilt", resolvedDirectory, options.noDocker === true);
  const passed = [...hashes, original, rebuilt].every((check) => check.passed);
  return {
    exitCode: passed ? 0 : 1,
    lines: [
      `Verification receipt — ${resolvedDirectory}`,
      ...hashes.map((check) => check.line),
      original.line,
      rebuilt.line,
      ...notReverifiedLines(),
      passed ? "All performed checks passed." : "One or more performed checks failed."
    ],
    artifactDirectory: resolvedDirectory
  };
}

export async function verifyPackage(pkg: string, options: VerifyOptions = {}): Promise<VerificationReceipt> {
  const requested = parsePackageSpecifier(pkg);
  const artifactDirectory = options.artifact ? path.resolve(options.artifact) : await findLatestProbeArtifactForPackage(requested.packageName, requested.version);
  if (!artifactDirectory || !(await readable(artifactDirectory))) {
    return {
      exitCode: 2,
      lines: [`No artifact found for ${pkg}. Run necromancer probe ${pkg} first or pass --artifact <directory>.`]
    };
  }
  return verifyArtifact(artifactDirectory, options);
}

export async function runVerifyCommand(pkg: string, options: VerifyOptions): Promise<void> {
  const receipt = await verifyPackage(pkg, options);
  const output = receipt.exitCode === 2 ? console.error : console.log;
  for (const line of receipt.lines) output(line);
  process.exitCode = receipt.exitCode;
}
