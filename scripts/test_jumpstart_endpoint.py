import contextlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import jumpstart_endpoint as lab


class JumpStartEndpointTest(unittest.TestCase):
    def test_cleanup_waits_for_creating_endpoint_and_retries_in_progress_error(self):
        states = iter([
            {"EndpointStatus": "Creating"},
            {"EndpointStatus": "Failed", "FailureReason": "Container failed health checks"},
            {"EndpointStatus": "Failed"},
            {"EndpointStatus": "Deleting"},
            None,
        ])
        events = []
        endpoint_absent = False
        rejected_once = False

        def describe(profile, resource):
            nonlocal endpoint_absent
            if resource == "endpoint":
                endpoint = next(states)
                endpoint_absent = endpoint is None
                events.append(endpoint["EndpointStatus"] if endpoint else "absent")
                return endpoint
            return None if f"delete-{resource}" in events else {"Name": lab.NAME}

        def aws(profile, service, operation, *args, request=None):
            nonlocal rejected_once
            if operation == "list-tags":
                return {"Tags": [{"Key": lab.RUN_TAG, "Value": "my-run"}]}
            events.append(operation)
            if operation == "delete-endpoint" and not rejected_once:
                rejected_once = True
                raise lab.AwsError(operation, 'An error occurred (ValidationException): '
                                   f'Cannot update in-progress endpoint "{lab.NAME}".')
            if operation != "delete-endpoint":
                self.assertTrue(endpoint_absent)
            return {}

        output = io.StringIO()
        with (patch.object(lab, "describe", side_effect=describe),
              patch.object(lab, "aws", side_effect=aws),
              patch.object(lab.time, "sleep"),
              contextlib.redirect_stdout(output)):
            lab.cleanup(lab.DEFAULT_PROFILE, "my-run")

        self.assertEqual(events, ["Creating", "Failed", "delete-endpoint", "Failed",
                                  "delete-endpoint", "Deleting", "absent",
                                  "delete-endpoint-config", "delete-model"])
        self.assertIn("Container failed health checks", output.getvalue())
        self.assertIn("Cleanup complete.", output.getvalue())

    def test_cleanup_timeout_does_not_remove_dependencies(self):
        with (patch.object(lab, "describe", return_value={"EndpointStatus": "Creating"}) as describe,
              patch.object(lab, "aws", return_value={"Tags": [{"Key": lab.RUN_TAG, "Value": "my-run"}]}) as aws):
            with self.assertRaisesRegex(RuntimeError, "still Creating when cleanup timed out"):
                lab.cleanup(lab.DEFAULT_PROFILE, "my-run", wait_seconds=0)

        describe.assert_called_once_with(lab.DEFAULT_PROFILE, "endpoint")
        self.assertEqual([call.args[2] for call in aws.call_args_list], ["list-tags"])

    def test_cleanup_cli_can_wait_past_default_deadline(self):
        run_id = "a1234567890b4000a000000000000000"
        elapsed = 0

        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds

        def describe(profile, resource):
            if resource == "endpoint" and not aws.called:
                status = "Creating" if elapsed <= lab.CLEANUP_TIMEOUT else "InService"
                return {"EndpointStatus": status}
            return None

        with (patch.object(sys, "argv", ["jumpstart_endpoint.py", "cleanup", "--run-id", run_id,
                                       "--wait-minutes", "30"]),
              patch.object(lab, "require_lab_user") as verify_user,
              patch.object(lab, "wait_for_ownership") as verify_owner,
              patch.object(lab, "describe", side_effect=describe),
              patch.object(lab, "aws") as aws,
              patch.object(lab.time, "monotonic", side_effect=lambda: elapsed),
              patch.object(lab.time, "sleep", side_effect=sleep),
              contextlib.redirect_stdout(io.StringIO())):
            lab.main()

        self.assertGreater(elapsed, lab.CLEANUP_TIMEOUT)
        verify_user.assert_called_once_with(lab.DEFAULT_PROFILE)
        verify_owner.assert_called_with(lab.DEFAULT_PROFILE, "endpoint", run_id)
        aws.assert_called_once_with(lab.DEFAULT_PROFILE, "sagemaker", "delete-endpoint",
                                    request={"EndpointName": lab.NAME})

    def test_run_invokes_once_and_checks_deletion_before_removing_dependencies(self):
        for invocation_fails in (False, True):
            with self.subTest(invocation_fails=invocation_fails):
                resources = {}
                calls = []

                def fake_aws(profile, service, operation, *args, request=None):
                    calls.append((service, operation))
                    if operation == "get-caller-identity":
                        return {"Arn": lab.DEPLOYER}
                    if operation == "list-tags":
                        resource = args[1].split(":")[-1].split("/")[0]
                        return {"Tags": resources[resource]["Tags"]}
                    if operation == "invoke-endpoint":
                        self.assertEqual(args[args.index("--content-type") + 1], "application/json")
                        self.assertEqual(resources["endpoint"]["EndpointStatus"], "InService")
                        if invocation_fails:
                            raise lab.AwsError(operation, "An error occurred (ModelError)")
                        Path(args[-1]).write_text(json.dumps([{"generated_text": "Steel Washers"}]), encoding="utf-8")
                        return {"InvokedProductionVariant": "AllTraffic"}

                    action, resource = operation.split("-", 1)
                    if action == "describe":
                        if resource not in resources:
                            raise lab.AwsError(operation, f"An error occurred (ValidationException): Could not find {lab.NAME}")
                        return resources[resource]
                    if action == "create":
                        resources[resource] = request.copy()
                        if resource == "endpoint":
                            resources[resource]["EndpointStatus"] = "InService"
                        return {}
                    if resource != "endpoint":
                        self.assertNotIn("endpoint", resources)
                    del resources[resource]
                    return {}

                fixture = {"inputs": "Extract the product name. Product: Steel Washers"}
                with (patch.object(lab, "aws", side_effect=fake_aws),
                      patch.object(lab, "build_fixture", return_value=fixture),
                      contextlib.redirect_stdout(io.StringIO())):
                    if invocation_fails:
                        with self.assertRaises(lab.AwsError):
                            lab.run(lab.DEFAULT_PROFILE)
                    else:
                        lab.run(lab.DEFAULT_PROFILE)

                self.assertEqual(calls.count(("sagemaker-runtime", "invoke-endpoint")), 1)
                deletes = [operation for _, operation in calls if operation.startswith("delete-")]
                self.assertEqual(deletes, ["delete-endpoint", "delete-endpoint-config", "delete-model"])
                delete_endpoint = calls.index(("sagemaker", "delete-endpoint"))
                self.assertEqual(calls[delete_endpoint + 1], ("sagemaker", "describe-endpoint"))
                self.assertEqual(resources, {})

    def test_cleanup_protects_endpoint_owned_by_another_run(self):
        with (patch.object(lab, "describe", return_value={"EndpointStatus": "InService"}),
              patch.object(lab, "aws", return_value={"Tags": [{"Key": lab.RUN_TAG, "Value": "different"}]}) as aws):
            with self.assertRaisesRegex(RuntimeError, "Refusing to delete"):
                lab.cleanup(lab.DEFAULT_PROFILE, "my-run")
        self.assertEqual(aws.call_count, 1)
        self.assertEqual(aws.call_args.args[2], "list-tags")
