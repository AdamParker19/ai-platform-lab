import json
import shutil

import joblib
import pytest
from fastapi.testclient import TestClient
from sklearn.base import BaseEstimator

from app import app
from dataset import read_reviews, normalize
from model import load_model, predict
from train import split_reviews


def test_data_and_split_are_reproducible_and_disjoint():
    rows, source = read_reviews()
    assert len(rows) + source["duplicates_removed"] == 1000
    training, test = split_reviews(rows)
    assert [training, test] == split_reviews(rows)
    assert not ({r["id"] for r in training} & {r["id"] for r in test})
    assert not ({normalize(r["text"]) for r in training} & {normalize(r["text"]) for r in test})
    assert {r["label"] for r in test} == {"negative", "positive"}


def test_preprocessing_fits_only_training_vocabulary(trained_bundle):
    directory, _, _ = trained_bundle
    training, test = split_reviews(read_reviews()[0])
    vectorizer = load_model(directory).pipeline.steps[0][1]
    analyze = vectorizer.build_analyzer()
    training_tokens = {token for row in training for token in analyze(row["text"])}
    test_only = {token for row in test for token in analyze(row["text"])} - training_tokens
    assert test_only  # Exercise actual words unseen in training, not a vacuous check.
    assert set(vectorizer.vocabulary_) == training_tokens
    assert not test_only.intersection(vectorizer.vocabulary_)


def test_evaluation_has_baseline_errors_and_auditable_split(trained_bundle):
    _, metadata, report = trained_bundle
    assert set(metadata["split"]["trainIds"]).isdisjoint(metadata["split"]["testIds"])
    for key in ("model", "baseline"):
        assert 0 <= report[key]["accuracy"] <= 1
        assert 0 <= report[key]["macro_f1"] <= 1
        assert sum(sum(row) for row in report[key]["confusion_matrix"]) == metadata["split"]["test"]
        assert "negative" in report[key]["classification_report"]
    assert all(error["actual"] != error["predicted"] for error in report["errors"])


def test_loading_and_predictions_never_retrain(trained_bundle, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Serving must not fit")
    monkeypatch.setattr(BaseEstimator, "fit", forbidden, raising=False)
    # Specifically patch the classes used by this pipeline.
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    monkeypatch.setattr(TfidfVectorizer, "fit_transform", forbidden)
    monkeypatch.setattr(LogisticRegression, "fit", forbidden)
    first = predict(load_model(trained_bundle[0]), "Excellent quality")
    second = predict(load_model(trained_bundle[0]), "Excellent quality")
    assert first == second
    assert first["modelVersion"] == trained_bundle[1]["modelVersion"]


def test_missing_artifact_fails_startup(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    with pytest.raises(RuntimeError, match="artifact missing"):
        with TestClient(app):
            pass


def test_corruption_is_rejected_before_deserialization(trained_bundle, tmp_path, monkeypatch):
    shutil.copytree(trained_bundle[0], tmp_path, dirs_exist_ok=True)
    with (tmp_path / "model.joblib").open("ab") as file:
        file.write(b"corruption")
    monkeypatch.setattr(joblib, "load", lambda *args: pytest.fail("Must reject before loading"))
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        load_model(tmp_path)


def test_dependency_mismatch_rejected(trained_bundle, tmp_path):
    shutil.copytree(trained_bundle[0], tmp_path, dirs_exist_ok=True)
    path = tmp_path / "metadata.json"
    metadata = json.loads(path.read_text())
    metadata["dependencies"]["scikit-learn"] = "0.0.0"
    path.write_text(json.dumps(metadata))
    with pytest.raises(RuntimeError, match="dependency mismatch"):
        load_model(tmp_path)


def test_bad_dataset_hash_and_conflicting_annotations(tmp_path):
    source = tmp_path / "reviews.txt"
    source.write_text("Great\t1\ngreat\t0\n")
    with pytest.raises(ValueError, match="checksum mismatch"):
        read_reviews(source)
    with pytest.raises(ValueError, match="Conflicting labels"):
        read_reviews(source, expected_sha256=None)


def test_crlf_conversion_is_diagnosed_without_bypassing_integrity(tmp_path):
    from dataset import DATA_PATH, DATA_SHA256
    source = tmp_path / "reviews.txt"
    source.write_bytes(DATA_PATH.read_bytes().replace(b"\n", b"\r\n"))
    with pytest.raises(ValueError, match="CRLF-to-LF conversion"):
        read_reviews(source, DATA_SHA256)
    # An actual edit must not be mistaken for harmless newline conversion.
    source.write_bytes(source.read_bytes() + b"New review\t1\r\n")
    with pytest.raises(ValueError, match="contents differ"):
        read_reviews(source, DATA_SHA256)
