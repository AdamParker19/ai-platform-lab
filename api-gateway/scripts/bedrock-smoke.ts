import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BedrockExtractionProvider, BedrockExtractionError, type BedrockTelemetry, type ConverseSender } from "../src/extraction/bedrock.js";
import { Extractor, ExtractionValidationError } from "../src/extraction/extractor.js";
import { sha256 } from "../src/extraction/provenance.js";
import { parsePromptVariant } from "../src/extraction/prompts.js";
import { smokeCases } from "./bedrock-cases.js";

export function parseSmokeOptions(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const values = new Map<string, string>();
  let live = false;
  const allowed = ["--output", "--input-usd-per-million", "--output-usd-per-million"];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--live" && !live) { live = true; continue; }
    const value = args[++i];
    if (!allowed.includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid smoke arguments");
    values.set(key, value);
  }
  const price = (key: string) => {
    const raw = values.get(key);
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
    return value;
  };
  const inputPrice = price("--input-usd-per-million"), outputPrice = price("--output-usd-per-million");
  if (live && (inputPrice === null || outputPrice === null)) throw new Error("Live mode requires both current token prices; review AWS pricing first");
  const modelId = live ? env.BEDROCK_MODEL_ID?.trim() : "offline-simulated-model";
  if (!modelId) throw new Error("Set BEDROCK_MODEL_ID to an available Converse model or inference profile");
  const promptVariant = parsePromptVariant(env.BEDROCK_PROMPT_VARIANT ?? "evidence-v2");
  const region = env.BEDROCK_REGION ?? env.AWS_REGION ?? "ap-south-1";
  return { live, modelId, region, promptVariant, inputPrice, outputPrice,
    output: resolve(values.get("--output") ?? `evaluation-results/bedrock-${live ? "live" : "offline"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`) };
}
export type SmokeOptions = ReturnType<typeof parseSmokeOptions>;

export function estimateCost(telemetry: BedrockTelemetry | undefined, inputPrice: number | null, outputPrice: number | null): number | null {
  if (!telemetry || telemetry.inputTokens === null || telemetry.outputTokens === null || inputPrice === null || outputPrice === null) return null;
  return (telemetry.inputTokens * inputPrice + telemetry.outputTokens * outputPrice) / 1_000_000;
}

export const offlineSender: ConverseSender = async command => {
  const text = command.input.messages?.[0]?.content?.[0]?.text;
  const fixture = smokeCases.find(c => text === `<document>\n${c.document}\n</document>`);
  if (!fixture) throw new Error("Unknown offline fixture");
  return { $metadata: {}, stopReason: "end_turn",
    output: { message: { role: "assistant", content: [{ text: JSON.stringify(fixture.offlineResponse) }] } } };
};

export async function runSmoke(config: SmokeOptions, send?: ConverseSender) {
  // A test can inject a sender; offline mode always injects one. No warm-up calls.
  const observations: BedrockTelemetry[] = [];
  const provider = new BedrockExtractionProvider({ modelId: config.modelId, region: config.region, promptVariant: config.promptVariant,
    maxOutputTokens: 256, timeoutMs: 30000, send: send ?? (config.live ? undefined : offlineSender),
    onTelemetry: event => observations.push(event) });
  const extractor = new Extractor(provider);
  const rows = [];
  const startedAt = new Date().toISOString();
  let codeRevision: string | null = null;
  let workingTreeDirty: boolean | null = null;
  try { codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* source archive */ }
  try { workingTreeDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0; } catch { /* source archive */ }
  for (const fixture of smokeCases) {
    const requestId = randomUUID();
    let result: Awaited<ReturnType<Extractor["extractWithGrounding"]>> | null = null;
    let errorCategory: string | null = null;
    try { result = await extractor.extractWithGrounding(fixture.document, { requestId }); }
    catch (error) {
      errorCategory = error instanceof BedrockExtractionError ? error.category
        : error instanceof ExtractionValidationError ? "invalid_response" : "provider_error";
    }
    const telemetry = observations.find(o => o.requestId === requestId);
    rows.push({ caseId: fixture.id, requestId, expected: fixture.expected, actual: result?.extraction ?? null,
      grounding: result?.grounding ?? null, supplierVerified: result?.grounding.status === "verified",
      outcome: errorCategory ?? result!.grounding.status, errorCategory,
      exactMatch: result ? isDeepStrictEqual(result.extraction, fixture.expected) : false,
      telemetry: telemetry ?? null, estimatedCostUsd: config.live ? estimateCost(telemetry, config.inputPrice, config.outputPrice) : null });
    // Stop on transport/permission failures; never retry or fall back to another provider.
    if (errorCategory && errorCategory !== "invalid_response") break;
  }
  const complete = rows.length === smokeCases.length;
  const estimates = rows.map(r => r.estimatedCostUsd);
  const report = {
    reportVersion: 1, mode: config.live ? "live" : "offline", startedAt, completedAt: new Date().toISOString(), codeRevision, workingTreeDirty,
    dataset: { version: "bedrock-smoke-v1", sha256: sha256(JSON.stringify(smokeCases.map(({ id, document, expected }) => ({ id, document, expected })))) },
    provenance: provider.metadata(), region: config.region,
    configuration: { plannedCalls: 5, maxAttemptsPerCall: 1, maxOutputTokens: 256, timeoutMs: 30000, warmupCalls: 0 },
    pricing: config.live ? { currency: "USD", inputUsdPerMillionTokens: config.inputPrice, outputUsdPerMillionTokens: config.outputPrice, source: "operator-supplied current rates; token-only estimate, not an AWS bill or spending cap" } : null,
    summary: { attemptedCases: rows.length, complete, schemaValidCases: rows.filter(r => r.actual !== null).length,
      supplierVerifiedCases: rows.filter(r => r.supplierVerified).length,
      modelQuality: config.live ? { exactMatches: rows.filter(r => r.exactMatch).length, totalCases: smokeCases.length,
        exactMatchRate: complete ? rows.filter(r => r.exactMatch).length / smokeCases.length : null } : null,
      estimatedCostUsd: config.live && estimates.length > 0 && estimates.every(v => v !== null) ? estimates.reduce<number>((sum, v) => sum + v!, 0) : null },
    limitations: ["Five synthetic cases are a smoke check, not a representative quality benchmark or p95 latency estimate.",
      "Offline mode uses scripted responses; no model was evaluated and no token usage is fabricated.",
      "Supplier verification checks labelled text agreement only, not source authenticity or the other fields.",
      "Missing token usage means cost is unknown. Timeouts do not prove an invocation was unbilled."], rows,
  };
  return report;
}

async function main() {
  const config = parseSmokeOptions(process.argv.slice(2));
  await mkdir(dirname(config.output), { recursive: true });
  // Reserve the destination BEFORE any live call, rather than discovering a
  // collision after paying for inference and losing the resulting evidence.
  const file = await open(config.output, "wx");
  let report: Awaited<ReturnType<typeof runSmoke>>;
  try {
    report = await runSmoke(config);
    await file.writeFile(JSON.stringify(report, null, 2) + "\n");
  } finally { await file.close(); }
  console.log(JSON.stringify({ mode: report.mode, report: config.output, ...report.summary }, null, 2));
  if (!report.summary.complete || report.rows.some(r => r.errorCategory)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Smoke run failed"); process.exitCode = 1; });
}
