"""Long Immich operations run in the background so requests return immediately.

Only one job runs at a time: sync and batch upload both walk the cache and the
albums, and overlapping them gains nothing. The UI polls a job by ID for progress.
"""
import itertools
import logging
import threading

KEEP = 10  # finished jobs retained for polling


class JobRunner:
    def __init__(self):
        self._lock = threading.Lock()
        self._ids = itertools.count(1)
        self._jobs = {}
        self._thread = None

    def _running(self):
        return next((j for j in self._jobs.values() if j["status"] == "running"), None)

    def running(self):
        """The running job, or None."""
        with self._lock:
            job = self._running()
            return dict(job) if job else None

    def start(self, kind, work):
        """Run work(progress) in a thread. Returns (job, started); if a job is
        already running, nothing starts and that job is returned instead."""
        with self._lock:
            running = self._running()
            if running:
                return dict(running), False
            job = {"id": next(self._ids), "kind": kind, "status": "running",
                   "done": 0, "total": 0, "result": None, "error": None}
            self._jobs[job["id"]] = job
            for old in sorted(self._jobs)[:-KEEP]:
                del self._jobs[old]
            self._thread = threading.Thread(target=self._run, args=(job, work), name=f"job-{kind}", daemon=True)
            self._thread.start()
            return dict(job), True

    def _run(self, job, work):
        def progress(done, total):
            with self._lock:
                job.update(done=done, total=total)
        try:
            result = work(progress)
            with self._lock:
                job.update(status="done", result=result)
        except Exception as e:
            logging.exception("%s job failed", job["kind"])
            with self._lock:
                job.update(status="failed", error=str(e))

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def join(self, timeout=None):
        """Wait for the most recently started job (used by tests)."""
        if self._thread:
            self._thread.join(timeout)
