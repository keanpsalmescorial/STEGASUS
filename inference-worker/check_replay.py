"""Recompute selected real image tiles and the full graph; compare with saved slide artifacts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import worker


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--slide", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    args = parser.parse_args()
    run = args.run.resolve()
    reference = args.reference.resolve()
    worker.verify_installation(run)
    with tempfile.TemporaryDirectory(prefix="stegasus-check-") as name:
        work = Path(name)
        for cached in ("tiles.sqlite", "manifest.json"):
            shutil.copyfile(reference / cached, work / cached)
        with sqlite3.connect(work / "tiles.sqlite") as db:
            deleted = db.execute("""delete from tiles where rowid in
                (select rowid from tiles where feature is not null order by y,x limit 64)""").rowcount
        db.close()
        if deleted != 64:
            raise ValueError("Expected at least 64 tissue tiles in the reference.")
        result = worker.compute(args.slide.resolve(), work, run, threading.Event(), pipeline='frozen')
        outputs = {}
        for filename in ("manifest.json", "result.json", "patch_predictions.csv", "thumbnail.png", "heatmap.png"):
            got = digest(work / filename)
            expected = digest(reference / filename)
            outputs[filename] = {"match": got == expected, "sha256": got}
        print(json.dumps({"freshTissueTiles": deleted, "result": result, "artifacts": outputs}, indent=2))
        if not all(item["match"] for item in outputs.values()):
            raise SystemExit("Artifact mismatch. Inspect separately.")


if __name__ == "__main__":
    main()
