"""Outbound-only laboratory worker for the hash-pinned November 2026 model."""
import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse
from uuid import UUID

import requests
from job_cache import job_directory, verified_download

ROOT = Path(__file__).resolve().parent
FROZEN = ROOT / "frozen"
MODEL_VERSION = "STEGASUS-20261030_234916_956062"
THRESHOLD = 0.6285356451984643
EXPERTS = ["efficientnet_b0", "mobilevit_xxs", "resnet50", "spatial_graph_expert"]
ARTIFACTS = {
    "heatmap": ("heatmap.png", "image/png"),
    "thumbnail": ("thumbnail.png", "image/png"),
    "records": ("records.json", "application/json"),
    "patch_scores": ("patch_predictions.csv", "text/csv"),
}


def verify_installation(run):
    if sys.platform != "win32":
        raise RuntimeError("The frozen WSI entry point requires Windows.")
    hashes = json.loads((ROOT / "frozen-hashes.json").read_text())
    for name, expected in hashes.items():
        parts = PureWindowsPath(name).parts
        path = run.joinpath(*parts[2:]) if parts[0] == "runs" else FROZEN / parts[0]
        with path.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise RuntimeError(f"Frozen file identity mismatch: {path.name}")
    # Confirm native libraries and serialized sklearn runtime work before claiming.
    import openslide
    import joblib
    import torch, timm, torchvision, h5py, matplotlib
    _ = openslide.lowlevel.get_version()
    stacker = joblib.load(run / "reliability_candidate" / "ensemble.joblib")
    if stacker["threshold"] != THRESHOLD or stacker["order"] != EXPERTS:
        raise RuntimeError("Frozen decision settings mismatch.")


def score_artifacts(output):
    result = json.loads((output / "result.json").read_text())
    manifest = json.loads((output / "manifest.json").read_text())
    scores = result["base_scores"]
    score = result["ensemble_score"]
    if result["base_order"] != EXPERTS or len(scores) != 4:
        raise ValueError("Unexpected expert output order.")
    if any(not math.isfinite(v) or not 0 <= v <= 1 for v in [*scores, score]):
        raise ValueError("Invalid probability output.")
    if result["research_threshold_flag"] is not (score >= THRESHOLD):
        raise ValueError("Frozen operating point and classification disagree.")
    with (output / "patch_predictions.csv").open(newline="") as f:
        reader = csv.reader(f)
        if next(reader) != ["x_level0", "y_level0", "tissue_fraction", *EXPERTS[:3]]:
            raise ValueError("Unexpected patch-score columns.")
        count = sum(1 for _ in reader)
    if count < 1 or count != result["tissue_tiles"]:
        raise ValueError("Tissue patch counts disagree.")
    (output / "records.json").write_text(json.dumps({"manifest": manifest, "result": result}, indent=2))
    for filename, _ in ARTIFACTS.values():
        if (output / filename).stat().st_size == 0:
            raise ValueError("Missing processing artifact.")
    return dict(score=score, threshold=round(THRESHOLD, 6), exactThreshold=THRESHOLD,
                classification="Flagged" if result["research_threshold_flag"] else "Below threshold",
                modelVersion=MODEL_VERSION, patchCount=count, expertScores=dict(zip(EXPERTS, scores)),
                inputSha256=manifest["slide_sha256"])


class Service:
    def __init__(self):
        url = os.environ["SUPABASE_URL"].rstrip("/")
        if urlparse(url).scheme != "https":
            raise ValueError("SUPABASE_URL must use HTTPS.")
        self.url = url + "/functions/v1/inference"
        self.token = os.environ["WORKER_TOKEN"]
        self.worker_id = os.environ["WORKER_ID"]

    def post(self, action, **payload):
        response = requests.post(self.url, json={"action": action, "workerId": self.worker_id, **payload},
                                 headers={"Authorization": "Bearer " + self.token}, timeout=(10, 30),
                                 allow_redirects=False)
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Worker API returned HTTP {response.status_code}.")
        return response.json()


def signed_url(url):
    if urlparse(url).scheme != "https" or not urlparse(url).hostname:
        raise ValueError("Storage URL must use HTTPS.")
    return url


def fetch_slide(url, target, lost, limit, expected_size):
    available = shutil.disk_usage(target.parent).free - 2 * 1024**3
    cap = min(limit, available)
    if type(expected_size) is not int or not 0 < expected_size <= cap:
        raise RuntimeError("Declared input size exceeds the laboratory limit.")
    total = 0
    with requests.get(signed_url(url), stream=True, allow_redirects=False, timeout=(15, 60)) as response:
        if response.status_code != 200:
            raise RuntimeError("Private input download failed.")
        size = response.headers.get("Content-Length")
        if size and int(size) != expected_size:
            raise RuntimeError("Stored object size differs from job metadata.")
        with target.open("xb") as out:
            for chunk in response.iter_content(1024**2):
                total += len(chunk)
                if total > expected_size or lost.is_set():
                    raise RuntimeError("Slide transfer stopped.")
                out.write(chunk)
    if total != expected_size:
        raise RuntimeError("Incomplete input transfer.")


def compute(slide, output, run, lost, pipeline='frozen', batch_size=8):
    if slide.suffix.lower() not in (".tif", ".tiff"):
        raise ValueError("Accepted input is a pyramidal research TIFF.")
    import openslide
    with openslide.OpenSlide(str(slide)) as image:
        # Use only files with the physical scale required by the frozen pipeline.
        for key in [openslide.PROPERTY_NAME_MPP_X, openslide.PROPERTY_NAME_MPP_Y]:
            value = float(image.properties.get(key, "nan"))
            if not math.isfinite(value) or value <= 0:
                raise ValueError("TIFF lacks verified physical scale metadata.")
    entry = ROOT / 'direct_pipeline.py' if pipeline == 'direct' else FROZEN / 'wsi_infer.py'
    args = [sys.executable, str(entry), "--slide", str(slide),
            "--output", str(output), "--run", str(run)]
    if pipeline == 'direct':
        args += ['--batch-size', str(batch_size)]
    # Restrict the child to local model computation; keep worker credentials out.
    env = {k: v for k, v in os.environ.items() if k not in {"WORKER_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
                                                             "AWS_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"}}
    child = subprocess.Popen(args, env=env)
    try:
        while child.poll() is None:
            if lost.wait(1):
                raise RuntimeError("Job lease lost.")
        if child.returncode:
            raise RuntimeError("Frozen inference failed.")
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait()
    return score_artifacts(output)


def process(service, job, run, limit, pipeline='frozen', batch_size=8, cache_dir=None):
    lease = {"jobId": str(UUID(job["id"])), "leaseToken": job["lease_token"]}
    stop, lost = threading.Event(), threading.Event()

    def keep_lease():
        while not stop.wait(45):
            try:
                service.post("worker-heartbeat", **lease)
            except (RuntimeError, requests.RequestException):
                lost.set()
                break

    watcher = threading.Thread(target=keep_lease, daemon=True)
    watcher.start()
    stage = "download"
    try:
        suffix = Path(job["filename"]).suffix.lower()
        if suffix not in {".tif", ".tiff"}:
            raise ValueError("Unsupported input format.")
        directory_context = job_directory(cache_dir,job['id']) if pipeline=='direct' and cache_dir else tempfile.TemporaryDirectory(prefix="stegasus-", dir=os.getenv("WORKER_TMP") or None)
        with directory_context as directory:
            base = Path(directory)
            slide = base / ("input" + suffix)
            if type(job['size_bytes']) is not int or not 0 < job['size_bytes'] <= limit:
                raise RuntimeError('Declared input size exceeds the laboratory limit.')
            if pipeline=='direct' and cache_dir:
                reused=verified_download(slide,job,lambda target:fetch_slide(job['downloadUrl'],target,lost,limit,job['size_bytes']))
                print('Verified input cache reused.' if reused else 'Input downloaded and verified.',flush=True)
            else:
                fetch_slide(job["downloadUrl"], slide, lost, limit, job["size_bytes"])
            stage = "frozen computation"
            result = compute(slide, base / "outputs", run, lost, pipeline, batch_size)
            stage = "artifact transfer"
            artifacts = []
            for kind, (filename, mime) in ARTIFACTS.items():
                if lost.is_set():
                    raise RuntimeError("Lease lost.")
                target = service.post("worker-artifact", **lease, kind=kind, mimeType=mime)
                with (base / "outputs" / filename).open("rb") as stream:
                    response = requests.put(signed_url(target["uploadUrl"]), data=stream,
                                            headers={"Content-Type": mime}, timeout=(15, 120), allow_redirects=False)
                    if not 200 <= response.status_code < 300:
                        raise RuntimeError("Private artifact upload failed.")
                artifacts.append(dict(kind=kind, key=target["key"], mimeType=mime))
            if not lost.is_set():
                service.post("worker-complete", **lease, result=result, artifacts=artifacts)
    except Exception as exc:
        # Exclude paths, signed URLs and credentials from remote error records.
        if not lost.is_set():
            service.post("worker-fail", **lease, error=f"Failed during {stage} ({type(exc).__name__}).")
        print(f"Job stopped during {stage} ({type(exc).__name__}).", flush=True)
    finally:
        stop.set()
        watcher.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify local weights, code and libraries.")
    parser.add_argument("--slide", type=Path, help="Run the frozen model on one authorized local TIFF.")
    parser.add_argument("--output", type=Path, help="New directory for local computation outputs.")
    parser.add_argument("--run", type=Path, default=os.getenv("STEGASUS_MODEL_RUN"))
    parser.add_argument('--pipeline', choices=['frozen','direct'], default=os.getenv('STEGASUS_PIPELINE','frozen'))
    parser.add_argument('--batch-size', type=int, default=int(os.getenv('STEGASUS_BATCH_SIZE','8')))
    parser.add_argument('--cache-dir', type=Path, default=os.getenv('WORKER_CACHE'),help='Optional private persistent cache for direct mode; retains slides until manually removed.')
    args = parser.parse_args()
    if not 1 <= args.batch_size <= 256:
        parser.error('Batch size must be between 1 and 256.')
    if not args.run or bool(args.slide) != bool(args.output):
        parser.error("Set --run or STEGASUS_MODEL_RUN; --slide and --output must be supplied together.")
    run = Path(args.run).resolve()
    verify_installation(run)
    if args.slide:
        args.output.mkdir(parents=True, exist_ok=args.pipeline=='direct')
        print(json.dumps(compute(args.slide.resolve(), args.output.resolve(), run, threading.Event(), args.pipeline, args.batch_size), indent=2))
    elif args.check:
        print("Verified frozen source, checkpoints, calibration and runtime.")
    else:
        service = Service()
        limit = int(os.getenv("WORKER_MAX_BYTES", str(5 * 1024**3)))
        while True:
            try:
                service.post("worker-heartbeat")
                assignment = service.post("worker-claim").get("job")
                if assignment:
                    process(service, assignment, run, limit, args.pipeline, args.batch_size, args.cache_dir)
                    continue
            except (RuntimeError, requests.RequestException) as exc:
                print(f"Worker network/API failure ({type(exc).__name__}); retrying.", flush=True)
            time.sleep(15)


if __name__ == "__main__":
    main()
