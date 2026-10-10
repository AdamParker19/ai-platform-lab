import { isDeepStrictEqual } from "node:util";
import type { ExtractionResult } from "../src/extraction/schema.js";

export type Outcome = "correct" | "incorrect" | "timeout" | "provider_error" | "invalid_response";
export type EvaluationRow = {
  documentId: string;
  thinking: boolean;
  run: number;
  outcome: Outcome;
  latencyMs: number;
  httpStatus: number | null;
  requestId: string | null;
  expected: ExtractionResult;
  actual: unknown;
};

export function sameExtraction(actual: ExtractionResult, expected: ExtractionResult): boolean {
  // Certificate ordering is not part of the contract. Duplicates still count as a mismatch.
  return isDeepStrictEqual(
    { ...actual, certificates: [...actual.certificates].sort() },
    { ...expected, certificates: [...expected.certificates].sort() },
  );
}

export function summarize(rows: EvaluationRow[]) {
  const latencies = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  const count = (outcome: Outcome) => rows.filter(row => row.outcome === outcome).length;
  const middle = Math.floor(latencies.length / 2);
  return {
    attempts: rows.length,
    correct: count("correct"),
    incorrect: count("incorrect"),
    timeouts: count("timeout"),
    providerErrors: count("provider_error"),
    invalidResponses: count("invalid_response"),
    successRate: rows.length ? count("correct") / rows.length : null,
    // All attempts count here, including failed requests and timeouts.
    medianLatencyMs: rows.length ? (rows.length % 2 ? latencies[middle]! : (latencies[middle - 1]! + latencies[middle]!) / 2) : null,
    p95LatencyMs: rows.length ? latencies[Math.ceil(rows.length * 0.95) - 1]! : null,
  };
}

export function hasFailures(rows: EvaluationRow[]): boolean {
  return rows.length === 0 || rows.some(row => row.outcome !== "correct");
}
