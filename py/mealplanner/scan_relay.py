"""Reads the phone's pantry photos on this laptop (pantry_scan.py needs StudyCode's model_manager).

The phone can't run the model itself, so its bridge drops the photo into the shared Dropbox folder
and waits for the answer beside it:

    scan-in/<id>.json    {"id": ..., "image": "data:image/jpeg;base64,...", "where": "fridge" | null}
    scan-out/<id>.json   {"ok": true, "result": {"where": ..., "items": [...]}}  /  {"ok": false, "error": ...}

Nothing stays running: meal-planner-scan.path starts this (meal-planner-scan.service) when scan-in
isn't empty, it answers everything there and exits. A request older than STALE_S is dropped -- the
phone gave up on it long ago. Answers are swept after an hour.
"""
from __future__ import annotations

import json
import logging
import os
import time

from . import pantry_scan
from .paths import DATA_DIR

INBOX = DATA_DIR / "scan-in"
OUTBOX = DATA_DIR / "scan-out"
STALE_S = 15 * 60
KEEP_S = 60 * 60
log = logging.getLogger("meal-planner-scan")


def _write(path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    os.replace(tmp, path)


def answer(req_path) -> None:
    rid = req_path.stem
    try:
        req = json.loads(req_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        if time.time() - req_path.stat().st_mtime < 30:
            return                                   # still arriving
        req_path.unlink(missing_ok=True)
        return
    if time.time() - req_path.stat().st_mtime > STALE_S:
        req_path.unlink(missing_ok=True)
        return
    log.info("reading %s", rid)
    try:
        image, mime = pantry_scan.decode_image(req.get("image") or "")
        out = {"ok": True, "result": pantry_scan.scan(image, req.get("where"), mime)}
    except Exception as e:                          # noqa: BLE001 - the phone shows it
        out = {"ok": False, "error": str(e) or e.__class__.__name__}
    _write(OUTBOX / f"{rid}.json", out)
    req_path.unlink(missing_ok=True)
    log.info("answered %s (%s)", rid, "ok" if out["ok"] else out["error"])


def run() -> None:
    INBOX.mkdir(parents=True, exist_ok=True)
    OUTBOX.mkdir(parents=True, exist_ok=True)
    for old in OUTBOX.glob("*.json"):
        if time.time() - old.stat().st_mtime > KEEP_S:
            old.unlink(missing_ok=True)
    waited = 0
    while True:
        reqs = sorted(INBOX.glob("*.json"), key=lambda p: p.stat().st_mtime)
        if not reqs:
            return
        before = len(reqs)
        for p in reqs:
            answer(p)
        if len(list(INBOX.glob("*.json"))) >= before:   # only half-arrived ones left: give them a moment
            waited += 1
            if waited > 15:
                return
            time.sleep(2)
        # stray non-request files (Dropbox conflict copies) would keep the path unit firing
        for p in INBOX.iterdir():
            if p.suffix != ".json" and time.time() - p.stat().st_mtime > 60:
                p.unlink(missing_ok=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    run()
