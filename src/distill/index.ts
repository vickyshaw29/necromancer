import { generateSoul } from "./engines.js";
import { normalizeSoul } from "./soul.js";
import { stageOriginalPackage, writeDistillWorkspace } from "./stage.js";
import { renderSoulTest } from "./test-template.js";
import { DistillOptions, DistillResult, ProbeArtifact } from "./types.js";

export * from "./artifact.js";
export * from "./engines.js";
export * from "./soul.js";
export * from "./test-template.js";
export * from "./types.js";

export async function distillArtifact(
  artifact: ProbeArtifact,
  packagePath: string,
  artifactDirectory: string,
  options: DistillOptions = {}
): Promise<DistillResult> {
  const originalPath = await stageOriginalPackage(packagePath, artifactDirectory);
  const request = { packageName: artifact.packageName, behaviors: artifact.behaviors, coverage: artifact.coverage };
  const generated = await generateSoul({ preference: options.engine, request, onNotice: options.onNotice });
  const soul = normalizeSoul(generated.soul);
  if (!soul) throw new Error("The selected DISTILL engine returned an empty SOUL document.");
  const output = await writeDistillWorkspace(artifactDirectory, soul, renderSoulTest(artifact, options.onNotice ?? (() => undefined)));
  return { engine: generated.engine, originalPath, ...output };
}
