"""Versioned disposable JPEG cache shared by previews and uploads."""
import hashlib
import json
import os
import threading
import time

import config
from utils.image_processor import render_image, write_image_atomic

RENDERER_VERSION = 1
MAX_BYTES = 512 * 1024 * 1024
_lock = threading.RLock()
_render_locks = [threading.Lock() for _ in range(32)]


def cached_render(source, crop=None, target=None, max_size=None, metadata=True):
    stat = os.stat(source)
    key = hashlib.sha256(json.dumps([
        os.path.abspath(source), stat.st_mtime_ns, stat.st_size,
        crop, target, max_size, metadata, RENDERER_VERSION,
    ], sort_keys=True).encode()).hexdigest()
    directory = os.path.join(config.CACHE_DIR, 'renders')
    path = os.path.join(directory, key + '.jpg')
    # Coalesce duplicate work without holding the eviction lock during rendering.
    with _render_locks[int(key[:8], 16) % len(_render_locks)]:
        with _lock:
            if os.path.isfile(path):
                os.utime(path, None)
                with open(path, 'rb') as stream:
                    return stream.read(), key
        content = render_image(source, crop, target, max_size, metadata)
        with _lock:
            write_image_atomic(path, content)
            _prune(directory)
    return content, key


def _prune(directory):
    files = []
    for name in os.listdir(directory):
        if name.endswith('.jpg'):
            path = os.path.join(directory, name)
            stat = os.stat(path)
            files.append((stat.st_mtime, stat.st_size, path))
    total = sum(size for _, size, _ in files)
    for modified, size, path in sorted(files):
        if total <= MAX_BYTES and modified >= time.time() - 30 * 86400:
            break
        os.remove(path)
        total -= size
