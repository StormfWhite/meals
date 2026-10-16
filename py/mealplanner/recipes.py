"""Recipes: a name, a servings count, and a list of ingredient quantities.

Nutrition is deliberately not a field here -- see nutrition.py's docstring.
"""
from __future__ import annotations

import time
import uuid
from typing import Optional

from . import store
from .paths import RECIPES_FILE


def _load() -> dict:
    return store.load(RECIPES_FILE, {"recipes": []})


def _save(data: dict) -> None:
    store.save(RECIPES_FILE, data)


def list_recipes() -> list[dict]:
    return sorted(_load()["recipes"], key=lambda r: r["name"].lower())


def get(recipe_id: str) -> Optional[dict]:
    return next((r for r in _load()["recipes"] if r["id"] == recipe_id), None)


def add(name: str, servings: int, ingredients: list[dict],
        tags: Optional[list[str]] = None, notes: str = "") -> dict:
    data = _load()
    now = time.time()
    recipe = {
        "id": "r_" + uuid.uuid4().hex[:8],
        "name": name.strip(),
        "servings": max(1, int(servings)),
        "ingredients": ingredients,
        "tags": tags or [],
        "notes": notes,
        "created_at": now,
        "updated_at": now,
    }
    data["recipes"].append(recipe)
    _save(data)
    return recipe


def update(recipe_id: str, **fields) -> dict:
    data = _load()
    recipe = next((r for r in data["recipes"] if r["id"] == recipe_id), None)
    if recipe is None:
        raise KeyError(recipe_id)
    for key in ("name", "servings", "ingredients", "tags", "notes", "hide_suggest"):
        if key in fields and fields[key] is not None:
            recipe[key] = fields[key].strip() if key == "name" else fields[key]
    recipe["updated_at"] = time.time()
    _save(data)
    return recipe


def delete(recipe_id: str) -> bool:
    data = _load()
    before = len(data["recipes"])
    data["recipes"] = [r for r in data["recipes"] if r["id"] != recipe_id]
    _save(data)
    return len(data["recipes"]) < before
