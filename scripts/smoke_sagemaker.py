"""Test a locally running SageMaker-compatible container; no AWS calls."""
import argparse
import http.client
import json
import time
import urllib.error
import urllib.request


def smoke(base_url):
    deadline = time.monotonic() + 90
    while True:
        try:
            with urllib.request.urlopen(base_url + "/ping", timeout=2) as response:
                health = json.load(response)
            break
        except (OSError, http.client.HTTPException):
            if time.monotonic() >= deadline:
                raise TimeoutError("SageMaker /ping did not become ready within 90 seconds")
            time.sleep(1)
    request = urllib.request.Request(
        base_url + "/invocations", method="POST",
        data=json.dumps({"text": "Excellent quality and easy to use"}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
        assert response.status == 200
    assert result["modelVersion"] == health["modelVersion"] == "sentiment-uci-amazon-v1", result
    assert result["prediction"] in {"positive", "negative"}, result
    assert 0 <= result["confidence"] <= 1, result
    print("SageMaker serving contract passed:", result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18080")
    smoke(parser.parse_args().base_url.rstrip("/"))
