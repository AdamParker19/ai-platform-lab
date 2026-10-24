"""Serving loads a trusted, versioned artifact. It never fits a model."""
from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
from typing import Any

import joblib


@dataclass
class ModelBundle:
    pipeline: Any
    metadata: dict


def load_model(directory: Path | None = None) -> ModelBundle:
    directory = directory or Path(os.environ.get("MODEL_DIR", Path(__file__).parent / "artifacts"))
    try:
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        artifact = directory / "model.joblib"
        artifact_bytes = artifact.read_bytes()
    except FileNotFoundError as exc:
        raise RuntimeError("Model artifact missing. Run python train.py before starting inference.") from exc
    if not isinstance(metadata.get("modelVersion"), str) or not metadata["modelVersion"].strip():
        raise RuntimeError("Model metadata has no version")
    if hashlib.sha256(artifact_bytes).hexdigest() != metadata.get("artifactSha256"):
        raise RuntimeError("Model artifact checksum mismatch")
    if metadata.get("pythonVersion", "").split(".")[:2] != platform.python_version().split(".")[:2]:
        raise RuntimeError("Training and serving Python major/minor versions differ")
    dependencies = metadata.get("dependencies", {})
    for name in ("scikit-learn", "numpy", "scipy", "joblib"):
        if dependencies.get(name) != importlib.metadata.version(name):
            raise RuntimeError(f"Training and serving dependency mismatch: {name}")
    # This is our own artifact. A checksum detects corruption, not an untrusted publisher.
    pipeline = joblib.load(artifact)
    if set(pipeline.classes_) != {"negative", "positive"}:
        raise RuntimeError("Unexpected model classes")
    return ModelBundle(pipeline, metadata)


def predict(model: ModelBundle, text: str) -> dict:
    probabilities = model.pipeline.predict_proba([text])[0]
    index = int(probabilities.argmax())
    return {
        "prediction": str(model.pipeline.classes_[index]),
        "confidence": float(probabilities[index]),
        "modelVersion": model.metadata["modelVersion"],
    }
