"""Short-lived, authenticated transfer of a single serialized SQLite result."""

import gzip
import hashlib
import secrets
import threading
import time


PART_BYTES = 16 * 1024
CACHE_BYTES = 32 * 1024 * 1024
MAX_RESULTS = 512
TTL_SECONDS = 120


class CacheFull(Exception):
    pass


class ResultParts:
    def __init__(self, clock=time.monotonic, capacity=CACHE_BYTES):
        self.clock = clock
        self.capacity = capacity
        self.entries = {}
        self.lock = threading.Lock()
        self.used = 0

    def expire(self):
        with self.lock:
            now = self.clock()
            while self.entries:
                key = next(iter(self.entries))
                expires, body = self.entries[key]
                if expires > now:
                    break
                del self.entries[key]
                self.used -= len(body)

    def put(self, body):
        packed = gzip.compress(body, compresslevel=1, mtime=0)
        digest = hashlib.sha256(packed).hexdigest()
        key = secrets.token_hex(24)
        self.expire()
        with self.lock:
            if len(self.entries) >= MAX_RESULTS or len(packed) > self.capacity - self.used:
                raise CacheFull
            self.entries[key] = (self.clock() + TTL_SECONDS, packed)
            self.used += len(packed)
        return {"transfer": {"id": key, "bytes": len(packed), "sha256": digest, "releasable": True}}

    def release(self, key):
        if not isinstance(key, str):
            raise ValueError("Invalid result id")
        with self.lock:
            entry = self.entries.pop(key, None)
            if entry is not None:
                self.used -= len(entry[1])

    def part(self, key, index):
        if not isinstance(key, str) or type(index) is not int or index < 0:
            raise ValueError("Invalid result part")
        with self.lock:
            entry = self.entries.get(key)
            if entry is None or entry[0] <= self.clock():
                raise KeyError(key)
            start = index * PART_BYTES
            if start >= len(entry[1]):
                raise ValueError("Invalid result part")
            return entry[1][start:start + PART_BYTES]
