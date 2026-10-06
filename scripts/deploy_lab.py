"""Deploy one stopped lab service, with a verified independent shutdown timer."""
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ACCOUNT = "501683248889"
REGION = "ap-south-1"
CLUSTER = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/ai-platform-lab"
SERVICE = f"arn:aws:ecs:{REGION}:{ACCOUNT}:service/ai-platform-lab/ai-platform-lab-service-s7r5cujf"
EXECUTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/ai-platform-lab-execution"
SHUTDOWN_ROLE = f"arn:aws:iam::{ACCOUNT}:role/ai-platform-lab-shutdown"
REGISTRY = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com"


def aws(namespace, operation, **parameters):
    command = ["aws", namespace, operation, "--region", REGION,
               "--output", "json", "--no-cli-pager",
               "--cli-connect-timeout", "10", "--cli-read-timeout", "30"]
    for key, value in parameters.items():
        command += ["--" + key.replace("_", "-"),
                    json.dumps(value) if isinstance(value, (dict, list)) else str(value)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"AWS {namespace} {operation} failed: {result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def service_state():
    result = aws("ecs", "describe-services", cluster=CLUSTER, services=[SERVICE])
    if result.get("failures") or len(result.get("services", [])) != 1:
        raise RuntimeError("Project service was not found")
    return result["services"][0]


def require_stopped(state):
    if state.get("status") != "ACTIVE" or any(
        state.get(key) != 0 for key in ("desiredCount", "runningCount", "pendingCount")
    ):
        raise RuntimeError("Deployment requires desired, running, and pending counts all zero")


def image_refs(tag):
    if not re.fullmatch(r"sha-[0-9a-f]{40}-run-[0-9]+-[0-9]+", tag):
        raise ValueError("Use the exact sha-...-run-... tag from Publish images")
    refs = {}
    for name in ("gateway", "inference"):
        details = aws("ecr", "describe-images", repository_name=f"ai-platform-lab/{name}",
                      image_ids=[{"imageTag": tag}])["imageDetails"]
        if len(details) != 1 or not re.fullmatch(r"sha256:[0-9a-f]{64}", details[0]["imageDigest"]):
            raise RuntimeError(f"Invalid published digest for {name}")
        refs[name] = f"{REGISTRY}/ai-platform-lab/{name}@{details[0]['imageDigest']}"
    return refs


def task_recipe(previous, refs):
    raw = aws("ecs", "describe-task-definition", task_definition=previous)["taskDefinition"]
    if (raw.get("family") != "ai-platform-lab" or raw.get("executionRoleArn") != EXECUTION_ROLE
            or raw.get("taskRoleArn") or raw.get("cpu") != "512" or raw.get("memory") != "1024"
            or raw.get("networkMode") != "awsvpc" or raw.get("requiresCompatibilities") != ["FARGATE"]
            or raw.get("runtimePlatform") != {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"}):
        raise RuntimeError("Task configuration changed; review it before deploying")
    containers = raw["containerDefinitions"]
    if len(containers) != 2 or {c["name"] for c in containers} != {"gateway", "inference"}:
        raise RuntimeError("Expected only gateway and inference containers")
    for container in containers:
        if not container.get("essential") or not container.get("healthCheck"):
            raise RuntimeError("Both containers must be essential and have health checks")
        container["image"] = refs[container["name"]]
    fields = ("family", "executionRoleArn", "networkMode", "containerDefinitions",
              "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory", "runtimePlatform")
    return {key: raw[key] for key in fields if key in raw}


def create_shutdown():
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    if not run_id.isdigit() or not attempt.isdigit():
        raise ValueError("Invalid workflow run identity")
    name = f"ai-platform-lab-deploy-stop-{run_id}-{attempt}"
    deadline = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(minutes=15)
    expression = f"at({deadline.strftime('%Y-%m-%dT%H:%M:%S')})"
    target = {
        "Arn": "arn:aws:scheduler:::aws-sdk:ecs:updateService",
        "RoleArn": SHUTDOWN_ROLE,
        "Input": json.dumps({"Cluster": CLUSTER, "Service": SERVICE, "DesiredCount": 0}),
        "RetryPolicy": {"MaximumEventAgeInSeconds": 600, "MaximumRetryAttempts": 3},
        "DeadLetterConfig": {"Arn": f"arn:aws:sqs:{REGION}:{ACCOUNT}:ai-platform-lab-shutdown-dlq"},
    }
    aws("scheduler", "create-schedule", name=name, group_name="default",
        schedule_expression=expression, schedule_expression_timezone="UTC",
        flexible_time_window={"Mode": "OFF"}, state="ENABLED",
        action_after_completion="NONE", target=target)
    saved = aws("scheduler", "get-schedule", name=name, group_name="default")
    if (saved.get("State") != "ENABLED" or saved.get("ScheduleExpression") != expression
            or saved.get("ScheduleExpressionTimezone") != "UTC"
            or saved.get("ActionAfterCompletion") != "NONE"
            or saved.get("FlexibleTimeWindow", {}).get("Mode") != "OFF"):
        raise RuntimeError("Shutdown schedule verification failed; tasks will not start")
    actual = saved["Target"]
    if (any(actual.get(key) != target[key] for key in ("Arn", "RoleArn", "RetryPolicy", "DeadLetterConfig"))
            or json.loads(actual["Input"]) != json.loads(target["Input"])):
        raise RuntimeError("Shutdown target verification failed; tasks will not start")
    return name, deadline


def wait_healthy(revision):
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        state = service_state()
        primary = next((d for d in state.get("deployments", []) if d["status"] == "PRIMARY"), {})
        if state["desiredCount"] != 1 or primary.get("taskDefinition") != revision:
            raise RuntimeError("Service was stopped or deployment rolled back")
        if primary.get("rolloutState") == "FAILED":
            raise RuntimeError("ECS deployment failed")
        if (primary.get("rolloutState") == "COMPLETED" and state["runningCount"] == 1
                and state["pendingCount"] == 0):
            arns = aws("ecs", "list-tasks", cluster=CLUSTER,
                       service_name="ai-platform-lab-service-s7r5cujf", desired_status="RUNNING")["taskArns"]
            if len(arns) == 1:
                result = aws("ecs", "describe-tasks", cluster=CLUSTER, tasks=arns)
                tasks = result.get("tasks", [])
                if not result.get("failures") and len(tasks) == 1:
                    task = tasks[0]
                    if (task["taskDefinitionArn"] == revision and task.get("lastStatus") == "RUNNING"
                            and task.get("healthStatus") == "HEALTHY"
                            and {c["name"] for c in task["containers"]} == {"gateway", "inference"}
                            and all(c.get("healthStatus") == "HEALTHY" for c in task["containers"])):
                        return arns[0]
        print(f"Waiting: running={state['runningCount']} pending={state['pendingCount']}", flush=True)
        time.sleep(10)
    raise TimeoutError("Deployment did not become healthy within five minutes")


def deploy():
    state = service_state()
    require_stopped(state)
    previous = state["taskDefinition"]
    refs = image_refs(os.environ["IMAGE_TAG"])
    recipe = task_recipe(previous, refs)
    revision = aws("ecs", "register-task-definition", cli_input_json=recipe)["taskDefinition"]["taskDefinitionArn"]
    name, deadline = create_shutdown()
    summary = Path(os.environ["GITHUB_STEP_SUMMARY"])
    with summary.open("a") as out:
        out.write(f"Previous revision: {previous}\n\nNew revision: {revision}\n\n")
        out.write(f"Shutdown schedule: {name}\n\nShutdown requested at: {deadline.isoformat()} (UTC)\n\n")
        for container, ref in refs.items():
            out.write(f"{container}: {ref}\n\n")
    require_stopped(service_state())
    if deadline - datetime.now(timezone.utc) < timedelta(minutes=12):
        raise RuntimeError("Insufficient shutdown timer remaining; tasks will not start")
    started = False
    succeeded = False
    try:
        started = True  # Even an ambiguous API timeout must trigger cleanup.
        aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE,
            task_definition=revision, desired_count=1)
        task = wait_healthy(revision)
        with summary.open("a") as out:
            out.write(f"Healthy task: {task}\n\nConfirm API access and then verify all task counts return to zero.\n")
        succeeded = True
    finally:
        if started and not succeeded:
            print("Deployment failed: requesting desired count zero and previous revision", flush=True)
            aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE,
                task_definition=previous, desired_count=0)


if __name__ == "__main__":
    deploy()
