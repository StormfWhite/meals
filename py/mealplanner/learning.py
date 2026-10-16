"""The learning loop: what actually happened to a planned quantity, and
what that teaches next week's default.

Deliberately simple -- no ML, no statistical tests. An exponential moving
average per ingredient (recent weeks outweigh old ones) and a plain "last
3 logs agree" rule for nudges. Both are logged by the user in three
seconds (pick an outcome, everything else is a sane auto-estimate you can
override), not measured with a kitchen scale.
"""
from __future__ import annotations

import time
from typing import Optional

from . import household, ingredients, store
from .paths import LEARNING_FILE

EVENT_CAP = 20
ALPHA = 0.35  # weight on the newest event; higher = faster to forget old weeks

# A rough, overridable guess at how much was actually used, given only the
# outcome -- logging should never be blocked on knowing an exact number.
AUTO_ESTIMATE_RATIO = {"ran_out": 1.15, "leftover": 0.7, "used_exactly": 1.0}


def _load() -> dict:
    return store.load(LEARNING_FILE, {"ingredients": {}, "meals": {}})


def _save(data: dict) -> None:
    store.save(LEARNING_FILE, data)


def _ema(previous: Optional[float], value: float) -> float:
    return value if previous is None else ALPHA * value + (1 - ALPHA) * previous


def log_ingredient(ingredient_id: str, week: str, planned_qty_g: float, outcome: str,
                   actual_qty_g: Optional[float] = None, bought_qty_g: Optional[float] = None) -> dict:
    data = _load()
    entry = data["ingredients"].setdefault(
        ingredient_id, {"events": [], "rolling_avg_actual_g": None, "rolling_avg_ratio": None})

    if actual_qty_g is None:
        actual_qty_g = planned_qty_g * AUTO_ESTIMATE_RATIO.get(outcome, 1.0)

    event = {
        "week": week,
        "planned_qty_g": planned_qty_g,
        "bought_qty_g": bought_qty_g,
        "household_size": household.active_count() or 1,
        "outcome": outcome,
        "actual_qty_g": actual_qty_g,
        "logged_at": time.time(),
    }
    entry["events"] = (entry["events"] + [event])[-EVENT_CAP:]

    ratio = (actual_qty_g / planned_qty_g) if planned_qty_g else 1.0
    entry["rolling_avg_ratio"] = _ema(entry["rolling_avg_ratio"], ratio)
    entry["rolling_avg_actual_g"] = _ema(entry["rolling_avg_actual_g"], actual_qty_g)

    _save(data)
    return entry


def log_meal(recipe_id: str, week: str, slot: str, outcome: str) -> dict:
    data = _load()
    entry = data["meals"].setdefault(recipe_id, {"events": []})
    entry["events"] = (entry["events"] + [{
        "week": week, "slot": slot, "outcome": outcome, "logged_at": time.time(),
    }])[-EVENT_CAP:]
    _save(data)
    return entry


def ingredient_entry(ingredient_id: str) -> Optional[dict]:
    return _load()["ingredients"].get(ingredient_id)


def meal_entry(recipe_id: str) -> Optional[dict]:
    return _load()["meals"].get(recipe_id)


def meal_skip_rate(recipe_id: str) -> Optional[dict]:
    entry = meal_entry(recipe_id)
    if not entry or not entry["events"]:
        return None
    skipped = sum(1 for e in entry["events"] if e["outcome"] == "skipped")
    return {"skipped": skipped, "total": len(entry["events"])}


def seeded_quantity(ingredient_id: str, recipe_derived_qty_g: float) -> float:
    """The recipe-derived amount, nudged by what actually tends to happen
    -- only once there's enough history (3 events) to call it a pattern
    rather than one unusual week."""
    entry = ingredient_entry(ingredient_id)
    if not entry or len(entry["events"]) < 3 or entry["rolling_avg_ratio"] is None:
        return recipe_derived_qty_g
    return recipe_derived_qty_g * entry["rolling_avg_ratio"]


def clear() -> None:
    _save({"ingredients": {}, "meals": {}})


def nudges() -> list[dict]:
    """Computed fresh every call, never stored -- nothing here can go
    stale. Fires when the last 3 logs for an ingredient all agree."""
    data = _load()
    ing_by_id = ingredients.by_id()
    out = []
    for ing_id, entry in data["ingredients"].items():
        events = entry["events"][-3:]
        if len(events) < 3:
            continue
        outcomes = {e["outcome"] for e in events}
        if len(outcomes) != 1:
            continue
        outcome = outcomes.pop()
        if outcome not in ("leftover", "ran_out"):
            continue

        ing = ing_by_id.get(ing_id)
        name = ing["name"] if ing else ing_id
        last = events[-1]
        qty_g = last.get("bought_qty_g") or last["planned_qty_g"]
        qty_label = ingredients.humanize_grams(ing, qty_g) if ing else f"{qty_g:.0f} g"
        people = last.get("household_size") or 1

        if outcome == "leftover":
            text = f"Last time you got {qty_label} of {name} for {people} people, you had some left over."
        else:
            text = f"Last time you got {qty_label} of {name} for {people} people, you ran out — you could use more."
        out.append({"ingredient_id": ing_id, "name": name, "outcome": outcome, "text": text})
    return out
