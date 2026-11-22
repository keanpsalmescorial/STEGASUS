"""Bounded retries and lease fencing; never continue after ownership expires."""
from datetime import datetime, timezone
import logging
import time
import requests


class ApiError(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f'Worker API returned HTTP {status}.')


def transient(exc):
    return isinstance(exc, (requests.Timeout, requests.ConnectionError)) or (
        isinstance(exc, ApiError) and (exc.status in (408, 429) or exc.status >= 500))


def retry(operation, attempts=3, wait=time.sleep, stopped=lambda: False):
    for attempt in range(attempts):
        if stopped():
            raise RuntimeError('Operation stopped; job lease is unavailable.')
        try:
            return operation()
        except (requests.RequestException, ApiError) as exc:
            if not transient(exc) or attempt + 1 == attempts:
                raise
            wait(min(2 ** attempt, 8))


class LeaseGuard:
    def __init__(self, expires=None, clock=time.monotonic):
        self.clock = clock
        remaining = 300.0
        if expires:
            remaining = (datetime.fromisoformat(expires.replace('Z', '+00:00')) -
                         datetime.now(timezone.utc)).total_seconds()
        self.deadline = clock() + max(0, remaining - 60)

    def valid(self):
        return self.clock() < self.deadline

    def heartbeat(self, operation):
        if not self.valid():
            return False
        started = self.clock()
        try:
            operation()
        except (requests.RequestException, RuntimeError) as exc:
            if not transient(exc):
                logging.error('Heartbeat stopped (%s): lease cannot be renewed.', type(exc).__name__)
                return False
            logging.warning('Temporary heartbeat failure (%s); retrying inside the valid lease window.', type(exc).__name__)
            return self.valid()
        # Server renews for 300 s. Use request start and a 60 s safety margin.
        self.deadline = started + 240
        return self.valid()
