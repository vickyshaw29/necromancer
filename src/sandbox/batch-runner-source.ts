/**
 * Trusted outer host for a bounded batch. Each target request still gets its own
 * runner process, so CommonJS caches and target globals cannot leak between cases.
 */
export const BATCH_RUNNER_SOURCE = String.raw`"use strict";

const { spawn } = require("node:child_process");

const RPC_PREFIX = "NECROMANCER_RPC:";
const BATCH_PREFIX = "NECROMANCER_BATCH:";
const MAX_REQUESTS = 8;
const MAX_CHILD_OUTPUT_BYTES = 1_000_000;

function capturedText(capture) {
  return Buffer.concat(capture.chunks, capture.bytes).toString("utf8");
}

function errorShape(error) {
  return { name: "SandboxProcessError", message: error instanceof Error ? error.message : String(error) };
}

function failed(error) {
  return { ok: false, error: errorShape(error), durationMs: 0 };
}

function childResponse(output, nonce) {
  const prefix = RPC_PREFIX + String(nonce || "") + ":";
  const line = output.split(/\r?\n/).filter((candidate) => candidate.startsWith(prefix)).at(-1);
  if (!line) throw new Error("Sandbox child did not return an RPC response.");
  const value = JSON.parse(line.slice(prefix.length));
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean" || typeof value.durationMs !== "number") {
    throw new Error("Sandbox child returned malformed RPC JSON.");
  }
  return value;
}

function invoke(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const stdout = { chunks: [], bytes: 0 };
    const stderr = { chunks: [], bytes: 0 };
    const child = spawn(process.execPath, ["--max-old-space-size=256", "--experimental-loader", "./loader.mjs", "runner.cjs"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
      windowsHide: true
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (capture, chunk) => {
      if (settled) return;
      const nextBytes = capture.bytes + chunk.length;
      if (nextBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(failed(new Error("Sandbox child exceeded the 1 MB output safety limit.")));
        return;
      }
      capture.chunks.push(chunk);
      capture.bytes = nextBytes;
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(failed(new Error("Sandbox child exceeded its " + timeoutMs + " ms time limit.")));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { append(stderr, chunk); });
    child.on("error", (error) => finish(failed(error)));
    child.on("close", (code, signal) => {
      if (settled) return;
      try {
        finish(childResponse(capturedText(stdout), request.nonce));
      } catch (error) {
        const status = signal ? "signal " + signal : "exit code " + code;
        const detail = (capturedText(stderr) || capturedText(stdout)).trim().slice(0, 2_000);
        finish(failed(new Error("Sandbox child exited with " + status + (detail ? ": " + detail : "."))));
      }
    });
    child.stdin.on("error", (error) => finish(failed(error)));
    child.stdin.end(JSON.stringify(request));
  });
}

async function readBatch() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new Error("Sandbox batch request exceeded the 256 KB input safety limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  try {
    const payload = await readBatch();
    if (!payload || !Array.isArray(payload.requests) || payload.requests.length === 0 || payload.requests.length > MAX_REQUESTS) {
      throw new Error("Sandbox batch must contain 1 to " + MAX_REQUESTS + " requests.");
    }
    const timeoutMs = Number.isSafeInteger(payload.timeoutMs) && payload.timeoutMs > 0 ? payload.timeoutMs : 10_000;
    const results = [];
    for (const request of payload.requests) results.push(await invoke(request, timeoutMs));
    process.stdout.write(BATCH_PREFIX + JSON.stringify({ results }) + "\n");
  } catch (error) {
    process.stdout.write(BATCH_PREFIX + JSON.stringify({ error: errorShape(error) }) + "\n");
  }
}

main();
`;
