import "dotenv/config";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { OllamaExtractionProvider } from "../extraction/provider.js";
import { JobStore } from "./store.js";
import { ExtractionWorker } from "./worker.js";

const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 30000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("Invalid LLM_TIMEOUT_MS");
if (process.env.JOBS_ENABLED !== "true") throw new Error("Set JOBS_ENABLED=true for this local lab");
const store = new JobStore(resolve(process.env.JOB_DB_PATH ?? "data/extraction-jobs.sqlite"));
const worker = new ExtractionWorker(store, new OllamaExtractionProvider({
  baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL ?? "qwen3:1.7b",
  think: process.env.OLLAMA_THINK?.replace(/^["']|["']$/g, "").trim() !== "false",
}), timeoutMs);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopping = true; });
console.log(JSON.stringify({ service: "extraction-worker", event: "listening", concurrency: 1 }));
try {
  while (!stopping) {
    if (!await worker.runOnce()) await setTimeout(250);
  }
} finally { store.close(); }
