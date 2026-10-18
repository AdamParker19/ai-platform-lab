"""Read the vendored UCI Amazon subset without fitting anything."""
import hashlib
from pathlib import Path

DATA_PATH = Path(__file__).parent / "data" / "amazon_cells_labelled.txt"
DATA_SHA256 = "47003fc0a0d4840b00e96e715b6189bad09e7443a3da41c4cbe12ffc79f86ae3"
SOURCE_URL = "https://archive.ics.uci.edu/dataset/331/sentiment+labelled+sentences"


def normalize(text: str) -> str:
    return " ".join(text.casefold().split())


def read_reviews(path: Path = DATA_PATH, expected_sha256: str | None = DATA_SHA256):
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if expected_sha256 and digest != expected_sha256:
        raise ValueError("Dataset checksum mismatch; review changes before training")
    rows = {}
    duplicates = 0
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line.strip():
            continue
        text, label = line.rsplit("\t", 1)
        if not text.strip() or label not in {"0", "1"}:
            raise ValueError(f"Invalid review at line {line_number}")
        key = normalize(text)
        value = "positive" if label == "1" else "negative"
        if key in rows:
            if rows[key]["label"] != value:
                raise ValueError(f"Conflicting labels at line {line_number}")
            duplicates += 1
            continue
        rows[key] = {"id": hashlib.sha256(key.encode()).hexdigest(), "text": text, "label": value}
    return list(rows.values()), {"sha256": digest, "duplicates_removed": duplicates}
