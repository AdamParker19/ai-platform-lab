import { extractionSchema, type ExtractionResult } from "./schema.js";
import type { ExtractionProvider } from "./provider.js";

export class ExtractionValidationError extends Error {
  constructor(message: string, public readonly issues: unknown) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

export class Extractor {
  constructor(private readonly provider: ExtractionProvider) {}

  async extract(document: string, options?: { signal?: AbortSignal }): Promise<ExtractionResult> {
    const rawResult = await this.provider.extract(document, options);
    const parsed = extractionSchema.safeParse(rawResult);
    if (!parsed.success) {
      throw new ExtractionValidationError("Model response failed schema validation", parsed.error.issues);
    }
    return parsed.data;
  }
}
