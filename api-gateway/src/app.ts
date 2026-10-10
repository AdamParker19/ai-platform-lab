import express, { type ErrorRequestHandler } from "express";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Extractor, ExtractionValidationError } from "./extraction/extractor.js";
import { OllamaExtractionProvider, type ExtractionProvider } from "./extraction/provider.js";

import { JobStore, JobConflict, JobCapacity } from "./jobs/store.js";

export type GatewayConfig = {
  jobStore?: JobStore;
  inferenceUrl: string;
  timeoutMs: number;
  extractionProvider?: ExtractionProvider;
  llmTimeoutMs?: number;
  maxDocumentLength?: number;
};

function validPrediction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.prediction === "positive" || v.prediction === "negative") &&
    typeof v.confidence === "number" && Number.isFinite(v.confidence) &&
    v.confidence >= 0 && v.confidence <= 1 &&
    typeof v.modelVersion === "string" && v.modelVersion.length > 0;
}

export function createApp(config: GatewayConfig) {
  const app = express();
  const llmTimeoutMs = config.llmTimeoutMs ?? 30000;
  const maxDocLength = config.maxDocumentLength ?? 10000;
  const extractionProvider = config.extractionProvider ?? new OllamaExtractionProvider();
  const extractor = new Extractor(extractionProvider);

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const requestId = randomBytes(16).toString("hex");
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const start = performance.now();
    res.on("finish", () => console.log(JSON.stringify({
      service: "api-gateway", requestId, method: req.method, path: req.path,
      status: res.statusCode, latencyMs: Math.round((performance.now() - start) * 100) / 100,
    })));
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.post("/api/analyze", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "text") || typeof body.text !== "string" ||
        !body.text.trim() || [...body.text.trim()].length > 5000) {
      res.status(400).json({ error: "text must contain 1–5000 characters; no extra fields allowed" });
      return;
    }
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      const upstream = await fetch(new URL("/predict", config.inferenceUrl), {
        method: "POST", headers: { "content-type": "application/json", "x-request-id": res.locals.requestId },
        body: JSON.stringify({ text: body.text.trim() }), signal,
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        res.status(502).json({ error: "Inference service failed" });
        return;
      }
      const prediction: unknown = await upstream.json();
      if (!validPrediction(prediction)) {
        res.status(502).json({ error: "Invalid inference response" });
        return;
      }
      res.json(prediction);
    } catch {
      res.status(signal.aborted ? 504 : 502).json({
        error: signal.aborted ? "Inference timed out" : "Inference service unavailable",
      });
    }
  });
  app.post("/api/extraction-jobs", (req, res) => {
    if (!config.jobStore) { res.status(503).json({ error: "Background jobs disabled" }); return; }
    const key = req.get("Idempotency-Key");
    const body = req.body;
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      res.status(400).json({ error: "Idempotency-Key must contain 8–128 letters, digits, underscores or hyphens" }); return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.document !== "string" ||
        !body.document.trim() || body.document.trim().length > maxDocLength || Object.keys(body).some(k => k !== "document")) {
      res.status(400).json({ error: `document must contain 1–${maxDocLength} characters; no extra fields allowed` }); return;
    }
    try {
      const { job, replayed } = config.jobStore.enqueue(key, body.document.trim(), res.locals.requestId);
      res.setHeader("Location", `/api/extraction-jobs/${job.jobId}`);
      res.setHeader("Idempotency-Replayed", String(replayed));
      res.status(replayed ? 200 : 202).json(job);
    } catch (error) {
      if (error instanceof JobConflict) { res.status(409).json({ error: error.message }); return; }
      if (error instanceof JobCapacity) { res.status(503).json({ error: error.message }); return; }
      throw error;
    }
  });
  app.get("/api/extraction-jobs/:id", (req, res) => {
    if (!config.jobStore) { res.status(503).json({ error: "Background jobs disabled" }); return; }
    const job = config.jobStore.get(req.params.id);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  });
  app.post("/api/extract", async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }
    if (!("document" in body)) {
      res.status(400).json({ error: "document field is required" });
      return;
    }
    if (typeof body.document !== "string") {
      res.status(400).json({ error: "document must be a string" });
      return;
    }
    const trimmedDocument = body.document.trim();
    if (trimmedDocument.length === 0) {
      res.status(400).json({ error: "document must not be empty" });
      return;
    }
    if (trimmedDocument.length > maxDocLength) {
      res.status(400).json({ error: `document exceeds maximum allowed length of ${maxDocLength} characters` });
      return;
    }
    if (Object.keys(body).some(key => key !== "document")) {
      res.status(400).json({ error: "No extra fields allowed in request body" });
      return;
    }

    const signal = AbortSignal.timeout(llmTimeoutMs);
    try {
      const extraction = await extractor.extract(trimmedDocument, { signal });
      res.json(extraction);
    } catch (error: unknown) {
      const isAborted = signal.aborted || (error instanceof Error && error.name === "AbortError");
      if (isAborted) {
        res.status(504).json({ error: "LLM extraction timed out" });
        return;
      }
      if (error instanceof ExtractionValidationError) {
        res.status(502).json({ error: "Invalid model response" });
        return;
      }
      res.status(502).json({ error: "Extraction service unavailable" });
    }
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json({ error: status === 413 ? "Request too large" : status === 400 ? "Invalid JSON" : "Internal server error" });
  };
  app.use(errorHandler);
  return app;
}

