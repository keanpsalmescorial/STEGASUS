"""Subprocess protocol tests using a stub child, never real slide inference."""
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from model_pool import ModelPool
from resident_engine import ResidentEngine

STUB = '''import json,os,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if 'WORKER_TOKEN' in os.environ: raise RuntimeError('credential passed to child')
    if request['argv']==['wait']: time.sleep(30)
    print('stub progress',flush=True)
    print('STEGASUS_ENGINE_RESULT '+json.dumps({'id':request['id'],'ok':request['argv']!=['fail']}),flush=True)
'''


class Tests(unittest.TestCase):
    def test_pool_reuses_identity_and_reloads_changed_weights(self):
        pool=ModelPool();calls=[]
        def load(): calls.append(1);return object()
        first=pool.get(('hash-a','cuda'),load)
        self.assertIs(pool.get(('hash-a','cuda'),load),first)
        self.assertIsNot(pool.get(('hash-b','cuda'),load),first)
        self.assertEqual(len(calls),2)
        pool.clear();self.assertIsNone(pool.bundle)

    def test_pool_never_caches_failed_initialization(self):
        pool=ModelPool()
        def fail(): raise RuntimeError('load failed')
        with self.assertRaises(RuntimeError): pool.get('hash',fail)
        self.assertIsNone(pool.key)

    def test_child_is_reused_and_credentials_are_removed(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name);stub=output/'stub.py';stub.write_text(STUB)
            engine=ResidentEngine([sys.executable,'-u',str(stub)])
            previous=os.environ.get('WORKER_TOKEN')
            os.environ['WORKER_TOKEN']='test-only'
            try:
                engine.compute([],output,threading.Event());pid=engine.child.pid
                engine.compute([],output,threading.Event())
                self.assertEqual(engine.child.pid,pid)
                self.assertIn('stub progress',(output/'processing.log').read_text())
            finally:
                engine.close()
                if previous is None: os.environ.pop('WORKER_TOKEN',None)
                else: os.environ['WORKER_TOKEN']=previous

    def test_failure_resets_child_and_preexisting_loss_does_not_start_one(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name);stub=output/'stub.py';stub.write_text(STUB)
            engine=ResidentEngine([sys.executable,'-u',str(stub)])
            try:
                with self.assertRaises(RuntimeError): engine.compute(['fail'],output,threading.Event())
                self.assertIsNone(engine.child)
                lost=threading.Event();lost.set()
                with self.assertRaises(RuntimeError):engine.compute([],output,lost)
                self.assertIsNone(engine.child)
            finally: engine.close()

    def test_mid_job_lease_loss_terminates_child(self):
        with tempfile.TemporaryDirectory() as name:
            output=Path(name);stub=output/'stub.py';stub.write_text(STUB)
            engine=ResidentEngine([sys.executable,'-u',str(stub)])
            lost=threading.Event();timer=threading.Timer(.2,lost.set)
            try:
                timer.start()
                with self.assertRaises(RuntimeError):engine.compute(['wait'],output,lost)
                self.assertIsNone(engine.child)
            finally: timer.cancel();engine.close()


if __name__=='__main__':unittest.main()
