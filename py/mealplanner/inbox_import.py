"""Recipes handed over by the Recipes app, taken in the moment they land.

The Recipes app drops files in DATA_DIR/inbox: `*.txt` = a recipe to add (read like a note), `*.json`
= a star / delete made over there. They used to be picked up only by an open Meal Planner window,
every 20 seconds, one slow lookup at a time. Now meal-planner-inbox.path runs this the instant the
folder isn't empty (nothing stays running), and a running app calls the same `run_once()` -- one
implementation, and a file is CLAIMED by renaming it first so two takers never both import it.

The recipe is saved at once with its ingredients as plain names; the USDA matching (nutrition, portions,
which list they go on) follows afterwards, so the recipe is usable straight away.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

from . import bangers, board, ingredients, recipe_import, recipes
from .paths import DATA_DIR

INBOX = DATA_DIR / "inbox"
log = logging.getLogger("meal-planner-inbox")


def norm_url(u: str) -> str:
    return re.sub(r"[?#].*$", "", (u or "").strip().lower()).rstrip("/")


def find_recipe(url: str, name: str) -> Optional[dict]:
    """The Recipes app's recipe in ours: by its page address, else by name."""
    all_ = recipes.list_recipes()
    if url:
        hit = next((r for r in all_ if norm_url(r.get("source_url", "")) == norm_url(url)), None)
        if hit:
            return hit
    return next((r for r in all_ if name and r["name"].strip().lower() == name.strip().lower()), None)


def apply_ops(d: Path) -> int:
    """Stars and deletes made in the Recipes app (inbox/*.json). An op whose recipe hasn't arrived
    yet (its .txt comes separately) waits for a later pass, and is dropped after a day."""
    n = 0
    for f in sorted(d.glob("*.json")):
        try:
            op = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            f.unlink(missing_ok=True)
            continue
        rec = find_recipe(op.get("url", ""), op.get("name", ""))
        if rec is None:
            if time.time() - f.stat().st_mtime > 86400 or op.get("op") == "delete":
                f.unlink(missing_ok=True)        # nothing to delete / too old to wait for
            continue
        kind = op.get("op")
        if kind == "delete":
            for b in [b for b in bangers.list_bangers() if b["recipe_id"] == rec["id"]]:
                bangers.delete(b["id"])
            recipes.delete(rec["id"])
        elif kind == "stars":                    # the full set of meals this recipe is a banger for
            want = {m for m in op.get("meals", []) if m in board.MEALS}
            have = {b["meal"]: b for b in bangers.list_bangers() if b["recipe_id"] == rec["id"]}
            for m in want - set(have):
                bangers.add(m, rec["id"])
            for m in set(have) - want:
                bangers.delete(have[m]["id"])
        f.unlink(missing_ok=True)
        n += 1
    return n


def import_text(text: str) -> Optional[str]:
    """One shared recipe into the list. Returns its name (also when it was already here), None when
    there was nothing to read. Never overwrites or duplicates: the same name, or the same source page
    even after a rename, keeps whatever was edited -- the Recipes app only ever adds."""
    parsed = recipe_import.parse_note(text)
    name = (parsed.get("name") or "").strip()
    if not name:
        return None
    link = (re.findall(r"https?://\S+", text) or [""])[-1]
    if find_recipe(link, name):
        return name
    by_name = {(i.get("name") or "").lower(): i for i in ingredients.list_ingredients()}
    rows, fresh = [], []
    for it in parsed.get("ingredients", []):
        if re.match(r"\s*https?://", it.get("name") or ""):
            continue                              # the source link, not an ingredient
        unit = it.get("unit") or "each"
        ing = by_name.get(it["name"].lower())
        if ing is None:
            ing = ingredients.add(it["name"], "other", unit, {}, None, None)
            by_name[it["name"].lower()] = ing
            fresh.append(ing["id"])
        rows.append({"ingredient_id": ing["id"], "qty": it.get("qty") or 0, "unit": unit, "note": it.get("note") or ""})
    recipe = recipes.add(name, 4, rows, ["shared"], parsed.get("notes") or "")
    if link:
        recipes.update(recipe["id"], source_url=link)
    for ing_id in fresh:                          # the USDA match, now that the recipe is already usable
        try:
            ingredients.resolve_usda(ing_id)
        except Exception as e:                    # no confident match / offline: it still plans and shops fine
            log.info("no USDA match for %s: %s", ing_id, e)
    return name


def run_once() -> int:
    """Everything in the inbox, now. Returns how many recipes were added / ops applied."""
    if not INBOX.exists():
        return 0
    done = apply_ops(INBOX)
    for f in sorted(INBOX.glob("*.txt")):
        claim = f.with_suffix(".txt.taking")
        try:
            os.rename(f, claim)                   # whoever renames it first owns it
        except OSError:
            continue
        try:
            if import_text(claim.read_text(encoding="utf-8", errors="replace")) is not None:
                done += 1
        except Exception:
            log.exception("could not import %s", f.name)
            os.rename(claim, f)                   # leave it for the next pass
            continue
        claim.unlink(missing_ok=True)
    return done


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(run_once())
