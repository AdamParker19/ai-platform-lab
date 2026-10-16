# Decision: deterministic supplier evidence checks

## Context

Zod validates the shape of an extraction. Both a legitimate supplier name and
"HACKED" are strings, so both pass the existing schema. Structural validity does
not establish source support or resistance to prompt injection.

## Decision

`verifySupplier(document, extracted)` recognizes nonempty values on lines starting
with `Supplier:` (case-insensitive label). It trims source values and deduplicates
exact repeats. Supplier values are compared exactly: no fuzzy matching, case
folding, or silent correction of the model output.

| Evidence | Status | Meaning |
| --- | --- | --- |
| One distinct value matching extraction | verified | Supplier agrees with recognized source evidence |
| One distinct value differing from extraction, including null | mismatch | Extraction conflicts with recognized source evidence |
| No values or multiple distinct values | needs_review | This rule cannot establish a single supported value |

Blank labels do not supply evidence. Repeated identical values are not conflicting.
Leading indentation, alternative labels, and prose are outside this narrow grammar.
A legitimate supplier named only in a paragraph therefore receives `needs_review`,
even when the extraction is correct. This is abstention, not proof of an error.

## Integration

`Extractor.extractWithGrounding()` calls the existing schema-validating `extract()`
once, then returns `{ extraction, grounding }`. The extraction fields are retained
without rewriting the supplier. Provider failures and schema errors still reject;
the caller's abort signal is forwarded.

This is an opt-in application method for this exercise. Existing HTTP routes and
background jobs still use `extract()` and do not enforce grounding or persist its
metadata. Adopting the new method and routing unverified results is subsequent work.
`verified` applies only to supplierName, not the entire document or other fields.

Example inside an async caller with a configured extractor:

```typescript
const { extraction, grounding } = await extractor.extractWithGrounding(document);
if (grounding.status !== "verified") {
  // Retain extraction + grounding for review; do not automatically publish.
} else {
  // Supplier evidence check passed; other validation rules still apply.
}
```

## Why deterministic checks first?

For explicitly labelled fields they are inexpensive, reproducible, and add no model
request. A second LLM adds inference latency and cost and may obey the same malicious
instructions. Agreement between two models is not independent proof of correctness.
At 100,000 documents per day, use deterministic checks first and selectively escalate
unresolved cases to a more capable verifier or human review. A mismatch should be
flagged rather than automatically overridden by a second model. Measure coverage,
false rejections, review volume, latency, and cost separately from accuracy.

## Threat boundary

- Unsupported extraction: an output has no backing under this evidence rule;
  a single contradictory label yields mismatch, while missing evidence yields review.
- Ambiguous evidence: conflicting labelled values yield review, even if one matches.
- Malicious source content: attacker-controlled text may contain forged labels.
  A single forged label can pass. Matching source text never authenticates the source.

This check does not detect all attacks, establish supplier identity, or authorize
business actions. Source authenticity needs separate trusted provenance and controls.

## Verification

`tests/grounding.test.ts` uses the existing development fixtures for ordinary,
missing, Alpine injection, Meridian injection, and administrator-override cases.
Additional cases cover conflicting labels, duplicates, blank labels, exact equality,
forged evidence, mocked integration, schema rejection, and option forwarding.
The tests establish validator behavior; they do not measure live model resistance.

Run from api-gateway:

```powershell
npm test
npm run build
```
