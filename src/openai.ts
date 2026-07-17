import { isRecord } from "./json.js";

export const OPENAI_MODEL = "gpt-5.6";

export interface StructuredOutputRequest {
  apiKey: string;
  input: string;
  schemaName: string;
  schema: unknown;
  timeoutMs: number;
  request?: typeof fetch;
}

function outputText(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) if (isRecord(content) && typeof content.text === "string") return content.text;
  }
  return undefined;
}

export async function requestStructuredOutput(options: StructuredOutputRequest): Promise<string> {
  const response = await (options.request ?? fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: options.input,
      text: { format: { type: "json_schema", name: options.schemaName, strict: false, schema: options.schema } }
    }),
    signal: AbortSignal.timeout(options.timeoutMs)
  });
  if (!response.ok) throw new Error(`OpenAI API responded with ${response.status}.`);
  const text = outputText(await response.json());
  if (!text) throw new Error("OpenAI API response had no structured output text.");
  return text;
}
