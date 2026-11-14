import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePromptVariant } from "../src/extraction/prompts.js";
import { gatewayDirectory, loadGatewayEnv, saveSmokeReport, type SmokeOptions } from "./bedrock-smoke.js";

class SingleConfigurationError extends Error {}

export function parseSingleOptions(args: string[], env: NodeJS.ProcessEnv = process.env): SmokeOptions {
  let offline = false;
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--offline" && !offline) offline = true;
    else if (key === "--output" && output === undefined && args[i + 1] && !args[i + 1]!.startsWith("--")) output = args[++i];
    else throw new SingleConfigurationError("Supported arguments: --offline, --output PATH");
  }
  const modelId = offline ? "offline-simulated-model" : env.BEDROCK_MODEL_ID?.trim();
  if (!modelId) throw new SingleConfigurationError("Set BEDROCK_MODEL_ID in api-gateway/.env");
  const region = (env.BEDROCK_REGION ?? env.AWS_REGION ?? "ap-south-1").trim();
  const timeoutMs = Number(env.BEDROCK_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new SingleConfigurationError("BEDROCK_TIMEOUT_MS must be 1–120000");
  const price = (key: string) => {
    const raw = env[key];
    if (raw === undefined || !raw.trim()) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new SingleConfigurationError(`Invalid ${key}`);
    return value;
  };
  const inputPrice = price("BEDROCK_INPUT_USD_PER_MILLION");
  const outputPrice = price("BEDROCK_OUTPUT_USD_PER_MILLION");
  if ((inputPrice === null) !== (outputPrice === null)) throw new SingleConfigurationError("Provide both Bedrock token prices or leave both unset");
  return { live: !offline, caseLimit: 1, timeoutMs, modelId, region,
    promptVariant: parsePromptVariant(env.BEDROCK_PROMPT_VARIANT ?? "evidence-v2"), inputPrice, outputPrice,
    output: output ? resolve(output) : resolve(gatewayDirectory, "evaluation-results", `bedrock-single-${offline ? "offline" : "live"}-${randomUUID()}.json`) };
}

async function main() {
  const progress = (message: string) => console.error(`[bedrock-single] ${message}`);
  progress("Runner started; loading api-gateway/.env.");
  loadGatewayEnv();
  const config = parseSingleOptions(process.argv.slice(2));
  progress(config.live
    ? `LIVE: one billable request, no retries, max 256 output tokens, ${config.timeoutMs}ms application deadline.`
    : "OFFLINE: one scripted case; AWS is not contacted.");
  const report = await saveSmokeReport(config, undefined, progress);
  const row = report.rows[0]!;
  console.log(JSON.stringify({ mode: report.mode, report: config.output, ...report.summary,
    outcome: row.outcome, extraction: row.actual, grounding: row.grounding, telemetry: row.telemetry }, null, 2));
  if (!report.summary.complete || row.errorCategory) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Raw SDK, filesystem and dotenv exceptions can contain private values.
    console.error(error instanceof SingleConfigurationError ? error.message
      : error?.code === "EEXIST" ? "Report already exists; choose a different --output path."
      : "Single-request run could not complete. Check .env configuration, arguments, and report destination. See lifecycle events above.");
    process.exitCode = 1;
  });
}
