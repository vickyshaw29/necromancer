import { exhume, discardExhumedPackage } from "./src/exhume/index.js";
import { createSandboxRunner } from "./src/sandbox/index.js";

const exhumed = await exhume("left-pad");
const expected = "    x";
let failures = 0;

for (const noDocker of [false, true]) {
  const mode = noDocker ? "child" : "docker";
  const t0 = Date.now();
  const runner = await createSandboxRunner(
    { packagePath: exhumed.packagePath, packageName: exhumed.manifest.name },
    { noDocker, onWarning: () => {} }
  );
  const result = await runner.invoke("left-pad", ["x", 5]);
  const ok = result.ok && result.value === expected && runner.mode === mode;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} [${mode}] runner.mode=${runner.mode} result=${JSON.stringify(result)} (${Date.now() - t0}ms)`
  );
  await runner.dispose();
}

await discardExhumedPackage(exhumed);
process.exit(failures === 0 ? 0 : 1);
