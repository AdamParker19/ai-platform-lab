import { sha256, type Provenance } from "./provenance.js";
import { parsePromptVariant, systemPrompt, type PromptVariant } from "./prompts.js";

export type ExtractionOptions = { signal?: AbortSignal; requestId?: string };

export interface ExtractionProvider {
  metadata?(): Provenance;
  describe?(signal?: AbortSignal): Promise<Provenance>;
  extract(document: string, options?: ExtractionOptions): Promise<unknown>;
}

export type OllamaProviderOptions = {
  baseUrl?: string;
  model?: string;
  think?: boolean;
  temperature?: number;
  seed?: number;
  promptVariant?: PromptVariant;
};

// Preserve the existing export for callers and the recorded baseline.
export { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";

export class OllamaExtractionProvider implements ExtractionProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly think: boolean;
  readonly temperature: number | undefined;
  readonly seed: number | undefined;
  readonly promptVariant: PromptVariant;
  readonly systemPrompt: string;

  constructor(options: OllamaProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? "qwen3:1.7b";
    const thinkEnv = process.env.OLLAMA_THINK?.replace(/^["']|["']$/g, "").trim();
    this.think = options.think ?? (thinkEnv === "false" ? false : true);
    this.temperature = options.temperature;
    this.seed = options.seed;
    // Candidate selection is explicit; ordinary serving keeps the baseline.
    this.promptVariant = parsePromptVariant(options.promptVariant ?? "baseline-v1");
    this.systemPrompt = systemPrompt(this.promptVariant);
  }

  metadata(): Provenance {
    return { provider: "ollama", model: this.model, modelDigest: null, digestStatus: "unavailable",
      observedAt: null, promptVariant: this.promptVariant, promptSha256: sha256(this.systemPrompt),
      settings: { think: this.think, temperature: this.temperature ?? null, seed: this.seed ?? null, format: "json" } };
  }

  async describe(signal?: AbortSignal): Promise<Provenance> {
    const metadata = this.metadata();
    try {
      const deadline = AbortSignal.timeout(2500);
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (!response.ok) { await response.body?.cancel(); return metadata; }
      const payload = await response.json() as { models?: { name?: string; model?: string; digest?: string; remote_model?: string }[] };
      const canonical = (name: string) => name.includes(":") ? name : `${name}:latest`;
      const match = payload.models?.find(m => canonical(m.name ?? m.model ?? "") === canonical(this.model));
      // A cloud alias digest does not identify remote model weights.
      if (match && !match.remote_model && typeof match.digest === "string" && /^[a-f0-9]{64}$/i.test(match.digest)) {
        metadata.modelDigest = match.digest;
        metadata.digestStatus = "observed";
        metadata.observedAt = new Date().toISOString();
      }
    } catch { /* Metadata lookup failure must not masquerade as a verified digest. */ }
    return metadata;
  }

  async extract(document: string, options?: { signal?: AbortSignal }): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: `<document>\n${document}\n</document>` },
        ],
        stream: false,
        format: "json",
        think: this.think,
        options: { ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
          ...(this.seed === undefined ? {} : { seed: this.seed }) },
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Ollama request failed with HTTP ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
      error?: string;
    };

    if (payload.error) {
      throw new Error(`Ollama error: ${payload.error}`);
    }

    const content = payload.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Empty model response received from Ollama");
    }

    try {
      return JSON.parse(content);
    } catch (parseError) {
      throw new Error(`Failed to parse model JSON: ${(parseError as Error).message}`);
    }
  }
}

export type MockProviderBehavior =
  | { mode: "fixed"; response: unknown }
  | { mode: "map"; responses: Record<string, unknown>; fallback?: unknown }
  | { mode: "error"; error: Error }
  | { mode: "timeout"; delayMs?: number }
  | { mode: "custom"; handler: (document: string, signal?: AbortSignal) => Promise<unknown> };

export class MockExtractionProvider implements ExtractionProvider {
  private behavior: MockProviderBehavior;

  constructor(behavior: MockProviderBehavior = { mode: "fixed", response: null }) {
    this.behavior = behavior;
  }

  setBehavior(behavior: MockProviderBehavior): void {
    this.behavior = behavior;
  }

  async extract(document: string, options?: { signal?: AbortSignal }): Promise<unknown> {
    const signal = options?.signal;
    if (signal?.aborted) {
      const abortErr = new Error("The operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    switch (this.behavior.mode) {
      case "fixed":
        return this.behavior.response;

      case "map": {
        if (document in this.behavior.responses) {
          return this.behavior.responses[document];
        }
        if (this.behavior.fallback !== undefined) {
          return this.behavior.fallback;
        }
        throw new Error(`No mock response configured for document: "${document.slice(0, 50)}..."`);
      }

      case "error":
        throw this.behavior.error;

      case "timeout": {
        const delay = this.behavior.delayMs ?? 10000;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true }
          );
        });
        return {
          supplierName: null,
          productName: null,
          countryOfOrigin: null,
          material: null,
          certificates: [],
        };
      }

      case "custom":
        return this.behavior.handler(document, signal);
    }
  }
}
