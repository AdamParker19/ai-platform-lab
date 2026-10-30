"""Package our own validated bundle for SageMaker's /opt/ml/model directory."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile

from model import load_model


def package_model(directory: Path, output: Path) -> dict:
    # Validate our trusted artifact, metadata, and serving dependencies first.
    bundle = load_model(directory)
    files = {name: (directory / name).read_bytes()
             for name in ("model.joblib", "metadata.json")}
    if output.resolve() in {(directory / name).resolve() for name in files}:
        raise ValueError("Archive output must not overwrite a model input")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Canonical headers make repackaging the same bundle produce the same digest.
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for name, data in files.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o644
                    archive.addfile(entry, io.BytesIO(data))
    return {"modelVersion": bundle.metadata["modelVersion"],
            "artifactSha256": bundle.metadata["artifactSha256"],
            "archiveSha256": hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package_model(args.model_dir, args.output), indent=2))
