"""Recipes: a name, a servings count, and a list of ingredient quantities.

`last_ingredients` is the list the meal was last saved with -- picking the meal again fills
that in, amounts and all (Storm 2026-10-22). `source_url` / `photos` are where the recipe
came from: a web page, or pictures of a cookbook page (files in DATA_DIR/photos).

Nutrition is deliberately not a field here -- see nutrition.py's docstring.
"""
from __future__ import annotations

import re
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
    for key in ("name", "servings", "ingredients", "tags", "notes", "hide_suggest",
                "source_url", "photos", "last_ingredients"):
        if key in fields and fields[key] is not None:
            recipe[key] = fields[key].strip() if key in ("name", "source_url") else fields[key]
    if fields.get("ingredients") is not None and fields.get("last_ingredients") is None:
        recipe["last_ingredients"] = fields["ingredients"]     # the newest list is the one just written
    recipe["updated_at"] = time.time()
    _save(data)
    return recipe


TRASH_DAYS = 30


def delete(recipe_id: str, bangers: Optional[list[dict]] = None) -> bool:
    """Moves the recipe to the trash (30 days) rather than erasing it, with the bangers (stars) it had,
    so `restore` can put back exactly what was there -- same id, so plan slots still point at it."""
    data = _load()
    rec = next((r for r in data["recipes"] if r["id"] == recipe_id), None)
    if rec is None:
        return False
    now = time.time()
    data["recipes"] = [r for r in data["recipes"] if r["id"] != recipe_id]
    trash = [t for t in data.get("trash", []) if now - t.get("deleted_at", now) < TRASH_DAYS * 86400]
    trash.append({"recipe": rec, "bangers": list(bangers or []), "deleted_at": now})
    data["trash"] = trash
    _save(data)
    return True


def find_trashed(recipe_id: str = "", url: str = "", name: str = "") -> Optional[dict]:
    """Newest trash entry matching the id, else the page address, else the name."""
    def norm(u):
        return re.sub(r"[?#].*$", "", (u or "").strip().lower()).rstrip("/")
    for t in reversed(_load().get("trash", [])):
        r = t["recipe"]
        if recipe_id and r["id"] == recipe_id:
            return t
        if url and norm(r.get("source_url", "")) == norm(url):
            return t
        if name and r["name"].strip().lower() == name.strip().lower():
            return t
    return None


def restore(recipe_id: str = "", url: str = "", name: str = "") -> Optional[dict]:
    """Takes a recipe back out of the trash (same id) and returns {"recipe", "bangers"}, or None."""
    t = find_trashed(recipe_id, url, name)
    if t is None:
        return None
    data = _load()
    rid = t["recipe"]["id"]
    data["trash"] = [x for x in data.get("trash", []) if x is not t and x["recipe"]["id"] != rid]
    if not any(r["id"] == rid for r in data["recipes"]):
        data["recipes"].append(t["recipe"])
    _save(data)
    return {"recipe": t["recipe"], "bangers": t["bangers"]}
