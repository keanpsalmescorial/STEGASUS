import tempfile
from pathlib import Path
import unittest
from job_cache import verified_download


class Tests(unittest.TestCase):
    def test_only_verified_downloads_are_reused_and_corruption_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            slide=Path(directory)/'input.tif';job={'id':'job','size_bytes':4};calls=[]
            def download(path):
                calls.append(1);path.write_bytes(b'test')
            self.assertFalse(verified_download(slide,job,download))
            self.assertTrue(verified_download(slide,job,download))
            slide.write_bytes(b'bad!')
            self.assertFalse(verified_download(slide,job,download))
            self.assertEqual(len(calls),2)

    def test_interrupted_download_never_becomes_a_reusable_input(self):
        with tempfile.TemporaryDirectory() as directory:
            slide=Path(directory)/'input.tif';job={'id':'job','size_bytes':4}
            def interrupted(path):
                path.write_bytes(b'te');raise RuntimeError('interrupted')
            with self.assertRaises(RuntimeError):verified_download(slide,job,interrupted)
            self.assertFalse(slide.exists())
            self.assertFalse(slide.with_suffix('.verified.json').exists())
            self.assertFalse(verified_download(slide,job,lambda path:path.write_bytes(b'test')))


if __name__=='__main__':unittest.main()
