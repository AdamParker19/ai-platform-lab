# FLAN-T5 XL endpoint lab

Run these commands in PowerShell from the repository root. The preview works
with Python alone. The live smoke test also uses AWS CLI v2 and the gateway's
Node.js 24 development dependencies.

```powershell
python scripts/jumpstart_endpoint.py plan
```

The preview prints three requests. The SageMaker **model** links the execution
role, the serving image, and the model files. The **endpoint configuration**
selects the machine and count. The **endpoint** starts that configuration.

| Setting | Value |
| --- | --- |
| AWS Region | `ap-south-1` |
| JumpStart model | `huggingface-text2text-flan-t5-xl`, version `2.2.15` |
| Model, configuration and endpoint names | `ai-platform-lab-flan-t5-xl` |
| Machine | One `ml.g5.2xlarge` with local NVMe storage |
| Execution role | `ai-platform-lab-sagemaker-execution` |
| CLI profile and expected user | `ai-platform-lab-login`, `anmol-ai-platform-dev` |

The script uses the Mumbai JumpStart model spec's uncompressed S3 prefix,
container image, and network isolation settings. SageMaker loads the files on
the hosting instance. The configuration uses the G5 instance's local disk and
omits a custom EBS volume size. No Studio domain or notebook is required.
See the [model specification](https://jumpstart-cache-prod-ap-south-1.s3.ap-south-1.amazonaws.com/community_models/huggingface-text2text-flan-t5-xl/specs_v2.2.15.json)
and [AWS endpoint parameters](https://docs.aws.amazon.com/sagemaker/latest/dg/large-model-inference-hosting.html).

Use the read-only check to confirm the caller and see whether the names are
available. If the CLI session expired, renew it as `anmol-ai-platform-dev` with
`aws login --profile ai-platform-lab-login --region ap-south-1`.

```powershell
python scripts/jumpstart_endpoint.py check
```

The check tests identity and `Describe` access. Creation and invocation access
are exercised during a live run. The user policy covers the three named
SageMaker resources and `iam:PassRole` on the execution role. The role's
policies cover the JumpStart files, inference image, and endpoint logs.

## Live smoke test and teardown

Approve the cost before running this step. The Mumbai on-demand hosting rate
verified on November 19, 2026 was **$1.819 per instance-hour**, or **about $0.91 for 30
billable minutes** before any data processing, CloudWatch charges, taxes, or
credits. Hosting continues while the instance is idle. The script waits up to
20 minutes for readiness before attempting cleanup. Actual billing depends on
provisioning time and when AWS releases the hosting resources. See the
[AWS Mumbai price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/ap-south-1/index.json).

```powershell
npm --prefix api-gateway ci --include=dev
python scripts/jumpstart_endpoint.py run --approve-cost
```

When the endpoint reaches `InService`, the script submits the gateway's existing
product-extraction example once as `application/json`. It prints the response
and whether the extracted text matched `Steel Washers`. This is one smoke test.

Save the printed **Run ID**. The script attempts cleanup on success, failure,
and Ctrl+C. It checks the run tag before deleting and waits for the endpoint to
disappear before deleting its configuration and model. If SageMaker is still
creating or updating the endpoint, cleanup polls for up to five minutes and
retries deletion once the service permits it. If cleanup times out, resume with
the same Run ID and a longer endpoint cleanup window. If login expires, the
network drops, or the process is closed, review **SageMaker AI → Deployments &
inference → Endpoints** in Mumbai and resume cleanup with the saved ID.

```powershell
$runId = Read-Host "Paste the Run ID"
python scripts/jumpstart_endpoint.py cleanup --run-id $runId --wait-minutes 30
python scripts/jumpstart_endpoint.py check
```

The second command confirms all three names are absent. If the CLI remains
blocked, inspect the endpoint's run tag in the console, delete the endpoint
for that run, and verify it disappears before removing its configuration and
model. The CloudWatch log group `/aws/sagemaker/Endpoints/ai-platform-lab-flan-t5-xl`
may remain for debugging. Review its retention after the lab. See
[AWS endpoint cleanup](https://docs.aws.amazon.com/sagemaker/latest/dg/realtime-endpoints-delete-resources.html).
