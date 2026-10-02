import express, { type ErrorRequestHandler } from "express";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

type Config = { inferenceUrl: string; timeoutMs: number };

function validPrediction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.prediction === "positive" || v.prediction === "negative") &&
    typeof v.confidence === "number" && Number.isFinite(v.confidence) &&
    v.confidence >= 0 && v.confidence <= 1 &&
    typeof v.modelVersion === "string" && v.modelVersion.length > 0;
}

export function createApp(config: Config) {
  const app = express();
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
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json({ error: status === 413 ? "Request too large" : status === 400 ? "Invalid JSON" : "Internal server error" });
  };
  app.use(errorHandler);
  return app;
}
