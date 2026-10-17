"""Per-recipe and per-person nutrient rollup math.

Nutrition is never stored on a recipe -- it's computed here, on read, from
`ingredients.json` (+ the USDA cache once fdc.py exists in Phase 3), so
editing an ingredient's FDC match or unit conversion never leaves stale
numbers sitting in recipes.json.

In Phase 1 (no fdc.py yet) the only nutrient source is an ingredient's own
`manual_nutrients`, if the user bothered to type it in. `_fdc_nutrients`
is written now so Phase 3 only has to add mealplanner/fdc.py -- nothing
here needs to change.
"""
from __future__ import annotations

import datetime
from typing import Optional

from . import board, config, ingredients, recipes

NUTRIENT_KEYS = ("calories_kcal", "protein_g", "fiber_g")


def _fdc_nutrients(fdc_id: Optional[int]) -> Optional[dict]:
    if fdc_id is None:
        return None
    try:
        from . import fdc  # noqa: PLC0415 -- doesn't exist until Phase 3
    except ImportError:
        return None
    return fdc.get_nutrients(fdc_id)


def nutrients_per_100g(ingredient: dict) -> Optional[dict]:
    """USDA data wins when it's available; a manually-typed estimate is the
    fallback, not the other way around -- real data should never be shadowed
    by a guess someone typed in before the ingredient was bound to FDC."""
    return _fdc_nutrients(ingredient.get("fdc_id")) or ingredient.get("manual_nutrients")


COUNT_UNITS = ("medium", "piece", "egg", "fruit", "large", "small", "clove", "slice")


def qty_to_grams(ingredient: dict, qty: float, unit: str) -> Optional[float]:
    if unit == "g":
        return qty
    conversions = ingredient.get("unit_conversions") or {}
    grams_per_unit = conversions.get(unit)
    if grams_per_unit is None and unit == "each":
        # "2 eggs", "3 onions": a count weighs whatever USDA says one of them weighs
        grams_per_unit = next((conversions[u] for u in COUNT_UNITS if u in conversions), None)
    if grams_per_unit is None:
        return None
    return qty * grams_per_unit


def _add_into(totals: dict, per100: dict, factor: float) -> None:
    for k in NUTRIENT_KEYS:
        totals[k] = totals.get(k, 0.0) + per100.get(k, 0.0) * factor
    vitamins = totals.setdefault("vitamins", {})
    for k, v in (per100.get("vitamins") or {}).items():
        vitamins[k] = vitamins.get(k, 0.0) + v * factor


def recipe_totals(recipe: dict, ingredients_by_id: dict) -> dict:
    """Sum of every ingredient's nutrients, scaled by quantity.

    `unknown` lists ingredient_ids that couldn't be priced in nutritionally
    (no unit conversion to grams, or no nutrient data at all) -- the totals
    are still returned for whatever *could* be resolved rather than refusing
    the whole recipe over one unmapped ingredient.
    """
    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    unknown: list[str] = []

    for item in recipe.get("ingredients", []):
        ing = ingredients_by_id.get(item["ingredient_id"])
        if ing is None:
            unknown.append(item["ingredient_id"])
            continue
        grams = qty_to_grams(ing, item["qty"], item["unit"])
        per100 = nutrients_per_100g(ing)
        if grams is None or per100 is None:
            unknown.append(ing["id"])
            continue
        _add_into(totals, per100, grams / 100.0)

    servings = recipe.get("servings") or 1
    per_serving = {k: (totals[k] / servings) for k in NUTRIENT_KEYS}
    per_serving["vitamins"] = {k: v / servings for k, v in totals["vitamins"].items()}

    return {"total": totals, "per_serving": per_serving, "unknown_ingredients": unknown}


def preview_totals(rows: list[dict], ingredients_by_id: dict) -> dict:
    """Live nutrition for a *draft* ingredient list that hasn't been saved
    as a recipe yet -- same math as recipe_totals, reused rather than
    duplicated, just returning a per-row breakdown alongside the sum so the
    meal editor can show a stat next to each ingredient as it's typed."""
    per_row = []
    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    for item in rows:
        row_totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
        row_totals["vitamins"] = {}
        ing = ingredients_by_id.get(item["ingredient_id"])
        if ing is not None:
            grams = qty_to_grams(ing, item["qty"], item["unit"])
            per100 = nutrients_per_100g(ing)
            if grams is not None and per100 is not None:
                _add_into(row_totals, per100, grams / 100.0)
                _add_into(totals, per100, grams / 100.0)
        per_row.append({"ingredient_id": item["ingredient_id"], **row_totals})
    return {"rows": per_row, "total": totals}


def preview_batch(blocks: dict[str, list[dict]], ingredients_by_id: dict) -> dict:
    """`preview_totals` for many draft lists at once, keyed however the
    caller likes. The week view has 21 meal blocks on screen at once, and
    one request that reads `ingredients.json` once beats 21 that each read
    it again -- the math itself is untouched."""
    return {key: preview_totals(rows, ingredients_by_id) for key, rows in blocks.items()}


def totals_for_slot(recipe: dict, slot: dict, ingredients_by_id: dict) -> dict:
    """A board slot's ingredient_overrides (Recipe picker's per-instance
    tweaks -- see recipes.py/board.py) stand in for the base recipe's
    ingredient list when present, without ever touching the saved recipe."""
    overrides = slot.get("ingredient_overrides")
    effective = {**recipe, "ingredients": overrides} if overrides else recipe
    return recipe_totals(effective, ingredients_by_id)


# ── day / week rollups ──────────────────────────────────────────────────
#
# There's no per-member assignment of who ate what -- the board is one
# shared plan for the household. So "a person's nutrition that day" means
# one serving of whatever's on the board for each scheduled slot, the same
# food every active member is assumed to share. `servings_used` on a slot
# is about batch/leftover accounting (how much of a big-batch recipe this
# cook event used), not about splitting nutrition between people, so it's
# deliberately not a multiplier here.

def day_totals(date_iso: str) -> dict:
    reup_day = config.load()["reup_day"]
    week_start = board.week_start_for(datetime.date.fromisoformat(date_iso), reup_day).isoformat()
    week = board.get_week(week_start)
    ing_by_id = ingredients.by_id()

    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    # Every slot on this date, not the three fixed keys -- a breakfast can
    # hold a smoothie *and* fried eggs, and both were eaten.
    for key, slot in week["slots"].items():
        slot_date, meal, _ = board.parse_slot_key(key)
        if slot_date != date_iso or meal not in board.MEALS:
            continue
        recipe = recipes.get(slot["recipe_id"])
        if not recipe:
            continue
        per_serving = totals_for_slot(recipe, slot, ing_by_id)["per_serving"]
        _add_into(totals, per_serving, 1.0)
    return totals


def week_totals(week_start_iso: str) -> dict:
    week = board.get_week(week_start_iso)
    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    per_day = {}
    for date in week["dates"]:
        day = day_totals(date)
        per_day[date] = day
        _add_into(totals, day, 1.0)
    return {"week_start": week_start_iso, "total": totals, "per_day": per_day}


def status_for(actual: float, target: float) -> str:
    """under (neutral) / on (good) / over (warn, amber) / way_over (bad,
    reserved for something well past the target, not just "a bit high")."""
    if not target:
        return "on"
    ratio = actual / target
    if ratio < 0.85:
        return "under"
    if ratio <= 1.15:
        return "on"
    if ratio <= 1.5:
        return "over"
    return "way_over"


def status_report(totals: dict, targets: dict) -> dict:
    report = {k: status_for(totals.get(k, 0.0), targets.get(k, 0.0)) for k in NUTRIENT_KEYS}
    report["vitamins"] = {
        k: status_for(totals.get("vitamins", {}).get(k, 0.0), v)
        for k, v in (targets.get("vitamins") or {}).items()
    }
    return report
