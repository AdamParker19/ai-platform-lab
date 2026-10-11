import "dotenv/config";
import { createApp } from "../src/app.js";
import { OllamaExtractionProvider, EXTRACTION_SYSTEM_PROMPT } from "../src/extraction/provider.js";
import { extractionSchema, type ExtractionResult } from "../src/extraction/schema.js";
import { loadDataset } from "./dataset.js";
import { quality, fieldScores } from "./evaluation.js";
import { markdownReport } from "./report.js";
import { execFileSync } from "node:child_process";
import { sameExtraction, summarize, hasFailures, type EvaluationRow } from "./evaluation.js";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Server } from "node:http";


function options() {
  const values = new Map<string, string>();
  const allowed = ["--runs", "--timeout-ms", "--thinking", "--warmup", "--output", "--split", "--seed", "--temperature"];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || value.startsWith("--") || values.has(key)) {
      throw new Error(`Invalid arguments. Supported: ${allowed.join(", ")}`);
    }
    values.set(key, value);
  }
  const integer = (key: string, fallback: string, min: number, max: number) => {
    const n = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be ${min}–${max}`);
    return n;
  };
  const thinking = values.get("--thinking") ?? "both";
  if (!["both", "on", "off"].includes(thinking)) throw new Error("--thinking must be both, on, or off");
  const modes = thinking === "both" ? [false, true] : [thinking === "on"];
  const split = values.get("--split") ?? "development";
  if (split !== "development" && split !== "holdout" && split !== "all") throw new Error("Invalid --split");
  const temperature = Number(values.get("--temperature") ?? "0");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("Invalid --temperature");
  return {
    split, temperature, seed: integer("--seed", "42", 0, 2147483647),
    runs: integer("--runs", "5", 1, 100),
    timeoutMs: integer("--timeout-ms", process.env.LLM_TIMEOUT_MS ?? "30000", 1, 120000),
    warmup: integer("--warmup", "1", 0, 3),
    modes,
    output: resolve(values.get("--output") ?? `evaluation-results/extraction-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
  };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}

async function attempt(url: string, doc: Awaited<ReturnType<typeof loadDataset>>["documents"][number], thinking: boolean, run: number, timeoutMs: number): Promise<EvaluationRow> {
  const start = performance.now();
  const signal = AbortSignal.timeout(timeoutMs + 2000);
  const row: EvaluationRow = {
    documentId: doc.id, category: doc.category, split: doc.split, thinking, run, expected: doc.expected, actual: null,
    outcome: "provider_error", latencyMs: 0, httpStatus: null, requestId: null,
  };
  try {
    const response = await fetch(`${url}/api/extract`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: doc.raw }), signal,
    });
    row.httpStatus = response.status;
    row.requestId = response.headers.get("x-request-id");
    const body: unknown = await response.json();
    if (response.status === 504) row.outcome = "timeout";
    else if (response.status !== 200) {
      row.outcome = response.status === 502 && body && typeof body === "object" &&
        "error" in body && body.error === "Invalid model response" ? "invalid_response" : "provider_error";
    } else {
      row.actual = body;
      const parsed = extractionSchema.safeParse(body);
      row.outcome = !parsed.success ? "invalid_response" : sameExtraction(parsed.data, doc.expected) ? "correct" : "incorrect";
    }
  } catch {
    row.outcome = signal.aborted ? "timeout" : row.httpStatus === 200 ? "invalid_response" : "provider_error";
  }
  row.latencyMs = Math.round(performance.now() - start);
  return row;
}

async function main() {
  const config = options();
  const dataset = await loadDataset(config.split);
  const documents = dataset.documents;
  let codeRevision: string | null = null;
  try { codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* source archive */ }
  const observations: { thinking: boolean; before: Awaited<ReturnType<OllamaExtractionProvider["describe"]>>; after: Awaited<ReturnType<OllamaExtractionProvider["describe"]>> }[] = [];
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const parsedUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("OLLAMA_BASE_URL must be an HTTP(S) URL without embedded credentials");
  }
  const model = process.env.OLLAMA_MODEL ?? "qwen3:1.7b";
  if (model.toLowerCase().includes("cloud")) throw new Error("Use a local model for this lab");
  const startedAt = new Date().toISOString();
  const rows: EvaluationRow[] = [];
  const warmupRows: EvaluationRow[] = [];
  console.log(`Evaluating ${model}: ${documents.length} documents × ${config.runs} runs × ${config.modes.length} modes`);
  console.log(`Deadline: ${config.timeoutMs}ms. Uses local Ollama; AWS is not contacted.`);
  for (const thinking of config.modes) {
    const provider = new OllamaExtractionProvider({ baseUrl, model, think: thinking, temperature: config.temperature, seed: config.seed });
    const before = await provider.describe();
    const server = createApp({ inferenceUrl: "http://127.0.0.1:9999", timeoutMs: 1000, extractionProvider: provider, llmTimeoutMs: config.timeoutMs }).listen(0, "127.0.0.1");
    try {
      if (!server.listening) await once(server, "listening");
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Gateway failed to start");
      const url = `http://127.0.0.1:${addr.port}`;
      for (let run = 1; run <= config.warmup; run++) {
        const row = await attempt(url, documents[0]!, thinking, run, config.timeoutMs);
        warmupRows.push(row);
        console.log(`Warm-up thinking=${thinking}: ${row.outcome} (${row.latencyMs}ms), excluded from measured summary`);
      }
      // Rotate document order between rounds to reduce fixed-position effects.
      for (let run = 1; run <= config.runs; run++) {
        for (let offset = 0; offset < documents.length; offset++) {
          const doc = documents[(offset + run - 1) % documents.length]!;
          const row = await attempt(url, doc, thinking, run, config.timeoutMs);
          rows.push(row);
          console.log(`thinking=${thinking} run=${run} ${doc.id}: ${row.outcome} (${row.latencyMs}ms)`);
        }
      }
    } finally { await close(server); }
    observations.push({ thinking, before, after: await provider.describe() });
  }
  const summary = config.modes.map(thinking => ({ thinking, ...summarize(rows.filter(row => row.thinking === thinking)), ...quality(rows.filter(row => row.thinking === thinking)) }));
  const modelIdentityConsistent = observations.length > 0 && observations.every(o =>
    o.before.modelDigest !== null && o.before.modelDigest === o.after.modelDigest &&
    o.before.modelDigest === observations[0]!.before.modelDigest);
  const grouped = ["development", "holdout"].flatMap(split =>
    config.modes.map(thinking => {
      const selected = rows.filter(r => r.split === split && r.thinking === thinking);
      return { split, thinking, ...summarize(selected), ...quality(selected) };
    }).filter(group => group.attempts > 0));
  const report = {
    reportVersion: 2, startedAt, completedAt: new Date().toISOString(), model, codeRevision,
    dataset: { version: dataset.version, sha256: dataset.sha256, split: config.split, annotationPolicy: dataset.annotationPolicy },
    modelIdentityConsistent, observations, grouped,
    promptSha256: createHash("sha256").update(EXTRACTION_SYSTEM_PROMPT).digest("hex"),
    configuration: { runs: config.runs, timeoutMs: config.timeoutMs, modes: config.modes, warmup: config.warmup, seed: config.seed, temperature: config.temperature },
    scope: "Small synthetic dataset. Holdout is a candidate evaluation split, not independently blind data. Alpine appears in the prompt. Exact-match field scoring; failures count as zero. Digest snapshots detect observed tag changes but cannot prove weights used during every call. Fixed seed does not guarantee reproducibility across runtimes.",
    passed: !hasFailures(rows) && modelIdentityConsistent, summary, warmupRows,
    fixtures: documents, results: rows.map(row => ({ ...row, fields: fieldScores(row) })),
  };
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, JSON.stringify(report, null, 2) + "\n", "utf8");
  const markdownPath = config.output.replace(/\.json$/i, "") + ".md";
  await writeFile(markdownPath, markdownReport(report), "utf8");
  console.table(summary.map(({ perField, ...row }) => row));
  console.log(`Report saved: ${config.output}`);
  console.log(report.passed ? "PASS: all measured extractions correct" : "FAIL: extraction failure or unavailable/changed model identity; inspect report");
  process.exitCode = report.passed ? 0 : 1;
}

main().catch(() => {
  console.error("Evaluation could not complete. Check CLI arguments, Ollama URL, and report destination. See scripts/verify-live.ts and docs/extraction-evaluation.md for usage.");
  process.exitCode = 1;
});
