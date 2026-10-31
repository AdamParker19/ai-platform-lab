import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { ExtractionOptions, ExtractionProvider } from "./provider.js";
import { parsePromptVariant, systemPrompt, type PromptVariant } from "./prompts.js";
import { sha256, type Provenance } from "./provenance.js";

export type BedrockErrorCategory = "timeout" | "access_denied" | "throttled" | "unavailable" | "invalid_response" | "provider_error";
export class BedrockExtractionError extends Error {
  constructor(public readonly category: BedrockErrorCategory) {
    super(`Bedrock extraction failed: ${category}`);
    this.name = category === "timeout" ? "AbortError" : "BedrockExtractionError";
  }
}

export type BedrockTelemetry = {
  service: "bedrock-extraction"; event: "model_call"; provider: "bedrock";
  requestId: string; awsRequestId: string | null; model: string; region: string;
  promptVariant: PromptVariant; promptSha256: string; maxOutputTokens: number;
  clientLatencyMs: number; serviceLatencyMs: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  stopReason: string | null; outcome: "json_parsed" | "error"; errorCategory: BedrockErrorCategory | null;
};
// Treat wire telemetry defensively; absence is unknown, never invented as zero.
export type ConverseReply = Pick<ConverseCommandOutput, "$metadata" | "output" | "stopReason"> & Partial<Pick<ConverseCommandOutput, "usage" | "metrics">>;
export type ConverseSender = (command: ConverseCommand, options: { abortSignal: AbortSignal }) => Promise<ConverseReply>;
export type BedrockProviderOptions = {
  modelId: string; region: string; maxOutputTokens?: number; timeoutMs?: number;
  promptVariant?: PromptVariant; send?: ConverseSender; onTelemetry?: (event: BedrockTelemetry) => void;
};

const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function category(error: unknown, signal: AbortSignal): BedrockErrorCategory {
  if (signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return "timeout";
  if (error instanceof BedrockExtractionError) return error.category;
  const name = error instanceof Error ? error.name : "";
  if (name === "AccessDeniedException") return "access_denied";
  if (name === "ThrottlingException") return "throttled";
  if (["ServiceUnavailableException", "ModelNotReadyException", "InternalServerException"].includes(name)) return "unavailable";
  return "provider_error";
}

export class BedrockExtractionProvider implements ExtractionProvider {
  readonly modelId: string;
  readonly region: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly promptVariant: PromptVariant;
  private readonly prompt: string;
  private readonly send: ConverseSender;
  private readonly onTelemetry: (event: BedrockTelemetry) => void;

  constructor(options: BedrockProviderOptions) {
    this.modelId = options.modelId.trim();
    this.region = options.region.trim();
    this.maxOutputTokens = options.maxOutputTokens ?? 256;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!this.modelId || this.modelId.length > 2048) throw new Error("A non-empty Bedrock model ID or inference profile is required");
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(this.region)) throw new Error("Invalid Bedrock region");
    if (!Number.isInteger(this.maxOutputTokens) || this.maxOutputTokens < 1 || this.maxOutputTokens > 512) throw new Error("Bedrock maxOutputTokens must be 1–512");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120000) throw new Error("Invalid Bedrock timeoutMs");
    this.promptVariant = parsePromptVariant(options.promptVariant ?? "evidence-v2");
    this.prompt = systemPrompt(this.promptVariant);
    if (options.send) this.send = options.send;
    else {
      // Default credential chain; no embedded keys, endpoint override, or SDK retries.
      const client = new BedrockRuntimeClient({ region: this.region, maxAttempts: 1 });
      this.send = (command, requestOptions) => client.send(command, requestOptions);
    }
    this.onTelemetry = options.onTelemetry ?? (event => console.log(JSON.stringify(event)));
  }

  metadata(): Provenance {
    return { provider: "bedrock", model: this.modelId, modelDigest: null, digestStatus: "unavailable",
      observedAt: null, promptVariant: this.promptVariant, promptSha256: sha256(this.prompt),
      settings: { think: null, temperature: null, seed: null, format: "prompted-json" } };
  }

  async extract(document: string, options: ExtractionOptions = {}): Promise<unknown> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const requestId = options.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(options.requestId) ? options.requestId : randomUUID();
    const start = performance.now();
    const telemetry: BedrockTelemetry = {
      service: "bedrock-extraction", event: "model_call", provider: "bedrock", requestId, awsRequestId: null,
      model: this.modelId, region: this.region, promptVariant: this.promptVariant, promptSha256: sha256(this.prompt),
      maxOutputTokens: this.maxOutputTokens, clientLatencyMs: 0, serviceLatencyMs: null,
      inputTokens: null, outputTokens: null, totalTokens: null, stopReason: null, outcome: "error", errorCategory: null,
    };
    try {
      if (signal.aborted) throw new BedrockExtractionError("timeout");
      if (!document.trim() || document.length > 10000) throw new BedrockExtractionError("invalid_response");
      const response = await this.send(new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: this.prompt }],
        messages: [{ role: "user", content: [{ text: `<document>\n${document}\n</document>` }] }],
        inferenceConfig: { maxTokens: this.maxOutputTokens },
        requestMetadata: { requestId, promptVariant: this.promptVariant },
      }), { abortSignal: signal });
      telemetry.awsRequestId = response.$metadata.requestId ?? null;
      telemetry.inputTokens = count(response.usage?.inputTokens);
      telemetry.outputTokens = count(response.usage?.outputTokens);
      telemetry.totalTokens = count(response.usage?.totalTokens);
      const serviceLatency = response.metrics?.latencyMs;
      telemetry.serviceLatencyMs = typeof serviceLatency === "number" && Number.isFinite(serviceLatency) && serviceLatency >= 0 ? serviceLatency : null;
      telemetry.stopReason = response.stopReason ?? null;
      if (signal.aborted) throw new BedrockExtractionError("timeout");
      // Truncation, blocked content and tool requests are not completed extractions.
      if (response.stopReason !== "end_turn") throw new BedrockExtractionError("invalid_response");
      const text = response.output?.message?.content?.flatMap(block => typeof block.text === "string" ? [block.text] : []).join("") ?? "";
      let result: unknown;
      try { result = JSON.parse(text); } catch { throw new BedrockExtractionError("invalid_response"); }
      telemetry.outcome = "json_parsed"; // Schema and grounding are separate downstream decisions.
      return result;
    } catch (error) {
      telemetry.errorCategory = category(error, signal);
      if (error && typeof error === "object" && "$metadata" in error) {
        const metadata = error.$metadata as { requestId?: unknown } | undefined;
        if (typeof metadata?.requestId === "string") telemetry.awsRequestId = metadata.requestId;
      }
      // Do not expose SDK messages or model text that might contain document content.
      throw new BedrockExtractionError(telemetry.errorCategory);
    } finally {
      telemetry.clientLatencyMs = Math.round((performance.now() - start) * 100) / 100;
      try { this.onTelemetry(telemetry); } catch { /* Logging must not change the extraction outcome. */ }
    }
  }
}
