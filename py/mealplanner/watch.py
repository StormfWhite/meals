"""Tells the open windows the moment the data changes, without anyone asking.

A thread blocks on the kernel's inotify queue (stdlib ctypes, nothing to install): while nothing
changes it is asleep and costs no CPU -- no polling anywhere, which is the battery point. When one
of the plan's files is written (by this app, the phone through Dropbox, the importer) or something
lands in inbox/, `version` goes up and every waiting event stream wakes with one line.

Linux only. Where inotify isn't there (or the folder can't be watched) `available` is False and the
page falls back to its old slow check.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import os
import struct
import threading
from typing import Optional

from .paths import DATA_DIR

IN_CLOSE_WRITE, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x8, 0x80, 0x100, 0x200
MASK = IN_CLOSE_WRITE | IN_MOVED_TO | IN_CREATE | IN_DELETE
DATA_FILES = {f"{n}.json" for n in ("board", "recipes", "ingredients", "groceries", "stock", "household",
                                    "bangers", "places", "routines")}

cond = threading.Condition()
version = 0
log: list = []             # (version, kind) of recent changes -- each stream reads what is newer than it has seen
available = False
_started = False


def _bump(kind: str) -> None:
    global version
    with cond:
        version += 1
        log.append((version, kind))
        del log[:-200]
        cond.notify_all()


def _loop(fd: int, dirs: dict) -> None:
    while True:
        try:
            buf = os.read(fd, 8192)             # blocks: asleep until the kernel has something
        except OSError:
            return
        i = 0
        hit = set()
        while i + 16 <= len(buf):
            wd, mask, _, n = struct.unpack_from("iIII", buf, i)
            name = buf[i + 16:i + 16 + n].split(b"\0", 1)[0].decode("utf-8", "replace")
            i += 16 + n
            where = dirs.get(wd)
            if where == "inbox":
                hit.add("inbox")
            elif where == "data" and name in DATA_FILES:
                hit.add("data")
        for k in hit:
            _bump(k)


def start() -> bool:
    global available, _started
    if _started:
        return available
    _started = True
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        fd = libc.inotify_init1(os.O_CLOEXEC)
        if fd < 0:
            return False
        dirs = {}
        for path, tag in ((DATA_DIR, "data"), (DATA_DIR / "inbox", "inbox")):
            path.mkdir(parents=True, exist_ok=True)
            wd = libc.inotify_add_watch(fd, str(path).encode(), MASK)
            if wd < 0:
                return False
            dirs[wd] = tag
        threading.Thread(target=_loop, args=(fd, dirs), daemon=True, name="data-watch").start()
        available = True
    except Exception:
        available = False
    return available


def wait(seen: int, timeout: float) -> tuple[int, set]:
    """Block until `version` moves past `seen` (or the timeout); returns (version, what changed)."""
    with cond:
        if version == seen:
            cond.wait(timeout)
        return version, {k for v, k in log if v > seen}
