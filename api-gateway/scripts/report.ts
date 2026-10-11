import { fields } from "./evaluation.js";

type Summary = {
  thinking: boolean; attempts: number; wholeDocumentAccuracy: number | null;
  fieldAccuracy: number | null; timeouts: number; providerErrors: number; invalidResponses: number;
  medianLatencyMs: number | null; p95LatencyMs: number | null;
  perField: { [key: string]: number | null };
};
type Report = {
  model: string; passed: boolean; modelIdentityConsistent: boolean; promptSha256: string;
  codeRevision: string | null; dataset: { version: string; sha256: string; split: string };
  summary: Summary[]; scope: string;
};
export function markdownReport(report: Report) {
  const percent = (v: number | null | undefined) => v == null ? "n/a" : (v * 100).toFixed(1) + "%";
  const safe = (v: string) => v.replace(/[\r\n|]/g, " ");
  const lines = [
    "# Extraction evaluation", "",
    "Model: " + safe(report.model),
    "Dataset: " + report.dataset.version + " (" + report.dataset.split + ")",
    "Dataset SHA-256: " + report.dataset.sha256,
    "Prompt SHA-256: " + report.promptSha256,
    "Code revision: " + (report.codeRevision ?? "unavailable"),
    "Observed model identity consistent: " + report.modelIdentityConsistent,
    "Gate: " + (report.passed ? "PASS" : "FAIL"), "",
    "| Thinking | Attempts | Whole document | Fields | Timeouts | Provider errors | Invalid | Median ms | p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.summary.map(s => "| " + [s.thinking ? "on" : "off", s.attempts,
      percent(s.wholeDocumentAccuracy), percent(s.fieldAccuracy), s.timeouts,
      s.providerErrors, s.invalidResponses, s.medianLatencyMs ?? "n/a", s.p95LatencyMs ?? "n/a"].join(" | ") + " |"),
    "", "| Field | Thinking off | Thinking on |", "|---|---:|---:|",
    ...fields.map(field => "| " + field + " | " +
      percent(report.summary.find(s => !s.thinking)?.perField[field]) + " | " +
      percent(report.summary.find(s => s.thinking)?.perField[field]) + " |"),
    "", report.scope, "",
    "Latency includes failed requests and timeouts. Warmups are excluded. JSON contains individual outcomes and split summaries.",
    "A failed gate is diagnostic evidence; do not change labels just to make it pass.", "",
  ];
  return lines.join("\n");
}
