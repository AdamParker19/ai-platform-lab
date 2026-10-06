"""Exercise cost safeguards with fake AWS responses; never calls AWS."""
import copy
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import deploy_lab as lab


class DeploymentSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.summary = str(Path(self.temp.name) / "summary.md")
        self.env = patch.dict(os.environ, {"IMAGE_TAG": "sha-" + "a" * 40 + "-run-123-1",
                                          "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                                          "GITHUB_STEP_SUMMARY": self.summary})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.stopped = {"status": "ACTIVE", "desiredCount": 0, "runningCount": 0,
                        "pendingCount": 0, "taskDefinition": "previous"}

    def exercise(self, shutdown_error=None, healthy_error=None, update_error=None):
        events = []
        def fake_aws(namespace, operation, **params):
            events.append((operation, params))
            if operation == "register-task-definition":
                return {"taskDefinition": {"taskDefinitionArn": "new"}}
            if operation == "update-service" and params["desired_count"] == 1 and update_error:
                raise update_error
            return {}
        def shutdown():
            events.append(("verify-shutdown", {}))
            if shutdown_error:
                raise shutdown_error
            return "schedule", datetime.now(timezone.utc) + timedelta(minutes=15)
        def healthy(revision):
            if healthy_error:
                raise healthy_error
            return "task"
        with patch.object(lab, "service_state", return_value=self.stopped), \
             patch.object(lab, "image_refs", return_value={}), \
             patch.object(lab, "task_recipe", return_value={}), \
             patch.object(lab, "aws", side_effect=fake_aws), \
             patch.object(lab, "create_shutdown", side_effect=shutdown), \
             patch.object(lab, "wait_healthy", side_effect=healthy):
            try:
                lab.deploy()
                return events, None
            except Exception as error:
                return events, error

    def test_success_verifies_shutdown_before_starting_one_task(self):
        events, error = self.exercise()
        self.assertIsNone(error)
        self.assertEqual([op for op, _ in events],
                         ["register-task-definition", "verify-shutdown", "update-service"])
        self.assertEqual(events[-1][1]["desired_count"], 1)

    def test_failed_schedule_verification_never_starts_tasks(self):
        events, error = self.exercise(shutdown_error=RuntimeError("wrong target"))
        self.assertIsNotNone(error)
        self.assertNotIn("update-service", [op for op, _ in events])

    def test_unhealthy_deployment_restores_previous_revision_at_zero(self):
        events, error = self.exercise(healthy_error=TimeoutError("unhealthy"))
        self.assertIsNotNone(error)
        self.assertEqual(events[-1][1]["task_definition"], "previous")
        self.assertEqual(events[-1][1]["desired_count"], 0)

    def test_ambiguous_start_api_failure_still_requests_shutdown(self):
        events, error = self.exercise(update_error=TimeoutError("response lost"))
        self.assertIsNotNone(error)
        self.assertEqual(events[-1][1]["desired_count"], 0)

    def test_existing_compute_is_not_replaced(self):
        for field in ("desiredCount", "runningCount", "pendingCount"):
            state = dict(self.stopped, **{field: 1})
            with self.assertRaises(RuntimeError):
                lab.require_stopped(state)

    def test_tampered_schedule_target_is_rejected(self):
        saved = {}
        def fake_aws(namespace, operation, **params):
            if operation == "create-schedule":
                saved.update({"State": params["state"], "ScheduleExpression": params["schedule_expression"],
                              "ScheduleExpressionTimezone": params["schedule_expression_timezone"],
                              "ActionAfterCompletion": params["action_after_completion"],
                              "FlexibleTimeWindow": params["flexible_time_window"],
                              "Target": copy.deepcopy(params["target"])})
                saved["Target"]["Input"] = '{"DesiredCount": 1}'
                return {}
            return saved
        with patch.object(lab, "aws", side_effect=fake_aws):
            with self.assertRaisesRegex(RuntimeError, "target verification"):
                lab.create_shutdown()


if __name__ == "__main__":
    unittest.main()
