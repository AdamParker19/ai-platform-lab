# AI Platform Lab

A hands-on backend-to-MLOps learning project: a TypeScript API gateway calling a Python inference service. Python 3.12 and Node.js 24 are the tested runtimes.

## What's here

- `inference-service/`: FastAPI, `/health`, `/predict`, a versioned scikit-learn sentiment artifact loaded once at startup.
- `api-gateway/`: Express + TypeScript, `/health`, `/api/analyze`, validation, a configurable inference deadline and graceful shutdown.
- Both services emit JSON request logs with latency and a shared request ID. Input text is not logged.
- Prediction responses include `prediction`, `confidence` and `modelVersion`.

The classifier is trained offline on the free UCI Amazon sentiment subset. Startup loads the saved pipeline, verifies its checksum and dependency versions, and never trains. Its probabilities are **not calibrated confidence**, and small-dataset results are not a production quality claim.

Start with [Challenge #4: ML to AWS walkthrough](docs/challenge-04-ml-to-aws.md) for the free dataset, training, metrics, local serving, Docker, and existing AWS publish/deploy/rollback workflows.

Continue with [Bedrock lab 1: provider and evaluation](docs/bedrock-lab-01-provider-and-evaluation.md)
for a five-case extraction smoke check with offline mocks, explicit live-call controls,
schema validation, supplier grounding, and latency/token/cost evidence.

## Bedrock request flight recorder

For one **live** diagnostic request, put your existing settings in
`api-gateway/.env` (plain `NAME=value` lines):

```dotenv
AWS_PROFILE=ai-platform-lab-login
AWS_REGION=ap-south-1
BEDROCK_REGION=ap-south-1
BEDROCK_MODEL_ID=apac.amazon.nova-micro-v1:0
```

From `api-gateway`, run:

```bash
npm run verify:bedrock:single
```

This submits only the first synthetic fixture using the existing provider,
Extractor, schema and grounding checks. There is one SDK attempt, no warm-up or
retries, a 30-second application deadline and a 256-output-token limit. The runner
prints lifecycle events, the final extraction and telemetry, and saves a JSON
report under `api-gateway/evaluation-results/`, including on provider failure.
The report destination is reserved before inference; an existing file is never
overwritten. `.env` is resolved from the project directory; already-set shell
variables take precedence. The existing `.env` remains git-ignored.

Use `npm run verify:bedrock:single -- --offline` to check this command without
AWS access, or `-- --output PATH` to choose a report path. Optional
`BEDROCK_TIMEOUT_MS` adjusts the deadline (1–120000 ms). Optional
`BEDROCK_INPUT_USD_PER_MILLION` and `BEDROCK_OUTPUT_USD_PER_MILLION` accept current
operator-reviewed prices; leave both unset to record unknown estimated cost.
Token usage is still reported when AWS provides it. A single fixture does not
establish model quality, and cancellation cannot prove AWS stopped processing.

Bedrock now emits JSON lifecycle events immediately, including while credentials or
the SDK are pending. Run the deterministic checks without AWS:

```bash
cd api-gateway
npm ci
node --import tsx --test tests/bedrock-lifecycle.test.ts tests/bedrock.test.ts tests/bedrock-smoke.test.ts
npm run verify:bedrock
```

The smoke runner prints lifecycle events to stderr and saves them per case in its
JSON report. It defaults to scripted offline responses. An injected sender skips
`credentials_resolved` unless a credential resolver is supplied; offline success
does not establish working AWS credentials or live model access.

Illustrative successful live request (IDs replaced, no request content):

```jsonl
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-001","stage":"starting","elapsedMs":0,"timestamp":"2026-11-12T12:00:00.000Z","awsRequestId":null,"errorCategory":null,"failure":null}
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-001","stage":"credentials_resolved","elapsedMs":5,"timestamp":"2026-11-12T12:00:00.005Z","awsRequestId":null,"errorCategory":null,"failure":null}
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-001","stage":"request_started","elapsedMs":6,"timestamp":"2026-11-12T12:00:00.006Z","awsRequestId":null,"errorCategory":null,"failure":null}
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-001","stage":"response_received","elapsedMs":250,"timestamp":"2026-11-12T12:00:00.250Z","awsRequestId":"aws-001","errorCategory":null,"failure":null}
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-001","stage":"completed","elapsedMs":251,"timestamp":"2026-11-12T12:00:00.251Z","awsRequestId":"aws-001","errorCategory":null,"failure":null}
```

An access-denied request follows the same first three stages, then ends with:

```jsonl
{"service":"bedrock-extraction","event":"request_lifecycle","requestId":"local-002","stage":"failed","elapsedMs":85,"timestamp":"2026-11-12T12:01:00.085Z","awsRequestId":"aws-002","errorCategory":"authorization_error","failure":{"name":"AccessDeniedException","code":null,"httpStatus":403}}
```

The provider's default 30-second deadline covers credential resolution and the SDK
call. It aborts the SDK and rejects the caller's wait even if the operation ignores
cancellation. Late credential resolution cannot start a request, and late SDK
settlement cannot emit a second terminal event. The gateway separately enforces
`LLM_TIMEOUT_MS` and returns HTTP 504, even for a provider that ignores its signal.

`request_started` means the adapter called the SDK; it does not prove a packet left
the machine or AWS received it. `completed` means model JSON parsed; schema and
grounding checks remain downstream. Local cancellation cannot guarantee AWS stopped
processing or that an invocation was unbilled. Startup failures before the runner
loads still require npm/Node terminal diagnostics.

Errors use the existing sanitized diagnostic helper: credentials →
`credentials_error`, permission denial → `authorization_error` (renamed from
`access_denied`), HTTP 429 → `throttled`, DNS/reset → `network_error`, deadline →
`timeout`. Only allowlisted error identifiers, HTTP status and request IDs are
logged; prompts, document content, SDK messages and credential values are omitted.
SDK `maxAttempts` stays explicitly **1** for this diagnostic lab. Neither gateway
nor adapter retries, so a timeout cannot silently multiply paid requests.

## Run locally

Terminal 1, from the repository root (Bash/WSL/macOS/Linux):

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r inference-service/requirements-dev.txt
cd inference-service
python train.py
uvicorn app:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell use `py -3.12 -m venv .venv` and `.venv\Scripts\Activate.ps1` instead of the first two commands.

Terminal 2, from the repository root:

```bash
cd api-gateway
npm ci
npm run build
npm start
```

For development use `npm run dev`. Configuration is read from environment variables; `.env.example` documents defaults but is not loaded automatically. Set `PORT`, `INFERENCE_URL` and `INFERENCE_TIMEOUT_MS` in your shell when needed.

Terminal 3:

```bash
curl http://localhost:8000/health
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"text":"This product is amazing"}'
```

On PowerShell, use `Invoke-RestMethod`:

```powershell
Invoke-RestMethod http://localhost:3000/api/analyze -Method Post -ContentType 'application/json' -Body '{"text":"This product is amazing"}'
```

## Checks

With your Python virtual environment activated, from the repo root:

```bash
cd inference-service
python -m pytest -q
cd ../api-gateway
npm run build
npm test
```

Gateway behavior: invalid input → 400; oversized JSON body → 413; inference failure/unavailable/invalid response → 502; inference deadline exceeded → 504. The default deadline is 3 seconds. A gateway timeout stops waiting; it does not guarantee cancellation of work already running inside the Python service. There are no automatic retries.

`/health` is a local process/liveness check; gateway health does not assert downstream availability. Inference startup finishes loading its model before serving traffic.

## Containers and AWS

```bash
docker compose up --build --detach --wait
# After your tests:
docker compose down
```

The inference Dockerfile trains in a build stage from the checksummed dataset;
the runtime image contains its artifact, metadata, and evaluation report. It does
not contact UCI during build or startup.

Existing main-only GitHub workflows publish both images to ECR, deploy a 15-minute
ECS lab with an independently verified shutdown schedule, and restore an earlier
stopped service revision. Branch CI tests code without granting branch workflows
AWS access. See the [walkthrough](docs/challenge-04-ml-to-aws.md).

## System-design exercise

For 10,000 requests/minute (~167 requests/second average), estimate per-replica throughput and p95 latency before choosing replica counts. Explain traffic spikes, concurrent requests, backpressure, overload rejection and how a rollout can be reversed.

Write your own answers as we go:

- Why keep inference replicas stateless, and where should model artifacts live?
- When is synchronous inference appropriate versus a queued job with a status endpoint?
- What does a timeout mean for a caller, and is retrying safe?
- How should model v2 be evaluated and canaried before replacing v1?
- Which service and model-quality metrics would trigger action?

License: see the existing LICENSE file.
