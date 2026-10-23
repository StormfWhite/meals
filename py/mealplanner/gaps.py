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
# women differ -- a household member's own targets win, see people())
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


def _defaults() -> dict:
    out = {k: float(v) for k, _, _, v in NUTRIENTS}
    out["calories_kcal"] = float(KCAL)
    return out


def people() -> list[dict]:
    """Who eats the plan: [{name, share, targets}]. The meals are cooked once and shared ("we
    are eating these meals together, split somewhat evenly"), so each active household member
    eats `share` of every pot -- an even split unless a member says otherwise. A target a member
    doesn't have falls back to the adult default. No members: one adult eating everything."""
    members = [m for m in household.list_members() if m.get("active", True)]
    if not members:
        return [{"name": "", "share": 1.0, "targets": _defaults()}]
    out = []
    for m in members:
        tg, t = _defaults(), m.get("targets") or {}
        for key in tg:
            v = t.get(key) if key in TOP_LEVEL else (t.get("vitamins") or {}).get(key)
            if v:
                tg[key] = float(v)
        out.append({"name": m["name"], "share": household.share(m), "targets": tg})
    return out


def _amount(totals: dict, key: str) -> float:
    if key in TOP_LEVEL:
        return float(totals.get(key) or 0.0)
    return float((totals.get("vitamins") or {}).get(key) or 0.0)


def lows(totals: dict, ppl: list[dict]) -> Optional[list[dict]]:
    """The day's low nutrients, worst first; None when too little is planned to say.

    Judged per person on their share of the day: low when anyone's share is under LOW_BELOW of
    what their share of the calories predicts. `who` names them when it isn't everyone; `pct`
    and `have`/`target` are the worst-off person's. `short`/`scale` are in whole-pot amounts --
    what the day's meals would need to add, and one person's full day of it -- so a suggestion
    (a portion added to a shared meal) is measured on the same footing."""
    kcal = _amount(totals, "calories_kcal")
    if kcal < MIN_KCAL:
        return None
    out = []
    for key, label, unit, _ in NUTRIENTS:
        have, rows = _amount(totals, key), []
        for p in ppl:
            tg, s = p["targets"], p["share"]
            expected = tg[key] * min(1.0, kcal * s / tg["calories_kcal"])
            rows.append({"name": p["name"], "ratio": have * s / expected if expected else 1.0,
                         "have": have * s, "target": tg[key], "short": (expected - have * s) / s,
                         "scale": tg[key] / s})
        low = [r for r in rows if r["ratio"] < LOW_BELOW]
        if not low:
            continue
        worst = min(low, key=lambda r: r["ratio"])
        out.append({"key": key, "label": label, "unit": unit, "have": round(worst["have"], 1),
                    "target": worst["target"], "pct": round(100 * worst["have"] / worst["target"]),
                    "who": [r["name"] for r in low] if len(low) < len(rows) else [],
                    "ratio": worst["ratio"], "short": max(r["short"] for r in low),
                    "scale": max(r["scale"] for r in low)})
    out.sort(key=lambda l: l["ratio"])
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


def _rank(cands: list[dict], low: list[dict]) -> list[dict]:
    out = []
    for c in cands:
        helps, score = [], 0.0
        for l in low:
            g = _gain(c["per100"], c["grams"], l["key"])
            part = min(g, l["short"]) / l["scale"]
            if g / l["scale"] >= MIN_HELP:
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
    ppl = people()
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
        low = lows(day.get("totals") or {}, ppl)
        if low is None:
            out[date] = {"judged": False, "low": [], "have": [], "buy": []}
            continue
        if not low:
            out[date] = {"judged": True, "low": [], "have": [], "buy": []}
            continue
        in_day = set(day.get("ingredient_ids") or [])
        # the same food under another name ("yogurt" / "fage yogurt") counts as in the day too
        in_day_fdc = {o["fdc_id"] for o in owned if o["ingredient_id"] in in_day and o.get("fdc_id")}
        have = _rank([o for o in owned if o["ingredient_id"] not in in_day and o.get("fdc_id") not in in_day_fdc], low)
        have = [h for n, h in enumerate(have)          # and is offered once
                if not h.get("fdc_id") or h["fdc_id"] not in {x.get("fdc_id") for x in have[:n]}]
        for h in have:
            h["in_stock"] = h["ingredient_id"] in on_hand
        have.sort(key=lambda h: (-h["score"] * (1.25 if h["in_stock"] else 1.0)))
        buy = _rank(buyable, low)
        out[date] = {"judged": True, "low": [{k: v for k, v in l.items() if k not in ("short", "scale", "ratio")} for l in low],
                     "have": have[:per_kind], "buy": buy[:per_kind]}
    return {"people": [{"name": p["name"], "share": p["share"]} for p in ppl], "days": out}


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
