import threading
import time
import unittest
from unittest.mock import patch
import openslide
from patch_prefetch import prefetched_patches


class Tests(unittest.TestCase):
    def test_order_bound_and_handles_closed_after_early_exit(self):
        handles = []
        reads = []
        class Slide:
            def __init__(self, path): self.closed = False; handles.append(self)
            def close(self): self.closed = True
        def read(slide, x, y, level, region):
            reads.append(x)
            time.sleep(.002 * (3 - x % 3))
            return x, .5
        with patch.object(openslide, 'OpenSlide', Slide), patch('patch_prefetch.read_patch', read):
            with prefetched_patches('slide', ((x,0) for x in range(100)), 0, (96,96), 2, 4) as patches:
                result = [next(patches) for _ in range(3)]
        self.assertEqual([row[0] for row in result], [0,1,2])
        self.assertLessEqual(len(reads), 7)
        self.assertTrue(handles)
        self.assertTrue(all(slide.closed for slide in handles))

    def test_read_errors_propagate_and_close_handles(self):
        handles = []
        class Slide:
            def __init__(self, path): self.closed=False; handles.append(self)
            def close(self): self.closed=True
        with patch.object(openslide, 'OpenSlide', Slide), patch('patch_prefetch.read_patch', side_effect=RuntimeError('bad TIFF')):
            with self.assertRaises(RuntimeError):
                with prefetched_patches('slide', [(0,0)], 0, (96,96), 1, 1) as patches:
                    list(patches)
        self.assertTrue(all(slide.closed for slide in handles))
