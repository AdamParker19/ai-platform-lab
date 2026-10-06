"""Restore an earlier task revision without starting any tasks."""
import os
import re
import time
from pathlib import Path

from deploy_lab import ACCOUNT, CLUSTER, REGION, SERVICE, aws, require_stopped, service_state, task_recipe


def rollback():
    revision = os.environ["TARGET_REVISION"]
    if not re.fullmatch(r"[1-9][0-9]*", revision):
        raise ValueError("Revision must be a positive integer")
    before = service_state()
    require_stopped(before)
    previous = before["taskDefinition"]
    family = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/ai-platform-lab:"
    if not previous.startswith(family) or int(revision) >= int(previous.removeprefix(family)):
        raise ValueError("Choose a revision earlier than the service's current revision")
    target = family + revision
    raw = aws("ecs", "describe-task-definition", task_definition=target)["taskDefinition"]
    if raw.get("status") != "ACTIVE":
        raise RuntimeError("Target task definition must be ACTIVE")
    refs = {c["name"]: c["image"] for c in raw["containerDefinitions"]}
    task_recipe(target, refs)  # Validate the same project, execution role, and task size.
    for name, ref in refs.items():
        expected = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/ai-platform-lab/{name}@sha256:"
        if not ref.startswith(expected) or not re.fullmatch(r"[0-9a-f]{64}", ref.removeprefix(expected)):
            raise RuntimeError("Rollback target must use project images pinned by digest")
    again = service_state()
    require_stopped(again)
    if again["taskDefinition"] != previous:
        raise RuntimeError("Service revision changed while validating rollback")
    aws("ecs", "update-service", cluster=CLUSTER, service=SERVICE,
        task_definition=target, desired_count=0)
    for _ in range(12):
        after = service_state()
        require_stopped(after)
        if after["taskDefinition"] == target:
            with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as out:
                out.write(f"Restored service configuration: {previous} → {target}\n\n")
                out.write("Verified: desired 0, running 0, pending 0. No task was started.\n\n")
                for name, ref in refs.items():
                    out.write(f"{name}: {ref}\n\n")
            print(f"Rollback verified: {target}; all task counts are zero")
            return
        time.sleep(5)
    raise TimeoutError("Rollback request sent, but service revision was not confirmed within one minute")


if __name__ == "__main__":
    rollback()
