"""Reusable local inference child. No network listener and no queue access."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from uuid import uuid4

PREFIX = 'STEGASUS_ENGINE_RESULT '


class ResidentEngine:
    def __init__(self, command=None):
        self.command = command or [sys.executable, '-u', str(Path(__file__).resolve()), '--child']
        self.child = None
        self.reader = None
        self.lines = None

    def _start(self):
        if self.child is not None and self.child.poll() is None:
            return
        self.close()
        env = {k:v for k,v in os.environ.items() if k not in {
            'WORKER_TOKEN','SUPABASE_SERVICE_ROLE_KEY','AWS_SECRET_ACCESS_KEY','R2_SECRET_ACCESS_KEY'}}
        env['PYTHONIOENCODING'] = 'utf-8'
        self.lines = queue.Queue()
        self.child = subprocess.Popen(self.command, env=env, stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      text=True, encoding='utf-8', errors='replace', bufsize=1)
        child, lines = self.child, self.lines
        def read():
            try:
                for line in child.stdout:
                    lines.put(line)
            finally:
                lines.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def compute(self, argv, output, lost, progress=None):
        if lost.is_set():
            self.close()
            raise RuntimeError('Job lease lost; no computation started.')
        self._start()
        request_id = str(uuid4())
        output.mkdir(parents=True, exist_ok=True)
        try:
            self.child.stdin.write(json.dumps({'id':request_id,'argv':argv})+'\n')
            self.child.stdin.flush()
            with (output/'processing.log').open('a',encoding='utf-8') as log:
                while True:
                    if lost.is_set():
                        raise RuntimeError('Job lease lost; resident inference stopped.')
                    try:
                        line = self.lines.get(timeout=.5)
                    except queue.Empty:
                        continue
                    if line is None:
                        raise RuntimeError('Resident inference exited unexpectedly; inspect processing.log.')
                    if line.startswith(PREFIX):
                        result = json.loads(line[len(PREFIX):])
                        if result.get('id') == request_id:
                            if not result.get('ok'):
                                raise RuntimeError('Resident inference failed; inspect processing.log.')
                            return
                    log.write(line); log.flush()
                    if progress:
                        progress.line(line)
                    print(line,end='',flush=True)
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.child is not None:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.child.kill(); self.child.wait()
            if self.reader:
                self.reader.join(timeout=5)
            for stream in (self.child.stdin,self.child.stdout):
                if stream:
                    stream.close()
        self.child = None
        self.reader = None


def child_main():
    from contextlib import ExitStack
    import traceback
    from model_pool import ModelPool
    from direct_pipeline import run
    pool = ModelPool()
    for line in sys.stdin:
        request = json.loads(line)
        ok = False
        try:
            with ExitStack() as resources:
                run(resources, request['argv'], pool)
            ok = True
        except (Exception, SystemExit):
            traceback.print_exc(file=sys.stdout)
            pool.clear()
        print(PREFIX+json.dumps({'id':request['id'],'ok':ok}),flush=True)


if __name__ == '__main__':
    child_main()
