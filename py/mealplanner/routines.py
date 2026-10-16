"""Meals that repeat: "smoothie every Monday breakfast", "oatmeal daily".

A routine is a rule, not a pile of copied slots. Nothing is written into
future weeks -- `board.get_week` materialises a routine's meal into any
week it reaches that hasn't already got something in that slot. That's
what makes editing one work the way you'd expect:

  change one week's copy   the real slot written that week wins over the
                           routine for that week only, and every other
                           week keeps following the rule
  clear one week's copy    a tombstone is written for that slot, so the
                           routine doesn't immediately put it back --
                           "not this Monday" is a real thing to want
  change the routine       every week that hasn't been touched follows

The alternative (stamping the meal into fifty-two weeks on the board)
would make "I changed my Monday breakfast" mean editing fifty-two rows,
and would fill board.json with meals nobody has planned yet.

`start_date` exists so turning a routine on today doesn't retroactively
claim to have eaten it every Monday since January -- history stays what
actually happened, which is what stats.py and suggest.py read.
"""
from __future__ import annotations

import datetime
import uuid
from typing import Optional

from . import store
from .paths import ROUTINES_FILE

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")


def _load() -> dict:
    return store.load(ROUTINES_FILE, {"routines": []})


def _save(data: dict) -> None:
    store.save(ROUTINES_FILE, data)


def list_routines() -> list[dict]:
    return _load()["routines"]


def get(routine_id: str) -> Optional[dict]:
    return next((r for r in _load()["routines"] if r["id"] == routine_id), None)


def add(meal: str, recipe_id: str, weekday: Optional[str] = None,
        start_date: Optional[str] = None, servings_used: float = 1,
        ingredient_overrides: Optional[list] = None) -> dict:
    """`weekday` None means every day; otherwise a lowercase weekday name."""
    data = _load()
    routine = {
        "id": "rt_" + uuid.uuid4().hex[:8],
        "meal": meal,
        "weekday": weekday if weekday in WEEKDAYS else None,
        "recipe_id": recipe_id,
        "servings_used": servings_used,
        "ingredient_overrides": ingredient_overrides,
        "start_date": start_date or datetime.date.today().isoformat(),
        "active": True,
    }
    # One rule per weekday+meal: hitting "every Monday" twice replaces the
    # rule rather than stacking two breakfasts on every Monday forever.
    data["routines"] = [r for r in data["routines"]
                        if not (r["meal"] == meal and r["weekday"] == routine["weekday"])]
    data["routines"].append(routine)
    _save(data)
    return routine


def update(routine_id: str, **fields) -> dict:
    data = _load()
    routine = next((r for r in data["routines"] if r["id"] == routine_id), None)
    if routine is None:
        raise KeyError(routine_id)
    for key in ("meal", "weekday", "recipe_id", "servings_used",
                "ingredient_overrides", "start_date", "active"):
        if key in fields and fields[key] is not None:
            routine[key] = fields[key]
    _save(data)
    return routine


def delete(routine_id: str) -> bool:
    data = _load()
    before = len(data["routines"])
    data["routines"] = [r for r in data["routines"] if r["id"] != routine_id]
    _save(data)
    return len(data["routines"]) < before


def for_date(date_iso: str) -> list[dict]:
    """Routines that apply to one date, in the order they were created."""
    try:
        date = datetime.date.fromisoformat(date_iso)
    except ValueError:
        return []
    weekday = WEEKDAYS[date.weekday()]
    out = []
    for routine in _load()["routines"]:
        if not routine.get("active", True):
            continue
        if routine.get("start_date") and date_iso < routine["start_date"]:
            continue
        if routine["weekday"] is not None and routine["weekday"] != weekday:
            continue
        out.append(routine)
    return out


def find(meal: str, weekday: Optional[str], recipe_id: Optional[str] = None) -> Optional[dict]:
    for routine in _load()["routines"]:
        if routine["meal"] != meal or routine["weekday"] != weekday:
            continue
        if recipe_id and routine["recipe_id"] != recipe_id:
            continue
        return routine
    return None
