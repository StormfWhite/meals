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

import datetime
import re
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
    # one ingredient per name: a second "Yogurt" (two adds racing, the phone and the laptop)
    # would be offered twice everywhere
    same = next((i for i in data["ingredients"] if i["name"].strip().lower() == name.strip().lower()), None)
    if same is not None:
        return same
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
        "created": datetime.date.today().isoformat(),     # how long it's had to be used (suggest.py)
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
    kept = {u: g for u, g in (ing.get("unit_conversions") or {}).items() if u in ("block", ing.get("pack"))}
    for key in ("name", "fdc_id", "fdc_description", "default_unit", "unit_conversions",
                "category", "store_section", "manual_nutrients", "shop_list", "freezes", "keep_days", "storage",
                "nutrient_fill", "hide_suggest", "brand", "pack"):
        if key in fields and fields[key] is not None:
            ing[key] = fields[key].strip() if key == "name" else fields[key]
    # a block or can size said in the Pantry ("frozen in 1 lb blocks", "4 32 oz cans",
    # stock.text_to_g) outlives a USDA lookup that started before it and writes its own portions
    if kept and fields.get("unit_conversions") is not None:
        ing["unit_conversions"] = {**ing["unit_conversions"], **{u: g for u, g in kept.items()
                                                                 if u not in fields["unit_conversions"]}}
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


# words on a package that say nothing about what the food is
_FILLER = r"\b(organic|natural|pure|raw|unfiltered|fresh|sliced|diced|chopped|pieces?|chunks?|whole|premium|plain)\b"


# how it gets typed -> how USDA spells it
_SPELLINGS = {"dragonfruit": "dragon fruit", "bannanas?": "banana", "bananna": "banana", "makgo": "mango", "yoghurt": "yogurt",
              "strawberrys": "strawberries", "blueberrys": "blueberries", "tomatos": "tomatoes"}


_GENERIC = {"fruit", "fruits", "vegetable", "vegetables", "meat", "mix", "blend", "sauce", "seeds",
            "berries", "berry", "greens", "nuts"}


def _usda_queries(name: str) -> list[str]:
    """What to ask USDA for, most specific first: the name, the name without package words
    ("organic raw and unfiltered honey" -> "honey"), then without a leading word USDA has
    never heard of -- a brand ("fage yogurt" -> "yogurt"), never a food ("almond butter")."""
    from . import fdc
    name = name.strip().lower()
    for typed, usda in _SPELLINGS.items():
        name = re.sub(rf"\b{typed}\b", usda, name)
    out = [name]
    clean = re.sub(r"\s{2,}", " ", re.sub(r"\band\b", " ", re.sub(_FILLER, " ", name))).strip(" ,")
    if clean and clean not in out and clean not in _GENERIC:      # "fresh berries" is no particular berry
        out.append(clean)
    if clean.startswith("frozen ") and clean[7:]:
        out.append(clean[7:])
    words = (out[-1]).split()
    def known(word: str) -> bool:
        try:
            return bool(fdc.search(word))
        except Exception:
            return True                 # can't tell: keep the word
    if "," in name:
        return []                       # several foods: only as a mix (_resolve_blend)
    # one leading brand at most, and never down to a word that names no food in particular
    if len(words) > 1 and words[-1] not in _GENERIC and not known(words[0]):
        out.append(" ".join(words[1:]))
    return list(dict.fromkeys(out))


def _resolve_blend(ingredient_id: str, ing: dict) -> Optional[dict]:
    """A bag of mixed fruit ("strawberry, blueberry, and mango pieces"): equal parts of each,
    when every one of them is a USDA food -- otherwise nothing (no guessing)."""
    from . import fdc
    name = re.sub(_FILLER, " ", ing["name"].lower())
    name = re.sub(r"^\s*frozen\s+", "", name)
    for typed, usda in _SPELLINGS.items():
        name = re.sub(rf"\b{typed}\b", usda, name)
    parts = [p.strip() for p in re.split(r",|\band\b|&|/", name) if p.strip()]
    if len(parts) < 2:
        return None
    foods = []
    for part in parts:
        # the fruit itself -- "Strawberries, frozen", never "Strawberry drink syrup"
        names = {part, part + "s", part + "es", re.sub(r"y$", "ies", part)}
        hit = next((m for q in (part + " frozen", part + " raw", part)
                    for m in fdc.ranked_matches(q, limit=6)
                    if m["description"].lower().split(",")[0].strip() in names), None)
        food = hit and fdc.get_nutrients(hit["fdc_id"])
        if not food:
            return None
        foods.append(food)
    n = len(foods)
    blend = {k: round(sum(f.get(k, 0.0) for f in foods) / n, 2) for k in ("calories_kcal", "protein_g", "fiber_g")}
    vit = {}
    for f in foods:
        for k, v in (f.get("vitamins") or {}).items():
            vit[k] = vit.get(k, 0.0) + v / n
    blend["vitamins"] = {k: round(v, 2) for k, v in vit.items()}
    cups = [(_kitchen_portions(f).get("cup")) for f in foods]
    fields = {"manual_nutrients": blend, "fdc_description": "Equal parts: " + ", ".join(f["description"] for f in foods),
              "category": fdc.category_for(foods[0].get("food_category", "")) or ing.get("category")}
    if all(cups):
        fields["unit_conversions"] = {"cup": round(sum(cups) / n, 1), **(ing.get("unit_conversions") or {})}
    return update(ingredient_id, **fields)


def fill_portions(ingredient_id: str) -> Optional[dict]:
    """A matched ingredient whose USDA record has no kitchen measures, or leaves a nutrient out
    (Foundation "Chia seeds, dry, raw": no cup, no fiber): those from another record of the same
    food. The match itself stays as it is."""
    from . import fdc
    ing = get(ingredient_id)
    if not ing or not ing.get("fdc_id"):
        return ing
    missing = [k for k in (fdc.get_nutrients(ing["fdc_id"]) or {}).get("missing", [])
               if k not in (ing.get("nutrient_fill") or {})]
    need_portions = not ing.get("unit_conversions")
    if not missing and not need_portions:
        return ing
    head = ", ".join((ing.get("fdc_description") or "").split(",")[:2]).lower()
    want = head.split(",")[0].strip()
    fields: dict = {}
    # the closest record of the same food: fewest words the matched one doesn't have
    # ("Grapes, raw" for green seedless grapes -- never "Grapes, muscadine, raw")
    mine = set(re.split(r"[^a-z]+", (ing.get("fdc_description") or "").lower()))
    seen: dict = {}
    for query in dict.fromkeys([head.replace(",", ""), want] + _usda_queries(ing["name"])):
        for other in fdc.ranked_matches(query, limit=6):
            if other["fdc_id"] != ing["fdc_id"] and other["description"].lower().split(",")[0].strip() == want:
                seen.setdefault(other["fdc_id"], other)
    extra = lambda o: len(set(re.split(r"[^a-z]+", o["description"].lower())) - mine - {""})
    for other in sorted(seen.values(), key=lambda o: (extra(o), -o["score"])):
        food = fdc.get_nutrients(other["fdc_id"]) or {}
        portions = _kitchen_portions(food)
        if need_portions and portions and "unit_conversions" not in fields:
            fields["unit_conversions"] = portions
        value = lambda k: food.get(k) if k in food else (food.get("vitamins") or {}).get(k)
        got = {k: value(k) for k in missing if k not in food.get("missing", []) and value(k)}
        if got:
            fields["nutrient_fill"] = {**(ing.get("nutrient_fill") or {}), **fields.get("nutrient_fill", {}), **got}
            missing = [k for k in missing if k not in got]
        if not missing and (not need_portions or "unit_conversions" in fields):
            return update(ingredient_id, **fields)
    return update(ingredient_id, **fields) if fields else ing


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
    if (ing.get("fdc_id") or (ing.get("fdc_description") or "").startswith("Equal parts")) and not force:
        return ing
    match = None
    for query in _usda_queries(ing["name"]):
        match = fdc.best_match(query)
        if match is not None:
            break
    if match is None:
        return _with_brand(ingredient_id) or _resolve_blend(ingredient_id, ing)

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
        for other in fdc.ranked_matches(query, limit=3):
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
    filled = fill_portions(ingredient_id) or updated
    return _with_brand(ingredient_id) or filled


def _with_brand(ingredient_id: str) -> Optional[dict]:
    """A name that names a product ("Crisp apple olipop") gets that product's label (brands.py)."""
    from . import brands, fdc
    try:
        return brands.bind(ingredient_id)
    except fdc.NeedFetch:
        raise
    except Exception:
        return None


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
