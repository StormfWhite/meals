"""The local ingredient catalog -- "ingredients as used in my recipes".

Distinct from the raw USDA cache (Phase 3's fdc_cache.sqlite): an entry
here points at one chosen fdc_id, but the actual nutrient payload lives in
the cache so re-resolving isn't needed on every recipe read. Until an
ingredient is bound to FDC, `manual_nutrients` (per 100g) is the only
nutrition source for it -- entirely optional, since a recipe with unknown
ingredients still saves fine, it just can't be summed into a nutrition
total yet.
"""
from __future__ import annotations

import uuid
from typing import Optional

from . import aisles, store
from .paths import INGREDIENTS_FILE

CATEGORIES = ("vegetable", "protein", "grain", "dairy", "fruit", "other")

# Units USDA reports portions in that are worth keeping as conversions --
# the rest of its portion table ("1 package (10 oz)") is packaging, not a
# way anyone writes an amount on a meal line.
KITCHEN_UNITS = {
    "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon",
    "teaspoons", "oz", "ounce", "ounces", "lb", "pound", "pounds", "clove",
    "cloves", "slice", "slices", "piece", "pieces", "medium", "large",
    "small", "head", "stalk", "sprig", "leaf", "bunch", "fillet", "breast",
    "thigh", "egg", "ear", "fruit", "berry", "wedge", "half", "quart", "pint",
}


def _load() -> dict:
    return store.load(INGREDIENTS_FILE, {"ingredients": []})


def _save(data: dict) -> None:
    store.save(INGREDIENTS_FILE, data)


def _decorate(ingredient: dict) -> dict:
    """Fill in what an entry written by an older version doesn't have.

    Read-time only, deliberately: a catalog saved before shopping lists
    existed shouldn't have to be migrated on disk to be usable, and
    deriving here means one rule (aisles.list_for) decides for both old
    and new entries."""
    return {**ingredient, "shop_list": aisles.list_for(ingredient)}


def list_ingredients(q: Optional[str] = None) -> list[dict]:
    items = _load()["ingredients"]
    if q:
        q = q.strip().lower()
        items = [i for i in items if q in i["name"].lower()]
    return [_decorate(i) for i in sorted(items, key=lambda i: i["name"].lower())]


def by_id() -> dict[str, dict]:
    return {i["id"]: _decorate(i) for i in _load()["ingredients"]}


def get(ingredient_id: str) -> Optional[dict]:
    return by_id().get(ingredient_id)


def add(name: str, category: str = "other", default_unit: str = "g",
        unit_conversions: Optional[dict] = None, store_section: Optional[str] = None,
        manual_nutrients: Optional[dict] = None, fdc_id: Optional[int] = None,
        shop_list: Optional[str] = None) -> dict:
    data = _load()
    ingredient = {
        "id": "i_" + uuid.uuid4().hex[:8],
        "name": name.strip(),
        "fdc_id": fdc_id,
        "fdc_description": None,
        "default_unit": default_unit or "g",
        "unit_conversions": unit_conversions or {},
        "category": category if category in CATEGORIES else "other",
        "store_section": store_section,
        "manual_nutrients": manual_nutrients,
        "shop_list": shop_list if shop_list in (aisles.GROCERY, aisles.MARKET) else None,
        "shop_list_locked": bool(shop_list),
    }
    data["ingredients"].append(ingredient)
    _save(data)
    # Note: binding to USDA is deliberately NOT done here. This function is
    # the data layer -- reached by every test and every bulk path -- and a
    # network call hidden inside it would make creating an ingredient
    # unpredictably slow and the test suite dependent on api.nal.usda.gov.
    # server.py resolves right after creating, which is the one funnel
    # everything the user types comes through.
    if not ingredient.get("shop_list"):
        ingredient = update(ingredient["id"], shop_list=aisles.list_for(ingredient),
                            lock_shop_list=False)
    return ingredient


def update(ingredient_id: str, **fields) -> dict:
    data = _load()
    ing = next((i for i in data["ingredients"] if i["id"] == ingredient_id), None)
    if ing is None:
        raise KeyError(ingredient_id)
    for key in ("name", "fdc_id", "fdc_description", "default_unit", "unit_conversions",
                "category", "store_section", "manual_nutrients", "shop_list", "freezes", "keep_days", "storage"):
        if key in fields and fields[key] is not None:
            ing[key] = fields[key].strip() if key == "name" else fields[key]
    # Moving something between the two lists by hand is a decision, not a
    # guess -- once made it must survive every later re-derivation.
    if fields.get("shop_list") and fields.get("lock_shop_list", True):
        ing["shop_list_locked"] = True
    _save(data)
    return ing


def _kitchen_portions(nutrients: dict) -> dict:
    """USDA's portion table, filtered to units anyone would actually write
    on a meal line -- "1 clove" survives, "1 package (15 oz)" doesn't."""
    return {u: g for u, g in (nutrients.get("portions") or {}).items() if u in KITCHEN_UNITS}


def resolve_usda(ingredient_id: str, force: bool = False) -> Optional[dict]:
    """Bind an ingredient to the USDA food it most likely means, and take
    that food's category and portion table with it.

    Returns the updated ingredient, or None if nothing confident enough was
    found (in which case the ingredient is left exactly as it was -- an
    unbound ingredient still plans and shops fine, it just can't be counted
    into a nutrition total).
    """
    from . import fdc  # local: fdc pulls in requests, this module is imported everywhere

    ing = get(ingredient_id)
    if ing is None:
        raise KeyError(ingredient_id)
    if ing.get("fdc_id") and not force:
        return ing
    match = fdc.best_match(ing["name"])
    if match is None:
        return None

    fields: dict = {"fdc_id": match["fdc_id"], "fdc_description": match["description"]}
    category = fdc.category_for(match.get("food_category", ""))
    if category != "other":
        fields["category"] = category

    nutrients = fdc.get_nutrients(match["fdc_id"]) or {}
    portions = _kitchen_portions(nutrients)
    if not portions:
        # The best-nutrition record often has no kitchen measures at all:
        # USDA's Foundation "Garlic, raw" lists only a reference amount,
        # while the SR Legacy entry for the same food is the one that knows
        # a clove is 3g (measured). So nutrition comes from the best match
        # and the portions come from whichever record for the same name
        # actually has them.
        for other in fdc.ranked_matches(ing["name"], limit=3):
            if other["fdc_id"] == match["fdc_id"]:
                continue
            portions = _kitchen_portions(fdc.get_nutrients(other["fdc_id"]) or {})
            if portions:
                break
    if portions:
        # Never clobber a conversion the user set by hand for this unit.
        fields["unit_conversions"] = {**portions, **(ing.get("unit_conversions") or {})}

    updated = update(ingredient_id, **fields)
    if not updated.get("shop_list_locked"):
        updated = update(ingredient_id, shop_list=aisles.classify(updated["name"], updated["category"]),
                         lock_shop_list=False)
    return updated


def humanize_grams(ingredient: dict, grams: float) -> str:
    """A gram amount in whatever kitchen unit the ingredient is normally
    bought in, since "920g eggplant" reads worse than "2 medium"."""
    unit = ingredient.get("default_unit", "g")
    per_unit = (ingredient.get("unit_conversions") or {}).get(unit)
    if unit == "g" or not per_unit:
        return f"{grams:.0f} g"
    count = round((grams / per_unit) * 2) / 2  # nearest half unit
    return f"{count:g} {unit}"


def delete(ingredient_id: str) -> bool:
    data = _load()
    before = len(data["ingredients"])
    data["ingredients"] = [i for i in data["ingredients"] if i["id"] != ingredient_id]
    _save(data)
    return len(data["ingredients"]) < before
