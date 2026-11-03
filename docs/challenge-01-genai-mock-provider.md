# Week 1 — Mockable GenAI endpoint (NVIDIA NCA-AMAD + AWS SAA-C03)

**Branch:** `feat/genai-rag`. This challenge is offline. No AWS account, billing, model download, Ollama instance or API key is needed.

## Why this architecture?

The repository already has two features that we must preserve:

- `POST /api/analyze` → TypeScript gateway → FastAPI `/predict` → versioned sentiment classifier.
- `POST /api/extract` → TypeScript `ExtractionProvider` / Ollama and existing mock → structured supplier-data extraction.

The new feature is independent:

```text
Client
  | POST /api/generate {"prompt":"..."}
  v
Express Gateway (input checks, x-request-id, 3s deadline)
  | POST /generate, forwards x-request-id
  v
FastAPI (Pydantic request/response, 2s deadline)
  | async GenAIProvider.generate(prompt, request_id)
  v
MockGenAIProvider (fully deterministic; no external calls)
```

The Python `GenAIProvider` is a `typing.Protocol`: a structural interface. The app depends on its behavior, not on a concrete vendor implementation. A future Ollama/NVIDIA NIM/Bedrock adapter can implement this contract without rewriting the API, and tests can inject failure providers.

## Step 1 — Run locally

From the repository root:

```bash
git switch feat/genai-rag
docker compose up --build --detach --wait
```

Docker Compose still exposes only the gateway at `127.0.0.1:3000`. The inference service is internal to the Compose network.

## Step 2 — Send one request

Bash / WSL:

```bash
curl -sS http://127.0.0.1:3000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain embeddings simply"}'
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/generate -Method Post -ContentType 'application/json' -Body '{"prompt":"Explain embeddings simply"}'
```

Expected shape (latency and request ID vary):

```json
{
  "text": "[MOCK] Received: Explain embeddings simply",
  "modelVersion": "mock-genai-v1",
  "requestId": "abcdef1234...",
  "latencyMs": 0.02
}
```

The `x-request-id` response header matches the JSON `requestId` field and the ID forwarded to FastAPI. `latencyMs` is **generation-handler latency in the Python service**, not full network round-trip time.

**Important:** The echo is a deterministic mock output, **not an actual LLM-generated answer**.

## Step 3 — Verify sentiment has not changed

```bash
curl -sS http://127.0.0.1:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{"text":"This product is amazing"}'
```

It should still return `prediction`, `confidence` and `modelVersion`.

## Step 4 — Validate failure contracts

Try an empty prompt:

```bash
curl -i http://127.0.0.1:3000/api/generate \
  -H 'Content-Type: application/json' -d '{"prompt":" "}'
```

The gateway returns HTTP 400 with a structured error:

```json
{
  "error": {
    "code": "INVALID_PROMPT",
    "message": "prompt must contain 1–2000 characters; no extra fields allowed"
  },
  "requestId": "..."
}
```

Additional outcomes:

| Failure | Gateway status | Code |
|---|---|---|
| Malformed JSON | 400 | `INVALID_JSON` |
| Body over 32 KB | 413 | `REQUEST_TOO_LARGE` |
| Bad or empty provider response | 502 | `INVALID_UPSTREAM_RESPONSE` |
| Python service unavailable | 502 | `UPSTREAM_UNAVAILABLE` |
| Python returns a provider timeout | 504 | `PROVIDER_TIMEOUT` |
| Gateway deadline expires | 504 | `GATEWAY_TIMEOUT` |

Existing routes keep their original error response contracts.

## Step 5 — Run regression tests

If running without Docker, set up the Python 3.12 environment and follow `README.md` to install dependencies and train the local sentiment model artifact. Then:

```bash
cd inference-service
python -m pytest -q
cd ../api-gateway
npm ci
npm test
npm run build
```

The new Python tests cover success, bad input, provider failure, invalid provider output, a 2-second timeout, and preservation of sentiment. The new gateway tests use an in-memory fake HTTP upstream to check successful routing, validation, model metadata, request-ID propagation, upstream 5xx, timeouts and unreachable service.

No tests invoke remote AI providers. Feature-branch pushes do not run the AWS publishing/deployment workflows.

## Learning notes for NVIDIA NCA-AMAD

- **Token:** A model's unit of input/output text processing; not necessarily a whole word. Real provider integrations track input/output token usage. The mock does not tokenize.
- **Context window:** The maximum amount of tokens that a model can attend to in a request, including prompts, retrieved context and generated output. Our 2,000-character API cap is *not* a model context-window measurement.
- **Embedding:** A numeric vector representing semantic properties of text. It enables nearest-neighbor retrieval, but embeddings alone do not generate answers.
- **RAG:** Retrieve relevant documents and supply them as context at inference time. Useful when answers depend on updatable, attributable evidence.
- **Fine-tuning:** Adjust model weights through training. Useful for specialized behavior or output patterns; not a substitute for current document retrieval.
- **Mock provider:** A replaceable fake that makes tests deterministic, cheap and fast. It tests integration and reliability contracts, **not answer quality**.

## Learning notes for AWS SAA-C03

- **Loose coupling:** Your gateway does not need to know which model vendor serves the response. Swapping the provider should not change the gateway API.
- **Timeout budgeting:** The Python timeout (2s) is lower than the gateway timeout (3s). Clients must still bound their own deadlines.
- **Reliability:** A 502 indicates an upstream failure or invalid contract; a 504 indicates a timeout. Neither should silently be treated as a successful model answer.
- **Traceability:** Carry the same request ID between services. Avoid logging raw prompts or credentials.

## End-of-week teach-back

1. Why is a `Protocol` better here than importing an Ollama SDK directly into `app.py`?
2. Why is the gateway's timeout slightly longer than FastAPI's timeout?
3. What does the current mock prove, and what **doesn't** it prove?
4. Why should `/api/analyze` and `/api/generate` remain separate?
5. When should a product use RAG instead of fine-tuning?

## Shut down locally

```bash
docker compose down
```

This stops local containers. It does not create, modify or bill any AWS resources.
