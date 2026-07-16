import { readFile } from "node:fs/promises";
import https from "https";

export async function readRemote(path) {
  return [readFile, https, path];
}
