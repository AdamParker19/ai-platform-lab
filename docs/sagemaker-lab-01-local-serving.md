# SageMaker lab 1: prepare and test the serving interface locally

This lab prepares files for a later AWS deployment. It creates local Docker
images and a model archive. It does not publish to ECR, upload to S3, create IAM
roles, or deploy an endpoint. The existing ECS/Compose Dockerfile remains separate.

## What we are preparing

SageMaker needs an inference container and a trained model bundle. The container
contains the web server, prediction code, Python, and pinned dependencies. The
archive contains `model.joblib` and `metadata.json` at its root.

For the planned deployment, SageMaker will download `model.tar.gz` from S3 and
extract it into `/opt/ml/model` before starting the container. Python reads the
local files in that directory. SageMaker's execution role will need permission
to fetch the S3 archive; Python will not need to download it itself.

| Existing ECS service | Dedicated SageMaker build |
| --- | --- |
| Listen on port 8000 | Listen on port 8080 |
| Health route `/health` | Health route `/ping` |
| Prediction route `/predict` | Prediction route `/invocations` |
| Artifact copied into image | Artifact supplied through `/opt/ml/model` |
| Start Uvicorn directly | Accept SageMaker's `serve` command |

The routes share the existing model loader, validation, and prediction function.
Startup verifies the artifact and dependency versions before health can succeed.
The runtime image contains no training code and fails startup if no valid bundle
is mounted. `serve.py` starts one Uvicorn worker and forwards shutdown handling
to Uvicorn. This dedicated image uses root as required by AWS's custom-container
guidance; the ECS image continues to use its existing non-root user.

## Run on Windows PowerShell

Start Docker Desktop. Run these commands from the repository root. Build the
archive inside Docker: your Windows-trained bundle may use a different Python
version from the Python 3.12 serving image. This avoids that incompatibility.

```powershell
docker build --platform linux/amd64 -f inference-service/Dockerfile.sagemaker --target artifacts --output type=local,dest=./sagemaker-output inference-service
docker build --platform linux/amd64 -f inference-service/Dockerfile.sagemaker --target runtime -t ai-platform-lab-sagemaker:local inference-service
```

The first command trains from the checksummed UCI data, validates the bundle,
and exports `model.tar.gz`, `metadata.json`, and `evaluation.json`. The second
builds only the inference runtime. Both use the same Python base and package pins.
The packager prints the model version, model-file SHA-256, and archive SHA-256.
These hashes identify different things: an image digest identifies the container;
the archive hash identifies the model package we will upload separately.

Extract the trusted archive we just built and mount it read-only, simulating the
directory SageMaker supplies:

```powershell
New-Item -ItemType Directory -Force .\sagemaker-output\model | Out-Null
tar -xzf .\sagemaker-output\model.tar.gz -C .\sagemaker-output\model
$modelDirectory = (Resolve-Path .\sagemaker-output\model).Path
docker run --detach --name sagemaker-lab-local -p 127.0.0.1:18080:8080 --mount "type=bind,source=$modelDirectory,target=/opt/ml/model,readonly" ai-platform-lab-sagemaker:local serve
```

Allow a few seconds for startup, then run:

```powershell
Invoke-RestMethod http://127.0.0.1:18080/ping
Invoke-RestMethod http://127.0.0.1:18080/invocations -Method Post -ContentType 'application/json' -Body '{"text":"Excellent quality and easy to use"}' -ErrorAction Stop
docker logs sagemaker-lab-local
```

Expected: health `ok`, a positive/negative prediction, and model version
`sentiment-uci-amazon-v1`. A successful local response verifies our serving
interface; it does not verify AWS permissions or SageMaker deployment.

If startup fails, inspect the logs first. A missing artifact means the mount
does not contain both required files. Dependency mismatch means training and
serving used different environments; rebuild the archive with this Dockerfile.
If port 18080 is occupied, use a free host port and update the test URLs.

Clean up the local container:

```powershell
docker rm --force sagemaker-lab-local
```

## Verification and next AWS step

Continue with [lab 2: publish the serving image](sagemaker-lab-02-publish-image.md)
after completing the local checks below.

Python tests cover both route contracts, packaging/extraction, deterministic
repackaging, corrupt bundles, and failed startup with missing artifacts. CI also
builds both Docker targets and invokes the mounted artifact over HTTP.

After this local check, we will choose actual resource names and prepare the
SageMaker execution role, S3 upload, ECR publishing, endpoint configuration,
invocation, and cleanup. No names for those new resources have been created by
this lab. The existing ECS shutdown schedule only controls ECS; a SageMaker
endpoint needs its own cleanup procedure.

Our first endpoint can use on-demand Serverless Inference for a small CPU model.
It supports cold starts and scales compute to zero when idle. Requests, storage,
and other resources can still incur charges. We will verify account access and
quotas before creating it. Later JumpStart/foundation-model practice may require
different endpoint options and compute.

## Official references

- [Custom inference container contract](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html)
- [Serverless Inference behavior and limitations](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html)
- [Model deployment workflow](https://docs.aws.amazon.com/sagemaker/latest/dg/deploy-model-get-started.html)
