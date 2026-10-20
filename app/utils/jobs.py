"""Single background worker with persistent history and cooperative cancellation."""
import copy
import itertools
import json
import logging
import os
import threading
import time

from utils.file_handler import write_json_atomic

KEEP = 10


class JobProgress:
    def __init__(self, runner, job):
        self.runner, self.job = runner, job

    def __call__(self, done, total):
        with self.runner._lock:
            self.job.update(done=done, total=total)
            self.runner._save()

    def cancelled(self):
        with self.runner._lock:
            return self.job['cancel_requested']

    def plan(self, asset_ids):
        with self.runner._lock:
            self.job.update(remaining_assets=list(asset_ids), total=len(asset_ids), done=0)
            self.runner._save()

    def complete(self, asset_id, error=None):
        with self.runner._lock:
            if error:
                self.job['errors'][asset_id] = str(error)
            if asset_id in self.job['remaining_assets']:
                self.job['remaining_assets'].remove(asset_id)
                self.job['done'] += 1
            self.runner._save()

    def result(self, result):
        with self.runner._lock:
            self.job['result'] = copy.deepcopy(result)
            self.runner._save()


class JobRunner:
    def __init__(self, path=None):
        self._lock = threading.RLock()
        self.path = path
        self._jobs = {}
        self._thread = None
        self._started = {}
        self._finished = {}
        if path and os.path.exists(path):
            with open(path) as stream:
                history = json.load(stream)
            for job in history:
                if job['status'] == 'running':
                    job.update(status='interrupted', error='Application restarted before the job finished',
                               finished_at=time.time())
                self._jobs[job['id']] = job
                if job['status'] == 'done':
                    self._finished[job['kind']] = job['id']
            self._save()
        self._ids = itertools.count(max(self._jobs, default=0) + 1)

    def _save(self):
        if self.path:
            write_json_atomic(self.path, list(self._jobs.values()))

    @staticmethod
    def _snapshot(job):
        result = copy.deepcopy(job)
        result['elapsed_seconds'] = max(0, (job.get('finished_at') or time.time()) - job['started_at'])
        return result

    def _running(self):
        return next((job for job in self._jobs.values() if job['status'] == 'running'), None)

    def running(self):
        with self._lock:
            job = self._running()
            return self._snapshot(job) if job else None

    def history(self):
        with self._lock:
            return [self._snapshot(job) for job in reversed(list(self._jobs.values()))]

    def start(self, kind, work, scope=None):
        with self._lock:
            running = self._running()
            if running:
                return self._snapshot(running), False
            job = {'id': next(self._ids), 'kind': kind, 'status': 'running',
                   'done': 0, 'total': 0, 'result': None, 'error': None,
                   'errors': {}, 'remaining_assets': [], 'cancel_requested': False,
                   'started_at': time.time(), 'finished_at': None, 'scope': scope}
            self._jobs[job['id']] = job
            self._started[kind] = time.monotonic()
            for old in sorted(self._jobs)[:-KEEP]:
                del self._jobs[old]
            try:
                self._save()
            except Exception:
                del self._jobs[job['id']]
                raise
            self._thread = threading.Thread(target=self._run, args=(job, work), name=f'job-{kind}', daemon=True)
            self._thread.start()
            return self._snapshot(job), True

    def _run(self, job, work):
        try:
            result = work(JobProgress(self, job))
            with self._lock:
                job.update(status='cancelled' if job['cancel_requested'] else 'done', result=result)
                if job['status'] == 'done':
                    self._finished[job['kind']] = job['id']
        except Exception as error:
            logging.exception('%s job failed', job['kind'])
            with self._lock:
                job.update(status='cancelled' if job['cancel_requested'] else 'failed', error=str(error))
        finally:
            with self._lock:
                job['finished_at'] = time.time()
                try:
                    self._save()
                except OSError:
                    logging.exception('Could not persist job history')

    def cancel(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job['status'] == 'running':
                job['cancel_requested'] = True
                self._save()
            return self._snapshot(job) if job else None

    def last_started(self, kind):
        with self._lock:
            return self._started.get(kind)

    def last_finished(self, kind):
        with self._lock:
            return self._finished.get(kind)

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return self._snapshot(job) if job else None

    def join(self, timeout=None):
        if self._thread:
            self._thread.join(timeout)
