"""Offline training: run explicitly, never from FastAPI startup."""
import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform

import joblib
from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline

from dataset import DATA_PATH, SOURCE_URL, read_reviews

DEFAULT_VERSION = "sentiment-uci-amazon-v1"
LABELS = ["negative", "positive"]


def dependency_versions():
    return {name: importlib.metadata.version(name) for name in ("scikit-learn", "numpy", "scipy", "joblib")}


def split_reviews(rows, seed=42):
    # Deduplication happens before this split, so normalized exact repeats cannot leak.
    return train_test_split(rows, test_size=0.2, stratify=[r["label"] for r in rows], random_state=seed)


def score(expected, predicted):
    return {
        "accuracy": accuracy_score(expected, predicted),
        "macro_f1": f1_score(expected, predicted, labels=LABELS, average="macro", zero_division=0),
        "confusion_matrix": confusion_matrix(expected, predicted, labels=LABELS).tolist(),
        "classification_report": classification_report(expected, predicted, labels=LABELS, output_dict=True, zero_division=0),
    }


def train(output: Path, version=DEFAULT_VERSION, seed=42):
    if not version.strip():
        raise ValueError("Model version must not be blank")
    rows, source = read_reviews(DATA_PATH)
    training, test = split_reviews(rows, seed)
    texts = [r["text"] for r in training]
    labels = [r["label"] for r in training]
    test_texts = [r["text"] for r in test]
    expected = [r["label"] for r in test]
    model = make_pipeline(TfidfVectorizer(), LogisticRegression(random_state=seed, max_iter=1000))
    model.fit(texts, labels)
    baseline = DummyClassifier(strategy="most_frequent").fit(texts, labels)
    predicted = model.predict(test_texts)
    evaluation = {
        "labels_order": LABELS, "confusion_matrix_axes": "rows=actual, columns=predicted",
        "model": score(expected, predicted), "baseline": score(expected, baseline.predict(test_texts)),
        "errors": [{"id": r["id"], "text": r["text"], "actual": r["label"], "predicted": str(p)}
                   for r, p in zip(test, predicted) if r["label"] != p],
        "limitations": "Small, selected, older product-review sentences; no neutral class; not a production benchmark. Test set must not be used for tuning.",
    }
    output.mkdir(parents=True, exist_ok=True)
    model_path = output / "model.joblib"
    joblib.dump(model, model_path, compress=3)
    metadata = {
        "modelVersion": version, "artifactSha256": hashlib.sha256(model_path.read_bytes()).hexdigest(),
        "pythonVersion": platform.python_version(), "dependencies": dependency_versions(),
        "dataset": {**source, "source": SOURCE_URL, "subset": "amazon_cells_labelled.txt", "license": "CC BY 4.0"},
        "seed": seed, "split": {"train": len(training), "test": len(test),
            "trainLabels": dict(Counter(labels)), "testLabels": dict(Counter(expected)),
            "trainIds": [r["id"] for r in training], "testIds": [r["id"] for r in test]},
        "algorithm": "TF-IDF + LogisticRegression; default parameters except random_state and max_iter",
        "confidenceMeaning": "Maximum model probability; not calibrated confidence or a correctness guarantee",
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    (output / "evaluation.json").write_text(json.dumps(evaluation, indent=2) + "\n", encoding="utf-8")
    return metadata, evaluation


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "artifacts")
    parser.add_argument("--version", default=DEFAULT_VERSION)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    metadata, evaluation = train(args.output, args.version, args.seed)
    print(json.dumps({"modelVersion": metadata["modelVersion"], "train": metadata["split"]["train"],
                      "test": metadata["split"]["test"], "model": evaluation["model"],
                      "baseline": evaluation["baseline"]}, indent=2))
