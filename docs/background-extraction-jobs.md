# Background extraction jobs

This local lab adds a durable queue, a separate worker and polling. No AWS resources are provisioned. Existing synchronous endpoints remain available; `/api/extract` bypasses the job queue's concurrency limit.

## Start locally (Windows PowerShell)

From the repository root:

```powershell
git fetch origin
git switch feat/llm-extraction
git pull --ff-only
cd api-gateway
npm ci
node --version
```

Use Node 24. SQLite is built into Node; no database package is required. Node may print an experimental SQLite warning. Reference: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html

Add/update these settings in your existing `api-gateway/.env`:

```dotenv
JOBS_ENABLED=true
JOB_DB_PATH=data/extraction-jobs.sqlite
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:1.7b
OLLAMA_THINK=true
LLM_TIMEOUT_MS=30000
```

Keep Ollama running with the configured model installed. In one terminal, from `api-gateway`:

```powershell
npm run dev
```

In a second terminal, also from `api-gateway`:

```powershell
npm run worker:dev
```

Restart the worker after changing `.env`; it does not use nodemon. `/health` checks the gateway, not worker/model readiness. The API can accept jobs while the model is unavailable; those jobs can fail after bounded retries.

## Submit, replay and poll

In a third PowerShell terminal:

```powershell
$key = [guid]::NewGuid().ToString()
$headers = @{ 'Idempotency-Key' = $key }
$body = @{ document = 'Supplier: Meridian Components. Product: Steel Washers.' } | ConvertTo-Json
$job = Invoke-RestMethod -Uri 'http://localhost:3000/api/extraction-jobs' -Method Post -ContentType 'application/json' -Headers $headers -Body $body
$job

# Reuse BOTH key and body for the same intended submission.
$replay = Invoke-RestMethod -Uri 'http://localhost:3000/api/extraction-jobs' -Method Post -ContentType 'application/json' -Headers $headers -Body $body
$replay.jobId -eq $job.jobId

# Rerun this until succeeded or failed.
Invoke-RestMethod -Uri "http://localhost:3000/api/extraction-jobs/$($job.jobId)" | ConvertTo-Json -Depth 6
```

The comparison should return `True`. Reusing the key with a different document returns 409. New intentional submissions require new keys. Keys are case-sensitive and global to this unauthenticated local lab, with 8–128 letters, digits, underscores or hyphens. Documents are trimmed before hashing; other content changes count as different documents.

| Request | Response |
|---|---|
| New key and valid document | 202, saved job and Location header |
| Existing key and same document | 200, same job; Idempotency-Replayed: true |
| Existing key and different document | 409 |
| Invalid input | 400 |
| Unknown job ID | 404 |
| Jobs disabled or storage full | 503 |

Replays return the existing job even after completion or failure. They do not restart terminal failures; use a new key to deliberately retry. Job responses include `jobId`, `status`, `attempts`, `createdAt`, `updatedAt`, and eventually `result` or `error`.

## Code walkthrough

Read these files in order:

1. `src/app.ts`: validates the key/document, saves the job, then returns immediately. The submission route does not call Ollama. GET reads status and results.
2. `src/jobs/store.ts`: one SQLite row stores the key, content hash, document and processing state. `BEGIN IMMEDIATE` takes the write lock before checking/inserting, and a UNIQUE constraint protects the key. Concurrent submissions cannot create duplicate jobs. The response happens after COMMIT. No transaction stays open during the LLM call.
3. `src/jobs/worker-main.ts`: a separate process polls every 250ms while idle. Both processes must use the same absolute database file; relative paths resolve from their working directories. Ctrl+C lets the current attempt finish.
4. `src/jobs/worker.ts`: claims one job, calls the existing Extractor with a deadline, saves the outcome, and logs job ID/attempt. Its started log links the original request ID to the job ID without logging the document or result.

| State | Meaning |
|---|---|
| queued | Saved; awaiting pickup or retry delay |
| running | Worker owns a temporary lease |
| succeeded | Output passed schema validation |
| failed | Invalid schema or attempts exhausted |

The lease lasts `LLM_TIMEOUT_MS + 5000`. An unexpired running lease prevents another local worker from claiming work, enforcing global concurrency one. Every claim receives a new random token. A result write must match that token and occur before lease expiry: a stale attempt cannot overwrite a newer attempt.

A future worker reclaims expired work after a crash. Three interrupted attempts become terminally failed. Provider errors and timeouts allow three total attempts, with delays of 1 second then 2 seconds. Invalid schema output fails immediately. Error codes: `provider_unavailable`, `extraction_timeout`, `invalid_model_response`, `worker_interrupted`. A queued retry can include its last attempt's error.

This does not guarantee exactly-once LLM execution. A crash after extraction but before saving causes another LLM call. Request idempotency prevents duplicate job creation; lease tokens prevent stale writes. They are separate guarantees. A provider that ignores cancellation could keep computing after the deadline; the worker cannot forcibly stop arbitrary remote computation.

## Verify recovery

1. Stop the worker and submit a new job. It remains queued.
2. Restart the gateway and poll the same ID. It still exists.
3. Start the worker. It processes that saved job.
4. To simulate a crash, forcibly kill the worker after a new job's `started` log. Restart it. After lease expiry, it claims another attempt. Normal Ctrl+C is graceful and may finish the attempt instead.
5. Stop Ollama and submit another key to observe bounded retries. Restart Ollama before submitting new work.

`npm test` checks real SQLite file reopen, duplicate submissions from separate Node processes, HTTP submission/polling, expired leases, stale writes, retries, invalid schemas and a provider ignoring cancellation. These tests use fake providers; they verify backend behavior, not real model quality. `npm run verify:live` remains the separate real-model evaluation tool.

## Optional Compose mode

Use this instead of native gateway/worker to avoid port conflicts. From the repository root:

```powershell
docker compose -f compose.yaml -f compose.jobs.yaml up --build -d
docker compose -f compose.yaml -f compose.jobs.yaml logs -f extraction-worker
```

The overlay shares one named volume between gateway and worker at `/app/data`. Both run as the image's non-root user and call host Ollama through `host.docker.internal`. Docker Desktop must be able to reach Ollama; check connectivity and Ollama's listening address if calls fail. Do not expose an unauthenticated Ollama listener to the public internet.

```powershell
docker compose -f compose.yaml -f compose.jobs.yaml down
```

Normal down retains the volume; `down -v` deliberately deletes all jobs, results and idempotency history. Native and Compose modes use different databases. The Compose overlay was not built/run in the implementation workspace; verify it locally.

## Limits and next step

This is a single-machine local lab. SQLite operations are synchronous and can briefly block Node during lock contention. Use local disk, not a shared network filesystem. There are at most 1,000 retained rows and three attempts per job. At capacity, existing-key replays work but new submissions return 503. Completed jobs/keys have no automatic expiry yet. Input documents are cleared on terminal completion/failure, but are stored on disk while pending/running; results remain on disk. Use synthetic documents.

To reset, stop both processes and remove native `api-gateway/data`, or deliberately remove the Compose volume. This also erases idempotency history. Local data/reports are excluded from git and Docker build context; keep JOB_DB_PATH in the protected data directory.

The API has no authentication or per-user result authorization. Keep it local. Production needs user-scoped keys, access control, retention and monitoring. Jobs are disabled unless JOBS_ENABLED=true. Do not enable this on ECS ephemeral task storage: replacement tasks would lose accepted jobs. Next we can replace local pickup with SQS and a durable shared job store while retaining this API contract.

`succeeded` means schema-valid output, not factual correctness or prompt-injection resistance. The live evaluation runner still measures whether the model extracts correctly.
