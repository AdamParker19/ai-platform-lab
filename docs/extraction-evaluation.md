# Local extraction evaluation

Run from `api-gateway` with Ollama running and the chosen model already installed:

```powershell
npm ci
npm run verify:live
```

The default evaluates five synthetic documents, five times each, with thinking off and on: 50 measured requests. It also performs one warm-up request per mode. Requests run sequentially, with a 30-second server deadline and a slightly longer client deadline. The worst-case request budget is roughly 28 minutes; actual duration depends on your hardware and model. It starts its own temporary gateway on a random localhost port, so you do not need to restart your normal gateway or change its thinking setting. It does not call AWS.

For a short first run:

```powershell
npm run verify:live -- --runs 1
```

To change the configuration:

```powershell
$env:OLLAMA_MODEL = "qwen3:1.7b"
$env:OLLAMA_BASE_URL = "http://127.0.0.1:11434"
npm run verify:live -- --runs 5 --thinking both --timeout-ms 30000
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--runs` | 5 | Measured rounds per document and mode; 1–100 |
| `--thinking` | both | `both`, `on`, or `off`; explicitly overrides `OLLAMA_THINK` for this evaluation |
| `--timeout-ms` | `LLM_TIMEOUT_MS` or 30000 | Server deadline, 1–120000 ms |
| `--warmup` | 1 | Warm-up requests per mode, 0–3 |
| `--output` | Timestamped file in `evaluation-results/` | JSON report destination |

Reports include configuration, model tag, prompt hash, expected and actual values, request IDs, status codes, per-request latency, outcome counts, success rate, median latency, and p95 latency. Latency summaries include unsuccessful attempts. Warm-ups are recorded separately and excluded from measured summaries and acceptance. Only synthetic fixtures are used; do not add confidential supplier documents to fixtures or published reports.

The fixture set includes full information, missing information, the Alpine/HACKED regression, the Meridian/HACKED regression, and the Meridian administrator-override example. Every expected field is checked, not just the supplier name. Object-key ordering and certificate ordering are ignored; wrong values and duplicate certificates fail.

Exit code is **0 only when every measured extraction is correct**. Incorrect output, timeout, invalid response, provider error, or an incomplete evaluation exits **1**. A FAIL can mean the runner successfully found the known model weakness; do not change expected answers just to make it pass.

These are development/regression fixtures, not an independent final test or a security guarantee. The current system prompt includes the Alpine example. Model tags can refer to different artifacts over time, and this runner does not override seed or temperature. Thinking-off requests are evaluated before thinking-on requests; compare multiple evaluations before drawing performance conclusions.

## Automated runner verification

```powershell
npm run build
npm test
```

Runner integration tests launch a fake Ollama HTTP server, execute the CLI as a subprocess, inspect its saved report, and check its exit status. They verify correct answers, wrong answers, schema failures, upstream failures, and a hanging upstream request. They validate the evaluation machinery; they do not establish real-model quality or prompt-injection resistance.

The existing synthetic endpoint tests use prewritten mock outputs and prove contract handling only. The live runner is the separate quality check.
