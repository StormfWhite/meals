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


# Per kg of body weight: protein 1.2 g (above the 0.8 floor, below the 1.6 of hard training),
# about 32 kcal (a moderately active adult -- only an estimate without height/age), and fiber
# 14 g per 1000 kcal. Vitamins and minerals don't scale with weight: gaps.NUTRIENTS' adult ones.
PROTEIN_G_PER_KG = 1.2
KCAL_PER_KG = 32
LB = 0.45359237


def targets_for_weight(weight_lb: float) -> dict:
    kg = weight_lb * LB
    kcal = round(kg * KCAL_PER_KG / 10) * 10
    from .gaps import NUTRIENTS, TOP_LEVEL   # gaps imports this module
    return {"calories_kcal": kcal, "protein_g": round(kg * PROTEIN_G_PER_KG),
            "fiber_g": round(kcal / 1000 * 14),
            "vitamins": {k: v for k, _, _, v in NUTRIENTS if k not in TOP_LEVEL}}


def _load() -> dict:
    return store.load(HOUSEHOLD_FILE, {"members": []})


def _save(data: dict) -> None:
    store.save(HOUSEHOLD_FILE, data)


def list_members() -> list[dict]:
    return _load()["members"]


def get_member(member_id: str) -> Optional[dict]:
    return next((m for m in list_members() if m["id"] == member_id), None)


def add_member(name: str, targets: Optional[dict] = None, weight_lb: Optional[float] = None) -> dict:
    data = _load()
    member = {
        "id": "m_" + uuid.uuid4().hex[:8],
        "name": name.strip(),
        "targets": {**DEFAULT_TARGETS, **(targets_for_weight(weight_lb) if weight_lb else {}), **(targets or {})},
        "active": True,
    }
    if weight_lb:
        member["weight_lb"] = weight_lb
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


def share(member: dict) -> float:
    """How much of each shared meal this member eats: their own `share`, else an even split."""
    return float(member.get("share") or 1.0 / max(1, active_count()))


def portion(member: dict, eaters: Optional[list] = None) -> float:
    """How much of one planned meal (its whole pot) this member eats. A meal is everyone's unless
    its slot names `eaters` (Storm: "some we could designate to joanna or to me like extra
    meals"); then it's split among just those, by their shares."""
    active = [m for m in list_members() if m.get("active", True)]
    eat = [m for m in active if m["id"] in eaters] if eaters else active
    if member["id"] not in {m["id"] for m in eat}:
        return 0.0
    return share(member) / sum(share(m) for m in eat)


def active_count() -> int:
    return sum(1 for m in list_members() if m.get("active", True))
