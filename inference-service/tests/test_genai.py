"""Offline contract tests for /generate, including injected provider failures."""
import asyncio

from fastapi.testclient import TestClient

from app import app
from genai import GeneratedText, MockGenAIProvider


def test_generate_mock_is_deterministic_and_correlated():
    with TestClient(app) as client:
        headers = {"x-request-id": "Week1Trace123"}
        first = client.post("/generate", json={"prompt": "Explain RAG"}, headers=headers)
        second = client.post("/generate", json={"prompt": "Explain RAG"}, headers=headers)
        assert first.status_code == second.status_code == 200
        body = first.json()
        assert body["text"] == second.json()["text"] == "[MOCK] Received: Explain RAG"
        assert body["modelVersion"] == "mock-genai-v1"
        assert body["requestId"] == first.headers["x-request-id"] == "Week1Trace123"
        assert body["latencyMs"] >= 0


def test_generate_validation_does_not_change_sentiment():
    with TestClient(app) as client:
        for invalid in ({}, {"prompt": ""}, {"prompt": "   "}, {"prompt": 42},
                        {"prompt": "a" * 2001}, {"prompt": "ok", "extra": True}):
            assert client.post("/generate", json=invalid).status_code == 422
        assert client.post("/predict", json={"text": "This is amazing"}).status_code == 200


class FailingProvider:
    async def generate(self, prompt: str, *, request_id: str) -> GeneratedText:
        raise ConnectionError("secret provider details must not leak")


class InvalidProvider:
    async def generate(self, prompt: str, *, request_id: str) -> GeneratedText:
        return GeneratedText(text="", model_version="broken-v1")


class SlowProvider:
    async def generate(self, prompt: str, *, request_id: str) -> GeneratedText:
        await asyncio.sleep(3)
        return GeneratedText(text="too late", model_version="slow-v1")


def test_generate_provider_failure_is_safe():
    with TestClient(app) as client:
        app.state.genai_provider = FailingProvider()
        response = client.post("/generate", json={"prompt": "hello"})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "PROVIDER_UNAVAILABLE"
        assert "secret provider" not in response.text
        app.state.genai_provider = InvalidProvider()
        response = client.post("/generate", json={"prompt": "hello"})
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "INVALID_PROVIDER_RESPONSE"
        app.state.genai_provider = MockGenAIProvider()


def test_generate_deadline():
    with TestClient(app) as client:
        app.state.genai_provider = SlowProvider()
        response = client.post("/generate", json={"prompt": "hello"})
        assert response.status_code == 504
        assert response.json()["error"]["code"] == "PROVIDER_TIMEOUT"
