# Bedrock lab 1: a measured, validated extraction provider

Time: 90–120 minutes, including the walkthrough and a small live smoke check once
account access is ready. The code and offline checks are prepared on
`feat/bedrock-extraction`. This lab extends the existing extraction interface.

## The idea

In the SageMaker lab, we supplied the server image and trained model archive.
Here, Amazon Bedrock supplies access to a foundation model through `Converse`.
We supply a prompt and document, then remain responsible for validating the
answer. The AWS SDK signs requests using the current AWS credential chain.

| Layer | Question it answers |
| --- | --- |
| Bedrock provider | Did the model return completed, parseable JSON? |
| Existing Zod schema | Are the required fields the right types? |
| Existing supplier grounding | Does the supplier agree with one labelled source value? |
| Smoke evaluation | Did the whole extraction match this synthetic example's gold answer? |

These are separate outcomes. Supplier `verified` means agreement with labelled
source text. It does not establish source authenticity or validate every field.
The prompt is not a security boundary. Missing or conflicting supplier labels
produce `needs_review`; a conflicting extracted value produces `mismatch`.
The extracted value remains available alongside that decision.

The bounded runner uses `Extractor.extractWithGrounding`. Ordinary gateway and
worker startup retain their Ollama configuration. In particular, the existing
`/api/extract` response contract still returns schema-validated extraction only;
it does not become a grounding-enforced publishing API. A future service that
publishes records must explicitly gate its business action on the appropriate
validation and review policy. Existing background-job retries are also separate
from this smoke runner's one-attempt policy.

## 1. Run locally with no AWS inference

From Windows PowerShell, starting at the repository root:

```powershell
git fetch origin
git switch feat/bedrock-extraction
git pull --ff-only origin feat/bedrock-extraction
cd api-gateway
npm ci
npm test
npm run build
npm run verify:bedrock
```

Use Node 24, matching the repository. The last command is **offline by default**,
even if `BEDROCK_MODEL_ID` is already set in your environment. It injects a
scripted Converse sender, with no credential lookup or AWS calls. It tests the
real Bedrock response adapter, Extractor, Zod validation and grounding together.

The five new synthetic fixtures are separate from our earlier development and
holdout data. Expected offline outcomes:

| Case | Scripted model behaviour | Grounding outcome |
| --- | --- | --- |
| Clean labelled document | Correct supplier | `verified` |
| Supplier only in prose | Correct supplier, no supported label | `needs_review` |
| Conflicting supplier labels | Chooses one supplier | `needs_review` |
| Prompt injection | Returns `HACKED` | `mismatch` |
| Fake message boundary | Returns `OVERRIDDEN` | `mismatch` |

The summary prints the report path under `evaluation-results/`. Open that JSON
file. It must say `mode: offline`, `modelQuality: null`, and have unknown token
usage and cost (`null`). Scripted output is not evidence of real model quality.

## 2. Understand the provider

Open `api-gateway/src/extraction/bedrock.ts` and follow these steps:

1. The constructor validates model, region, token limit and deadline. The real
   SDK client has `maxAttempts: 1`; the runner adds no retries or warm-up calls.
2. The command puts the versioned prompt in `system` and the document in the
   user message. It requests at most 256 output tokens in this lab. It does not
   claim that prompted JSON is a provider-enforced JSON schema.
3. The request ID and prompt version are sent as request metadata. The document
   and model output are excluded from the provider's telemetry.
4. An abort signal reaches the SDK. Truncated responses, filtering, tool requests
   and malformed JSON fail rather than becoming accepted extractions.
5. The Extractor validates the parsed value with the existing Zod schema, then
   applies the existing supplier grounding check. Provider telemetry saying
   `json_parsed` does not mean this downstream validation passed.

The provider records `clientLatencyMs`, service-reported `serviceLatencyMs`, token
usage, stop reason, AWS request ID, model ID and prompt hash. These timers have
different boundaries, just as our application timer differed from SageMaker's
metrics. An AWS model ID is not a model-weights digest: provenance explicitly
keeps `modelDigest: null` and `digestStatus: unavailable`.

## 3. Prepare the AWS identity and select a model

Use an existing scoped project profile. The commands below use the project's
`ai-platform-lab` profile; use its actual configured name if yours differs.

```powershell
$env:AWS_PROFILE = "ai-platform-lab"
aws sts get-caller-identity --profile $env:AWS_PROFILE
aws bedrock list-foundation-models --region ap-south-1 --by-provider Amazon --by-output-modality TEXT --by-inference-type ON_DEMAND --query "modelSummaries[].{Model:modelId,Provider:providerName}" --output table
```

The caller must have `bedrock:ListFoundationModels` for discovery. Listing a
model does not prove that the account can invoke it. Choose a small text model
that supports Converse and direct on-demand invocation in Mumbai. Check the
current model documentation, account eligibility and pricing before invoking.
No model ID or price is assumed in the code.

For the core lab, use a direct regional foundation model. If AWS requires an
inference profile instead, review its model resources, destination regions,
permissions and pricing before using it; changing the string alone is not a
complete IAM setup.

Grant the invoking identity a policy scoped to the selected model. Replace the
placeholder with the exact model ID returned by discovery:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DiscoverRegionalModels",
      "Effect": "Allow",
      "Action": "bedrock:ListFoundationModels",
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "ap-south-1" } }
    },
    {
      "Sid": "InvokeSelectedModel",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:ap-south-1::foundation-model/<MODEL_ID_FROM_DISCOVERY>",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "ap-south-1" } }
    }
  ]
}
```

`Converse` uses the `bedrock:InvokeModel` permission. This policy belongs to the
identity running the SDK, not the SageMaker execution role. The foundation-model
ARN has an empty account segment (`::`); that is intentional. Never put access
keys in the provider or commit credentials. This lab creates no IAM role or AWS
deployment automatically.

## 4. Run the explicitly enabled live smoke check

First review the selected model's current regional input/output rates and your
remaining AWS credits. Set these variables to actual values from that review:

```powershell
$env:BEDROCK_REGION = "ap-south-1"
$env:BEDROCK_MODEL_ID = "<SELECTED_AVAILABLE_MODEL_ID>"
$env:BEDROCK_PROMPT_VARIANT = "evidence-v2"
$inputPrice = "<CURRENT_USD_PER_MILLION_INPUT_TOKENS>"
$outputPrice = "<CURRENT_USD_PER_MILLION_OUTPUT_TOKENS>"
npm run verify:bedrock -- --live --input-usd-per-million $inputPrice --output-usd-per-million $outputPrice
```

Replace every placeholder. Both price arguments are required in live mode. The
rates are used for reporting; they do not set an AWS billing cap. Cost is a
token-only estimate from observed usage, not a bill. A timeout with no returned
usage has unknown cost, not zero cost.

The runner makes at most five sequential SDK attempts, with 256 output tokens
per call and a 30-second deadline. It stops early on permission, throttling or
transport failures and saves the attempted rows. It does not retry or switch
providers. Invalid model responses remain recorded and the run exits nonzero.
Mismatches and review outcomes are valid validation outcomes, recorded separately
from exact-match quality. Re-running the command starts another set of calls.

Reports include source revision, fixture hash, prompt hash, model identity,
per-case validation, latency and token usage. A partial live run has no aggregate
exact-match rate. A complete five-case run is still only a smoke check, not a
representative accuracy benchmark or a p95 performance measurement. Report files
use new names, and an explicitly reused path is rejected before inference.

The runner does not provision an endpoint or vector database. After a direct
on-demand run there is no endpoint to delete; review any other resources you
create separately. Offline report files remain local and are gitignored.

## Acceptance and certification alignment

- Automated mock tests pass for response mapping, schema failure, grounding,
  truncation, SDK failure categories, cancellation, telemetry privacy and budget
  controls. The existing gateway tests and TypeScript build still pass.
- The offline five-case report clearly identifies simulated results.
- The live report records the actual selected model and prompt, five attempted
  cases (or an explicitly partial failure), observed usage, and reviewed rates.
  If account access blocks the run, live verification remains incomplete.
- You can explain why JSON validity, source agreement, source authenticity and
  real model quality are different questions.

MLA-C02: foundation-model integration/evaluation, secure inference and operational
monitoring. AIP-C01: FM integration, implementation, safety, evaluation and
latency/cost troubleshooting. This exercises selected skills, not entire domains.
RAG, vector databases, agents and managed training pipelines are later labs.

## Official references

- [Converse API, permissions, usage and metrics](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [SDK default credential chain](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)
- [Bedrock IAM examples](https://docs.aws.amazon.com/bedrock/latest/userguide/security_iam_id-based-policy-examples.html)
- [Supported models and features](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html)
- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [MLA-C02 guide](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02.html)
- [AIP-C01 guide](https://docs.aws.amazon.com/aws-certification/latest/ai-professional-01/ai-professional-01.html)
