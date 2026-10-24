"""Optional: restore the exact publicly available dataset snapshot."""
import hashlib
import io
import urllib.request
import zipfile
from dataset import DATA_PATH, DATA_SHA256

URL = "https://archive.ics.uci.edu/static/public/331/sentiment+labelled+sentences.zip"
ARCHIVE_SHA256 = "afc26626d710899948693e1a61405dce197f57ffa719fa1130d346b4cc095343"


def main():
    with urllib.request.urlopen(URL, timeout=30) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000 or hashlib.sha256(raw).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("Archive changed; inspect the source instead of accepting new bytes")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        data = archive.read("sentiment labelled sentences/amazon_cells_labelled.txt")
    if hashlib.sha256(data).hexdigest() != DATA_SHA256:
        raise ValueError("Dataset checksum mismatch")
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_PATH.write_bytes(data)
    print(f"Verified UCI Amazon subset: {DATA_PATH}")


if __name__ == "__main__":
    main()
