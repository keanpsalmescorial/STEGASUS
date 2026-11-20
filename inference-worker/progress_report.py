"""Measured stage telemetry. No fabricated whole-slide countdown."""
import re
import threading
import time

STAGES=('download','preparing','patches','graph','artifacts','complete')


class Progress:
    def __init__(self,pipeline='frozen',clock=time.monotonic,expected_total=None):
        self.clock=clock;self.started=clock();self.stage_started=self.started
        self.stage='download';self.completed=0;self.total=0
        self.baseline=0;self.pipeline=pipeline;self.expected_total=expected_total
        self.lock=threading.Lock()

    def update(self,stage,completed=0,total=0):
        with self.lock:
            if stage!=self.stage:
                self.stage=stage;self.stage_started=self.clock();self.baseline=completed
            self.completed=completed;self.total=total

    def line(self,text):
        match=re.search(r'(\d+)/(\d+) (?:tiles saved|grid patches cached)',text)
        if match:self.update('patches',int(match[1]),int(match[2]))
        if 'graph aggregation next' in text:self.update('graph')

    def snapshot(self):
        with self.lock:
            elapsed=max(0,self.clock()-self.started)
            stage_elapsed=max(0,self.clock()-self.stage_started)
            advanced=self.completed-self.baseline
            eta=None;scope=None
            if advanced>0 and self.total>self.completed and stage_elapsed>=10:
                eta=stage_elapsed*(self.total-self.completed)/advanced;scope='stage'
            if self.expected_total and self.expected_total>elapsed and self.stage!='complete':
                eta=max(self.expected_total-elapsed,eta or 0);scope='total'
            return dict(stage=self.stage,completed=self.completed,total=self.total,
                        elapsedSeconds=round(elapsed,1),etaSeconds=round(eta,1) if eta is not None else None,
                        etaScope=scope,pipeline=self.pipeline)
