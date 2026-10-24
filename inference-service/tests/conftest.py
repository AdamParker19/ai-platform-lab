import pytest
from train import train


@pytest.fixture(scope="session")
def trained_bundle(tmp_path_factory):
    directory = tmp_path_factory.mktemp("model")
    metadata, evaluation = train(directory)
    return directory, metadata, evaluation


@pytest.fixture(autouse=True)
def model_directory(monkeypatch, trained_bundle):
    monkeypatch.setenv("MODEL_DIR", str(trained_bundle[0]))
