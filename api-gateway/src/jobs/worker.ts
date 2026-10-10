import { Extractor, ExtractionValidationError } from "../extraction/extractor.js";
import type { ExtractionProvider } from "../extraction/provider.js";
import { JobStore } from "./store.js";

export class ExtractionWorker {
  private extractor: Extractor;
  constructor(private store: JobStore, provider: ExtractionProvider, private timeoutMs = 30000) {
    this.extractor = new Extractor(provider);
  }
  async runOnce() {
    const job = this.store.claim(this.timeoutMs + 5000);
    if (!job) return false;
    console.log(JSON.stringify({ service: "extraction-worker", event: "started", jobId: job.id,
      requestId: job.request_id, attempt: job.attempts }));
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("deadline")); }, this.timeoutMs);
      });
      const result = await Promise.race([this.extractor.extract(job.document, { signal: controller.signal }), deadline]);
      const saved = this.store.succeed(job.id, job.token!, result);
      console.log(JSON.stringify({ service: "extraction-worker", event: saved ? "succeeded" : "lease_lost", jobId: job.id }));
    } catch (error) {
      const invalid = error instanceof ExtractionValidationError;
      const code = controller.signal.aborted ? "extraction_timeout" : invalid ? "invalid_model_response" : "provider_unavailable";
      const saved = this.store.fail(job.id, job.token!, code, !invalid);
      console.log(JSON.stringify({ service: "extraction-worker", event: saved ? "attempt_failed" : "lease_lost", jobId: job.id, error: code }));
    } finally { clearTimeout(timer); }
    return true;
  }
}
