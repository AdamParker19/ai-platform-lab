export type GroundingStatus = "verified" | "mismatch" | "needs_review";

export interface GroundingResult {
  status: GroundingStatus;
  field: "supplierName";
  extractedValue: string | null;
  evidence: string[];
}

/** Checks agreement with labelled source text, not the trustworthiness of that text. */
export function verifySupplier(document: string, extracted: string | null): GroundingResult {
  const values = document.split(/\r?\n/).flatMap(line => {
    // Only a label at the start of a line counts. Never search arbitrary prose.
    const match = line.match(/^Supplier:\s*(.*?)\s*$/i);
    const value = match?.[1].trim();
    return value ? [value] : [];
  });
  const evidence = [...new Set(values)];

  return {
    status: evidence.length !== 1
      ? "needs_review"
      : extracted === evidence[0] ? "verified" : "mismatch",
    field: "supplierName",
    extractedValue: extracted,
    evidence,
  };
}
