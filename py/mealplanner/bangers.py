"""Bangers: the meals Storm has judged the best, kept per meal type.

A banger is only a pointer (meal type + recipe id) -- the recipe stays the
single owner of ingredients and nutrition, so editing a recipe edits its
banger too. The same recipe may be a banger at two meal types.
"""
from __future__ import annotations

import uuid

from . import store
from .paths import BANGERS_FILE


def _load() -> dict:
    return store.load(BANGERS_FILE, {"bangers": []})


def list_bangers() -> list[dict]:
    return _load()["bangers"]


def add(meal: str, recipe_id: str) -> dict:
    data = _load()
    for b in data["bangers"]:
        if b["meal"] == meal and b["recipe_id"] == recipe_id:
            return b
    banger = {"id": "b_" + uuid.uuid4().hex[:8], "meal": meal, "recipe_id": recipe_id}
    data["bangers"].append(banger)
    store.save(BANGERS_FILE, data)
    return banger


def delete(banger_id: str) -> bool:
    data = _load()
    before = len(data["bangers"])
    data["bangers"] = [b for b in data["bangers"] if b["id"] != banger_id]
    store.save(BANGERS_FILE, data)
    return len(data["bangers"]) < before
