import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadDotEnv(filePath = path.join(process.cwd(), ".env")): Promise<void> {
  try {
    const text = await readFile(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const assignment = line.replace(/^export\s+/, "");
      const separator = assignment.indexOf("=");
      if (separator <= 0) continue;
      const key = assignment.slice(0, separator).trim();
      let value = assignment.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
