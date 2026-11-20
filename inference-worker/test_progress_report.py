import unittest
from progress_report import Progress

class Tests(unittest.TestCase):
    def test_rates_need_measurement_and_resumed_work_is_not_counted_as_new(self):
        clock=[0];p=Progress(clock=lambda:clock[0]);p.line('100/1000 tiles saved; Ctrl+C is safe')
        self.assertIsNone(p.snapshot()['etaSeconds'])
        clock[0]=20;p.line('200/1000 tiles saved; Ctrl+C is safe')
        self.assertEqual(p.snapshot()['etaSeconds'],160)
        self.assertEqual(p.snapshot()['etaScope'],'stage')
        p.line('Patch processing complete: 1000/1000; graph aggregation next')
        self.assertIsNone(p.snapshot()['etaSeconds'])
    def test_history_allows_total_eta_but_never_negative_countdown(self):
        clock=[0];p=Progress(clock=lambda:clock[0],expected_total=240)
        clock[0]=60;self.assertEqual(p.snapshot()['etaSeconds'],180)
        clock[0]=300;self.assertIsNone(p.snapshot()['etaSeconds'])
    def test_direct_log_and_download_progress(self):
        p=Progress();p.line('112/500 grid patches cached; device=cuda; elapsed=40s')
        self.assertEqual(p.snapshot()['completed'],112)
        p.update('download',50,100);self.assertEqual(p.snapshot()['total'],100)

if __name__=='__main__':unittest.main()
