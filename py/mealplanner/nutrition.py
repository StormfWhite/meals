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
import re
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
    by a guess someone typed in before the ingredient was bound to FDC.
    Something made in bulk is what went into its pot (bulk.py), never a lookup."""
    if ingredient.get("made"):
        from . import bulk
        return bulk.per100(ingredient)
    food = _fdc_nutrients(ingredient.get("fdc_id"))
    if food and ingredient.get("nutrient_fill"):
        # a gap in the record (Foundation chia lists no fiber, Foundation yogurt no B12) taken
        # from another record of it; vitamins and minerals sit under "vitamins"
        fill = {k: v for k, v in ingredient["nutrient_fill"].items() if k in food.get("missing", [])}
        vit = {k: v for k, v in fill.items() if k not in NUTRIENT_KEYS}
        food = {**food, **{k: v for k, v in fill.items() if k in NUTRIENT_KEYS},
                "vitamins": {**(food.get("vitamins") or {}), **vit}}
    if ingredient.get("brand"):
        # a name-brand product: its own label, the generic match only filling what that leaves out
        from . import brands
        return brands.per100(ingredient, food)
    return food or ingredient.get("manual_nutrients")


# what ONE of the thing weighs, best first: "each"/"whole" (USDA's "1 banana", "whole onion"),
# then a medium one. A slice is never a whole banana or onion -- only bread counts by the slice.
COUNT_UNITS = ("each", "medium", "whole", "fruit", "piece", "egg", "large", "small", "clove")
SLICE_COUNTED = re.compile(r"\b(bread|toast|loaf|sourdough|rye|cheese)\b", re.I)
SIZE_WORDS = ("medium", "large", "small", "whole", "extra large")


# the same unit, written out -- a line says "teaspoon", USDA's table says "tsp"
UNIT_ALIASES = {"teaspoon": "tsp", "teaspoons": "tsp", "tablespoon": "tbsp", "tablespoons": "tbsp",
                "tbs": "tbsp", "tbl": "tbsp", "tbsps": "tbsp", "tsps": "tsp", "cups": "cup", "c": "cup",
                "t": "tsp", "ounce": "oz", "ounces": "oz", "pound": "lb", "pounds": "lb", "lbs": "lb",
                "gram": "g", "grams": "g", "gr": "g", "kilogram": "kg", "kilograms": "kg", "kgs": "kg",
                "blocks": "block", "fluid ounce": "fl oz", "fluid ounces": "fl oz", "floz": "fl oz",
                "milliliter": "ml", "milliliters": "ml", "millilitre": "ml", "mls": "ml", "liter": "l",
                "liters": "l", "litre": "l", "litres": "l", "pints": "pint", "pt": "pint", "quarts": "quart",
                "qt": "quart", "qts": "quart", "gallons": "gallon", "gal": "gallon",
                "cans": "can", "jars": "jar", "bags": "bag", "boxes": "box", "bottles": "bottle",
                "cartons": "carton", "packages": "package", "pkg": "package", "packs": "package",
                "pack": "package", "tubs": "tub", "tins": "tin", "pouches": "pouch", "containers": "container",
                "pieces": "piece", "pc": "piece", "pcs": "piece", "whole": "whole", "ea": "each"}
WEIGHTS_G = {"oz": 28.3495, "lb": 453.592, "kg": 1000.0}
# every kitchen volume in teaspoons, so one known volume ("1 cup" = 225 g) weighs all the others
TSP_PER = {"tsp": 1, "tbsp": 3, "cup": 48, "fl oz": 6, "pint": 96, "quart": 192, "gallon": 768,
           "ml": 0.202884, "l": 202.884}

_FRACTIONS = {"½": .5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": .25, "¾": .75, "⅛": .125, "⅜": .375, "⅝": .625, "⅞": .875}
_WORD_NUMS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
              "eight": 8, "nine": 9, "ten": 10, "a couple": 2, "couple": 2, "a few": 3, "few": 3,
              "half": .5, "half a": .5, "half an": .5, "a half": .5, "quarter": .25, "a quarter": .25,
              "dozen": 12, "a dozen": 12, "half a dozen": 6, "half dozen": 6}


def parse_amount(text: str) -> Optional[tuple[float, str]]:
    """How an amount gets written -> (qty, unit). "1/2 cup", "1 1/2 cups", "½ cup", "1½ tbsp",
    "half a cup", "a dozen", "2 dozen eggs", "2 cups of spinach", "2-3 carrots" (the middle),
    "3" (unit ""), "1 banana" (unit "banana" -- qty_to_grams knows it's a count of the food).
    None when there's no amount in it."""
    t = re.sub(r"\s+", " ", str(text or "").strip().lower())
    for ch, v in _FRACTIONS.items():                       # "1½" -> "1 .5", "½" -> ".5"
        t = t.replace(ch, f" {v} ")
    t = re.sub(r"\s+", " ", t).strip()
    qty = None
    m = re.match(r"^(\d+(?:\.\d+)?|\.\d+)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\b\s*(.*)$", t)    # "2-3", "2 to 3"
    if m:
        qty, rest = (float(m.group(1)) + float(m.group(2))) / 2, m.group(3)
    else:
        for rx, value in (
                (r"^(\d+)\s+(\d+)\s*/\s*(\d+)\b", lambda g: float(g[0]) + float(g[1]) / float(g[2])),   # 1 1/2
                (r"^(\d+)\s*/\s*(\d+)\b", lambda g: float(g[0]) / float(g[1])),                          # 1/2
                (r"^(\d+(?:\.\d+)?)\s+(0?\.\d+)(?!\d)", lambda g: float(g[0]) + float(g[1])),            # 1½
                (r"^(\d+(?:\.\d+)?|\.\d+)", lambda g: float(g[0]))):
            m = re.match(rx, t)
            if m:
                try:
                    qty, rest = value(m.groups()), t[m.end():]
                except ZeroDivisionError:
                    return None
                break
    if qty is None:
        for words in sorted(_WORD_NUMS, key=len, reverse=True):
            if t == words or t.startswith(words + " "):
                qty, rest = float(_WORD_NUMS[words]), t[len(words):]
                break
        else:
            return None
    rest = rest.strip()
    # "2 dozen eggs", "1 and a half cups"
    m = re.match(r"^(?:and )?(a half|half)\b\s*(.*)$", rest)
    if m:
        qty, rest = qty + .5, m.group(2)
    m = re.match(r"^dozen\b\s*(.*)$", rest)
    if m:
        qty, rest = qty * 12, m.group(1)
    rest = re.sub(r"^(?:x|×|\*)\s*", "", rest)
    rest = re.sub(r"^(?:a|an)\s+", "", rest)                # "half a cup"
    unit = re.split(r"\s+of\b|,|\(", rest)[0].strip(" .")   # "2 cups of spinach", "1 cup (chopped)"
    if unit.startswith("fl ") or unit.startswith("fluid "):
        unit = "fl oz"
    elif unit:
        two = " ".join(unit.split()[:2])
        unit = two if two in UNIT_ALIASES or two in SIZE_WORDS else unit.split()[0]
    return (qty, unit) if qty > 0 else None


def _stem(w: str) -> str:
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("oes") and len(w) > 4:
        return w[:-2]
    if w.endswith("es") and len(w) > 4 and w[-3] in "sxz":
        return w[:-2]
    return w[:-1] if w.endswith("s") and not w.endswith("ss") and len(w) > 3 else w


def _names_the_food(ingredient: dict, unit: str) -> bool:
    """ "1 banana" for Banana, "3 eggs" for Eggs, "2 carrots" for Baby carrots: the unit is the
    food itself, so it's a count."""
    words = {_stem(w) for w in re.split(r"[^a-z]+", (ingredient.get("name") or "").lower()) if len(w) > 2}
    return bool(unit) and _stem(unit) in words


def count_grams(ingredient: dict) -> Optional[float]:
    """What one of it weighs -- None when nothing says (spinach has no "one")."""
    conversions = {UNIT_ALIASES.get(u, u): g for u, g in (ingredient.get("unit_conversions") or {}).items()}
    got = next((conversions[u] for u in COUNT_UNITS if u in conversions), None)
    if got is None and "slice" in conversions and SLICE_COUNTED.search(ingredient.get("name") or ""):
        got = conversions["slice"]
    return got


def qty_to_grams(ingredient: dict, qty: float, unit: str) -> Optional[float]:
    unit = (unit or "").strip().lower()
    unit = UNIT_ALIASES.get(unit, unit)
    if unit == "g":
        return qty
    if unit in WEIGHTS_G:
        return qty * WEIGHTS_G[unit]
    conversions = {UNIT_ALIASES.get(u, u): g for u, g in (ingredient.get("unit_conversions") or {}).items()}
    grams_per_unit = conversions.get(unit)
    if grams_per_unit is None and unit.endswith("s"):
        # "3 cloves", "2 slices", "2 bunches": the table says it in the singular
        grams_per_unit = conversions.get(unit[:-1]) or (conversions.get(unit[:-2]) if unit.endswith("es") else None)
        if grams_per_unit is None and UNIT_ALIASES.get(unit[:-1]) in conversions:
            grams_per_unit = conversions[UNIT_ALIASES[unit[:-1]]]
    if grams_per_unit is None and unit in TSP_PER:
        # only "1 tbsp" is known: a teaspoon is a third of it, a cup sixteen of them
        known = next(((u, g) for u, g in conversions.items() if u in TSP_PER), None)
        if known:
            grams_per_unit = known[1] / TSP_PER[known[0]] * TSP_PER[unit]
    if grams_per_unit is None and (unit in ("", "each", "whole") or unit in SIZE_WORDS
                                   or _names_the_food(ingredient, unit)):
        # "2 eggs", "3 onions", "1 banana", "2 medium": a count weighs what one of them weighs
        grams_per_unit = count_grams(ingredient)
        if grams_per_unit is not None and unit in ("large", "small", "extra large") and "medium" in conversions \
                and grams_per_unit == conversions.get("medium"):
            grams_per_unit *= {"large": 1.25, "small": 0.75, "extra large": 1.45}[unit]   # only a medium is known
    if grams_per_unit is None:
        return None
    return qty * grams_per_unit


def text_to_grams(ingredient: dict, text: str) -> Optional[float]:
    """Any amount as written ("1 banana", "1/2 cup", "a dozen", "8 oz") -> grams, or None."""
    got = parse_amount(text)
    return qty_to_grams(ingredient, got[0], got[1]) if got else None


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
# The board is one shared plan: a meal's lines are the whole pot, eaten by
# the household in shares (household.portion) unless its slot names its
# `eaters` (one person's extra meal). `servings_used` on a slot says how
# many times its lines go into the pot (board.pot_factor): 1 = the lines are
# the whole pot, 2 = they're one person's portion, made twice (Storm
# 2026-10-25). A batch cook's lines are the whole batch already, and a meal
# eaten FROM a batch uses servings for how many it takes -- both count once.

def day_totals(date_iso: str, member: Optional[dict] = None) -> dict:
    """The day's meals added up: whole pots, or with `member` what that member eats of them
    (household.portion: their share, or nothing of a meal that's someone else's)."""
    from . import household
    reup_day = config.load()["reup_day"]
    week_start = board.week_start_for(datetime.date.fromisoformat(date_iso), reup_day).isoformat()
    week = board.get_week(week_start)
    ing_by_id = ingredients.by_id()

    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    from . import batches
    served = batches.shelf().served_in(week_start)
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
        # per_serving is already per recipe serving: times the meal's servings (2 = one person's
        # lines, made twice). A batch cook's lines are its whole batch; a meal from a batch counts once.
        pot = 1.0 if key in served or (slot.get("store") or {}).get("n") else board.servings(slot)
        _add_into(totals, per_serving, pot * (household.portion(member, slot.get("eaters")) if member else 1.0))
    return totals


def week_totals(week_start_iso: str, member: Optional[dict] = None) -> dict:
    week = board.get_week(week_start_iso)
    totals: dict = {k: 0.0 for k in NUTRIENT_KEYS}
    totals["vitamins"] = {}
    per_day = {}
    for date in week["dates"]:
        day = day_totals(date, member)
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
