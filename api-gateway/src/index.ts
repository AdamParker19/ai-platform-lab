import { createApp } from "./app.js";
import { OllamaExtractionProvider } from "./extraction/provider.js";

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const port = positiveInteger("PORT", 3000, 65535);
const timeoutMs = positiveInteger("INFERENCE_TIMEOUT_MS", 3000, 60000);
const llmTimeoutMs = positiveInteger("LLM_TIMEOUT_MS", 30000, 120000);
const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:8000";
if (!["http:", "https:"].includes(new URL(inferenceUrl).protocol)) throw new Error("Invalid INFERENCE_URL");

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen3:1.7b";
const ollamaThink = process.env.OLLAMA_THINK === "false" ? false : true;
const extractionProvider = new OllamaExtractionProvider({
  baseUrl: ollamaBaseUrl,
  model: ollamaModel,
  think: ollamaThink,
});

const server = createApp({
  inferenceUrl,
  timeoutMs,
  extractionProvider,
  llmTimeoutMs,
}).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ service: "api-gateway", event: "listening", port, ollamaModel, ollamaThink }));
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
