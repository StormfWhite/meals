"""What a day's meals are low in, and whole foods that would fill it.

Storm 2026-10-23: "when you track my nutrition between the meals can you show when something is
low and suggestions for how to improve it based on what we already buy or what we could buy",
"focusing on whole foods and ingredients".

All counting, no judgement calls: a nutrient is LOW when the day has less of it than its share of
the calories eaten would predict (a day with only breakfast planned isn't "low in everything"),
and a suggestion is a real food with its real USDA numbers, ranked by how much of the day's gaps
one ordinary portion closes. First the foods already bought (in the pantry now, or in past
meals), then whole foods worth buying (whole_foods.json, built by tools/build_whole_foods.py).
Nothing processed: juices, flours, oils, sweeteners, extracts and drinks are never suggested.
Vegetarian ("we are vegetarian"): no meat or fish, even if some was bought once. Nothing is
ever added by itself ("just suggestions"); a food to buy goes on the list only from its + tap.
"""
from __future__ import annotations

import datetime
import json
import re
from pathlib import Path
from typing import Optional

from . import household, ingredients, nutrition, suggest

# key, label, unit, adult daily amount (the general adult RDA/AI, the higher one where men and
# women differ -- a household member's own targets in Settings win)
NUTRIENTS = [
    ("protein_g", "protein", "g", 90),          # ~1.2 g/kg at 75 kg; 0.8 is the floor, 1.6 for training
    ("fiber_g", "fiber", "g", 30),
    ("potassium_mg", "potassium", "mg", 3400),
    ("magnesium_mg", "magnesium", "mg", 400),
    ("calcium_mg", "calcium", "mg", 1000),
    ("iron_mg", "iron", "mg", 8),
    ("zinc_mg", "zinc", "mg", 11),
    ("vitamin_c_mg", "vitamin C", "mg", 90),
    ("vitamin_a_mcg", "vitamin A", "mcg", 900),
    ("vitamin_d_mcg", "vitamin D", "mcg", 15),
    ("b12_mcg", "B12", "mcg", 2.4),
    ("folate_mcg", "folate", "mcg", 400),
]
TOP_LEVEL = ("calories_kcal", "protein_g", "fiber_g")
KCAL = 2000
LOW_BELOW = 0.7          # under 70% of what the day's calories would predict
MIN_KCAL = 300           # less planned than this: too little to judge
MIN_HELP = 0.08          # a suggestion closes at least 8% of one gap's daily amount

NOT_WHOLE = re.compile(r"\b(juice|flour|extract|oil|sugar|syrup|honey|sauce|granola|bread|cracker|"
                       r"chips?|candy|cookie|soda|drink|milk substitute|powder|starch|vinegar|"
                       r"dressing|spread|jam|jelly)\b", re.I)
MEAT = re.compile(r"\b(beef|pork|poultry|chicken|turkey|duck|lamb|veal|venison|bacon|ham|sausages?|"
                  r"fish|finfish|shellfish|salmon|tuna|sardines?|anchov(?:y|ies)|shrimp|crab|lobster|"
                  r"clams?|mussels?|oysters?|scallops?|gelatin)\b", re.I)
NOT_WHOLE_CATEGORIES = {"Sweets", "Beverages", "Spices and Herbs", "Fats and Oils", "Snacks",
                        "Baked Products", "Fast Foods", "Restaurant Foods", "Soups, Sauces, and Gravies"}

_WHOLE_FOODS: Optional[list] = None


def whole_foods() -> list[dict]:
    global _WHOLE_FOODS
    if _WHOLE_FOODS is None:
        p = Path(__file__).with_name("whole_foods.json")
        _WHOLE_FOODS = json.loads(p.read_text()) if p.exists() else []
    return _WHOLE_FOODS


def targets() -> dict:
    """key -> daily amount. Active household members' own targets, the highest of them (low
    for anyone at the table is worth saying), over the adult defaults."""
    out = {k: float(v) for k, _, _, v in NUTRIENTS}
    out["calories_kcal"] = float(KCAL)
    members = [m for m in household.list_members() if m.get("active", True)]
    for key in out:
        mine = []
        for m in members:
            t = m.get("targets") or {}
            v = t.get(key) if key in TOP_LEVEL else (t.get("vitamins") or {}).get(key)
            if v:
                mine.append(float(v))
        if mine:
            out[key] = max(mine)
    return out


def _amount(totals: dict, key: str) -> float:
    if key in TOP_LEVEL:
        return float(totals.get(key) or 0.0)
    return float((totals.get("vitamins") or {}).get(key) or 0.0)


def lows(totals: dict, tg: dict) -> Optional[list[dict]]:
    """The day's low nutrients, worst first; None when too little is planned to say."""
    kcal = _amount(totals, "calories_kcal")
    if kcal < MIN_KCAL:
        return None
    share = min(1.0, kcal / tg["calories_kcal"])
    out = []
    for key, label, unit, _ in NUTRIENTS:
        have, target = _amount(totals, key), tg[key]
        expected = target * share
        if have < LOW_BELOW * expected:
            out.append({"key": key, "label": label, "unit": unit, "have": round(have, 1),
                        "target": target, "pct": round(100 * have / target),
                        "short": expected - have})
    out.sort(key=lambda l: l["have"] / (l["target"] * share))
    return out


def _whole(description: str, category: Optional[str], name: str) -> bool:
    if category in NOT_WHOLE_CATEGORIES:
        return False
    if any(MEAT.search(t or "") for t in (description, category, name)):
        return False
    return not (NOT_WHOLE.search(description or "") or NOT_WHOLE.search(name or ""))


def _default_portion(per100: dict, name: str) -> tuple[float, str]:
    """A portion for something never measured in a meal yet: an ounce of nuts or seeds, a
    quarter cup of dry beans or grain, else 100 g."""
    cat, desc = (per100.get("food_category") or "").lower(), (per100.get("description") or "").lower()
    if "seed" in cat or "nut" in cat.split() or re.search(r"\b(nuts?|seeds?)\b", name.lower()):
        return 28.0, "1 oz"
    if ("legume" in cat or "bean" in cat or "grain" in cat) and ("raw" in desc or "dry" in desc or "mature" in desc):
        return 48.0, "1/4 cup dry"
    return 100.0, "100 g"


def _owned(today: datetime.date) -> list[dict]:
    """Every ingredient already bought that's a whole food with USDA numbers, with the portion
    it's usually written in."""
    uses, _ = suggest._history(today)
    by_fdc = {f["fdc_id"]: f for f in whole_foods()}
    out = []
    for ing in ingredients.by_id().values():
        per100 = nutrition.nutrients_per_100g(ing)
        if not per100:
            continue
        if not _whole(per100.get("description", ""), per100.get("food_category"), ing["name"]):
            continue
        grams, label = None, None
        usual = suggest._typical_amount(uses.get(ing["id"], []))
        if usual:
            grams = nutrition.qty_to_grams(ing, usual["qty"], usual["unit"])
            label = usual["label"]
        if not grams and ing.get("fdc_id") in by_fdc:
            f = by_fdc[ing["fdc_id"]]
            grams, label = f["grams"], f["portion"]
        if not grams:
            grams, label = _default_portion(per100, ing["name"])
        out.append({"ingredient_id": ing["id"], "name": ing["name"], "fdc_id": ing.get("fdc_id"),
                    "per100": per100, "grams": grams, "portion": label})
    return out


def _gain(per100: dict, grams: float, key: str) -> float:
    return _amount(per100, key) * grams / 100.0


def _rank(cands: list[dict], low: list[dict], tg: dict) -> list[dict]:
    out = []
    for c in cands:
        helps, score = [], 0.0
        for l in low:
            g = _gain(c["per100"], c["grams"], l["key"])
            part = min(g, l["short"]) / tg[l["key"]]
            if g / tg[l["key"]] >= MIN_HELP:
                helps.append({"key": l["key"], "label": l["label"], "unit": l["unit"],
                              "amount": round(g, 1) if g < 10 else round(g)})
            score += part
        if helps:
            out.append({**{k: c[k] for k in c if k != "per100"}, "helps": helps, "score": round(score, 3),
                        "kcal": round(_gain(c["per100"], c["grams"], "calories_kcal"))})
    out.sort(key=lambda c: -c["score"])
    return out


def for_days(days: dict[str, dict], on_hand: Optional[set] = None,
             today: Optional[datetime.date] = None, per_kind: int = 3) -> dict:
    """days = {date: {"totals": day totals, "ingredient_ids": [...in that day's meals]}}
    -> {"targets", "days": {date: {"judged", "low", "have", "buy"}}}.
    `have` = already bought (`in_stock` when it's in the pantry now), `buy` = whole foods
    nobody has bought yet."""
    tg = targets()
    today = today or datetime.date.today()
    on_hand = on_hand or set()
    owned = _owned(today)
    owned_fdc = {o["fdc_id"] for o in owned if o.get("fdc_id")}
    owned_names = {o["name"].strip().lower() for o in owned}
    buyable = [{"name": f["name"], "fdc_id": f["fdc_id"], "per100": f["per100"], "grams": f["grams"],
                "portion": f["portion"]}
               for f in whole_foods()
               if f["fdc_id"] not in owned_fdc and f["name"].lower() not in owned_names]
    out = {}
    for date, day in days.items():
        low = lows(day.get("totals") or {}, tg)
        if low is None:
            out[date] = {"judged": False, "low": [], "have": [], "buy": []}
            continue
        if not low:
            out[date] = {"judged": True, "low": [], "have": [], "buy": []}
            continue
        in_day = set(day.get("ingredient_ids") or [])
        have = _rank([o for o in owned if o["ingredient_id"] not in in_day], low, tg)
        for h in have:
            h["in_stock"] = h["ingredient_id"] in on_hand
        have.sort(key=lambda h: (-h["score"] * (1.25 if h["in_stock"] else 1.0)))
        buy = _rank(buyable, low, tg)
        out[date] = {"judged": True, "low": [{k: v for k, v in l.items() if k != "short"} for l in low],
                     "have": have[:per_kind], "buy": buy[:per_kind]}
    return {"targets": tg, "days": out}


def buy(name: str, week: str, market_week: Optional[str] = None) -> dict:
    """The + on a food to buy: the catalog ingredient (made from its USDA record the first time,
    so its nutrition is known at once) plus a hand-add on that list."""
    from . import aisles, fdc, groceries   # groceries imports a lot
    f = next((f for f in whole_foods() if f["name"].lower() == name.strip().lower()), None)
    ing = next((i for i in ingredients.by_id().values() if i["name"].strip().lower() == name.strip().lower()), None)
    if ing is None:
        if f is None:
            raise KeyError(name)
        # what resolve_usda would have written, without asking USDA again
        category = fdc.category_for(f.get("food_category") or "")
        ing = ingredients.add(f["name"], category=category, fdc_id=f["fdc_id"],
                              unit_conversions=ingredients._kitchen_portions(f))
        ing = ingredients.update(ing["id"], fdc_description=f["description"])
        if not ing.get("shop_list_locked"):
            ingredients.update(ing["id"], shop_list=aisles.classify(ing["name"], category), lock_shop_list=False)
    ing = ingredients.get(ing["id"])
    # the farmer's market list runs on its own week (the panel's marketWeek)
    to_market = ing.get("shop_list") == aisles.MARKET and market_week
    groceries.add_extra_item(market_week if to_market else week, ing["id"])
    return ing
