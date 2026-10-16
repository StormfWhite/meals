"""Household members and their daily nutrition targets.

An editable list, not a fixed count -- Storm was explicit that the number
of people should be free to change, not something Settings asks for once
up front.
"""
from __future__ import annotations

import uuid
from typing import Optional

from . import store
from .paths import HOUSEHOLD_FILE

DEFAULT_TARGETS = {
    "calories_kcal": 2000,
    "protein_g": 50,
    "fiber_g": 28,
    "vitamins": {},
}


def _load() -> dict:
    return store.load(HOUSEHOLD_FILE, {"members": []})


def _save(data: dict) -> None:
    store.save(HOUSEHOLD_FILE, data)


def list_members() -> list[dict]:
    return _load()["members"]


def get_member(member_id: str) -> Optional[dict]:
    return next((m for m in list_members() if m["id"] == member_id), None)


def add_member(name: str, targets: Optional[dict] = None) -> dict:
    data = _load()
    member = {
        "id": "m_" + uuid.uuid4().hex[:8],
        "name": name.strip(),
        "targets": {**DEFAULT_TARGETS, **(targets or {})},
        "active": True,
    }
    data["members"].append(member)
    _save(data)
    return member


def update_member(member_id: str, **fields) -> dict:
    data = _load()
    member = next((m for m in data["members"] if m["id"] == member_id), None)
    if member is None:
        raise KeyError(member_id)
    if "name" in fields and fields["name"] is not None:
        member["name"] = fields["name"].strip()
    if "targets" in fields and fields["targets"] is not None:
        member["targets"] = {**DEFAULT_TARGETS, **fields["targets"]}
    if "active" in fields and fields["active"] is not None:
        member["active"] = bool(fields["active"])
    _save(data)
    return member


def delete_member(member_id: str) -> bool:
    data = _load()
    before = len(data["members"])
    data["members"] = [m for m in data["members"] if m["id"] != member_id]
    _save(data)
    return len(data["members"]) < before


def active_count() -> int:
    return sum(1 for m in list_members() if m.get("active", True))
