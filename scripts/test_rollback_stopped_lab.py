import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rollback_stopped_lab as lab


class RollbackSafetyTests(unittest.TestCase):
    def test_success_changes_revision_with_desired_count_zero(self):
        family = f"arn:aws:ecs:{lab.REGION}:{lab.ACCOUNT}:task-definition/ai-platform-lab:"
        before = {"status": "ACTIVE", "desiredCount": 0, "runningCount": 0, "pendingCount": 0,
                  "taskDefinition": family + "3"}
        after = dict(before, taskDefinition=family + "2")
        raw = {"status": "ACTIVE", "containerDefinitions": [
            {"name": name, "image": f"{lab.ACCOUNT}.dkr.ecr.{lab.REGION}.amazonaws.com/ai-platform-lab/{name}@sha256:" + "a" * 64}
            for name in ("gateway", "inference")]}
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict(os.environ, {"TARGET_REVISION": "2", "GITHUB_STEP_SUMMARY": str(Path(folder) / "summary")}), \
             patch.object(lab, "service_state", side_effect=[before, before, after]), \
             patch.object(lab, "task_recipe"), \
             patch.object(lab, "aws", side_effect=[{"taskDefinition": raw}, {}]) as api:
            lab.rollback()
            self.assertEqual(api.call_args.kwargs["desired_count"], 0)
            self.assertEqual(api.call_args.kwargs["task_definition"], family + "2")

    def test_live_service_cannot_be_rolled_back_by_this_workflow(self):
        state = {"status": "ACTIVE", "desiredCount": 1, "runningCount": 1, "pendingCount": 0}
        with patch.dict(os.environ, {"TARGET_REVISION": "2"}), \
             patch.object(lab, "service_state", return_value=state), \
             patch.object(lab, "aws") as api:
            with self.assertRaises(RuntimeError):
                lab.rollback()
            api.assert_not_called()

    def test_non_revision_input_is_rejected_before_aws_calls(self):
        with patch.dict(os.environ, {"TARGET_REVISION": "2; echo unsafe"}), \
             patch.object(lab, "service_state") as read:
            with self.assertRaises(ValueError):
                lab.rollback()
            read.assert_not_called()

    def test_forward_revision_is_not_a_rollback(self):
        state = {"status": "ACTIVE", "desiredCount": 0, "runningCount": 0, "pendingCount": 0,
                 "taskDefinition": f"arn:aws:ecs:{lab.REGION}:{lab.ACCOUNT}:task-definition/ai-platform-lab:3"}
        with patch.dict(os.environ, {"TARGET_REVISION": "4"}), \
             patch.object(lab, "service_state", return_value=state), \
             patch.object(lab, "aws") as api:
            with self.assertRaises(ValueError):
                lab.rollback()
            api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
