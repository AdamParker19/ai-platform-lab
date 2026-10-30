# SageMaker lab 2: publish the tested serving image

The local lab verified that our container can load a model bundle and answer
SageMaker's HTTP routes. This step stores that serving image in our existing ECR
repository so SageMaker can pull it later. Publishing consumes ECR storage; it
does not start an AWS endpoint or change the ECS service.

## Resources for this lab

| Resource | Value |
| --- | --- |
| AWS account | `501683248889` |
| Region | `ap-south-1` (Mumbai) |
| ECR repository | `ai-platform-lab/inference` |
| GitHub publishing role | `arn:aws:iam::501683248889:role/ai-platform-lab-github-publisher` |
| SageMaker execution role | `arn:aws:iam::501683248889:role/ai-platform-lab-sagemaker-execution` |
| Model bucket | `ai-platform-lab-models-501683248889-ap-south-1` |

The model archive location selected for this lab is:

```text
s3://ai-platform-lab-models-501683248889-ap-south-1/models/sentiment-uci-amazon-v1/91459352f7767d20742f9adaeec22d9dfab4c8d322d7f6f841dfe1aab8ce488c/model.tar.gz
```

The hexadecimal directory names the local archive's SHA-256. Naming a key after
a hash does not make S3 verify the bytes or prevent an overwrite. Keep the
archive private and retain its hash; this publishing workflow does not read or
verify the uploaded S3 object.

## Understand the two roles

| Role | Who uses it | What it does here |
| --- | --- | --- |
| GitHub publisher | GitHub Actions through OIDC | Upload the tested container to ECR |
| SageMaker execution | SageMaker during endpoint preparation and hosting | Read the model archive, pull the container, and write logs/metrics |

The new execution role's ARN has been supplied by the lab operator. Verify that
its trust and permission policies match the lab setup in IAM; an ARN alone does
not verify those policies. Its S3 grant should name the exact archive above. Its
log grant covers future endpoint names beginning with `ai-platform-lab-`.

The publisher already publishes to `ai-platform-lab/inference`. This workflow
uses that existing role and repository. It does not need permission to assume
or pass the SageMaker execution role, because it does not create a SageMaker
model or endpoint. Preserve the publisher's existing main-branch OIDC trust.

## Run the publishing workflow

1. Review and merge the SageMaker changes in PR #3 into `main`, then confirm CI
   succeeds on `main`.
2. Open GitHub Actions and select **Publish SageMaker image**. The workflow must
   be on the default branch before GitHub exposes its manual run control.
3. Choose **Run workflow**, select **main**, and run it.
4. Open the run's **Summary** after it succeeds. Copy **Image tag URI**, **Image
   digest URI**, and **Source commit** into your deployment notes.

The workflow runs Python tests, builds a compatible sample model archive and
the Linux AMD64 runtime image, mounts the extracted bundle, and checks `/ping`
and `/invocations`. Only after those checks pass does it request temporary AWS
credentials and push the same runtime image to ECR. The sample archive used by
the workflow stays on the GitHub runner; your selected S3 archive is separate.

The image tag begins with `sagemaker-sha-` and includes the source commit, run ID,
and attempt. This distinguishes it from the existing ECS images, whose tags
begin with `sha-`. The SageMaker runtime expects port 8080 and an external model
at `/opt/ml/model`; it is not a replacement for the current ECS image.

## Read the result

An image digest URI looks like:

```text
501683248889.dkr.ecr.ap-south-1.amazonaws.com/ai-platform-lab/inference@sha256:<64 hexadecimal characters>
```

The image digest identifies the server code, Python environment, dependencies,
and image configuration. The S3 archive hash identifies the trained model
package. A deployment record needs both because changing either can change
predictions or serving behavior.

If publishing fails, read the first failed step. Test or smoke failures occur
before AWS credentials are requested. An OIDC failure points to the publisher
trust policy and main-branch selection. ECR `AccessDenied` points to the
publisher's permissions for the existing inference repository, not the SageMaker
execution role.

After publication, the next lab will connect this image, the S3 archive, and the
execution role in a SageMaker model definition. Endpoint creation, account quota
checks, invocation, and AWS endpoint cleanup are still subsequent steps. The
existing ECS shutdown schedule does not manage SageMaker endpoints.

## Official references

- [Manually running a GitHub Actions workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- [Pushing an image to private ECR](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)
- [SageMaker execution-role permissions](https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-roles.html)
- [SageMaker custom-container contract](https://docs.aws.amazon.com/sagemaker/latest/dg/your-algorithms-inference-code.html)
