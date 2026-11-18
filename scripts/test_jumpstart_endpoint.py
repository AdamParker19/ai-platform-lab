import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import jumpstart_endpoint as lab


class JumpStartEndpointTest(unittest.TestCase):
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
