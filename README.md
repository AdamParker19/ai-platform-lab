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
