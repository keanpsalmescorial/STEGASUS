"""Bounded, ordered CPU prefetch with a separate OpenSlide handle per thread."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import threading
from patch_batches import read_patch


@contextmanager
def prefetched_patches(path, coordinates, level, region, workers=2, capacity=64):
    import openslide
    local = threading.local()
    handles = []
    mutex = threading.Lock()

    def read(coord):
        if not hasattr(local, 'slide'):
            local.slide = openslide.OpenSlide(str(path))
            with mutex:
                handles.append(local.slide)
        image, fraction = read_patch(local.slide, *coord, level, region)
        return (*coord, fraction, image)

    executor = ThreadPoolExecutor(max_workers=workers)
    pending = deque()
    source = iter(coordinates)

    def ordered():
        for _ in range(capacity):
            coord = next(source, None)
            if coord is None:
                break
            pending.append(executor.submit(read, coord))
        while pending:
            result = pending.popleft().result()
            coord = next(source, None)
            if coord is not None:
                pending.append(executor.submit(read, coord))
            yield result

    try:
        yield ordered()
    finally:
        for future in pending:
            future.cancel()
        executor.shutdown(wait=True, cancel_futures=True)
        for handle in handles:
            handle.close()
