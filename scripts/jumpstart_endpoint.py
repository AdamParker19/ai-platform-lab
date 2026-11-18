"""Preview or run a single FLAN-T5 XL endpoint smoke test in the Mumbai lab."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

REGION = "ap-south-1"
ACCOUNT = "501683248889"
DEPLOYER = f"arn:aws:iam::{ACCOUNT}:user/anmol-ai-platform-dev"
EXECUTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/ai-platform-lab-sagemaker-execution"
DEFAULT_PROFILE = "ai-platform-lab-login"
NAME = "ai-platform-lab-flan-t5-xl"
RUN_TAG = "ai-platform-lab-run"
MODEL_ID = "huggingface-text2text-flan-t5-xl"
MODEL_VERSION = "2.2.15"
MODEL_FILES = f"s3://jumpstart-cache-prod-{REGION}/huggingface-text2text/{MODEL_ID}/artifacts/inference/v2.0.0/"
IMAGE = (
    f"763104351884.dkr.ecr.{REGION}.amazonaws.com/huggingface-pytorch-tgi-inference:"
    "2.4.0-tgi2.4.0-gpu-py311-cu124-ubuntu22.04"
)
INSTANCE = "ml.g5.2xlarge"
READY_TIMEOUT = 20 * 60
CLEANUP_TIMEOUT = 5 * 60
POLL_INTERVAL = 10
GATEWAY = Path(__file__).resolve().parents[1] / "api-gateway"

# The endpoint must be gone before deleting its configuration and model.
NAME_FIELDS = {"endpoint": "EndpointName", "endpoint-config": "EndpointConfigName", "model": "ModelName"}
ENDPOINT_IN_PROGRESS = {"Creating", "Updating", "SystemUpdating", "RollingBack"}


def deployment_requests(run_id):
    tags = [{"Key": RUN_TAG, "Value": run_id}]
    return {
        "model": {
            "ModelName": NAME,
            "ExecutionRoleArn": EXECUTION_ROLE,
            "EnableNetworkIsolation": True,
            "PrimaryContainer": {
                "Image": IMAGE,
                "ModelDataSource": {
                    "S3DataSource": {"S3Uri": MODEL_FILES, "S3DataType": "S3Prefix", "CompressionType": "None"}
                },
                # Container settings from the pinned JumpStart model spec.
                "Environment": {
                    "ENDPOINT_SERVER_TIMEOUT": "3600",
                    "HF_MODEL_ID": "/opt/ml/model",
                    "MAX_INPUT_LENGTH": "1024",
                    "MAX_TOTAL_TOKENS": "2048",
                    "MODEL_CACHE_ROOT": "/opt/ml/model",
                    "SAGEMAKER_CONTAINER_LOG_LEVEL": "20",
                    "SAGEMAKER_ENV": "1",
                    "SAGEMAKER_MODEL_SERVER_TIMEOUT": "3600",
                    "SAGEMAKER_MODEL_SERVER_WORKERS": "1",
                    "SAGEMAKER_PROGRAM": "inference.py",
                    "SAGEMAKER_SUBMIT_DIRECTORY": "/opt/ml/model/code",
                    "SM_NUM_GPUS": "1",
                },
            },
            "Tags": tags,
        },
        "endpoint-config": {
            "EndpointConfigName": NAME,
            "ProductionVariants": [{
                "VariantName": "AllTraffic",
                "ModelName": NAME,
                "InitialInstanceCount": 1,
                "InstanceType": INSTANCE,
                "ModelDataDownloadTimeoutInSeconds": 1200,
                "ContainerStartupHealthCheckTimeoutInSeconds": 1200,
            }],
            "Tags": tags,
        },
        "endpoint": {"EndpointName": NAME, "EndpointConfigName": NAME, "Tags": tags},
    }


class AwsError(RuntimeError):
    def __init__(self, operation, stderr):
        # The AWS CLI's human-readable formats include the API error code in parentheses.
        match = re.search(r"An error occurred \((\w+)\)", stderr)
        self.code = match[1] if match else None
        self.details = stderr
        super().__init__(f"AWS {operation} failed: {stderr}")


def aws(profile, service, operation, *args, request=None):
    command = [
        "aws", service, operation, "--profile", profile, "--region", REGION,
        "--output", "json", "--no-cli-pager", "--no-cli-auto-prompt",
        "--cli-connect-timeout", "8", "--cli-read-timeout", "65",
        *args,
    ]
    if request is not None:
        command.extend(["--cli-input-json", json.dumps(request)])
    result = subprocess.run(
        command, capture_output=True, encoding="utf-8", errors="replace", timeout=80,
        env={**os.environ, "AWS_MAX_ATTEMPTS": "1", "AWS_CLI_ERROR_FORMAT": "legacy",
             "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true"},
    )
    if result.returncode:
        raise AwsError(operation, result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def require_lab_user(profile):
    identity = aws(profile, "sts", "get-caller-identity")
    if identity.get("Arn") != DEPLOYER:
        raise RuntimeError(f"Use the AWS CLI profile for {DEPLOYER}. Current identity: {identity.get('Arn')}")


def describe(profile, resource):
    try:
        return aws(profile, "sagemaker", f"describe-{resource}", request={NAME_FIELDS[resource]: NAME})
    except AwsError as error:
        if (error.code == "ValidationException" and NAME in error.details
                and re.search(r"could not find|not found|does not exist", error.details, re.IGNORECASE)):
            return None
        raise


def check(profile):
    require_lab_user(profile)
    for resource in NAME_FIELDS:
        if describe(profile, resource) is not None:
            raise RuntimeError(f"{resource} {NAME} already exists. Resolve it before starting a new run.")
    print(f"Verified {DEPLOYER} and confirmed the three lab resource names are available in {REGION}.", flush=True)


def wait_for_endpoint(profile, *, timeout=READY_TIMEOUT):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        endpoint = describe(profile, "endpoint")
        status = endpoint["EndpointStatus"] if endpoint else "Not visible yet"
        if status != previous:
            print(f"Endpoint status: {status}", flush=True)
            previous = status
        if status == "InService":
            return
        if status in {"Failed", "OutOfService", "Deleting", "UpdateRollbackFailed"}:
            raise RuntimeError(f"Endpoint {status}: {endpoint.get('FailureReason', '')}")
        time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
    raise RuntimeError(f"Endpoint did not reach InService within {timeout} seconds.")


def wait_for_ownership(profile, resource, run_id):
    arn = f"arn:aws:sagemaker:{REGION}:{ACCOUNT}:{resource}/{NAME}"
    deadline = time.monotonic() + 30
    while True:
        tags = aws(profile, "sagemaker", "list-tags", "--resource-arn", arn).get("Tags", [])
        owner = next((tag["Value"] for tag in tags if tag["Key"] == RUN_TAG), None)
        if owner == run_id:
            return
        if owner is not None or time.monotonic() >= deadline:
            raise RuntimeError(f"Refusing to delete {arn} without matching run tag {run_id}.")
        time.sleep(2)


def delete_endpoint(profile, run_id, current):
    deadline = time.monotonic() + CLEANUP_TIMEOUT
    deletion_requested = False
    previous_status = None
    wait_reported = False

    while current is not None:
        status = current["EndpointStatus"]
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Endpoint {NAME} was still {status} when cleanup timed out. Retry cleanup.")
        if status != previous_status:
            print(f"Endpoint status during cleanup: {status}", flush=True)
            if current.get("FailureReason"):
                print(f"Endpoint failure: {current['FailureReason']}", flush=True)
            previous_status = status

        if not deletion_requested and status not in ENDPOINT_IN_PROGRESS and status != "Deleting":
            # Recheck the tag before each delete, including after a state change or retry.
            wait_for_ownership(profile, "endpoint", run_id)
            try:
                aws(profile, "sagemaker", "delete-endpoint", request={"EndpointName": NAME})
            except AwsError as error:
                if error.code != "ValidationException" or "cannot update in-progress endpoint" not in error.details.lower():
                    raise
                if not wait_reported:
                    print("SageMaker is still changing the endpoint. Waiting to retry deletion.", flush=True)
                    wait_reported = True
            else:
                deletion_requested = True
                print(f"Deletion requested for endpoint {NAME}.", flush=True)
                current = describe(profile, "endpoint")
                continue

        time.sleep(min(POLL_INTERVAL, max(0, deadline - time.monotonic())))
        current = describe(profile, "endpoint")


def cleanup(profile, run_id, uncertain_resource=None):
    for resource, field in NAME_FIELDS.items():
        current = describe(profile, resource)
        if current is None and resource == uncertain_resource:
            # A cancelled or timed-out create can still arrive at SageMaker.
            deadline = time.monotonic() + 30
            while current is None and time.monotonic() < deadline:
                time.sleep(2)
                current = describe(profile, resource)
            if current is None:
                raise RuntimeError(f"Creation of {resource} was interrupted and its status is uncertain.")
        if current is None:
            continue
        wait_for_ownership(profile, resource, run_id)
        if resource == "endpoint":
            delete_endpoint(profile, run_id, current)
            continue
        print(f"Deleting {resource} {NAME}.", flush=True)
        aws(profile, "sagemaker", f"delete-{resource}", request={field: NAME})
        if describe(profile, resource) is not None:
            raise RuntimeError(f"{resource} {NAME} is still visible after deletion. Retry cleanup if it remains.")
    print("Cleanup complete. The endpoint, configuration, and model are absent.", flush=True)


def build_fixture():
    result = subprocess.run(
        ["node", "--import", "tsx", "scripts/jumpstart-preflight.ts"], cwd=GATEWAY,
        capture_output=True, encoding="utf-8", timeout=30,
    )
    if result.returncode:
        raise RuntimeError(f"Build the request with the gateway's dev dependencies installed: {result.stderr.strip()}")
    return json.loads(result.stdout)


def invoke_once(profile, fixture):
    with tempfile.TemporaryDirectory(prefix="jumpstart-smoke-") as directory:
        body = Path(directory) / "request.json"
        output = Path(directory) / "response.json"
        body.write_text(json.dumps(fixture), encoding="utf-8")
        metadata = aws(
            profile, "sagemaker-runtime", "invoke-endpoint",
            "--endpoint-name", NAME, "--content-type", "application/json", "--accept", "application/json",
            "--body", f"fileb://{body.as_posix()}", str(output),
        )
        response = json.loads(output.read_text(encoding="utf-8"))
    generated = response[0] if isinstance(response, list) and response else response
    prediction = generated.get("generated_text") if isinstance(generated, dict) else None
    matches = isinstance(prediction, str) and prediction.strip() == "Steel Washers"
    print(json.dumps({"metadata": metadata, "response": response, "expectedProductMatched": matches}, indent=2), flush=True)
    if not matches:
        raise RuntimeError("The endpoint responded but the fixture did not match the expected product name.")


def run(profile):
    fixture = build_fixture()
    check(profile)

    run_id = uuid.uuid4().hex
    print(f"Run ID: {run_id}. Save this ID in case cleanup is interrupted.", flush=True)
    uncertain_resource = None
    try:
        for resource, request in deployment_requests(run_id).items():
            print(f"Creating {resource} {NAME}.", flush=True)
            uncertain_resource = resource
            try:
                aws(profile, "sagemaker", f"create-{resource}", request=request)
            except AwsError as error:
                if error.code in {"AccessDenied", "AccessDeniedException", "ValidationException", "ResourceLimitExceeded"}:
                    uncertain_resource = None
                raise
            if resource == "endpoint-config" and describe(profile, resource) is None:
                raise RuntimeError("Endpoint configuration is not visible yet. Try again after cleanup.")
            if resource != "endpoint":
                uncertain_resource = None
        wait_for_endpoint(profile)
        uncertain_resource = None
        wait_for_ownership(profile, "endpoint", run_id)
        invoke_once(profile, fixture)
    finally:
        run_error = sys.exception()
        try:
            cleanup(profile, run_id, uncertain_resource)
        except (RuntimeError, OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
            if run_error is not None:
                print(f"Run stopped before cleanup: {str(run_error) or type(run_error).__name__}",
                      file=sys.stderr, flush=True)
            print(f"Cleanup needs attention. Check the named endpoint in Mumbai, then run: "
                  f"python scripts/jumpstart_endpoint.py cleanup --run-id {run_id} --profile {profile}",
                  file=sys.stderr, flush=True)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("plan", help="Print the deployment requests locally.")
    live = commands.add_parser("run", help="Deploy one billable GPU instance, invoke once, and clean up.")
    live.add_argument("--approve-cost", action="store_true", required=True)
    read_only = commands.add_parser("check", help="Check the AWS identity and resource names without deploying.")
    recovery = commands.add_parser("cleanup", help="Delete the resources tagged for a specific run.")
    recovery.add_argument("--run-id", required=True, type=lambda value: uuid.UUID(value).hex)
    for command in (live, read_only, recovery):
        command.add_argument("--profile", default=DEFAULT_PROFILE)
    args = parser.parse_args()
    if args.command in {None, "plan"}:
        print(json.dumps({
            "region": REGION, "modelId": MODEL_ID, "modelVersion": MODEL_VERSION,
            "readinessWaitSeconds": READY_TIMEOUT, "deployment": deployment_requests("example-run-id"),
        }, indent=2))
        return
    if args.command == "check":
        check(args.profile)
    elif args.command == "cleanup":
        require_lab_user(args.profile)
        cleanup(args.profile, args.run_id)
    else:
        run(args.profile)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
