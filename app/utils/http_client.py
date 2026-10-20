"""Thread-local sessions: reuse connections without sharing mutable sessions."""
import threading
import requests
from requests.adapters import HTTPAdapter

class HttpClient:
    """Keep each integration's cookies and sessions isolated from other clients."""
    def __init__(self):
        self._local = threading.local()

    def session(self):
        client = getattr(self._local, 'client', None)
        if client is None:
            client = requests.Session()
            # Do not automatically retry mutations: an upload may already have succeeded.
            adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
            client.mount('http://', adapter)
            client.mount('https://', adapter)
            self._local.client = client
        return client
