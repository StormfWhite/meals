"""Board-history-driven stats: how often a meal gets eaten, and whether an
ingredient has been creeping up or down across its instances.

Deliberately separate from learning.py -- that module tracks purchase
*outcomes* (ran out / had leftovers), a signal only produced when the user
logs a grocery result. This module only reads what's already in board.json
(every slot the board has ever held), so it has something to say about a
recipe from the moment it's been scheduled a few times, with zero extra
logging. Same philosophy as learning.py though: plain arithmetic, no ML,
and it needs a real pattern across several instances, not one weird week.
"""
from __future__ import annotations

from . import board, ingredients, nutrition, recipes

MIN_TREND_INSTANCES = 4
TREND_THRESHOLD = 0.2  # a swing smaller than this isn't a "trend", it's noise


def meal_frequency(recipe_id: str) -> dict:
    history = [s for s in board.all_slots_history() if s["recipe_id"] == recipe_id]
    if not history:
        return {"count": 0, "last_date": None, "meals": {}}
    meals: dict[str, int] = {}
    for s in history:
        meals[s["meal"]] = meals.get(s["meal"], 0) + 1
    return {"count": len(history), "last_date": max(s["date"] for s in history), "meals": meals}


def ingredient_trend(recipe_id: str, min_instances: int = MIN_TREND_INSTANCES,
                     threshold: float = TREND_THRESHOLD) -> list[dict]:
    """For each ingredient that's shown up in >=min_instances historical
    instances of this recipe (using each instance's effective list --
    ingredient_overrides or the base recipe, same precedence
    nutrition.totals_for_slot uses), compare the mean quantity of the
    earlier half of instances vs the recent half. A swing past `threshold`
    gets reported; anything smaller is left out as not a real pattern."""
    recipe = recipes.get(recipe_id)
    if recipe is None:
        return []
    history = sorted((s for s in board.all_slots_history() if s["recipe_id"] == recipe_id),
                     key=lambda s: s["date"])
    if len(history) < min_instances:
        return []

    ing_by_id = ingredients.by_id()
    per_ing: dict[str, list[float]] = {}
    for slot in history:
        ing_list = slot.get("ingredient_overrides") or recipe["ingredients"]
        seen_this_instance: set[str] = set()
        for item in ing_list:
            if item["ingredient_id"] in seen_this_instance:
                continue
            ing = ing_by_id.get(item["ingredient_id"])
            if ing is None:
                continue
            grams = nutrition.qty_to_grams(ing, item["qty"], item["unit"])
            if grams is None:
                continue
            seen_this_instance.add(item["ingredient_id"])
            per_ing.setdefault(item["ingredient_id"], []).append(grams)

    out = []
    for ing_id, series in per_ing.items():
        if len(series) < min_instances:
            continue
        mid = len(series) // 2
        earlier, recent = series[:mid], series[mid:]
        earlier_avg, recent_avg = sum(earlier) / len(earlier), sum(recent) / len(recent)
        if earlier_avg == 0:
            continue
        pct_change = (recent_avg - earlier_avg) / earlier_avg
        if abs(pct_change) < threshold:
            continue
        ing = ing_by_id.get(ing_id)
        out.append({
            "ingredient_id": ing_id,
            "name": ing["name"] if ing else ing_id,
            "direction": "up" if pct_change > 0 else "down",
            "pct_change": round(pct_change * 100, 1),
            "earlier_avg_g": round(earlier_avg, 1),
            "recent_avg_g": round(recent_avg, 1),
        })
    return sorted(out, key=lambda r: abs(r["pct_change"]), reverse=True)
