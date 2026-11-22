import unittest
from unittest.mock import patch
import requests
from worker_connection import ApiError, LeaseGuard, retry


class Tests(unittest.TestCase):
    def test_transient_heartbeat_preserves_live_lease_then_recovers(self):
        now = [0.0]
        guard = LeaseGuard(clock=lambda: now[0])
        def fail(): raise requests.ConnectTimeout()
        now[0] = 30
        self.assertTrue(guard.heartbeat(fail))
        now[0] = 60
        self.assertTrue(guard.heartbeat(lambda: None))
        now[0] = 299
        self.assertTrue(guard.valid())
        now[0] = 301
        self.assertFalse(guard.heartbeat(fail))

    def test_revocation_stops_immediately(self):
        for status in (400, 401, 403, 409):
            guard = LeaseGuard()
            def fail(): raise ApiError(status)
            self.assertFalse(guard.heartbeat(fail))

    def test_retries_transient_only_and_honors_stop(self):
        calls = []
        def operation():
            calls.append(1)
            if len(calls) < 3: raise ApiError(503)
            return 'done'
        self.assertEqual(retry(operation, wait=lambda _: None), 'done')
        self.assertEqual(len(calls), 3)
        calls.clear()
        def denied(): calls.append(1); raise ApiError(403)
        with self.assertRaises(ApiError): retry(denied, wait=lambda _: None)
        self.assertEqual(len(calls), 1)
        with self.assertRaises(RuntimeError): retry(operation, stopped=lambda: True)


if __name__ == '__main__': unittest.main()
