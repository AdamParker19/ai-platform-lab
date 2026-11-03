"""Mockable text-generation provider; no network or cloud calls."""
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class GeneratedText:
    text: str
    model_version: str


class GenAIProvider(Protocol):
    """Contract that a future real LLM adapter must implement."""

    async def generate(self, prompt: str, *, request_id: str) -> GeneratedText:
        ...


class MockGenAIProvider:
    """Deterministic offline implementation for learning and tests.

    Echoing a small slice of the prompt is intentionally NOT an LLM answer.
    """

    async def generate(self, prompt: str, *, request_id: str) -> GeneratedText:
        return GeneratedText(
            text=f"[MOCK] Received: {prompt[:80]}",
            model_version="mock-genai-v1",
        )
