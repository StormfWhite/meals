"""The full Nutrition Facts label for one meal line (the popout under the kcal number).

Pure counting: grams of the line x USDA per-100 g, then each person's share of it against their own
target. A nutrient the record doesn't list is UNKNOWN ("known": False), never 0 -- older cached USDA
rows (fdc v6) have no fat/sodium/E/K/B1-B3 and must read "-", not "0 mg".
"""
from __future__ import annotations

from typing import Optional

from . import gaps, household, ingredients, nutrition

# key, label, unit, group, daily value (None = no bar), kind: need | limit, indent (a sub-row)
# The DV is the FDA's, used only where gaps.NUTRIENTS (a person's own targets) has no entry.
ROWS = [
    ("calories_kcal", "Calories", "kcal", "main", None, "need", 0),
    ("protein_g", "Protein", "g", "main", None, "need", 0),
    ("fat_g", "Fat", "g", "fat", 78, "need", 0),
    ("sat_fat_g", "Saturated", "g", "fat", 20, "limit", 1),
    ("trans_fat_g", "Trans", "g", "fat", None, "limit", 1),
    ("mono_fat_g", "Monounsaturated", "g", "fat", None, "need", 1),
    ("poly_fat_g", "Polyunsaturated", "g", "fat", None, "need", 1),
    ("omega3_g", "Omega-3", "g", "fat", None, "need", 1),
    ("cholesterol_mg", "Cholesterol", "mg", "fat", 300, "limit", 0),
    ("sodium_mg", "Sodium", "mg", "main", 2300, "limit", 0),
    ("carbs_g", "Carbohydrate", "g", "carbs", 275, "need", 0),
    ("fiber_g", "Fiber", "g", "carbs", None, "need", 1),
    ("sugars_g", "Sugars", "g", "carbs", 50, "limit", 1),
    ("vitamin_a_mcg", "Vitamin A", "mcg", "vitamins", None, "need", 0),
    ("beta_carotene_mcg", "Beta-carotene", "mcg", "vitamins", None, "need", 1),
    ("vitamin_c_mg", "Vitamin C", "mg", "vitamins", None, "need", 0),
    ("vitamin_d_mcg", "Vitamin D", "mcg", "vitamins", None, "need", 0),
    ("vitamin_e_mg", "Vitamin E", "mg", "vitamins", 15, "need", 0),
    ("vitamin_k_mcg", "Vitamin K", "mcg", "vitamins", 120, "need", 0),
    ("thiamin_mg", "Thiamin (B1)", "mg", "vitamins", 1.2, "need", 0),
    ("riboflavin_mg", "Riboflavin (B2)", "mg", "vitamins", 1.3, "need", 0),
    ("niacin_mg", "Niacin (B3)", "mg", "vitamins", 16, "need", 0),
    ("vitamin_b6_mg", "Vitamin B6", "mg", "vitamins", None, "need", 0),
    ("folate_mcg", "Folate", "mcg", "vitamins", None, "need", 0),
    ("b12_mcg", "Vitamin B12", "mcg", "vitamins", None, "need", 0),
    ("choline_mg", "Choline", "mg", "vitamins", None, "need", 0),
    ("calcium_mg", "Calcium", "mg", "minerals", None, "need", 0),
    ("iron_mg", "Iron", "mg", "minerals", None, "need", 0),
    ("magnesium_mg", "Magnesium", "mg", "minerals", None, "need", 0),
    ("phosphorus_mg", "Phosphorus", "mg", "minerals", 1250, "need", 0),
    ("potassium_mg", "Potassium", "mg", "minerals", None, "need", 0),
    ("zinc_mg", "Zinc", "mg", "minerals", None, "need", 0),
    ("copper_mg", "Copper", "mg", "minerals", 0.9, "need", 0),
    ("manganese_mg", "Manganese", "mg", "minerals", 2.3, "need", 0),
    ("selenium_mcg", "Selenium", "mcg", "minerals", 55, "need", 0),
    ("iodine_mcg", "Iodine", "mcg", "minerals", None, "need", 0),
]
TOP = ("calories_kcal", "protein_g", "fiber_g")


def amount_of(per100: dict, key: str) -> Optional[float]:
    """Per 100 g, or None when the record doesn't list it."""
    if key in TOP:
        v = per100.get(key)
        return float(v) if v is not None else None
    v = (per100.get("vitamins") or {}).get(key)
    return float(v) if v is not None else None


def portion_factor(servings: Optional[float], n_people: int) -> float:
    """What one person's portion of the line is: the pot over the count."""
    if servings:
        return 1.0 / servings
    return 1.0 / max(1, n_people)


def _fmt(v: float) -> float:
    return round(v, 1) if abs(v) < 10 else round(v)


def for_line(ing: dict, qty: float, unit: str, eaters: Optional[list] = None,
             servings: Optional[float] = None) -> Optional[dict]:
    """{name, description, grams, rows:[...]} for `qty unit` of the ingredient, or None when it
    has no nutrition or the amount can't be weighed."""
    per100 = nutrition.nutrients_per_100g(ing)
    if not per100:
        return None
    grams = nutrition.qty_to_grams(ing, qty, unit)
    if not grams:
        return None
    ppl = gaps.people()
    pf = portion_factor(servings, len(ppl))
    who = []
    for p in ppl:
        f = household.portion(p["member"], eaters, servings) if p["member"] else 1.0
        who.append((p, f))
    rows = []
    for key, label, u, group, dv, kind, indent in ROWS:
        a = amount_of(per100, key)
        row = {"key": key, "label": label, "unit": u, "group": group, "kind": kind, "indent": indent,
               "known": a is not None}
        if a is None:
            rows.append(row)
            continue
        line = a * grams / 100.0
        row.update({"per100": _fmt(a), "line": _fmt(line), "portion": _fmt(line * pf)})
        pct = []
        for p, f in who:
            target = p["targets"].get(key) or dv
            if key == "calories_kcal" or not target:
                continue
            pct.append({"name": p["name"], "pct": round(100 * line * f / target)})
        if pct:
            row["pct"] = pct
        rows.append(row)
    return {"name": ing["name"], "description": per100.get("description") or "", "grams": round(grams),
            "portions": servings or 1, "people": [{"name": p["name"]} for p, _ in who if p["name"]],
            "rows": rows}


def for_ingredient_id(ingredient_id: str, qty: float, unit: str, eaters=None, servings=None) -> Optional[dict]:
    ing = ingredients.get(ingredient_id)
    return for_line(ing, qty, unit, eaters, servings) if ing else None
