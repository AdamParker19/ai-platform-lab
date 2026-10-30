"""Regression checks for transient Docker connections during model startup."""
from contextlib import redirect_stdout
import http.client
import io
import json
import unittest
from unittest.mock import patch

import smoke_sagemaker as lab


def response(body):
    stream = io.BytesIO(json.dumps(body).encode())
    stream.status = 200
    return stream


class SmokeReadinessTests(unittest.TestCase):
    def test_startup_connection_resets_are_retried_before_invocation(self):
        version = "sentiment-uci-amazon-v1"
        attempts = [ConnectionResetError("container starting"),
                    http.client.RemoteDisconnected("server warming"),
                    response({"status": "ok", "modelVersion": version}),
                    response({"prediction": "positive", "confidence": 0.8, "modelVersion": version})]
        with patch.object(lab.urllib.request, "urlopen", side_effect=attempts) as request, \
             patch.object(lab.time, "sleep") as pause, redirect_stdout(io.StringIO()):
            lab.smoke("http://127.0.0.1:18080")
        self.assertEqual(request.call_count, 4)
        self.assertEqual(pause.call_count, 2)

    def test_persistent_startup_failure_has_a_deadline(self):
        with patch.object(lab.urllib.request, "urlopen", side_effect=ConnectionResetError()), \
             patch.object(lab.time, "monotonic", side_effect=[0, 91]), \
             self.assertRaisesRegex(TimeoutError, "90 seconds"):
            lab.smoke("http://127.0.0.1:18080")


if __name__ == "__main__":
    unittest.main()
