"""Name-brand and specialty foods: nutrition from the product's own label.

Storm 2026-10-23: "it should look up the nutrition of certain specific things that aren't on USDA
or to find it better if it is like Olipop", "name brand specialty stuff". USDA's generic records
guess badly at a product ("Crisp apple olipop" had matched "Crisp, apple" -- the dessert, 215 kcal
per 100 g, for a 35-kcal soda). So when an ingredient's name carries a brand, the product itself
is looked up: USDA's Branded Foods first (the label, per 100 g), then Open Food Facts (anything
sold anywhere, crowd-sourced from labels).

A product counts only when its brand's words are all in the name ("olipop", "fage", "trader
joe's") and the rest of the name fits its description (the flavour: "crisp apple"). Nothing is
guessed beyond that: no brand in the name, no brand lookup.

The label is stored on the ingredient (`brand`), so reading it never asks anyone again. A label
lists few vitamins; when the generic USDA match is the same kind of food (Fage -> yogurt) it stays
bound and fills in the rest, otherwise it's dropped (Olipop -> not apple crisp).
"""
from __future__ import annotations

import re
from typing import Optional

from . import fdc

OFF_SEARCH = "https://world.openfoodfacts.org/cgi/search.pl"
MIN_FIT = 0.5          # at least half the non-brand words of the name in the product's description
_DESCRIPTIVE = {"raw", "natural", "pure", "fresh", "unfiltered", "whole", "frozen", "plain", "sweet",
                "simple", "farm", "farms", "garden", "gardens", "valley", "kitchen", "harvest", "golden",
                "best", "good", "great", "value", "select", "premium", "choice", "family", "market"}
_STOP = {"the", "and", "with", "of", "a", "an", "in", "organic", "original", "classic", "brand"}
_UNITS_G = {"g": 1.0, "mg": 1e-3, "µg": 1e-6, "mcg": 1e-6, "ug": 1e-6}

# Open Food Facts keys -> ours, and the factor from OFF's grams (per 100 g) to our unit
OFF_KEYS = {
    "proteins_100g": ("protein_g", 1), "fiber_100g": ("fiber_g", 1),
    "potassium_100g": ("potassium_mg", 1e3), "magnesium_100g": ("magnesium_mg", 1e3),
    "calcium_100g": ("calcium_mg", 1e3), "iron_100g": ("iron_mg", 1e3), "zinc_100g": ("zinc_mg", 1e3),
    "vitamin-c_100g": ("vitamin_c_mg", 1e3), "vitamin-a_100g": ("vitamin_a_mcg", 1e6),
    "vitamin-d_100g": ("vitamin_d_mcg", 1e6), "vitamin-b12_100g": ("b12_mcg", 1e6),
    "vitamin-b9_100g": ("folate_mcg", 1e6), "folates_100g": ("folate_mcg", 1e6),
}
TOP = ("calories_kcal", "protein_g", "fiber_g")


def _words(text: str) -> list[str]:
    text = (text or "").lower().replace("’", "'").replace("'s", "s").replace("'", "")
    return [w for w in re.split(r"[^a-z0-9]+", text) if w and w not in _STOP]


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 3 and w.endswith("s") else w


def _fit(name: str, brand: str, description: str) -> Optional[float]:
    """None when the brand isn't in the name; else how much of the rest of the name the product's
    description covers (1.0 = all of it, or nothing left to cover)."""
    name_w = [_stem(w) for w in _words(name)]
    brand_w = [_stem(w) for w in _words(brand)]
    joined = "".join(name_w)
    if not brand_w or not (set(brand_w) <= set(name_w) or "".join(brand_w) in joined):
        return None
    rest = [w for w in name_w if w not in brand_w and w not in "".join(brand_w)]
    if not rest:
        return 1.0
    desc = {_stem(w) for w in _words(description)}
    return sum(w in desc for w in rest) / len(rest)


def _usda(name: str) -> Optional[dict]:
    best = None
    for hit in fdc.search_branded(name):
        for brand in {hit["brand"], hit["owner"]} - {""}:
            fit = _fit(name, brand, hit["description"])
            if fit is not None and fit >= MIN_FIT:
                key = (fit, -len(hit["description"]))
                if best is None or key > best[0]:
                    best = (key, hit, brand)
    if not best:
        return None
    _, hit, brand = best
    food = fdc.get_nutrients(hit["fdc_id"]) or {}
    if not food.get("calories_kcal") and not food.get("protein_g"):
        return None
    return {"source": "usda", "id": hit["fdc_id"], "brand": brand.title() if brand.isupper() else brand,
            "description": hit["description"].title() if hit["description"].isupper() else hit["description"],
            "food_category": hit["food_category"],
            "per100": {**{k: food.get(k, 0.0) for k in TOP}, "vitamins": dict(food.get("vitamins") or {})},
            "listed": [k for k in TOP if k not in food.get("missing", [])]
                      + [k for k in (food.get("vitamins") or {}) if k not in food.get("missing", [])],
            "portions": food.get("portions") or {}}


def _off_per100(n: dict) -> tuple[dict, list]:
    kcal = n.get("energy-kcal_100g")
    if kcal is None and n.get("energy_100g") is not None:       # kJ
        kcal = float(n["energy_100g"]) / 4.184
    out: dict = {"calories_kcal": float(kcal or 0.0), "protein_g": 0.0, "fiber_g": 0.0, "vitamins": {}}
    listed = ["calories_kcal"] if kcal is not None else []
    for k, (ours, f) in OFF_KEYS.items():
        if n.get(k) is None:
            continue
        v = float(n[k]) * f
        if ours in TOP:
            out[ours] = v
        else:
            out["vitamins"][ours] = v
        listed.append(ours)
    return out, listed


def _off(name: str) -> Optional[dict]:
    data = fdc.get_json(OFF_SEARCH, {"search_terms": name, "search_simple": 1, "action": "process",
                                     "json": 1, "page_size": 20,
                                     "fields": "code,product_name,brands,nutriments,serving_quantity,categories"},
                        headers={"User-Agent": "MealPlanner/1.0 (personal use)"})   # OFF asks apps to say who they are
    best = None
    for p in data.get("products", []):
        n = p.get("nutriments") or {}
        if n.get("energy-kcal_100g") is None and n.get("energy_100g") is None:
            continue
        for brand in [b.strip() for b in (p.get("brands") or "").split(",") if b.strip()][:2]:
            fit = _fit(name, brand, p.get("product_name") or "")
            if fit is not None and fit >= MIN_FIT:
                key = (fit, len(n))                        # the fullest label wins a tie
                if best is None or key > best[0]:
                    best = (key, p, brand)
    if not best:
        return None
    _, p, brand = best
    per100, listed = _off_per100(p["nutriments"])
    portions = {}
    if p.get("serving_quantity"):
        try:
            portions["serving"] = round(float(p["serving_quantity"]), 2)
        except (TypeError, ValueError):
            pass
    return {"source": "off", "id": p.get("code"), "brand": brand, "description": p.get("product_name") or "",
            "food_category": (p.get("categories") or "").split(",")[0].strip(),
            "per100": per100, "listed": listed, "portions": portions}


def _food_words(name: str) -> set:
    """Words USDA's generic foods use for this name: a "brand" made only of these ("Beans",
    "Organic Valley Spinach") is a food word, not a brand."""
    try:
        hits = fdc.search(name)[:6]
    except fdc.NeedFetch:
        raise
    except Exception:
        hits = []
    # and the words a package uses to describe any food ("Honey In The Raw" is honey, raw)
    return {_stem(w) for h in hits for w in _words(h["description"])} | _DESCRIPTIVE


def find(name: str, hint: Optional[str] = None, generic: str = "") -> Optional[dict]:
    """The product a branded name means, with its label per 100 g -- or None (no brand in the name,
    or nothing that fits). USDA's Branded Foods first, Open Food Facts after. `hint` is the exact
    product bought (the store's name for it, prices.py): looked up first, kept only if its brand
    is the one in `name`."""
    food = None
    for query in [q for q in (hint, name) if q]:
        for look in (_usda, _off):
            try:
                hit = look(query)
            except fdc.NeedFetch:
                raise
            except Exception:
                hit = None
            if not hit or _fit(name, hit["brand"], hit["description"] + " " + query) is None:
                continue
            if food is None:      # + the generic match's own words ("Honey" for raw unfiltered honey)
                food = _food_words(name) | {_stem(w) for w in _words(generic)}
            if {_stem(w) for w in _words(hit["brand"])} <= food:
                continue
            return hit
    return None


def store_label(ingredient_id: str) -> Optional[str]:
    """The product the store matched for this ingredient, newest first ("Fage Total Plain 2% ...")."""
    from . import prices
    rows = [r[ingredient_id] for r in prices._load().get("prices", {}).values() if ingredient_id in r]
    rows.sort(key=lambda r: -(r.get("updated_at") or 0))
    for r in rows:
        if r.get("label"):
            return re.sub(r"\s*·.*$", "", r["label"]).replace("®", "").replace("™", "").strip()
    return None


def bind(ingredient_id: str) -> Optional[dict]:
    """Look the ingredient up as a product, if its name names one; store the label on it.
    Returns the updated ingredient, or None when it isn't a branded name."""
    from . import ingredients
    ing = ingredients.get(ingredient_id)
    if ing is None:
        return None
    hit = find(ing["name"], store_label(ingredient_id), ing.get("fdc_description") or "")
    if hit is None:
        return None
    fields: dict = {"brand": {k: hit[k] for k in ("source", "id", "brand", "description", "food_category",
                                                   "per100", "listed")}}
    generic = fdc.get_nutrients(ing["fdc_id"]) if ing.get("fdc_id") else None
    same_kind = bool(generic) and fdc.category_for(generic.get("food_category") or "") == \
        fdc.category_for(hit["food_category"]) != "other"
    portions = dict(hit.get("portions") or {})
    if same_kind:
        fields["unit_conversions"] = {**(ing.get("unit_conversions") or {}), **portions}
    else:
        # the generic match was some other food (the dessert, for a soda): its numbers and its cup go
        fields.update({"fdc_id": None, "fdc_description": None, "nutrient_fill": {},
                       "unit_conversions": portions})
    data = ingredients._load()
    row = next(i for i in data["ingredients"] if i["id"] == ingredient_id)
    block = (row.get("unit_conversions") or {}).get("block")
    row.update(fields)               # update() skips None, and a dropped match must really go
    if block:
        row["unit_conversions"]["block"] = block
    ingredients._save(data)
    return ingredients.get(ingredient_id)


def per100(ingredient: dict, generic: Optional[dict]) -> dict:
    """The label over the generic match: what the label lists wins, the generic fills the rest."""
    b = ingredient["brand"]
    base = generic or {k: 0.0 for k in TOP}
    listed = set(b.get("listed") or [])
    out = {**base, **{k: b["per100"].get(k, 0.0) for k in TOP if k in listed or not generic}}
    out["vitamins"] = {**(base.get("vitamins") or {}),
                       **{k: v for k, v in (b["per100"].get("vitamins") or {}).items() if k in listed}}
    desc = b["description"]
    out["description"] = desc if desc.lower().startswith(b["brand"].lower()) else f'{b["brand"]} {desc}'.strip()
    out["food_category"] = b.get("food_category") or base.get("food_category", "")
    return out
