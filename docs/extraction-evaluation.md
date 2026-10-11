# Traceable extraction evaluation

This lab compares thinking off/on against versioned expected answers. It produces JSON evidence and a readable Markdown comparison. It uses your existing Ollama server; no AWS resource is created.

## Run

From api-gateway, with Node 24 and Ollama running:

```powershell
npm ci
npm test
npm run build
$env:OLLAMA_MODEL = 'Qwen3:1.7b'

# Quick check: five development documents, once in each mode.
npm run verify:live -- --runs 1 --warmup 0 --output evaluation-results/quick.json

# Main comparison: 50 measured requests, plus two warmups.
npm run verify:live -- --runs 5 --output evaluation-results/comparison.json

# Evaluate the reserved candidate split after freezing the prompt/settings.
npm run verify:live -- --split holdout --runs 5 --output evaluation-results/holdout.json
```

Native runs use http://127.0.0.1:11434 by default; OLLAMA_BASE_URL overrides this. The script loads .env. It creates temporary local gateways and calls the real extraction route, independently of the running Compose gateway/worker. Pause other model traffic while benchmarking. This is not a queue throughput benchmark.

Other flags: --thinking both|on|off, --timeout-ms 1..120000, --warmup 0..3, --seed 0..2147483647, --temperature 0..2, --split development|holdout|all. Defaults are both modes, five repetitions, one warmup per mode, 30 seconds (or LLM_TIMEOUT_MS), seed 42, temperature 0, development split. Explicit evaluation settings do not change the background worker's generation settings. Worker metadata uses null for generation options left to Ollama defaults.

There are five development examples and four candidate holdout examples. A default run can take roughly 28 minutes at the deadline; start with the quick check. Output files are ignored by git. JSON and .md reports share a basename.

## What gets measured

- Whole-document accuracy: every field must match.
- Field accuracy: correct fields / (five fields × all measured attempts).
- Per-field accuracy: supplierName, productName, countryOfOrigin, material and certificates.
- Timeouts, provider errors and invalid responses: each remains in the denominator and gets zero correct fields.
- Median/p95 latency: all measured requests, including failures. Warmups are stored separately and excluded from scores.

Strings match exactly, including case. Scalar null is a legitimate expected value. Certificates are one field: order is ignored, duplicates count as a mismatch. One wrong supplier with the other four fields correct yields 80% field accuracy and 0% whole-document accuracy. Many missing fields can make field accuracy look generous, so examine complete-record accuracy and individual cases too.

A conflicting origin with no confirmed resolution is annotated null in this dataset. That is our documented product rule, not a universal ML truth. If the model chooses one conflicting value, investigate the failure rather than silently changing the label. Changing rules/labels requires a dataset version change.

## Reproduction metadata and its limits

Each report includes dataset version and SHA-256, complete selected fixtures, prompt SHA-256, requested model, seed, temperature, thinking mode, deadline, code revision (when git is available), raw outputs and HTTP request IDs. Digest snapshots come from Ollama /api/tags before and after each mode. If a snapshot is unavailable or the observed digest changes across modes, modelIdentityConsistent is false and the gate fails.

Snapshots are observations, not an atomic guarantee of which weights served every request. Avoid pulling/replacing models during a run. Cloud aliases have no verified local weight digest and are not suitable for this local lab. A fixed seed does not guarantee identical output across hardware or Ollama versions. Record your Ollama version/hardware alongside experiments when sharing results. The code revision may refer to a checkout with local edits; use a clean committed checkout.

Modes currently run off then on; documents rotate between rounds. Warmups reduce cold-start bias, but fixed mode order, caching and background workloads still affect latency. Small-sample p95 is descriptive, not a production SLA.

Exit 0 means every measured document matched and all model identity observations were consistent. Exit 1 indicates incorrect output, errors or uncertain identity; inspect the report. This intentionally strict regression gate is not a claim of production readiness.

## Dataset discipline

evaluation/dataset-v1.json holds versioned synthetic fixtures with categories ordinary, missing, ambiguous and injection. Existing Alpine/Meridian attacks remain development regressions. Alpine appears in the system prompt, so it cannot count as independent evidence.

The holdout partition is a candidate reserved set created in this repository. It has not been independently curated or blinded. Do not tune the prompt using its results and continue calling it untouched: once used for tuning, move those examples into development in a new dataset version and collect fresh held-out examples. Synthetic success cannot establish general prompt-injection resistance.

## Background job traceability

GET /api/extraction-jobs/:id now includes attemptHistory. Each new claim atomically inserts an attempt containing initial provider configuration. A best-effort digest lookup updates that attempt before generation, within the existing total deadline. Model, system-prompt hash, thinking and explicit sampling settings are recorded per attempt. A lookup failure leaves digest null; it does not prevent serving.

Completion or failure saves the attempt outcome and elapsed claim-to-completion duration in the same transaction as the job state. Retry attempts can show different configurations if a worker was reconfigured between attempts. A crashed attempt becomes worker_interrupted when lease recovery observes it; finishedAt is the recovery observation time and durationMs remains null because the exact death time is unknown.

SQLite upgrades add a separate job_attempts table. Existing jobs remain intact. Historical completed jobs have empty attemptHistory because their provenance was never recorded. No values are invented retroactively. Stale attempts cannot overwrite newer provenance or results.

After pulling, rebuild the local containers without deleting the volume:

```powershell
docker compose -f compose.yaml -f compose.jobs.yaml up --build -d
```

Submit a new job and poll it with ConvertTo-Json -Depth 10 to inspect nested provenance. Do not use down -v unless deliberately deleting all job history.

## Verification

Automated tests use fake HTTP providers and real temporary SQLite files. They test scoring, report output, sampling option forwarding, digest handling, additive schema upgrade, attempt history, restart recovery and stale-write rejection. They do not execute the real model. The feature branch now triggers the existing GitHub CI build/tests; check its run before using the commit.

## Reading order

1. scripts/dataset.ts validates and selects the fixture partition.
2. scripts/verify-live.ts executes requests and captures experiment metadata.
3. scripts/evaluation.ts computes exact-document and field scores.
4. scripts/report.ts renders the comparison.
5. src/extraction/provenance.ts defines metadata; provider.ts observes Ollama identity.
6. src/jobs/store.ts and worker.ts persist per-attempt history.

Model output passing a schema remains separate from factual accuracy.
