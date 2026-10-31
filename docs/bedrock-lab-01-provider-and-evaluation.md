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
aws bedrock list-foundation-models --region ap-south-1 --query "{Total:length(modelSummaries),AmazonModels:modelSummaries[?starts_with(modelId, 'amazon.')].{Model:modelId,Provider:providerName,Output:outputModalities,Inference:inferenceTypesSupported}}" --output json --no-cli-pager
```

Start with an unfiltered regional API request, then inspect Amazon model IDs in
the response. Applying provider, modality and inference filters together can
produce an empty table without identifying which filter excluded the results.
The `Total` count distinguishes an empty catalog response from an empty Amazon
subset. No model is invoked by this discovery command.

The caller needs `bedrock:ListFoundationModels` for catalog discovery and
`bedrock:ListInferenceProfiles` for the next command. Listing a model or an
`ACTIVE` profile does not prove that this identity can invoke it.

Our account's Mumbai catalog on 31 October 2026 reports `INFERENCE_PROFILE` for
the Amazon text models, including Nova Micro. The earlier `ON_DEMAND` filter
excluded them. Use an existing system-defined profile; no new profile or
endpoint is needed. From the same PowerShell terminal:

```powershell
aws bedrock list-inference-profiles --region ap-south-1 --type-equals SYSTEM_DEFINED --query "{Total:length(inferenceProfileSummaries),NovaMicro:inferenceProfileSummaries[?contains(inferenceProfileId, 'nova-micro')].{Id:inferenceProfileId,Arn:inferenceProfileArn,Status:status,Models:models[].modelArn}}" --output json --no-cli-pager
```

The account returned the active profile `apac.amazon.nova-micro-v1:0`, with ARN
`arn:aws:bedrock:ap-south-1:501683248889:inference-profile/apac.amazon.nova-micro-v1:0`.
Its returned destination model ARNs cover these Regions:

| Region | Location |
| --- | --- |
| `ap-south-1` | Mumbai |
| `ap-southeast-2` | Sydney |
| `ap-northeast-1` | Tokyo |
| `ap-northeast-2` | Seoul |
| `ap-southeast-1` | Singapore |
| `ap-northeast-3` | Osaka |

Requests enter Bedrock in Mumbai and may be processed in any of those Regions.
Use only the lab's synthetic documents. The profile does not promise India-only
processing. Inspect the actual returned ARNs rather than guessing destinations
from the `apac` prefix. The SDK's `modelId` parameter accepts this profile ID or
ARN; it does not require a provider code change.

The exact invocation policy is in
[bedrock-nova-micro-invoke-policy.json](bedrock-nova-micro-invoke-policy.json).
It grants non-streaming `bedrock:InvokeModel` on the profile and its six model
ARNs. The model statement uses `bedrock:InferenceProfileArn` to allow those model
resources only through this profile. Do not replace it with a grant on only the
Mumbai foundation-model ARN. An explicit region Deny or organization SCP that
blocks a destination can still block the profile.

Attach the policy to the IAM user or role used by the local SDK. Identify it
using `aws sts get-caller-identity --no-cli-pager` in the same Windows terminal
where you will run Node, with the intended project credentials/profile selected.
CloudShell's identity can differ from Windows. This is not a permission for the
SageMaker execution role. If the ARN is an STS assumed-role ARN, the policy
belongs on the underlying IAM role, not the temporary session. If the local
profile is missing or the ARN ends in `:root`, resolve the project identity before
running the live test; do not create root access keys for this lab.

The policy file contains invocation grants only; retain separately reviewed
discovery permissions if needed. It does not remove permissions granted by other
policies or override explicit Deny statements. The foundation-model ARNs have an
empty account segment (`::`); that is intentional. Never put access keys in the
provider or commit credentials. This lab creates no IAM role or AWS deployment
automatically.

## 4. Run the explicitly enabled live smoke check

First review your remaining AWS credits and the selected model's current rates.
Inference-profile pricing is based on the source Region (Mumbai here).

On 31 October 2026, AWS's
[Mumbai Bedrock price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json)
(published `2026-10-30T16:04:56Z`, terms effective `2026-10-01T00:00:00Z`)
lists these standard on-demand Nova Micro rates:

| Usage | USD per 1,000 tokens | USD per million tokens |
| --- | --- | --- |
| Input | $0.000041 | $0.041 |
| Output | $0.000164 | $0.164 |

These are not batch or cache-read rates. The runner does not request prompt
caching. Recheck rates for later runs or a different model/Region. After the
invoking identity and policy are ready, run from `api-gateway`:

```powershell
$env:BEDROCK_REGION = "ap-south-1"
$env:BEDROCK_MODEL_ID = "apac.amazon.nova-micro-v1:0"
$env:BEDROCK_PROMPT_VARIANT = "evidence-v2"
$inputPrice = "0.041"
$outputPrice = "0.164"
npm run verify:bedrock -- --live --input-usd-per-million $inputPrice --output-usd-per-million $outputPrice
```

Both price arguments are required in live mode. The
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

The runner does not provision an endpoint or vector database. After this
profile-based run there is no endpoint to delete; review any other resources you
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
- [Inference profiles and source-Region pricing](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
- [Inference profile IAM prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)
- [List inference profiles](https://docs.aws.amazon.com/cli/latest/reference/bedrock/list-inference-profiles.html)
- [Supported models and features](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html)
- [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [MLA-C02 guide](https://docs.aws.amazon.com/aws-certification/latest/machine-learning-engineer-associate-02/machine-learning-engineer-associate-02.html)
- [AIP-C01 guide](https://docs.aws.amazon.com/aws-certification/latest/ai-professional-01/ai-professional-01.html)
