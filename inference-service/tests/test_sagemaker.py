import hashlib
import shutil
import tarfile

from fastapi.testclient import TestClient
import pytest

from app import app
from model import load_model
from package_model import package_model


def test_sagemaker_routes_use_the_existing_loaded_model():
    with TestClient(app) as client:
        for method in (client.get, client.post):
            response = method("/ping")
            assert response.status_code == 200
            assert response.json()["modelVersion"] == "sentiment-uci-amazon-v1"
        body = {"text": "Excellent quality and easy to use"}
        response = client.post("/invocations", json=body)
        assert response.status_code == 200
        assert response.json() == client.post("/predict", json=body).json()
        assert response.headers["x-request-id"]
        assert client.post("/invocations", json={"text": " "}).status_code == 422


def test_archive_extracts_directly_into_the_serving_model_directory(trained_bundle, tmp_path):
    directory, metadata, _ = trained_bundle
    archive = tmp_path / "model.tar.gz"
    manifest = package_model(directory, archive)
    assert manifest["modelVersion"] == metadata["modelVersion"]
    assert manifest["artifactSha256"] == metadata["artifactSha256"]
    assert manifest["archiveSha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
    with tarfile.open(archive) as packed:
        assert packed.getnames() == ["model.joblib", "metadata.json"]
        assert all(member.isfile() and member.mode == 0o644 for member in packed.getmembers())
        packed.extractall(tmp_path / "mounted", filter="data")
    assert load_model(tmp_path / "mounted").metadata == metadata
    again = tmp_path / "again.tar.gz"
    package_model(directory, again)
    assert again.read_bytes() == archive.read_bytes()


def test_corrupt_model_cannot_be_packaged(trained_bundle, tmp_path):
    directory = tmp_path / "bundle"
    shutil.copytree(trained_bundle[0], directory)
    (directory / "model.joblib").write_bytes(b"corrupt")
    archive = tmp_path / "model.tar.gz"
    with pytest.raises(RuntimeError, match="checksum mismatch"):
        package_model(directory, archive)
    assert not archive.exists()


def test_ping_never_claims_ready_when_model_is_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_DIR", str(tmp_path))
    with pytest.raises(RuntimeError, match="artifact missing"):
        with TestClient(app):
            pytest.fail("Startup must fail before /ping can report success")
