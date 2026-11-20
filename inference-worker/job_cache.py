"""Opt-in private per-job cache; interrupted downloads are never reused."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
from uuid import UUID


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


@contextmanager
def job_directory(root,job_id):
    import msvcrt
    base=Path(root).resolve()/str(UUID(job_id))
    base.mkdir(parents=True,exist_ok=True)
    with (base/'job.lock').open('a+b') as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b'0');lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        yield base


def verified_download(slide,job,download):
    receipt=slide.with_suffix('.verified.json')
    if slide.exists() and receipt.exists():
        try:
            identity=json.loads(receipt.read_text())
            if identity['job_id']==job['id'] and slide.stat().st_size==job['size_bytes'] and identity['sha256']==sha256(slide):
                return True
        except (ValueError,KeyError):
            pass
    partial=slide.with_suffix('.partial')
    partial.unlink(missing_ok=True)
    download(partial)
    if partial.stat().st_size!=job['size_bytes']:
        raise RuntimeError('Incomplete cached download.')
    identity={'job_id':job['id'],'sha256':sha256(partial)}
    partial.replace(slide)
    receipt.write_text(json.dumps(identity))
    return False
