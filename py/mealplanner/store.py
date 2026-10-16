"""Atomic JSON load/save, shared by every data module.

A plain Path.write_text() (what the sibling apps use for their disposable
caches) leaves a window where a crash mid-write truncates the file. A
recipe box and a season of learning history are worth more than that, so
saves here go to a temp file first and land with os.replace(), which is
atomic on the same filesystem -- readers never see a half-written file.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_locks: dict[Path, threading.RLock] = {}
_locks_guard = threading.Lock()


def _lock_for(path: Path) -> threading.RLock:
    with _locks_guard:
        lock = _locks.setdefault(path, threading.RLock())
    return lock


def load(path: Path, default: Any) -> Any:
    lock = _lock_for(path)
    with lock:
        if not path.exists():
            return json.loads(json.dumps(default))  # deep copy
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return json.loads(json.dumps(default))


def save(path: Path, data: Any) -> None:
    lock = _lock_for(path)
    with lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        os.replace(tmp, path)
