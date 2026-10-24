import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { extractionSchema } from "../src/extraction/schema.js";
import { sha256 } from "../src/extraction/provenance.js";
import { EXTRACTION_SYSTEM_PROMPT, EVIDENCE_SYSTEM_PROMPT } from "../src/extraction/prompts.js";
import { sameExtraction, summarize, quality, type EvaluationRow } from "./evaluation.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const rowSchema = z.object({
  documentId: z.string(), thinking: z.boolean(), run: z.number().int().positive(),
  outcome: z.enum(["correct", "incorrect", "timeout", "provider_error", "invalid_response"]),
  latencyMs: z.number().finite().nonnegative(), httpStatus: z.number().nullable(),
  requestId: z.string().nullable(), expected: extractionSchema, actual: z.unknown(),
});
const reportSchema = z.object({
  reportVersion: z.union([z.literal(2), z.literal(3)]),
  promptVariant: z.enum(["baseline-v1", "evidence-v2"]).optional(),
  promptSha256: digest, model: z.string(), modelIdentityConsistent: z.boolean(),
  dataset: z.object({ version: z.string(), sha256: digest, split: z.string() }),
  configuration: z.object({
    runs: z.number().int().positive(), timeoutMs: z.number().positive(),
    modes: z.array(z.boolean()).min(1).max(2), warmup: z.number().int().nonnegative(),
    seed: z.number().int(), temperature: z.number().finite(),
  }),
  observations: z.array(z.object({
    thinking: z.boolean(),
    before: z.object({ modelDigest: digest.nullable() }),
    after: z.object({ modelDigest: digest.nullable() }),
  })),
  fixtures: z.array(z.object({
    id: z.string(), raw: z.string(), expected: extractionSchema,
    category: z.string(), split: z.string(),
  })).min(1),
  results: z.array(rowSchema).min(1),
});

export type ExperimentReport = z.infer<typeof reportSchema>;
export function parseExperimentReport(value: unknown): ExperimentReport {
  const report = reportSchema.parse(value);
  const { runs, modes } = report.configuration;
  if (new Set(modes).size !== modes.length || new Set(report.fixtures.map(f => f.id)).size !== report.fixtures.length) {
    throw new Error("Report contains duplicate modes or documents");
  }
  if (report.results.length !== runs * modes.length * report.fixtures.length) {
    throw new Error("Report is incomplete");
  }
  const seen = new Set<string>();
  for (const row of report.results) {
    const fixture = report.fixtures.find(f => f.id === row.documentId);
    const key = JSON.stringify([row.documentId, row.thinking, row.run]);
    if (!fixture || !modes.includes(row.thinking) || row.run > runs || seen.has(key) ||
      !isDeepStrictEqual(row.expected, fixture.expected)) {
      throw new Error("Report contains inconsistent or duplicate measurements");
    }
    seen.add(key);
    if (row.outcome === "correct" || row.outcome === "incorrect") {
      const parsed = extractionSchema.safeParse(row.actual);
      if (!parsed.success || sameExtraction(parsed.data, row.expected) !== (row.outcome === "correct")) {
        throw new Error("Reported outcome disagrees with actual extraction");
      }
    }
  }
  return report;
}

function observedDigest(report: ExperimentReport): string | null {
  if (!report.modelIdentityConsistent || report.observations.length !== report.configuration.modes.length) return null;
  const first = report.observations[0]?.before.modelDigest ?? null;
  if (!first) return null;
  const seen = new Set<boolean>();
  for (const o of report.observations) {
    if (seen.has(o.thinking) || !report.configuration.modes.includes(o.thinking) ||
      o.before.modelDigest !== first || o.after.modelDigest !== first) return null;
    seen.add(o.thinking);
  }
  return first;
}

export function baselinePlanProblems(baseline: ExperimentReport,
  candidate: Pick<ExperimentReport, "promptVariant" | "promptSha256" | "model" | "dataset" | "configuration" | "fixtures">) {
  const reasons: string[] = [];
  // Old v2 reports have no variant label: check their actual prompt hash.
  if (baseline.promptSha256 !== sha256(EXTRACTION_SYSTEM_PROMPT) ||
    (baseline.promptVariant !== undefined && baseline.promptVariant !== "baseline-v1")) {
    reasons.push("Reference is not the preserved baseline-v1 prompt");
  }
  if (candidate.promptVariant !== "evidence-v2" || candidate.promptSha256 !== sha256(EVIDENCE_SYSTEM_PROMPT)) {
    reasons.push("Candidate is not the evidence-v2 prompt");
  }
  if (!isDeepStrictEqual(baseline.dataset, candidate.dataset) ||
    !isDeepStrictEqual(baseline.fixtures, candidate.fixtures)) reasons.push("Dataset or selected fixtures changed");
  if (!isDeepStrictEqual(baseline.configuration, candidate.configuration)) {
    reasons.push("Runs, modes, warmup, deadline, seed or temperature changed");
  }
  if (baseline.model !== candidate.model) reasons.push("Requested model changed");
  return reasons;
}

export function compareReports(baselineValue: unknown, candidateValue: unknown) {
  const baseline = parseExperimentReport(baselineValue);
  const candidate = parseExperimentReport(candidateValue);
  const reasons = baselinePlanProblems(baseline, candidate);
  const baselineDigest = observedDigest(baseline), candidateDigest = observedDigest(candidate);
  if (!baselineDigest || baselineDigest !== candidateDigest) {
    reasons.push("Requested model or observed weight digest differs or is unavailable");
  }
  const limits = "Historical comparison, not a randomized experiment. Hardware, Ollama version, model load and caching can change latency. Repetitions reuse the same small document set. Improvement alone does not establish injection resistance or authorize promotion.";
  if (reasons.length) return { comparable: false as const, reasons, modes: [], limits };
  const modes = candidate.configuration.modes.map(thinking => {
    const previous = baseline.results.filter(r => r.thinking === thinking) as EvaluationRow[];
    const next = candidate.results.filter(r => r.thinking === thinking) as EvaluationRow[];
    const b = { ...summarize(previous), ...quality(previous) };
    const c = { ...summarize(next), ...quality(next) };
    return {
      thinking, baseline: b, candidate: c,
      wholeDocumentDeltaPercentagePoints: 100 * (c.wholeDocumentAccuracy! - b.wholeDocumentAccuracy!),
      fieldDeltaPercentagePoints: 100 * (c.fieldAccuracy! - b.fieldAccuracy!),
      timeoutDelta: c.timeouts - b.timeouts,
      medianLatencyRatio: b.medianLatencyMs! > 0 ? c.medianLatencyMs! / b.medianLatencyMs! : null,
    };
  });
  return { comparable: true as const, reasons, modes, limits };
}
